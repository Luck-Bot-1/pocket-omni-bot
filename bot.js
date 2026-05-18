// ============================================
// LEGENDARY TRADING BOT - ORCHESTRATOR
// Version: FINAL - WITH REAL DATA + START/STOP
// ============================================

const { analyzeSignal, recordTradeOutcome } = require('./analyzer.js');
const fs = require('fs');
const https = require('https');
const yahooFinance = require('yahoo-finance2');

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    MAX_POSITION_SIZE_PERCENT: 2.0,
    MIN_POSITION_SIZE_PERCENT: 0.5,
    MAX_CORRELATION_EXPOSURE: 0.65,
    MAX_CONCURRENT_TRADES: 3,
    MIN_CONFIDENCE_TO_TRADE: 70,
    BROKER_SPREAD_PIPS: 1.5,
    BROKER_PAYOUT_PERCENT: 78,
    SAVE_TRADES_TO_FILE: true,
    TRADE_HISTORY_FILE: './trade_history.json',
    SCAN_INTERVAL_MS: 60000  // 1 minute between scans
};

// ============================================
// TELEGRAM CONFIGURATION
// ============================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ============================================
// BOT STATE (Start/Stop Control)
// ============================================
let isScanning = true;  // Auto-scanning enabled by default
let scanIntervalId = null;

// ============================================
// POCKET OPTION SUPPORTED PAIRS (35+ pairs)
// ============================================
const POCKET_OPTION_PAIRS = [
    'EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDCHF', 'USDJPY',
    'AUDCAD', 'AUDJPY', 'CADJPY', 'CHFJPY', 'EURAUD', 'EURCAD', 'EURCHF',
    'EURGBP', 'EURJPY', 'EURNZD', 'GBPAUD', 'GBPCAD', 'GBPCHF', 'GBPJPY',
    'GBPNZD', 'NZDCAD', 'NZDJPY', 'USDCNH', 'USDMXN', 'USDTRY', 'USDZAR',
    'AUDNZD', 'CADCHF', 'EURTRY', 'GBPTRY', 'AUDCHF'
];

// Map to Yahoo Finance symbols
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
// SAFE FILE INITIALIZATION
// ============================================
function ensureTradeHistoryExists() {
    if (!fs.existsSync(CONFIG.TRADE_HISTORY_FILE)) {
        try {
            fs.writeFileSync(CONFIG.TRADE_HISTORY_FILE, JSON.stringify([], null, 2));
        } catch(e) {}
    }
}
ensureTradeHistoryExists();

// ============================================
// STATE MANAGEMENT
// ============================================
let accountBalance = 10000;
let openPositions = [];
let tradeHistory = [];
let lastSignals = {};

try {
    if (fs.existsSync(CONFIG.TRADE_HISTORY_FILE)) {
        const data = fs.readFileSync(CONFIG.TRADE_HISTORY_FILE, 'utf8');
        tradeHistory = JSON.parse(data);
    }
} catch(e) {}

// ============================================
// CORRELATION MATRIX (Simplified)
// ============================================
const CORRELATION_MATRIX = {
    'EURUSD': { 'GBPUSD': 0.88, 'AUDUSD': 0.82, 'USDCHF': -0.85 },
    'GBPUSD': { 'EURUSD': 0.88, 'AUDUSD': 0.75, 'USDCHF': -0.78 },
    'AUDUSD': { 'EURUSD': 0.82, 'GBPUSD': 0.75, 'AUDCAD': 0.85 },
    'USDCAD': { 'AUDUSD': -0.68, 'AUDCAD': 0.72 },
    'USDCHF': { 'EURUSD': -0.85, 'GBPUSD': -0.78 },
    'AUDCAD': { 'AUDUSD': 0.85, 'USDCAD': 0.72 },
    'GBPCHF': { 'GBPUSD': 0.80, 'USDCHF': -0.78 },
    'AUDCHF': { 'AUDUSD': 0.72, 'USDCHF': -0.70 }
};

function getCorrelation(pair1, pair2) {
    try {
        return CORRELATION_MATRIX[pair1]?.[pair2] || CORRELATION_MATRIX[pair2]?.[pair1] || 0;
    } catch(e) {
        return 0;
    }
}

// ============================================
// REAL DATA FETCHER (YAHOO FINANCE)
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
        
        const candles = result.quotes.map(quote => ({
            open: quote.open,
            high: quote.high,
            low: quote.low,
            close: quote.close,
            volume: quote.volume || 1000,
            time: quote.date.getTime()
        })).filter(c => c.open && c.close && c.high && c.low);
        
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
    const data = JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML'
    });
    
    return new Promise((resolve) => {
        const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
            res.on('end', () => resolve(true));
        });
        req.on('error', () => resolve(false));
        req.write(data);
        req.end();
    });
}

