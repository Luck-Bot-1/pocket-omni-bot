const { LegendaryAnalyzer } = require('./analyzer.js');
const https = require('https');
const fs = require('fs');
const pairsConfig = require('./pairs.json');

if (!pairsConfig.probabilityLevels || !pairsConfig.technicalParameters) {
    console.error('❌ Invalid pairs.json');
    process.exit(1);
}

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
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

let userSettings = { selectedPairs: [...PAIRS], selectedTimeframe: PRIMARY_TF, autoScanEnabled: false };
let signalHistory = [];
let autoScanInterval = null;
let isScanning = false;
let lastUpdateId = 0;
let botStartTime = Date.now();
let consecutiveErrors = 0;
let lastSuccessfulPoll = Date.now();
let isShuttingDown = false;
let activeOperations = 0;

const analyzer = new LegendaryAnalyzer();

// ---------- Rate Limiter (fixed 429 handling) ----------
class RateLimiter {
    constructor() { this.queue = []; this.processing = false; this.lastRequest = 0; this.minInterval = 50; this.requestHistory = []; }
    async schedule(fn, priority = 5) {
        return new Promise((resolve, reject) => {
            this.queue.push({ fn, resolve, reject, priority, timestamp: Date.now(), retries: 0 });
            this.queue.sort((a, b) => b.priority - a.priority);
            this.process();
        });
    }
    async process() {
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;
        const now = Date.now();
        const wait = this.lastRequest + this.minInterval - now;
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        const req = this.queue.shift();
        this.lastRequest = Date.now();
        this.requestHistory.push(this.lastRequest);
        if (this.requestHistory.length > 60) this.requestHistory.shift();
        try {
            const result = await req.fn();
            req.resolve(result);
        } catch (err) {
            if (err.statusCode === 429 && req.retries < 3) {
                req.retries++;
                const backoff = (err.retryAfter || Math.pow(2, req.retries)) * 1000;
                setTimeout(() => { this.queue.unshift(req); this.process(); }, backoff);
            } else {
                req.reject(err);
            }
        }
        this.processing = false;
        this.process();
    }
}
const rateLimiter = new RateLimiter();

// ---------- Persistence ----------
function loadData() {
    try {
        if (fs.existsSync('./signalHistory.json')) signalHistory = JSON.parse(fs.readFileSync('./signalHistory.json', 'utf8')).slice(0, 2000);
        if (fs.existsSync('./settings.json')) userSettings = { ...userSettings, ...JSON.parse(fs.readFileSync('./settings.json', 'utf8')) };
        console.log(`📂 Loaded ${signalHistory.length} signals`);
    } catch (e) { console.error('Load error:', e); }
}

function saveData() {
    try {
        if (signalHistory.length > 2000) signalHistory = signalHistory.slice(0, 2000);
        fs.writeFileSync('./signalHistory.json', JSON.stringify(signalHistory, null, 2));
        fs.writeFileSync('./settings.json', JSON.stringify(userSettings, null, 2));
    } catch (e) { console.error('Save error:', e); }
}

// ---------- Graceful Shutdown ----------
async function gracefulShutdown(signal) {
    if (isShuttingDown) process.exit(1);
    isShuttingDown = true;
    console.log(`\n🛑 Received ${signal}. Shutting down...`);
    if (autoScanInterval) clearInterval(autoScanInterval);
    let waited = 0;
    while (activeOperations > 0 && waited < 30000) { await new Promise(r => setTimeout(r, 100)); waited += 100; }
    saveData();
    if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
        try { await sendMessage(`🛑 *Bot Shutting Down*\nSaving state...\n⏱️ ${new Date().toLocaleString()}`); } catch(e) {}
    }
    console.log('✅ Shutdown complete');
    process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (e) => { console.error('Uncaught:', e); gracefulShutdown('UNCAUGHT'); });
process.on('unhandledRejection', (r) => { console.error('Unhandled:', r); });

