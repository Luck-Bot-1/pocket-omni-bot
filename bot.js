const { LegendaryAnalyzer } = require('./analyzer.js');
const yahooFinance = require('yahoo-finance2').default;
const https = require('https');
const http = require('http');
const fs = require('fs');
const winston = require('winston');
const pairsConfig = require('./pairs.json');

// ---------- Structured Logger ----------
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

// ---------- Configuration ----------
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

// ---------- Bounded Cache with TTL ----------
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

// ---------- Token Bucket Rate Limiter ----------
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

// ---------- Yahoo Finance fetch using official package ----------
async function fetchYahoo(symbol, interval, retries = 3) {
    // Map our interval to Yahoo Finance chart interval strings
    const intervalMap = {
        '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '1h'
    };
    const yahooInterval = intervalMap[interval] || '15m';

    const endDate = new Date();
    let startDate = new Date();
    switch (interval) {
        case '1m': startDate.setDate(startDate.getDate() - 1); break;
        case '5m': startDate.setDate(startDate.getDate() - 2); break;
        case '15m': startDate.setDate(startDate.getDate() - 7); break;
        case '30m': startDate.setDate(startDate.getDate() - 14); break;
        case '1h': startDate.setDate(startDate.getDate() - 30); break;
        case '4h': startDate.setDate(startDate.getDate() - 30); break;
        default: startDate.setDate(startDate.getDate() - 7);
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            logger.info(`📡 Fetching ${symbol} (${interval}) attempt ${attempt}...`);
            
            // Use chart() instead of historical()
            const result = await yahooFinance.chart(symbol, {
                period1: startDate,
                period2: endDate,
                interval: yahooInterval,
                includePrePost: false,
                events: 'div,splits'
            });

            if (!result || !result.quotes || result.quotes.length === 0) {
                logger.warn(`Attempt ${attempt} for ${symbol} returned no data`);
                continue;
            }

            // Convert quotes to our candle format
            const candles = result.quotes.map(q => ({
                open: q.open,
                high: q.high,
                low: q.low,
                close: q.close,
                volume: q.volume || 1000,
                time: new Date(q.date).getTime()
            })).filter(c => c.open !== null && c.close !== null);

            logger.info(`✅ Successfully fetched ${candles.length} candles for ${symbol}`);
            return candles;
        } catch (error) {
            logger.warn(`Yahoo attempt ${attempt} failed for ${symbol}: ${error.message}`);
            if (attempt === retries) {
                logger.error(`❌ All Yahoo attempts failed for ${symbol}`);
                return null;
            }
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
    }
    return null;
}
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
    }
    return null;
}

