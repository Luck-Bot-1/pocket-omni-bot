// ============================================
// OMNI_POCKET_BOT - WITH WORKING MENU
// ============================================

const { analyzeSignal } = require('./analyzer.js');
const https = require('https');
const fs = require('fs');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const PAIRS = [
    { name: 'EUR/USD', symbol: 'EURUSD=X' },
    { name: 'GBP/USD', symbol: 'GBPUSD=X' },
    { name: 'AUD/USD', symbol: 'AUDUSD=X' },
    { name: 'NZD/USD', symbol: 'NZDUSD=X' },
    { name: 'USD/CAD', symbol: 'USDCAD=X' },
    { name: 'USD/CHF', symbol: 'USDCHF=X' },
    { name: 'USD/JPY', symbol: 'USDJPY=X' },
    { name: 'AUD/CAD', symbol: 'AUDCAD=X' },
    { name: 'AUD/JPY', symbol: 'AUDJPY=X' },
    { name: 'CAD/JPY', symbol: 'CADJPY=X' },
    { name: 'CHF/JPY', symbol: 'CHFJPY=X' },
    { name: 'EUR/AUD', symbol: 'EURAUD=X' },
    { name: 'EUR/CAD', symbol: 'EURCAD=X' },
    { name: 'EUR/CHF', symbol: 'EURCHF=X' },
    { name: 'EUR/GBP', symbol: 'EURGBP=X' },
    { name: 'EUR/JPY', symbol: 'EURJPY=X' },
    { name: 'EUR/NZD', symbol: 'EURNZD=X' },
    { name: 'GBP/AUD', symbol: 'GBPAUD=X' },
    { name: 'GBP/CAD', symbol: 'GBPCAD=X' },
    { name: 'GBP/CHF', symbol: 'GBPCHF=X' },
    { name: 'GBP/JPY', symbol: 'GBPJPY=X' },
    { name: 'GBP/NZD', symbol: 'GBPNZD=X' },
    { name: 'NZD/CAD', symbol: 'NZDCAD=X' },
    { name: 'NZD/JPY', symbol: 'NZDJPY=X' },
    { name: 'AUD/NZD', symbol: 'AUDNZD=X' },
    { name: 'CAD/CHF', symbol: 'CADCHF=X' },
    { name: 'AUD/CHF', symbol: 'AUDCHF=X' }
];

const MIN_CONFIDENCE = 55;
let lastUpdateId = 0;
let botStartTime = Date.now();
let isScanning = false;

function sendTelegramMessage(text) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return false;
    
    const data = JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: "",
        disable_web_page_preview: true
    });
    
    const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    });
    
    req.on('error', (e) => console.log(`❌ Error: ${e.message}`));
    req.write(data);
    req.end();
    return true;
}

// ============================================
// WORKING MENU COMMANDS
// ============================================
function showMainMenu() {
    const menu = `🏆 <b>OMNI_POCKET_BOT MAIN MENU</b> 🏆
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 <b>BOT STATUS</b>
✅ ONLINE | 27 PAIRS
🔄 15m AUTO-SCAN
📈 MIN CONF: 55%

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔘 <b>TRADING COMMANDS</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
/scan → Manual scan (15m)
/scan5m → Manual scan (5m)
/scan1h → Manual scan (1h)
/status → Bot status
/help → All commands

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 <b>SIGNAL EXPLANATION</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CALL ↑ = BUY (Price will go UP)
PUT ↓ = SELL (Price will go DOWN)
Confidence % = Signal strength
Expiry = Option duration in minutes
SL = Stop Loss in pips
TP = Take Profit in pips

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ <b>IMPORTANT</b>
This is a SIGNAL-ONLY bot.
You must manually execute trades on Pocket Option.

Send /help for complete command list`;
    
    sendTelegramMessage(menu);
}

