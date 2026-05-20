// ============================================
// OMNI_POCKET_BOT v4.0 - COMPLETE INTERFACE FIX
// WITH WORKING TELEGRAM BUTTONS
// ============================================

const { analyzeSignal } = require('./analyzer.js');
const https = require('https');
const fs = require('fs');

// ============================================
// CONFIGURATION
// ============================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const PAIRS = [
    'EUR/USD', 'GBP/USD', 'AUD/USD', 'NZD/USD', 'USD/CAD', 'USD/CHF', 'USD/JPY',
    'AUD/CAD', 'AUD/JPY', 'CAD/JPY', 'CHF/JPY', 'EUR/AUD', 'EUR/CAD', 'EUR/CHF',
    'EUR/GBP', 'EUR/JPY', 'EUR/NZD', 'GBP/AUD', 'GBP/CAD', 'GBP/CHF', 'GBP/JPY',
    'GBP/NZD', 'NZD/CAD', 'NZD/JPY', 'AUD/NZD', 'CAD/CHF', 'AUD/CHF'
];

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h'];
const PRIMARY_TF = '15m';

const YAHOO_SYMBOLS = {
    'EUR/USD': 'EURUSD=X', 'GBP/USD': 'GBPUSD=X', 'AUD/USD': 'AUDUSD=X',
    'NZD/USD': 'NZDUSD=X', 'USD/CAD': 'USDCAD=X', 'USD/CHF': 'USDCHF=X',
    'USD/JPY': 'USDJPY=X', 'AUD/CAD': 'AUDCAD=X', 'AUD/JPY': 'AUDJPY=X',
    'CAD/JPY': 'CADJPY=X', 'CHF/JPY': 'CHFJPY=X', 'EUR/AUD': 'EURAUD=X',
    'EUR/CAD': 'EURCAD=X', 'EUR/CHF': 'EURCHF=X', 'EUR/GBP': 'EURGBP=X',
    'EUR/JPY': 'EURJPY=X', 'EUR/NZD': 'EURNZD=X', 'GBP/AUD': 'GBPAUD=X',
    'GBP/CAD': 'GBPCAD=X', 'GBP/CHF': 'GBPCHF=X', 'GBP/JPY': 'GBPJPY=X',
    'GBP/NZD': 'GBPNZD=X', 'NZD/CAD': 'NZDCAD=X', 'NZD/JPY': 'NZDJPY=X',
    'AUD/NZD': 'AUDNZD=X', 'CAD/CHF': 'CADCHF=X', 'AUD/CHF': 'AUDCHF=X'
};

// State variables
let userSettings = {
    selectedPairs: [...PAIRS],
    selectedTimeframe: PRIMARY_TF,
    autoScanEnabled: false,
    riskPerTrade: 20
};

let trades = [];
let autoScanInterval = null;
let isScanning = false;
let lastUpdateId = 0;
let botStartTime = Date.now();

// Load saved trades
try {
    if (fs.existsSync('./trades.json')) {
        trades = JSON.parse(fs.readFileSync('./trades.json', 'utf8'));
    }
} catch(e) {}

// ============================================
// TELEGRAM API FUNCTIONS
// ============================================

