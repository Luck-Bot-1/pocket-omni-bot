// ============================================
// LEGENDARY TRADING BOT - TWELVE DATA (WORKING)
// ============================================

const { analyzeSignal } = require('./analyzer.js');
const https = require('https');

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    MIN_CONFIDENCE: 70,
    AUTO_SCAN_INTERVAL: 15,
    EXPIRY_MINUTES: 15,
    TELEGRAM_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    TWELVE_DATA_KEY: process.env.TWELVE_DATA_API_KEY
};

// ============================================
// ALL POCKET OPTION LIVE PAIRS
// ============================================
const PAIRS = [
    'EUR/USD', 'GBP/USD', 'AUD/USD', 'NZD/USD', 'USD/CAD', 'USD/CHF', 'USD/JPY',
    'AUD/CAD', 'AUD/JPY', 'CAD/JPY', 'CHF/JPY', 'EUR/AUD', 'EUR/CAD', 'EUR/CHF',
    'EUR/GBP', 'EUR/JPY', 'EUR/NZD', 'GBP/AUD', 'GBP/CAD', 'GBP/CHF', 'GBP/JPY',
    'GBP/NZD', 'NZD/CAD', 'NZD/JPY', 'AUD/NZD', 'CAD/CHF', 'AUD/CHF'
];

