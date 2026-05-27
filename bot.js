// ============================================================
// ULTIMATE BOT v14.0 – REAL DATA, TEST COMMAND, 40% THRESHOLD
// ============================================================

if (!globalThis.fetch) {
    const nodeFetch = require('node-fetch');
    const { AbortController } = require('node-abort-controller');
    globalThis.fetch = nodeFetch;
    globalThis.AbortController = AbortController;
}

const { RobustAnalyzer } = require('./analyzer.js');
const http = require('http');
const fs = require('fs');
const winston = require('winston');
const pairsConfig = require('./pairs.json');

// ------------------------- Configuration -------------------------
if (!pairsConfig.pairs || !pairsConfig.timeframes || !pairsConfig.primaryTimeframe) {
    console.error('❌ pairs.json missing required fields');
    process.exit(1);
}

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PORT = process.env.PORT || 8080;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    process.exit(1);
}

const YAHOO_SYMBOLS = {};
for (const pair of pairsConfig.pairs) {
    YAHOO_SYMBOLS[pair] = pair.replace('/', '') + '=X';
}

const PAIRS = pairsConfig.pairs;
const TIMEFRAMES = pairsConfig.timeframes;
const PRIMARY_TF = pairsConfig.primaryTimeframe;

// ------------------------- Logger (console + file) -------------------------
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    transports: [
        new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
        new winston.transports.File({ filename: 'logs/combined.log' }),
        new winston.transports.Console({ format: winston.format.simple() })
    ]
});

// ------------------------- Message Queue -------------------------
class MessageQueue {
    constructor() { this.queue = []; this.processing = false; }
    enqueue(sendFn, ...args) {
        this.queue.push({ sendFn, args });
        if (!this.processing) this.process();
    }
    async process() {
        this.processing = true;
        while (this.queue.length) {
            const { sendFn, args } = this.queue.shift();
            try {
                await sendFn(...args);
            } catch (e) {
                logger.error(`Message failed: ${e.message}`);
                this.queue.unshift({ sendFn, args });
                await new Promise(r => setTimeout(r, 1000));
            }
            await new Promise(r => setTimeout(r, 50));
        }
        this.processing = false;
    }
    async drain() { while (this.queue.length) await new Promise(r => setTimeout(r, 100)); }
}
const messageQueue = new MessageQueue();

// ------------------------- Cache -------------------------
const CACHE_MAX_SIZE = 200;
const CACHE_TTL = 60000;
const candleCache = new Map();
function cacheSet(key, data) {
    if (candleCache.size >= CACHE_MAX_SIZE) {
        const oldest = candleCache.keys().next().value;
        candleCache.delete(oldest);
    }
    candleCache.set(key, { data, timestamp: Date.now() });
}
function cacheGet(key) {
    const entry = candleCache.get(key);
    if (entry && Date.now() - entry.timestamp < CACHE_TTL) return entry.data;
    if (entry) candleCache.delete(key);
    return null;
}
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of candleCache.entries()) {
        if (now - entry.timestamp >= CACHE_TTL) candleCache.delete(key);
    }
}, 3600000);

