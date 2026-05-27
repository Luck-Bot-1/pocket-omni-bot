// ============================================================
// DIAGNOSTIC BOT v1.0 – FORCES SIGNALS TO PROVE FUNCTIONALITY
// ============================================================

if (!globalThis.fetch) {
    const nodeFetch = require('node-fetch');
    const { AbortController } = require('node-abort-controller');
    globalThis.fetch = nodeFetch;
    globalThis.AbortController = AbortController;
}

const http = require('http');
const fs = require('fs');
const pairsConfig = require('./pairs.json');

// Simple console logger
const log = (...args) => console.log(new Date().toISOString(), ...args);

// Validate config
if (!pairsConfig.pairs || !pairsConfig.timeframes) {
    log('❌ FATAL: pairs.json invalid');
    process.exit(1);
}

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PORT = process.env.PORT || 8080;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    log('❌ FATAL: Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    process.exit(1);
}

const YAHOO_SYMBOLS = {};
for (const pair of pairsConfig.pairs) {
    YAHOO_SYMBOLS[pair] = pair.replace('/', '') + '=X';
}
const PAIRS = pairsConfig.pairs;
const PRIMARY_TF = pairsConfig.primaryTimeframe || '15m';

// Simple cache
const candleCache = new Map();
function cacheSet(key, data) { candleCache.set(key, { data, ts: Date.now() }); }
function cacheGet(key) {
    const e = candleCache.get(key);
    if (e && Date.now() - e.ts < 60000) return e.data;
    if (e) candleCache.delete(key);
    return null;
}

// Rate limiter (simple)
class TokenBucket {
    constructor(capacity=5, refillRate=20) {
        this.capacity = capacity;
        this.tokens = capacity;
        this.refillRate = refillRate / 1000;
        this.lastRefill = Date.now();
    }
    async consume() {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
        this.lastRefill = now;
        if (this.tokens >= 1) {
            this.tokens -= 1;
            return true;
        }
        await new Promise(r => setTimeout(r, 10));
        return this.consume();
    }
}
const rateLimiter = new TokenBucket(5, 20);

// Message queue
const messageQueue = [];
let processing = false;
async function sendMessage(text, replyMarkup = null) {
    await rateLimiter.consume();
    const body = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown", disable_web_page_preview: true };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`Telegram: ${json.description}`);
    return json;
}

async function editMessageText(messageId, text, replyMarkup = null) {
    if (!messageId) return;
    await rateLimiter.consume();
    const body = { chat_id: TELEGRAM_CHAT_ID, message_id: messageId, text, parse_mode: "Markdown" };
    if (replyMarkup) body.reply_markup = replyMarkup;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).catch(e => log('Edit failed', e.message));
}

