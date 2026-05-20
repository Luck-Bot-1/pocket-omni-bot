// ============================================
// OMNI_POCKET_BOT v26.0 - WITH RSI OVERRIDE
// FIXES CONTRADICTORY SIGNALS
// ============================================

const { analyzeSignal } = require('./analyzer.js');
const https = require('https');
const fs = require('fs');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const PAIRS = [
    'EUR/USD', 'GBP/USD', 'AUD/USD', 'NZD/USD', 'USD/CAD', 'USD/CHF', 'USD/JPY',
    'AUD/CAD', 'AUD/JPY', 'CAD/JPY', 'CHF/JPY', 'EUR/AUD', 'EUR/CAD', 'EUR/CHF',
    'EUR/GBP', 'EUR/JPY', 'EUR/NZD', 'GBP/AUD', 'GBP/CAD', 'GBP/CHF', 'GBP/JPY',
    'GBP/NZD', 'NZD/CAD', 'NZD/JPY', 'AUD/NZD', 'CAD/CHF', 'AUD/CHF'
];

const SYMBOLS = {
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

const MIN_CONFIDENCE = 65;
const DELAY_MS = 500;

let lastUpdateId = 0;
let botStartTime = Date.now();
let isScanning = false;
let autoScanInterval = null;

function sendMessage(text) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log(`\n⚠️ TELEGRAM NOT CONFIGURED\n${text}\n`);
        return false;
    }
    
    let msg = text;
    if (msg.length > 4000) msg = msg.substring(0, 3950) + "\n\n... (truncated)";
    
    const data = JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: "",
        disable_web_page_preview: true
    });
    
    const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
    });
    
    req.on('error', (e) => console.log(`❌ Send error: ${e.message}`));
    req.write(data);
    req.end();
    return true;
}

// ============================================
// FIXED SIGNAL FORMAT WITH RSI VALIDATION
// ============================================
function formatSignal(pair, analysis, isAuto) {
    // CRITICAL FIX: Override contradictory signals
    let signal = analysis.signal;
    let confidence = analysis.confidence;
    let rsi = parseFloat(analysis.rsi);
    let override = false;
    
    // RSI Override Logic
    if (signal === 'CALL' && rsi > 70) {
        signal = 'PUT';
        confidence = Math.min(confidence, 70);
        override = true;
        console.log(`⚠️ RSI OVERRIDE: ${pair} CALL→PUT (RSI=${rsi} >70)`);
    } else if (signal === 'PUT' && rsi < 30) {
        signal = 'CALL';
        confidence = Math.min(confidence, 70);
        override = true;
        console.log(`⚠️ RSI OVERRIDE: ${pair} PUT→CALL (RSI=${rsi} <30)`);
    }
    
    const arrow = signal === 'CALL' ? '📈' : '📉';
    const direction = signal === 'CALL' ? 'CALL (UP)' : 'PUT (DOWN)';
    const overrideMark = override ? ' 🔄(RSI FIXED)' : '';
    
    let msg = '';
    if (isAuto) {
        msg = `🤖 AUTO [15m] ${arrow} ${pair}${overrideMark}\n`;
    } else {
        msg = `${arrow} SIGNAL: ${pair}${overrideMark}\n`;
    }
    msg += `🎯 ${direction} | ${confidence}%\n`;
    msg += `📊 RSI:${analysis.rsi} ADX:${analysis.adx} Trend:${analysis.trendDirection}\n`;
    
    // Add RSI interpretation
    if (rsi > 70) msg += `⚠️ RSI OVERBOUGHT (${rsi}) → Expected DOWN\n`;
    else if (rsi < 30) msg += `⚠️ RSI OVERSOLD (${rsi}) → Expected UP\n`;
    
    msg += `⏱️ Expiry:${analysis.expiry}min SL:${analysis.stopLossPips} TP:${analysis.takeProfitPips}\n`;
    
    return msg;
}