// ============================================
// FETCH DATA FROM TWELVE DATA
// ============================================
async function fetchTwelveData(pair, interval = '15min') {
    if (!CONFIG.TWELVE_DATA_KEY) {
        console.log('❌ TWELVE_DATA_API_KEY not set');
        return null;
    }
    
    return new Promise((resolve) => {
        const symbol = pair.replace('/', '');
        const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval}&outputsize=120&apikey=${CONFIG.TWELVE_DATA_KEY}`;
        
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    
                    if (json.code === 429) {
                        console.log(`   ⚠️ Rate limit for ${pair}`);
                        resolve(null);
                        return;
                    }
                    
                    if (!json.values || !Array.isArray(json.values)) {
                        resolve(null);
                        return;
                    }
                    
                    const candles = [];
                    for (let i = 0; i < json.values.length; i++) {
                        const v = json.values[i];
                        if (v.open && v.high && v.low && v.close) {
                            candles.push({
                                open: parseFloat(v.open),
                                high: parseFloat(v.high),
                                low: parseFloat(v.low),
                                close: parseFloat(v.close),
                                volume: 1000,
                                time: new Date(v.datetime).getTime()
                            });
                        }
                    }
                    resolve({ values: candles });
                } catch(e) {
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null));
    });
}

// ============================================
// GET MULTI-TIMEFRAME DATA (15min, 1H, 4H)
// ============================================
async function getMultiTimeframeData(pair) {
    const fifteenMin = await fetchTwelveData(pair, '15min');
    const oneHour = await fetchTwelveData(pair, '1h');
    const fourHour = await fetchTwelveData(pair, '4h');
    
    return { entry: fifteenMin, trend: oneHour, structure: fourHour };
}

// ============================================
// SEND TELEGRAM MESSAGE
// ============================================
function sendMessage(text) {
    if (!CONFIG.TELEGRAM_TOKEN) return;
    const data = JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' });
    const req = https.request(`https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`, { method: 'POST' });
    req.write(data);
    req.end();
}

// ============================================
// ANALYZE SINGLE PAIR
// ============================================
async function analyzePair(pair) {
    try {
        const tfData = await getMultiTimeframeData(pair);
        
        if (!tfData.entry || !tfData.entry.values || tfData.entry.values.length < 30) {
            return null;
        }
        
        return await analyzeSignal(
            tfData.entry, { pairName: pair }, '15m',
            tfData.trend, tfData.structure
        );
    } catch(e) {
        return null;
    }
}

// ============================================
// SCAN SPECIFIC PAIR
// ============================================
async function scanPair(pair) {
    if (!CONFIG.TWELVE_DATA_KEY) {
        sendMessage(`❌ TWELVE_DATA_API_KEY not configured.`);
        return;
    }
    
    const upperPair = pair.toUpperCase();
    sendMessage(`🔍 Analyzing ${upperPair}...`);
    
    const analysis = await analyzePair(upperPair);
    
    if (!analysis) {
        sendMessage(`❌ Could not analyze ${upperPair}.`);
        return;
    }
    
    if (analysis.confidence >= CONFIG.MIN_CONFIDENCE) {
        const arrow = analysis.signal === 'CALL' ? '📈' : '📉';
        const emoji = analysis.confidence >= 90 ? '🏆' : '✅';
        sendMessage(`
${emoji} <b>SIGNAL</b> ${emoji}

Pair: ${upperPair}
Signal: ${arrow} ${analysis.signal}
Confidence: ${analysis.confidence}%
Strategy: ${analysis.strategyUsed}
RSI: ${analysis.rsi} | ADX: ${analysis.adx}
Divergence: ${analysis.divergence || 'None'}
Expiry: ${CONFIG.EXPIRY_MINUTES}m
        `);
    } else {
        sendMessage(`
📊 ${upperPair}
Signal: ${analysis.signal || 'NONE'}
Confidence: ${analysis.confidence}%
RSI: ${analysis.rsi} | ADX: ${analysis.adx}
⚠️ Below ${CONFIG.MIN_CONFIDENCE}% threshold
        `);
    }
}

// ============================================
// SCAN ALL PAIRS
// ============================================
async function scanAllPairs() {
    if (!CONFIG.TWELVE_DATA_KEY) {
        sendMessage(`❌ TWELVE_DATA_API_KEY not configured.`);
        return;
    }
    
    sendMessage(`🔍 Scanning ${PAIRS.length} pairs...`);
    let signals = [];
    let processed = 0;
    
    for (const pair of PAIRS) {
        const analysis = await analyzePair(pair);
        if (analysis) processed++;
        if (analysis?.confidence >= CONFIG.MIN_CONFIDENCE) {
            signals.push({ pair, analysis });
            const arrow = analysis.signal === 'CALL' ? '📈' : '📉';
            sendMessage(`${arrow} ${pair}: ${analysis.signal} @ ${analysis.confidence}%`);
        }
        await new Promise(r => setTimeout(r, 800));
    }
    
    sendMessage(`✅ Scan complete. Processed: ${processed}/${PAIRS.length} pairs. Found ${signals.length} signal(s).`);
    return signals;
}

// ============================================
// SHOW AVAILABLE PAIRS
// ============================================
function showPairs() {
    const list = PAIRS.map((p, i) => `${i+1}. ${p}`).join('\n');
    sendMessage(`📊 <b>${PAIRS.length} Pairs</b>\n\n${list}`);
}

// ============================================
// TELEGRAM BOT
// ============================================
let lastUpdateId = 0;
let autoScanInterval = null;

function startAutoScan() {
    if (autoScanInterval) return;
    autoScanInterval = setInterval(() => scanAllPairs(), CONFIG.AUTO_SCAN_INTERVAL * 60 * 1000);
    sendMessage(`✅ Auto-scan enabled (every ${CONFIG.AUTO_SCAN_INTERVAL} minutes)`);
}

function stopAutoScan() {
    if (autoScanInterval) { clearInterval(autoScanInterval); autoScanInterval = null; }
    sendMessage(`⏸️ Auto-scan disabled`);
}

function pollTelegram() {
    if (!CONFIG.TELEGRAM_TOKEN) return;
    
    const poll = () => {
        const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.ok?.result) {
                        for (const update of json.result) {
                            lastUpdateId = update.update_id;
                            const text = update.message?.text || '';
                            
                            if (text === '/start') {
                                sendMessage(`
🚀 <b>OmniPocket Bot</b>

Commands:
/scan - Scan all pairs
/scan PAIR - Scan specific pair
/pairs - Show available pairs
/startscan - Enable auto-scan
/stopscan - Disable auto-scan
/status - Bot status

Data: Twelve Data
Threshold: ${CONFIG.MIN_CONFIDENCE}%
Expiry: ${CONFIG.EXPIRY_MINUTES}m
                                `);
                            }
                            else if (text === '/pairs') showPairs();
                            else if (text === '/status') sendMessage(`✅ Bot running\nPairs: ${PAIRS.length}\nData: Twelve Data\nAuto-scan: ${autoScanInterval ? 'ON' : 'OFF'}`);
                            else if (text === '/startscan') startAutoScan();
                            else if (text === '/stopscan') stopAutoScan();
                            else if (text === '/scan') scanAllPairs();
                            else if (text.startsWith('/scan ')) scanPair(text.substring(6));
                        }
                    }
                } catch(e) {}
                setTimeout(poll, 2000);
            });
        }).on('error', () => setTimeout(poll, 2000));
    };
    poll();
}

// ============================================
// START BOT
// ============================================
console.log('\n========================================');
console.log('🚀 LEGENDARY TRADING BOT - TWELVE DATA');
console.log('========================================\n');
console.log(`Pairs: ${PAIRS.length}`);
console.log(`Data source: Twelve Data`);
console.log(`API Key: ${CONFIG.TWELVE_DATA_KEY ? '✅ Set' : '❌ NOT SET'}`);
console.log(`Threshold: ${CONFIG.MIN_CONFIDENCE}%\n`);

if (CONFIG.TELEGRAM_TOKEN && CONFIG.TELEGRAM_CHAT_ID) {
    console.log('✅ Telegram connected');
    pollTelegram();
    if (CONFIG.TWELVE_DATA_KEY) startAutoScan();
    sendMessage(`🚀 Bot ACTIVE\n📡 Data: Twelve Data\n✅ ${PAIRS.length} pairs\n✅ /scan for manual scan`);
} else {
    console.log('⚠️ Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
}

module.exports = { scanAllPairs, scanPair, showPairs };