function showHelp() {
    const help = `📋 <b>COMPLETE COMMAND LIST</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

<b>📊 STATUS COMMANDS</b>
/start or /menu → Show main menu
/status → Bot status and uptime
/help → This help screen

<b>🔍 MANUAL SCAN COMMANDS</b>
/scan → Scan all 27 pairs on 15m
/scan5m → Scan all pairs on 5m
/scan1h → Scan all pairs on 1h

<b>🤖 AUTO-SCAN</b>
Auto-scan runs EVERY 15 MINUTES
No command needed - fully automatic

<b>📊 HOW TO READ SIGNALS</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Example: 🤖 📈 EUR/USD CALL ↑ | 87%
RSI:32.5 ADX:28.0 UPTREND
Exp:15min SL:12.5 TP:25.0

MEANING:
• CALL ↑ = Price expected to go UP
• 87% = Signal confidence
• RSI 32.5 = Oversold (bullish)
• ADX 28.0 = Weak trend
• UPTREND = Market direction
• Exp:15min = Trade duration
• SL:12.5 = Stop loss pips
• TP:25.0 = Take profit pips

<b>⚠️ DISCLAIMER</b>
This bot provides signals ONLY.
You MUST manually execute trades on Pocket Option.
Past performance does not guarantee future results.

Send /menu to return to main menu`;
    
    sendTelegramMessage(help);
}

function showStatus() {
    const uptimeMin = Math.floor((Date.now() - botStartTime) / 1000 / 60);
    const uptimeHours = Math.floor(uptimeMin / 60);
    const uptimeRemainMin = uptimeMin % 60;
    
    const status = `📊 <b>OMNI_POCKET_BOT STATUS</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⏱️ <b>UPTIME:</b> ${uptimeHours}h ${uptimeRemainMin}m
📡 <b>DATA:</b> Yahoo Finance (LIVE)
👥 <b>PAIRS:</b> 27 FOREX PAIRS
🔄 <b>AUTO-SCAN:</b> 15 MINUTE (active)
📈 <b>MIN CONFIDENCE:</b> 55%
🟢 <b>STATUS:</b> OPERATIONAL

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>LAST ACTIVITY:</b>
• Auto-scan runs every 15 min
• Signals appear automatically
• Manual scan available via /scan

Send /menu for main menu`;
    
    sendTelegramMessage(status);
}

// ============================================
// SHORT SIGNAL FORMAT
// ============================================
function formatShortSignal(analysis, pairName, isAuto = false) {
    const arrow = analysis.signal === 'CALL' ? '📈' : '📉';
    const direction = analysis.signal === 'CALL' ? 'CALL ↑' : 'PUT ↓';
    
    let msg = '';
    if (isAuto) {
        msg = `🤖 ${arrow} ${pairName} ${direction} | ${analysis.confidence}%\n`;
    } else {
        msg = `${arrow} ${pairName} ${direction} | ${analysis.confidence}%\n`;
    }
    msg += `RSI:${analysis.rsi} ADX:${analysis.adx} ${analysis.trendDirection}\n`;
    msg += `Exp:${analysis.expiry}min SL:${analysis.stopLossPips} TP:${analysis.takeProfitPips}`;
    
    return msg;
}

