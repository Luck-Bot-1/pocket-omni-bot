// ============================================================
// LEGENDARY BOT v2.0 – INSTITUTIONAL TRADING ENGINE
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
const pairsConfig = require('./pairs.json');

if (!pairsConfig.pairs || !pairsConfig.timeframes || !pairsConfig.primaryTimeframe) {
    console.error('❌ pairs.json invalid');
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
for (const pair of pairsConfig.pairs) YAHOO_SYMBOLS[pair] = pair.replace('/', '') + '=X';
const PAIRS = pairsConfig.pairs;
const TIMEFRAMES = pairsConfig.timeframes;
const PRIMARY_TF = pairsConfig.primaryTimeframe;

const log = (...args) => console.log(new Date().toISOString(), ...args);
const CACHE_TTL = 60000;
const candleCache = new Map();
function cacheSet(key, data) { candleCache.set(key, { data, timestamp: Date.now() }); }
function cacheGet(key) {
    const entry = candleCache.get(key);
    if (entry && Date.now() - entry.timestamp < CACHE_TTL) return entry.data;
    return null;
}

class SimpleRateLimiter {
    constructor(limitPerMinute = 20) {
        this.limit = limitPerMinute;
        this.users = new Map();
    }
    async check(userId) {
        const now = Date.now();
        const record = this.users.get(userId) || [];
        const recent = record.filter(t => now - t < 60000);
        if (recent.length >= this.limit) {
            const wait = 60000 - (now - recent[0]);
            await new Promise(r => setTimeout(r, wait));
            return this.check(userId);
        }
        recent.push(now);
        this.users.set(userId, recent);
        return true;
    }
}
const userLimiter = new SimpleRateLimiter(20);

// ---------- DATA FETCHING (REAL YAHOO + MOCK FALLBACK) ----------
async function fetchYahooRaw(symbol, interval) {
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
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
        clearTimeout(timeout);
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
            log(`✅ REAL DATA: ${candles.length} candles for ${symbol}`);
            return candles;
        }
        return null;
    } catch (e) {
        log(`⚠️ Yahoo fetch error for ${symbol}: ${e.message}`);
        return null;
    }
}

function generateMockCandles(symbol, interval, count = 100) {
    log(`⚠️ Using MOCK data for ${symbol}`);
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
    const cacheKey = `${symbol}_${interval}`;
    const cached = cacheGet(cacheKey);
    if (cached) return { candles: cached, isMock: false };
    let candles = await fetchYahooRaw(symbol, interval);
    if (candles && candles.length >= 50) {
        cacheSet(cacheKey, candles);
        return { candles, isMock: false };
    }
    candles = generateMockCandles(symbol, interval, 100);
    cacheSet(cacheKey, candles);
    return { candles, isMock: true };
}

// ---------- NEWS COOLDOWN (ENABLED) ----------
function isNewsTime() {
    const now = new Date();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    if ((hour === 12 && minute >= 15 && minute <= 45) ||
        (hour === 14 && minute <= 15) ||
        (hour === 18 && minute <= 15)) {
        return true;
    }
    return false;
}

// ---------- SESSION LIQUIDATION (ENABLED) ----------
function isEndOfSession() {
    const now = new Date();
    const hour = now.getUTCHours();
    // Close 5 minutes before major session close (4:55 PM EST = 20:55 UTC)
    if (hour === 20 && now.getUTCMinutes() >= 55) return true;
    return false;
}

// ---------- TELEGRAM HELPERS ----------
async function sendMessage(text, replyMarkup = null) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
    const body = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown", disable_web_page_preview: true };
    if (replyMarkup) body.reply_markup = replyMarkup;
    try {
        const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        const json = await response.json();
        if (!json.ok) log(`Telegram send error: ${json.description}`);
        return json;
    } catch (e) { log(`Send failed: ${e.message}`); }
}

async function editMessageText(messageId, text, replyMarkup = null) {
    if (!messageId) return;
    const body = { chat_id: TELEGRAM_CHAT_ID, message_id: messageId, text, parse_mode: "Markdown" };
    if (replyMarkup) body.reply_markup = replyMarkup;
    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
    } catch (e) {}
}