function callTelegramAPI(method, data) {
    return new Promise((resolve) => {
        if (!TELEGRAM_TOKEN) {
            resolve({ ok: false, error: 'No token' });
            return;
        }
        
        const postData = JSON.stringify(data);
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`;
        
        const req = https.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        }, (res) => {
            let responseData = '';
            res.on('data', chunk => responseData += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(responseData));
                } catch(e) {
                    resolve({ ok: false, error: e.message });
                }
            });
        });
        
        req.on('error', (e) => resolve({ ok: false, error: e.message }));
        req.write(postData);
        req.end();
    });
}

function sendMessage(text, replyMarkup = null) {
    const data = {
        chat_id: TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: "Markdown",
        disable_web_page_preview: true
    };
    if (replyMarkup) data.reply_markup = replyMarkup;
    
    return callTelegramAPI('sendMessage', data);
}

function editMessage(text, messageId, replyMarkup = null) {
    const data = {
        chat_id: TELEGRAM_CHAT_ID,
        message_id: messageId,
        text: text,
        parse_mode: "Markdown"
    };
    if (replyMarkup) data.reply_markup = replyMarkup;
    
    return callTelegramAPI('editMessageText', data);
}

function answerCallback(queryId, text, showAlert = false) {
    return callTelegramAPI('answerCallbackQuery', {
        callback_query_id: queryId,
        text: text,
        show_alert: showAlert
    });
}

// ============================================
// DELETE WEBHOOK ON STARTUP
// ============================================
async function deleteWebhook() {
    console.log('🔧 Deleting existing webhook...');
    const result = await callTelegramAPI('deleteWebhook', {});
    if (result.ok) {
        console.log('✅ Webhook deleted successfully');
    } else {
        console.log(`⚠️ Webhook delete: ${result.error || 'unknown'}`);
    }
}

// ============================================
// MAIN MENU WITH BUTTONS
// ============================================
async function showMainMenu(messageId = null) {
    const uptime = Math.floor((Date.now() - botStartTime) / 1000 / 60);
    const menu = `*🏆 OMNI_POCKET_BOT v4.0 🏆*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ *STATUS:* ONLINE (${uptime}m)
✅ *DATA:* YAHOO FINANCE (LIVE)
✅ *PAIRS:* ${userSettings.selectedPairs.length}/${PAIRS.length}
✅ *TIMEFRAME:* ${userSettings.selectedTimeframe} ${userSettings.selectedTimeframe === PRIMARY_TF ? '⭐' : ''}
✅ *AUTO-SCAN:* ${userSettings.autoScanEnabled ? '🟢 ACTIVE' : '🔴 STOPPED'}
✅ *RISK:* $${userSettings.riskPerTrade}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 *BOT FEATURES:*
• Real technical analysis (Max 85%)
• Manual pair selection
• Multiple timeframes (1m-4h)
• Auto-scan every 15 min (15m PRIMARY)
• Trade tracking with P&L
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Choose an option:`;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔍 MANUAL SCAN", callback_data: "menu_scan" }],
            [{ text: "🎯 SELECT PAIRS", callback_data: "menu_pairs" }, { text: "⏰ SELECT TIMEFRAME", callback_data: "menu_timeframe" }],
            [{ text: "🤖 AUTO-SCAN", callback_data: "menu_autoscan" }, { text: "📊 MY TRADES", callback_data: "menu_trades" }],
            [{ text: "💰 SET RISK", callback_data: "menu_risk" }, { text: "📈 STATUS", callback_data: "menu_status" }],
            [{ text: "❓ HELP", callback_data: "menu_help" }]
        ]
    };
    
    if (messageId) {
        await editMessage(menu, messageId, keyboard);
    } else {
        await sendMessage(menu, keyboard);
    }
}

// ============================================
// PAIR SELECTION INTERFACE
// ============================================
async function showPairSelection(page = 0, messageId = null) {
    const itemsPerPage = 10;
    const totalPages = Math.ceil(PAIRS.length / itemsPerPage);
    const start = page * itemsPerPage;
    const end = start + itemsPerPage;
    const currentPairs = PAIRS.slice(start, end);
    
    let menu = `*🎯 SELECT PAIRS TO MONITOR*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Selected: ${userSettings.selectedPairs.length}/${PAIRS.length}
Page ${page + 1}/${totalPages}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
*Tap to toggle:*\n`;
    
    const keyboard = { inline_keyboard: [] };
    
    for (const pair of currentPairs) {
        const isSelected = userSettings.selectedPairs.includes(pair);
        const emoji = isSelected ? '✅' : '⬜';
        keyboard.inline_keyboard.push([{ text: `${emoji} ${pair}`, callback_data: `toggle_pair_${pair}` }]);
    }
    
    const navButtons = [];
    if (page > 0) navButtons.push({ text: "◀️ PREV", callback_data: `pairs_page_${page - 1}` });
    if (page < totalPages - 1) navButtons.push({ text: "NEXT ▶️", callback_data: `pairs_page_${page + 1}` });
    if (navButtons.length > 0) keyboard.inline_keyboard.push(navButtons);
    
    keyboard.inline_keyboard.push([
        { text: "✅ SELECT ALL", callback_data: "pairs_select_all" },
        { text: "❌ CLEAR ALL", callback_data: "pairs_clear_all" }
    ]);
    keyboard.inline_keyboard.push([{ text: "🔙 BACK TO MENU", callback_data: "menu_main" }]);
    
    if (messageId) {
        await editMessage(menu, messageId, keyboard);
    } else {
        await sendMessage(menu, keyboard);
    }
}

// ============================================
// TIMEFRAME SELECTION INTERFACE
// ============================================
async function showTimeframeSelection(messageId = null) {
    let menu = `*⏰ SELECT TIMEFRAME*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Current: *${userSettings.selectedTimeframe}*
${userSettings.selectedTimeframe === PRIMARY_TF ? '⭐ PRIMARY (15m) recommended' : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
*Choose timeframe:*`;
    
    const keyboard = { inline_keyboard: [] };
    
    for (const tf of TIMEFRAMES) {
        const emoji = userSettings.selectedTimeframe === tf ? '✅' : '🔘';
        const star = tf === PRIMARY_TF ? ' ⭐' : '';
        keyboard.inline_keyboard.push([{ text: `${emoji} ${tf}${star}`, callback_data: `set_tf_${tf}` }]);
    }
    
    keyboard.inline_keyboard.push([{ text: "🔙 BACK TO MENU", callback_data: "menu_main" }]);
    
    if (messageId) {
        await editMessage(menu, messageId, keyboard);
    } else {
        await sendMessage(menu, keyboard);
    }
}

// ============================================
// AUTO-SCAN CONTROL INTERFACE
// ============================================
async function showAutoScanMenu(messageId = null) {
    const status = userSettings.autoScanEnabled ? "🟢 ACTIVE" : "🔴 STOPPED";
    const buttonText = userSettings.autoScanEnabled ? "⏸️ STOP AUTO-SCAN" : "▶️ START AUTO-SCAN";
    const buttonData = userSettings.autoScanEnabled ? "autoscan_stop" : "autoscan_start";
    
    let menu = `*🤖 AUTO-SCAN CONTROL*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Status: ${status}
Interval: 15 minutes
Primary Timeframe: ${PRIMARY_TF} ⭐
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When enabled, bot automatically scans
all selected pairs every 15 minutes
and sends signals when found.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: buttonText, callback_data: buttonData }],
            [{ text: "🔙 BACK TO MENU", callback_data: "menu_main" }]
        ]
    };
    
    if (messageId) {
        await editMessage(menu, messageId, keyboard);
    } else {
        await sendMessage(menu, keyboard);
    }
}

