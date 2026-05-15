const fs = require('fs');
const path = require('path');
const BACKTEST_FILE = path.join(__dirname, 'backtest_stats.json');

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

function getHistoricalWinRate(pair, tf, patternId) {
    const stats = loadStats();
    const key = `${pair}_${tf}_${patternId}`;
    if (stats[key] && stats[key].total >= 10) return stats[key].winRate;
    return null;
}

function calculateEMA(values, period) {
    if (!values || values.length === 0) return 0;
    const k = 2 / (period + 1);
    let ema = values[0];
    for (let i = 1; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
    return ema;
}

function calculateRSI(closes, period = 14) {
    if (!closes || closes.length < period + 1) return 50;
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

function calculateADX(high, low, close, period = 14) {
    if (!high || !low || !close || high.length < period + 1) {
        return { adx: 20, plusDI: 20, minusDI: 20 };
    }
    const tr = [];
    for (let i = 1; i < high.length; i++) {
        const hl = high[i] - low[i];
        const hc = Math.abs(high[i] - close[i-1]);
        const lc = Math.abs(low[i] - close[i-1]);
        tr.push(Math.max(hl, hc, lc));
    }
    const plusDM = [], minusDM = [];
    for (let i = 1; i < high.length; i++) {
        const up = high[i] - high[i-1];
        const down = low[i-1] - low[i];
        plusDM.push((up > down && up > 0) ? up : 0);
        minusDM.push((down > up && down > 0) ? down : 0);
    }
    const smoothTR = tr.slice(-period).reduce((a, b) => a + b, 0) / period;
    const smoothPlus = plusDM.slice(-period).reduce((a, b) => a + b, 0) / period;
    const smoothMinus = minusDM.slice(-period).reduce((a, b) => a + b, 0) / period;
    const plusDI = (smoothPlus / smoothTR) * 100;
    const minusDI = (smoothMinus / smoothTR) * 100;
    const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
    return { adx: dx || 20, plusDI: plusDI || 20, minusDI: minusDI || 20 };
}

function calculateATR(high, low, close, period = 14) {
    if (!high || !low || !close || high.length < period + 1) return 0.001;
    const tr = [];
    for (let i = 1; i < high.length; i++) {
        const hl = high[i] - low[i];
        const hc = Math.abs(high[i] - close[i-1]);
        const lc = Math.abs(low[i] - close[i-1]);
        tr.push(Math.max(hl, hc, lc));
    }
    return tr.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calculateVWAP(candles) {
    if (!candles || candles.length === 0) return 1.0;
    let cumPV = 0, cumVol = 0;
    for (let i = 0; i < candles.length; i++) {
        const typical = (candles[i].high + candles[i].low + candles[i].close) / 3;
        cumPV += typical * candles[i].volume;
        cumVol += candles[i].volume;
    }
    return cumVol > 0 ? cumPV / cumVol : candles[candles.length - 1].close;
}

function getADXStrength(adx) {
    if (adx >= 50) return '🔥 EXTREME TREND';
    if (adx >= 40) return '📈 VERY STRONG TREND';
    if (adx >= 30) return '📈 STRONG TREND';
    if (adx >= 25) return '📊 DEVELOPING TREND';
    if (adx >= 20) return '🌀 WEAK TREND';
    return '🌀 SIDEWAYS/RANGE';
}

function getRSIValues(closes) {
    const rsiVals = [];
    for (let i = 0; i < closes.length; i++) {
        const slice = closes.slice(0, i + 1);
        rsiVals.push(slice.length < 14 ? 50 : calculateRSI(slice, 14));
    }
    return rsiVals;
}

function detectDivergence(price, indicator, lookback = 100, minBars = 8) {
    if (!price || !indicator || price.length < lookback) return 'None';
    try {
        const priceSwings = { highs: [], lows: [] };
        const indicatorSwings = { highs: [], lows: [] };
        for (let i = minBars; i < price.length - minBars; i++) {
            let isHigh = true, isLow = true;
            for (let j = -minBars; j <= minBars; j++) {
                if (j === 0) continue;
                if (price[i] <= price[i + j]) isHigh = false;
                if (price[i] >= price[i + j]) isLow = false;
            }
            if (isHigh) {
                priceSwings.highs.push({ value: price[i] });
                indicatorSwings.highs.push({ value: indicator[i] });
            }
            if (isLow) {
                priceSwings.lows.push({ value: price[i] });
                indicatorSwings.lows.push({ value: indicator[i] });
            }
        }
        let bearishDiv = false, bullishDiv = false;
        if (priceSwings.highs.length >= 2 && indicatorSwings.highs.length >= 2) {
            const lastPH = priceSwings.highs[priceSwings.highs.length - 1].value;
            const prevPH = priceSwings.highs[priceSwings.highs.length - 2].value;
            const lastIH = indicatorSwings.highs[indicatorSwings.highs.length - 1].value;
            const prevIH = indicatorSwings.highs[indicatorSwings.highs.length - 2].value;
            if (lastPH > prevPH && lastIH < prevIH) bearishDiv = true;
        }
        if (priceSwings.lows.length >= 2 && indicatorSwings.lows.length >= 2) {
            const lastPL = priceSwings.lows[priceSwings.lows.length - 1].value;
            const prevPL = priceSwings.lows[priceSwings.lows.length - 2].value;
            const lastIL = indicatorSwings.lows[indicatorSwings.lows.length - 1].value;
            const prevIL = indicatorSwings.lows[indicatorSwings.lows.length - 2].value;
            if (lastPL < prevPL && lastIL > prevIL) bullishDiv = true;
        }
        if (bearishDiv) return 'Bearish';
        if (bullishDiv) return 'Bullish';
        return 'None';
    } catch(e) { return 'None'; }
}

function getIchimokuSignal(highs, lows, closes) {
    if (!highs || !lows || !closes || highs.length < 52) return null;
    try {
        const high9 = Math.max(...highs.slice(-9)), low9 = Math.min(...lows.slice(-9));
        const tenkan = (high9 + low9) / 2;
        const high26 = Math.max(...highs.slice(-26)), low26 = Math.min(...lows.slice(-26));
        const kijun = (high26 + low26) / 2;
        const senkouA = (tenkan + kijun) / 2;
        const high52 = Math.max(...highs.slice(-52)), low52 = Math.min(...lows.slice(-52));
        const senkouB = (high52 + low52) / 2;
        const price = closes[closes.length - 1];
        if (price > senkouA && price > senkouB && tenkan > kijun) return 'CALL';
        if (price < senkouA && price < senkouB && tenkan < kijun) return 'PUT';
        return null;
    } catch(e) { return null; }
}

function getMACDSignal(closes) {
    if (!closes || closes.length < 26) return null;
    try {
        const ema12 = calculateEMA(closes, 12);
        const ema26 = calculateEMA(closes, 26);
        const macdLine = ema12 - ema26;
        const signalLine = calculateEMA([macdLine], 9);
        const histogram = macdLine - signalLine;
        if (histogram > 0 && macdLine > signalLine) return 'CALL';
        if (histogram < 0 && macdLine < signalLine) return 'PUT';
        return null;
    } catch(e) { return null; }
}

function getStructureSignal(closes) {
    if (!closes || closes.length < 100) return null;
    try {
        const recent = closes.slice(-100);
        let swingHighs = [], swingLows = [];
        for (let i = 10; i < recent.length - 10; i++) {
            let isHigh = true, isLow = true;
            for (let j = -10; j <= 10; j++) {
                if (j === 0) continue;
                if (recent[i] <= recent[i + j]) isHigh = false;
                if (recent[i] >= recent[i + j]) isLow = false;
            }
            if (isHigh) swingHighs.push(recent[i]);
            if (isLow) swingLows.push(recent[i]);
        }
        if (swingHighs.length >= 2 && swingLows.length >= 2) {
            const higherHighs = swingHighs[swingHighs.length - 1] > swingHighs[swingHighs.length - 2];
            const higherLows = swingLows[swingLows.length - 1] > swingLows[swingLows.length - 2];
            if (higherHighs && higherLows) return 'CALL';
            if (!higherHighs && !higherLows) return 'PUT';
        }
        return null;
    } catch(e) { return null; }
}

function getFibonacciSignal(closes) {
    if (!closes || closes.length < 100) return null;
    try {
        const high = Math.max(...closes.slice(-100)), low = Math.min(...closes.slice(-100));
        const range = high - low;
        const price = closes[closes.length - 1];
        const level382 = low + range * 0.382;
        const level618 = low + range * 0.618;
        if (price <= level618 && price >= level382) return 'CALL';
        if (price >= level618 && price <= high - (range * 0.382)) return 'PUT';
        return null;
    } catch(e) { return null; }
}

function getHigherTimeframeTrend(higherPriceData) {
    if (!higherPriceData || !higherPriceData.values || higherPriceData.values.length < 50) {
        return { trend: 'Neutral', direction: 0 };
    }
    try {
        const closes = higherPriceData.values.map(c => c.close);
        const ema20 = calculateEMA(closes, 20);
        const ema50 = calculateEMA(closes, 50);
        const price = closes[closes.length - 1];
        if (price > ema20 && price > ema50) return { trend: 'Bullish', direction: 1 };
        if (price < ema20 && price < ema50) return { trend: 'Bearish', direction: -1 };
        return { trend: 'Neutral', direction: 0 };
    } catch(e) { return { trend: 'Neutral', direction: 0 }; }
}

async function analyzeSignal(priceData, config, tf, higherPriceData = null, lowerPriceData = null) {
    try {
        const candles = priceData.values;
        if (!candles || candles.length < 100) {
            return { signal: 'CALL', confidence: 50, rsi: '50', adx: '20', adxStrength: 'Insufficient', trendDirection: 'Neutral', divergence: 'None', strategyUsed: 'Data Insufficient', priceChange: '0', volatilityPercent: '0.15', recommendation: '⚠️ Need 100+ candles' };
        }
        
        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const price = closes[closes.length - 1];
        const priceChange = ((price - closes[0]) / closes[0]) * 100;
        const rsi = calculateRSI(closes, 14);
        const { adx, plusDI, minusDI } = calculateADX(highs, lows, closes, 14);
        const vwap = calculateVWAP(candles);
        const atr = calculateATR(highs, lows, closes, 14);
        const avgPrice = closes.slice(-20).reduce((a,b)=>a+b,0)/20;
        const volatilityPercent = (atr / avgPrice) * 100;
        const adxStrength = getADXStrength(adx);
        
        const ema20 = calculateEMA(closes, 20);
        const ema50 = calculateEMA(closes, 50);
        let trendDirection = 'Neutral';
        let trendScore = 0;
        if (price > ema20 && price > ema50 && plusDI > minusDI) {
            trendDirection = 'UPTREND';
            trendScore = 1;
        } else if (price < ema20 && price < ema50 && minusDI > plusDI) {
            trendDirection = 'DOWNTREND';
            trendScore = -1;
        }
        
        const rsiVals = getRSIValues(closes);
        const rawDivergence = detectDivergence(closes, rsiVals, 100, 8);
        let divergence = 'None';
        const isOversold = rsi < 30;
        const isOverbought = rsi > 70;
        
        if (rawDivergence === 'Bullish' && isOversold) divergence = 'Bullish';
        else if (rawDivergence === 'Bearish' && isOverbought) divergence = 'Bearish';
        
        let bullish = 0, bearish = 0;
        const ichimoku = getIchimokuSignal(highs, lows, closes);
        if (ichimoku === 'CALL') bullish += 25;
        else if (ichimoku === 'PUT') bearish += 25;
        
        const macd = getMACDSignal(closes);
        if (macd === 'CALL') bullish += 20;
        else if (macd === 'PUT') bearish += 20;
        
        const structure = getStructureSignal(closes);
        if (structure === 'CALL') bullish += 20;
        else if (structure === 'PUT') bearish += 20;
        
        const fibonacci = getFibonacciSignal(closes);
        if (fibonacci === 'CALL') bullish += 15;
        else if (fibonacci === 'PUT') bearish += 15;
        
        if (divergence === 'Bullish') bullish += 20;
        else if (divergence === 'Bearish') bearish += 20;
        
        const htf = getHigherTimeframeTrend(higherPriceData);
        if (htf.direction > 0) bullish += 20;
        else if (htf.direction < 0) bearish += 20;
        
        if (price > vwap) bullish += 10;
        else bearish += 10;
        
        let signal = null;
        let baseConfidence = 55;
        let strategyUsed = '';
        
        if (divergence === 'Bearish') {
            signal = 'PUT';
            baseConfidence = 90;
            strategyUsed = 'Bearish Divergence';
        }
        else if (divergence === 'Bullish') {
            signal = 'CALL';
            baseConfidence = 90;
            strategyUsed = 'Bullish Divergence';
        }
        else if (isOversold) {
            signal = 'CALL';
            baseConfidence = 80;
            strategyUsed = 'Oversold Reversal';
        }
        else if (isOverbought) {
            signal = 'PUT';
            baseConfidence = 80;
            strategyUsed = 'Overbought Reversal';
        }
        else if (trendScore === 1) {
            signal = 'CALL';
            baseConfidence = 75;
            strategyUsed = 'Trend Following';
        }
        else if (trendScore === -1) {
            signal = 'PUT';
            baseConfidence = 75;
            strategyUsed = 'Trend Following';
        }
        else if (bullish > bearish + 30) {
            signal = 'CALL';
            baseConfidence = 70;
            strategyUsed = 'Bullish Consensus';
        }
        else if (bearish > bullish + 30) {
            signal = 'PUT';
            baseConfidence = 70;
            strategyUsed = 'Bearish Consensus';
        }
        else {
            signal = price > vwap ? 'CALL' : 'PUT';
            baseConfidence = 60;
            strategyUsed = 'VWAP Bias';
        }
        
        let adxBoost = 0;
        if (adx >= 50) adxBoost = 15;
        else if (adx >= 40) adxBoost = 12;
        else if (adx >= 30) adxBoost = 8;
        else if (adx >= 25) adxBoost = 5;
        
        let finalConfidence = baseConfidence + adxBoost;
        finalConfidence = Math.min(94, Math.max(45, finalConfidence));
        
        let intensity = '⚪ LOW';
        if (finalConfidence >= 92) intensity = '🏆🏆🏆 LEGENDARY';
        else if (finalConfidence >= 86) intensity = '🔴🔴🔴🔴 EXTREME';
        else if (finalConfidence >= 78) intensity = '🔴🔴🔴 STRONG';
        else if (finalConfidence >= 68) intensity = '🟠🟠 MODERATE';
        else if (finalConfidence >= 58) intensity = '🟡 WEAK';
        
        let recommendation = '';
        if (finalConfidence >= 86) recommendation = '✅✅✅ EXTREME HIGH PROBABILITY ✅✅✅';
        else if (finalConfidence >= 78) recommendation = '✅✅ STRONG SIGNAL ✅✅';
        else if (finalConfidence >= 68) recommendation = '✅ GOOD SIGNAL - Consider taking';
        else if (finalConfidence >= 58) recommendation = '⚠️ WEAK SIGNAL - Trade with caution';
        else recommendation = '⚠️ LOW CONFIDENCE - Better to skip';
        
        return {
            signal: signal,
            confidence: Math.round(finalConfidence),
            intensity: intensity,
            rsi: rsi.toFixed(1),
            adx: adx.toFixed(1),
            adxStrength: adxStrength,
            priceChange: priceChange.toFixed(2),
            trendDirection: trendDirection,
            volatilityPercent: volatilityPercent.toFixed(2),
            divergence: divergence,
            strategyUsed: strategyUsed,
            recommendation: recommendation,
            shouldTrade: finalConfidence >= 70 ? '✅ Consider trading' : '⚠️ Consider skipping'
        };
    } catch(e) {
        console.error('Analyzer error:', e);
        return { signal: 'CALL', confidence: 50, rsi: '50', adx: '20', trendDirection: 'Error', divergence: 'None', strategyUsed: 'Fallback', recommendation: '⚠️ Error - retry', shouldTrade: '⚠️ Skip' };
    }
}

module.exports = { analyzeSignal, recordTradeOutcome };
