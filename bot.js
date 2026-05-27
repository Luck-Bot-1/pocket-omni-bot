const { RobustAnalyzer } = require('./analyzer.js');
const https = require('https');
const http = require('http');
const fs = require('fs');
const winston = require('winston');
const pairsConfig = require('./pairs.json');

// ------------------------- Simple Async Mutex (no external dependency) -------------------------
class Mutex {
    constructor() {
        this._queue = [];
        this._locked = false;
    }
    async acquire() {
        return new Promise((resolve) => {
            this._queue.push(resolve);
            this._dispatch();
        });
    }
    _dispatch() {
        if (this._locked) return;
        const next = this._queue.shift();
        if (next) {
            this._locked = true;
            next(() => {
                this._locked = false;
                this._dispatch();
            });
        }
    }
    async runExclusive(fn) {
        const release = await this.acquire();
        try {
            return await fn();
        } finally {
            release();
        }
    }
}

// ------------------------- Logger (structured) -------------------------
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
            return JSON.stringify({ timestamp, level, message, ...meta });
        })
    ),
    transports: [
        new winston.transports.File({ filename: 'logs/error.log', level: 'error', maxsize: 10485760, maxFiles: 5 }),
        new winston.transports.File({ filename: 'logs/combined.log', maxsize: 10485760, maxFiles: 5 }),
        new winston.transports.Console({ format: winston.format.simple() })
    ]
});

// ------------------------- Configuration -------------------------
if (!pairsConfig.probabilityLevels || !pairsConfig.technicalParameters) {
    logger.error('Invalid pairs.json');
    process.exit(1);
}

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PORT = process.env.PORT || 8080;
const PAIRS = pairsConfig.pairs;
const TIMEFRAMES = pairsConfig.timeframes;
const PRIMARY_TF = pairsConfig.primaryTimeframe;

const YAHOO_SYMBOLS = {
    'EUR/USD': 'EURUSD=X', 'GBP/USD': 'GBPUSD=X', 'AUD/USD': 'AUDUSD=X',
    'NZD/USD': 'NZDUSD=X', 'USD/CAD': 'USDCAD=X', 'USD/CHF': 'USDCHF=X',
    'USD/JPY': 'USDJPY=X', 'AUD/CAD': 'AUDCAD=X', 'AUD/JPY': 'AUDJPY=X',
    'CAD/JPY': 'CADJPY=X', 'CHF/JPY': 'CHFJPY=X', 'EUR/AUD': 'EURAUD=X',
    'EUR/CAD': 'EURCAD=X', 'EUR/CHF': 'EURCHF=X', 'EUR/GBP': 'EURGBP=X',
    'EUR/JPY': 'EURJPY=X', 'GBP/AUD': 'GBPAUD=X', 'GBP/CAD': 'GBPCAD=X',
    'GBP/CHF': 'GBPCHF=X', 'GBP/JPY': 'GBPJPY=X', 'CAD/CHF': 'CADCHF=X',
    'AUD/CHF': 'AUDCHF=X'
};

// ------------------------- Cache with TTL & size limit -------------------------
const CACHE_MAX_SIZE = 200;
const CACHE_TTL = 60000;
const candleCache = new Map();

function cacheSet(key, data, isMock) {
    if (candleCache.size >= CACHE_MAX_SIZE) {
        const oldest = candleCache.keys().next().value;
        candleCache.delete(oldest);
    }
    candleCache.set(key, { data, isMock, timestamp: Date.now() });
}

function cacheGet(key) {
    const entry = candleCache.get(key);
    if (entry && Date.now() - entry.timestamp < CACHE_TTL) return entry;
    if (entry) candleCache.delete(key);
    return null;
}

// ------------------------- User Rate Limiter (flood control) -------------------------
class UserRateLimiter {
    constructor(maxRequestsPerMinute = 10) {
        this.users = new Map();
        this.max = maxRequestsPerMinute;
    }
    async allow(userId) {
        const now = Date.now();
        const record = this.users.get(userId) || { timestamps: [] };
        record.timestamps = record.timestamps.filter(t => now - t < 60000);
        if (record.timestamps.length >= this.max) {
            const oldest = record.timestamps[0];
            const waitMs = 60000 - (now - oldest);
            await new Promise(r => setTimeout(r, waitMs));
            return this.allow(userId);
        }
        record.timestamps.push(now);
        this.users.set(userId, record);
        return true;
    }
}
const userLimiter = new UserRateLimiter(10);