// ============================================
// TRADES INTERFACE
// ============================================
async function showTrades(messageId = null) {
    const totalTrades = trades.length;
    const wins = trades.filter(t => t.result === 'win').length;
    const losses = trades.filter(t => t.result === 'loss').length;
    const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0;
    const totalPnL = trades.reduce((sum, t) => sum + (t.result === 'win' ? t.profit : -t.loss), 0);
    
    let menu = `*📊 MY TRADES*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total Trades: ${totalTrades}
Wins: ${wins} | Losses: ${losses}
Win Rate: ${winRate}%
Total P&L: $${totalPnL.toFixed(2)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
*Recent Trades:*`;
    
    const recent = trades.slice(-5).reverse();
    for (const trade of recent) {
        const resultEmoji = trade.result === 'win' ? '✅' : '❌';
        menu += `\n\n${resultEmoji} *${trade.pair}* | ${trade.direction}\n`;
        menu += `   Risk: $${trade.risk} | ${trade.result === 'win' ? `Profit: +$${trade.profit}` : `Loss: -$${trade.loss}`}`;
    }
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🗑️ CLEAR HISTORY", callback_data: "trades_clear" }],
            [{ text: "🔙 BACK TO MENU", callback_data: "menu_main" }]
        ]
    };
    
    if (messageId) {
        await editMessage(menu, messageId, keyboard);
    } else {
        await sendMessage(menu, keyboard);
    }
}

