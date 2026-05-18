// ============================================
// LEGENDARY TRADING BOT - ORCHESTRATOR
// Version: FINAL - PRODUCTION READY
// ============================================

const { analyzeSignal, recordTradeOutcome } = require('./analyzer.js');
const fs = require('fs');
const https = require('https');
const yahooFinance = require('yahoo-finance2');

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    MIN_CONFIDENCE_TO_TRADE: 70,
    SCAN_INTERVAL_MS: 60000,
    SAVE_TRADES_TO_FILE: true,
    TRADE_HISTORY_FILE: './trade_history.json'
};

// ============================================
// TELEGRAM CONFIGURATION
// ============================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ============================================
// BOT STATE
// ============================================
let isScanning = true;
let scanIntervalId = null;

// ============================================
// POCKET OPTION SUPPORTED PAIRS (33 pairs)
// ============================================
const POCKET_OPTION_PAIRS = [
    'EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDCHF', 'USDJPY',
    'AUDCAD', 'AUDJPY', 'CADJPY', 'CHFJPY', 'EURAUD', 'EURCAD', 'EURCHF',
    'EURGBP', 'EURJPY', 'EURNZD', 'GBPAUD', 'GBPCAD', 'GBPCHF', 'GBPJPY',
    'GBPNZD', 'NZDCAD', 'NZDJPY', 'USDCNH', 'USDMXN', 'USDTRY', 'USDZAR',
    'AUDNZD', 'CADCHF', 'EURTRY', 'GBPTRY', 'AUDCHF'
];

const pairToYahooSymbol = {
    'EURUSD': 'EURUSD=X', 'GBPUSD': 'GBPUSD=X', 'AUDUSD': 'AUDUSD=X',
    'NZDUSD': 'NZDUSD=X', 'USDCAD': 'USDCAD=X', 'USDCHF': 'USDCHF=X',
    'USDJPY': 'USDJPY=X', 'AUDCAD': 'AUDCAD=X', 'AUDJPY': 'AUDJPY=X',
    'CADJPY': 'CADJPY=X', 'CHFJPY': 'CHFJPY=X', 'EURAUD': 'EURAUD=X',
    'EURCAD': 'EURCAD=X', 'EURCHF': 'EURCHF=X', 'EURGBP': 'EURGBP=X',
    'EURJPY': 'EURJPY=X', 'EURNZD': 'EURNZD=X', 'GBPAUD': 'GBPAUD=X',
    'GBPCAD': 'GBPCAD=X', 'GBPCHF': 'GBPCHF=X', 'GBPJPY': 'GBPJPY=X',
    'GBPNZD': 'GBPNZD=X', 'NZDCAD': 'NZDCAD=X', 'NZDJPY': 'NZDJPY=X',
    'AUDNZD': 'AUDNZD=X', 'CADCHF': 'CADCHF=X', 'AUDCHF': 'AUDCHF=X',
    'USDCNH': 'USDCNH=X', 'USDMXN': 'USDMXN=X', 'USDTRY': 'USDTRY=X',
    'USDZAR': 'USDZAR=X', 'EURTRY': 'EURTRY=X', 'GBPTRY': 'GBPTRY=X'
};

// ============================================
// INITIALIZE FILES
// ============================================
if (!fs.existsSync(CONFIG.TRADE_HISTORY_FILE)) {
    fs.writeFileSync(CONFIG.TRADE_HISTORY_FILE, JSON.stringify([], null, 2));
}

let tradeHistory = [];
try {
    tradeHistory = JSON.parse(fs.readFileSync(CONFIG.TRADE_HISTORY_FILE, 'utf8'));
} catch(e) {}

let lastSignals = {};
let openPositions = [];
let accountBalance = 10000;

// ============================================
// FETCH REAL DATA FROM YAHOO FINANCE
// ============================================
async function fetchRealPriceData(pair) {
    try {
        const symbol = pairToYahooSymbol[pair];
        if (!symbol) return null;
        
        const result = await yahooFinance.chart(symbol, {
            period1: new Date(Date.now() - 24 * 60 * 60 * 1000),
            interval: '5m',
            includeAdjustedClose: false
        });
        
        if (!result || !result.quotes || result.quotes.length < 50) return null;
        
        const candles = result.quotes
            .filter(q => q.open && q.close && q.high && q.low)
            .map(quote => ({
                open: quote.open,
                high: quote.high,
                low: quote.low,
                close: quote.close,
                volume: quote.volume || 1000,
                time: quote.date.getTime()
            }));
        
        return { values: candles };
    } catch(e) {
        return null;
    }
}