async function sendTyping() {
    fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendChatAction`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, action: 'typing' })
    }).catch(() => {});
}

function escapeMarkdown(text) { return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1'); }

const analyzer = new RobustAnalyzer(10000);
let isScanning = false;

async function performScan(timeframe, isAuto = false) {
    if (isScanning) {
        if (!isAuto) await sendMessage("⏳ Scan already in progress...");
        return;
    }
    isScanning = true;
    try {
        const totalPairs = PAIRS.length;
        if (!isAuto) await sendTyping();
        let signals = 0;
        for (let idx = 0; idx < PAIRS.length; idx++) {
            const pair = PAIRS[idx];
            const symbol = YAHOO_SYMBOLS[pair];
            if (!symbol) continue;
            try {
                // News cooldown filter
                if (isNewsTime()) {
                    log(`⏸️ News cooldown – skipping ${pair}`);
                    continue;
                }
                // Session liquidation – no new entries
                if (isEndOfSession()) {
                    log(`🔚 End of session – skipping new entries`);
                    continue;
                }
                const fetchResult = await fetchCandles(symbol, timeframe);
                if (!fetchResult?.candles) continue;
                let htCandles = null;
                if (timeframe !== '1h') {
                    const htResult = await fetchCandles(symbol, '1h');
                    if (htResult) htCandles = htResult.candles;
                }
                const analysis = analyzer.calculateProbability(fetchResult.candles, pair, timeframe, htCandles);
                if (analysis.probability >= 55 && analysis.signal !== 'NEUTRAL') {
                    signals++;
                    const signalText = formatSignal(analysis, pair, timeframe, isAuto, fetchResult.isMock);
                    const actionKeyboard = {
                        inline_keyboard: [[
                            { text: "✅ WIN", callback_data: `record_win_${analysis.rawScore}` },
                            { text: "❌ LOSS", callback_data: `record_loss_${analysis.rawScore}` }
                        ]]
                    };
                    await sendMessage(signalText, actionKeyboard);
                }
            } catch (e) { log(`Error ${pair}: ${e.message}`); }
            await new Promise(r => setTimeout(r, 200));
        }
        if (!isAuto) await sendMessage(`✅ *SCAN COMPLETE*: ${signals} signals (threshold 55%)`);
    } finally { isScanning = false; }
}

function formatSignal(analysis, pair, timeframe, isAuto, isMock) {
    const arrow = analysis.signal === 'CALL' ? '📈' : (analysis.signal === 'PUT' ? '📉' : '➡️');
    const bar = '█'.repeat(Math.floor(analysis.probability / 5)) + '░'.repeat(20 - Math.floor(analysis.probability / 5));
    let msg = `${isAuto ? '🤖 AUTO-SCAN\n' : ''}*${arrow} SIGNAL ${arrow}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 *${pair}* | ${timeframe}\n🎯 *${analysis.signal === 'CALL' ? 'CALL (BUY)' : 'PUT (SELL)'}* | Probability: *${analysis.probability}%*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 *PROBABILITY METER:*\n\`${bar}\` ${analysis.probability}%\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📈 *TECHNICALS:* RSI ${analysis.rsi} | ADX ${analysis.adx} | Regime ${analysis.marketRegime}\n🌀 Divergence: ${analysis.divergence}\n📊 Factors: ${analysis.activeFactors.join(', ') || 'none'}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 *ACTION:* ${analysis.recommendedAction} (Risk ${analysis.suggestedRisk})\n🛡️ SL: ${analysis.stopLoss} pips | TP: ${analysis.takeProfit} pips\n💰 Entry: ${analysis.currentPrice} | R:R ${analysis.riskRewardRatio}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚠️ *Probability ≠ Guarantee* – Manage risk.\n🕐 ${new Date().toLocaleTimeString()}`;
    if (isMock) msg += `\n⚠️ *Using simulated data*`;
    return msg;
}