// ------------------------- Telegram Rate Limiter (token bucket) -------------------------
class TokenBucket {
    constructor(tokensPerSecond = 20, burst = 5) {
        this.capacity = burst;
        this.tokens = burst;
        this.refillRate = tokensPerSecond / 1000;
        this.lastRefill = Date.now();
    }
    async consume(tokens = 1, timeoutMs = 5000) {
        const start = Date.now();
        while (true) {
            const now = Date.now();
            const elapsed = now - this.lastRefill;
            this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
            this.lastRefill = now;
            if (this.tokens >= tokens) {
                this.tokens -= tokens;
                return true;
            }
            if (Date.now() - start > timeoutMs) return true;
            await new Promise(r => setTimeout(r, 10));
        }
    }
}
const telegramRateLimiter = new TokenBucket(20, 5);

// ------------------------- State Manager (async, custom mutex, no blocking) -------------------------
class StateManager {
    constructor() {
        this.state = {
            scanning: { active: false, userId: null, startTime: null, totalPairs: 0, processed: 0, progressMsgId: null },
            settings: { selectedPairs: [...PAIRS], selectedTimeframe: PRIMARY_TF, autoScanEnabled: false },
            signals: [],
            stats: { signalsGenerated: 0, lastScanTime: null }
        };
        this.mutex = new Mutex();
        this.load().catch(e => logger.error('Initial load error', { error: e.message }));
    }

    async withMutex(fn) {
        return this.mutex.runExclusive(async () => {
            return await fn(this.getSnapshot());
        });
    }

    getSnapshot() {
        return {
            scanning: { ...this.state.scanning },
            settings: { ...this.state.settings },
            signals: [...this.state.signals],
            stats: { ...this.state.stats }
        };
    }

    update(updates) {
        if (updates.scanning) this.state.scanning = { ...this.state.scanning, ...updates.scanning };
        if (updates.settings) this.state.settings = { ...this.state.settings, ...updates.settings };
        if (updates.signals) this.state.signals = [...updates.signals];
        if (updates.stats) this.state.stats = { ...this.state.stats, ...updates.stats };
        this.persist().catch(e => logger.error('Persist error', { error: e.message }));
    }

    async persist() {
        try {
            await fs.promises.writeFile('./state.json', JSON.stringify({
                settings: this.state.settings,
                signals: this.state.signals.slice(0, 1000),
                stats: this.state.stats
            }, null, 2));
        } catch (e) {
            logger.error('State persist failed', { error: e.message });
        }
    }

    async load() {
        try {
            if (fs.existsSync('./state.json')) {
                const data = await fs.promises.readFile('./state.json', 'utf8');
                const saved = JSON.parse(data);
                this.state.settings = { ...this.state.settings, ...saved.settings };
                this.state.signals = saved.signals || [];
                this.state.stats = saved.stats || { signalsGenerated: 0, lastScanTime: null };
            }
        } catch (e) {
            logger.error('State load failed', { error: e.message });
        }
    }
}
const stateManager = new StateManager();

// ------------------------- Helper: fetch with timeout -------------------------
function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        fetch(url, { ...options, signal: controller.signal })
            .then(resolve)
            .catch(reject)
            .finally(() => clearTimeout(timeout));
    });
}

