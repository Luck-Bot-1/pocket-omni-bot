// ============================================
// LEGENDARY TRADING BOT v12.0 - FINAL PRODUCTION
// REPLACE YOUR EXISTING bot.js WITH THIS FILE
// NO FURTHER CHANGES EVER NEEDED
// ============================================

const { analyzeSignal } = require('./analyzer.js');
const https = require('https');
const fs = require('fs');

// ============================================
// CONFIGURATION - USING ENVIRONMENT VARIABLES (NEVER HARDCODE)
// ============================================
const CONFIG = {
    MIN_CONFIDENCE: 65,
    SCAN_INTERVAL_MINUTES: 30,
    DELAY_BETWEEN_PAIRS_MS: 1200,
    TELEGRAM_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    TWELVE_DATA_KEY: process.env.TWELVE_DATA_API_KEY,
    USE_YAHOO_FINANCE: true  // FREE LIVE DATA
};

// ============================================
// FOREX PAIRS (Yahoo Finance Live Symbols)
// ============================================
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

// ============================================
// STATE
// ============================================
let autoScanInterval = null;
let isScanning = false;
let lastUpdateId = 0;
let botStartTime = Date.now();

// ============================================
// LOGGING
// ============================================
function log(msg, level = 'INFO') {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] [${level}] ${msg}`);
    try {
        fs.appendFileSync('bot.log', `[${new Date().toISOString()}] [${level}] ${msg}\n`);
    } catch(e) {}
}

// ============================================
// YAHOO FINANCE DATA FETCHER (LIVE & FREE)
// ============================================
async function fetchYahooFinance(symbol, interval = '15m') {
    return new Promise((resolve) => {
        const period1 = Math.floor((Date.now() / 1000) - (7 * 24 * 60 * 60));
        const period2 = Math.floor(Date.now() / 1000);
        
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=${interval}`;
        
        const request = https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (!json.chart?.result?.[0]) { resolve(null); return; }
                    
                    const result = json.chart.result[0];
                    const timestamps = result.timestamp;
                    const quotes = result.indicators.quote[0];
                    
                    if (!timestamps || !quotes || !quotes.open) { resolve(null); return; }
                    
                    const candles = [];
                    for (let i = 0; i < timestamps.length; i++) {
                        if (quotes.open[i] && quotes.high[i] && quotes.low[i] && quotes.close[i]) {
                            candles.push({
                                open: quotes.open[i],
                                high: quotes.high[i],
                                low: quotes.low[i],
                                close: quotes.close[i],
                                volume: quotes.volume[i] || 1000,
                                time: timestamps[i] * 1000
                            });
                        }
                    }
                    resolve({ values: candles });
                } catch(e) { resolve(null); }
            });
        });
        request.on('error', () => resolve(null));
        request.setTimeout(10000, () => { request.destroy(); resolve(null); });
    });
}

async function fetchTwelveData(pair, interval = '15min') {
    if (!CONFIG.TWELVE_DATA_KEY) return null;
    return new Promise((resolve) => {
        const symbol = pair.replace('/', '');
        const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval}&outputsize=100&apikey=${CONFIG.TWELVE_DATA_KEY}`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (!json.values) { resolve(null); return; }
                    const candles = json.values.map(v => ({
                        open: parseFloat(v.open), high: parseFloat(v.high),
                        low: parseFloat(v.low), close: parseFloat(v.close),
                        volume: 1000, time: new Date(v.datetime).getTime()
                    }));
                    resolve({ values: candles });
                } catch(e) { resolve(null); }
            });
        }).on('error', () => resolve(null));
    });
}

async function fetchPriceData(pair, interval = '15min') {
    if (CONFIG.USE_YAHOO_FINANCE) {
        const yahooInterval = interval === '15min' ? '15m' : interval === '1h' ? '1h' : '5m';
        const data = await fetchYahooFinance(pair.symbol, yahooInterval);
        if (data && data.values?.length >= 50) return data;
    }
    if (CONFIG.TWELVE_DATA_KEY) return await fetchTwelveData(pair.name, interval);
    return null;
}

// ============================================
// TELEGRAM MESSAGING
// ============================================
function sendMessage(text) {
    if (!CONFIG.TELEGRAM_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
        console.log(`\n📱 TELEGRAM MESSAGE:\n${text}\n`);
        return;
    }
    
    const data = JSON.stringify({
        chat_id: CONFIG.TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
    });
    
    const req = https.request(
        `https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } }
    );
    req.on('error', (e) => log(`Telegram error: ${e.message}`, 'ERROR'));
    req.write(data);
    req.end();
    log(`📤 Sent: ${text.substring(0, 50)}...`);
}