// ------------------------- Rate Limiters -------------------------
class UserRateLimiter {
    constructor(maxPerMinute = 20) {
        this.users = new Map();
        this.max = maxPerMinute;
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
const userLimiter = new UserRateLimiter(20);

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

// ------------------------- Mutex & State Manager -------------------------
class Mutex {
    constructor() { this._queue = []; this._locked = false; }
    async acquire() { return new Promise((resolve) => { this._queue.push(resolve); this._dispatch(); }); }
    _dispatch() { if (this._locked) return; const next = this._queue.shift(); if (next) { this._locked = true; next(() => { this._locked = false; this._dispatch(); }); } }
    async runExclusive(fn) { const release = await this.acquire(); try { return await fn(); } finally { release(); } }
}

class StateManager {
    constructor() {
        this.state = {
            scanning: { active: false, cancelRequested: false, progressMsgId: null },
            settings: { selectedPairs: [...PAIRS], selectedTimeframe: PRIMARY_TF, autoScanEnabled: false },
            signals: [],
            stats: { signalsGenerated: 0, lastScanTime: null }
        };
        this.mutex = new Mutex();
        this.load().catch(e => logger.error('Load error', e));
    }
    async withMutex(fn) { return this.mutex.runExclusive(async () => fn(this.getSnapshot())); }
    getSnapshot() { return JSON.parse(JSON.stringify(this.state)); }
    async update(updates) {
        await this.mutex.runExclusive(async () => {
            if (updates.scanning) this.state.scanning = { ...this.state.scanning, ...updates.scanning };
            if (updates.settings) this.state.settings = { ...this.state.settings, ...updates.settings };
            if (updates.signals) this.state.signals = [...updates.signals];
            if (updates.stats) this.state.stats = { ...this.state.stats, ...updates.stats };
            await this.persist();
        });
    }
    async persist() {
        try {
            await fs.promises.writeFile('./state.json', JSON.stringify({
                settings: this.state.settings,
                signals: this.state.signals.slice(0, 1000),
                stats: this.state.stats
            }, null, 2));
        } catch (e) { logger.error('Persist failed', e); }
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
        } catch (e) { logger.error('Load failed', e); }
    }
}
const stateManager = new StateManager();
let lastDataTimestamp = Date.now();

// ------------------------- Circuit Breaker for Yahoo -------------------------
class CircuitBreaker {
    constructor(failureThreshold = 5, timeoutMs = 300000) {
        this.failures = 0;
        this.failureThreshold = failureThreshold;
        this.timeoutMs = timeoutMs;
        this.isOpen = false;
    }
    recordFailure() {
        this.failures++;
        if (this.failures >= this.failureThreshold) {
            this.isOpen = true;
            console.log(`⚠️ Circuit breaker OPEN for Yahoo API`);
            setTimeout(() => {
                this.isOpen = false;
                this.failures = 0;
                console.log(`✅ Circuit breaker CLOSED`);
            }, this.timeoutMs);
        }
    }
    recordSuccess() { this.failures = 0; this.isOpen = false; }
    canProceed() { return !this.isOpen; }
}
const yahooCircuitBreaker = new CircuitBreaker(5, 300000);

// ------------------------- Data Fetching (Real Yahoo + Fallback Mock) -------------------------
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

async function fetchYahooRaw(symbol, interval, retries = 3) {
    let period1;
    switch (interval) {
        case '1m': period1 = Math.floor(Date.now() / 1000) - 86400; break;
        case '5m': period1 = Math.floor(Date.now() / 1000) - 259200; break;
        case '15m': period1 = Math.floor(Date.now() / 1000) - 604800; break;
        case '30m': period1 = Math.floor(Date.now() / 1000) - 1209600; break;
        case '1h': period1 = Math.floor(Date.now() / 1000) - 2592000; break;
        default: period1 = Math.floor(Date.now() / 1000) - 604800;
    }
    const period2 = Math.floor(Date.now() / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=${interval}`;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 10000);
            const json = await response.json();
            if (!json.chart?.result?.[0]) return null;
            const quotes = json.chart.result[0].indicators.quote[0];
            if (!quotes?.open) return null;
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
            if (candles.length >= 50) {
                console.log(`✅ REAL DATA: ${candles.length} candles for ${symbol}`);
                return candles;
            }
            return null;
        } catch (e) {
            console.log(`⚠️ Fetch attempt ${attempt} for ${symbol} failed: ${e.message}`);
            await new Promise(r => setTimeout(r, Math.min(10, Math.pow(2, attempt)) * 1000));
        }
    }
    return null;
}

function generateMockCandles(symbol, interval, count = 100) {
    console.log(`⚠️ Using MOCK data for ${symbol}`);
    const basePrice = 1.1000;
    const now = Date.now();
    const intervalMs = { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000 }[interval] || 900000;
    const candles = [];
    let price = basePrice;
    for (let i = 0; i < count; i++) {
        price += (Math.random() - 0.5) * 0.001;
        const open = price;
        const close = price + (Math.random() - 0.5) * 0.0005;
        const high = Math.max(open, close) + Math.random() * 0.0005;
        const low = Math.min(open, close) - Math.random() * 0.0005;
        const time = now - (count - i) * intervalMs;
        candles.push({ open, high, low, close, volume: 1000 + Math.random() * 500, time });
        price = close;
    }
    return candles;
}

async function fetchCandles(symbol, interval) {
    console.log(`[FETCH] Trying ${symbol} ${interval}...`);
    const cacheKey = `${symbol}_${interval}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
        console.log(`[FETCH] Cache hit for ${symbol}`);
        return { candles: cached, isMock: false };
    }

    let candles = null;
    if (yahooCircuitBreaker.canProceed()) {
        candles = await fetchYahooRaw(symbol, interval);
        if (candles && candles.length >= 50) {
            cacheSet(cacheKey, candles);
            lastDataTimestamp = Date.now();
            yahooCircuitBreaker.recordSuccess();
            return { candles, isMock: false };
        } else {
            yahooCircuitBreaker.recordFailure();
        }
    }
    if (!candles || candles.length < 50) {
        candles = generateMockCandles(symbol, interval, 100);
        cacheSet(cacheKey, candles);
        lastDataTimestamp = Date.now();
        return { candles, isMock: true };
    }
    return null;
}

// ------------------------- Filters (relaxed for testing) -------------------------
function isLiquid(candles, pair) { return true; }
function isNewsTime() { return false; }
function isEndOfSession() { return false; }

// ------------------------- Telegram Helpers -------------------------
function escapeMarkdown(text) {
    return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

async function sendMessageRaw(text, replyMarkup = null) {
    await telegramRateLimiter.consume(1);
    const body = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown", disable_web_page_preview: true };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const json = await response.json();
    if (!json.ok && json.error_code === 429) {
        const retryAfter = json.parameters?.retry_after || 5;
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        return sendMessageRaw(text, replyMarkup);
    }
    if (!json.ok) throw new Error(`Telegram: ${json.description}`);
    return json;
}

function sendMessage(text, replyMarkup = null) {
    return messageQueue.enqueue(sendMessageRaw, text, replyMarkup);
}

async function editMessageText(messageId, text, replyMarkup = null) {
    if (!messageId) return;
    await telegramRateLimiter.consume(1);
    const body = { chat_id: TELEGRAM_CHAT_ID, message_id: messageId, text, parse_mode: "Markdown" };
    if (replyMarkup) body.reply_markup = replyMarkup;
    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
    } catch (e) { logger.warn(`EditMessage failed: ${e.message}`); }
}

async function sendTypingAction() {
    await telegramRateLimiter.consume(1);
    fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendChatAction`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, action: 'typing' })
    }).catch(() => {});
}

// ------------------------- Core Strategy -------------------------
const analyzer = new RobustAnalyzer(10000);

// ------------------------- Scan Function (threshold lowered to 40%) -------------------------
async function performScan(timeframe, isAuto = false) {
    return stateManager.withMutex(async (snapshot) => {
        if (snapshot.scanning.active) {
            if (!isAuto) await sendMessage("⏳ Scan already in progress...");
            return null;
        }
        const totalPairs = stateManager.state.settings.selectedPairs.length;
        await stateManager.update({ scanning: { active: true, cancelRequested: false, progressMsgId: null } });
        let progressMsgId = null;
        if (!isAuto) {
            await sendTypingAction();
            const startMsg = await sendMessage(`🔍 *SCAN STARTED*\n⏰ ${timeframe} | ${totalPairs} pairs\n_Processing..._`);
            if (startMsg?.result?.message_id) {
                progressMsgId = startMsg.result.message_id;
                await stateManager.update({ scanning: { progressMsgId } });
            }
        }
        let signals = 0;
        const pairsList = [...stateManager.state.settings.selectedPairs];
        for (let idx = 0; idx < pairsList.length; idx++) {
            if (stateManager.state.scanning.cancelRequested) {
                await sendMessage("⏹️ Scan cancelled.");
                break;
            }
            const pair = pairsList[idx];
            const symbol = YAHOO_SYMBOLS[pair];
            if (!symbol) continue;
            try {
                const fetchResult = await fetchCandles(symbol, timeframe);
                if (!fetchResult?.candles) continue;
                if (!isLiquid(fetchResult.candles, pair)) continue;
                if (isNewsTime()) continue;
                if (isEndOfSession()) continue;

                let htCandles = null;
                if (timeframe !== '1h') {
                    const htResult = await fetchCandles(symbol, '1h');
                    if (htResult) htCandles = htResult.candles;
                }
                const analysis = analyzer.calculateProbability(fetchResult.candles, pair, timeframe, htCandles);
                // TEMPORARY LOWERED THRESHOLD TO 40%
                if (analysis.probability >= 40 && analysis.signal !== 'NEUTRAL') {
                    signals++;
                    const signalText = formatSignal(analysis, pair, timeframe, isAuto, fetchResult.isMock);
                    const actionKeyboard = {
                        inline_keyboard: [[
                            { text: "✅ WIN", callback_data: `record_win_${analysis.rawScore}` },
                            { text: "❌ LOSS", callback_data: `record_loss_${analysis.rawScore}` }
                        ]]
                    };
                    await sendMessage(signalText, actionKeyboard);
                    const newSignals = [analysis, ...stateManager.state.signals].slice(0, 1000);
                    await stateManager.update({ signals: newSignals, stats: { signalsGenerated: newSignals.length, lastScanTime: Date.now() } });
                }
            } catch (e) {
                logger.error(`Error processing ${pair}: ${e.message}`);
            }
            if (!isAuto && progressMsgId && idx % 5 === 0) {
                const percent = Math.round((idx / totalPairs) * 100);
                const bar = '█'.repeat(Math.floor(percent / 5)) + '░'.repeat(20 - Math.floor(percent / 5));
                const cancelButton = { inline_keyboard: [[{ text: "❌ CANCEL SCAN", callback_data: "cancel_scan" }]] };
                await editMessageText(progressMsgId, `🔍 *SCANNING* ${percent}%\n\`${bar}\`\n${idx}/${totalPairs} pairs`, cancelButton);
                await sendTypingAction();
            }
            await new Promise(r => setTimeout(r, 200));
        }
        await stateManager.update({ scanning: { active: false, cancelRequested: false, progressMsgId: null } });
        if (!isAuto && progressMsgId) {
            await editMessageText(progressMsgId, `✅ *SCAN COMPLETE*: ${signals} signals`);
        }
        return signals;
    });
}