// ============================================
// SIGNAL FORMATTING
// ============================================
function formatSignalMessage(signal, pair, timeframe, isAuto = false) {
    const arrow = signal.signal === 'CALL' ? '📈' : '📉';
    const direction = signal.signal === 'CALL' ? 'CALL (UP)' : 'PUT (DOWN)';
    
    let msg = `*${arrow} SIGNAL ${arrow}*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📊 *${pair}* | [${timeframe}]\n`;
    msg += `🎯 *${direction}* | Confidence: *${signal.confidence}%*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📈 *TECHNICAL ANALYSIS:*\n`;
    msg += `   RSI: ${signal.rsi} ${signal.rsi < 30 ? '(OVERSOLD 🔥)' : (signal.rsi > 70 ? '(OVERBOUGHT ❄️)' : '')}\n`;
    msg += `   ADX: ${signal.adx} ${signal.adx > 25 ? '(TRENDING 💪)' : '(SIDEWAYS 🔄)'}\n`;
    msg += `   Trend: ${signal.trend}\n`;
    msg += `   Volatility: ${signal.volatility}%\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `💡 *REASON:* ${signal.direction}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `⏱️ *Expiry:* ${signal.expiry} minutes\n`;
    msg += `🛡️ *SL:* ${signal.stopLoss} pips | *TP:* ${signal.takeProfit} pips\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `⚠️ *Risk Warning:* Never risk more than 2% per trade`;
    
    return msg;
}

// ============================================
// FETCH CANDLES FROM YAHOO
// ============================================
async function fetchCandles(symbol, interval) {
    return new Promise((resolve) => {
        let period1;
        switch(interval) {
            case '1m': period1 = Math.floor((Date.now() / 1000) - 86400); break;
            case '5m': period1 = Math.floor((Date.now() / 1000) - 259200); break;
            case '15m': period1 = Math.floor((Date.now() / 1000) - 604800); break;
            case '30m': period1 = Math.floor((Date.now() / 1000) - 1209600); break;
            case '1h': period1 = Math.floor((Date.now() / 1000) - 2592000); break;
            case '4h': period1 = Math.floor((Date.now() / 1000) - 8640000); break;
            default: period1 = Math.floor((Date.now() / 1000) - 604800);
        }
        const period2 = Math.floor(Date.now() / 1000);
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=${interval}`;
        
        const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (!json.chart?.result?.[0]) { resolve(null); return; }
                    const result = json.chart.result[0];
                    const quotes = result.indicators.quote[0];
                    if (!quotes || !quotes.open) { resolve(null); return; }
                    const candles = [];
                    for (let i = 0; i < result.timestamp.length; i++) {
                        if (quotes.open[i] && quotes.high[i] && quotes.low[i] && quotes.close[i]) {
                            candles.push({
                                open: quotes.open[i], high: quotes.high[i], low: quotes.low[i],
                                close: quotes.close[i], volume: quotes.volume[i] || 1000,
                                time: result.timestamp[i] * 1000
                            });
                        }
                    }
                    resolve(candles.length > 30 ? candles : null);
                } catch(e) { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(10000, () => { req.destroy(); resolve(null); });
        req.end();
    });
}

