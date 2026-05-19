// ============================================
// LEGENDARY TRADING BOT - FINAL PERMANENT
// WILL GENERATE SIGNALS - DEPLOY ONCE
// ============================================

const { analyzeSignal } = require('./analyzer.js');
const https = require('https');

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    MIN_CONFIDENCE: 65,
    SCAN_INTERVAL: 30,
    DELAY_BETWEEN_PAIRS: 1500,
    TELEGRAM_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    TWELVE_DATA_KEY: process.env.TWELVE_DATA_API_KEY
};

// ============================================
// POCKET OPTION PAIRS (30)
// ============================================
const PAIRS = [
    'EUR/USD', 'GBP/USD', 'AUD/USD', 'NZD/USD', 'USD/CAD', 'USD/CHF', 'USD/JPY',
    'AUD/CAD', 'AUD/JPY', 'CAD/JPY', 'CHF/JPY', 'EUR/AUD', 'EUR/CAD', 'EUR/CHF',
    'EUR/GBP', 'EUR/JPY', 'EUR/NZD', 'GBP/AUD', 'GBP/CAD', 'GBP/CHF', 'GBP/JPY',
    'GBP/NZD', 'NZD/CAD', 'NZD/JPY', 'AUD/NZD', 'CAD/CHF', 'AUD/CHF'
];

// ============================================
// STATE
// ============================================
let autoScanInterval = null;
let isScanning = false;
let lastUpdateId = 0;

// ============================================
// HELPERS
// ============================================
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }

function sendMessage(text) {
    if (!CONFIG.TELEGRAM_TOKEN) return;
    const data = JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' });
    const req = https.request(`https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`, { method: 'POST' });
    req.write(data);
    req.end();
    log(`📤 Sent: ${text.substring(0, 50)}`);
}

// ============================================
// FETCH FROM TWELVE DATA
// ============================================
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

// ============================================
// ANALYZE SINGLE PAIR
// ============================================
async function analyzePair(pair) {
    try {
        const data = await fetchTwelveData(pair, '15min');
        if (!data?.values?.length >= 50) return null;
        return await analyzeSignal(data, { pairName: pair }, '15m');
    } catch(e) { return null; }
}

// ============================================
// SCAN SPECIFIC PAIR (MANUAL)
// ============================================
async function scanPair(pair) {
    const upperPair = pair.toUpperCase();
    sendMessage(`🔍 Analyzing ${upperPair}...`);
    const analysis = await analyzePair(upperPair);
    if (!analysis) { sendMessage(`❌ Could not analyze ${upperPair}`); return; }
    const arrow = analysis.signal === 'CALL' ? '📈' : '📉';
    const emoji = analysis.confidence >= 90 ? '🏆' : analysis.confidence >= 70 ? '✅' : '📊';
    sendMessage(`${emoji} ${upperPair}\nSignal: ${arrow} ${analysis.signal}\nConfidence: ${analysis.confidence}%\nRSI: ${analysis.rsi} | ADX: ${analysis.adx}`);
}

// ============================================
// SCAN ALL PAIRS (MANUAL)
// ============================================
async function scanAllPairs() {
    if (isScanning) { sendMessage('⏳ Scan already in progress'); return; }
    
    isScanning = true;
    sendMessage(`🔍 Scanning ${PAIRS.length} pairs... (2-3 minutes)`);
    log(`Manual scan started`);
    
    let signals = [];
    
    for (const pair of PAIRS) {
        const analysis = await analyzePair(pair);
        if (analysis?.confidence >= CONFIG.MIN_CONFIDENCE) {
            signals.push({ pair, analysis });
            const arrow = analysis.signal === 'CALL' ? '📈' : '📉';
            sendMessage(`${arrow} ${pair}: ${analysis.signal} @ ${analysis.confidence}%`);
            log(`✅ ${pair}: ${analysis.signal} @ ${analysis.confidence}%`);
        }
        await new Promise(r => setTimeout(r, CONFIG.DELAY_BETWEEN_PAIRS));
    }
    
    if (signals.length === 0) {
        sendMessage(`✅ Scan complete: No signals above ${CONFIG.MIN_CONFIDENCE}% threshold.`);
    } else {
        sendMessage(`✅ Scan complete: ${signals.length} signals found.`);
    }
    
    isScanning = false;
}