function formatSignal(analysis, pair, timeframe, isAuto, isMock) {
    const arrow = analysis.signal === 'CALL' ? '📈' : (analysis.signal === 'PUT' ? '📉' : '➡️');
    const bar = '█'.repeat(Math.floor(analysis.probability / 5)) + '░'.repeat(20 - Math.floor(analysis.probability / 5));
    let msg = `${isAuto ? '🤖 AUTO-SCAN\n' : ''}*${arrow} SIGNAL ${arrow}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 *${pair}* | ${timeframe}\n🎯 *${analysis.signal === 'CALL' ? 'CALL (BUY)' : 'PUT (SELL)'}* | Probability: *${analysis.probability}%*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 *PROBABILITY METER:*\n\`${bar}\` ${analysis.probability}%\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📈 *TECHNICALS:* RSI ${analysis.rsi} | ADX ${analysis.adx} | Regime ${analysis.marketRegime}\n🌀 Divergence: ${analysis.divergence}\n📊 Factors: ${analysis.activeFactors.join(', ') || 'none'}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 *ACTION:* ${analysis.recommendedAction} (Risk ${analysis.suggestedRisk})\n🛡️ SL: ${analysis.stopLoss} pips | TP: ${analysis.takeProfit} pips\n💰 Entry: ${analysis.currentPrice} | R:R ${analysis.riskRewardRatio}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚠️ *Probability ≠ Guarantee* – Manage risk.\n🕐 ${new Date().toLocaleTimeString()}`;
    if (isMock) msg += `\n⚠️ *Using simulated data (real data unavailable)*`;
    return msg;
}