// ============================================
// SCAN FUNCTIONS
// ============================================
async function performScan(timeframe, isAuto = false) {
    if (isScanning) {
        if (!isAuto) await sendMessage("⏳ Scan already in progress...");
        return null;
    }
    isScanning = true;
    
    console.log(`\n🔍 ========== SCAN STARTED ==========`);
    console.log(`📊 Timeframe: ${timeframe} | Auto: ${isAuto}`);
    console.log(`📊 Pairs: ${userSettings.selectedPairs.length}`);
    
    if (!isAuto) await sendMessage(`🔍 Scanning ${userSettings.selectedPairs.length} pairs on [${timeframe}]...`);
    
    let signalsFound = 0;
    
    for (const pair of userSettings.selectedPairs) {
        try {
            const symbol = YAHOO_SYMBOLS[pair];
            if (!symbol) continue;
            
            const candles = await fetchCandles(symbol, timeframe);
            if (!candles) continue;
            
            const analysis = analyzeSignal(candles, pair, timeframe);
            if (analysis && analysis.signal !== 'NEUTRAL' && analysis.confidence >= 50) {
                signalsFound++;
                const msg = formatSignalMessage(analysis, pair, timeframe, isAuto);
                await sendMessage(msg);
                console.log(`🔔 SIGNAL: ${pair} - ${analysis.signal} @ ${analysis.confidence}%`);
                await new Promise(r => setTimeout(r, 500));
            }
        } catch(e) {
            console.log(`❌ Error: ${pair} - ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 200));
    }
    
    console.log(`✅ ========== SCAN COMPLETE ==========`);
    console.log(`📊 Signals found: ${signalsFound}`);
    
    if (!isAuto) {
        if (signalsFound === 0) {
            await sendMessage(`✅ Scan [${timeframe}] complete: No signals found`);
        } else {
            await sendMessage(`✅ Scan [${timeframe}] complete: ${signalsFound} signals found`);
        }
    }
    
    isScanning = false;
    return signalsFound;
}

async function autoScan() {
    if (!userSettings.autoScanEnabled) return;
    if (isScanning) return;
    
    console.log(`\n🔄 ========== AUTO-SCAN ==========`);
    console.log(`🕐 ${new Date().toLocaleTimeString()}`);
    console.log(`📊 Timeframe: ${PRIMARY_TF} (PRIMARY)`);
    
    let signalsFound = 0;
    
    for (const pair of userSettings.selectedPairs) {
        try {
            const symbol = YAHOO_SYMBOLS[pair];
            if (!symbol) continue;
            
            const candles = await fetchCandles(symbol, PRIMARY_TF);
            if (!candles) continue;
            
            const analysis = analyzeSignal(candles, pair, PRIMARY_TF);
            if (analysis && analysis.signal !== 'NEUTRAL' && analysis.confidence >= 55) {
                signalsFound++;
                const msg = formatSignalMessage(analysis, pair, PRIMARY_TF, true);
                await sendMessage(msg);
                console.log(`🔔 AUTO: ${pair} - ${analysis.signal} @ ${analysis.confidence}%`);
                await new Promise(r => setTimeout(r, 500));
            }
        } catch(e) {}
        await new Promise(r => setTimeout(r, 200));
    }
    
    console.log(`✅ AUTO-SCAN complete: ${signalsFound} signals`);
}

async function initialScan() {
    console.log('\n🚀 ========== INITIAL STARTUP SCAN ==========');
    console.log('📊 Running first scan on 15m PRIMARY timeframe...');
    await performScan(PRIMARY_TF, false);
    console.log('✅ Initial scan complete!');
}

// ============================================
// CALLBACK QUERY HANDLER
// ============================================
async function handleCallback(query) {
    const data = query.data;
    const messageId = query.message.message_id;
    const chatId = query.message.chat.id;
    
    if (chatId.toString() !== TELEGRAM_CHAT_ID) {
        await answerCallback(query.id, "Unauthorized", true);
        return;
    }
    
    // Main menu
    if (data === "menu_main") {
        await showMainMenu(messageId);
        await answerCallback(query.id, "Main menu");
    }
    else if (data === "menu_scan") {
        await answerCallback(query.id, "Starting manual scan...");
        await performScan(userSettings.selectedTimeframe, false);
        await showMainMenu(messageId);
    }
    else if (data === "menu_pairs") {
        await showPairSelection(0, messageId);
        await answerCallback(query.id, "Select pairs to monitor");
    }
    else if (data === "menu_timeframe") {
        await showTimeframeSelection(messageId);
        await answerCallback(query.id, "Select timeframe");
    }
    else if (data === "menu_autoscan") {
        await showAutoScanMenu(messageId);
        await answerCallback(query.id, "Auto-scan settings");
    }
    else if (data === "menu_trades") {
        await showTrades(messageId);
        await answerCallback(query.id, "Trade history");
    }
    else if (data === "menu_risk") {
        await answerCallback(query.id, `Current risk: $${userSettings.riskPerTrade}`, true);
    }
    else if (data === "menu_status") {
        const uptime = Math.floor((Date.now() - botStartTime) / 1000 / 60);
        const status = `📊 BOT STATUS\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nUptime: ${uptime} min\nPairs: ${userSettings.selectedPairs.length}/${PAIRS.length}\nTimeframe: ${userSettings.selectedTimeframe}\nAuto-scan: ${userSettings.autoScanEnabled ? 'ON' : 'OFF'}\nRisk: $${userSettings.riskPerTrade}\nData: Yahoo Finance LIVE`;
        await answerCallback(query.id, status, true);
    }
    else if (data === "menu_help") {
        const help = `📋 HELP\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n• MANUAL SCAN: Scans selected pairs\n• SELECT PAIRS: Choose which to monitor\n• TIMEFRAME: 1m,5m,15m,30m,1h,4h\n• AUTO-SCAN: Every 15 min on 15m\n• MY TRADES: Track your P&L\n• SIGNAL TRUST: Only trade 65%+ confidence\n• DATA: Yahoo Finance LIVE`;
        await answerCallback(query.id, help, true);
    }
    // Pair selection
    else if (data.startsWith("toggle_pair_")) {
        const pair = data.replace("toggle_pair_", "");
        if (userSettings.selectedPairs.includes(pair)) {
            userSettings.selectedPairs = userSettings.selectedPairs.filter(p => p !== pair);
            await answerCallback(query.id, `Removed ${pair}`);
        } else {
            userSettings.selectedPairs.push(pair);
            await answerCallback(query.id, `Added ${pair}`);
        }
        await showPairSelection(0, messageId);
    }
    else if (data.startsWith("pairs_page_")) {
        const page = parseInt(data.replace("pairs_page_", ""));
        await showPairSelection(page, messageId);
        await answerCallback(query.id, `Page ${page + 1}`);
    }
    else if (data === "pairs_select_all") {
        userSettings.selectedPairs = [...PAIRS];
        await answerCallback(query.id, `Selected all ${PAIRS.length} pairs`);
        await showPairSelection(0, messageId);
    }
    else if (data === "pairs_clear_all") {
        userSettings.selectedPairs = [];
        await answerCallback(query.id, "Cleared all pairs");
        await showPairSelection(0, messageId);
    }
    // Timeframe selection
    else if (data.startsWith("set_tf_")) {
        const tf = data.replace("set_tf_", "");
        userSettings.selectedTimeframe = tf;
        await answerCallback(query.id, `Timeframe set to ${tf}`);
        await showTimeframeSelection(messageId);
    }
    // Auto-scan
    else if (data === "autoscan_start") {
        if (autoScanInterval) clearInterval(autoScanInterval);
        userSettings.autoScanEnabled = true;
        autoScanInterval = setInterval(autoScan, 15 * 60 * 1000);
        await answerCallback(query.id, "Auto-scan STARTED (every 15 min on 15m PRIMARY)");
        await showAutoScanMenu(messageId);
        await autoScan();
    }
    else if (data === "autoscan_stop") {
        if (autoScanInterval) clearInterval(autoScanInterval);
        autoScanInterval = null;
        userSettings.autoScanEnabled = false;
        await answerCallback(query.id, "Auto-scan STOPPED");
        await showAutoScanMenu(messageId);
    }
    // Trades
    else if (data === "trades_clear") {
        trades = [];
        fs.writeFileSync('./trades.json', JSON.stringify(trades, null, 2));
        await answerCallback(query.id, "Trade history cleared");
        await showTrades(messageId);
    }
    else {
        await answerCallback(query.id, "Option not available", true);
    }
}

// ============================================
// TELEGRAM POLLING (getUpdates)
// ============================================
async function pollTelegram() {
    if (!TELEGRAM_TOKEN) {
        console.log('❌ No TELEGRAM_TOKEN');
        return;
    }
    
    console.log('📡 Starting Telegram polling (getUpdates)...');
    console.log('💡 Send /start to your bot to see the interface!');
    
    const poll = async () => {
        try {
            const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`;
            
            const req = https.get(url, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', async () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.ok && json.result) {
                            for (const update of json.result) {
                                lastUpdateId = update.update_id;
                                
                                // Handle text commands
                                if (update.message && update.message.text) {
                                    const text = update.message.text;
                                    const chatId = update.message.chat.id;
                                    
                                    if (chatId.toString() !== TELEGRAM_CHAT_ID) continue;
                                    
                                    if (text === '/start') {
                                        await showMainMenu();
                                    } else if (text === '/status') {
                                        const uptime = Math.floor((Date.now() - botStartTime) / 1000 / 60);
                                        await sendMessage(`📊 *BOT STATUS*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nUptime: ${uptime} minutes\nPairs: ${userSettings.selectedPairs.length}/${PAIRS.length}\nAuto-scan: ${userSettings.autoScanEnabled ? 'ON' : 'OFF'}\nData: Yahoo Finance LIVE`);
                                    } else if (text === '/scan') {
                                        await performScan(userSettings.selectedTimeframe, false);
                                    } else if (text === '/help') {
                                        await sendMessage(`📋 *COMMANDS*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n/start - Show main menu\n/status - Bot status\n/scan - Manual scan\n/help - This menu`);
                                    } else {
                                        await sendMessage(`❌ Unknown command. Send /start for menu.`);
                                    }
                                }
                                
                                // Handle button clicks
                                if (update.callback_query) {
                                    await handleCallback(update.callback_query);
                                }
                            }
                        }
                    } catch(e) {
                        console.log(`Polling parse error: ${e.message}`);
                    }
                    setTimeout(poll, 2000);
                });
            });
            
            req.on('error', (e) => {
                console.log(`Polling error: ${e.message}`);
                setTimeout(poll, 5000);
            });
            req.end();
        } catch(e) {
            console.log(`Polling exception: ${e.message}`);
            setTimeout(poll, 5000);
        }
    };
    
    poll();
}