// ---------- Yahoo Finance Fetch ----------
async function fetchCandles(symbol, interval, timeoutMs = 10000) {
    return new Promise((resolve) => {
        activeOperations++;
        let req = null, timer = null;
        const cleanup = () => {
            if (timer) clearTimeout(timer);
            if (req && !req.destroyed) req.destroy();
            activeOperations--;
        };
        timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
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
        req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (!json.chart?.result?.[0]) { cleanup(); resolve(null); return; }
                    const quotes = json.chart.result[0].indicators.quote[0];
                    if (!quotes || !quotes.open) { cleanup(); resolve(null); return; }
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
                    cleanup();
                    resolve(candles.length > 30 ? candles : null);
                } catch (e) { cleanup(); resolve(null); }
            });
        });
        req.on('error', () => { cleanup(); resolve(null); });
        req.end();
    });
}

// ---------- Telegram Send (with proper 429 requeue) ----------
async function sendMessage(text, replyMarkup = null, priority = 5) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) { console.log(`📱 ${text.substring(0, 200)}...`); return; }
    return rateLimiter.schedule(async () => {
        const data = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown", disable_web_page_preview: true };
        if (replyMarkup) data.reply_markup = replyMarkup;
        const postData = JSON.stringify(data);
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        return new Promise((resolve, reject) => {
            const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } }, (res) => {
                let respData = '';
                res.on('data', chunk => respData += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(respData);
                        if (!parsed.ok && parsed.error_code === 429) {
                            const err = new Error('Rate limited');
                            err.statusCode = 429;
                            err.retryAfter = parsed.parameters?.retry_after || 5;
                            reject(err);
                        } else {
                            resolve(parsed);
                        }
                    } catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.write(postData);
            req.end();
        });
    }, priority);
}

// ---------- Signal Formatting ----------
function formatSignal(analysis, pair, timeframe, isAuto = false) {
    const arrow = analysis.signal === 'CALL' ? '📈' : (analysis.signal === 'PUT' ? '📉' : '➡️');
    const dir = analysis.signal === 'CALL' ? 'CALL (BUY)' : (analysis.signal === 'PUT' ? 'PUT (SELL)' : 'NEUTRAL');
    const bar = '█'.repeat(Math.floor(analysis.probability / 5)) + '░'.repeat(20 - Math.floor(analysis.probability / 5));
    return `${isAuto ? '🤖 AUTO-SCAN\n' : ''}*${arrow} PROBABILITY SIGNAL ${arrow}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 *${pair}* | [${timeframe}]\n🎯 *${dir}* | Probability: *${analysis.probability}%* ${analysis.probabilityEmoji}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 *PROBABILITY METER:*\n\`${bar}\` ${analysis.probability}%\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📈 *TECHNICALS:* RSI ${analysis.rsi} | ADX ${analysis.adx} | Vol ${analysis.volatility}%\n📊 Strategies: ${analysis.activeStrategies.length}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 *${analysis.guidance}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🛡️ *SL:* ${analysis.stopLoss} pips | *TP:* ${analysis.takeProfit} pips\n💰 *Entry:* ${analysis.currentPrice} | *Risk:* ${analysis.suggestedRisk}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚠️ *Probability ≠ Certainty* | YOU decide\n🕐 ${new Date().toLocaleTimeString()}`;
}

// ---------- Scan Logic ----------
async function performScan(timeframe, isAuto = false) {
    if (isScanning) { if (!isAuto) await sendMessage("⏳ Scan in progress..."); return null; }
    isScanning = true;
    console.log(`\n🔍 SCAN: ${timeframe} | Auto: ${isAuto} | Pairs: ${userSettings.selectedPairs.length}`);
    if (!isAuto) await sendMessage(`🔍 *SCAN STARTED*\n━━━━━━━━━━━━━━━━━━━━━━\n⏰ ${timeframe} | ${userSettings.selectedPairs.length} pairs\n_Generating opportunities..._`);
    let signals = 0, legendary = 0, exceptional = 0, high = 0, good = 0, moderate = 0, low = 0;
    for (const pair of userSettings.selectedPairs) {
        const symbol = YAHOO_SYMBOLS[pair];
        if (!symbol) continue;
        const candles = await fetchCandles(symbol, timeframe);
        if (!candles || candles.length < 30) continue;
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
        signalHistory.unshift({ timestamp: new Date().toISOString(), pair, timeframe, signal: analysis.signal, probability: analysis.probability, probabilityLevel: analysis.probabilityLevel, recommendedAction: analysis.recommendedAction });
        saveData();
        await new Promise(r => setTimeout(r, 200));
    }
    console.log(`✅ SCAN COMPLETE: ${signals} signals | L:${legendary} E:${exceptional} H:${high} G:${good} M:${moderate} Lw:${low}`);
    if (!isAuto) await sendMessage(`✅ *SCAN COMPLETE*: ${signals} signals\n👑${legendary} 🔥${exceptional} 🔥${high} 📊${good} ⚡${moderate} ⚠️${low}\n━━━━━━━━━━━━━━━━━━━━━━\nReview probabilities above. YOU decide.`);
    isScanning = false;
    return signals;
}

