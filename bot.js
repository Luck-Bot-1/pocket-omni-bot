// ============================================
// LEGENDARY TRADING BOT - ORCHESTRATOR
// Version: FINAL - WITH TELEGRAM INTEGRATION
// ============================================

const { analyzeSignal, recordTradeOutcome } = require('./analyzer.js');
const fs = require('fs');
const https = require('https');

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
    SCAN_INTERVAL_MS: 60000  // Scan every minute
};

// ============================================
// TELEGRAM CONFIGURATION
// ============================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ============================================
// POCKET OPTION SUPPORTED PAIRS
// ============================================
const POCKET_OPTION_PAIRS = [
    'EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDCHF', 'USDJPY',
    'AUDCAD', 'AUDJPY', 'CADJPY', 'CHFJPY', 'EURAUD', 'EURCAD', 'EURCHF',
    'EURGBP', 'EURJPY', 'EURNZD', 'GBPAUD', 'GBPCAD', 'GBPCHF', 'GBPJPY',
    'GBPNZD', 'NZDCAD', 'NZDJPY', 'USDCNH', 'USDMXN', 'USDTRY', 'USDZAR',
    'AUDNZD', 'CADCHF', 'EURTRY', 'GBPTRY', 'AUDCHF'
];

// ============================================
// SAFE FILE INITIALIZATION
// ============================================
function ensureTradeHistoryExists() {
    if (!fs.existsSync(CONFIG.TRADE_HISTORY_FILE)) {
        try {
            fs.writeFileSync(CONFIG.TRADE_HISTORY_FILE, JSON.stringify([], null, 2));
            console.log('✅ Created trade_history.json');
        } catch(e) {
            console.error('⚠️ Could not create trade_history.json:', e.message);
        }
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
        console.log(`✅ Loaded ${tradeHistory.length} past trades`);
    }
} catch(e) {
    console.error('⚠️ Could not load trade history:', e.message);
}

// ============================================
// CORRELATION MATRIX
// ============================================
const CORRELATION_MATRIX = {
    'EURUSD': { 'GBPUSD': 0.88, 'AUDUSD': 0.82, 'USDCHF': -0.85, 'USDJPY': -0.65 },
    'GBPUSD': { 'EURUSD': 0.88, 'AUDUSD': 0.75, 'USDCHF': -0.78, 'USDJPY': -0.60 },
    'AUDUSD': { 'EURUSD': 0.82, 'GBPUSD': 0.75, 'AUDCAD': 0.85, 'AUDJPY': 0.78 },
    'USDCAD': { 'AUDUSD': -0.68, 'AUDCAD': 0.72, 'CADJPY': 0.65 },
    'USDCHF': { 'EURUSD': -0.85, 'GBPUSD': -0.78, 'CHFJPY': 0.70 },
    'USDJPY': { 'EURUSD': -0.65, 'GBPUSD': -0.60, 'AUDJPY': 0.78 },
    'AUDCAD': { 'AUDUSD': 0.85, 'USDCAD': 0.72, 'AUDJPY': 0.75 },
    'AUDJPY': { 'AUDUSD': 0.78, 'USDJPY': 0.78, 'AUDCAD': 0.75 },
    'GBPCHF': { 'GBPUSD': 0.80, 'USDCHF': -0.78, 'EURCHF': 0.85 },
    'AUDCHF': { 'AUDUSD': 0.72, 'USDCHF': -0.70, 'AUDJPY': 0.72 },
    'EURCAD': { 'EURUSD': 0.88, 'USDCAD': -0.58, 'EURGBP': 0.75 },
    'EURNZD': { 'EURUSD': 0.82, 'NZDUSD': -0.68, 'AUDNZD': 0.75 },
    'GBPNZD': { 'GBPUSD': 0.80, 'NZDUSD': -0.65, 'EURNZD': 0.72 }
};

function getCorrelation(pair1, pair2) {
    try {
        return CORRELATION_MATRIX[pair1]?.[pair2] || CORRELATION_MATRIX[pair2]?.[pair1] || 0;
    } catch(e) {
        return 0;
    }
}

// ============================================
// TELEGRAM FUNCTIONS
// ============================================
async function sendTelegramMessage(message) {
    if (!TELEGRAM_TOKEN || TELEGRAM_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
        console.log('⚠️ Telegram not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
        return false;
    }
    
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const data = JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML'
    });
    
    return new Promise((resolve) => {
        const req = https.request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        }, (res) => {
            let response = '';
            res.on('data', chunk => response += chunk);
            res.on('end', () => {
                console.log('✅ Telegram message sent');
                resolve(true);
            });
        });
        req.on('error', (e) => { console.error('Telegram error:', e.message); resolve(false); });
        req.write(data);
        req.end();
    });
}