// ---------- Main fetch with cache ----------
async function fetchCandles(symbol, interval, timeoutMs = 10000) {
    const cacheKey = `${symbol}_${interval}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
        logger.debug(`Cache hit for ${symbol}`);
        return cached;
    }

    const candles = await fetchYahoo(symbol, interval, 3);
    if (candles && candles.length > 0) {
        cacheSet(cacheKey, candles);
        return candles;
    }

    logger.error(`❌ No data for ${symbol} after all retries`);
    return null;
}

// ---------- Startup connectivity test ----------
async function testYahooConnectivity() {
    try {
        const testSymbol = 'EURUSD=X';
        const result = await yahooFinance.historical(testSymbol, {
            period1: new Date(Date.now() - 24 * 60 * 60 * 1000),
            interval: '15m'
        });
        if (result && result.length > 0) {
            logger.info('✅ Yahoo Finance connectivity test PASSED');
            return true;
        } else {
            logger.error('❌ Yahoo Finance connectivity test FAILED (no data)');
            return false;
        }
    } catch (error) {
        logger.error(`❌ Yahoo Finance connectivity test FAILED: ${error.message}`);
        return false;
    }
}

// ---------- Immutable State Manager ----------
class StateManager {
    constructor() {
        this.state = {
            scanning: { active: false, userId: null, startTime: null, totalPairs: 0, processed: 0, progressMsgId: null },
            settings: { selectedPairs: [...PAIRS], selectedTimeframe: PRIMARY_TF, autoScanEnabled: false },
            signals: [],
            stats: { signalsGenerated: 0, lastScanTime: null }
        };
        this.locks = new Map();
    }

    async withMutex(key, fn) {
        while (this.locks.get(key)) await new Promise(r => setTimeout(r, 10));
        this.locks.set(key, true);
        try {
            return await fn(this.getSnapshot());
        } finally {
            this.locks.delete(key);
        }
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
        this.persist();
    }

    persist() {
        try {
            fs.writeFileSync('./state.json', JSON.stringify({ settings: this.state.settings, signals: this.state.signals.slice(0, 1000), stats: this.state.stats }, null, 2));
        } catch (e) { logger.error('State persist failed', { error: e.message }); }
    }

    load() {
        try {
            if (fs.existsSync('./state.json')) {
                const saved = JSON.parse(fs.readFileSync('./state.json', 'utf8'));
                this.state.settings = { ...this.state.settings, ...saved.settings };
                this.state.signals = saved.signals || [];
                this.state.stats = saved.stats || { signalsGenerated: 0, lastScanTime: null };
            }
        } catch (e) { logger.error('State load failed', { error: e.message }); }
    }
}

const stateManager = new StateManager();
stateManager.load();

// ---------- Telegram API helpers ----------
async function sendMessage(text, replyMarkup = null, priority = 5) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) { logger.info(`📱 ${text.substring(0, 200)}...`); return; }
    await telegramRateLimiter.consume(1);
    return new Promise((resolve) => {
        const data = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown", disable_web_page_preview: true };
        if (replyMarkup) data.reply_markup = replyMarkup;
        const postData = JSON.stringify(data);
        const req = https.request(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
        }, (res) => {
            let resp = '';
            res.on('data', d => resp += d);
            res.on('end', () => {
                try { resolve(JSON.parse(resp)); } catch(e) { resolve({ ok: false }); }
            });
        });
        req.on('error', () => resolve({ ok: false }));
        req.write(postData);
        req.end();
    });
}

async function editMessageText(messageId, text, replyMarkup = null) {
    if (!messageId) return;
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
    await telegramRateLimiter.consume(1);
    return new Promise((resolve) => {
        const data = { chat_id: TELEGRAM_CHAT_ID, message_id: messageId, text, parse_mode: "Markdown" };
        if (replyMarkup) data.reply_markup = replyMarkup;
        const postData = JSON.stringify(data);
        const req = https.request(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
        }, (res) => {
            let resp = '';
            res.on('data', d => resp += d);
            res.on('end', () => {
                try { resolve(JSON.parse(resp)); } catch(e) { resolve({ ok: false }); }
            });
        });
        req.on('error', () => resolve({ ok: false }));
        req.write(postData);
        req.end();
    });
}

async function sendTypingAction() {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
    await telegramRateLimiter.consume(1);
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendChatAction`;
    return new Promise((resolve) => {
        const postData = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, action: 'typing' });
        const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } }, () => { resolve(); });
        req.on('error', () => resolve());
        req.write(postData);
        req.end();
    });
}

// ---------- Graceful shutdown ----------
let isShuttingDown = false;
let autoScanInterval = null;
async function gracefulShutdown(signal) {
    if (isShuttingDown) process.exit(1);
    isShuttingDown = true;
    logger.info(`🛑 Received ${signal}. Shutting down...`);
    if (autoScanInterval) clearInterval(autoScanInterval);
    while (stateManager.state.scanning.active) await new Promise(r => setTimeout(r, 100));
    stateManager.persist();
    if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
        await sendMessage(`🛑 *Bot Shutting Down*\nSaving state...\n⏱️ ${new Date().toLocaleString()}`);
    }
    logger.info('✅ Shutdown complete');
    process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (e) => { logger.error('Uncaught', { error: e.stack }); gracefulShutdown('UNCAUGHT'); });
process.on('unhandledRejection', (r) => { logger.error('Unhandled rejection', { reason: r }); });

const analyzer = new LegendaryAnalyzer();