async function autoScan() { if (userSettings.autoScanEnabled && !isScanning) { console.log(`\n🔄 AUTO-SCAN: ${new Date().toLocaleTimeString()}`); await performScan(userSettings.selectedTimeframe, true); } }

// ---------- Telegram UI (all callbacks safe) ----------
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
    const uptime = Math.floor((Date.now() - botStartTime) / 1000 / 60);
    const menu = `🏆 *OMNI v16.0* | ${uptime}m\n━━━━━━━━━━━━━━━━━━━━━━\n📊 ${userSettings.selectedPairs.length}/${PAIRS.length} pairs\n⏰ ${userSettings.selectedTimeframe} ⭐\n🤖 ${userSettings.autoScanEnabled ? 'ON' : 'OFF'}\n━━━━━━━━━━━━━━━━━━━━━━\n📊 92%+ 👑 MAX (3%)\n📊 85-91% 🔥🔥🔥 STRONG (2.5%)\n📊 78-84% 🔥🔥 CONFIDENT (2%)\n📊 70-77% 🔥 NORMAL (1.5%)\n📊 62-69% ⚡ CAUTIOUS (1%)\n📊 55-61% ⚠️ SKIP (0.5%)\n━━━━━━━━━━━━━━━━━━━━━━\n*YOU decide. Not the bot.*`;
    const kb = getMainKeyboard();
    if (messageId) {
        const req = https.request(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, { method: 'POST' }, () => {});
        req.write(JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, message_id: messageId, text: menu, parse_mode: "Markdown", reply_markup: kb }));
        req.end();
    } else await sendMessage(menu, kb);
}

