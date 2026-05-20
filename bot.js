// ============================================
// OMNI_POCKET_BOT - ULTRA SHORT VERSION
// TELEGRAM OPTIMIZED - NO ERROR 400
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
const DELAY_BETWEEN_PAIRS_MS = 300;

let lastUpdateId = 0;
let botStartTime = Date.now();
let isScanning = false;

// ============================================
// SIMPLE TELEGRAM SEND
// ============================================
function sendTelegramMessage(text) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return false;
    
    // Keep messages under 200 chars to avoid error 400
    let messageText = text;
    if (messageText.length > 200) {
        messageText = messageText.substring(0, 180) + "...";
    }
    
    const data = JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: messageText,
        parse_mode: "",
        disable_web_page_preview: true
    });
    
    const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, (res) => {
        let responseData = '';
        res.on('data', chunk => responseData += chunk);
        res.on('end', () => {
            if (res.statusCode === 200) {
                console.log('✅ Sent');
            } else {
                console.log(`❌ Error: ${res.statusCode}`);
            }
        });
    });
    
    req.on('error', (e) => console.log(`❌ Failed: ${e.message}`));
    req.write(data);
    req.end();
    return true;
}

// ============================================
// SUPER SHORT SIGNAL FORMAT (UNDER 200 CHARS)
// ============================================
function formatShortSignal(analysis, pairName, isAuto = false) {
    const arrow = analysis.signal === 'CALL' ? '📈' : '📉';
    const direction = analysis.signal === 'CALL' ? 'CALL ↑' : 'PUT ↓';
    
    // Ultra short format - guaranteed under 200 chars
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
// AUTO SCAN 15M
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
        await new Promise(r => setTimeout(r, DELAY_BETWEEN_PAIRS_MS));
    }
    
    if (signalsFound > 0) {
        sendTelegramMessage(`✅ Scan done: ${signalsFound} signals`);
    }
    console.log(`✅ Auto-scan done: ${signalsFound} signals`);
    isScanning = false;
}

// ============================================
// COMMAND HANDLER
// ============================================
function handleCommand(text) {
    console.log(`📥 Command: ${text}`);
    const cmd = text.toLowerCase().trim();
    
    if (cmd === '/start') {
        sendTelegramMessage(`🏆 OMNI_POCKET_BOT 🏆
✅ ONLINE | 27 PAIRS
🔄 15m AUTO-SCAN
📊 MIN CONF: 55%
━━━━━━━━━━━━━━━━
COMMANDS:
/status - Bot status
/scan - Manual scan
/help - Commands`);
    }
    else if (cmd === '/status') {
        const uptimeMin = Math.floor((Date.now() - botStartTime) / 1000 / 60);
        sendTelegramMessage(`📊 STATUS
Uptime: ${uptimeMin}m
Pairs: 27
Auto-scan: 15m ACTIVE
✅ Operational`);
    }
    else if (cmd === '/scan') {
        if (isScanning) {
            sendTelegramMessage("⏳ Scan in progress...");
            return;
        }
        sendTelegramMessage("🔍 Scanning 27 pairs on 15m...");
        manualScan();
    }
    else if (cmd === '/help') {
        sendTelegramMessage(`📋 COMMANDS
/start - Welcome
/status - Bot status
/scan - Manual scan (15m)
/help - This menu

Auto-scan runs every 15 min`);
    }
    else {
        sendTelegramMessage(`❌ Unknown: ${text}\nType /help`);
    }
}

async function manualScan() {
    if (isScanning) return;
    isScanning = true;
    
    let signals = 0;
    for (const pair of PAIRS) {
        const analysis = await analyzePair(pair, '15min');
        if (analysis && analysis.confidence >= MIN_CONFIDENCE && analysis.signal !== 'NEUTRAL') {
            signals++;
            const msg = formatShortSignal(analysis, pair.name, false);
            sendTelegramMessage(msg);
            await new Promise(r => setTimeout(r, 500));
        }
        await new Promise(r => setTimeout(r, DELAY_BETWEEN_PAIRS_MS));
    }
    
    sendTelegramMessage(`✅ Manual scan done: ${signals} signals`);
    isScanning = false;
}

// ============================================
// TELEGRAM POLLING
// ============================================
function pollTelegram() {
    if (!TELEGRAM_TOKEN) {
        console.log('❌ No TELEGRAM_TOKEN');
        return;
    }
    
    console.log('📡 Polling started. Send /start to Omni_Pocket_Bot!');
    
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
console.log('\n' + '█'.repeat(50));
console.log('🏆 OMNI_POCKET_BOT');
console.log('█'.repeat(50));
console.log(`Pairs: ${PAIRS.length}`);
console.log(`Auto-scan: 15m`);
console.log('█'.repeat(50) + '\n');

if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    console.log('✅ Telegram configured');
    pollTelegram();
    
    setTimeout(() => {
        sendTelegramMessage(`🤖 OMNI_POCKET_BOT ONLINE 🤖
✅ 27 PAIRS | 15m AUTO-SCAN
Send /start for menu`);
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
