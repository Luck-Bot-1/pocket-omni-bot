// ============================================
// LEGENDARY TRADING BOT - FINAL PERMANENT VERSION
// NO MORE CHANGES AFTER THIS - EVER
// ============================================

const { analyzeSignal } = require('./analyzer.js');
const https = require('https');

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    MIN_CONFIDENCE: 65,
    AUTO_SCAN_INTERVAL: 30,
    EXPIRY_MINUTES: 15,
    DELAY_BETWEEN_PAIRS: 2000,
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
// HELPERS
// ============================================
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
function sendMessage(text) {
    if (!CONFIG.TELEGRAM_TOKEN) return;
    const data = JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' });
    const req = https.request(`https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`, { method: 'POST' });
    req.write(data);
    req.end();
}

// ============================================
// TWELVE DATA API
// ============================================
async function fetchTwelveData(pair, interval = '15min') {
    if (!CONFIG.TWELVE_DATA_KEY) return null;
    return new Promise((resolve) => {
        const symbol = pair.replace('/', '');
        const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval}&outputsize=120&apikey=${CONFIG.TWELVE_DATA_KEY}`;
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
        }).on('error', () => resolve(null)).setTimeout(10000, function() { this.destroy(); resolve(null); });
    });
}

// ============================================
// MULTI-TIMEFRAME
// ============================================
async function getMultiTimeframeData(pair) {
    const fifteenMin = await fetchTwelveData(pair, '15min');
    await new Promise(r => setTimeout(r, 500));
    const oneHour = await fetchTwelveData(pair, '1h');
    await new Promise(r => setTimeout(r, 500));
    const fourHour = await fetchTwelveData(pair, '4h');
    return { entry: fifteenMin, trend: oneHour, structure: fourHour };
}

// ============================================
// ANALYZE PAIR
// ============================================
async function analyzePair(pair) {
    try {
        const tfData = await getMultiTimeframeData(pair);
        if (!tfData.entry?.values?.length >= 50) return null;
        return await analyzeSignal(tfData.entry, { pairName: pair }, '15m', tfData.trend, tfData.structure);
    } catch(e) { return null; }
}

// ============================================
// SCAN SPECIFIC PAIR
// ============================================
async function scanPair(pair) {
    const upperPair = pair.toUpperCase();
    sendMessage(`🔍 Analyzing ${upperPair}...`);
    const analysis = await analyzePair(upperPair);
    if (!analysis) { sendMessage(`❌ Could not analyze ${upperPair}`); return; }
    const arrow = analysis.signal === 'CALL' ? '📈' : '📉';
    const emoji = analysis.confidence >= 90 ? '🏆' : analysis.confidence >= 70 ? '✅' : '📊';
    sendMessage(`${emoji} <b>${upperPair}</b> ${emoji}\n\nSignal: ${arrow} ${analysis.signal}\nConfidence: ${analysis.confidence}%\nStrategy: ${analysis.strategyUsed}\nRSI: ${analysis.rsi} | ADX: ${analysis.adx}\nDivergence: ${analysis.divergence || 'None'}\nExpiry: ${CONFIG.EXPIRY_MINUTES}m`);
}

// ============================================
// SCAN ALL PAIRS
// ============================================
async function scanAllPairs(isAuto = false) {
    if (!isAuto) sendMessage(`🔍 Scanning ${PAIRS.length} pairs... (2-3 minutes)`);
    log(`Scanning ${PAIRS.length} pairs`);
    let signals = [], processed = 0;
    for (let i = 0; i < PAIRS.length; i++) {
        const pair = PAIRS[i];
        log(`[${i+1}/${PAIRS.length}] ${pair}...`);
        const analysis = await analyzePair(pair);
        if (analysis) { processed++; if (analysis.confidence >= CONFIG.MIN_CONFIDENCE) { signals.push({ pair, analysis }); log(`✅ SIGNAL: ${pair} ${analysis.signal} @ ${analysis.confidence}%`); if (!isAuto) { const arrow = analysis.signal === 'CALL' ? '📈' : '📉'; sendMessage(`${arrow} ${pair}: ${analysis.signal} @ ${analysis.confidence}%`); } } }
        if (i < PAIRS.length - 1) await new Promise(r => setTimeout(r, CONFIG.DELAY_BETWEEN_PAIRS));
    }
    if (!isAuto) sendMessage(`✅ Scan complete\nSignals: ${signals.length}\nProcessed: ${processed}/${PAIRS.length}\n${signals.length === 0 ? '⚠️ No signals above threshold. Try during London/NY overlap.' : ''}`);
    return signals;
}

// ============================================
// TELEGRAM COMMANDS
// ============================================
let lastUpdateId = 0, autoScanInterval = null, isScanning = false;
function startAutoScan() { if (autoScanInterval) return; autoScanInterval = setInterval(() => { if (!isScanning) { isScanning = true; scanAllPairs(true).finally(() => { isScanning = false; }); } }, CONFIG.AUTO_SCAN_INTERVAL * 60 * 1000); sendMessage(`✅ Auto-scan enabled (every ${CONFIG.AUTO_SCAN_INTERVAL} min)`); }
function stopAutoScan() { if (autoScanInterval) { clearInterval(autoScanInterval); autoScanInterval = null; sendMessage('⏸️ Auto-scan disabled'); } }
function showPairs() { sendMessage(`📊 ${PAIRS.length} Pairs\n${PAIRS.map((p,i)=>`${i+1}. ${p}`).join('\n')}`); }
function showStatus() { sendMessage(`📊 Bot Status\n• Pairs: ${PAIRS.length}\n• Threshold: ${CONFIG.MIN_CONFIDENCE}%\n• Auto-scan: ${autoScanInterval ? 'ON' : 'OFF'}\n• API Key: ${CONFIG.TWELVE_DATA_KEY ? '✅' : '❌'}`); }

function pollTelegram() {
    if (!CONFIG.TELEGRAM_TOKEN) return;
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
                            if (text === '/start') sendMessage(`🚀 LEGENDARY TRADING BOT\n\nCommands:\n/scan - Scan all pairs\n/scan PAIR - Scan specific pair\n/pairs - Show pairs\n/startscan - Auto-scan ON\n/stopscan - Auto-scan OFF\n/status - Bot status\n\nThreshold: ${CONFIG.MIN_CONFIDENCE}%\nExpiry: ${CONFIG.EXPIRY_MINUTES}m`);
                            else if (text === '/status') showStatus();
                            else if (text === '/pairs') showPairs();
                            else if (text === '/startscan') startAutoScan();
                            else if (text === '/stopscan') stopAutoScan();
                            else if (text === '/scan') { if (!isScanning) { isScanning = true; scanAllPairs(false).finally(() => { isScanning = false; }); } else sendMessage('⏳ Scan in progress'); }
                            else if (text?.startsWith('/scan ')) scanPair(text.substring(6));
                        }
                    }
                } catch(e) {}
                setTimeout(poll, 2000);
            });
        }).on('error', () => setTimeout(poll, 2000));
    };
    poll();
    log('📡 Telegram polling active');
}

// ============================================
// KEEP ALIVE
// ============================================
setInterval(() => log('💓 Bot alive'), 60000);

// ============================================
// START
// ============================================
console.log('\n========================================');
console.log('🚀 LEGENDARY TRADING BOT - FINAL');
console.log('========================================\n');
console.log(`Pairs: ${PAIRS.length}`);
console.log(`Threshold: ${CONFIG.MIN_CONFIDENCE}%`);
console.log(`Twelve Data API: ${CONFIG.TWELVE_DATA_KEY ? '✅' : '❌'}`);
console.log(`Telegram: ${CONFIG.TELEGRAM_TOKEN ? '✅' : '❌'}\n`);

if (CONFIG.TELEGRAM_TOKEN && CONFIG.TELEGRAM_CHAT_ID && CONFIG.TWELVE_DATA_KEY) {
    pollTelegram();
    startAutoScan();
    sendMessage(`🚀 Bot ACTIVE!\n✅ ${PAIRS.length} pairs\n✅ Send /scan to test`);
} else {
    console.log('❌ Missing: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, or TWELVE_DATA_API_KEY');
}

module.exports = { scanAllPairs, scanPair, showPairs, showStatus };