// ------------------------- Real Data Fetching (NO MOCK) -------------------------
async function fetchYahooRaw(symbol, interval) {
    let period1;
    switch (interval) {
        case '1m': period1 = Math.floor(Date.now() / 1000) - 86400; break;
        case '5m': period1 = Math.floor(Date.now() / 1000) - 259200; break;
        case '15m': period1 = Math.floor(Date.now() / 1000) - 604800; break;
        default: period1 = Math.floor(Date.now() / 1000) - 604800;
    }
    const period2 = Math.floor(Date.now() / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=${interval}`;
    try {
        const response = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 10000);
        const json = await response.json();
        if (!json.chart?.result?.[0]) return null;
        const quotes = json.chart.result[0].indicators.quote[0];
        if (!quotes || !quotes.open) return null;
        const candles = [];
        const timestamps = json.chart.result[0].timestamp;
        for (let i = 0; i < timestamps.length; i++) {
            if (quotes.open[i] && quotes.high[i] && quotes.low[i] && quotes.close[i]) {
                candles.push({
                    open: quotes.open[i], high: quotes.high[i], low: quotes.low[i],
                    close: quotes.close[i], volume: quotes.volume[i] || 1000,
                    time: timestamps[i] * 1000
                });
            }
        }
        return candles.length >= 50 ? candles : null;
    } catch (e) {
        return null;
    }
}

async function fetchAlphaVantage(symbol, interval, apiKey) {
    if (!apiKey) return null;
    const avInterval = { '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '60min', '4h': '60min' }[interval];
    if (!avInterval) return null;
    const baseSymbol = symbol.replace('=X', '');
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=${baseSymbol}&interval=${avInterval}&apikey=${apiKey}&outputsize=full`;
    try {
        const response = await fetchWithTimeout(url, {}, 10000);
        const json = await response.json();
        const timeSeries = json[`Time Series (${avInterval})`];
        if (!timeSeries) return null;
        const candles = [];
        for (const [timestamp, values] of Object.entries(timeSeries)) {
            candles.push({
                time: new Date(timestamp).getTime(),
                open: parseFloat(values['1. open']),
                high: parseFloat(values['2. high']),
                low: parseFloat(values['3. low']),
                close: parseFloat(values['4. close']),
                volume: parseInt(values['5. volume']) || 1000
            });
        }
        candles.sort((a, b) => a.time - b.time);
        return candles.length >= 50 ? candles.slice(-300) : null;
    } catch (e) { return null; }
}

async function fetchTwelveData(symbol, interval, apiKey) {
    if (!apiKey) return null;
    const tdInterval = { '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '1h', '4h': '4h' }[interval];
    if (!tdInterval) return null;
    const baseSymbol = symbol.replace('=X', '');
    const url = `https://api.twelvedata.com/time_series?symbol=${baseSymbol}&interval=${tdInterval}&apikey=${apiKey}&outputsize=300`;
    try {
        const response = await fetchWithTimeout(url, {}, 10000);
        const json = await response.json();
        if (!json.values) return null;
        const candles = [];
        for (const v of json.values) {
            candles.push({
                time: new Date(v.datetime).getTime(),
                open: parseFloat(v.open),
                high: parseFloat(v.high),
                low: parseFloat(v.low),
                close: parseFloat(v.close),
                volume: parseInt(v.volume) || 1000
            });
        }
        candles.sort((a, b) => a.time - b.time);
        return candles.length >= 50 ? candles : null;
    } catch (e) { return null; }
}

async function fetchCandles(symbol, interval) {
    const cacheKey = `${symbol}_${interval}`;
    const cached = cacheGet(cacheKey);
    if (cached) return { candles: cached.data, isMock: cached.isMock };

    let candles = null;
    // 1. Yahoo Finance library (yahoo-finance2)
    try {
        const yahooFinance = require('yahoo-finance2').default;
        const intervalMap = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '1h' };
        const yahooInterval = intervalMap[interval] || '15m';
        const endDate = new Date();
        let startDate = new Date();
        switch (interval) {
            case '1m': startDate.setDate(startDate.getDate() - 1); break;
            case '5m': startDate.setDate(startDate.getDate() - 2); break;
            case '15m': startDate.setDate(startDate.getDate() - 7); break;
            default: startDate.setDate(startDate.getDate() - 7);
        }
        const result = await yahooFinance.chart(symbol, {
            period1: startDate,
            period2: endDate,
            interval: yahooInterval,
            includePrePost: false
        });
        if (result && result.quotes && result.quotes.length >= 50) {
            candles = result.quotes.map(q => ({
                open: q.open,
                high: q.high,
                low: q.low,
                close: q.close,
                volume: q.volume || 1000,
                time: new Date(q.date).getTime()
            })).filter(c => c.open !== null && c.close !== null);
        }
    } catch(e) { /* fall through */ }

    if (candles && candles.length >= 50) {
        cacheSet(cacheKey, candles, false);
        return { candles, isMock: false };
    }

    // 2. Alpha Vantage
    const avKey = process.env.ALPHA_VANTAGE_KEY;
    if (avKey) {
        candles = await fetchAlphaVantage(symbol, interval, avKey);
        if (candles && candles.length >= 50) {
            cacheSet(cacheKey, candles, false);
            return { candles, isMock: false };
        }
    }

    // 3. Twelve Data
    const tdKey = process.env.TWELVE_DATA_KEY;
    if (tdKey) {
        candles = await fetchTwelveData(symbol, interval, tdKey);
        if (candles && candles.length >= 50) {
            cacheSet(cacheKey, candles, false);
            return { candles, isMock: false };
        }
    }

    // 4. Yahoo Raw HTTP (last resort, but still real)
    candles = await fetchYahooRaw(symbol, interval);
    if (candles && candles.length >= 50) {
        cacheSet(cacheKey, candles, true);
        return { candles, isMock: true };
    }

    logger.warn(`No data for ${symbol} ${interval}`);
    return null;
}

// ------------------------- Telegram API Helpers (with retry & backoff) -------------------------
async function sendMessage(text, replyMarkup = null, retries = 3) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
        logger.info(`📱 ${text.substring(0, 200)}...`);
        return;
    }
    await telegramRateLimiter.consume(1);
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const body = {
                chat_id: TELEGRAM_CHAT_ID,
                text,
                parse_mode: "Markdown",
                disable_web_page_preview: true
            };
            // Only add reply_markup if it's a valid object
            if (replyMarkup && typeof replyMarkup === 'object') {
                body.reply_markup = replyMarkup;
            }
            const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const json = await response.json();
            if (!json.ok && json.error_code === 429) {
                const retryAfter = json.parameters?.retry_after || (attempt * 2);
                logger.warn(`Telegram 429, retry after ${retryAfter}s (attempt ${attempt})`);
                await new Promise(r => setTimeout(r, retryAfter * 1000));
                continue;
            }
            if (!json.ok) throw new Error(`Telegram error: ${json.description}`);
            return json;
        } catch (e) {
            lastError = e;
            logger.warn(`SendMessage attempt ${attempt} failed: ${e.message}`);
            if (attempt < retries) await new Promise(r => setTimeout(r, 1000 * attempt));
        }
    }
    logger.error(`Failed to send message after ${retries} attempts: ${lastError?.message}`);
}