async function autoScan() {
    if (!stateManager.state.settings.autoScanEnabled) return;
    if (stateManager.state.scanning.active) return;
    logger.info(`🔄 AUTO-SCAN: ${new Date().toLocaleTimeString()}`);
    await performScan(stateManager.state.settings.selectedTimeframe, true);
}

// ------------------------- UI Components -------------------------
function getMainKeyboard() {
    return { inline_keyboard: [
        [{ text: "🔍 PROBABILITY SCAN", callback_data: "scan_manual" }],
        [{ text: "🎯 SELECT PAIRS", callback_data: "menu_pairs" }, { text: "⏰ TIMEFRAME", callback_data: "menu_timeframe" }],
        [{ text: "🤖 AUTO-SCAN", callback_data: "menu_autoscan" }, { text: "📊 HISTORY", callback_data: "menu_history" }],
        [{ text: "📈 STATUS", callback_data: "menu_status" }, { text: "📋 GUIDE", callback_data: "menu_guide" }],
        [{ text: "📊 STATS", callback_data: "menu_stats" }, { text: "🧪 TEST", callback_data: "test_signal" }, { text: "📡 TEST DATA", callback_data: "test_data" }, { text: "💪 FORCE", callback_data: "force_signal" }],
        [{ text: "❓ HELP", callback_data: "menu_help" }]
    ] };
}

