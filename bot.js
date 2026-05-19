// ============================================
// LEGENDARY TRADING BOT - PERMANENT VERSION
// NO MORE CHANGES NEEDED AFTER THIS
// ============================================

const { analyzeSignal } = require('./analyzer.js');
const https = require('https');

// ============================================
// CONFIGURATION (CHANGE ONLY THESE NUMBERS IF NEEDED)
// ============================================
const CONFIG = {
    MIN_CONFIDENCE: 70,           // Minimum confidence to send signal
    AUTO_SCAN_INTERVAL: 30,       // Minutes between auto-scans
    EXPIRY_MINUTES: 15,           // Binary option expiry
    DELAY_BETWEEN_PAIRS: 2000,    // Milliseconds between API calls
    TELEGRAM_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID
};

// ============================================
// ALL POCKET OPTION LIVE PAIRS (30 PAIRS)
// ============================================
const PAIRS = [
    'EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDCHF', 'USDJPY',
    'AUDCAD', 'AUDJPY', 'CADJPY', 'CHFJPY', 'EURAUD', 'EURCAD', 'EURCHF',
    'EURGBP', 'EURJPY', 'EURNZD', 'GBPAUD', 'GBPCAD', 'GBPCHF', 'GBPJPY',
    'GBPNZD', 'NZDCAD', 'NZDJPY', 'AUDNZD', 'CADCHF', 'AUDCHF',
    'USDCNH', 'USDMXN', 'USDZAR'
];

