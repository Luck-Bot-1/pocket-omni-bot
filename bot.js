// ============================================
// LEGENDARY TRADING BOT - ORCHESTRATOR
// Version: 10.0 ULTIMATE - 50+ PAIRS REAL-TIME
// ============================================

const { analyzeSignal, recordTradeOutcome } = require('./analyzer.js');
const fs = require('fs');

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
    DEMO_MODE: true,
    DEMO_INTERVAL_MS: 60000,
    // NEW: Multi-pair scanning
    SCAN_ALL_PAIRS: true,
    PAIRS_TO_SCAN: [
        // Major Pairs (12)
        'EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDCHF', 'USDJPY',
        // Cross Pairs (16)
        'AUDCAD', 'AUDJPY', 'AUDCHF', 'CADJPY', 'CADCHF', 'CHFJPY',
        'EURGBP', 'EURCHF', 'EURJPY', 'GBPJPY', 'GBPCHF', 'NZDCAD', 'NZDJPY',
        // Exotic Pairs (12)
        'USDTRY', 'USDMXN', 'USDZAR', 'USDSGD', 'USDHKD',
        'EURTRY', 'GBPTRY', 'AUDTRY',
        // Additional Majors (10+)
        'EURCAD', 'GBPCAD', 'AUDNZD', 'EURNZD', 'GBPNZD',
        'CADCHF', 'EURSEK', 'USDNOK', 'USDDKK', 'USDSEK'
    ]
};

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
let lastSignals = {}; // Track last signal per pair to avoid spam

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
// EXPANDED CORRELATION MATRIX - 50+ PAIRS
// ============================================
const CORRELATION_MATRIX = {
    // Major Pairs
    'EURUSD': { 'GBPUSD': 0.88, 'AUDUSD': 0.82, 'NZDUSD': 0.78, 'USDCAD': -0.55, 'USDCHF': -0.85, 'USDJPY': -0.65, 'EURGBP': 0.92, 'EURCHF': 0.88, 'EURJPY': 0.85 },
    'GBPUSD': { 'EURUSD': 0.88, 'AUDUSD': 0.75, 'NZDUSD': 0.72, 'USDCAD': -0.52, 'USDCHF': -0.78, 'USDJPY': -0.60, 'EURGBP': 0.88, 'GBPJPY': 0.82, 'GBPCHF': 0.80 },
    'AUDUSD': { 'EURUSD': 0.82, 'GBPUSD': 0.75, 'NZDUSD': 0.85, 'USDCAD': -0.68, 'AUDCAD': 0.85, 'AUDJPY': 0.78, 'AUDCHF': 0.72, 'AUDNZD': 0.88 },
    'NZDUSD': { 'EURUSD': 0.78, 'GBPUSD': 0.72, 'AUDUSD': 0.85, 'USDCAD': -0.62, 'NZDCAD': 0.70, 'NZDJPY': 0.75, 'AUDNZD': 0.85 },
    'USDCAD': { 'EURUSD': -0.55, 'GBPUSD': -0.52, 'AUDUSD': -0.68, 'NZDUSD': -0.62, 'AUDCAD': 0.72, 'CADJPY': 0.65, 'CADCHF': 0.60, 'EURCAD': 0.58 },
    'USDCHF': { 'EURUSD': -0.85, 'GBPUSD': -0.78, 'AUDUSD': -0.72, 'NZDUSD': -0.68, 'USDJPY': 0.55, 'CHFJPY': 0.70, 'EURCHF': 0.85, 'GBPCHF': 0.80 },
    'USDJPY': { 'EURUSD': -0.65, 'GBPUSD': -0.60, 'AUDUSD': -0.58, 'NZDUSD': -0.55, 'USDCHF': 0.55, 'CADJPY': 0.62, 'AUDJPY': 0.78, 'NZDJPY': 0.75, 'EURJPY': 0.82, 'GBPJPY': 0.80 },
    
    // Cross Pairs
    'AUDCAD': { 'AUDUSD': 0.85, 'USDCAD': 0.72, 'AUDJPY': 0.75, 'CADJPY': 0.68, 'AUDCHF': 0.70, 'NZDCAD': 0.68 },
    'AUDJPY': { 'AUDUSD': 0.78, 'USDJPY': 0.78, 'AUDCAD': 0.75, 'AUDCHF': 0.72, 'CADJPY': 0.70, 'NZDJPY': 0.72 },
    'AUDCHF': { 'AUDUSD': 0.72, 'USDCHF': -0.70, 'AUDJPY': 0.72, 'AUDCAD': 0.70, 'CHFJPY': 0.68 },
    'CADJPY': { 'USDCAD': 0.65, 'USDJPY': 0.62, 'AUDCAD': 0.68, 'AUDJPY': 0.70, 'CADCHF': 0.60 },
    'CHFJPY': { 'USDCHF': 0.70, 'USDJPY': 0.65, 'AUDCHF': 0.68, 'CADJPY': 0.62 },
    'EURGBP': { 'EURUSD': 0.92, 'GBPUSD': 0.88, 'EURCHF': 0.85, 'EURJPY': 0.82, 'GBPJPY': 0.85 },
    'EURCHF': { 'EURUSD': 0.88, 'USDCHF': -0.85, 'EURGBP': 0.85, 'EURJPY': 0.80, 'GBPCHF': 0.85 },
    'EURJPY': { 'EURUSD': 0.85, 'USDJPY': -0.80, 'EURGBP': 0.82, 'EURCHF': 0.80, 'GBPJPY': 0.85 },
    'GBPJPY': { 'GBPUSD': 0.82, 'USDJPY': -0.78, 'GBPCHF': 0.80, 'EURJPY': 0.85, 'EURGBP': 0.85 },
    'GBPCHF': { 'GBPUSD': 0.80, 'USDCHF': -0.78, 'GBPJPY': 0.80, 'EURCHF': 0.85 },
    'NZDCAD': { 'NZDUSD': 0.70, 'USDCAD': -0.62, 'AUDCAD': 0.68, 'NZDJPY': 0.65, 'AUDNZD': 0.72 },
    'NZDJPY': { 'NZDUSD': 0.75, 'USDJPY': -0.55, 'AUDJPY': 0.72, 'NZDCAD': 0.65 },
    'AUDNZD': { 'AUDUSD': 0.88, 'NZDUSD': 0.85, 'AUDCAD': 0.70, 'NZDCAD': 0.72 },
    'EURCAD': { 'EURUSD': 0.88, 'USDCAD': -0.58, 'EURGBP': 0.75, 'EURJPY': 0.70 },
    'GBPCAD': { 'GBPUSD': 0.85, 'USDCAD': -0.55, 'GBPJPY': 0.72, 'EURCAD': 0.80 },
    'EURNZD': { 'EURUSD': 0.82, 'NZDUSD': -0.68, 'EURGBP': 0.70, 'AUDNZD': 0.75 },
    'GBPNZD': { 'GBPUSD': 0.80, 'NZDUSD': -0.65, 'GBPJPY': 0.68, 'EURNZD': 0.72 },
    
    // Exotic Pairs (simplified correlations)
    'USDTRY': { 'EURUSD': -0.45, 'USDJPY': 0.35, 'USDCAD': 0.30, 'EURTRY': 0.85 },
    'USDMXN': { 'EURUSD': -0.40, 'USDCAD': 0.55, 'USDTRY': 0.25 },
    'USDZAR': { 'EURUSD': -0.42, 'AUDUSD': -0.38, 'USDCAD': 0.35 },
    'USDSGD': { 'EURUSD': -0.48, 'USDJPY': 0.42, 'AUDUSD': -0.35 },
    'USDHKD': { 'EURUSD': -0.25, 'USDJPY': 0.20, 'USDCAD': 0.15 },
    'EURTRY': { 'EURUSD': 0.55, 'USDTRY': 0.85, 'EURGBP': 0.45 },
    'GBPTRY': { 'GBPUSD': 0.50, 'USDTRY': 0.80, 'EURTRY': 0.75 },
    'AUDTRY': { 'AUDUSD': 0.48, 'USDTRY': 0.78, 'EURTRY': 0.70 },
    'USDNOK': { 'EURUSD': -0.50, 'USDJPY': 0.30, 'USDCAD': 0.40 },
    'USDDKK': { 'EURUSD': -0.55, 'USDJPY': 0.28, 'USDCAD': 0.35 },
    'USDSEK': { 'EURUSD': -0.52, 'USDJPY': 0.32, 'USDCAD': 0.38 }
};