// Fetch Yahoo data (simple)
async function fetchYahooRaw(symbol, interval) {
    let period1;
    switch (interval) {
        case '1m': period1 = Math.floor(Date.now()/1000)-86400; break;
        case '5m': period1 = Math.floor(Date.now()/1000)-259200; break;
        default: period1 = Math.floor(Date.now()/1000)-604800;
    }
    const period2 = Math.floor(Date.now()/1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=${interval}`;
    try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const json = await res.json();
        if (!json.chart?.result?.[0]) return null;
        const quotes = json.chart.result[0].indicators.quote[0];
        const timestamps = json.chart.result[0].timestamp;
        const candles = [];
        for (let i=0; i<timestamps.length; i++) {
            if (quotes.open[i] && quotes.high[i] && quotes.low[i] && quotes.close[i]) {
                candles.push({
                    open: quotes.open[i], high: quotes.high[i], low: quotes.low[i],
                    close: quotes.close[i], volume: quotes.volume[i] || 1000,
                    time: timestamps[i]*1000
                });
            }
        }
        if (candles.length >= 50) return candles;
        return null;
    } catch(e) { log(`Yahoo error ${symbol}:`, e.message); return null; }
}

// Force a signal for testing
async function forceSignal() {
    await sendMessage("💪 *FORCED SIGNAL* – This is a test signal to prove the bot can send messages.\nProbability: 85%\nAction: CALL (BUY)\nRisk: 2.5%");
}

// Simplified scan – always produces a signal if data exists
async function performScan(timeframe, isAuto=false) {
    log(`Starting scan on ${timeframe}`);
    const pairsList = PAIRS.slice(0, 3); // limit to first 3 for speed
    let signals = 0;
    for (const pair of pairsList) {
        const symbol = YAHOO_SYMBOLS[pair];
        if (!symbol) continue;
        let candles = cacheGet(symbol);
        if (!candles) {
            candles = await fetchYahooRaw(symbol, timeframe);
            if (candles) cacheSet(symbol, candles);
        }
        if (!candles || candles.length < 50) {
            log(`No data for ${pair}`);
            continue;
        }
        // Simple RSI calculation
        const closes = candles.map(c => c.close);
        const rsi = (period=14) => {
            if (closes.length < period+1) return 50;
            let gains=0, losses=0;
            for (let i=1; i<=period; i++) {
                const diff = closes[i] - closes[i-1];
                if (diff>=0) gains+=diff; else losses-=diff;
            }
            let avgGain=gains/period, avgLoss=losses/period;
            for (let i=period+1; i<closes.length; i++) {
                const diff = closes[i]-closes[i-1];
                if (diff>=0) { avgGain = (avgGain*(period-1)+diff)/period; avgLoss = (avgLoss*(period-1))/period; }
                else { avgGain = (avgGain*(period-1))/period; avgLoss = (avgLoss*(period-1)-diff)/period; }
            }
            if (avgLoss===0) return 100;
            const rs = avgGain/avgLoss;
            return 100 - 100/(1+rs);
        };
        const currentRSI = rsi(14);
        const price = closes[closes.length-1];
        let signal = 'NEUTRAL';
        let probability = 0;
        // Force a signal if RSI < 40 or > 60 (broad range)
        if (currentRSI < 40) {
            signal = 'CALL';
            probability = 65;
        } else if (currentRSI > 60) {
            signal = 'PUT';
            probability = 65;
        } else {
            // Still generate a signal to prove bot works
            signal = currentRSI > 50 ? 'CALL' : 'PUT';
            probability = 55;
        }
        signals++;
        const msg = `📊 *${pair}* | ${timeframe}\n🎯 *${signal === 'CALL' ? 'CALL (BUY)' : 'PUT (SELL)'}* | Probability: *${probability}%*\n📈 RSI: ${currentRSI.toFixed(1)}\n💰 Entry: ${price.toFixed(5)}\n━━━━━━━━━━━━━━━━━━━━━━\n⚠️ *Diagnostic mode* – Real strategy disabled.`;
        await sendMessage(msg);
        log(`Signal sent for ${pair}: ${signal} ${probability}%`);
        await new Promise(r => setTimeout(r, 500));
    }
    await sendMessage(`✅ Scan complete: ${signals} signals sent (diagnostic mode).`);
    return signals;
}

// UI handlers (minimal)
async function showMainMenu(messageId=null) {
    const menu = `🏆 *DIAGNOSTIC BOT* – Testing mode\n━━━━━━━━━━━━━━━━━━━━━━\nUse /scan to test data fetching and messaging.\nUse /forcesignal to send a test message.\nUse /start to see this menu again.`;
    const keyboard = { inline_keyboard: [[{ text: "🔍 SCAN", callback_data: "scan_manual" }, { text: "💪 FORCE SIGNAL", callback_data: "force_signal" }]] };
    if (messageId) await editMessageText(messageId, menu, keyboard);
    else await sendMessage(menu, keyboard);
}

async function handleCommand(text, chatId) {
    if (chatId.toString() !== TELEGRAM_CHAT_ID) return;
    log(`Command: ${text}`);
    if (text === '/start') await showMainMenu();
    else if (text === '/scan') { await sendMessage("🔍 Scanning (diagnostic mode)..."); await performScan(PRIMARY_TF, false); }
    else if (text === '/forcesignal') await forceSignal();
    else await sendMessage("Unknown command. Send /start");
}

async function handleCallback(query) {
    const data = query.data;
    const msgId = query.message.message_id;
    log(`Callback: ${data}`);
    if (data === 'scan_manual') {
        await sendMessage("🔍 Scanning...");
        await performScan(PRIMARY_TF, false);
        await showMainMenu(msgId);
    } else if (data === 'force_signal') {
        await forceSignal();
        await showMainMenu(msgId);
    } else {
        await showMainMenu(msgId);
    }
}

// Polling
async function startPolling() {
    // delete webhook
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteWebhook`, { method: 'POST' });
    log('Polling started');
    let lastUpdateId = 0;
    while (true) {
        try {
            const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId+1}&timeout=30`;
            const res = await fetch(url);
            const json = await res.json();
            if (json.ok && json.result) {
                for (const update of json.result) {
                    if (update.update_id > lastUpdateId) lastUpdateId = update.update_id;
                    if (update.message?.text) await handleCommand(update.message.text, update.message.chat.id);
                    if (update.callback_query) await handleCallback(update.callback_query);
                }
            }
        } catch (e) { log('Poll error', e.message); await new Promise(r=>setTimeout(r,2000)); }
    }
}

// Health server
function startHealthServer() {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'alive', uptime: process.uptime() }));
    });
    server.listen(PORT, () => log(`Health server on ${PORT}`));
}

// Graceful shutdown
process.on('SIGTERM', () => { log('Shutting down'); process.exit(0); });
process.on('SIGINT', () => { log('Shutting down'); process.exit(0); });

// Start
console.log('\n' + '█'.repeat(60));
console.log('🏆 DIAGNOSTIC BOT v1.0 – FORCES SIGNALS');
console.log('█'.repeat(60));
console.log(`Telegram: ✅`);
console.log(`HTTP Port: ${PORT}`);
console.log('█'.repeat(60) + '\n');

startHealthServer();
startPolling();

setTimeout(async () => {
    await sendMessage("🤖 *DIAGNOSTIC BOT ONLINE*\n━━━━━━━━━━━━━━━━━━━━━━\n✅ This bot forces signals to prove the infrastructure works.\n✅ Send /scan to fetch real Yahoo data and get signals.\n✅ Send /forcesignal to test messaging.\n📱 *Send /start to begin*");
    log('Startup message sent');
}, 3000);