async function editMessageText(messageId, text, replyMarkup = null) {
    if (!messageId || !TELEGRAM_TOKEN) return;
    await telegramRateLimiter.consume(1);
    try {
        const body = {
            chat_id: TELEGRAM_CHAT_ID,
            message_id: messageId,
            text,
            parse_mode: "Markdown"
        };
        if (replyMarkup && typeof replyMarkup === 'object') {
            body.reply_markup = replyMarkup;
        }
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    } catch (e) { logger.warn(`EditMessage failed: ${e.message}`); }
}

async function sendTypingAction() {
    if (!TELEGRAM_TOKEN) return;
    await telegramRateLimiter.consume(1);
    fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendChatAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, action: 'typing' })
    }).catch(() => {});
}

// ------------------------- Bot Logic -------------------------
const analyzer = new RobustAnalyzer();

async function performScan(timeframe, isAuto = false) {
    return stateManager.withMutex(async (snapshot) => {
        if (snapshot.scanning.active) {
            if (!isAuto) await sendMessage("⏳ Scan already in progress...");
            return null;
        }
        const totalPairs = stateManager.state.settings.selectedPairs.length;
        stateManager.update({ scanning: { active: true, userId: null, startTime: Date.now(), totalPairs, processed: 0, progressMsgId: null } });
        let progressMsgId = null;
        if (!isAuto) {
            const startMsg = await sendMessage(`🔍 *SCAN STARTED*\n━━━━━━━━━━━━━━━━━━━━━━\n⏰ ${timeframe} | ${totalPairs} pairs\n_Processing..._`);
            if (startMsg && startMsg.result && startMsg.result.message_id) {
                progressMsgId = startMsg.result.message_id;
                stateManager.update({ scanning: { progressMsgId } });
            }
            await sendTypingAction();
        }
        let signals = 0;
        const pairsList = [...stateManager.state.settings.selectedPairs];
        for (let idx = 0; idx < pairsList.length; idx++) {
            const pair = pairsList[idx];
            const symbol = YAHOO_SYMBOLS[pair];
            if (!symbol) continue;
            const fetchResult = await fetchCandles(symbol, timeframe);
            if (!fetchResult || !fetchResult.candles) {
                logger.warn(`No data for ${pair}`);
                continue;
            }
            const analysis = analyzer.calculateProbability(fetchResult.candles, pair, timeframe);
            if (analysis.probability >= 55) {
                signals++;
                const msg = formatSignal(analysis, pair, timeframe, isAuto, fetchResult.isMock);
                await sendMessage(msg);
                const newSignals = [analysis, ...stateManager.state.signals].slice(0, 1000);
                stateManager.update({ signals: newSignals, stats: { signalsGenerated: newSignals.length, lastScanTime: Date.now() } });
            }
            if (!isAuto && progressMsgId && idx % 5 === 0) {
                const percent = Math.round((idx / totalPairs) * 100);
                const bar = '█'.repeat(Math.floor(percent / 5)) + '░'.repeat(20 - Math.floor(percent / 5));
                await editMessageText(progressMsgId, `🔍 *SCANNING* ${percent}%\n\`${bar}\`\n${idx}/${totalPairs} pairs`);
                await sendTypingAction();
            }
            await new Promise(r => setTimeout(r, 200));
        }
        stateManager.update({ scanning: { active: false, progressMsgId: null } });
        if (!isAuto && progressMsgId) {
            await editMessageText(progressMsgId, `✅ *SCAN COMPLETE*: ${signals} signals\n━━━━━━━━━━━━━━━━━━━━━━\nReview probabilities above. YOU decide.`);
        }
        return signals;
    });
}