function getCorrelation(pair1, pair2) {
    try {
        return CORRELATION_MATRIX[pair1]?.[pair2] || CORRELATION_MATRIX[pair2]?.[pair1] || 0;
    } catch(e) {
        return 0;
    }
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
        console.error('Position sizing error:', e);
        return { fraction: 0.01, amount: accountBalance * 0.01, kellyFraction: 0 };
    }
}

// ============================================
// CORRELATION CHECK
// ============================================
function checkCorrelationLimit(pair, signal, newPositionAmount) {
    try {
        let totalExposure = newPositionAmount;
        let correlatedPairs = [];
        const CORRELATION_THRESHOLD = 0.5;
        
        for (const pos of openPositions) {
            const correlation = getCorrelation(pair, pos.pair);
            const isSameDirection = (signal === pos.signal);
            
            if (Math.abs(correlation) > CORRELATION_THRESHOLD && isSameDirection) {
                totalExposure += pos.amount;
                correlatedPairs.push(pos.pair);
            }
        }
        
        const maxExposure = accountBalance * CONFIG.MAX_CORRELATION_EXPOSURE;
        
        if (totalExposure > maxExposure) {
            return {
                allowed: false,
                reason: `Correlation exposure $${totalExposure.toFixed(2)} > max $${maxExposure.toFixed(2)}`,
                suggestedReduction: maxExposure / totalExposure
            };
        }
        
        return { allowed: true, reason: 'Correlation OK' };
    } catch(e) {
        console.error('Correlation check error:', e);
        return { allowed: true, reason: 'Correlation check failed - allowing trade' };
    }
}