// ============================================
// STARTUP
// ============================================
console.log('\n' + '█'.repeat(60));
console.log('🏆 OMNI_POCKET_BOT v4.0');
console.log('█'.repeat(60));
console.log(`Data Source: YAHOO FINANCE (LIVE)`);
console.log(`Pairs: ${PAIRS.length}`);
console.log(`Timeframes: ${TIMEFRAMES.join(', ')}`);
console.log(`Primary: ${PRIMARY_TF} ⭐`);
console.log(`Telegram Token: ${TELEGRAM_TOKEN ? '✅ SET' : '❌ MISSING'}`);
console.log(`Telegram Chat ID: ${TELEGRAM_CHAT_ID ? '✅ SET' : '❌ MISSING'}`);
console.log('█'.repeat(60) + '\n');

// Start bot
async function startBot() {
    // Delete webhook first
    await deleteWebhook();
    
    if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
        // Start polling
        pollTelegram();
        
        // Send startup message
        setTimeout(async () => {
            await sendMessage(`🤖 *OMNI_POCKET_BOT v4.0 ONLINE* 🤖
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ DATA: YAHOO FINANCE (LIVE)
✅ PAIRS: ${PAIRS.length}
✅ AUTO-SCAN: 15m (every 15 min)
✅ INTERFACE: BUTTONS ENABLED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📱 *Tap /start to see the menu with buttons!*`);
        }, 3000);
        
        // Start auto-scan after 15 seconds
        setTimeout(async () => {
            console.log('📊 Starting auto-scan...');
            await initialScan();
            startAutoScan();
        }, 15000);
    } else {
        console.log('\n⚠️ TELEGRAM NOT CONFIGURED!');
        console.log('Add these environment variables in Railway:');
        console.log('  TELEGRAM_BOT_TOKEN = your_bot_token');
        console.log('  TELEGRAM_CHAT_ID = your_chat_id\n');
    }
}

function startAutoScan() {
    if (autoScanInterval) clearInterval(autoScanInterval);
    autoScanInterval = setInterval(autoScan, 15 * 60 * 1000);
    console.log('🤖 Auto-scan started (every 15 minutes)');
}

startBot();

// Keep alive
setInterval(() => {
    const uptime = Math.floor((Date.now() - botStartTime) / 1000 / 60);
    console.log(`💓 Alive | Uptime: ${uptime}m | Data: Yahoo LIVE | Auto-scan: ${userSettings.autoScanEnabled ? 'ON' : 'OFF'}`);
}, 60000);