async function showHistory(messageId = null) {
    const recent = signalHistory.slice(0, 15);
    let msg = `*📊 SIGNAL HISTORY*\n━━━━━━━━━━━━━━━━━━━━━━\n`;
    for (const s of recent) {
        let emoji = s.probability >= 92 ? '👑' : (s.probability >= 85 ? '🔥🔥🔥' : (s.probability >= 78 ? '🔥🔥' : (s.probability >= 70 ? '🔥' : (s.probability >= 62 ? '⚡' : '⚠️'))));
        msg += `${emoji} ${s.signal === 'CALL' ? '📈' : '📉'} *${s.pair}* | ${s.probability}%\n   ${s.recommendedAction}\n\n`;
    }
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n📊 Total: ${signalHistory.length}\n💡 Use probability to guide decisions.`;
    const kb = { inline_keyboard: [[{ text: "🗑️ CLEAR", callback_data: "history_clear" }], [{ text: "🔙 BACK", callback_data: "menu_main" }]] };
    if (messageId) {
        const req = https.request(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, { method: 'POST' }, () => {});
        req.write(JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, message_id: messageId, text: msg, parse_mode: "Markdown", reply_markup: kb }));
        req.end();
    } else await sendMessage(msg, kb);
}

async function showStatus(messageId = null) {
    const uptime = Math.floor((Date.now() - botStartTime) / 1000 / 60);
    const legendary = signalHistory.filter(s => s.probability >= 92).length;
    const exceptional = signalHistory.filter(s => s.probability >= 85 && s.probability < 92).length;
    const high = signalHistory.filter(s => s.probability >= 78 && s.probability < 85).length;
    const msg = `*📈 STATUS*\n━━━━━━━━━━━━━━━━━━━━━━\nUptime: ${uptime}m\nPairs: ${userSettings.selectedPairs.length}/${PAIRS.length}\nAuto: ${userSettings.autoScanEnabled ? 'ON' : 'OFF'}\n━━━━━━━━━━━━━━━━━━━━━━\n*SIGNALS:* ${signalHistory.length}\n👑 Legendary: ${legendary}\n🔥 Exceptional: ${exceptional}\n🔥 High: ${high}\n━━━━━━━━━━━━━━━━━━━━━━\n*YOU are the decision maker*`;
    const kb = { inline_keyboard: [[{ text: "🔙 BACK", callback_data: "menu_main" }]] };
    if (messageId) {
        const req = https.request(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, { method: 'POST' }, () => {});
        req.write(JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, message_id: messageId, text: msg, parse_mode: "Markdown", reply_markup: kb }));
        req.end();
    } else await sendMessage(msg, kb);
}

async function showGuide(messageId = null) {
    const msg = `*📋 PROBABILITY GUIDE*\n━━━━━━━━━━━━━━━━━━━━━━\n👑 92-100% → MAX (3% risk)\n🔥🔥🔥 85-91% → STRONG (2.5%)\n🔥🔥 78-84% → CONFIDENT (2%)\n🔥 70-77% → NORMAL (1.5%)\n⚡ 62-69% → CAUTIOUS (1%)\n⚠️ 55-61% → SKIP (0.5%)\n❌ <55% → NO TRADE\n━━━━━━━━━━━━━━━━━━━━━━\n*GOLDEN RULES:*\n• Higher % = Larger position\n• Lower % = Skip or tiny\n• YOU decide based on risk\n━━━━━━━━━━━━━━━━━━━━━━\n*REMEMBER:* Probability ≠ Guarantee`;
    const kb = { inline_keyboard: [[{ text: "🔙 BACK", callback_data: "menu_main" }]] };
    if (messageId) {
        const req = https.request(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, { method: 'POST' }, () => {});
        req.write(JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, message_id: messageId, text: msg, parse_mode: "Markdown", reply_markup: kb }));
        req.end();
    } else await sendMessage(msg, kb);
}

async function showHelp(messageId = null) {
    const msg = `*📋 HELP*\n━━━━━━━━━━━━━━━━━━━━━━\n*COMMANDS:*\n/start - Menu\n/scan - Manual scan\n/status - Status\n/help - Help\n━━━━━━━━━━━━━━━━━━━━━━\n*HOW TO USE:*\n1. Bot shows EVERY signal with %\n2. Check probability level\n3. YOU decide to trade or skip\n4. Higher % = Larger position\n━━━━━━━━━━━━━━━━━━━━━━\n*EXAMPLE:*\n85% CALL → 2.5% risk\n65% PUT → 1% risk\n55% CALL → Skip\n━━━━━━━━━━━━━━━━━━━━━━\n*YOU are the decision maker*`;
    const kb = { inline_keyboard: [[{ text: "🔙 BACK", callback_data: "menu_main" }]] };
    if (messageId) {
        const req = https.request(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, { method: 'POST' }, () => {});
        req.write(JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, message_id: messageId, text: msg, parse_mode: "Markdown", reply_markup: kb }));
        req.end();
    } else await sendMessage(msg, kb);
}

async function showPairSelection(page = 0, messageId = null) {
    const perPage = 10;
    const total = Math.ceil(PAIRS.length / perPage);
    const start = page * perPage;
    const current = PAIRS.slice(start, start + perPage);
    let menu = `*🎯 SELECT PAIRS* (${userSettings.selectedPairs.length}/${PAIRS.length})\nPage ${page + 1}/${total}\n\n`;
    const kb = { inline_keyboard: [] };
    for (const p of current) {
        const check = userSettings.selectedPairs.includes(p) ? '✅' : '⬜';
        kb.inline_keyboard.push([{ text: `${check} ${p}`, callback_data: `toggle_${p}` }]);
    }
    const nav = [];
    if (page > 0) nav.push({ text: "◀️ PREV", callback_data: `page_${page - 1}` });
    if (page < total - 1) nav.push({ text: "NEXT ▶️", callback_data: `page_${page + 1}` });
    if (nav.length) kb.inline_keyboard.push(nav);
    kb.inline_keyboard.push([{ text: "✅ ALL", callback_data: "select_all" }, { text: "❌ CLEAR", callback_data: "clear_all" }]);
    kb.inline_keyboard.push([{ text: "🔙 BACK", callback_data: "menu_main" }]);
    if (messageId) {
        const req = https.request(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, { method: 'POST' }, () => {});
        req.write(JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, message_id: messageId, text: menu, parse_mode: "Markdown", reply_markup: kb }));
        req.end();
    } else await sendMessage(menu, kb);
}

async function showTimeframeSelection(messageId = null) {
    let menu = `*⏰ TIMEFRAME*\nCurrent: ${userSettings.selectedTimeframe}\n\n`;
    const kb = { inline_keyboard: [] };
    for (const tf of TIMEFRAMES) {
        const star = tf === PRIMARY_TF ? ' ⭐' : '';
        const check = userSettings.selectedTimeframe === tf ? '✅' : '🔘';
        kb.inline_keyboard.push([{ text: `${check} ${tf}${star}`, callback_data: `set_tf_${tf}` }]);
    }
    kb.inline_keyboard.push([{ text: "🔙 BACK", callback_data: "menu_main" }]);
    if (messageId) {
        const req = https.request(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, { method: 'POST' }, () => {});
        req.write(JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, message_id: messageId, text: menu, parse_mode: "Markdown", reply_markup: kb }));
        req.end();
    } else await sendMessage(menu, kb);
}

async function showAutoScanMenu(messageId = null) {
    const status = userSettings.autoScanEnabled ? "🟢 ON" : "🔴 OFF";
    const btn = userSettings.autoScanEnabled ? "⏸️ STOP" : "▶️ START";
    const data = userSettings.autoScanEnabled ? "autoscan_stop" : "autoscan_start";
    let menu = `*🤖 AUTO-SCAN*\nStatus: ${status}\nInterval: 15 min\nTF: ${PRIMARY_TF}\n\nWhen enabled, auto-scans every 15 min and sends signals. YOU decide.`;
    const kb = { inline_keyboard: [[{ text: btn, callback_data: data }], [{ text: "🔙 BACK", callback_data: "menu_main" }]] };
    if (messageId) {
        const req = https.request(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, { method: 'POST' }, () => {});
        req.write(JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, message_id: messageId, text: menu, parse_mode: "Markdown", reply_markup: kb }));
        req.end();
    } else await sendMessage(menu, kb);
}

// ---------- DELETE WEBHOOK ON STARTUP (CRITICAL FIX) ----------
async function deleteWebhook() {
    console.log('🔧 Deleting existing webhook...');
    try {
        const result = await new Promise((resolve) => {
            const req = https.request(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteWebhook`, { method: 'POST' }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch(e) { resolve({ ok: false }); }
                });
            });
            req.on('error', () => resolve({ ok: false }));
            req.end();
        });
        if (result.ok) console.log('✅ Webhook deleted successfully');
        else console.log(`⚠️ Webhook delete: ${result.error || 'unknown'}`);
    } catch(e) { console.log(`⚠️ Webhook delete error: ${e.message}`); }
}