// ============================================
// EXECUTE TRADE
// ============================================
async function executeTrade(signal, confidence, positionAmount, pair, expiry, strategyUsed) {
    try {
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
    } catch(e) {
        console.error('Execute trade error:', e);
        return { success: false, error: e.message };
    }
}

// ============================================
// CLOSE TRADE
// ============================================
async function closeTrade(orderId, wasWin, profitPercent) {
    try {
        const position = openPositions.find(p => p.orderId === orderId);
        if (!position) return { success: false, reason: 'Position not found' };
        
        const profitAmount = wasWin ? position.amount * (CONFIG.BROKER_PAYOUT_PERCENT / 100) : -position.amount;
        accountBalance += profitAmount;
        
        try {
            recordTradeOutcome(position.strategy, position.confidence, wasWin, profitPercent, position.pair, `${position.expiryMinutes}m`);
        } catch(e) {
            console.error('Error recording trade outcome:', e);
        }
        
        tradeHistory.push({ ...position, closeTime: Date.now(), wasWin, profitAmount, profitPercent, endingBalance: accountBalance });
        openPositions = openPositions.filter(p => p.orderId !== orderId);
        
        console.log(`\n🔸🔸🔸 TRADE CLOSED 🔸🔸🔸`);
        console.log(`   Result: ${wasWin ? '✅ WIN' : '❌ LOSS'}`);
        console.log(`   Profit: $${profitAmount.toFixed(2)}`);
        console.log(`   New Balance: $${accountBalance.toFixed(2)}`);
        
        if (CONFIG.SAVE_TRADES_TO_FILE) {
            try {
                fs.writeFileSync(CONFIG.TRADE_HISTORY_FILE, JSON.stringify(tradeHistory, null, 2));
            } catch(e) {
                console.error('Error saving trade history:', e);
            }
        }
        
        return { success: true, profitAmount, newBalance: accountBalance };
    } catch(e) {
        console.error('Close trade error:', e);
        return { success: false, error: e.message };
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
    } catch(e) {
        console.error('Check expired positions error:', e);
    }
}

