// ============================================
// LEGENDARY TRADING BOT - ORCHESTRATOR
// Version: 8.0 MASTER - GOD LEVEL
// File: bot.js
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
    TRADE_HISTORY_FILE: './trade_history.json'
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

// Load existing trades if file exists
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
    'AUDCAD': { 'USDCAD': 0.72, 'AUDUSD': 0.85, 'EURUSD': 0.65, 'GBPUSD': 0.58 },
    'USDCAD': { 'AUDCAD': 0.72, 'AUDUSD': -0.68, 'EURUSD': -0.55, 'GBPUSD': -0.52 },
    'AUDUSD': { 'AUDCAD': 0.85, 'USDCAD': -0.68, 'EURUSD': 0.82, 'GBPUSD': 0.75 },
    'EURUSD': { 'AUDCAD': 0.65, 'USDCAD': -0.55, 'AUDUSD': 0.82, 'GBPUSD': 0.88 },
    'GBPUSD': { 'AUDCAD': 0.58, 'USDCAD': -0.52, 'AUDUSD': 0.75, 'EURUSD': 0.88 }
};

function getCorrelation(pair1, pair2) {
    try {
        return CORRELATION_MATRIX[pair1]?.[pair2] || 0;
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
        
        // Safely record trade outcome
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
            // In production, replace with actual broker API
            // For demo: simulate outcome based on confidence
            const wasWin = Math.random() * 100 < pos.confidence;
            const profitPercent = wasWin ? CONFIG.BROKER_PAYOUT_PERCENT : -100;
            closeTrade(pos.orderId, wasWin, profitPercent);
        }
    } catch(e) {
        console.error('Check expired positions error:', e);
    }
}

// ============================================
// MAIN TRADING LOOP (CRASH-PROOF)
// ============================================
async function tradingLoop(priceData, config, tf, higherPriceData = null, lowerPriceData = null) {
    // SAFETY CHECK #1: Validate priceData
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
        
        // SAFETY CHECK #2: Validate config
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
        // NEVER CRASH - return graceful failure
        return { success: false, reason: error.message || 'Unknown error' };
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
            openPositions: openPositions.length
        };
    } catch(e) {
        console.error('Get statistics error:', e);
        return {
            totalTrades: 0, winningTrades: 0, losingTrades: 0,
            winRate: '0', totalProfit: '0',
            currentBalance: accountBalance.toFixed(2), totalReturn: '0',
            sharpeRatio: '0', openPositions: 0
        };
    }
}

// SAFE EXPORTS - ONLY ONE
module.exports = { tradingLoop, getStatistics, closeTrade, openPositions, accountBalance };