async function analyzePair(pairData) {
    try {
        const data = await fetchPriceData(pairData, '15min');
        if (!data?.values?.length >= 50) return null;
        return await analyzeSignal(data, { pairName: pairData.name }, '15m');
    } catch(e) { return null; }
}

// ============================================
// SCAN COMMANDS
// ============================================
async function scanSinglePair(pairName) {
    const pair = PAIRS.find(p => p.name === pairName.toUpperCase());
    if (!pair) { sendMessage(`❌ Pair ${pairName} not found`); return; }
    
    sendMessage(`🔍 Analyzing ${pair.name}...`);
    const analysis = await analyzePair(pair);
    
    if (!analysis) { sendMessage(`❌ Could not analyze ${pair.name}`); return; }
    
    const arrow = analysis.signal === 'CALL' ? '📈' : '📉';
    const emoji = analysis.confidence >= 90 ? '🏆' : analysis.confidence >= 70 ? '✅' : '📊';
    
    let message = `${emoji} ${arrow} ${pair.name}\n`;
    message += `Signal: ${analysis.signal}\n`;
    message += `Confidence: ${analysis.confidence}%\n`;
    message += `RSI: ${analysis.rsi} | ADX: ${analysis.adx}\n`;
    message += `Trend: ${analysis.trendDirection || 'Neutral'}\n`;
    message += `Volatility: ${analysis.volatilityPercent || 'N/A'}%\n`;
    if (analysis.divergence && analysis.divergence !== 'None') message += `Divergence: ${analysis.divergence}\n`;
    message += `\n${analysis.recommendation || 'Trade with caution'}`;
    
    sendMessage(message);
}

async function scanAllPairs() {
    if (isScanning) { sendMessage('⏳ Scan already in progress'); return; }
    
    isScanning = true;
    sendMessage(`🔍 Scanning ${PAIRS.length} pairs... (2-3 minutes)`);
    log(`Manual scan started`);
    
    let signals = [];
    for (const pair of PAIRS) {
        const analysis = await analyzePair(pair);
        if (analysis && analysis.confidence >= CONFIG.MIN_CONFIDENCE && analysis.signal !== 'NEUTRAL') {
            signals.push({ pair: pair.name, analysis });
            const arrow = analysis.signal === 'CALL' ? '📈' : '📉';
            sendMessage(`${arrow} ${pair.name}: ${analysis.signal} @ ${analysis.confidence}%`);
            log(`✅ SIGNAL: ${pair.name} - ${analysis.signal} @ ${analysis.confidence}%`);
        }
        await new Promise(r => setTimeout(r, CONFIG.DELAY_BETWEEN_PAIRS_MS));
    }
    
    if (signals.length === 0) {
        sendMessage(`✅ Scan complete: No signals above ${CONFIG.MIN_CONFIDENCE}%`);
    } else {
        sendMessage(`✅ Scan complete: ${signals.length} signals found`);
    }
    isScanning = false;
}

async function autoScan() {
    if (isScanning) return;
    isScanning = true;
    log(`🔄 Auto-scan triggered`);
    
    for (const pair of PAIRS) {
        const analysis = await analyzePair(pair);
        if (analysis && analysis.confidence >= CONFIG.MIN_CONFIDENCE && analysis.signal !== 'NEUTRAL') {
            const arrow = analysis.signal === 'CALL' ? '📈' : '📉';
            sendMessage(`🤖 AUTO ${arrow} ${pair.name}: ${analysis.signal} @ ${analysis.confidence}%`);
            log(`🔔 AUTO SIGNAL: ${pair.name} - ${analysis.signal} @ ${analysis.confidence}%`);
        }
        await new Promise(r => setTimeout(r, CONFIG.DELAY_BETWEEN_PAIRS_MS));
    }
    isScanning = false;
}

function startAutoScan() {
    if (autoScanInterval) { sendMessage('⚠️ Auto-scan already running'); return; }
    autoScanInterval = setInterval(autoScan, CONFIG.SCAN_INTERVAL_MINUTES * 60 * 1000);
    sendMessage(`✅ Auto-scan ENABLED (every ${CONFIG.SCAN_INTERVAL_MINUTES} minutes)`);
    log(`Auto-scan started`);
}

function stopAutoScan() {
    if (autoScanInterval) {
        clearInterval(autoScanInterval);
        autoScanInterval = null;
        sendMessage('⏸️ Auto-scan DISABLED');
        log(`Auto-scan stopped`);
    } else {
        sendMessage('⚠️ Auto-scan was not running');
    }
}