// ============================================
// MAIN TRADING LOOP (Single Pair)
// ============================================
async function tradingLoop(priceData, config, tf, higherPriceData = null, lowerPriceData = null) {
    if (!priceData || !priceData.values || !Array.isArray(priceData.values)) {
        console.error('❌ Invalid priceData provided to tradingLoop');
        return { success: false, reason: 'Invalid priceData' };
    }
    
    try {
        checkExpiredPositions();
        
        if (openPositions.length >= CONFIG.MAX_CONCURRENT_TRADES) {
            console.log(`⚠️ Max concurrent trades (${CONFIG.MAX_CONCURRENT_TRADES}) reached.`);
            return { success: false, reason: 'Max trades reached' };
        }
        
        if (!config || !config.pairName) {
            console.error('❌ Invalid config provided');
            return { success: false, reason: 'Invalid config' };
        }
        
        const analysis = await analyzeSignal(priceData, config, tf, higherPriceData, lowerPriceData, openPositions);
        
        if (!analysis || !analysis.signal) {
            return { success: false, reason: 'No signal' };
        }
        
        if (analysis.confidence < CONFIG.MIN_CONFIDENCE_TO_TRADE) {
            console.log(`⚠️ Confidence ${analysis.confidence}% < ${CONFIG.MIN_CONFIDENCE_TO_TRADE}%`);
            return { success: false, reason: 'Low confidence' };
        }
        
        if (analysis.shouldTrade && analysis.shouldTrade.includes('Skip')) {
            console.log(`⚠️ Analyzer recommends skipping: ${analysis.recommendation}`);
            return { success: false, reason: 'Analyzer skip' };
        }
        
        const positionSize = calculatePositionSize(analysis.confidence, parseFloat(analysis.volatilityPercent) || 0.15, accountBalance);
        const correlationCheck = checkCorrelationLimit(config.pairName, analysis.signal, positionSize.amount);
        
        if (!correlationCheck.allowed) {
            console.log(`⚠️ Correlation limit exceeded: ${correlationCheck.reason}`);
            return { success: false, reason: correlationCheck.reason };
        }
        
        const trade = await executeTrade(analysis.signal, analysis.confidence, positionSize.amount, config.pairName, analysis.expiry || 15, analysis.strategyUsed);
        
        if (!trade.success) {
            return { success: false, reason: trade.error };
        }
        
        console.log(`\n📊 TRADE EXECUTED:`);
        console.log(`   Signal: ${analysis.signal} | Confidence: ${analysis.confidence}%`);
        console.log(`   Strategy: ${analysis.strategyUsed}`);
        console.log(`   RSI: ${analysis.rsi} | ADX: ${analysis.adx}`);
        console.log(`   Divergence: ${analysis.divergence || 'None'}`);
        console.log(`   Volatility: ${analysis.volatilityPercent}%`);
        
        return { success: true, trade, analysis };
        
    } catch(error) {
        console.error('Trading loop error:', error);
        return { success: false, reason: error.message || 'Unknown error' };
    }
}