// ---------- Callback & Command Handling ----------
async function handleCallback(query) {
    const data = query.data;
    const msgId = query.message.message_id;
    console.log(`🔘 Callback received: ${data}`);
    if (data === "menu_main") await showMainMenu(msgId);
    else if (data === "scan_manual") { await performScan(userSettings.selectedTimeframe, false); await showMainMenu(msgId); }
    else if (data === "menu_pairs") await showPairSelection(0, msgId);
    else if (data === "menu_timeframe") await showTimeframeSelection(msgId);
    else if (data === "menu_autoscan") await showAutoScanMenu(msgId);
    else if (data === "menu_history") await showHistory(msgId);
    else if (data === "menu_status") await showStatus(msgId);
    else if (data === "menu_guide") await showGuide(msgId);
    else if (data === "menu_help") await showHelp(msgId);
    else if (data === "autoscan_start") {
        userSettings.autoScanEnabled = true;
        if (autoScanInterval) clearInterval(autoScanInterval);
        autoScanInterval = setInterval(autoScan, 900000);
        saveData();
        await showAutoScanMenu(msgId);
        setTimeout(autoScan, 2000);
    } else if (data === "autoscan_stop") {
        userSettings.autoScanEnabled = false;
        if (autoScanInterval) clearInterval(autoScanInterval);
        autoScanInterval = null;
        saveData();
        await showAutoScanMenu(msgId);
    } else if (data === "history_clear") { signalHistory = []; saveData(); await showHistory(msgId); }
    else if (data === "select_all") { userSettings.selectedPairs = [...PAIRS]; saveData(); await showPairSelection(0, msgId); }
    else if (data === "clear_all") { userSettings.selectedPairs = []; saveData(); await showPairSelection(0, msgId); }
    else if (data.startsWith("toggle_")) {
        const pair = data.slice(7);
        if (userSettings.selectedPairs.includes(pair)) userSettings.selectedPairs = userSettings.selectedPairs.filter(p => p !== pair);
        else userSettings.selectedPairs.push(pair);
        saveData();
        await showPairSelection(0, msgId);
    } else if (data.startsWith("page_")) {
        const page = parseInt(data.slice(5));
        await showPairSelection(page, msgId);
    } else if (data.startsWith("set_tf_")) {
        userSettings.selectedTimeframe = data.slice(7);
        saveData();
        await showTimeframeSelection(msgId);
    }
    const ans = https.request(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, { method: 'POST' }, () => {});
    ans.write(JSON.stringify({ callback_query_id: query.id }));
    ans.end();
}