async function fetchCandles(pairName, interval = '15m') {
    return new Promise((resolve) => {
        const symbol = SYMBOLS[pairName];
        if (!symbol) { resolve(null); return; }
        
        let period1;
        switch(interval) {
            case '1m': period1 = Math.floor((Date.now() / 1000) - 86400); break;
            case '5m': period1 = Math.floor((Date.now() / 1000) - 259200); break;
            case '15m': period1 = Math.floor((Date.now() / 1000) - 604800); break;
            case '30m': period1 = Math.floor((Date.now() / 1000) - 1209600); break;
            case '1h': period1 = Math.floor((Date.now() / 1000) - 2592000); break;
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
                    resolve(candles.length > 30 ? { values: candles } : null);
                } catch(e) { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(10000, () => { req.destroy(); resolve(null); });
        req.end();
    });
}

async function analyzePair(pairName, timeframe) {
    try {
        const candles = await fetchCandles(pairName, timeframe);
        if (!candles) return null;
        const analysis = await analyzeSignal(candles, { pairName }, timeframe);
        
        // Log each analysis for debugging
        console.log(`📊 ${pairName}: ${analysis.signal} @ ${analysis.confidence}% | RSI:${analysis.rsi} ADX:${analysis.adx} Trend:${analysis.trendDirection}`);
        
        return analysis;
    } catch(e) {
        console.log(`❌ Error analyzing ${pairName}: ${e.message}`);
        return null;
    }
}

// ============================================
// AUTO SCAN WITH DETAILED LOGGING
// ============================================
async function autoScan() {
    if (isScanning) return;
    isScanning = true;
    
    const startTime = new Date();
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🔄 AUTO-SCAN STARTED - ${startTime.toLocaleTimeString()}`);
    console.log(`📊 Scanning ${PAIRS.length} pairs on 15m timeframe`);
    console.log(`${'═'.repeat(60)}`);
    
    let signals = [];
    for (const pair of PAIRS) {
        const analysis = await analyzePair(pair, '15m');
        if (analysis && analysis.confidence >= MIN_CONFIDENCE && analysis.signal !== 'NEUTRAL') {
            signals.push({ pair, analysis });
            const msg = formatSignal(pair, analysis, true);
            sendMessage(msg);
            console.log(`🔔 SIGNAL: ${pair} - ${analysis.signal} @ ${analysis.confidence}% (RSI:${analysis.rsi} ADX:${analysis.adx})`);
            await new Promise(r => setTimeout(r, 500));
        }
        await new Promise(r => setTimeout(r, DELAY_MS));
    }
    
    const endTime = new Date();
    const duration = (endTime - startTime) / 1000;
    
    console.log(`${'═'.repeat(60)}`);
    console.log(`✅ AUTO-SCAN COMPLETE - ${duration.toFixed(1)} seconds`);
    console.log(`📊 Found ${signals.length} signals above ${MIN_CONFIDENCE}%`);
    console.log(`${'═'.repeat(60)}\n`);
    
    if (signals.length === 0) {
        sendMessage(`✅ Auto-scan complete: No signals above ${MIN_CONFIDENCE}%`);
    } else {
        sendMessage(`✅ Auto-scan complete: ${signals.length} signals found`);
    }
    isScanning = false;
}

// ============================================
// MANUAL SCAN WITH DETAILED LOGGING
// ============================================
async function scanAll(timeframe = '15m') {
    if (isScanning) {
        sendMessage("⏳ Scan already running...");
        return;
    }
    isScanning = true;
    
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🔍 MANUAL SCAN STARTED - ${new Date().toLocaleTimeString()}`);
    console.log(`📊 Timeframe: ${timeframe} | Pairs: ${PAIRS.length}`);
    console.log(`${'═'.repeat(60)}`);
    
    sendMessage(`🔍 Manual scan [${timeframe}] started...`);
    
    let signals = 0;
    for (const pair of PAIRS) {
        const analysis = await analyzePair(pair, timeframe);
        if (analysis && analysis.confidence >= MIN_CONFIDENCE && analysis.signal !== 'NEUTRAL') {
            signals++;
            const msg = formatSignal(pair, analysis, false);
            sendMessage(msg);
            console.log(`🔔 SIGNAL: ${pair} - ${analysis.signal} @ ${analysis.confidence}%`);
            await new Promise(r => setTimeout(r, 500));
        }
        await new Promise(r => setTimeout(r, DELAY_MS));
    }
    
    console.log(`${'═'.repeat(60)}`);
    console.log(`✅ MANUAL SCAN COMPLETE - ${signals} signals found`);
    console.log(`${'═'.repeat(60)}\n`);
    
    sendMessage(`✅ Scan [${timeframe}] complete: ${signals} signals found`);
    isScanning = false;
}