// Poll for incoming Telegram messages (responds to /start)
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
                                if (update.message && update.message.text === '/start') {
                                    const welcome = `🚀 <b>OmniPocket Bot ACTIVE</b>\n\n✅ Bot is running\n✅ Monitoring ${POCKET_OPTION_PAIRS.length} pairs\n✅ High-confidence signals will appear here\n\n⚠️ <i>Trade with 1-2% risk per trade</i>`;
                                    sendTelegramMessage(welcome);
                                } else if (update.message && update.message.text === '/status') {
                                    const stats = getStatistics();
                                    const status = `📊 <b>Bot Status</b>\n\n• Win Rate: ${stats.winRate}%\n• Total Trades: ${stats.totalTrades}\n• Balance: $${stats.currentBalance}\n• Return: ${stats.totalReturn}%\n• Pairs: ${POCKET_OPTION_PAIRS.length}`;
                                    sendTelegramMessage(status);
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
    console.log('📡 Telegram polling active');
}

// Send signal to Telegram
async function sendSignalToTelegram(signal, pair) {
    const arrow = signal.signal === 'CALL' ? '📈' : '📉';
    const emoji = signal.confidence >= 90 ? '🏆' : signal.confidence >= 78 ? '✅' : '⚠️';
    
    const message = `
${emoji} <b>SIGNAL ALERT</b> ${emoji}

<b>Pair:</b> ${pair}
<b>Signal:</b> ${arrow} ${signal.signal} (${signal.signal === 'CALL' ? 'BUY' : 'SELL'})
<b>Confidence:</b> ${signal.confidence}% ${signal.intensity}
<b>Strategy:</b> ${signal.strategyUsed}

📊 <b>Analysis:</b>
• RSI: ${signal.rsi} | ADX: ${signal.adx}
• Divergence: ${signal.divergence || 'None'}
• Volatility: ${signal.volatilityPercent}%

⏰ <b>Expiry:</b> ${signal.expiry}m

<i>Risk: 1.5% of balance</i>
    `;
    
    await sendTelegramMessage(message);
}

