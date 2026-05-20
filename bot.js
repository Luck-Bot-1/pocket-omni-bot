// ============================================
// OMNI_POCKET_BOT - POCKET OPTION TRADING BOT
// TELEGRAM DASHBOARD - 15M AUTO SCAN
// ============================================

const { analyzeSignal } = require('./analyzer.js');
const https = require('https');
const fs = require('fs');

// ============================================
// CONFIGURATION
// ============================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// FOREX PAIRS (27 PAIRS - USD/MXN REMOVED)
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
const DELAY_BETWEEN_PAIRS_MS = 500;

let lastUpdateId = 0;
let botStartTime = Date.now();
let isScanning = false;

// ============================================
// SEND TELEGRAM MESSAGE (PLAIN TEXT)
// ============================================
function sendTelegramMessage(text) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log(`❌ TELEGRAM NOT CONFIGURED`);
        return false;
    }
    
    let messageText = text;
    if (messageText.length > 4000) {
        messageText = messageText.substring(0, 3950) + "\n\n... (truncated)";
    }
    
    console.log(`📤 Sending (${messageText.length} chars)...`);
    
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
        headers: { 
            'Content-Type': 'application/json',
            'Content-Length': data.length
        }
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
// FORMAT SIGNAL MESSAGE
// ============================================
function formatSignalMessage(analysis, pairName, timeframe, isAuto = false) {
    const arrow = analysis.signal === 'CALL' ? '📈' : '📉';
    const signalText = analysis.signal === 'CALL' ? 'CALL (UP)' : 'PUT (DOWN)';
    
    let message = '';
    
    if (isAuto) {
        message += `🤖 AUTO SIGNAL [15M]\n`;
    } else {
        message += `${arrow} SIGNAL ${arrow}\n`;
    }
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `📊 ${pairName} | [${timeframe}]\n`;
    message += `🎯 ${signalText}\n`;
    message += `⭐ CONFIDENCE: ${analysis.confidence}% | PROB: ${analysis.probability || analysis.confidence}%\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `📈 TECHNICALS:\n`;
    message += `   RSI: ${analysis.rsi} | ADX: ${analysis.adx}\n`;
    message += `   Trend: ${analysis.trendDirection}\n`;
    message += `   Alignment: ${analysis.trendAlignment || 'NEUTRAL'}\n`;
    
    if (analysis.divergence !== 'None') {
        message += `   Divergence: ${analysis.divergence} (${analysis.divergenceQuality}/100)\n`;
    }
    message += `   Volume: ${analysis.volumeRatio}x | Flow: ${analysis.volumeImbalance}\n`;
    message += `   Session: ${analysis.session}\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `💰 EXECUTION:\n`;
    message += `   Action: ${analysis.signal === 'CALL' ? 'BUY CALL' : 'BUY PUT'}\n`;
    message += `   Expiry: ${analysis.expiry} min\n`;
    message += `   SL: ${analysis.stopLossPips} pips | TP: ${analysis.takeProfitPips} pips\n`;
    message += `   R/R: ${analysis.riskReward}\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `${analysis.recommendation}\n`;
    message += `🕐 ${new Date().toLocaleTimeString()}`;
    
    return message;
}

// ============================================
// YAHOO FINANCE FETCHER
// ============================================
async function fetchYahooFinance(symbol, interval = '15m') {
    return new Promise((resolve) => {
        let period1;
        switch(interval) {
            case '1m': period1 = Math.floor((Date.now() / 1000) - (1 * 24 * 60 * 60)); break;
            case '5m': period1 = Math.floor((Date.now() / 1000) - (3 * 24 * 60 * 60)); break;
            case '15m': period1 = Math.floor((Date.now() / 1000) - (7 * 24 * 60 * 60)); break;
            case '30m': period1 = Math.floor((Date.now() / 1000) - (14 * 24 * 60 * 60)); break;
            case '1h': period1 = Math.floor((Date.now() / 1000) - (30 * 24 * 60 * 60)); break;
            default: period1 = Math.floor((Date.now() / 1000) - (7 * 24 * 60 * 60));
        }
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
                                open: quotes.open[i],
                                high: quotes.high[i],
                                low: quotes.low[i],
                                close: quotes.close[i],
                                volume: quotes.volume[i] || 1000,
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
        let yahooInterval = '15m';
        if (timeframe === '1min') yahooInterval = '1m';
        else if (timeframe === '5min') yahooInterval = '5m';
        else if (timeframe === '15min') yahooInterval = '15m';
        else if (timeframe === '30min') yahooInterval = '30m';
        else if (timeframe === '1h') yahooInterval = '1h';
        
        const data = await fetchYahooFinance(pair.symbol, yahooInterval);
        if (!data || !data.values || data.values.length < 30) return null;
        
        const analysis = await analyzeSignal(data, { pairName: pair.name }, timeframe);
        return analysis;
    } catch(e) {
        return null;
    }
}

// ============================================
// AUTO SCAN 15M
// ============================================
async function autoScan15m() {
    if (isScanning) return;
    isScanning = true;
    
    console.log(`\n🔄 AUTO-SCAN [15M] - ${new Date().toLocaleTimeString()}`);
    sendTelegramMessage(`🔄 Omni_Pocket_Bot scanning ${PAIRS.length} pairs...`);
    
    let signalsFound = 0;
    
    for (const pair of PAIRS) {
        const analysis = await analyzePair(pair, '15min');
        if (analysis && analysis.confidence >= MIN_CONFIDENCE && analysis.signal !== 'NEUTRAL') {
            signalsFound++;
            const message = formatSignalMessage(analysis, pair.name, '15m', true);
            sendTelegramMessage(message);
            console.log(`🔔 ${pair.name} - ${analysis.signal} @ ${analysis.confidence}%`);
            await new Promise(r => setTimeout(r, 1000));
        }
        await new Promise(r => setTimeout(r, DELAY_BETWEEN_PAIRS_MS));
    }
    
    console.log(`✅ Auto-scan complete: ${signalsFound} signals`);
    if (signalsFound === 0) {
        sendTelegramMessage(`✅ Auto-scan complete: No signals above ${MIN_CONFIDENCE}%`);
    } else {
        sendTelegramMessage(`✅ Auto-scan complete: ${signalsFound} signals found`);
    }
    isScanning = false;
}

// ============================================
// MANUAL SCAN
// ============================================
async function manualScan(timeframe = '15min') {
    if (isScanning) {
        sendTelegramMessage("⏳ Scan in progress...");
        return;
    }
    isScanning = true;
    
    const tfDisplay = timeframe === '15min' ? '15m' : timeframe === '5min' ? '5m' : '1h';
    sendTelegramMessage(`🔍 Manual scan [${tfDisplay}] started...`);
    
    let signals = 0;
    for (const pair of PAIRS) {
        const analysis = await analyzePair(pair, timeframe);
        if (analysis && analysis.confidence >= MIN_CONFIDENCE && analysis.signal !== 'NEUTRAL') {
            signals++;
            const message = formatSignalMessage(analysis, pair.name, tfDisplay, false);
            sendTelegramMessage(message);
            await new Promise(r => setTimeout(r, 1000));
        }
        await new Promise(r => setTimeout(r, DELAY_BETWEEN_PAIRS_MS));
    }
    
    sendTelegramMessage(`✅ Manual scan complete: ${signals} signals found`);
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
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ STATUS: ONLINE
✅ PAIRS: 27
✅ AUTO-SCAN: 15m (every 15 min)
✅ MIN CONF: 55%
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COMMANDS:
/status - Bot status
/scan - Manual scan (15m)
/scan5m - Manual scan (5m)
/scan1h - Manual scan (1h)
/help - All commands

Bot sends signals automatically every 15 minutes`);
    }
    else if (cmd === '/status') {
        const uptimeMin = Math.floor((Date.now() - botStartTime) / 1000 / 60);
        sendTelegramMessage(`📊 OMNI_POCKET_BOT STATUS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Uptime: ${uptimeMin} minutes
Pairs: 27
Auto-scan: 15m (active)
Min Confidence: 55%
Status: OPERATIONAL ✅`);
    }
    else if (cmd === '/scan') {
        manualScan('15min');
    }
    else if (cmd === '/scan5m') {
        manualScan('5min');
    }
    else if (cmd === '/scan1h') {
        manualScan('1h');
    }
    else if (cmd === '/help') {
        sendTelegramMessage(`📋 OMNI_POCKET_BOT COMMANDS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
/start - Welcome menu
/status - Bot status
/scan - Manual scan (15m)
/scan5m - Manual scan (5m)
/scan1h - Manual scan (1h)
/help - This menu

AUTO-SCAN: 15m (every 15 min)
SIGNALS INCLUDE: RSI, ADX, Divergence, Trend, Volume, Session, SL/TP`);
    }
    else {
        sendTelegramMessage(`❌ Unknown: ${text}\nType /help for commands`);
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
// SEND STARTUP MESSAGE
// ============================================
function sendStartupMessage() {
    sendTelegramMessage(`🤖 OMNI_POCKET_BOT ONLINE 🤖

✅ Status: RUNNING
✅ Pairs: 27
✅ Auto-scan: 15 min
✅ Min Confidence: 55%

Send /scan to test manual scan
Send /status for bot status
Send /help for commands`);
}

// ============================================
// START
// ============================================
console.log('\n' + '█'.repeat(60));
console.log('🏆 OMNI_POCKET_BOT');
console.log('█'.repeat(60));
console.log(`Pairs: ${PAIRS.length} (USD/MXN removed)`);
console.log(`Min Confidence: ${MIN_CONFIDENCE}%`);
console.log(`Auto-scan: 15m (every 15 min)`);
console.log('█'.repeat(60) + '\n');

if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    console.log('✅ Telegram configured');
    console.log(`   Token: ${TELEGRAM_TOKEN.substring(0, 10)}...`);
    console.log(`   Chat ID: ${TELEGRAM_CHAT_ID}`);
    
    setTimeout(() => {
        sendStartupMessage();
    }, 3000);
    
    pollTelegram();
} else {
    console.log('❌ Telegram NOT configured!');
    console.log('Add env vars: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
}

// Start auto-scan after 15 seconds
setTimeout(() => {
    console.log('📊 Starting auto-scan...');
    autoScan15m();
    setInterval(autoScan15m, 15 * 60 * 1000);
}, 15000);

// Keep alive
setInterval(() => {
    const uptimeMin = Math.floor((Date.now() - botStartTime) / 1000 / 60);
    console.log(`💓 Omni_Pocket_Bot alive | Uptime: ${uptimeMin}m | Pairs: ${PAIRS.length}`);
}, 60000);
