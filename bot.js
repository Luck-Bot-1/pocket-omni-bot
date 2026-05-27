const { LegendaryAnalyzer } = require('./analyzer.js');
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

// ---------- Bounded Cache ----------
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

// ---------- Rotating User-Agent (for Yahoo raw) ----------
const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];
let userAgentIndex = 0;
function getRandomUserAgent() {
    userAgentIndex = (userAgentIndex + 1) % userAgents.length;
    return userAgents[userAgentIndex];
}

// ---------- Yahoo Raw Fetch (fallback) ----------
async function fetchYahooRaw(symbol, interval, timeoutMs = 10000) {
    return new Promise((resolve) => {
        let period1;
        switch (interval) {
            case '1m': period1 = Math.floor(Date.now() / 1000) - 86400; break;
            case '5m': period1 = Math.floor(Date.now() / 1000) - 259200; break;
            case '15m': period1 = Math.floor(Date.now() / 1000) - 604800; break;
            case '30m': period1 = Math.floor(Date.now() / 1000) - 1209600; break;
            case '1h': period1 = Math.floor(Date.now() / 1000) - 2592000; break;
            case '4h': period1 = Math.floor(Date.now() / 1000) - 8640000; break;
            default: period1 = Math.floor(Date.now() / 1000) - 604800;
        }
        const period2 = Math.floor(Date.now() / 1000);
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=${interval}`;
        const req = https.get(url, { headers: { 'User-Agent': getRandomUserAgent() }, timeout: timeoutMs }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (!json.chart?.result?.[0]) { resolve(null); return; }
                    const quotes = json.chart.result[0].indicators.quote[0];
                    if (!quotes || !quotes.open) { resolve(null); return; }
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
                    resolve(candles.length > 30 ? candles : null);
                } catch (e) { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.end();
    });
}

// ---------- Alpha Vantage Fetch (real API) ----------
async function fetchAlphaVantage(symbol, interval, apiKey) {
    if (!apiKey) return null;
    const avInterval = { '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '60min', '4h': '60min' }[interval];
    if (!avInterval) return null;
    const baseSymbol = symbol.replace('=X', '');
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=${baseSymbol}&interval=${avInterval}&apikey=${apiKey}&outputsize=full`;
    try {
        const result = await new Promise((resolve) => {
            const req = https.get(url, { headers: { 'User-Agent': getRandomUserAgent() } }, (res) => {
                let data = '';
                res.on('data', d => data += d);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const timeSeries = json[`Time Series (${avInterval})`];
                        if (!timeSeries) { resolve(null); return; }
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
                        resolve(candles.length > 30 ? candles.slice(-300) : null);
                    } catch (e) { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.end();
        });
        if (result && result.length > 0) {
            logger.info(`✅ Alpha Vantage fetched ${result.length} candles for ${symbol}`);
            return result;
        }
        return null;
    } catch (e) { return null; }
}

// ---------- Twelve Data Fetch (real API) ----------
async function fetchTwelveData(symbol, interval, apiKey) {
    if (!apiKey) return null;
    const tdInterval = { '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '1h', '4h': '4h' }[interval];
    if (!tdInterval) return null;
    const baseSymbol = symbol.replace('=X', '');
    const url = `https://api.twelvedata.com/time_series?symbol=${baseSymbol}&interval=${tdInterval}&apikey=${apiKey}&outputsize=300`;
    try {
        const result = await new Promise((resolve) => {
            const req = https.get(url, { headers: { 'User-Agent': getRandomUserAgent() } }, (res) => {
                let data = '';
                res.on('data', d => data += d);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (!json.values) { resolve(null); return; }
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
                        resolve(candles.length > 30 ? candles : null);
                    } catch (e) { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.end();
        });
        if (result && result.length > 0) {
            logger.info(`✅ Twelve Data fetched ${result.length} candles for ${symbol}`);
            return result;
        }
        return null;
    } catch (e) { return null; }
}

// ---------- Mock Data (last resort, but now forces directional later) ----------
function generateMockCandles(symbol, interval, count = 300) {
    const seed = symbol.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
    const basePrice = 1.1000 + (seed % 100) / 10000;
    const now = Date.now();
    const intervalMs = { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000 }[interval] || 900000;
    const candles = [];
    let price = basePrice;
    let trend = 0;
    for (let i = 0; i < count; i++) {
        if (i % 40 === 0) trend = (Math.random() - 0.5) * 0.002;
        const noise = (Math.random() - 0.5) * 0.0008;
        price += trend + noise;
        if (price > basePrice * 1.03) price = basePrice * 1.03;
        if (price < basePrice * 0.97) price = basePrice * 0.97;
        const open = price;
        const close = price + (Math.random() - 0.5) * 0.001;
        const high = Math.max(open, close) + Math.random() * 0.0008;
        const low = Math.min(open, close) - Math.random() * 0.0008;
        const time = now - (count - i) * intervalMs;
        candles.push({ open, high, low, close, volume: 1000, time });
        price = close;
    }
    return candles;
}

// ---------- Main fetch with full fallback chain ----------
async function fetchCandles(symbol, interval) {
    const cacheKey = `${symbol}_${interval}`;
    const cached = cacheGet(cacheKey);
    if (cached) return { candles: cached.data, isMock: cached.isMock };

    // 1. Yahoo Finance (official library) – usually blocked, but try anyway
    let candles = null;
    try {
        const intervalMap = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '1h' };
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
        const result = await require('yahoo-finance2').default.chart(symbol, {
            period1: startDate,
            period2: endDate,
            interval: yahooInterval,
            includePrePost: false
        });
        if (result && result.quotes && result.quotes.length > 0) {
            candles = result.quotes.map(q => ({
                open: q.open,
                high: q.high,
                low: q.low,
                close: q.close,
                volume: q.volume || 1000,
                time: new Date(q.date).getTime()
            })).filter(c => c.open !== null && c.close !== null);
            if (candles.length > 30) {
                logger.info(`✅ Yahoo fetched ${candles.length} candles for ${symbol}`);
                cacheSet(cacheKey, candles, false);
                return { candles, isMock: false };
            }
        }
    } catch (e) { logger.warn(`Yahoo failed for ${symbol}: ${e.message}`); }

    // 2. Alpha Vantage
    const avKey = process.env.ALPHA_VANTAGE_KEY;
    if (avKey) {
        candles = await fetchAlphaVantage(symbol, interval, avKey);
        if (candles && candles.length > 0) {
            cacheSet(cacheKey, candles, false);
            return { candles, isMock: false };
        }
    }

    // 3. Twelve Data
    const tdKey = process.env.TWELVE_DATA_KEY;
    if (tdKey) {
        candles = await fetchTwelveData(symbol, interval, tdKey);
        if (candles && candles.length > 0) {
            cacheSet(cacheKey, candles, false);
            return { candles, isMock: false };
        }
    }

    // 4. Yahoo raw HTTP fallback
    candles = await fetchYahooRaw(symbol, interval);
    if (candles && candles.length > 0) {
        logger.info(`✅ Yahoo Raw fetched ${candles.length} candles for ${symbol}`);
        cacheSet(cacheKey, candles, true);
        return { candles, isMock: true };
    }

    // 5. Final mock (with force directional flag)
    logger.warn(`⚠️ Using forced mock data for ${symbol} (all APIs failed)`);
    const mockCandles = generateMockCandles(symbol, interval, 300);
    cacheSet(cacheKey, mockCandles, true);
    return { candles: mockCandles, isMock: true, forceMockDirection: true };
}

// ---------- Startup message ----------
let globalDataStatus = 'unknown';
let lastAlertTime = 0;
async function testConnectivity() {
    const avKey = process.env.ALPHA_VANTAGE_KEY;
    const tdKey = process.env.TWELVE_DATA_KEY;
    if (avKey || tdKey) {
        globalDataStatus = 'real_possible';
        logger.info(`✅ API keys present: Alpha Vantage ${avKey ? '✅' : '❌'}, Twelve Data ${tdKey ? '✅' : '❌'}`);
        await sendMessage(`📡 *Real data sources available*\nAlpha Vantage: ${avKey ? '✅' : '❌'}\nTwelve Data: ${tdKey ? '✅' : '❌'}\n\nBot will try real APIs first, then fall back to mock (with guaranteed directional signals).`);
    } else {
        globalDataStatus = 'mock_only';
        logger.warn('⚠️ No API keys – using forced mock data. Signals will be directional but simulated.');
        if (Date.now() - lastAlertTime > 3600000) {
            lastAlertTime = Date.now();
            await sendMessage(`⚠️ *No Alpha Vantage or Twelve Data API keys set.*\nUsing simulated market data. Signals are directional but NOT real.\n\nTo get live data, set ALPHA_VANTAGE_KEY or TWELVE_DATA_KEY in environment.`);
        }
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

// ---------- Telegram API helpers with 429 retry ----------
async function sendMessage(text, replyMarkup = null, priority = 5, retries = 3) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) { logger.info(`📱 ${text.substring(0, 200)}...`); return; }
    await telegramRateLimiter.consume(1);
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const result = await new Promise((resolve) => {
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
                req.on('error', (e) => resolve({ ok: false, error: e.message }));
                req.write(postData);
                req.end();
            });
            if (!result.ok && result.error_code === 429) {
                const retryAfter = result.parameters?.retry_after || (attempt * 2);
                logger.warn(`Telegram rate limit (429). Retry after ${retryAfter}s (attempt ${attempt}/${retries})`);
                await new Promise(r => setTimeout(r, retryAfter * 1000));
                continue;
            }
            return result;
        } catch (e) {
            lastError = e;
            logger.warn(`SendMessage attempt ${attempt} failed: ${e.message}`);
            if (attempt < retries) await new Promise(r => setTimeout(r, 1000 * attempt));
        }
    }
    logger.error(`Failed to send message after ${retries} attempts: ${lastError?.message}`);
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

// ---------- Scan with progress bar, passes `forceMockDirection` flag ----------
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
        let mockUsed = false;
        const pairsList = [...stateManager.state.settings.selectedPairs];
        for (let idx = 0; idx < pairsList.length; idx++) {
            const pair = pairsList[idx];
            const symbol = YAHOO_SYMBOLS[pair];
            if (!symbol) continue;
            const fetchResult = await fetchCandles(symbol, timeframe);
            if (!fetchResult || !fetchResult.candles || fetchResult.candles.length < 50) {
                dataFailures++;
                logger.warn(`Insufficient candles for ${pair}`);
                continue;
            }
            if (fetchResult.isMock) mockUsed = true;
            // Pass forceMockDirection flag to analyzer
            const analysis = analyzer.calculateProbability(fetchResult.candles, pair, timeframe, fetchResult.forceMockDirection || false);
            if (analysis.probability >= 55) signals++;
            if (analysis.probability >= 92) legendary++;
            else if (analysis.probability >= 85) exceptional++;
            else if (analysis.probability >= 78) high++;
            else if (analysis.probability >= 70) good++;
            else if (analysis.probability >= 62) moderate++;
            else if (analysis.probability >= 55) low++;
            const msg = formatSignal(analysis, pair, timeframe, isAuto, fetchResult.isMock);
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
        logger.info(`SCAN COMPLETE: ${signals} signals | Data failures: ${dataFailures} | Mock used: ${mockUsed} | L:${legendary} E:${exceptional} H:${high} G:${good} M:${moderate} Lw:${low}`);
        if (!isAuto && progressMsgId) {
            let completionMsg = `✅ *SCAN COMPLETE*: ${signals} signals\n👑${legendary} 🔥${exceptional} 🔥${high} 📊${good} ⚡${moderate} ⚠️${low}\n━━━━━━━━━━━━━━━━━━━━━━\nReview probabilities above. YOU decide.`;
            if (mockUsed) {
                completionMsg += `\n⚠️ *Simulated data* – real APIs failed. Check Alpha Vantage/Twelve Data keys.`;
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

function formatSignal(analysis, pair, timeframe, isAuto, isMock) {
    const arrow = analysis.signal === 'CALL' ? '📈' : (analysis.signal === 'PUT' ? '📉' : '➡️');
    const dir = analysis.signal === 'CALL' ? 'CALL (BUY)' : (analysis.signal === 'PUT' ? 'PUT (SELL)' : 'NEUTRAL');
    const bar = '█'.repeat(Math.floor(analysis.probability / 5)) + '░'.repeat(20 - Math.floor(analysis.probability / 5));
    let msg = `${isAuto ? '🤖 AUTO-SCAN\n' : ''}*${arrow} PROBABILITY SIGNAL ${arrow}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 *${pair}* | [${timeframe}]\n🎯 *${dir}* | Probability: *${analysis.probability}%* ${analysis.probabilityEmoji}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 *PROBABILITY METER:*\n\`${bar}\` ${analysis.probability}%\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📈 *TECHNICALS:* RSI ${analysis.rsi} | ADX ${analysis.adx} | Vol ${analysis.volatility}%\n📊 Strategies: ${analysis.activeStrategies.length}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 *${analysis.guidance}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🛡️ *SL:* ${analysis.stopLoss} pips | *TP:* ${analysis.takeProfit} pips\n💰 *Entry:* ${analysis.currentPrice} | *Risk:* ${analysis.suggestedRisk}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚠️ *Probability ≠ Certainty* | YOU decide\n🕐 ${new Date().toLocaleTimeString()}`;
    if (isMock) {
        msg += `\n⚠️ *SIMULATED DATA* – real APIs failed. Set ALPHA_VANTAGE_KEY / TWELVE_DATA_KEY.`;
    }
    return msg;
}

// ---------- Telegram UI (all functions identical to previous stable version) ----------
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
    const menu = `🏆 *OMNI v36* | ${uptime}m\n━━━━━━━━━━━━━━━━━━━━━━\n📊 ${s.selectedPairs.length}/${PAIRS.length} pairs\n⏰ ${s.selectedTimeframe} ⭐\n🤖 ${s.autoScanEnabled ? 'ON' : 'OFF'}\n━━━━━━━━━━━━━━━━━━━━━━\n📊 92%+ 👑 MAX (3%)\n📊 85-91% 🔥🔥🔥 STRONG (2.5%)\n📊 78-84% 🔥🔥 CONFIDENT (2%)\n📊 70-77% 🔥 NORMAL (1.5%)\n📊 62-69% ⚡ CAUTIOUS (1%)\n📊 55-61% ⚠️ SKIP (0.5%)\n━━━━━━━━━━━━━━━━━━━━━━\n*YOU decide. Not the bot.*`;
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
            res.end(JSON.stringify({
                status: 'alive',
                uptime: process.uptime(),
                signals: stateManager.state.signals.length,
                dataSource: globalDataStatus
            }));
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
console.log('🏆 OMNI_BOT v36 - REAL API FALLBACK + FORCED DIRECTIONAL');
console.log('█'.repeat(60));
console.log(`Strategy: NO REJECTION | YOU decide`);
console.log(`Indicators: HMA + RSI + ADX + MACD + BB`);
console.log(`Risk: Kelly Criterion + regime‑adaptive`);
console.log(`Telegram: ${TELEGRAM_TOKEN ? '✅' : '❌'}`);
console.log(`HTTP Port: ${PORT}`);
console.log(`Data: Yahoo → Alpha Vantage → Twelve Data → forced mock (guaranteed directional)`);
console.log('█'.repeat(60) + '\n');

testConnectivity().catch(console.error);
startHealthServer();
startPolling();

setTimeout(async () => {
    if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
        await sendMessage(`🤖 *OMNI_BOT v36 ONLINE*\n━━━━━━━━━━━━━━━━━━━━━━\n✅ Multi‑source real data (Yahoo, Alpha Vantage, Twelve Data)\n✅ If all fail → forced directional mock (NO 0% neutrals)\n✅ Guaranteed CALL/PUT signals with probabilities 30‑98%\n📱 *Send /start to begin*`);
    }
    console.log('🚀 Bot ready! Send /start');
}, 3000);

setInterval(() => {
    const stats = stateManager.state.stats;
    logger.info(`💓 Uptime: ${Math.floor((Date.now() - global.botStartTime) / 60000)}m | Auto: ${stateManager.state.settings.autoScanEnabled ? 'ON' : 'OFF'} | Signals: ${stats.signalsGenerated}`);
}, 60000);