// ============================================
// COMMAND HANDLER
// ============================================
function handleCommand(text) {
    console.log(`📥 Command: ${text}`);
    const cmd = text.toLowerCase().trim();
    
    if (cmd === '/start' || cmd === '/menu') {
        sendMessage(`🏆 OMNI_POCKET_BOT v26.0 🏆
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ ONLINE | ${PAIRS.length} PAIRS
✅ AUTO-SCAN: 15m (every 15 min)
✅ MIN CONFIDENCE: ${MIN_CONFIDENCE}%
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 COMMANDS:
/status - Bot status
/scan - Manual scan (15m)
/scan5m - Manual scan (5m)
/scan1h - Manual scan (1h)
/start_auto - Start auto-scan
/stop_auto - Stop auto-scan
/help - All commands
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔧 FIXES IN v26.0:
✅ RSI Override: CALL when RSI<30
✅ RSI Override: PUT when RSI>70
✅ Detailed scan logs in console
✅ No more contradictory signals`);
    }
    else if (cmd === '/help') {
        sendMessage(`📋 COMMANDS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
/start or /menu - Main menu
/status - Bot status
/scan - Manual scan (15m)
/scan5m - Manual scan (5m)
/scan1h - Manual scan (1h)
/start_auto - Start 15m auto-scan
/stop_auto - Stop auto-scan
/help - This menu
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 SIGNAL RULES:
RSI <30 (OVERSOLD) → CALL (UP)
RSI >70 (OVERBOUGHT) → PUT (DOWN)
ADX >25 → STRONG TREND (GOOD)
ADX <20 → WEAK TREND (SKIP)`);
    }
    else if (cmd === '/status') {
        const uptime = Math.floor((Date.now() - botStartTime) / 1000 / 60);
        const autoRunning = autoScanInterval ? "🟢 RUNNING" : "🔴 STOPPED";
        sendMessage(`📊 BOT STATUS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Uptime: ${uptime} minutes
Pairs: ${PAIRS.length}
Auto-scan: ${autoRunning}
Min Confidence: ${MIN_CONFIDENCE}%
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Operational with RSI Override`);
    }
    else if (cmd === '/scan') {
        scanAll('15m');
    }
    else if (cmd === '/scan5m') {
        scanAll('5m');
    }
    else if (cmd === '/scan1h') {
        scanAll('1h');
    }
    else if (cmd === '/start_auto') {
        if (autoScanInterval) {
            sendMessage("⚠️ Auto-scan already running");
            return;
        }
        autoScanInterval = setInterval(autoScan, 15 * 60 * 1000);
        sendMessage("✅ Auto-scan STARTED (every 15 minutes)");
        console.log("🚀 Auto-scan started");
        autoScan(); // Run immediately
    }
    else if (cmd === '/stop_auto') {
        if (autoScanInterval) {
            clearInterval(autoScanInterval);
            autoScanInterval = null;
            sendMessage("⏸️ Auto-scan STOPPED");
            console.log("🛑 Auto-scan stopped");
        } else {
            sendMessage("⚠️ No auto-scan running");
        }
    }
    else {
        sendMessage(`❌ Unknown: ${text}\nType /help for commands`);
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
                            if (msgText) handleCommand(msgText);
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
// STARTUP
// ============================================
console.log('\n' + '█'.repeat(60));
console.log('🏆 OMNI_POCKET_BOT v26.0');
console.log('█'.repeat(60));
console.log(`Pairs: ${PAIRS.length}`);
console.log(`Min Confidence: ${MIN_CONFIDENCE}%`);
console.log(`Auto-scan: 15m`);
console.log(`RSI Override: ENABLED (RSI<30→CALL, RSI>70→PUT)`);
console.log('█'.repeat(60) + '\n');

if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    console.log('✅ Telegram configured');
    pollTelegram();
    
    setTimeout(() => {
        sendMessage(`🤖 OMNI_POCKET_BOT v26.0 ONLINE 🤖

✅ ${PAIRS.length} PAIRS | 15m AUTO-SCAN
✅ RSI OVERRIDE ENABLED
✅ No more contradictory signals

RSI <30 → CALL (UP)
RSI >70 → PUT (DOWN)

Send /start for menu`);
    }, 3000);
} else {
    console.log('❌ Telegram NOT configured!');
    console.log('Add env vars: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
}

// Start auto-scan
setTimeout(() => {
    console.log('📊 Starting auto-scan...');
    autoScanInterval = setInterval(autoScan, 15 * 60 * 1000);
    autoScan();
}, 15000);

setInterval(() => {
    const uptime = Math.floor((Date.now() - botStartTime) / 1000 / 60);
    console.log(`💓 Alive | Uptime: ${uptime}m`);
}, 60000);