// ============================================
// TELEGRAM FUNCTIONS
// ============================================
async function sendTelegramMessage(message) {
    if (!TELEGRAM_TOKEN) return false;
    
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const data = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' });
    
    return new Promise((resolve) => {
        const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
            res.on('end', () => resolve(true));
        });
        req.on('error', () => resolve(false));
        req.write(data);
        req.end();
    });
}

async function sendSignalToTelegram(analysis, pair) {
    const arrow = analysis.signal === 'CALL' ? '📈' : '📉';
    const emoji = analysis.confidence >= 90 ? '🏆' : analysis.confidence >= 78 ? '✅' : '⚠️';
    
    const message = `
${emoji} <b>SIGNAL ALERT</b> ${emoji}

<b>Pair:</b> ${pair}
<b>Signal:</b> ${arrow} ${analysis.signal}
<b>Confidence:</b> ${analysis.confidence}% ${analysis.intensity}
<b>Strategy:</b> ${analysis.strategyUsed}

📊 <b>Analysis:</b>
• RSI: ${analysis.rsi} | ADX: ${analysis.adx}
• Divergence: ${analysis.divergence || 'None'}
• Volatility: ${analysis.volatilityPercent}%

⏰ <b>Expiry:</b> ${analysis.expiry}m
    `;
    await sendTelegramMessage(message);
}

// ============================================
// SCAN ALL PAIRS
// ============================================
async function scanAllPairs(isManual = false) {
    if (isManual) {
        await sendTelegramMessage('🔍 <b>Manual scan initiated...</b>\n\nScanning all 33 pairs...\n⏳ This will take 30-60 seconds.');
    }
    
    console.log(`\n🔍 SCANNING ${POCKET_OPTION_PAIRS.length} PAIRS...`);
    
    let signalsFound = 0;
    let lowConfidence = 0;
    
    for (const pair of POCKET_OPTION_PAIRS) {
        try {
            const priceData = await fetchRealPriceData(pair);
            if (!priceData) continue;
            
            const config = { pairName: pair };
            const analysis = await analyzeSignal(priceData, config, '15m', null, null, openPositions);
            
            if (analysis && analysis.signal) {
                if (analysis.confidence >= CONFIG.MIN_CONFIDENCE_TO_TRADE) {
                    const lastTime = lastSignals[pair] || 0;
                    if (Date.now() - lastTime > 1800000 || isManual) {
                        signalsFound++;
                        lastSignals[pair] = Date.now();
                        await sendSignalToTelegram(analysis, pair);
                        console.log(`   ✅ ${pair}: ${analysis.signal} @ ${analysis.confidence}%`);
                    }
                } else if (analysis.confidence >= 55) {
                    lowConfidence++;
                    console.log(`   ⚠️ ${pair}: ${analysis.signal} @ ${analysis.confidence}% (below threshold)`);
                }
            }
            
            await new Promise(resolve => setTimeout(resolve, 100));
        } catch(e) {}
    }
    
    if (isManual) {
        const message = `
✅ <b>Scan Complete</b>

📊 <b>Results:</b>
• Signals found: ${signalsFound}
• Low confidence (50-69%): ${lowConfidence}
• Pairs scanned: ${POCKET_OPTION_PAIRS.length}

${signalsFound === 0 ? '💡 <i>No signals met the 70% threshold. Try during London/NY overlap (2-9 PM GMT+6).</i>' : ''}
        `;
        await sendTelegramMessage(message);
    }
    
    return signalsFound;
}

// ============================================
// AUTO-SCAN CONTROLS
// ============================================
function startAutoScan() {
    if (scanIntervalId) {
        sendTelegramMessage('⚠️ Auto-scan is already running.');
        return;
    }
    
    isScanning = true;
    scanIntervalId = setInterval(async () => {
        if (isScanning) await scanAllPairs(false);
    }, CONFIG.SCAN_INTERVAL_MS);
    
    sendTelegramMessage('✅ <b>Auto-scan ENABLED</b>\n\nBot will scan every minute.');
    console.log('Auto-scan started');
}