function formatSignal(analysis, pair, timeframe, isAuto, isMock) {
    const arrow = analysis.signal === 'CALL' ? '📈' : (analysis.signal === 'PUT' ? '📉' : '➡️');
    const bar = '█'.repeat(Math.floor(analysis.probability / 5)) + '░'.repeat(20 - Math.floor(analysis.probability / 5));
    let msg = `${isAuto ? '🤖 AUTO-SCAN\n' : ''}*${arrow} PROBABILITY SIGNAL ${arrow}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 *${pair}* | [${timeframe}]\n🎯 *${analysis.signal === 'CALL' ? 'CALL (BUY)' : 'PUT (SELL)'}* | Probability: *${analysis.probability}%*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 *PROBABILITY METER:*\n\`${bar}\` ${analysis.probability}%\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📈 *TECHNICALS:* RSI ${analysis.rsi} | ADX ${analysis.adx} | Trend ${analysis.trendRegime}\n🌀 Divergence: ${analysis.divergence}\n📊 Factors: ${analysis.activeFactors.join(', ') || 'none'}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 *ACTION:* ${analysis.recommendedAction} (Risk ${analysis.suggestedRisk})\n🛡️ SL: ${analysis.stopLoss} pips | TP: ${analysis.takeProfit} pips\n💰 Entry: ${analysis.currentPrice} | R:R ${analysis.riskRewardRatio}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚠️ *Probability ≠ Guarantee* – Manage risk.\n🕐 ${new Date().toLocaleTimeString()}`;
    if (isMock) msg += `\n⚠️ *Using fallback data (real sources unavailable)*`;
    return msg;
}

async function autoScan() {
    if (!stateManager.state.settings.autoScanEnabled) return;
    if (stateManager.state.scanning.active) return;
    logger.info(`🔄 AUTO-SCAN: ${new Date().toLocaleTimeString()}`);
    await performScan(stateManager.state.settings.selectedTimeframe, true);
}

// ------------------------- Telegram UI (same as before) -------------------------
function getMainKeyboard() {
    return { inline_keyboard: [
        [{ text: "🔍 PROBABILITY SCAN", callback_data: "scan_manual" }],
        [{ text: "🎯 SELECT PAIRS", callback_data: "menu_pairs" }, { text: "⏰ TIMEFRAME", callback_data: "menu_timeframe" }],
        [{ text: "🤖 AUTO-SCAN", callback_data: "menu_autoscan" }, { text: "📊 HISTORY", callback_data: "menu_history" }],
        [{ text: "📈 STATUS", callback_data: "menu_status" }, { text: "📋 GUIDE", callback_data: "menu_guide" }],
        [{ text: "❓ HELP", callback_data: "menu_help" }]
    ] };
}

async function showMainMenu(messageId = null) {
    const s = stateManager.state.settings;
    const menu = `🏆 *ROBUST ANALYZER v5* | Production Ready\n━━━━━━━━━━━━━━━━━━━━━━\n📊 ${s.selectedPairs.length}/${PAIRS.length} pairs\n⏰ ${s.selectedTimeframe} ⭐\n🤖 ${s.autoScanEnabled ? 'ON' : 'OFF'}\n━━━━━━━━━━━━━━━━━━━━━━\n📊 85%+ → STRONG (2.5% risk)\n📊 75-84% → CONFIDENT (2.0%)\n📊 65-74% → NORMAL (1.5%)\n📊 55-64% → CAUTIOUS (0.8%)\n━━━━━━━━━━━━━━━━━━━━━━\n*YOU decide. Not the bot.*`;
    const kb = getMainKeyboard();
    if (messageId) await editMessageText(messageId, menu, kb);
    else await sendMessage(menu, kb);
}

async function showPairSelection(page = 0, messageId = null) {
    const perPage = 10;
    const totalPages = Math.ceil(PAIRS.length / perPage);
    const start = page * perPage;
    const currentPairs = PAIRS.slice(start, start + perPage);
    const selected = stateManager.state.settings.selectedPairs;
    let menu = `*🎯 SELECT PAIRS* (${selected.length}/${PAIRS.length})\nPage ${page + 1}/${totalPages}\n\n`;
    const keyboard = { inline_keyboard: [] };
    for (const p of currentPairs) {
        const check = selected.includes(p) ? '✅' : '⬜';
        keyboard.inline_keyboard.push([{ text: `${check} ${p}`, callback_data: `toggle_${p}` }]);
    }
    const nav = [];
    if (page > 0) nav.push({ text: "◀️ PREV", callback_data: `pairs_page_${page - 1}` });
    if (page < totalPages - 1) nav.push({ text: "NEXT ▶️", callback_data: `pairs_page_${page + 1}` });
    if (nav.length) keyboard.inline_keyboard.push(nav);
    keyboard.inline_keyboard.push([{ text: "✅ SELECT ALL", callback_data: "pairs_select_all" }, { text: "❌ CLEAR ALL", callback_data: "pairs_clear_all" }]);
    keyboard.inline_keyboard.push([{ text: "🔙 BACK TO MENU", callback_data: "menu_main" }]);
    if (messageId) await editMessageText(messageId, menu, keyboard);
    else await sendMessage(menu, keyboard);
}