async function showMainMenu(messageId = null) {
    const s = stateManager.state.settings;
    const menu = `🏆 *INSTITUTIONAL BOT v14* – REAL STRATEGY\n━━━━━━━━━━━━━━━━━━━━━━\n📊 ${s.selectedPairs.length}/${PAIRS.length} pairs\n⏰ ${s.selectedTimeframe} ⭐\n🤖 ${s.autoScanEnabled ? 'ON' : 'OFF'}\n━━━━━━━━━━━━━━━━━━━━━━\n📊 85%+ → STRONG (2.5% risk)\n📊 75-84% → CONFIDENT (2.0%)\n📊 65-74% → NORMAL (1.5%)\n📊 55-64% → CAUTIOUS (0.8%)\n━━━━━━━━━━━━━━━━━━━━━━\n*Threshold temporarily 40% for testing*`;
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
        keyboard.inline_keyboard.push([{ text: `${check} ${p}`, callback_data: `toggle_${p}_${page}` }]);
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
        msg += `${emoji} ${s.signal === 'CALL' ? '📈' : '📉'} *${escapeMarkdown(s.pair)}* | ${s.probability}%\n   ${escapeMarkdown(s.recommendedAction)}\n\n`;
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
    const dataAge = Math.floor((Date.now() - lastDataTimestamp) / 1000);
    const msg = `*📈 STATUS*\n━━━━━━━━━━━━━━━━━━━━━━\nUptime: ${uptime}m\nPairs: ${stateManager.state.settings.selectedPairs.length}/${PAIRS.length}\nAuto: ${stateManager.state.settings.autoScanEnabled ? 'ON' : 'OFF'}\nData age: ${dataAge}s ago\n━━━━━━━━━━━━━━━━━━━━━━\n*SIGNALS:* ${signals.length}\n🔥 High (≥75%): ${high}\n━━━━━━━━━━━━━━━━━━━━━━\n*Real strategy active*`;
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
    const msg = `*📋 HELP*\n━━━━━━━━━━━━━━━━━━━━━━\n*COMMANDS:*\n/start - Menu\n/scan - Manual scan\n/status - Status\n/stats - Strategy performance\n/testdata - Test Yahoo data fetch\n/forcesignal - Force test signal\n/help - Help\n━━━━━━━━━━━━━━━━━━━━━━\n*HOW TO USE:*\n1. Bot shows EVERY signal with %\n2. After a trade, click WIN/LOSS to calibrate\n3. Higher % = Larger position\n━━━━━━━━━━━━━━━━━━━━━━\n*YOU are the decision maker*`;
    const keyboard = { inline_keyboard: [[{ text: "🔙 BACK TO MENU", callback_data: "menu_main" }]] };
    if (messageId) await editMessageText(messageId, msg, keyboard);
    else await sendMessage(msg, keyboard);
}

async function showStats(messageId = null) {
    const trades = analyzer.tradeHistory.slice(-50);
    if (trades.length === 0) {
        const msg = "📊 *No trade data yet.*\nAfter you receive signals and mark WIN/LOSS, stats will appear here.";
        if (messageId) await editMessageText(messageId, msg);
        else await sendMessage(msg);
        return;
    }
    const wins = trades.filter(t => t.win).length;
    const winRate = (wins / trades.length * 100).toFixed(1);
    const returns = trades.map(t => t.win ? 1 : -1);
    const avgReturn = returns.reduce((a,b)=>a+b,0)/returns.length;
    const variance = returns.reduce((a,b)=>a + Math.pow(b - avgReturn,2),0)/returns.length;
    const sharpe = avgReturn / (Math.sqrt(variance) || 1);
    const profitFactor = (trades.filter(t=>t.win).length / (trades.filter(t=>!t.win).length || 1)).toFixed(2);
    const msg = `📊 *STRATEGY STATS* (last ${trades.length} trades)\n━━━━━━━━━━━━━━━━━━━━━━\n✅ Win rate: ${winRate}%\n📈 Sharpe ratio: ${sharpe.toFixed(2)}\n💵 Profit factor: ${profitFactor}\n🎯 Total trades: ${trades.length}\n━━━━━━━━━━━━━━━━━━━━━━\n*Keep marking WIN/LOSS to improve calibration!*`;
    const keyboard = { inline_keyboard: [[{ text: "🔙 BACK TO MENU", callback_data: "menu_main" }]] };
    if (messageId) await editMessageText(messageId, msg, keyboard);
    else await sendMessage(msg, keyboard);
}