// ============================================
// AUTO SCAN (SILENT - ONLY SIGNALS)
// ============================================
async function autoScan() {
    if (isScanning) return;
    isScanning = true;
    log(`🔄 Auto-scan triggered`);
    
    for (const pair of PAIRS) {
        const analysis = await analyzePair(pair);
        if (analysis?.confidence >= CONFIG.MIN_CONFIDENCE) {
            const arrow = analysis.signal === 'CALL' ? '📈' : '📉';
            sendMessage(`${arrow} ${pair}: ${analysis.signal} @ ${analysis.confidence}%`);
            log(`🔔 AUTO SIGNAL: ${pair} ${analysis.signal} @ ${analysis.confidence}%`);
        }
        await new Promise(r => setTimeout(r, CONFIG.DELAY_BETWEEN_PAIRS));
    }
    
    isScanning = false;
}

// ============================================
// AUTO SCAN CONTROLS
// ============================================
function startAutoScan() {
    if (autoScanInterval) { sendMessage('⚠️ Auto-scan already running'); return; }
    autoScanInterval = setInterval(autoScan, CONFIG.SCAN_INTERVAL * 60 * 1000);
    sendMessage(`✅ Auto-scan ENABLED (every ${CONFIG.SCAN_INTERVAL} minutes)`);
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

// ============================================
// STATUS
// ============================================
function showStatus() {
    sendMessage(`📊 Bot Status\nPairs: ${PAIRS.length}\nThreshold: ${CONFIG.MIN_CONFIDENCE}%\nAuto-scan: ${autoScanInterval ? '🟢 ACTIVE' : '🔴 STOPPED'}\nInterval: ${CONFIG.SCAN_INTERVAL} min\nData: Twelve Data`);
}

// ============================================
// TELEGRAM POLLING
// ============================================
function pollTelegram() {
    if (!CONFIG.TELEGRAM_TOKEN) { log('❌ No TELEGRAM_TOKEN'); return; }
    log('📡 Polling started');
    
    const poll = () => {
        https.get(`https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.ok?.result) {
                        for (const update of json.result) {
                            lastUpdateId = update.update_id;
                            const text = update.message?.text || '';
                            log(`📥 Command: ${text}`);
                            
                            if (text === '/start') {
                                sendMessage(`🚀 BOT ACTIVE!\n\nCommands:\n/scan - Scan all pairs\n/scan EUR/USD - Scan specific\n/startscan - Enable auto-scan\n/stopscan - Disable auto-scan\n/status - Bot status\n\nThreshold: ${CONFIG.MIN_CONFIDENCE}%\nPairs: ${PAIRS.length}`);
                            }
                            else if (text === '/status') showStatus();
                            else if (text === '/startscan') startAutoScan();
                            else if (text === '/stopscan') stopAutoScan();
                            else if (text === '/scan') scanAllPairs();
                            else if (text?.startsWith('/scan ')) scanPair(text.substring(6));
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

// ============================================
// START
// ============================================
console.log('\n========================================');
console.log('🚀 LEGENDARY TRADING BOT - FINAL');
console.log('========================================\n');
console.log(`Pairs: ${PAIRS.length}`);
console.log(`Threshold: ${CONFIG.MIN_CONFIDENCE}%`);
console.log(`Auto-scan: every ${CONFIG.SCAN_INTERVAL} min`);
console.log(`Twelve Data: ${CONFIG.TWELVE_DATA_KEY ? '✅' : '❌'}`);
console.log(`Telegram: ${CONFIG.TELEGRAM_TOKEN ? '✅' : '❌'}\n`);

if (CONFIG.TELEGRAM_TOKEN && CONFIG.TELEGRAM_CHAT_ID && CONFIG.TWELVE_DATA_KEY) {
    pollTelegram();
    sendMessage(`🚀 BOT ACTIVE!\n✅ ${PAIRS.length} pairs\n✅ /scan to test\n✅ /startscan for auto-scan`);
} else {
    console.log('❌ Missing: TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, or TWELVE_DATA_KEY');
}