async function showTimeframeSelection(messageId = null) {
    let menu = `*⏰ SELECT TIMEFRAME*\nCurrent: *${stateManager.state.settings.selectedTimeframe}*\n━━━━━━━━━━━━━━━━━━━━━━\n*Choose timeframe:*`;
    const keyboard = { inline_keyboard: [] };
    for (const tf of TIMEFRAMES) {
        const emoji = stateManager.state.settings.selectedTimeframe === tf ? '✅' : '🔘';
        keyboard.inline_keyboard.push([{ text: `${emoji} ${tf}`, callback_data: `set_tf_${tf}` }]);
    }
    keyboard.inline_keyboard.push([{ text: "🔙 BACK TO MENU", callback_data: "menu_main" }]);
    if (messageId) await editMessageText(messageId, menu, keyboard);
    else await sendMessage(menu, keyboard);
}

async function showAutoScanMenu(messageId = null) {
    const auto = stateManager.state.settings.autoScanEnabled;
    const status = auto ? "🟢 ACTIVE" : "🔴 STOPPED";
    const buttonText = auto ? "⏸️ STOP AUTO-SCAN" : "▶️ START AUTO-SCAN";
    const buttonData = auto ? "autoscan_stop" : "autoscan_start";
    let menu = `*🤖 AUTO-SCAN CONTROL*\nStatus: ${status}\nInterval: 15 minutes\nPrimary Timeframe: ${PRIMARY_TF}\n━━━━━━━━━━━━━━━━━━━━━━\nWhen enabled, bot automatically scans all selected pairs every 15 minutes.`;
    const keyboard = { inline_keyboard: [[{ text: buttonText, callback_data: buttonData }], [{ text: "🔙 BACK TO MENU", callback_data: "menu_main" }]] };
    if (messageId) await editMessageText(messageId, menu, keyboard);
    else await sendMessage(menu, keyboard);
}

