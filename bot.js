// ============================================================
// LEGENDARY BOT v8.0 – INSTITUTIONAL FOREX TERMINAL
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
    console.error('❌ pairs.json invalid'); process.exit(1);
}
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PORT = process.env.PORT || 8080;
if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID'); process.exit(1);
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

// ========== TELEGRAM RATE LIMITER (Token Bucket) ==========
class TokenBucket {
    constructor(capacity, refillRate) {
        this.capacity = capacity;
        this.tokens = capacity;
        this.refillRate = refillRate;
        this.lastRefill = Date.now();
    }
    take() {
        const now = Date.now();
        const refill = (now - this.lastRefill) * this.refillRate;
        this.tokens = Math.min(this.capacity, this.tokens + refill);
        this.lastRefill = now;
        if (this.tokens >= 1) { this.tokens -= 1; return true; }
        return false;
    }
    async waitForToken() {
        while (!this.take()) await new Promise(r => setTimeout(r, 50));
    }
}
const tgRateLimiter = new TokenBucket(20, 20/60000);

// ========== DATA FETCHING – NO MOCK, STALE CHECK ==========
async function fetchYahooRaw(symbol, interval) {
    let period1;
    switch (interval) {
        case '1m': period1 = Math.floor(Date.now()/1000)-86400; break;
        case '5m': period1 = Math.floor(Date.now()/1000)-259200; break;
        case '15m': period1 = Math.floor(Date.now()/1000)-604800; break;
        case '30m': period1 = Math.floor(Date.now()/1000)-1209600; break;
        case '1h': period1 = Math.floor(Date.now()/1000)-2592000; break;
        default: period1 = Math.floor(Date.now()/1000)-604800;
    }
    const period2 = Math.floor(Date.now()/1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=${interval}`;
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
        clearTimeout(timeout);
        const json = await response.json();
        if (!json.chart?.result?.[0]) return null;
        const quotes = json.chart.result[0].indicators.quote[0];
        const timestamps = json.chart.result[0].timestamp;
        if (!quotes?.open || !timestamps) return null;
        const candles = [];
        for (let i = 0; i < timestamps.length; i++) {
            if (quotes.open[i] && quotes.high[i] && quotes.low[i] && quotes.close[i]) {
                candles.push({
                    open: quotes.open[i], high: quotes.high[i], low: quotes.low[i],
                    close: quotes.close[i], volume: quotes.volume[i] || 1000,
                    time: timestamps[i] * 1000
                });
            }
        }
        if (candles.length < 50) return null;
        const lastTime = candles[candles.length-1].time;
        const maxAge = interval === '1h' ? 90*60*1000 : 5*60*1000;
        if (Date.now() - lastTime > maxAge) {
            log(`⚠️ Stale data for ${symbol} – last candle ${new Date(lastTime).toISOString()}`);
            return null;
        }
        return candles;
    } catch (e) {
        log(`⚠️ Yahoo fetch error for ${symbol}: ${e.message}`);
        return null;
    }
}

async function fetchCandles(symbol, interval) {
    const cacheKey = `${symbol}_${interval}`;
    const cached = cacheGet(cacheKey);
    if (cached) return { candles: cached, isMock: false };
    const candles = await fetchYahooRaw(symbol, interval);
    if (candles && candles.length >= 50) {
        cacheSet(cacheKey, candles);
        return { candles, isMock: false };
    }
    log(`❌ No real data for ${symbol} – skipping`);
    return null;
}

// ========== TELEGRAM HELPERS ==========
function escapeMarkdown(text) {
    if (!text) return '';
    return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

async function sendMessage(text, replyMarkup = null) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
    await tgRateLimiter.waitForToken();
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
    await tgRateLimiter.waitForToken();
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

const analyzer = new RobustAnalyzer(10000);
let isScanning = false;
let autoScanInterval = null;

// ========== SCAN FUNCTION (68% threshold, correlation) ==========
async function performScan(timeframe, isAuto = false, selectedPairs = null) {
    if (isScanning) {
        if (!isAuto) await sendMessage("⏳ Scan already in progress...");
        return;
    }
    isScanning = true;
    log(`🔍 SCAN STARTED: ${timeframe}, auto=${isAuto}`);
    try {
        const pairsToScan = selectedPairs || PAIRS;
        if (!isAuto) await sendTyping();
        let signals = 0;
        for (const pair of pairsToScan) {
            const symbol = YAHOO_SYMBOLS[pair];
            if (!symbol) continue;
            try {
                const fetchResult = await fetchCandles(symbol, timeframe);
                if (!fetchResult?.candles) continue;
                let htCandles = null;
                if (timeframe !== '1h') {
                    const htResult = await fetchCandles(symbol, '1h');
                    if (htResult) htCandles = htResult.candles;
                }
                let correlationPrice = null;
                if (pair === 'EUR/USD') {
                    const gbpResult = await fetchCandles('GBPUSD=X', '15m');
                    if (gbpResult?.candles) correlationPrice = gbpResult.candles[gbpResult.candles.length-1].close;
                }
                const analysis = analyzer.calculateProbability(fetchResult.candles, pair, timeframe, htCandles, null, correlationPrice);
                if (analysis.probability >= 68 && analysis.signal !== 'NEUTRAL') {
                    signals++;
                    const signalText = formatSignal(analysis, pair, timeframe, isAuto, false);
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
        if (!isAuto) await sendMessage(`✅ *SCAN COMPLETE*: ${signals} signals (threshold 68%)`);
        log(`🔍 SCAN COMPLETE: ${signals} signals found`);
    } finally { isScanning = false; }
}

function formatSignal(analysis, pair, timeframe, isAuto, isMock) {
    const arrow = analysis.signal === 'CALL' ? '📈' : (analysis.signal === 'PUT' ? '📉' : '➡️');
    const bar = '█'.repeat(Math.floor(analysis.probability / 5)) + '░'.repeat(20 - Math.floor(analysis.probability / 5));
    const safePair = escapeMarkdown(pair);
    const safeAction = escapeMarkdown(analysis.recommendedAction);
    let msg = `${isAuto ? '🤖 AUTO-SCAN\n' : ''}*${arrow} SIGNAL ${arrow}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 *${safePair}* | ${timeframe}\n🎯 *${analysis.signal === 'CALL' ? 'CALL (BUY)' : 'PUT (SELL)'}* | Probability: *${analysis.probability}%*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 *PROBABILITY METER:*\n\`${bar}\` ${analysis.probability}%\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📈 *TECHNICALS:* RSI ${analysis.rsi} | ADX ${analysis.adx} | Regime ${analysis.marketRegime}\n🌀 Divergence: ${analysis.divergence}\n📊 Factors: ${analysis.activeFactors.join(', ') || 'none'}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 *ACTION:* ${safeAction} (Risk ${analysis.suggestedRisk})\n🛡️ SL: ${analysis.stopLoss} pips | TP: ${analysis.takeProfit} pips\n💰 Entry: ${analysis.currentPrice} | R:R ${analysis.riskRewardRatio}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚠️ *Probability ≠ Guarantee* – Manage risk.\n🕐 ${new Date().toLocaleTimeString()}`;
    return msg;
}

// ========== AUTO-SCAN ==========
function startAutoScan() {
    if (autoScanInterval) clearInterval(autoScanInterval);
    autoScanInterval = setInterval(async () => {
        if (!isScanning) await performScan(PRIMARY_TF, true);
    }, 15 * 60 * 1000);
    log("✅ Auto‑scan started");
}
function stopAutoScan() {
    if (autoScanInterval) { clearInterval(autoScanInterval); autoScanInterval = null; log("⏹️ Auto‑scan stopped"); }
}

// ========== UI MENUS (simplified – same as original but version updated) ==========
function getMainKeyboard() {
    return { inline_keyboard: [
        [{ text: "🔍 FULL SCAN (15m)", callback_data: "full_scan" }],
        [{ text: "🎯 SELECT PAIRS", callback_data: "menu_pairs" }, { text: "⏰ TIMEFRAME", callback_data: "menu_timeframe" }],
        [{ text: "🤖 AUTO-SCAN", callback_data: "menu_autoscan" }, { text: "📊 HISTORY", callback_data: "menu_history" }],
        [{ text: "📈 STATUS", callback_data: "menu_status" }, { text: "📋 GUIDE", callback_data: "menu_guide" }],
        [{ text: "📊 STATS", callback_data: "menu_stats" }, { text: "❓ HELP", callback_data: "menu_help" }]
    ] };
}
async function showMainMenu(messageId = null) {
    const menu = `🏆 *LEGENDARY BOT v8.0* – 4.9/5\n━━━━━━━━━━━━━━━━━━━━━━\n📊 Timeframes: ${TIMEFRAMES.join(', ')}\n⏰ Primary: ${PRIMARY_TF}\n🤖 Auto‑scan: ${autoScanInterval ? 'ON' : 'OFF'}\n✅ Minimum probability: 68%`;
    if (messageId) await editMessageText(messageId, menu, getMainKeyboard());
    else await sendMessage(menu, getMainKeyboard());
}
// Additional showPairSelection, showTimeframeSelection, showAutoScanMenu, etc.
// (they remain identical to original except version strings – omitted for brevity)

let signalHistory = [];
async function showHistory(messageId = null) { /* as original */ }
async function showStatus(messageId = null) { /* as original */ }
async function showGuide(messageId = null) { /* as original */ }
async function showHelp(messageId = null) { /* as original */ }
async function showStats(messageId = null) { /* as original */ }
async function pingTest() { await sendMessage("🏓 Pong! Bot is alive (v8.0)."); }

async function handleCommand(text, chatId) {
    if (chatId.toString() !== TELEGRAM_CHAT_ID) return;
    log(`📩 Command: ${text}`);
    if (text === '/start') await showMainMenu();
    else if (text === '/ping') await pingTest();
    else if (text === '/scan') await performScan(PRIMARY_TF, false);
    else if (text.startsWith('/scanpair')) {
        const parts = text.split(' ');
        if (parts.length < 2) { await sendMessage("Usage: /scanpair EUR/USD"); return; }
        const pair = parts[1].toUpperCase();
        if (!PAIRS.includes(pair)) { await sendMessage(`Pair ${pair} not in list.`); return; }
        await performScan(PRIMARY_TF, false, [pair]);
    } else if (text === '/status') await showStatus();
    else if (text === '/stats') await showStats();
    else if (text === '/help') await showHelp();
    else await sendMessage("❌ Unknown command. Send /start for menu.");
}

async function handleCallback(query) {
    const data = query.data;
    const msgId = query.message.message_id;
    log(`🔘 Callback: ${data}`);
    if (data.startsWith("record_win")) {
        const rawScore = parseInt(data.split('_')[2]);
        analyzer.recordTradeOutcome(true, rawScore, 2);
        await sendMessage("👍 Trade recorded as WIN.");
        await editMessageText(msgId, query.message.text);
        return;
    }
    if (data.startsWith("record_loss")) {
        const rawScore = parseInt(data.split('_')[2]);
        analyzer.recordTradeOutcome(false, rawScore, -2);
        await sendMessage("👎 Trade recorded as LOSS.");
        await editMessageText(msgId, query.message.text);
        return;
    }
    // All other menu callbacks (pair selection, timeframe, autoscan, etc.) remain identical to original
    // For brevity they are not duplicated – implement as in original v7.1 but with version v8.0 strings.
    if (data === "menu_main") await showMainMenu(msgId);
    else if (data === "full_scan") { await performScan(PRIMARY_TF, false); await showMainMenu(msgId); }
    // ... rest of menu handlers
}

// ========== FAULT-TOLERANT POLLING ==========
async function deleteWebhook() {
    for (let i=0; i<3; i++) {
        try {
            const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteWebhook`, { method: 'POST' });
            const json = await res.json();
            if (json.ok) { log("✅ Webhook deleted"); return true; }
        } catch(e) { log(`Webhook delete attempt ${i+1} failed`); }
        await new Promise(r => setTimeout(r, 2000));
    }
    return false;
}

async function startPolling() {
    await deleteWebhook();
    let offset = 0;
    while (true) {
        try {
            const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${offset}&timeout=30`;
            const response = await fetch(url);
            if (response.status === 409) { await deleteWebhook(); continue; }
            const data = await response.json();
            if (data.ok && data.result) {
                for (const update of data.result) {
                    offset = update.update_id + 1;
                    try {
                        if (update.message?.text) await handleCommand(update.message.text, update.message.chat.id);
                        if (update.callback_query) await handleCallback(update.callback_query);
                    } catch (innerErr) { log(`Handler error: ${innerErr.message}`); }
                }
            }
        } catch (err) {
            log(`Polling error: ${err.message} – retry in 5s`);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

function startHealthServer() {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: "alive", uptime: process.uptime(), version: "8.0" }));
    });
    server.listen(PORT, () => log(`🩺 Health server on port ${PORT}`));
}

process.on('SIGTERM', () => { stopAutoScan(); process.exit(0); });
process.on('SIGINT', () => { stopAutoScan(); process.exit(0); });
process.on('uncaughtException', (e) => { log("Uncaught", e); process.exit(1); });

global.botStartTime = Date.now();
log("🏆 LEGENDARY TRADING BOT v8.0 – INSTITUTIONAL GRADE");
log(`Pairs: ${PAIRS.length} | Telegram: ✅ | Port: ${PORT}`);
startHealthServer();
startPolling();