// ============================================
// FETCH FROM YAHOO FINANCE (NO API KEY NEEDED)
// ============================================
async function fetchYahooData(pair, interval = '5m', range = '5d') {
    return new Promise((resolve) => {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${pair}=X?interval=${interval}&range=${range}`;
        
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const quotes = json.chart?.result?.[0]?.indicators?.quote?.[0];
                    const timestamps = json.chart?.result?.[0]?.timestamp;
                    
                    if (!quotes?.open || !timestamps) {
                        resolve(null);
                        return;
                    }
                    
                    const candles = [];
                    for (let i = 0; i < timestamps.length; i++) {
                        if (quotes.open[i] && quotes.high[i] && quotes.low[i] && quotes.close[i]) {
                            candles.push({
                                open: quotes.open[i],
                                high: quotes.high[i],
                                low: quotes.low[i],
                                close: quotes.close[i],
                                volume: quotes.volume?.[i] || 1000,
                                time: timestamps[i] * 1000
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
// CONVERT 5MIN TO 15MIN CANDLES
// ============================================
function convertTo15Min(fiveMinData) {
    if (!fiveMinData?.values) return null;
    const candles = [];
    for (let i = 0; i < fiveMinData.values.length; i += 3) {
        const group = fiveMinData.values.slice(i, i + 3);
        if (group.length === 3) {
            candles.push({
                open: group[0].open,
                high: Math.max(...group.map(c => c.high)),
                low: Math.min(...group.map(c => c.low)),
                close: group[2].close,
                volume: group.reduce((s, c) => s + c.volume, 0),
                time: group[2].time
            });
        }
    }
    return { values: candles };
}

// ============================================
// GET MULTI-TIMEFRAME DATA (15min, 1H, 4H)
// ============================================
async function getMultiTimeframeData(pair) {
    const fiveMin = await fetchYahooData(pair, '5m', '1d');
    const oneHour = await fetchYahooData(pair, '30m', '5d');
    const fourHour = await fetchYahooData(pair, '1h', '10d');
    
    return {
        entry: convertTo15Min(fiveMin),
        trend: oneHour,
        structure: fourHour
    };
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
        if (!tfData.entry?.values?.length >= 30) return null;
        
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
    const upperPair = pair.toUpperCase();
    sendMessage(`🔍 Analyzing ${upperPair}...`);
    const analysis = await analyzePair(upperPair);
    
    if (!analysis) {
        sendMessage(`❌ Could not analyze ${upperPair}`);
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
    sendMessage(`🔍 Scanning ${PAIRS.length} pairs...`);
    let signals = [];
    let processed = 0;
    
    for (let i = 0; i < PAIRS.length; i++) {
        const pair = PAIRS[i];
        console.log(`[${i+1}/${PAIRS.length}] ${pair}...`);
        
        const analysis = await analyzePair(pair);
        if (analysis) processed++;
        
        if (analysis?.confidence >= CONFIG.MIN_CONFIDENCE) {
            signals.push({ pair, analysis });
            const arrow = analysis.signal === 'CALL' ? '📈' : '📉';
            sendMessage(`${arrow} ${pair}: ${analysis.signal} @ ${analysis.confidence}%`);
        }
        
        if (i < PAIRS.length - 1) {
            await new Promise(r => setTimeout(r, CONFIG.DELAY_BETWEEN_PAIRS));
        }
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
let isScanning = false;

function startAutoScan() {
    if (autoScanInterval) return;
    autoScanInterval = setInterval(() => {
        if (!isScanning) {
            isScanning = true;
            scanAllPairs().finally(() => { isScanning = false; });
        }
    }, CONFIG.AUTO_SCAN_INTERVAL * 60 * 1000);
    sendMessage(`✅ Auto-scan enabled (every ${CONFIG.AUTO_SCAN_INTERVAL} minutes)`);
}

function stopAutoScan() {
    if (autoScanInterval) {
        clearInterval(autoScanInterval);
        autoScanInterval = null;
    }
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
🚀 <b>OmniPocket Trading Bot</b>

<b>Commands:</b>
/scan - Scan all pairs
/scan PAIR - Scan specific pair (e.g., /scan EURUSD)
/pairs - Show available pairs
/startscan - Enable auto-scan
/stopscan - Disable auto-scan
/status - Bot status

<b>Settings:</b>
Pairs: ${PAIRS.length}
Threshold: ${CONFIG.MIN_CONFIDENCE}%
Expiry: ${CONFIG.EXPIRY_MINUTES}m
Data: Yahoo Finance (no API key)
                                `);
                            }
                            else if (text === '/pairs') showPairs();
                            else if (text === '/status') {
                                sendMessage(`✅ Bot running\nPairs: ${PAIRS.length}\nAuto-scan: ${autoScanInterval ? 'ON' : 'OFF'}\nThreshold: ${CONFIG.MIN_CONFIDENCE}%\nExpiry: ${CONFIG.EXPIRY_MINUTES}m`);
                            }
                            else if (text === '/startscan') startAutoScan();
                            else if (text === '/stopscan') stopAutoScan();
                            else if (text === '/scan') {
                                if (!isScanning) {
                                    isScanning = true;
                                    scanAllPairs().finally(() => { isScanning = false; });
                                } else {
                                    sendMessage(`⏳ Scan already in progress.`);
                                }
                            }
                            else if (text.startsWith('/scan ')) {
                                scanPair(text.substring(6));
                            }
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
console.log('🚀 LEGENDARY TRADING BOT - PERMANENT');
console.log('========================================\n');
console.log(`Pairs: ${PAIRS.length}`);
console.log(`Data source: Yahoo Finance (no API key)`);
console.log(`Threshold: ${CONFIG.MIN_CONFIDENCE}%`);
console.log(`Expiry: ${CONFIG.EXPIRY_MINUTES}m`);
console.log(`Auto-scan: every ${CONFIG.AUTO_SCAN_INTERVAL} minutes`);
console.log(`Delay between pairs: ${CONFIG.DELAY_BETWEEN_PAIRS/1000}s\n`);

if (CONFIG.TELEGRAM_TOKEN && CONFIG.TELEGRAM_CHAT_ID) {
    console.log('✅ Telegram connected');
    pollTelegram();
    startAutoScan();
    sendMessage(`🚀 Bot ACTIVE\n✅ ${PAIRS.length} pairs\n✅ /scan for manual scan\n✅ Auto-scan every ${CONFIG.AUTO_SCAN_INTERVAL} min`);
} else {
    console.log('⚠️ Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
}

module.exports = { scanAllPairs, scanPair, showPairs };