async function handleCommand(text, chatId) {
    if (chatId.toString() !== TELEGRAM_CHAT_ID) return;
    console.log(`📩 Command: ${text}`);
    if (text === '/start') await showMainMenu();
    else if (text === '/status') await showStatus();
    else if (text === '/scan') await performScan(userSettings.selectedTimeframe, false);
    else if (text === '/help') await showHelp();
    else await sendMessage(`❌ Unknown. Send /start for menu.`);
}

// ---------- Polling ----------
async function startPolling() {
    if (!TELEGRAM_TOKEN) { console.log('❌ No TELEGRAM_TOKEN'); return; }
    
    // CRITICAL: Delete webhook before polling
    await deleteWebhook();
    
    console.log('📡 Starting polling...');
    const poll = async () => {
        try {
            const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=55`;
            const req = https.get(url, { timeout: 60000 }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        consecutiveErrors = 0;
                        lastSuccessfulPoll = Date.now();
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
            req.on('error', () => { consecutiveErrors++; setTimeout(poll, Math.min(30000, Math.pow(2, consecutiveErrors) * 1000)); });
            req.end();
        } catch (e) { setTimeout(poll, 5000); }
    };
    poll();
}

// ---------- Main ----------
console.log('\n' + '█'.repeat(60));
console.log('🏆 OMNI_BOT v16.0 - LEGENDARY EDITION (WEBHOOK FIXED)');
console.log('█'.repeat(60));
console.log(`Strategy: NO REJECTION | YOU decide`);
console.log(`Indicators: HMA (zero‑lag) + RSI + ADX + MACD + BB`);
console.log(`Risk: Kelly Criterion + regime‑adaptive`);
console.log(`Telegram: ${TELEGRAM_TOKEN ? '✅' : '❌'}`);
console.log('█'.repeat(60) + '\n');

loadData();
startPolling();

setTimeout(async () => {
    if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
        await sendMessage(`🤖 *OMNI_BOT v16.0 ONLINE*\n━━━━━━━━━━━━━━━━━━━━━━\n✅ NO SIGNAL REJECTION\n✅ YOU decide based on %\n✅ Higher % = Larger position\n✅ Lower % = Skip\n━━━━━━━━━━━━━━━━━━━━━━\n📱 *Send /start to begin*\n━━━━━━━━━━━━━━━━━━━━━━\n⚠️ Probability ≠ Guarantee\nYOU are the decision maker.`);
    }
    console.log('🚀 Bot ready! Send /start');
}, 3000);

setInterval(() => {
    console.log(`💓 Uptime: ${Math.floor((Date.now() - botStartTime) / 60000)}m | Auto: ${userSettings.autoScanEnabled ? 'ON' : 'OFF'} | Signals: ${signalHistory.length}`);
}, 60000);