async function showHistory(messageId = null) {
    const signals = stateManager.state.signals.slice(0, 15);
    let msg = `*📊 SIGNAL HISTORY*\n━━━━━━━━━━━━━━━━━━━━━━\n`;
    for (const s of signals) {
        let emoji = s.probability >= 85 ? '🔥🔥' : (s.probability >= 75 ? '🔥' : (s.probability >= 65 ? '📊' : '⚠️'));
        msg += `${emoji} ${s.signal === 'CALL' ? '📈' : '📉'} *${s.pair}* | ${s.probability}%\n   ${s.recommendedAction}\n\n`;
    }
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n📊 Total: ${stateManager.state.signals.length}\n💡 Use probability to guide decisions.`;
    const keyboard = { inline_keyboard: [[{ text: "🗑️ CLEAR HISTORY", callback_data: "history_clear" }], [{ text: "🔙 BACK TO MENU", callback_data: "menu_main" }]] };
    if (messageId) await editMessageText(messageId, msg, keyboard);
    else await sendMessage(msg, keyboard);
}

async function showStatus(messageId = null) {
    const uptime = Math.floor((Date.now() - global.botStartTime) / 60000);
    const signals = stateManager.state.signals;
    const high = signals.filter(s => s.probability >= 75).length;
    const msg = `*📈 STATUS*\n━━━━━━━━━━━━━━━━━━━━━━\nUptime: ${uptime}m\nPairs: ${stateManager.state.settings.selectedPairs.length}/${PAIRS.length}\nAuto: ${stateManager.state.settings.autoScanEnabled ? 'ON' : 'OFF'}\n━━━━━━━━━━━━━━━━━━━━━━\n*SIGNALS:* ${signals.length}\n🔥 High (≥75%): ${high}\n━━━━━━━━━━━━━━━━━━━━━━\n*YOU are the decision maker*`;
    const keyboard = { inline_keyboard: [[{ text: "🔙 BACK TO MENU", callback_data: "menu_main" }]] };
    if (messageId) await editMessageText(messageId, msg, keyboard);
    else await sendMessage(msg, keyboard);
}

async function showGuide(messageId = null) {
    const msg = `*📋 PROBABILITY GUIDE*\n━━━━━━━━━━━━━━━━━━━━━━\n🔥🔥 85-100% → STRONG (2.5% risk)\n🔥 75-84% → CONFIDENT (2.0%)\n📊 65-74% → NORMAL (1.5%)\n⚠️ 55-64% → CAUTIOUS (0.8%)\n❌ <55% → NO TRADE\n━━━━━━━━━━━━━━━━━━━━━━\n*GOLDEN RULES:*\n• Higher % = Larger position\n• Lower % = Skip or tiny\n• YOU decide based on risk\n━━━━━━━━━━━━━━━━━━━━━━\n*REMEMBER:* Probability ≠ Guarantee`;
    const keyboard = { inline_keyboard: [[{ text: "🔙 BACK TO MENU", callback_data: "menu_main" }]] };
    if (messageId) await editMessageText(messageId, msg, keyboard);
    else await sendMessage(msg, keyboard);
}

async function showHelp(messageId = null) {
    const msg = `*📋 HELP*\n━━━━━━━━━━━━━━━━━━━━━━\n*COMMANDS:*\n/start - Menu\n/scan - Manual scan\n/status - Status\n/help - Help\n━━━━━━━━━━━━━━━━━━━━━━\n*HOW TO USE:*\n1. Bot shows EVERY signal with %\n2. Check probability level\n3. YOU decide to trade or skip\n4. Higher % = Larger position\n━━━━━━━━━━━━━━━━━━━━━━\n*YOU are the decision maker*`;
    const keyboard = { inline_keyboard: [[{ text: "🔙 BACK TO MENU", callback_data: "menu_main" }]] };
    if (messageId) await editMessageText(messageId, msg, keyboard);
    else await sendMessage(msg, keyboard);
}

// ------------------------- Command & Callback Handlers -------------------------
async function handleCommand(text, chatId) {
    if (chatId.toString() !== TELEGRAM_CHAT_ID) return;
    await userLimiter.allow(chatId);
    logger.info(`📩 Command: ${text}`);
    if (text === '/start') await showMainMenu();
    else if (text === '/status') await showStatus();
    else if (text === '/scan') { await sendTypingAction(); await performScan(stateManager.state.settings.selectedTimeframe, false); }
    else if (text === '/help') await showHelp();
    else await sendMessage(`❌ Unknown command. Send /start for menu.`);
}

async function handleCallback(query) {
    const data = query.data;
    const msgId = query.message.message_id;
    const userId = query.from.id;
    await userLimiter.allow(userId);
    logger.info(`🔘 Callback: ${data}`);
    if (data === "menu_main") await showMainMenu(msgId);
    else if (data === "scan_manual") { await sendTypingAction(); await performScan(stateManager.state.settings.selectedTimeframe, false); await showMainMenu(msgId); }
    else if (data === "menu_pairs") await showPairSelection(0, msgId);
    else if (data === "menu_timeframe") await showTimeframeSelection(msgId);
    else if (data === "menu_autoscan") await showAutoScanMenu(msgId);
    else if (data === "menu_history") await showHistory(msgId);
    else if (data === "menu_status") await showStatus(msgId);
    else if (data === "menu_guide") await showGuide(msgId);
    else if (data === "menu_help") await showHelp(msgId);
    else if (data === "autoscan_start") {
        stateManager.update({ settings: { autoScanEnabled: true } });
        if (global.autoScanInterval) clearInterval(global.autoScanInterval);
        global.autoScanInterval = setInterval(autoScan, 15 * 60 * 1000);
        await showAutoScanMenu(msgId);
        setTimeout(autoScan, 2000);
    } else if (data === "autoscan_stop") {
        stateManager.update({ settings: { autoScanEnabled: false } });
        if (global.autoScanInterval) clearInterval(global.autoScanInterval);
        global.autoScanInterval = null;
        await showAutoScanMenu(msgId);
    } else if (data === "history_clear") {
        stateManager.update({ signals: [] });
        await showHistory(msgId);
    } else if (data === "pairs_select_all") { stateManager.update({ settings: { selectedPairs: [...PAIRS] } }); await showPairSelection(0, msgId); }
    else if (data === "pairs_clear_all") { stateManager.update({ settings: { selectedPairs: [] } }); await showPairSelection(0, msgId); }
    else if (data.startsWith("toggle_")) {
        const pair = data.slice(7);
        if (!PAIRS.includes(pair)) return;
        const current = stateManager.state.settings.selectedPairs;
        const updated = current.includes(pair) ? current.filter(p => p !== pair) : [...current, pair];
        stateManager.update({ settings: { selectedPairs: updated } });
        await showPairSelection(0, msgId);
    }
    else if (data.startsWith("pairs_page_")) {
        const page = parseInt(data.replace("pairs_page_", ""));
        if (!isNaN(page)) await showPairSelection(page, msgId);
    }
    else if (data.startsWith("set_tf_")) {
        const tf = data.replace("set_tf_", "");
        if (TIMEFRAMES.includes(tf)) {
            stateManager.update({ settings: { selectedTimeframe: tf } });
            await showTimeframeSelection(msgId);
        }
    }
    else {
        await sendMessage("Unknown action. Please use /start menu.");
    }
}

// ------------------------- Resilient Polling -------------------------
async function deleteWebhook(retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteWebhook`, { method: 'POST' });
            const json = await res.json();
            if (json.ok) { logger.info('✅ Webhook deleted'); return true; }
        } catch (e) { logger.warn(`Webhook delete attempt ${i+1} failed`); }
        if (i < retries-1) await new Promise(r => setTimeout(r, 2000));
    }
    return false;
}