// ============================================
// YAHOO FINANCE FETCHER
// ============================================
async function fetchYahooFinance(symbol, interval = '15m') {
    return new Promise((resolve) => {
        let period1 = Math.floor((Date.now() / 1000) - (7 * 24 * 60 * 60));
        const period2 = Math.floor(Date.now() / 1000);
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=${interval}`;
        
        const request = https.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        }, (res) => {
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
                    resolve(candles.length > 0 ? { values: candles } : null);
                } catch(e) { resolve(null); }
            });
        });
        request.on('error', () => { resolve(null); });
        request.setTimeout(10000, () => { request.destroy(); resolve(null); });
    });
}

async function analyzePair(pair, timeframe = '15min') {
    try {
        const data = await fetchYahooFinance(pair.symbol, '15m');
        if (!data || !data.values || data.values.length < 30) return null;
        const analysis = await analyzeSignal(data, { pairName: pair.name }, timeframe);
        return analysis;
    } catch(e) { return null; }
}

// ============================================
// AUTO SCAN
// ============================================
async function autoScan15m() {
    if (isScanning) return;
    isScanning = true;
    
    console.log(`\n🔄 Auto-scan - ${new Date().toLocaleTimeString()}`);
    
    let signalsFound = 0;
    
    for (const pair of PAIRS) {
        const analysis = await analyzePair(pair, '15min');
        if (analysis && analysis.confidence >= MIN_CONFIDENCE && analysis.signal !== 'NEUTRAL') {
            signalsFound++;
            const msg = formatShortSignal(analysis, pair.name, true);
            sendTelegramMessage(msg);
            console.log(`🔔 ${pair.name} - ${analysis.signal} @ ${analysis.confidence}%`);
            await new Promise(r => setTimeout(r, 500));
        }
        await new Promise(r => setTimeout(r, 300));
    }
    
    if (signalsFound > 0) {
        sendTelegramMessage(`✅ Auto-scan complete: ${signalsFound} signals found`);
    }
    console.log(`✅ Auto-scan done: ${signalsFound} signals`);
    isScanning = false;
}

// ============================================
// MANUAL SCAN
// ============================================
async function manualScan(timeframe = '15min') {
    if (isScanning) {
        sendTelegramMessage("⏳ Scan already in progress...");
        return;
    }
    isScanning = true;
    
    const tfName = timeframe === '15min' ? '15m' : timeframe === '5min' ? '5m' : '1h';
    sendTelegramMessage(`🔍 Manual scan [${tfName}] started...`);
    
    let signals = 0;
    for (const pair of PAIRS) {
        const analysis = await analyzePair(pair, timeframe);
        if (analysis && analysis.confidence >= MIN_CONFIDENCE && analysis.signal !== 'NEUTRAL') {
            signals++;
            const msg = formatShortSignal(analysis, pair.name, false);
            sendTelegramMessage(msg);
            await new Promise(r => setTimeout(r, 500));
        }
        await new Promise(r => setTimeout(r, 300));
    }
    
    sendTelegramMessage(`✅ Manual scan [${tfName}] complete: ${signals} signals found`);
    isScanning = false;
}

// ============================================
// COMMAND HANDLER - ALL COMMANDS WORKING
// ============================================
function handleCommand(text) {
    console.log(`📥 Command: ${text}`);
    const cmd = text.toLowerCase().trim();
    
    // Main menu commands
    if (cmd === '/start' || cmd === '/menu') {
        showMainMenu();
    }
    else if (cmd === '/help') {
        showHelp();
    }
    else if (cmd === '/status') {
        showStatus();
    }
    // Scan commands
    else if (cmd === '/scan') {
        manualScan('15min');
    }
    else if (cmd === '/scan5m') {
        manualScan('5min');
    }
    else if (cmd === '/scan1h') {
        manualScan('1h');
    }
    else {
        sendTelegramMessage(`❌ Unknown command: ${text}

Type /menu to see all available commands.

Available commands:
/start or /menu - Main menu
/status - Bot status
/scan - Manual scan (15m)
/scan5m - Manual scan (5m)
/scan1h - Manual scan (1h)
/help - Complete help`);
    }
}

// ============================================
// TELEGRAM POLLING
// ============================================
function pollTelegram() {
    if (!TELEGRAM_TOKEN) {
        console.log('❌ No TELEGRAM_TOKEN');
        return;
    }
    
    console.log('📡 Polling started. Send /start to your bot!');
    
    const poll = () => {
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`;
        
        const req = https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.ok && json.result) {
                        for (const update of json.result) {
                            lastUpdateId = update.update_id;
                            const msgText = update.message?.text;
                            const chatId = update.message?.chat?.id;
                            
                            if (chatId && TELEGRAM_CHAT_ID && chatId.toString() !== TELEGRAM_CHAT_ID) {
                                continue;
                            }
                            
                            if (msgText) {
                                handleCommand(msgText);
                            }
                        }
                    }
                } catch(e) {}
                setTimeout(poll, 2000);
            });
        });
        req.on('error', () => setTimeout(poll, 5000));
        req.end();
    };
    poll();
}

// ============================================
// START
// ============================================
console.log('\n' + '█'.repeat(60));
console.log('🏆 OMNI_POCKET_BOT');
console.log('█'.repeat(60));
console.log(`Pairs: ${PAIRS.length}`);
console.log(`Auto-scan: 15m`);
console.log(`Commands: /start, /menu, /status, /scan, /help`);
console.log('█'.repeat(60) + '\n');

if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    console.log('✅ Telegram configured');
    pollTelegram();
    
    setTimeout(() => {
        sendTelegramMessage(`🤖 OMNI_POCKET_BOT ONLINE 🤖

✅ Bot is ready!
✅ Type /start or /menu to begin
✅ Auto-scan runs every 15 minutes`);
    }, 3000);
} else {
    console.log('❌ Telegram NOT configured');
}

// Start auto-scan
setTimeout(() => {
    console.log('📊 Starting auto-scan...');
    autoScan15m();
    setInterval(autoScan15m, 15 * 60 * 1000);
}, 15000);

setInterval(() => {
    const uptimeMin = Math.floor((Date.now() - botStartTime) / 1000 / 60);
    console.log(`💓 Alive | Uptime: ${uptimeMin}m`);
}, 60000);