// ---------- Scan with progress bar ----------
async function performScan(timeframe, isAuto = false, userId = null) {
    return stateManager.withMutex('scan', async (snapshot) => {
        if (snapshot.scanning.active) {
            if (!isAuto) await sendMessage("⏳ Scan already in progress...");
            return null;
        }
        const totalPairs = stateManager.state.settings.selectedPairs.length;
        stateManager.update({ scanning: { active: true, userId, startTime: Date.now(), totalPairs, processed: 0, progressMsgId: null } });
        let progressMsgId = null;
        if (!isAuto) {
            const startMsg = await sendMessage(`🔍 *SCAN STARTED*\n━━━━━━━━━━━━━━━━━━━━━━\n⏰ ${timeframe} | ${totalPairs} pairs\n_Processing..._`);
            if (startMsg && startMsg.result && startMsg.result.message_id) {
                progressMsgId = startMsg.result.message_id;
                stateManager.update({ scanning: { progressMsgId } });
            }
            await sendTypingAction();
        }
        let signals = 0, legendary = 0, exceptional = 0, high = 0, good = 0, moderate = 0, low = 0;
        let dataFailures = 0;
        const pairsList = [...stateManager.state.settings.selectedPairs];
        for (let idx = 0; idx < pairsList.length; idx++) {
            const pair = pairsList[idx];
            const symbol = YAHOO_SYMBOLS[pair];
            if (!symbol) continue;
            const candles = await fetchCandles(symbol, timeframe);
            if (!candles || candles.length < 50) {
                dataFailures++;
                logger.warn(`Insufficient candles for ${pair}`);
                continue;
            }
            const analysis = analyzer.calculateProbability(candles, pair, timeframe);
            if (analysis.probability >= 55) signals++;
            if (analysis.probability >= 92) legendary++;
            else if (analysis.probability >= 85) exceptional++;
            else if (analysis.probability >= 78) high++;
            else if (analysis.probability >= 70) good++;
            else if (analysis.probability >= 62) moderate++;
            else if (analysis.probability >= 55) low++;
            const msg = formatSignal(analysis, pair, timeframe, isAuto);
            await sendMessage(msg, null, analysis.probability >= 85 ? 1 : 5);
            const newSignals = [analysis, ...stateManager.state.signals].slice(0, 1000);
            stateManager.update({ signals: newSignals, stats: { signalsGenerated: newSignals.length, lastScanTime: Date.now() } });
            if (!isAuto && progressMsgId && idx % 5 === 0) {
                const percent = Math.round((idx / totalPairs) * 100);
                const bar = '█'.repeat(Math.floor(percent / 5)) + '░'.repeat(20 - Math.floor(percent / 5));
                const progressText = `🔍 *SCANNING* ${percent}%\n\`${bar}\`\n${idx}/${totalPairs} pairs`;
                await editMessageText(progressMsgId, progressText);
                await sendTypingAction();
            }
            await new Promise(r => setTimeout(r, 200));
        }
        stateManager.update({ scanning: { active: false, progressMsgId: null } });
        logger.info(`SCAN COMPLETE: ${signals} signals | Data failures: ${dataFailures} | L:${legendary} E:${exceptional} H:${high} G:${good} M:${moderate} Lw:${low}`);
        if (!isAuto && progressMsgId) {
            let completionMsg = `✅ *SCAN COMPLETE*: ${signals} signals\n👑${legendary} 🔥${exceptional} 🔥${high} 📊${good} ⚡${moderate} ⚠️${low}\n━━━━━━━━━━━━━━━━━━━━━━\nReview probabilities above. YOU decide.`;
            if (dataFailures > 0) {
                completionMsg += `\n⚠️ ${dataFailures} pairs had no data – check Yahoo Finance connectivity.`;
            }
            await editMessageText(progressMsgId, completionMsg);
        }
        return signals;
    });
}

async function autoScan() {
    if (!stateManager.state.settings.autoScanEnabled) return;
    if (stateManager.state.scanning.active) return;
    logger.info(`🔄 AUTO-SCAN: ${new Date().toLocaleTimeString()}`);
    await performScan(stateManager.state.settings.selectedTimeframe, true);
}