async function startPolling() {
    if (!TELEGRAM_TOKEN) { logger.error('❌ No TELEGRAM_TOKEN'); return; }
    await deleteWebhook(3);
    logger.info('📡 Starting resilient long polling...');
    let lastUpdateId = 0;
    let consecutiveErrors = 0;

    const poll = async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 55000);
        try {
            const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=55`;
            const response = await fetch(url, { signal: controller.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const json = await response.json();
            if (json.ok && json.result) {
                consecutiveErrors = 0;
                for (const update of json.result) {
                    if (update.update_id > lastUpdateId) {
                        lastUpdateId = update.update_id;
                        if (update.message?.text) await handleCommand(update.message.text, update.message.chat.id);
                        if (update.callback_query) await handleCallback(update.callback_query);
                    }
                }
            }
        } catch (err) {
            consecutiveErrors++;
            const backoff = Math.min(30, Math.pow(2, consecutiveErrors)) * 1000;
            logger.warn(`Poll error (${consecutiveErrors}): ${err.message}. Retry in ${backoff}ms`);
            await new Promise(r => setTimeout(r, backoff));
        } finally {
            clearTimeout(timeout);
            setImmediate(poll);
        }
    };
    poll();
}

// ------------------------- Health Server -------------------------
function startHealthServer() {
    const server = http.createServer((req, res) => {
        if (req.url === '/health' || req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'alive',
                uptime: process.uptime(),
                signals: stateManager.state.signals.length,
                dataAvailable: true
            }));
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    server.listen(PORT, () => logger.info(`🩺 Health server listening on port ${PORT}`));
}

// ------------------------- Graceful Shutdown -------------------------
let isShuttingDown = false;
async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`🛑 Received ${signal}. Draining...`);
    if (global.autoScanInterval) clearInterval(global.autoScanInterval);
    while (stateManager.state.scanning.active) {
        await new Promise(r => setTimeout(r, 100));
    }
    await stateManager.persist();
    await sendMessage(`🛑 *Bot Shutting Down*\nSaving state...\n⏱️ ${new Date().toLocaleString()}`);
    logger.info('✅ Shutdown complete');
    process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (e) => { logger.error('Uncaught', { error: e.stack }); gracefulShutdown('UNCAUGHT'); });
process.on('unhandledRejection', (r) => { logger.error('Unhandled rejection', { reason: r }); });

// ------------------------- Startup -------------------------
global.botStartTime = Date.now();
console.log('\n' + '█'.repeat(60));
console.log('🏆 ROBUST ANALYZER v5 - PRODUCTION GRADE (No async-mutex)');
console.log('█'.repeat(60));
console.log(`Strategy: No overrides, real ADX, calibrated probabilities`);
console.log(`Indicators: RSI + ADX + MACD + BB + Divergence`);
console.log(`Risk: Probability-based fixed fraction`);
console.log(`Telegram: ${TELEGRAM_TOKEN ? '✅' : '❌'}`);
console.log(`HTTP Port: ${PORT}`);
console.log(`Data: Yahoo Finance → Alpha Vantage → Twelve Data → Yahoo Raw (NO MOCK)`);
console.log('█'.repeat(60) + '\n');

startHealthServer();
startPolling();

setTimeout(async () => {
    if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
        await sendMessage(`🤖 *ROBUST ANALYZER v5 ONLINE*\n━━━━━━━━━━━━━━━━━━━━━━\n✅ Real market data only\n✅ No forced trends or mock signals\n✅ Calibrated probabilities\n📱 *Send /start to begin*`);
    }
    console.log('🚀 Bot ready! Send /start');
}, 3000);

setInterval(() => {
    logger.info(`💓 Uptime: ${Math.floor((Date.now() - global.botStartTime) / 60000)}m | Auto: ${stateManager.state.settings.autoScanEnabled ? 'ON' : 'OFF'} | Signals: ${stateManager.state.stats.signalsGenerated}`);
}, 60000);