function stopAutoScan() {
    if (scanIntervalId) {
        clearInterval(scanIntervalId);
        scanIntervalId = null;
    }
    isScanning = false;
    sendTelegramMessage('⏸️ <b>Auto-scan DISABLED</b>\n\nUse /scan for manual scan.');
    console.log('Auto-scan stopped');
}

// ============================================
// COMMAND HANDLER
// ============================================
async function handleTelegramCommand(text) {
    const cmd = text.toLowerCase();
    
    if (cmd === '/start') {
        await sendTelegramMessage(`
🚀 <b>OmniPocket Trading Bot</b>

<b>Commands:</b>
/start - Show menu
/status - Bot status
/scan - Manual scan
/startscan - Enable auto-scan
/stopscan - Disable auto-scan

<b>Status:</b>
Auto-scan: ${isScanning ? '🟢 ACTIVE' : '🔴 STOPPED'}
Pairs: ${POCKET_OPTION_PAIRS.length}
Threshold: ${CONFIG.MIN_CONFIDENCE_TO_TRADE}%
        `);
    }
    else if (cmd === '/status') {
        const winRate = tradeHistory.length ? (tradeHistory.filter(t => t.wasWin).length / tradeHistory.length * 100).toFixed(1) : '0';
        await sendTelegramMessage(`
📊 <b>Bot Status</b>

• Auto-scan: ${isScanning ? '🟢 ACTIVE' : '🔴 STOPPED'}
• Win Rate: ${winRate}%
• Total Trades: ${tradeHistory.length}
• Pairs: ${POCKET_OPTION_PAIRS.length}
• Threshold: ${CONFIG.MIN_CONFIDENCE_TO_TRADE}%
        `);
    }
    else if (cmd === '/scan') {
        await scanAllPairs(true);
    }
    else if (cmd === '/startscan') {
        startAutoScan();
    }
    else if (cmd === '/stopscan') {
        stopAutoScan();
    }
}

// ============================================
// TELEGRAM POLLING
// ============================================
async function pollTelegram() {
    if (!TELEGRAM_TOKEN) return;
    
    let lastUpdateId = 0;
    
    const poll = async () => {
        try {
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
                                if (update.message && update.message.text) {
                                    handleTelegramCommand(update.message.text);
                                }
                            }
                        }
                    } catch(e) {}
                });
            });
            req.on('error', () => {});
            req.end();
        } catch(e) {}
        setTimeout(poll, 2000);
    };
    poll();
}

// ============================================
// GET STATISTICS
// ============================================
function getStatistics() {
    const totalTrades = tradeHistory.length;
    const winningTrades = tradeHistory.filter(t => t.wasWin).length;
    const winRate = totalTrades > 0 ? (winningTrades / totalTrades * 100).toFixed(1) : '0';
    return { totalTrades, winningTrades, winRate, currentBalance: accountBalance.toFixed(2) };
}

// ============================================
// MAIN
// ============================================
if (require.main === module) {
    console.log('\n========================================');
    console.log('🚀 LEGENDARY TRADING BOT vFINAL');
    console.log('========================================\n');
    
    console.log(`📊 CONFIGURATION:`);
    console.log(`   Pairs: ${POCKET_OPTION_PAIRS.length}`);
    console.log(`   Threshold: ${CONFIG.MIN_CONFIDENCE_TO_TRADE}%`);
    console.log(`   Interval: ${CONFIG.SCAN_INTERVAL_MS / 1000}s\n`);
    
    if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
        console.log('🤖 Telegram Bot configured');
        pollTelegram();
        startAutoScan();
        sendTelegramMessage('🚀 <b>OmniPocket Bot is ACTIVE!</b>\n\n✅ Auto-scan ENABLED\n✅ Use /scan for manual scan\n✅ Use /stopscan to disable auto-scan');
    } else {
        console.log('⚠️ Telegram not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
    }
}

module.exports = { scanAllPairs, getStatistics, startAutoScan, stopAutoScan };