// ------------------------- Test & Force Signals -------------------------
async function testSignal(messageId = null) {
    await sendTypingAction();
    await sendMessage("🧪 *Testing real strategy on EUR/USD 15m*");
    const symbol = 'EURUSD=X';
    const timeframe = '15m';
    const fetchResult = await fetchCandles(symbol, timeframe);
    if (!fetchResult?.candles) {
        await sendMessage("❌ Test failed: Could not fetch data.");
        return;
    }
    const analysis = analyzer.calculateProbability(fetchResult.candles, "EUR/USD", timeframe, null);
    const resultMsg = `🧪 *TEST RESULT*\n━━━━━━━━━━━━━━━━━━━━━━\n📊 Signal: ${analysis.signal}\n🎯 Probability: ${analysis.probability}%\n📈 RSI: ${analysis.rsi} | ADX: ${analysis.adx}\n🌀 Divergence: ${analysis.divergence}\n📊 Factors: ${analysis.activeFactors.join(', ')}\n━━━━━━━━━━━━━━━━━━━━━━\nGuidance: ${analysis.guidance}\n\nIf probability <55%, market conditions are not favourable.`;
    await sendMessage(resultMsg);
}

async function testDataFetch(messageId = null) {
    await sendTypingAction();
    await sendMessage("📡 *Testing Yahoo Finance data fetch for EUR/USD 15m...*");
    
    const symbol = 'EURUSD=X';
    const timeframe = '15m';
    const fetchResult = await fetchCandles(symbol, timeframe);
    
    if (!fetchResult || !fetchResult.candles) {
        await sendMessage("❌ *No data received.*\nPossible reasons:\n- Network issue\n- Yahoo API changed\n- Symbol mapping error\n- Circuit breaker open");
        return;
    }
    
    const lastCandles = fetchResult.candles.slice(-3);
    let candleInfo = lastCandles.map(c => 
        `🕒 ${new Date(c.time).toLocaleTimeString()} | O:${c.open.toFixed(5)} H:${c.high.toFixed(5)} L:${c.low.toFixed(5)} C:${c.close.toFixed(5)}`
    ).join('\n');
    
    const msg = `📊 *Yahoo Data Test*\n━━━━━━━━━━━━━━━━━━━━━━\n✅ *${fetchResult.candles.length} candles* fetched for ${symbol}\n📉 *Data source:* ${fetchResult.isMock ? '⚠️ MOCK (simulated)' : '✅ REAL Yahoo Finance'}\n━━━━━━━━━━━━━━━━━━━━━━\n*Last 3 candles:*\n${candleInfo}\n━━━━━━━━━━━━━━━━━━━━━━\n*If data is real, your bot is working.*\nIf no signals appear, market conditions don't meet entry criteria.`;
    await sendMessage(msg);
}

async function forceSignal(messageId = null) {
    await sendTypingAction();
    await sendMessage("💪 *FORCING A SIGNAL (mock uptrend)*");
    const mockCandles = [];
    let price = 1.1000;
    for (let i = 0; i < 100; i++) {
        price += 0.0002;
        mockCandles.push({
            open: price - 0.0001, high: price + 0.0001, low: price - 0.0002, close: price,
            volume: 2000, time: Date.now() - (100-i)*900000
        });
    }
    const analysis = analyzer.calculateProbability(mockCandles, "EUR/USD", "15m", null);
    const resultMsg = `💪 *FORCED SIGNAL RESULT*\n━━━━━━━━━━━━━━━━━━━━━━\n📊 Signal: ${analysis.signal}\n🎯 Probability: ${analysis.probability}%\n📈 RSI: ${analysis.rsi} | ADX: ${analysis.adx}\n🌀 Divergence: ${analysis.divergence}\n📊 Factors: ${analysis.activeFactors.join(', ')}\n━━━━━━━━━━━━━━━━━━━━━━\nIf probability <55%, strategy logic is too strict. If >55%, bot works and real data is the issue.`;
    await sendMessage(resultMsg);
}

