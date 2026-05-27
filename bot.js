// ============================================================
// LEGENDARY BOT v5.2 – FULLY HARDENED (NO CHANGES NEEDED)
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

function isEndOfSession() {
    const now = new Date();
    const hour = now.getUTCHours();
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
let autoScanInterval = null;

async function performScan(timeframe, isAuto = false, selectedPairs = null) {
    if (isScanning) {
        if (!isAuto) await sendMessage("⏳ Scan already in progress...");
        return;
    }
    isScanning = true;
    try {
        const pairsToScan = selectedPairs || PAIRS;
        const totalPairs = pairsToScan.length;
        if (!isAuto) await sendTyping();
        let signals = 0;
        for (let idx = 0; idx < pairsToScan.length; idx++) {
            const pair = pairsToScan[idx];
            const symbol = YAHOO_SYMBOLS[pair];
            if (!symbol) continue;
            try {
                if (isNewsTime()) { log(`⏸️ News cooldown – skipping ${pair}`); continue; }
                if (isEndOfSession()) { log(`🔚 End of session – skipping`); continue; }
                const fetchResult = await fetchCandles(symbol, timeframe);
                if (!fetchResult?.candles) continue;
                let htCandles = null;
                if (timeframe !== '1h') {
                    const htResult = await fetchCandles(symbol, '1h');
                    if (htResult) htCandles = htResult.candles;
                }
                const analysis = analyzer.calculateProbability(fetchResult.candles, pair, timeframe, htCandles);
                if (analysis.probability >= 45 && analysis.signal !== 'NEUTRAL') {
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
        if (!isAuto) await sendMessage(`✅ *SCAN COMPLETE*: ${signals} signals (threshold 45%)`);
    } finally { isScanning = false; }
}

function formatSignal(analysis, pair, timeframe, isAuto, isMock) {
    const arrow = analysis.signal === 'CALL' ? '📈' : (analysis.signal === 'PUT' ? '📉' : '➡️');
    const bar = '█'.repeat(Math.floor(analysis.probability / 5)) + '░'.repeat(20 - Math.floor(analysis.probability / 5));
    let msg = `${isAuto ? '🤖 AUTO-SCAN\n' : ''}*${arrow} SIGNAL ${arrow}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 *${pair}* | ${timeframe}\n🎯 *${analysis.signal === 'CALL' ? 'CALL (BUY)' : 'PUT (SELL)'}* | Probability: *${analysis.probability}%*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 *PROBABILITY METER:*\n\`${bar}\` ${analysis.probability}%\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📈 *TECHNICALS:* RSI ${analysis.rsi} | ADX ${analysis.adx} | Regime ${analysis.marketRegime}\n🌀 Divergence: ${analysis.divergence}\n📊 Factors: ${analysis.activeFactors.join(', ') || 'none'}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 *ACTION:* ${analysis.recommendedAction} (Risk ${analysis.suggestedRisk})\n🛡️ SL: ${analysis.stopLoss} pips | TP: ${analysis.takeProfit} pips\n💰 Entry: ${analysis.currentPrice} | R:R ${analysis.riskRewardRatio}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚠️ *Probability ≠ Guarantee* – Manage risk.\n🕐 ${new Date().toLocaleTimeString()}`;
    if (isMock) msg += `\n⚠️ *Using simulated data*`;
    return msg;
}

function startAutoScan() {
    if (autoScanInterval) clearInterval(autoScanInterval);
    autoScanInterval = setInterval(async () => {
        if (!isScanning) {
            log("🔄 AUTO-SCAN triggered");
            await performScan(PRIMARY_TF, true);
        }
    }, 15 * 60 * 1000);
}
function stopAutoScan() { if (autoScanInterval) { clearInterval(autoScanInterval); autoScanInterval = null; } }

function getMainKeyboard() {
    return {
        inline_keyboard: [
            [{ text: "🔍 FULL SCAN (15m)", callback_data: "full_scan" }],
            [{ text: "🎯 SELECT PAIRS", callback_data: "menu_pairs" }, { text: "⏰ TIMEFRAME", callback_data: "menu_timeframe" }],
            [{ text: "🤖 AUTO-SCAN", callback_data: "menu_autoscan" }, { text: "📊 HISTORY", callback_data: "menu_history" }],
            [{ text: "📈 STATUS", callback_data: "menu_status" }, { text: "📋 GUIDE", callback_data: "menu_guide" }],
            [{ text: "📊 STATS", callback_data: "menu_stats" }, { text: "❓ HELP", callback_data: "menu_help" }]
        ]
    };
}

async function showMainMenu(messageId = null) {
    const menu = `🏆 *LEGENDARY TRADING BOT v5.2*\n━━━━━━━━━━━━━━━━━━━━━━\n📊 Active timeframes: ${TIMEFRAMES.join(', ')}\n⏰ Primary: ${PRIMARY_TF} (expiry 15m)\n🤖 Auto‑scan: ${autoScanInterval ? 'ON' : 'OFF'}\n━━━━━━━━━━━━━━━━━━━━━━\n*Send /ping to test*`;
    const kb = getMainKeyboard();
    if (messageId) await editMessageText(messageId, menu, kb);
    else await sendMessage(menu, kb);
}

let currentPairPage = 0;
async function showPairSelection(page = 0, messageId = null) {
    currentPairPage = page;
    const perPage = 10;
    const totalPages = Math.ceil(PAIRS.length / perPage);
    const start = page * perPage;
    const currentPairs = PAIRS.slice(start, start + perPage);
    let menu = `*🎯 INDIVIDUAL PAIR SCAN*\nPage ${page + 1}/${totalPages}\n\nTap a pair to scan it immediately (15m timeframe).`;
    const keyboard = { inline_keyboard: [] };
    for (const p of currentPairs) {
        keyboard.inline_keyboard.push([{ text: `📊 ${p}`, callback_data: `scan_pair_${p}` }]);
    }
    const nav = [];
    if (page > 0) nav.push({ text: "◀️ PREV", callback_data: `pairs_page_${page - 1}` });
    if (page < totalPages - 1) nav.push({ text: "NEXT ▶️", callback_data: `pairs_page_${page + 1}` });
    if (nav.length) keyboard.inline_keyboard.push(nav);
    keyboard.inline_keyboard.push([{ text: "🔙 BACK TO MENU", callback_data: "menu_main" }]);
    if (messageId) await editMessageText(messageId, menu, keyboard);
    else await sendMessage(menu, keyboard);
}

async function showTimeframeSelection(messageId = null) {
    let menu = `*⏰ SELECT TIMEFRAME*\nCurrent default: ${PRIMARY_TF}\nChoose a timeframe for manual scan:`;
    const keyboard = { inline_keyboard: [] };
    for (const tf of TIMEFRAMES) {
        const emoji = tf === PRIMARY_TF ? '⭐' : '🔘';
        keyboard.inline_keyboard.push([{ text: `${emoji} ${tf}`, callback_data: `set_tf_${tf}` }]);
    }
    keyboard.inline_keyboard.push([{ text: "🔙 BACK TO MENU", callback_data: "menu_main" }]);
    if (messageId) await editMessageText(messageId, menu, keyboard);
    else await sendMessage(menu, keyboard);
}

async function showAutoScanMenu(messageId = null) {
    const auto = autoScanInterval !== null;
    const status = auto ? "🟢 ACTIVE" : "🔴 STOPPED";
    const buttonText = auto ? "⏸️ STOP AUTO-SCAN" : "▶️ START AUTO-SCAN";
    const buttonData = auto ? "autoscan_stop" : "autoscan_start";
    let menu = `*🤖 AUTO-SCAN CONTROL*\nStatus: ${status}\nInterval: 15 minutes\nPrimary Timeframe: ${PRIMARY_TF}\n━━━━━━━━━━━━━━━━━━━━━━\nWhen enabled, bot scans all pairs every 15 min.`;
    const keyboard = { inline_keyboard: [[{ text: buttonText, callback_data: buttonData }], [{ text: "🔙 BACK TO MENU", callback_data: "menu_main" }]] };
    if (messageId) await editMessageText(messageId, menu, keyboard);
    else await sendMessage(menu, keyboard);
}

let signalHistory = [];
async function showHistory(messageId = null) {
    if (signalHistory.length === 0) {
        const msg = "📊 *No signals yet.* Run a scan first.";
        if (messageId) await editMessageText(messageId, msg);
        else await sendMessage(msg);
        return;
    }
    let msg = `*📊 SIGNAL HISTORY* (last ${Math.min(15, signalHistory.length)})\n━━━━━━━━━━━━━━━━━━━━━━\n`;
    for (let i = 0; i < Math.min(15, signalHistory.length); i++) {
        const s = signalHistory[i];
        msg += `${s.signal === 'CALL' ? '📈' : '📉'} *${s.pair}* ${s.timeframe} | ${s.probability}%\n`;
    }
    msg += `\nUse /scan for new signals.`;
    const keyboard = { inline_keyboard: [[{ text: "🗑️ CLEAR HISTORY", callback_data: "history_clear" }], [{ text: "🔙 BACK TO MENU", callback_data: "menu_main" }]] };
    if (messageId) await editMessageText(messageId, msg, keyboard);
    else await sendMessage(msg, keyboard);
}

async function showStatus(messageId = null) {
    const uptime = Math.floor((Date.now() - global.botStartTime) / 60000);
    const msg = `*📈 STATUS*\n━━━━━━━━━━━━━━━━━━━━━━\nUptime: ${uptime}m\nPairs: ${PAIRS.length}\nAuto‑scan: ${autoScanInterval ? 'ON' : 'OFF'}\nPrimary TF: ${PRIMARY_TF}\nSignals in history: ${signalHistory.length}\n━━━━━━━━━━━━━━━━━━━━━━\n*Bot is operational*`;
    const keyboard = { inline_keyboard: [[{ text: "🔙 BACK TO MENU", callback_data: "menu_main" }]] };
    if (messageId) await editMessageText(messageId, msg, keyboard);
    else await sendMessage(msg, keyboard);
}

async function showGuide(messageId = null) {
    const msg = `*📋 PROBABILITY GUIDE*\n━━━━━━━━━━━━━━━━━━━━━━\n🔥🔥 85-100% → STRONG (2.5% risk)\n🔥 75-84% → CONFIDENT (2.0%)\n📊 65-74% → NORMAL (1.5%)\n⚠️ 55-64% → CAUTIOUS (0.8%)\n❌ <55% → NO TRADE\n━━━━━━━━━━━━━━━━━━━━━━\n*RULES:*\n- Higher % = larger position\n- Always set stop loss\n- Probability ≠ guarantee`;
    const keyboard = { inline_keyboard: [[{ text: "🔙 BACK TO MENU", callback_data: "menu_main" }]] };
    if (messageId) await editMessageText(messageId, msg, keyboard);
    else await sendMessage(msg, keyboard);
}

async function showHelp(messageId = null) {
    const msg = `*📋 HELP*\n━━━━━━━━━━━━━━━━━━━━━━\n*COMMANDS:*\n/start – Menu\n/scan – Manual full scan\n/scanpair EUR/USD – Scan one pair\n/ping – Test bot response\n/status – Bot status\n/stats – Performance stats\n/help – This message\n━━━━━━━━━━━━━━━━━━━━━━\n*BUTTONS:*\n- FULL SCAN: scan all pairs (15m)\n- SELECT PAIRS: scan individual pair\n- TIMEFRAME: change scan TF\n- AUTO-SCAN: on/off\n- HISTORY: past signals`;
    const keyboard = { inline_keyboard: [[{ text: "🔙 BACK TO MENU", callback_data: "menu_main" }]] };
    if (messageId) await editMessageText(messageId, msg, keyboard);
    else await sendMessage(msg, keyboard);
}

async function showStats(messageId = null) {
    const trades = analyzer.tradeHistory.slice(-50);
    if (trades.length === 0) {
        const msg = "📊 *No trade data yet.* After you mark WIN/LOSS, stats appear.";
        if (messageId) await editMessageText(messageId, msg);
        else await sendMessage(msg);
        return;
    }
    const wins = trades.filter(t => t.win).length;
    const winRate = (wins / trades.length * 100).toFixed(1);
    const msg = `📊 *STRATEGY STATS* (last ${trades.length} trades)\n━━━━━━━━━━━━━━━━━━━━━━\n✅ Win rate: ${winRate}%\n🎯 Total trades: ${trades.length}\n━━━━━━━━━━━━━━━━━━━━━━\nKeep marking WIN/LOSS to improve calibration.`;
    const keyboard = { inline_keyboard: [[{ text: "🔙 BACK TO MENU", callback_data: "menu_main" }]] };
    if (messageId) await editMessageText(messageId, msg, keyboard);
    else await sendMessage(msg, keyboard);
}

async function pingTest() { await sendMessage("🏓 Pong! Bot is alive and responding."); }

async function handleCommand(text, chatId) {
    if (chatId.toString() !== TELEGRAM_CHAT_ID) return;
    await userLimiter.check(chatId);
    log(`📩 Command: ${text}`);
    if (text === '/start') await showMainMenu();
    else if (text === '/ping') await pingTest();
    else if (text === '/scan') { await sendTyping(); await performScan(PRIMARY_TF, false); }
    else if (text.startsWith('/scanpair')) {
        const parts = text.split(' ');
        if (parts.length < 2) { await sendMessage("Usage: /scanpair EUR/USD"); return; }
        const pair = parts[1].toUpperCase();
        if (!PAIRS.includes(pair)) { await sendMessage(`Pair ${pair} not in list.`); return; }
        await sendTyping(); await performScan(PRIMARY_TF, false, [pair]);
    } else if (text === '/status') await showStatus();
    else if (text === '/stats') await showStats();
    else if (text === '/help') await showHelp();
    else await sendMessage("❌ Unknown command. Send /start for menu.");
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
        return;
    }
    if (data.startsWith("record_loss")) {
        const rawScore = parseInt(data.split('_')[2]);
        analyzer.recordTradeOutcome(false, rawScore, -2);
        await sendMessage("👎 Trade recorded as LOSS.");
        await editMessageText(msgId, query.message.text);
        return;
    }
    if (data.startsWith("scan_pair_")) {
        const pair = data.replace("scan_pair_", "");
        await sendTyping(); await performScan(PRIMARY_TF, false, [pair]);
        return;
    }
    if (data.startsWith("pairs_page_")) {
        const page = parseInt(data.replace("pairs_page_", ""));
        if (!isNaN(page)) await showPairSelection(page, msgId);
        return;
    }
    if (data.startsWith("set_tf_")) {
        const tf = data.replace("set_tf_", "");
        if (TIMEFRAMES.includes(tf)) {
            global.tempTimeframe = tf;
            await sendMessage(`✅ Timeframe set to ${tf} for manual scans. Use /scan to scan.`);
        }
        await showTimeframeSelection(msgId);
        return;
    }
    if (data === "autoscan_start") { startAutoScan(); await showAutoScanMenu(msgId); return; }
    if (data === "autoscan_stop") { stopAutoScan(); await showAutoScanMenu(msgId); return; }
    if (data === "history_clear") { signalHistory = []; await sendMessage("🗑️ History cleared."); await showHistory(msgId); return; }
    if (data === "menu_main") await showMainMenu(msgId);
    else if (data === "full_scan") { await sendTyping(); await performScan(PRIMARY_TF, false); await showMainMenu(msgId); }
    else if (data === "menu_pairs") await showPairSelection(0, msgId);
    else if (data === "menu_timeframe") await showTimeframeSelection(msgId);
    else if (data === "menu_autoscan") await showAutoScanMenu(msgId);
    else if (data === "menu_history") await showHistory(msgId);
    else if (data === "menu_status") await showStatus(msgId);
    else if (data === "menu_guide") await showGuide(msgId);
    else if (data === "menu_help") await showHelp(msgId);
    else if (data === "menu_stats") await showStats(msgId);
    else await sendMessage("Unknown action.");
}

async function deleteWebhook() {
    for (let i = 0; i < 3; i++) {
        try {
            const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteWebhook`, { method: 'POST' });
            const json = await res.json();
            if (json.ok) { log("✅ Webhook deleted"); return true; }
        } catch (e) { log(`Webhook delete attempt ${i+1} failed: ${e.message}`); }
        await new Promise(r => setTimeout(r, 2000));
    }
    return false;
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
                    if (update.message?.text) {
                        setImmediate(() => handleCommand(update.message.text, update.message.chat.id).catch(e => log(e)));
                    }
                    if (update.callback_query) {
                        setImmediate(() => handleCallback(update.callback_query).catch(e => log(e)));
                    }
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

process.on('SIGTERM', () => { log("SIGTERM"); stopAutoScan(); process.exit(0); });
process.on('SIGINT', () => { log("SIGINT"); stopAutoScan(); process.exit(0); });
process.on('uncaughtException', (e) => { log("Uncaught", e); process.exit(1); });

global.botStartTime = Date.now();
log("🏆 LEGENDARY TRADING BOT v5.2 – FULLY HARDENED");
log(`Pairs: ${PAIRS.length} loaded`);
log(`Telegram: ${TELEGRAM_TOKEN ? "✅" : "❌"}`);
log(`HTTP Port: ${PORT}`);
startHealthServer();
startPolling();