// ---------- Formatting ----------
function formatSignal(analysis, pair, timeframe, isAuto) {
    const arrow = analysis.signal === 'CALL' ? '📈' : (analysis.signal === 'PUT' ? '📉' : '➡️');
    const dir = analysis.signal === 'CALL' ? 'CALL (BUY)' : (analysis.signal === 'PUT' ? 'PUT (SELL)' : 'NEUTRAL');
    const bar = '█'.repeat(Math.floor(analysis.probability / 5)) + '░'.repeat(20 - Math.floor(analysis.probability / 5));
    return `${isAuto ? '🤖 AUTO-SCAN\n' : ''}*${arrow} PROBABILITY SIGNAL ${arrow}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 *${pair}* | [${timeframe}]\n🎯 *${dir}* | Probability: *${analysis.probability}%* ${analysis.probabilityEmoji}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 *PROBABILITY METER:*\n\`${bar}\` ${analysis.probability}%\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📈 *TECHNICALS:* RSI ${analysis.rsi} | ADX ${analysis.adx} | Vol ${analysis.volatility}%\n📊 Strategies: ${analysis.activeStrategies.length}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 *${analysis.guidance}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🛡️ *SL:* ${analysis.stopLoss} pips | *TP:* ${analysis.takeProfit} pips\n💰 *Entry:* ${analysis.currentPrice} | *Risk:* ${analysis.suggestedRisk}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚠️ *Probability ≠ Certainty* | YOU decide\n🕐 ${new Date().toLocaleTimeString()}`;
}

// ---------- Telegram UI functions (fully populated) ----------
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
    const uptime = Math.floor((Date.now() - global.botStartTime || 0) / 1000 / 60);
    const s = stateManager.state.settings;
    const menu = `🏆 *OMNI v27* | ${uptime}m\n━━━━━━━━━━━━━━━━━━━━━━\n📊 ${s.selectedPairs.length}/${PAIRS.length} pairs\n⏰ ${s.selectedTimeframe} ⭐\n🤖 ${s.autoScanEnabled ? 'ON' : 'OFF'}\n━━━━━━━━━━━━━━━━━━━━━━\n📊 92%+ 👑 MAX (3%)\n📊 85-91% 🔥🔥🔥 STRONG (2.5%)\n📊 78-84% 🔥🔥 CONFIDENT (2%)\n📊 70-77% 🔥 NORMAL (1.5%)\n📊 62-69% ⚡ CAUTIOUS (1%)\n📊 55-61% ⚠️ SKIP (0.5%)\n━━━━━━━━━━━━━━━━━━━━━━\n*YOU decide. Not the bot.*`;
    const kb = getMainKeyboard();
    if (messageId) {
        await editMessageText(messageId, menu, kb);
    } else {
        await sendMessage(menu, kb);
    }
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
    if (messageId) {
        await editMessageText(messageId, menu, keyboard);
    } else {
        await sendMessage(menu, keyboard);
    }
}

async function showTimeframeSelection(messageId = null) {
    let menu = `*⏰ SELECT TIMEFRAME*\n━━━━━━━━━━━━━━━━━━━━━━\nCurrent: *${stateManager.state.settings.selectedTimeframe}*\n${stateManager.state.settings.selectedTimeframe === PRIMARY_TF ? '⭐ PRIMARY (15m) recommended' : ''}\n━━━━━━━━━━━━━━━━━━━━━━\n*Choose timeframe:*`;
    const keyboard = { inline_keyboard: [] };
    for (const tf of TIMEFRAMES) {
        const emoji = stateManager.state.settings.selectedTimeframe === tf ? '✅' : '🔘';
        const star = tf === PRIMARY_TF ? ' ⭐' : '';
        keyboard.inline_keyboard.push([{ text: `${emoji} ${tf}${star}`, callback_data: `set_tf_${tf}` }]);
    }
    keyboard.inline_keyboard.push([{ text: "🔙 BACK TO MENU", callback_data: "menu_main" }]);
    if (messageId) {
        await editMessageText(messageId, menu, keyboard);
    } else {
        await sendMessage(menu, keyboard);
    }
}