// ------------------------- Command & Callback Handlers -------------------------
async function handleCommand(text, chatId) {
    if (chatId.toString() !== TELEGRAM_CHAT_ID) return;
    await userLimiter.allow(chatId);
    logger.info(`📩 Command: ${text}`);
    if (text === '/start') await showMainMenu();
    else if (text === '/status') await showStatus();
    else if (text === '/stats') await showStats();
    else if (text === '/scan') { await sendTypingAction(); await performScan(stateManager.state.settings.selectedTimeframe, false); }
    else if (text === '/testdata') await testDataFetch();
    else if (text === '/forcesignal') await forceSignal();
    else if (text === '/test') await testSignal();
    else if (text === '/help') await showHelp();
    else await sendMessage(`❌ Unknown command. Send /start for menu.`);
}

async function handleCallback(query) {
    const data = query.data;
    const msgId = query.message.message_id;
    const userId = query.from.id;
    await userLimiter.allow(userId);
    logger.info(`🔘 Callback: ${data}`);

    if (data.startsWith("record_win")) {
        const rawScore = parseInt(data.split('_')[2]);
        analyzer.recordTradeOutcome(true, rawScore, 2);
        await sendMessage("👍 Trade recorded as WIN. Calibration updated.");
        await editMessageText(msgId, query.message.text);
        return;
    }
    if (data.startsWith("record_loss")) {
        const rawScore = parseInt(data.split('_')[2]);
        analyzer.recordTradeOutcome(false, rawScore, -2);
        await sendMessage("👎 Trade recorded as LOSS. Calibration updated.");
        await editMessageText(msgId, query.message.text);
        return;
    }
    if (data === "cancel_scan") {
        await stateManager.update({ scanning: { cancelRequested: true } });
        await sendMessage("⏹️ Cancelling scan...");
        return;
    }
    if (data === "test_data") { await testDataFetch(msgId); return; }
    if (data === "force_signal") { await forceSignal(msgId); return; }
    if (data === "test_signal") { await testSignal(msgId); return; }
    if (data === "history_clear") {
        const confirmKeyboard = { inline_keyboard: [[
            { text: "✅ YES, CLEAR", callback_data: "history_clear_confirm" },
            { text: "❌ CANCEL", callback_data: "menu_history" }
        ]] };
        await editMessageText(msgId, "⚠️ *Are you sure?* This will delete all signal history permanently.", confirmKeyboard);
        return;
    }
    if (data === "history_clear_confirm") {
        await stateManager.update({ signals: [] });
        await showHistory(msgId);
        return;
    }
    // Main menu handlers
    if (data === "menu_main") await showMainMenu(msgId);
    else if (data === "menu_stats") await showStats(msgId);
    else if (data === "scan_manual") { await sendTypingAction(); await performScan(stateManager.state.settings.selectedTimeframe, false); await showMainMenu(msgId); }
    else if (data === "menu_pairs") await showPairSelection(0, msgId);
    else if (data === "menu_timeframe") await showTimeframeSelection(msgId);
    else if (data === "menu_autoscan") await showAutoScanMenu(msgId);
    else if (data === "menu_history") await showHistory(msgId);
    else if (data === "menu_status") await showStatus(msgId);
    else if (data === "menu_guide") await showGuide(msgId);
    else if (data === "menu_help") await showHelp(msgId);
    else if (data === "autoscan_start") {
        await stateManager.update({ settings: { autoScanEnabled: true } });
        if (global.autoScanInterval) clearInterval(global.autoScanInterval);
        global.autoScanInterval = setInterval(autoScan, 15 * 60 * 1000);
        await showAutoScanMenu(msgId);
        setTimeout(autoScan, 2000);
    } else if (data === "autoscan_stop") {
        await stateManager.update({ settings: { autoScanEnabled: false } });
        if (global.autoScanInterval) clearInterval(global.autoScanInterval);
        global.autoScanInterval = null;
        await showAutoScanMenu(msgId);
    } else if (data === "pairs_select_all") { await stateManager.update({ settings: { selectedPairs: [...PAIRS] } }); await showPairSelection(0, msgId); }
    else if (data === "pairs_clear_all") { await stateManager.update({ settings: { selectedPairs: [] } }); await showPairSelection(0, msgId); }
    else if (data.startsWith("toggle_")) {
        const parts = data.split('_');
        const pair = parts[1];
        const page = parseInt(parts[2]) || 0;
        if (!PAIRS.includes(pair)) return;
        const current = stateManager.state.settings.selectedPairs;
        const updated = current.includes(pair) ? current.filter(p => p !== pair) : [...current, pair];
        await stateManager.update({ settings: { selectedPairs: updated } });
        await showPairSelection(page, msgId);
    }
    else if (data.startsWith("pairs_page_")) {
        const page = parseInt(data.replace("pairs_page_", ""));
        if (!isNaN(page)) await showPairSelection(page, msgId);
    }
    else if (data.startsWith("set_tf_")) {
        const tf = data.replace("set_tf_", "");
        if (TIMEFRAMES.includes(tf)) {
            await stateManager.update({ settings: { selectedTimeframe: tf } });
            await showTimeframeSelection(msgId);
        }
    }
    else {
        await sendMessage("Unknown action. Use /start menu.");
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
    await deleteWebhook(3);
    logger.info('📡 Starting resilient long polling (forever loop)...');
    let lastUpdateId = 0;
    let consecutiveErrors = 0;
    (async function pollForever() {
        while (true) {
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
                            setImmediate(() => {
                                if (update.message?.text) handleCommand(update.message.text, update.message.chat.id).catch(e => logger.error('Command error', e));
                                if (update.callback_query) handleCallback(update.callback_query).catch(e => logger.error('Callback error', e));
                            });
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
            }
        }
    })();
}