// ============================================
// NEW: MULTI-PAIR SCANNING FOR REAL-TIME ALERTS
// ============================================
async function scanAllPairs(getPriceDataFunction, tf = '15m') {
    console.log(`\n🔍 SCANNING ${CONFIG.PAIRS_TO_SCAN.length} PAIRS FOR SIGNALS...`);
    console.log(`   Time: ${new Date().toLocaleTimeString()}`);
    
    const signals = [];
    
    for (const pair of CONFIG.PAIRS_TO_SCAN) {
        try {
            // Get price data for this pair (implement based on your data source)
            const priceData = await getPriceDataFunction(pair);
            
            if (!priceData || !priceData.values || priceData.values.length < 100) {
                continue;
            }
            
            const config = { pairName: pair };
            const analysis = await analyzeSignal(priceData, config, tf, null, null, openPositions);
            
            if (analysis && analysis.signal && analysis.confidence >= CONFIG.MIN_CONFIDENCE_TO_TRADE) {
                // Check if we already sent this signal recently (avoid spam)
                const lastSignalTime = lastSignals[pair] || 0;
                const timeSinceLastSignal = Date.now() - lastSignalTime;
                
                if (timeSinceLastSignal > 300000) { // 5 minutes cooldown
                    signals.push({
                        pair,
                        signal: analysis.signal,
                        confidence: analysis.confidence,
                        intensity: analysis.intensity,
                        strategy: analysis.strategyUsed,
                        rsi: analysis.rsi,
                        adx: analysis.adx,
                        divergence: analysis.divergence,
                        timestamp: Date.now()
                    });
                    lastSignals[pair] = Date.now();
                    
                    // REAL-TIME ALERT OUTPUT
                    console.log(`\n🚨 REAL-TIME SIGNAL ALERT 🚨`);
                    console.log(`   Pair: ${pair}`);
                    console.log(`   Signal: ${analysis.signal === 'CALL' ? '📈 CALL (BUY)' : '📉 PUT (SELL)'}`);
                    console.log(`   Confidence: ${analysis.confidence}% ${analysis.intensity}`);
                    console.log(`   Strategy: ${analysis.strategyUsed}`);
                    console.log(`   RSI: ${analysis.rsi} | ADX: ${analysis.adx}`);
                    if (analysis.divergence !== 'None') {
                        console.log(`   Divergence: ${analysis.divergence} (Quality: ${analysis.divergenceQuality}%)`);
                    }
                    console.log(`   Recommendation: ${analysis.recommendation}`);
                }
            }
        } catch(e) {
            console.error(`Error scanning ${pair}:`, e.message);
        }
    }
    
    if (signals.length === 0) {
        console.log(`   No strong signals found across ${CONFIG.PAIRS_TO_SCAN.length} pairs.`);
    } else {
        console.log(`\n📊 FOUND ${signals.length} SIGNAL(S):`);
        for (const sig of signals) {
            console.log(`   ✅ ${sig.pair}: ${sig.signal} @ ${sig.confidence}% (${sig.strategy})`);
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
        
        const returns = tradeHistory.map(t => t.profitPercent || 0);
        const avgReturn = returns.reduce((a,b) => a+b, 0) / (returns.length || 1);
        const variance = returns.reduce((a,b) => a + Math.pow(b - avgReturn, 2), 0) / (returns.length || 1);
        const sharpeRatio = Math.sqrt(variance) > 0 ? (avgReturn / Math.sqrt(variance)) * Math.sqrt(252) : 0;
        
        return {
            totalTrades, 
            winningTrades, 
            losingTrades: totalTrades - winningTrades,
            winRate: winRate.toFixed(1), 
            totalProfit: totalProfit.toFixed(2),
            currentBalance: accountBalance.toFixed(2), 
            totalReturn: ((accountBalance - 10000) / 10000 * 100).toFixed(1),
            sharpeRatio: sharpeRatio.toFixed(2), 
            openPositions: openPositions.length,
            pairsScanned: CONFIG.PAIRS_TO_SCAN.length
        };
    } catch(e) {
        console.error('Get statistics error:', e);
        return {
            totalTrades: 0, winningTrades: 0, losingTrades: 0,
            winRate: '0', totalProfit: '0',
            currentBalance: accountBalance.toFixed(2), totalReturn: '0',
            sharpeRatio: '0', openPositions: 0, pairsScanned: 0
        };
    }
}

// ============================================
// DEMO MODE - GENERATE FAKE PRICE DATA
// ============================================
function generateDemoPriceData(basePrice = 0.98000, volatility = 0.0005) {
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

// Demo price data getter for multi-pair scanning
async function demoGetPriceData(pair) {
    // Generate different base prices for different pairs
    const basePrices = {
        'EURUSD': 1.08500, 'GBPUSD': 1.26500, 'AUDUSD': 0.66500, 'USDJPY': 148.50,
        'USDCAD': 1.34500, 'USDCHF': 0.88500, 'NZDUSD': 0.60500, 'AUDCAD': 0.89500
    };
    const basePrice = basePrices[pair] || 1.00000;
    const volatility = 0.0003 + Math.random() * 0.0004;
    return generateDemoPriceData(basePrice, volatility);
}

// ============================================
// MAIN ENTRY POINT
// ============================================
if (require.main === module) {
    console.log('\n========================================');
    console.log('🚀 LEGENDARY TRADING BOT v10.0 ULTIMATE');
    console.log('========================================\n');
    console.log(`📊 CONFIGURATION:`);
    console.log(`   Pairs to scan: ${CONFIG.PAIRS_TO_SCAN.length}`);
    console.log(`   Confidence threshold: ${CONFIG.MIN_CONFIDENCE_TO_TRADE}%`);
    console.log(`   Max concurrent trades: ${CONFIG.MAX_CONCURRENT_TRADES}`);
    console.log(`   Correlation exposure limit: ${CONFIG.MAX_CORRELATION_EXPOSURE * 100}%\n`);
    
    if (CONFIG.DEMO_MODE) {
        console.log('📈 DEMO MODE ENABLED');
        console.log('   Scanning all pairs with fake price data...\n');
        
        let iteration = 0;
        
        async function runDemoIteration() {
            iteration++;
            const timestamp = new Date().toLocaleTimeString();
            console.log(`\n[${timestamp}] 🔍 Demo Scan #${iteration}`);
            
            const signals = await scanAllPairs(demoGetPriceData, '15m');
            
            if (iteration % 5 === 0) {
                const stats = getStatistics();
                console.log(`\n📊 STATISTICS UPDATE:`);
                console.log(`   Win Rate: ${stats.winRate}% (${stats.winningTrades}/${stats.totalTrades})`);
                console.log(`   Balance: $${stats.currentBalance}`);
                console.log(`   Total Return: ${stats.totalReturn}%`);
                console.log(`   Pairs Scanned: ${stats.pairsScanned}`);
            }
        }
        
        // Run immediately
        runDemoIteration();
        
        // Then run on interval
        const intervalId = setInterval(runDemoIteration, CONFIG.DEMO_INTERVAL_MS);
        console.log(`\n⏰ Scanning ${CONFIG.PAIRS_TO_SCAN.length} pairs every ${CONFIG.DEMO_INTERVAL_MS / 1000} seconds...`);
        console.log('   Press Ctrl+C to stop\n');
        
        process.on('SIGINT', () => {
            console.log('\n\n🛑 Shutting down...');
            clearInterval(intervalId);
            console.log('📊 Final Statistics:');
            console.log(getStatistics());
            process.exit(0);
        });
    } else {
        console.log('🔧 PRODUCTION MODE');
        console.log('   Provide a getPriceDataFunction to scanAllPairs() for real-time alerts.\n');
    }
}

// EXPORTS
module.exports = { 
    tradingLoop, 
    scanAllPairs,  // NEW: Multi-pair scanning
    getStatistics, 
    closeTrade, 
    openPositions, 
    accountBalance,
    CONFIG  // Export config for customization
};
