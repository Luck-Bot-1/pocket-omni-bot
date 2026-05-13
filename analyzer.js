const fs = require('fs');
const path = require('path');
const BACKTEST_FILE = path.join(__dirname, 'backtest_stats.json');

// ============================================
// PROFESSIONAL BACKTEST
// ============================================
function loadStats() {
    if (!fs.existsSync(BACKTEST_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(BACKTEST_FILE, 'utf8')); } catch(e) { return {}; }
}
function saveStats(stats) { fs.writeFileSync(BACKTEST_FILE, JSON.stringify(stats, null, 2)); }

function recordTradeOutcome(pair, tf, patternId, wasWin, profitPercent = 0) {
    const stats = loadStats();
    const key = `${pair}_${tf}_${patternId}`;
    if (!stats[key]) stats[key] = { total: 0, wins: 0, winRate: 55, trades: [] };
    stats[key].total++;
    if (wasWin) stats[key].wins++;
    stats[key].winRate = (stats[key].wins / stats[key].total) * 100;
    stats[key].trades.push({ wasWin, profitPercent, timestamp: Date.now() });
    if (stats[key].trades.length > 200) stats[key].trades.shift();
    saveStats(stats);
}

function getRealConfidence(pair, tf, patternId) {
    const stats = loadStats();
    const key = `${pair}_${tf}_${patternId}`;
    if (stats[key] && stats[key].total >= 10) return Math.min(99, Math.max(1, stats[key].winRate));
    return 60;
}

// ============================================
// TECHNICAL INDICATORS
// ============================================
function calculateEMA(values, period) {
    const k = 2 / (period + 1);
    let ema = values[0];
    for (let i = 1; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
    return ema;
}

function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i-1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
    }
    let avgGain = gains / period, avgLoss = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i-1];
        if (diff >= 0) {
            avgGain = (avgGain * (period - 1) + diff) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgGain = (avgGain * (period - 1)) / period;
            avgLoss = (avgLoss * (period - 1) - diff) / period;
        }
    }
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function detectDivergence(price, indicator, lookback = 20) {
    const lastPrice = price[price.length - 1];
    const lastInd = indicator[indicator.length - 1];
    let bearish = false, bullish = false;
    for (let i = lookback; i > 0; i--) {
        const idx = price.length - 1 - i;
        if (idx < 0) continue;
        if (price[idx] < lastPrice && indicator[idx] > lastInd) bearish = true;
        if (price[idx] > lastPrice && indicator[idx] < lastInd) bullish = true;
    }
    return bearish ? 'Bearish' : (bullish ? 'Bullish' : 'None');
}