// Send signal to Telegram
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
// SCAN ALL PAIRS (REAL DATA ONLY)
// ============================================
async function scanAllPairs(isManual = false) {
    if (isManual) {
        await sendTelegramMessage('🔍 <b>Manual scan initiated...</b>\n\nScanning all pairs for signals...');
    }
    
    console.log(`\n🔍 SCANNING ${POCKET_OPTION_PAIRS.length} PAIRS...`);
    
    let signalsFound = 0;
    
    for (const pair of POCKET_OPTION_PAIRS) {
        try {
            const priceData = await fetchRealPriceData(pair);
            if (!priceData || !priceData.values || priceData.values.length < 50) continue;
            
            const config = { pairName: pair };
            const analysis = await analyzeSignal(priceData, config, '15m', null, null, openPositions);
            
            if (analysis && analysis.signal && analysis.confidence >= CONFIG.MIN_CONFIDENCE_TO_TRADE) {
                const lastSignalTime = lastSignals[pair] || 0;
                const timeSinceLastSignal = Date.now() - lastSignalTime;
                
                // 30 minute cooldown to prevent spam
                if (timeSinceLastSignal > 1800000 || isManual) {
                    signalsFound++;
                    lastSignals[pair] = Date.now();
                    await sendSignalToTelegram(analysis, pair);
                    console.log(`   ✅ ${pair}: ${analysis.signal} @ ${analysis.confidence}%`);
                }
            }
        } catch(e) {
            // Silent fail for individual pairs
        }
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    if (isManual) {
        await sendTelegramMessage(`✅ <b>Manual scan complete</b>\n\nFound ${signalsFound} signal(s).`);
    }
    
    return signalsFound;
}

// ============================================
// START AUTO-SCANNING
// ============================================
function startAutoScan() {
    if (scanIntervalId) {
        sendTelegramMessage('⚠️ Auto-scan is already running.');
        return;
    }
    
    isScanning = true;
    scanIntervalId = setInterval(async () => {
        if (isScanning) {
            await scanAllPairs(false);
        }
    }, CONFIG.SCAN_INTERVAL_MS);
    
    sendTelegramMessage('✅ <b>Auto-scan ENABLED</b>\n\nBot will scan every minute and send signals automatically.');
    console.log('Auto-scan started');
}

// ============================================
// STOP AUTO-SCANNING
// ============================================
function stopAutoScan() {
    if (scanIntervalId) {
        clearInterval(scanIntervalId);
        scanIntervalId = null;
    }
    
    isScanning = false;
    sendTelegramMessage('⏸️ <b>Auto-scan DISABLED</b>\n\nBot will no longer scan automatically. Use /scan to manual scan.');
    console.log('Auto-scan stopped');
}

// ============================================
// TELEGRAM COMMAND HANDLER
// ============================================
async function handleTelegramCommand(text) {
    const cmd = text.toLowerCase();
    
    if (cmd === '/start') {
        const welcome = `
🚀 <b>OmniPocket Trading Bot</b>

<b>Commands:</b>
/start - Show this menu
/status - Show bot status
/scan - Manual scan (one time)
/startscan - Enable auto-scanning
/stopscan - Disable auto-scanning
/help - Show help

<b>Current Status:</b>
Auto-scan: ${isScanning ? '🟢 ACTIVE' : '🔴 STOPPED'}
Pairs monitored: ${POCKET_OPTION_PAIRS.length}
Min confidence: ${CONFIG.MIN_CONFIDENCE_TO_TRADE}%
        `;
        await sendTelegramMessage(welcome);
    }
    else if (cmd === '/status') {
        const stats = getStatistics();
        const status = `
📊 <b>Bot Status</b>

• Auto-scan: ${isScanning ? '🟢 ACTIVE' : '🔴 STOPPED'}
• Win Rate: ${stats.winRate}%
• Total Trades: ${stats.totalTrades}
• Balance: $${stats.currentBalance}
• Return: ${stats.totalReturn}%
• Pairs: ${POCKET_OPTION_PAIRS.length}
        `;
        await sendTelegramMessage(status);
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
    else if (cmd === '/help') {
        const help = `
📖 <b>Help Guide</b>

<b>/start</b> - Show main menu
<b>/status</b> - Show bot performance
<b>/scan</b> - Manual scan (instant)
<b>/startscan</b> - Enable auto-scanning
<b>/stopscan</b> - Disable auto-scanning

<b>How it works:</b>
1. Bot scans ${POCKET_OPTION_PAIRS.length} currency pairs
2. When high-confidence signal found → you receive alert
3. You decide to trade or skip

<b>Signal Types:</b>
📈 CALL - Price expected UP
📉 PUT - Price expected DOWN

<b>Confidence Levels:</b>
🏆 90%+ - LEGENDARY
✅ 78%+ - STRONG
⚠️ 70%+ - MODERATE
        `;
        await sendTelegramMessage(help);
    }
}

// ============================================
// TELEGRAM POLLING
// ============================================
async function pollTelegram() {
    if (!TELEGRAM_TOKEN) return;
    
    let lastUpdateId = 0;
    
    async function poll() {
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
    }
    
    poll();
}

// ============================================
// POSITION SIZING
// ============================================
function calculatePositionSize(confidence, volatilityPercent, accountBalance) {
    try {
        const winProb = confidence / 100;
        const lossProb = 1 - winProb;
        const payoutOdds = CONFIG.BROKER_PAYOUT_PERCENT / 100;
        
        let kellyFraction = (winProb * payoutOdds - lossProb) / payoutOdds;
        let positionFraction = Math.max(0, kellyFraction * 0.5);
        
        positionFraction = Math.min(0.02, Math.max(0.005, positionFraction));
        
        return {
            fraction: positionFraction,
            amount: accountBalance * positionFraction,
            kellyFraction: kellyFraction
        };
    } catch(e) {
        return { fraction: 0.01, amount: accountBalance * 0.01, kellyFraction: 0 };
    }
}

// ============================================
// GET STATISTICS
// ============================================
function getStatistics() {
    try {
        const totalTrades = tradeHistory.length;
        const winningTrades = tradeHistory.filter(t => t.wasWin).length;
        const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
        const totalProfit = tradeHistory.reduce((sum, t) => sum + (t.profitAmount || 0), 0);
        
        return {
            totalTrades, 
            winningTrades, 
            losingTrades: totalTrades - winningTrades,
            winRate: winRate.toFixed(1), 
            totalProfit: totalProfit.toFixed(2),
            currentBalance: accountBalance.toFixed(2), 
            totalReturn: ((accountBalance - 10000) / 10000 * 100).toFixed(1),
            openPositions: openPositions.length
        };
    } catch(e) {
        return {
            totalTrades: 0, winningTrades: 0, losingTrades: 0,
            winRate: '0', totalProfit: '0',
            currentBalance: accountBalance.toFixed(2), totalReturn: '0',
            openPositions: 0
        };
    }
}

// ============================================
// TRADING LOOP
// ============================================
async function tradingLoop(priceData, config, tf, higherPriceData = null, lowerPriceData = null) {
    if (!priceData || !priceData.values) {
        return { success: false, reason: 'Invalid priceData' };
    }
    
    try {
        const analysis = await analyzeSignal(priceData, config, tf, higherPriceData, lowerPriceData, openPositions);
        
        if (!analysis || !analysis.signal || analysis.confidence < CONFIG.MIN_CONFIDENCE_TO_TRADE) {
            return { success: false, reason: 'No valid signal' };
        }
        
        const positionSize = calculatePositionSize(analysis.confidence, parseFloat(analysis.volatilityPercent) || 0.15, accountBalance);
        
        return { success: true, analysis, positionSize };
    } catch(error) {
        return { success: false, reason: error.message };
    }
}

// ============================================
// CLOSE TRADE
// ============================================
async function closeTrade(orderId, wasWin, profitPercent) {
    const position = openPositions.find(p => p.orderId === orderId);
    if (!position) return { success: false };
    
    const profitAmount = wasWin ? position.amount * (CONFIG.BROKER_PAYOUT_PERCENT / 100) : -position.amount;
    accountBalance += profitAmount;
    
    try {
        recordTradeOutcome(position.strategy, position.confidence, wasWin, profitPercent, position.pair, `${position.expiryMinutes}m`);
    } catch(e) {}
    
    tradeHistory.push({ ...position, closeTime: Date.now(), wasWin, profitAmount });
    openPositions = openPositions.filter(p => p.orderId !== orderId);
    
    if (CONFIG.SAVE_TRADES_TO_FILE) {
        fs.writeFileSync(CONFIG.TRADE_HISTORY_FILE, JSON.stringify(tradeHistory, null, 2));
    }
    
    return { success: true, profitAmount, newBalance: accountBalance };
}

// ============================================
// MAIN ENTRY POINT
// ============================================
if (require.main === module) {
    console.log('\n========================================');
    console.log('🚀 LEGENDARY TRADING BOT vFINAL');
    console.log('========================================\n');
    
    console.log(`📊 CONFIGURATION:`);
    console.log(`   Pairs: ${POCKET_OPTION_PAIRS.length}`);
    console.log(`   Min Confidence: ${CONFIG.MIN_CONFIDENCE_TO_TRADE}%`);
    console.log(`   Scan Interval: ${CONFIG.SCAN_INTERVAL_MS / 1000}s\n`);
    
    if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
        console.log('🤖 Telegram Bot configured');
        pollTelegram();
        
        // Start auto-scanning by default
        startAutoScan();
        
        sendTelegramMessage('🚀 <b>OmniPocket Bot is ACTIVE!</b>\n\n✅ Using REAL Yahoo Finance data\n✅ Auto-scan ENABLED\n✅ Use /stopscan to disable, /startscan to enable\n✅ Use /scan for manual scan');
    } else {
        console.log('⚠️ Telegram not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
    }
}

// ============================================
// EXPORTS
// ============================================
module.exports = { 
    tradingLoop, 
    scanAllPairs,
    getStatistics, 
    closeTrade, 
    startAutoScan,
    stopAutoScan,
    openPositions, 
    accountBalance,
    CONFIG
};