async function handleCommand(text, chatId) {
    if (chatId.toString() !== TELEGRAM_CHAT_ID) return;
    await userLimiter.check(chatId);
    log(`📩 Command: ${text}`);
    if (text === '/start') {
        await sendMessage("🤖 *LEGENDARY BOT v2.0 ONLINE*\nCommands:\n/ping – test response\n/scan – run analysis\n/testdata – check data source\n/forcesignal – test strategy logic\n/help – full help");
    } else if (text === '/ping') {
        await sendMessage("🏓 Pong! Bot is responding.");
    } else if (text === '/scan') {
        await sendTyping();
        await performScan(PRIMARY_TF, false);
    } else if (text === '/testdata') {
        await sendTyping();
        const symbol = 'EURUSD=X';
        const result = await fetchCandles(symbol, '15m');
        const status = result.isMock ? "⚠️ MOCK DATA" : "✅ REAL YAHOO DATA";
        const last = result.candles[result.candles.length-1];
        await sendMessage(`📡 *Data Test*\n━━━━━━━━━━━━━━━━━━━━━━\nSymbol: ${symbol}\nSource: ${status}\nCandles: ${result.candles.length}\nLast price: ${last.close.toFixed(5)}\nLast time: ${new Date(last.time).toLocaleString()}`);
    } else if (text === '/forcesignal') {
        await sendTyping();
        const mock = [];
        let p = 1.1000;
        for (let i = 0; i < 100; i++) { p += 0.0002; mock.push({ open: p-0.0001, high: p+0.0001, low: p-0.0002, close: p, volume: 2000, time: Date.now()-(100-i)*900000 }); }
        const a = analyzer.calculateProbability(mock, "EUR/USD", "15m", null);
        await sendMessage(`💪 *FORCED SIGNAL*\n━━━━━━━━━━━━━━━━━━━━━━\nSignal: ${a.signal}\nProbability: ${a.probability}%\nRSI: ${a.rsi} | ADX: ${a.adx}\nDivergence: ${a.divergence}`);
    } else if (text === '/help') {
        await sendMessage("Commands:\n/start – main menu\n/ping – alive check\n/scan – run analysis\n/testdata – check Yahoo data\n/forcesignal – test logic\n/help – this message");
    } else {
        await sendMessage("❌ Unknown. Try /help");
    }
}

async function handleCallback(query) {
    const data = query.data;
    const msgId = query.message.message_id;
    const userId = query.from.id;
    await userLimiter.check(userId);
    log(`🔘 Callback: ${data}`);
    if (data.startsWith("record_win")) {
        const rawScore = parseInt(data.split('_')[2]);
        analyzer.recordTradeOutcome(true, rawScore, 2);
        await sendMessage("👍 Trade recorded as WIN.");
        await editMessageText(msgId, query.message.text);
    } else if (data.startsWith("record_loss")) {
        const rawScore = parseInt(data.split('_')[2]);
        analyzer.recordTradeOutcome(false, rawScore, -2);
        await sendMessage("👎 Trade recorded as LOSS.");
        await editMessageText(msgId, query.message.text);
    } else {
        await sendMessage("Unknown action.");
    }
}

async function deleteWebhook() {
    try {
        const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteWebhook`, { method: 'POST' });
        const json = await res.json();
        log(json.ok ? "✅ Webhook deleted" : "⚠️ Webhook delete failed");
        return json.ok;
    } catch (e) { log("Webhook delete error", e.message); return false; }
}

async function startPolling() {
    await deleteWebhook();
    log("📡 Starting long polling...");
    let offset = 0;
    let consecutiveErrors = 0;
    while (true) {
        try {
            const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${offset}&timeout=30`;
            const response = await fetch(url);
            if (response.status === 409) {
                log("HTTP 409 – conflict, deleting webhook...");
                await deleteWebhook();
                continue;
            }
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data.ok && data.result) {
                consecutiveErrors = 0;
                for (const update of data.result) {
                    offset = update.update_id + 1;
                    if (update.message?.text) await handleCommand(update.message.text, update.message.chat.id);
                    if (update.callback_query) await handleCallback(update.callback_query);
                }
            }
        } catch (err) {
            consecutiveErrors++;
            const backoff = Math.min(30, Math.pow(2, consecutiveErrors));
            log(`Poll error (${consecutiveErrors}): ${err.message}. Retry in ${backoff}s`);
            await new Promise(r => setTimeout(r, backoff * 1000));
        }
    }
}

function startHealthServer() {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: "alive", uptime: process.uptime() }));
    });
    server.listen(PORT, () => log(`🩺 Health server on port ${PORT}`));
}

process.on('SIGTERM', () => { log("SIGTERM"); process.exit(0); });
process.on('SIGINT', () => { log("SIGINT"); process.exit(0); });
process.on('uncaughtException', (e) => { log("Uncaught", e); process.exit(1); });

log("🏆 LEGENDARY BOT v2.0 – INSTITUTIONAL GRADE");
log(`Pairs: ${PAIRS.length} loaded`);
log(`Telegram: ${TELEGRAM_TOKEN ? "✅" : "❌"}`);
log(`HTTP Port: ${PORT}`);
startHealthServer();
startPolling();
