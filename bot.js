// ============================================
// LEGENDARY TRADING BOT - FINAL WORKING VERSION
// Multi-timeframe: 15min (entry), 1H (trend), 4H (structure)
// Data source: Yahoo Finance (no API key needed)
// ============================================

const { analyzeSignal } = require('./analyzer.js');
const https = require('https');

// ============================================
// TELEGRAM CONFIGURATION
// ============================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ============================================
// LIVE POCKET OPTION PAIRS (ALL SUPPORTED)
// ============================================
const PAIRS = [
    'EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDCHF', 'USDJPY',
    'AUDCAD', 'AUDJPY', 'CADJPY', 'CHFJPY', 'EURAUD', 'EURCAD', 'EURCHF',
    'EURGBP', 'EURJPY', 'EURNZD', 'GBPAUD', 'GBPCAD', 'GBPCHF', 'GBPJPY',
    'GBPNZD', 'NZDCAD', 'NZDJPY', 'AUDNZD', 'CADCHF', 'AUDCHF'
];

// ============================================
// MULTI-TIMEFRAME DATA FETCHING
// ============================================
async function fetchPriceData(pair, interval = '5m', range = '5d') {
    return new Promise((resolve) => {
        const symbol = `${pair}=X`;
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`;
        
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const quotes = json.chart?.result?.[0]?.indicators?.quote?.[0];
                    const timestamps = json.chart?.result?.[0]?.timestamp;
                    
                    if (!quotes || !timestamps || !quotes.open) {
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
// MULTI-TIMEFRAME DATA FOR 15MIN EXPIRY
// ============================================
async function getMultiTimeframeData(pair) {
    // For 15min expiry, we need:
    // - 5min data for entry (converted to 15min candles)
    // - 1H data for trend bias
    // - 4H data for structure
    
    const fiveMinData = await fetchPriceData(pair, '5m', '1d');
    const oneHourData = await fetchPriceData(pair, '30m', '5d');
    const fourHourData = await fetchPriceData(pair, '1h', '10d');
    
    // Convert 5min to 15min candles
    let fifteenMinCandles = null;
    if (fiveMinData && fiveMinData.values) {
        const candles = fiveMinData.values;
        const fifteenMinCandlesArray = [];
        
        for (let i = 0; i < candles.length; i += 3) {
            const group = candles.slice(i, i + 3);
            if (group.length === 3) {
                fifteenMinCandlesArray.push({
                    open: group[0].open,
                    high: Math.max(...group.map(c => c.high)),
                    low: Math.min(...group.map(c => c.low)),
                    close: group[2].close,
                    volume: group.reduce((sum, c) => sum + c.volume, 0),
                    time: group[2].time
                });
            }
        }
        fifteenMinCandles = { values: fifteenMinCandlesArray };
    }
    
    return {
        entry: fifteenMinCandles,    // 15min for entry
        trend: oneHourData,          // 1H for trend bias
        structure: fourHourData      // 4H for structure
    };
}

// ============================================
// SEND TELEGRAM MESSAGE
// ============================================
function sendTelegramMessage(text) {
    if (!TELEGRAM_TOKEN) return;
    
    const data = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: text, parse_mode: 'HTML' });
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    req.write(data);
    req.end();
}

// ============================================
// SCAN SINGLE PAIR WITH MULTI-TIMEFRAME
// ============================================
async function scanSinglePair(pair) {
    try {
        const tfData = await getMultiTimeframeData(pair);
        
        if (!tfData.entry || !tfData.entry.values || tfData.entry.values.length < 50) {
            return null;
        }
        
        // Analyze with multi-timeframe data
        const analysis = await analyzeSignal(
            tfData.entry,                    // 15min entry data
            { pairName: pair },              // Config
            '15m',                           // Timeframe
            tfData.trend || null,            // 1H trend data
            tfData.structure || null         // 4H structure data
        );
        
        return analysis;
    } catch(e) {
        return null;
    }
}

// ============================================
// SCAN ALL PAIRS
// ============================================
async function scanAllPairs(isManual = false) {
    const startTime = Date.now();
    
    if (isManual) {
        sendTelegramMessage(`🔍 Manual scan started...\n📊 ${PAIRS.length} pairs\n⏳ Multi-timeframe analysis (15m/1H/4H)\nPlease wait 2-3 minutes.`);
    }
    
    console.log(`\n🔍 SCANNING ${PAIRS.length} PAIRS at ${new Date().toLocaleTimeString()}`);
    console.log(`📡 Data source: Yahoo Finance`);
    console.log(`⏰ Timeframes: 15min (entry), 1H (trend), 4H (structure)\n`);
    
    let signalsFound = 0;
    let pairsProcessed = 0;
    let lowConfidence = 0;
    
    for (const pair of PAIRS) {
        console.log(`   📊 Analyzing ${pair}...`);
        const analysis = await scanSinglePair(pair);
        
        if (analysis) {
            pairsProcessed++;
            
            if (analysis.signal && analysis.confidence >= 70) {
                signalsFound++;
                console.log(`   ✅ ${pair}: ${analysis.signal} @ ${analysis.confidence}%`);
                
                const arrow = analysis.signal === 'CALL' ? '📈' : '📉';
                const emoji = analysis.confidence >= 90 ? '🏆' : analysis.confidence >= 78 ? '✅' : '⚠️';
                
                const message = `
${emoji} <b>SIGNAL ALERT</b> ${emoji}

<b>Pair:</b> ${pair}
<b>Signal:</b> ${arrow} ${analysis.signal}
<b>Confidence:</b> ${analysis.confidence}% ${analysis.intensity}
<b>Strategy:</b> ${analysis.strategyUsed}

📊 <b>Multi-Timeframe Analysis:</b>
• RSI: ${analysis.rsi} | ADX: ${analysis.adx}
• Divergence: ${analysis.divergence || 'None'}
• Volatility: ${analysis.volatilityPercent}%
• Trend: ${analysis.trendDirection}

⏰ <b>Expiry:</b> ${analysis.expiry || 15}m
                `;
                sendTelegramMessage(message);
            } else if (analysis.confidence >= 55) {
                lowConfidence++;
                console.log(`   ⚠️ ${pair}: ${analysis.signal} @ ${analysis.confidence}% (below 70% threshold)`);
            }
        }
        
        // Delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 500));
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ SCAN COMPLETE: ${signalsFound} signals, ${lowConfidence} low, ${pairsProcessed}/${PAIRS.length} pairs, ${duration}s`);
    
    if (isManual) {
        const summary = `
✅ <b>Scan Complete</b>

📊 <b>Results:</b>
• Signals found: ${signalsFound}
• Low confidence (55-69%): ${lowConfidence}
• Pairs processed: ${pairsProcessed}/${PAIRS.length}
• Duration: ${duration} seconds
• Timeframes: 15min/1H/4H

${signalsFound === 0 ? '💡 No signals met the 70% threshold. Try during London/NY overlap (2-9 PM GMT+6).' : ''}
        `;
        sendTelegramMessage(summary);
    }
    
    return signalsFound;
}

// ============================================
// TELEGRAM COMMAND HANDLER
// ============================================
let lastUpdateId = 0;
let autoScanInterval = null;

function startAutoScan() {
    if (autoScanInterval) {
        sendTelegramMessage('⚠️ Auto-scan is already running.');
        return;
    }
    autoScanInterval = setInterval(() => {
        console.log('🔄 Auto scan triggered');
        scanAllPairs(false);
    }, 15 * 60 * 1000); // Every 15 minutes
    sendTelegramMessage('✅ Auto-scan ENABLED (every 15 minutes)');
    console.log('Auto-scan started');
}

function stopAutoScan() {
    if (autoScanInterval) {
        clearInterval(autoScanInterval);
        autoScanInterval = null;
        sendTelegramMessage('⏸️ Auto-scan DISABLED');
        console.log('Auto-scan stopped');
    }
}

function pollTelegram() {
    if (!TELEGRAM_TOKEN) {
        console.log('⚠️ TELEGRAM_BOT_TOKEN not set');
        return;
    }
    
    const poll = () => {
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`;
        
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.ok && json.result) {
                        for (const update of json.result) {
                            lastUpdateId = update.update_id;
                            const text = update.message?.text;
                            
                            if (text === '/start') {
                                sendTelegramMessage(`
🚀 <b>OmniPocket Trading Bot</b>

<b>Commands:</b>
/start - Show menu
/status - Bot status
/scan - Manual scan
/startscan - Enable auto-scan
/stopscan - Disable auto-scan

<b>Configuration:</b>
• Pairs: ${PAIRS.length}
• Timeframes: 15min/1H/4H
• Expiry: 15 minutes
• Threshold: 70%
• Data: Yahoo Finance
                                `);
                            }
                            else if (text === '/status') {
                                sendTelegramMessage(`
📊 <b>Bot Status</b>

• Pairs: ${PAIRS.length}
• Timeframes: 15min, 1H, 4H
• Threshold: 70%
• Expiry: 15 minutes
• Auto-scan: ${autoScanInterval ? '🟢 ACTIVE' : '🔴 STOPPED'}
• Data source: Yahoo Finance
• Status: RUNNING
                                `);
                            }
                            else if (text === '/scan') {
                                scanAllPairs(true);
                            }
                            else if (text === '/startscan') {
                                startAutoScan();
                            }
                            else if (text === '/stopscan') {
                                stopAutoScan();
                            }
                        }
                    }
                } catch(e) {}
                setTimeout(poll, 2000);
            });
        }).on('error', () => setTimeout(poll, 2000));
    };
    poll();
    console.log('📡 Telegram polling active');
}

// ============================================
// MAIN ENTRY POINT
// ============================================
console.log('\n========================================');
console.log('🚀 LEGENDARY TRADING BOT vFINAL');
console.log('========================================\n');
console.log(`📊 CONFIGURATION:`);
console.log(`   Pairs: ${PAIRS.length}`);
console.log(`   Timeframes: 15min (entry), 1H (trend), 4H (structure)`);
console.log(`   Expiry: 15 minutes`);
console.log(`   Threshold: 70%`);
console.log(`   Data source: Yahoo Finance (no API key needed)`);
console.log(`   Dependencies: NONE (native Node.js only)\n`);

if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    console.log('🤖 Telegram configured');
    pollTelegram();
    startAutoScan();
    sendTelegramMessage(`🚀 <b>Bot is ACTIVE!</b>\n\n📡 Data source: Yahoo Finance\n📊 ${PAIRS.length} pairs monitored\n⏰ Multi-timeframe: 15min/1H/4H\n✅ Send /scan for manual scan\n✅ Auto-scan every 15 minutes`);
} else {
    console.log('⚠️ Telegram not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
    console.log('   Bot will still run but won\'t send messages.');
}

// ============================================
// EXPORTS
// ============================================
module.exports = { scanAllPairs, startAutoScan, stopAutoScan };