// ============================================
// MAIN SIGNAL GENERATION
// ============================================
async function analyzeSignal(priceData, config, tf, higherPriceData = null) {
    try {
        const candles = priceData.values;
        if (!candles || candles.length < 30) {
            return { signal: 'WAIT', reason: 'Insufficient data' };
        }
        
        const closes = candles.map(c => c.close);
        const currentPrice = closes[closes.length - 1];
        const ema9 = calculateEMA(closes, 9);
        const ema21 = calculateEMA(closes, 21);
        const rsi = calculateRSI(closes, 14);
        const priceChange = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
        
        // Price Action Trend Detection
        const last5Closes = closes.slice(-5);
        const isMakingHigherHighs = last5Closes[4] > last5Closes[3] && last5Closes[3] > last5Closes[2];
        const isMakingLowerLows = last5Closes[4] < last5Closes[3] && last5Closes[3] < last5Closes[2];
        const priceAbove20Candles = currentPrice > Math.max(...closes.slice(-20));
        const priceBelow20Candles = currentPrice < Math.min(...closes.slice(-20));
        const rangeSize = Math.max(...closes.slice(-20)) - Math.min(...closes.slice(-20));
        
        // RSI values for divergence
        const rsiValues = [];
        for (let i = 0; i < closes.length; i++) {
            const slice = closes.slice(0, i + 1);
            if (slice.length < 14) rsiValues.push(50);
            else rsiValues.push(calculateRSI(slice, 14));
        }
        const divergence = detectDivergence(closes, rsiValues);
        
        let signal = null;
        let trend = 'Sideways';
        let strategyUsed = '';
        const emaRelation = ema9 > ema21 ? 'EMA9 > EMA21' : 'EMA9 < EMA21';
        
        // STRATEGY 1: TREND FOLLOWING (EMA + Price Action)
        const isUptrend = (ema9 > ema21 && priceAbove20Candles) || (ema9 > ema21 && isMakingHigherHighs);
        const isDowntrend = (ema9 < ema21 && priceBelow20Candles) || (ema9 < ema21 && isMakingLowerLows);
        
        if (isUptrend) {
            signal = 'CALL';
            trend = '📈 Uptrend';
            strategyUsed = 'Trend Following';
        }
        else if (isDowntrend) {
            signal = 'PUT';
            trend = '📉 Downtrend';
            strategyUsed = 'Trend Following';
        }
        // STRATEGY 2: PULLBACK ENTRY
        else if (ema9 > ema21 && rsi < 45) {
            signal = 'CALL';
            trend = '📈 Pullback Buy';
            strategyUsed = 'Pullback Entry';
        }
        else if (ema9 < ema21 && rsi > 55) {
            signal = 'PUT';
            trend = '📉 Pullback Sell';
            strategyUsed = 'Pullback Entry';
        }
        // STRATEGY 3: REVERSAL
        else if (rsi > 75) {
            signal = 'PUT';
            trend = '⚠️ Overbought → Sell';
            strategyUsed = 'Reversal';
        }
        else if (rsi < 25) {
            signal = 'CALL';
            trend = '⚠️ Oversold → Buy';
            strategyUsed = 'Reversal';
        }
        // STRATEGY 4: MOMENTUM
        else if (priceChange > 0.15) {
            signal = 'CALL';
            trend = '⚡ Up Momentum';
            strategyUsed = 'Momentum';
        }
        else if (priceChange < -0.15) {
            signal = 'PUT';
            trend = '⚡ Down Momentum';
            strategyUsed = 'Momentum';
        }
        // STRATEGY 5: RANGE TRADING
        else if (rangeSize < 0.005 && rsi > 65) {
            signal = 'PUT';
            trend = '📊 Range Top → Sell';
            strategyUsed = 'Range Trading';
        }
        else if (rangeSize < 0.005 && rsi < 35) {
            signal = 'CALL';
            trend = '📊 Range Bottom → Buy';
            strategyUsed = 'Range Trading';
        }
        else {
            signal = 'WAIT';
            strategyUsed = 'No Setup';
        }
        
        // DIVERGENCE VETO
        if (signal === 'CALL' && divergence === 'Bearish') {
            signal = 'WAIT';
            trend = '🚨 Bearish Divergence';
            strategyUsed = 'Divergence Veto';
        }
        if (signal === 'PUT' && divergence === 'Bullish') {
            signal = 'WAIT';
            trend = '🚨 Bullish Divergence';
            strategyUsed = 'Divergence Veto';
        }
        
        if (signal === 'WAIT') {
            return { signal: 'WAIT', reason: trend };
        }
        
        const patternId = `${emaRelation}_${strategyUsed.replace(/ /g, '_')}_${divergence}`;
        const confidence = getRealConfidence(config.pairName || 'UNKNOWN', tf, patternId);
        
        return {
            signal: signal,
            confidence: Math.min(99, Math.max(1, confidence)),
            rsi: rsi.toFixed(1),
            emaRelation: emaRelation,
            priceChange: priceChange.toFixed(2),
            divergence: divergence,
            trend: trend,
            strategyUsed: strategyUsed,
            trendAlignment: `✅ ${strategyUsed} | RSI: ${rsi.toFixed(1)}`,
            patternId: patternId
        };
        
    } catch (error) {
        console.error('Analyzer error:', error);
        return { signal: 'WAIT', reason: 'Analysis error' };
    }
}

module.exports = { analyzeSignal, recordTradeOutcome };