function showStatus() {
    const uptimeHours = Math.floor((Date.now() - botStartTime) / 1000 / 60 / 60);
    const uptimeMinutes = Math.floor((Date.now() - botStartTime) / 1000 / 60) % 60;
    
    sendMessage(`📊 BOT STATUS

🤖 Status: ONLINE
⏱️ Uptime: ${uptimeHours}h ${uptimeMinutes}m
🔄 Auto-scan: ${autoScanInterval ? '🟢 ACTIVE' : '🔴 STOPPED'}
⏰ Interval: ${CONFIG.SCAN_INTERVAL_MINUTES} min
🎯 Threshold: ${CONFIG.MIN_CONFIDENCE}%
📈 Pairs: ${PAIRS.length}
📡 Data: Yahoo Finance (LIVE)

Commands:
/scan - Scan all pairs
/scan EUR/USD - Scan specific
/startscan - Enable auto-scan
/stopscan - Disable auto-scan
/status - Bot status`);
}

// ============================================
// TELEGRAM POLLING
// ============================================
function pollTelegram() {
    if (!CONFIG.TELEGRAM_TOKEN) {
        log('❌ No TELEGRAM_TOKEN - console mode');
        return;
    }
    
    log('📡 Telegram polling started');
    
    const poll = () => {
        const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`;
        
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.ok && json.result) {
                        for (const update of json.result) {
                            lastUpdateId = update.update_id;
                            const text = update.message?.text || '';
                            const chatId = update.message?.chat?.id;
                            
                            if (CONFIG.TELEGRAM_CHAT_ID && chatId && chatId.toString() !== CONFIG.TELEGRAM_CHAT_ID) {
                                log(`Unauthorized chat: ${chatId}`, 'WARN');
                                continue;
                            }
                            
                            log(`📥 Command: ${text}`);
                            
                            if (text === '/start') {
                                sendMessage(`🚀 LEGENDARY BOT ACTIVE!

✅ Yahoo Finance LIVE DATA
✅ ${PAIRS.length} pairs
✅ Auto-scan: ${autoScanInterval ? 'ON' : 'OFF'}

Commands:
/scan - Scan all pairs
/scan EUR/USD - Scan specific
/startscan - Enable auto-scan
/stopscan - Disable auto-scan
/status - Bot status

Threshold: ${CONFIG.MIN_CONFIDENCE}%`);
                            }
                            else if (text === '/status') showStatus();
                            else if (text === '/startscan') startAutoScan();
                            else if (text === '/stopscan') stopAutoScan();
                            else if (text === '/scan') scanAllPairs();
                            else if (text?.startsWith('/scan ')) {
                                const pair = text.substring(6).trim();
                                scanSinglePair(pair);
                            }
                        }
                    }
                } catch(e) {}
                setTimeout(poll, 2000);
            });
        }).on('error', () => setTimeout(poll, 5000));
    };
    poll();
}

// ============================================
// KEEP ALIVE
// ============================================
setInterval(() => log('💓 Alive'), 60000);

process.on('SIGINT', () => {
    log('Shutting down...');
    if (autoScanInterval) clearInterval(autoScanInterval);
    sendMessage('🛑 Bot shutting down');
    setTimeout(() => process.exit(0), 1000);
});

// ============================================
// START
// ============================================
console.log('\n========================================');
console.log('🏆 LEGENDARY TRADING BOT v12.0');
console.log('========================================');
console.log('Status: PRODUCTION READY');
console.log('Data Source: Yahoo Finance (LIVE)');
console.log('========================================\n');

console.log(`Pairs: ${PAIRS.length}`);
console.log(`Threshold: ${CONFIG.MIN_CONFIDENCE}%`);
console.log(`Auto-scan: every ${CONFIG.SCAN_INTERVAL_MINUTES} min`);
console.log(`Yahoo Finance: ✅ PRIMARY`);
console.log(`Telegram: ${CONFIG.TELEGRAM_TOKEN ? '✅' : '❌'}\n`);

if (CONFIG.TELEGRAM_TOKEN && CONFIG.TELEGRAM_CHAT_ID) {
    pollTelegram();
    sendMessage(`🏆 LEGENDARY BOT v12.0 ACTIVATED

✅ Yahoo Finance LIVE DATA
✅ ${PAIRS.length} pairs
✅ /scan to test
✅ /startscan for auto-scan`);
} else {
    console.log('⚠️ Telegram not configured - console mode only');
    console.log('To enable Telegram, set environment variables:');
    console.log('  TELEGRAM_BOT_TOKEN=your_token');
    console.log('  TELEGRAM_CHAT_ID=your_chat_id');
}

log('Bot started successfully');

setTimeout(() => {
    log('Running initial scan...');
    scanAllPairs();
}, 10000);