function startHealthServer() {
    const server = http.createServer((req, res) => {
        if (req.url === '/health' || req.url === '/') {
            const dataAgeSeconds = (Date.now() - lastDataTimestamp) / 1000;
            const healthy = dataAgeSeconds < 300;
            res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: healthy ? 'alive' : 'degraded',
                uptime: process.uptime(),
                signals: stateManager.state.signals.length,
                lastDataSecondsAgo: Math.round(dataAgeSeconds)
            }));
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    server.listen(PORT, () => logger.info(`🩺 Health server on port ${PORT}`));
}

let isShuttingDown = false;
async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`🛑 Received ${signal}. Draining...`);
    if (global.autoScanInterval) clearInterval(global.autoScanInterval);
    while (stateManager.state.scanning.active) await new Promise(r => setTimeout(r, 100));
    await messageQueue.drain();
    await stateManager.persist();
    await sendMessage(`🛑 *Bot Shutting Down*\nSaving state...`);
    logger.info('✅ Shutdown complete');
    process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (e) => { logger.error('Uncaught', { error: e.stack }); gracefulShutdown('UNCAUGHT'); });
process.on('unhandledRejection', (r) => { logger.error('Unhandled rejection', { reason: r }); });

global.botStartTime = Date.now();
console.log('\n' + '█'.repeat(60));
console.log('🏆 INSTITUTIONAL BOT v14 – REAL STRATEGY + TEST DATA');
console.log('█'.repeat(60));
console.log(`Data: Yahoo Real + Fallback Mock | Full indicators active | Threshold 40%`);
console.log(`Pairs: ${PAIRS.length} pairs loaded`);
console.log(`Telegram: ✅ token and chat ID set`);
console.log(`HTTP Port: ${PORT}`);
console.log('█'.repeat(60) + '\n');

startHealthServer();
startPolling();

setTimeout(async () => {
    await sendMessage(`🤖 *INSTITUTIONAL BOT v14 ONLINE*\n━━━━━━━━━━━━━━━━━━━━━━\n✅ Real strategy active (no diagnostic mode)\n✅ Use /testdata to verify data fetch\n✅ Threshold temporarily 40% for testing\n📱 *Send /start to begin*`);
    console.log('🚀 Bot ready! Send /start');
}, 3000);