async function showAutoScanMenu(messageId = null) {
    const auto = stateManager.state.settings.autoScanEnabled;
    const status = auto ? "🟢 ACTIVE" : "🔴 STOPPED";
    const buttonText = auto ? "⏸️ STOP AUTO-SCAN" : "▶️ START AUTO-SCAN";
    const buttonData = auto ? "autoscan_stop" : "autoscan_start";
    let menu = `*🤖 AUTO-SCAN CONTROL*\n━━━━━━━━━━━━━━━━━━━━━━\nStatus: ${status}\nInterval: 15 minutes\nPrimary Timeframe: ${PRIMARY_TF} ⭐\n━━━━━━━━━━━━━━━━━━━━━━\nWhen enabled, bot automatically scans\nall selected pairs every 15 minutes\nand sends signals when found.`;
    const keyboard = { inline_keyboard: [[{ text: buttonText, callback_data: buttonData }], [{ text: "🔙 BACK TO MENU", callback_data: "menu_main" }]] };
    if (messageId) {
        await editMessageText(messageId, menu, keyboard);
    } else {
        await sendMessage(menu, keyboard);
    }
}

async function showHistory(messageId = null) {
    const signals = stateManager.state.signals.slice(0, 15);
    let msg = `*📊 SIGNAL HISTORY*\n━━━━━━━━━━━━━━━━━━━━━━\n`;
    for (const s of signals) {
        let emoji = s.probability >= 92 ? '👑' : (s.probability >= 85 ? '🔥🔥🔥' : (s.probability >= 78 ? '🔥🔥' : (s.probability >= 70 ? '🔥' : (s.probability >= 62 ? '⚡' : '⚠️'))));
        msg += `${emoji} ${s.signal === 'CALL' ? '📈' : '📉'} *${s.pair}* | ${s.probability}%\n   ${s.recommendedAction}\n\n`;
    }
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n📊 Total: ${stateManager.state.signals.length}\n💡 Use probability to guide decisions.`;
    const keyboard = { inline_keyboard: [[{ text: "🗑️ CLEAR HISTORY", callback_data: "history_clear" }], [{ text: "🔙 BACK TO MENU", callback_data: "menu_main" }]] };
    if (messageId) {
        await editMessageText(messageId, msg, keyboard);
    } else {
        await sendMessage(msg, keyboard);
    }
}

async function showStatus(messageId = null) {
    const uptime = Math.floor((Date.now() - global.botStartTime || 0) / 1000 / 60);
    const signals = stateManager.state.signals;
    const legendary = signals.filter(s => s.probability >= 92).length;
    const exceptional = signals.filter(s => s.probability >= 85 && s.probability < 92).length;
    const high = signals.filter(s => s.probability >= 78 && s.probability < 85).length;
    const msg = `*📈 STATUS*\n━━━━━━━━━━━━━━━━━━━━━━\nUptime: ${uptime}m\nPairs: ${stateManager.state.settings.selectedPairs.length}/${PAIRS.length}\nAuto: ${stateManager.state.settings.autoScanEnabled ? 'ON' : 'OFF'}\n━━━━━━━━━━━━━━━━━━━━━━\n*SIGNALS:* ${signals.length}\n👑 Legendary: ${legendary}\n🔥 Exceptional: ${exceptional}\n🔥 High: ${high}\n━━━━━━━━━━━━━━━━━━━━━━\n*YOU are the decision maker*`;
    const keyboard = { inline_keyboard: [[{ text: "🔙 BACK TO MENU", callback_data: "menu_main" }]] };
    if (messageId) {
        await editMessageText(messageId, msg, keyboard);
    } else {
        await sendMessage(msg, keyboard);
    }
}

async function showGuide(messageId = null) {
    const msg = `*📋 PROBABILITY GUIDE*\n━━━━━━━━━━━━━━━━━━━━━━\n👑 92-100% → MAX (3% risk)\n🔥🔥🔥 85-91% → STRONG (2.5%)\n🔥🔥 78-84% → CONFIDENT (2%)\n🔥 70-77% → NORMAL (1.5%)\n⚡ 62-69% → CAUTIOUS (1%)\n⚠️ 55-61% → SKIP (0.5%)\n❌ <55% → NO TRADE\n━━━━━━━━━━━━━━━━━━━━━━\n*GOLDEN RULES:*\n• Higher % = Larger position\n• Lower % = Skip or tiny\n• YOU decide based on risk\n━━━━━━━━━━━━━━━━━━━━━━\n*REMEMBER:* Probability ≠ Guarantee`;
    const keyboard = { inline_keyboard: [[{ text: "🔙 BACK TO MENU", callback_data: "menu_main" }]] };
    if (messageId) {
        await editMessageText(messageId, msg, keyboard);
    } else {
        await sendMessage(msg, keyboard);
    }
}

async function showHelp(messageId = null) {
    const msg = `*📋 HELP*\n━━━━━━━━━━━━━━━━━━━━━━\n*COMMANDS:*\n/start - Menu\n/scan - Manual scan\n/status - Status\n/help - Help\n━━━━━━━━━━━━━━━━━━━━━━\n*HOW TO USE:*\n1. Bot shows EVERY signal with %\n2. Check probability level\n3. YOU decide to trade or skip\n4. Higher % = Larger position\n━━━━━━━━━━━━━━━━━━━━━━\n*EXAMPLE:*\n85% CALL → 2.5% risk\n65% PUT → 1% risk\n55% CALL → Skip\n━━━━━━━━━━━━━━━━━━━━━━\n*YOU are the decision maker*`;
    const keyboard = { inline_keyboard: [[{ text: "🔙 BACK TO MENU", callback_data: "menu_main" }]] };
    if (messageId) {
        await editMessageText(messageId, msg, keyboard);
    } else {
        await sendMessage(msg, keyboard);
    }
}

// ---------- Webhook deletion ----------
async function deleteWebhook(retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const result = await new Promise((resolve) => {
                const req = https.request(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteWebhook`, { method: 'POST' }, (res) => {
                    let data = '';
                    res.on('data', d => data += d);
                    res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({ ok: false }); } });
                });
                req.on('error', () => resolve({ ok: false }));
                req.end();
            });
            if (result.ok) {
                logger.info('✅ Webhook deleted');
                return true;
            }
        } catch (e) { logger.warn(`Webhook delete attempt ${i+1} failed`); }
        if (i < retries - 1) await new Promise(r => setTimeout(r, 2000));
    }
    return false;
}