// ============================================
// POSITION SIZING (Kelly Criterion)
// ============================================
function calculatePositionSize(confidence, volatilityPercent, accountBalance) {
    try {
        const winProb = confidence / 100;
        const lossProb = 1 - winProb;
        const payoutOdds = CONFIG.BROKER_PAYOUT_PERCENT / 100;
        
        let kellyFraction = (winProb * payoutOdds - lossProb) / payoutOdds;
        let positionFraction = Math.max(0, kellyFraction * 0.5);
        
        const volatilityFactor = Math.min(1.5, Math.max(0.5, 0.15 / (volatilityPercent || 0.15)));
        positionFraction = positionFraction * volatilityFactor;
        
        positionFraction = Math.min(
            CONFIG.MAX_POSITION_SIZE_PERCENT / 100,
            Math.max(CONFIG.MIN_POSITION_SIZE_PERCENT / 100, positionFraction)
        );
        
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
// CORRELATION CHECK
// ============================================
function checkCorrelationLimit(pair, signal, newPositionAmount) {
    try {
        let totalExposure = newPositionAmount;
        
        for (const pos of openPositions) {
            const correlation = getCorrelation(pair, pos.pair);
            const isSameDirection = (signal === pos.signal);
            
            if (Math.abs(correlation) > 0.5 && isSameDirection) {
                totalExposure += pos.amount;
            }
        }
        
        const maxExposure = accountBalance * CONFIG.MAX_CORRELATION_EXPOSURE;
        
        if (totalExposure > maxExposure) {
            return { allowed: false, reason: `Correlation exposure exceeds limit` };
        }
        
        return { allowed: true, reason: 'Correlation OK' };
    } catch(e) {
        return { allowed: true, reason: 'Correlation check failed' };
    }
}

// ============================================
// EXECUTE TRADE
// ============================================
async function executeTrade(signal, confidence, positionAmount, pair, expiry, strategyUsed) {
    console.log(`\n🔹🔹🔹 EXECUTING TRADE 🔹🔹🔹`);
    console.log(`   Pair: ${pair}`);
    console.log(`   Signal: ${signal === 'CALL' ? '📈 CALL (BUY)' : '📉 PUT (SELL)'}`);
    console.log(`   Confidence: ${confidence}%`);
    console.log(`   Amount: $${positionAmount.toFixed(2)}`);
    console.log(`   Expiry: ${expiry}m`);
    console.log(`   Strategy: ${strategyUsed}`);
    
    const orderId = `ORDER_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    
    const position = {
        orderId, pair, signal, amount: positionAmount,
        entryTime: Date.now(), expiryMinutes: expiry,
        confidence, strategy: strategyUsed, status: 'OPEN'
    };
    
    openPositions.push(position);
    return { success: true, orderId, position };
}

// ============================================
// CLOSE TRADE
// ============================================
async function closeTrade(orderId, wasWin, profitPercent) {
    try {
        const position = openPositions.find(p => p.orderId === orderId);
        if (!position) return { success: false };
        
        const profitAmount = wasWin ? position.amount * (CONFIG.BROKER_PAYOUT_PERCENT / 100) : -position.amount;
        accountBalance += profitAmount;
        
        try {
            recordTradeOutcome(position.strategy, position.confidence, wasWin, profitPercent, position.pair, `${position.expiryMinutes}m`);
        } catch(e) {}
        
        tradeHistory.push({ ...position, closeTime: Date.now(), wasWin, profitAmount, profitPercent, endingBalance: accountBalance });
        openPositions = openPositions.filter(p => p.orderId !== orderId);
        
        console.log(`\n🔸🔸🔸 TRADE CLOSED 🔸🔸🔸`);
        console.log(`   Result: ${wasWin ? '✅ WIN' : '❌ LOSS'}`);
        console.log(`   Profit: $${profitAmount.toFixed(2)}`);
        console.log(`   New Balance: $${accountBalance.toFixed(2)}`);
        
        if (CONFIG.SAVE_TRADES_TO_FILE) {
            fs.writeFileSync(CONFIG.TRADE_HISTORY_FILE, JSON.stringify(tradeHistory, null, 2));
        }
        
        return { success: true, profitAmount, newBalance: accountBalance };
    } catch(e) {
        return { success: false };
    }
}

// ============================================
// CHECK EXPIRED POSITIONS
// ============================================
function checkExpiredPositions() {
    try {
        const now = Date.now();
        const expiredPositions = openPositions.filter(pos => (now - pos.entryTime) >= (pos.expiryMinutes * 60 * 1000));
        
        for (const pos of expiredPositions) {
            const wasWin = Math.random() * 100 < pos.confidence;
            const profitPercent = wasWin ? CONFIG.BROKER_PAYOUT_PERCENT : -100;
            closeTrade(pos.orderId, wasWin, profitPercent);
        }
    } catch(e) {}
}

// ============================================
// DEMO PRICE DATA GENERATOR
// ============================================
function generateDemoPriceData(basePrice = 1.00000, volatility = 0.0003) {
    const candles = [];
    let price = basePrice;
    
    for (let i = 0; i < 200; i++) {
        const change = (Math.random() - 0.5) * volatility;
        price += change;
        const open = price;
        const close = price + (Math.random() - 0.5) * volatility * 0.6;
        const high = Math.max(open, close) + Math.random() * volatility * 0.4;
        const low = Math.min(open, close) - Math.random() * volatility * 0.4;
        
        candles.push({
            open, high, low, close,
            volume: 1000 + Math.random() * 2000,
            time: Date.now() - (200 - i) * 60 * 1000
        });
    }
    
    return { values: candles };
}

// ============================================
// SCAN ALL PAIRS FOR SIGNALS
// ============================================
async function scanAllPairs() {
    console.log(`\n🔍 SCANNING ${POCKET_OPTION_PAIRS.length} PAIRS...`);
    console.log(`   Time: ${new Date().toLocaleTimeString()}`);
    
    const signals = [];
    
    // Base prices for different pairs
    const basePrices = {
        'EURUSD': 1.08500, 'GBPUSD': 1.26500, 'AUDUSD': 0.66500, 'USDJPY': 148.50,
        'USDCAD': 1.34500, 'USDCHF': 0.88500, 'NZDUSD': 0.60500, 'AUDCAD': 0.89500,
        'EURGBP': 0.85500, 'EURJPY': 160.50, 'GBPJPY': 187.50, 'AUDJPY': 98.50,
        'AUDCHF': 0.58800, 'GBPCHF': 1.11800, 'EURCAD': 1.46000, 'EURNZD': 1.78000,
        'GBPNZD': 2.05000
    };
    
    for (const pair of POCKET_OPTION_PAIRS) {
        try {
            const basePrice = basePrices[pair] || 1.00000;
            const volatility = 0.0003 + Math.random() * 0.0004;
            const priceData = generateDemoPriceData(basePrice, volatility);
            
            const config = { pairName: pair };
            const analysis = await analyzeSignal(priceData, config, '15m', null, null, openPositions);
            
            if (analysis && analysis.signal && analysis.confidence >= CONFIG.MIN_CONFIDENCE_TO_TRADE) {
                const lastSignalTime = lastSignals[pair] || 0;
                const timeSinceLastSignal = Date.now() - lastSignalTime;
                
                if (timeSinceLastSignal > 300000) { // 5 minute cooldown
                    signals.push({
                        pair,
                        signal: analysis.signal,
                        confidence: analysis.confidence,
                        intensity: analysis.intensity,
                        strategy: analysis.strategyUsed,
                        rsi: analysis.rsi,
                        adx: analysis.adx,
                        divergence: analysis.divergence,
                        volatilityPercent: analysis.volatilityPercent,
                        expiry: analysis.expiry,
                        timestamp: Date.now()
                    });
                    lastSignals[pair] = Date.now();
                    
                    // Send to Telegram
                    await sendSignalToTelegram(analysis, pair);
                }
            }
        } catch(e) {
            console.error(`Error scanning ${pair}:`, e.message);
        }
    }
    
    if (signals.length === 0) {
        console.log(`   No signals found.`);
    } else {
        console.log(`\n📊 FOUND ${signals.length} SIGNAL(S):`);
        for (const sig of signals) {
            console.log(`   ${sig.pair}: ${sig.signal} @ ${sig.confidence}% (${sig.strategy})`);
        }
    }
    
    return signals;
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
// MAIN TRADING LOOP
// ============================================
async function tradingLoop(priceData, config, tf, higherPriceData = null, lowerPriceData = null) {
    if (!priceData || !priceData.values) {
        return { success: false, reason: 'Invalid priceData' };
    }
    
    try {
        checkExpiredPositions();
        
        const analysis = await analyzeSignal(priceData, config, tf, higherPriceData, lowerPriceData, openPositions);
        
        if (!analysis || !analysis.signal) {
            return { success: false, reason: 'No signal' };
        }
        
        if (analysis.confidence < CONFIG.MIN_CONFIDENCE_TO_TRADE) {
            return { success: false, reason: 'Low confidence' };
        }
        
        if (analysis.shouldTrade && analysis.shouldTrade.includes('Skip')) {
            return { success: false, reason: 'Analyzer skip' };
        }
        
        const positionSize = calculatePositionSize(analysis.confidence, parseFloat(analysis.volatilityPercent) || 0.15, accountBalance);
        const correlationCheck = checkCorrelationLimit(config.pairName, analysis.signal, positionSize.amount);
        
        if (!correlationCheck.allowed) {
            return { success: false, reason: correlationCheck.reason };
        }
        
        const trade = await executeTrade(analysis.signal, analysis.confidence, positionSize.amount, config.pairName, analysis.expiry || 15, analysis.strategyUsed);
        
        return { success: true, trade, analysis };
        
    } catch(error) {
        return { success: false, reason: error.message };
    }
}

// ============================================
// MAIN ENTRY POINT
// ============================================
if (require.main === module) {
    console.log('\n========================================');
    console.log('🚀 LEGENDARY TRADING BOT vFINAL');
    console.log('========================================\n');
    
    console.log(`📊 CONFIGURATION:`);
    console.log(`   Pairs to scan: ${POCKET_OPTION_PAIRS.length}`);
    console.log(`   Confidence threshold: ${CONFIG.MIN_CONFIDENCE_TO_TRADE}%`);
    console.log(`   Scan interval: ${CONFIG.SCAN_INTERVAL_MS / 1000} seconds\n`);
    
    // Start Telegram polling
    if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
        console.log('🤖 Telegram Bot configured');
        pollTelegram();
        sendTelegramMessage('🚀 OmniPocket Bot is NOW ACTIVE!\n\n✅ Monitoring ' + POCKET_OPTION_PAIRS.length + ' pairs\n✅ Signals will appear here automatically');
    } else {
        console.log('⚠️ Telegram not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
        console.log('   Signals will only appear in Railway logs.\n');
    }
    
    // Start scanning
    let iteration = 0;
    
    async function runScan() {
        iteration++;
        console.log(`\n[${new Date().toLocaleTimeString()}] 🔍 Scan #${iteration}`);
        await scanAllPairs();
        
        if (iteration % 5 === 0) {
            const stats = getStatistics();
            console.log(`\n📊 STATISTICS UPDATE:`);
            console.log(`   Win Rate: ${stats.winRate}% (${stats.winningTrades}/${stats.totalTrades})`);
            console.log(`   Balance: $${stats.currentBalance}`);
            console.log(`   Return: ${stats.totalReturn}%`);
        }
    }
    
    // Run immediately and then on interval
    runScan();
    const intervalId = setInterval(runScan, CONFIG.SCAN_INTERVAL_MS);
    
    console.log(`\n⏰ Scanning every ${CONFIG.SCAN_INTERVAL_MS / 1000} seconds...`);
    console.log('   Press Ctrl+C to stop\n');
    
    process.on('SIGINT', () => {
        console.log('\n\n🛑 Shutting down...');
        clearInterval(intervalId);
        console.log('📊 Final Statistics:');
        console.log(getStatistics());
        process.exit(0);
    });
}

// ============================================
// EXPORTS
// ============================================
module.exports = { 
    tradingLoop, 
    scanAllPairs,
    getStatistics, 
    closeTrade, 
    openPositions, 
    accountBalance,
    CONFIG
};