// ---------- Callback & command handling ----------
async function handleCallback(query) {
    const data = query.data;
    const msgId = query.message.message_id;
    logger.info(`🔘 Callback: ${data}`);
    if (data === "menu_main") await showMainMenu(msgId);
    else if (data === "scan_manual") { await performScan(stateManager.state.settings.selectedTimeframe, false); await showMainMenu(msgId); }
    else if (data === "menu_pairs") await showPairSelection(0, msgId);
    else if (data === "menu_timeframe") await showTimeframeSelection(msgId);
    else if (data === "menu_autoscan") await showAutoScanMenu(msgId);
    else if (data === "menu_history") await showHistory(msgId);
    else if (data === "menu_status") await showStatus(msgId);
    else if (data === "menu_guide") await showGuide(msgId);
    else if (data === "menu_help") await showHelp(msgId);
    else if (data === "autoscan_start") {
        stateManager.update({ settings: { autoScanEnabled: true } });
        if (autoScanInterval) clearInterval(autoScanInterval);
        autoScanInterval = setInterval(autoScan, 15 * 60 * 1000);
        await showAutoScanMenu(msgId);
        setTimeout(autoScan, 2000);
    } else if (data === "autoscan_stop") {
        stateManager.update({ settings: { autoScanEnabled: false } });
        if (autoScanInterval) clearInterval(autoScanInterval);
        autoScanInterval = null;
        await showAutoScanMenu(msgId);
    } else if (data === "history_clear") { stateManager.update({ signals: [] }); await showHistory(msgId); }
    else if (data === "pairs_select_all") { stateManager.update({ settings: { selectedPairs: [...PAIRS] } }); await showPairSelection(0, msgId); }
    else if (data === "pairs_clear_all") { stateManager.update({ settings: { selectedPairs: [] } }); await showPairSelection(0, msgId); }
    else if (data.startsWith("toggle_")) {
        const pair = data.slice(7);
        if (!PAIRS.includes(pair)) {
            const ans = https.request(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, { method: 'POST' }, () => {});
            ans.write(JSON.stringify({ callback_query_id: query.id, text: "Invalid pair", show_alert: true }));
            ans.end();
            return;
        }
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
    const ans = https.request(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => {});
    ans.write(JSON.stringify({ callback_query_id: query.id }));
    ans.end();
}

async function handleCommand(text, chatId) {
    if (chatId.toString() !== TELEGRAM_CHAT_ID) return;
    logger.info(`📩 Command: ${text}`);
    if (text === '/start') await showMainMenu();
    else if (text === '/status') await showStatus();
    else if (text === '/scan') await performScan(stateManager.state.settings.selectedTimeframe, false);
    else if (text === '/help') await showHelp();
    else await sendMessage(`❌ Unknown. Send /start for menu.`);
}

// ---------- Long polling ----------
async function startPolling() {
    if (!TELEGRAM_TOKEN) { logger.error('❌ No TELEGRAM_TOKEN'); return; }
    await deleteWebhook(3);
    logger.info('📡 Starting long polling (timeout=55s)...');
    let lastUpdateId = 0;
    const poll = async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 55000);
        try {
            const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=55`;
            const req = https.get(url, { signal: controller.signal, timeout: 60000 }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.ok && json.result) {
                            for (const u of json.result) {
                                if (u.update_id > lastUpdateId) {
                                    lastUpdateId = u.update_id;
                                    if (u.message?.text) handleCommand(u.message.text, u.message.chat.id);
                                    if (u.callback_query) handleCallback(u.callback_query);
                                }
                            }
                        }
                        setTimeout(poll, 1000);
                    } catch (e) { setTimeout(poll, 2000); }
                });
            });
            req.on('error', (err) => {
                if (err.name === 'AbortError') logger.warn('Poll timeout, retrying');
                setTimeout(poll, 2000);
            });
            req.end();
        } catch (e) { setTimeout(poll, 5000); } finally { clearTimeout(timeout); }
    };
    poll();
}

// ---------- Health server ----------
function startHealthServer() {
    const server = http.createServer((req, res) => {
        if (req.url === '/health' || req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'alive', uptime: process.uptime(), signals: stateManager.state.signals.length }));
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    server.listen(PORT, () => logger.info(`🩺 Health server listening on port ${PORT}`));
}

// ---------- Main ----------
global.botStartTime = Date.now();
console.log('\n' + '█'.repeat(60));
console.log('🏆 OMNI_BOT v27 - YAHOO FINANCE FIXED (FINAL)');
console.log('█'.repeat(60));
console.log(`Strategy: NO REJECTION | YOU decide`);
console.log(`Indicators: HMA (zero‑lag) + RSI + ADX + MACD + BB`);
console.log(`Risk: Kelly Criterion + regime‑adaptive`);
console.log(`Telegram: ${TELEGRAM_TOKEN ? '✅' : '❌'}`);
console.log(`HTTP Port: ${PORT}`);
console.log('█'.repeat(60) + '\n');

testYahooConnectivity().then(connected => {
    if (!connected) {
        logger.error('⚠️ Yahoo Finance is not reachable. Check network or API access.');
    }
});

startHealthServer();
startPolling();

setTimeout(async () => {
    if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
        await sendMessage(`🤖 *OMNI_BOT v27 ONLINE*\n━━━━━━━━━━━━━━━━━━━━━━\n✅ Yahoo Finance data fetching (official package)\n✅ NO mock data – only real signals\n✅ YOU decide based on %\n━━━━━━━━━━━━━━━━━━━━━━\n📱 *Send /start to begin*`);
    }
    console.log('🚀 Bot ready! Send /start');
}, 3000);

setInterval(() => {
    const stats = stateManager.state.stats;
    logger.info(`💓 Uptime: ${Math.floor((Date.now() - global.botStartTime) / 60000)}m | Auto: ${stateManager.state.settings.autoScanEnabled ? 'ON' : 'OFF'} | Signals: ${stats.signalsGenerated}`);
}, 60000);
