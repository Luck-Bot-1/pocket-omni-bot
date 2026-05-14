const fs = require('fs');
const path = require('path');
const BACKTEST_FILE = path.join(__dirname, 'backtest_stats.json');

// ============================================
// PROFESSIONAL BACKTEST & LEARNING
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

function getHistoricalWinRate(pair, tf, patternId) {
    const stats = loadStats();
    const key = `${pair}_${tf}_${patternId}`;
    if (stats[key] && stats[key].total >= 10) return stats[key].winRate;
    return null;
}

// ============================================
// TECHNICAL INDICATORS
// ============================================
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

// ============================================
// ADVANCED DIVERGENCE DETECTION
// ============================================
function getRSIValues(closes) {
    const rsiVals = [];
    for (let i = 0; i < closes.length; i++) {
        const slice = closes.slice(0, i + 1);
        rsiVals.push(slice.length < 14 ? 50 : calculateRSI(slice, 14));
    }
    return rsiVals;
}

function detectDivergence(price, indicator, lookback = 100, minBars = 8) {
    if (!price || !indicator || price.length < lookback) {
        return 'None';
    }
    
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
            priceSwings.highs.push({ index: i, value: price[i] });
            indicatorSwings.highs.push({ index: i, value: indicator[i] });
        }
        if (isLow) {
            priceSwings.lows.push({ index: i, value: price[i] });
            indicatorSwings.lows.push({ index: i, value: indicator[i] });
        }
    }
    
    let bearishDiv = false, bullishDiv = false;
    
    if (priceSwings.highs.length >= 2 && indicatorSwings.highs.length >= 2) {
        const lastPH = priceSwings.highs[priceSwings.highs.length - 1];
        const prevPH = priceSwings.highs[priceSwings.highs.length - 2];
        const lastIH = indicatorSwings.highs[indicatorSwings.highs.length - 1];
        const prevIH = indicatorSwings.highs[indicatorSwings.highs.length - 2];
        if (lastPH.value > prevPH.value && lastIH.value < prevIH.value) bearishDiv = true;
    }
    
    if (priceSwings.lows.length >= 2 && indicatorSwings.lows.length >= 2) {
        const lastPL = priceSwings.lows[priceSwings.lows.length - 1];
        const prevPL = priceSwings.lows[priceSwings.lows.length - 2];
        const lastIL = indicatorSwings.lows[indicatorSwings.lows.length - 1];
        const prevIL = indicatorSwings.lows[indicatorSwings.lows.length - 2];
        if (lastPL.value < prevPL.value && lastIL.value > prevIL.value) bullishDiv = true;
    }
    
    if (bearishDiv) return 'Bearish';
    if (bullishDiv) return 'Bullish';
    return 'None';
}

// ============================================
// LEGENDARY STRATEGIES
// ============================================
function getIchimokuSignal(highs, lows, closes) {
    if (!highs || !lows || !closes || highs.length < 52) return null;
    try {
        const high9 = Math.max(...highs.slice(-9));
        const low9 = Math.min(...lows.slice(-9));
        const tenkan = (high9 + low9) / 2;
        const high26 = Math.max(...highs.slice(-26));
        const low26 = Math.min(...lows.slice(-26));
        const kijun = (high26 + low26) / 2;
        const senkouA = (tenkan + kijun) / 2;
        const high52 = Math.max(...highs.slice(-52));
        const low52 = Math.min(...lows.slice(-52));
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
        const high = Math.max(...closes.slice(-100));
        const low = Math.min(...closes.slice(-100));
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

function getSessionBonus(pair) {
    try {
        const hour = new Date().getHours();
        const day = new Date().getDay();
        if (day === 0 || day === 6) return -30;
        if (pair.includes('EUR') || pair.includes('GBP')) {
            if (hour >= 13 && hour <= 22) return 15;
            if (hour >= 18 || hour <= 2) return 10;
        } else if (pair.includes('USD') || pair.includes('CAD')) {
            if (hour >= 18 || hour <= 2) return 15;
            if (hour >= 13 && hour <= 22) return 10;
        } else {
            if (hour >= 1 && hour <= 7) return 15;
        }
        return 0;
    } catch(e) { return 0; }
}

function getSignalIntensity(conf) {
    if (conf >= 85) return '🔴🔴🔴🔴 EXTREME';
    if (conf >= 75) return '🔴🔴🔴 STRONG';
    if (conf >= 65) return '🟠🟠 MODERATE';
    if (conf >= 55) return '🟡 WEAK';
    return '⚪ LOW';
}

// ============================================
// MAIN SIGNAL GENERATION - CORRECT PRIORITY
// ============================================
async function analyzeSignal(priceData, config, tf, higherPriceData = null, lowerPriceData = null) {
    try {
        const candles = priceData.values;
        if (!candles || candles.length < 100) {
            return { 
                signal: 'CALL', confidence: 50, intensity: '⚪ LOW', 
                rsi: '50', adx: '20', adxStrength: 'Insufficient',
                trendDirection: 'Unknown', divergence: 'None',
                ichimoku: 'N/A', macd: 'N/A', structure: 'N/A', fibonacci: 'N/A',
                recommendation: '⚠️ Need more data', shouldTrade: '⚠️ Skip'
            };
        }
        
        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const price = closes[closes.length - 1];
        const rsi = calculateRSI(closes, 14);
        const { adx, plusDI, minusDI } = calculateADX(highs, lows, closes, 14);
        const change = ((price - closes[0]) / closes[0]) * 100;
        const vwap = calculateVWAP(candles);
        const atr = calculateATR(highs, lows, closes, 14);
        const avgPrice = closes.slice(-20).reduce((a,b)=>a+b,0)/20;
        const volatilityPercent = (atr / avgPrice) * 100;
        
        const adxStrength = getADXStrength(adx);
        
        // TREND DIRECTION
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
        
        // DIVERGENCE DETECTION
        const rsiVals = getRSIValues(closes);
        const divergence = detectDivergence(closes, rsiVals, 100, 8);
        
        // ALL STRATEGIES
        const ichimoku = getIchimokuSignal(highs, lows, closes);
        const macd = getMACDSignal(closes);
        const structure = getStructureSignal(closes);
        const fibonacci = getFibonacciSignal(closes);
        const htf = getHigherTimeframeTrend(higherPriceData);
        const sessionBonus = getSessionBonus(config.pairName || '');
        
        // VOTING SYSTEM
        let bullish = 0, bearish = 0, strategies = 0;
        
        if (ichimoku === 'CALL') { bullish += 25; strategies++; }
        else if (ichimoku === 'PUT') { bearish += 25; strategies++; }
        
        if (macd === 'CALL') { bullish += 20; strategies++; }
        else if (macd === 'PUT') { bearish += 20; strategies++; }
        
        if (structure === 'CALL') { bullish += 20; strategies++; }
        else if (structure === 'PUT') { bearish += 20; strategies++; }
        
        if (fibonacci === 'CALL') { bullish += 15; strategies++; }
        else if (fibonacci === 'PUT') { bearish += 15; strategies++; }
        
        if (htf.direction > 0) { bullish += 20; }
        else if (htf.direction < 0) { bearish += 20; }
        
        if (price > vwap) { bullish += 10; }
        else { bearish += 10; }
        
        // ============================================
        // CORRECT STRATEGY PRIORITY
        // PRIORITY 1: DIVERGENCE (HIGHEST - OVERRIDES ALL)
        // PRIORITY 2: OVERSOLD/OVERBOUGHT
        // PRIORITY 3: TREND FOLLOWING
        // PRIORITY 4: VOTING CONSENSUS
        // PRIORITY 5: DEFAULT VWAP
        // ============================================
        let signal = null;
        let baseConfidence = 55;
        let strategyUsed = '';
        let trendDesc = '';
        
        const isOversold = rsi < 35;
        const isOverbought = rsi > 65;
        
        // PRIORITY 1: DIVERGENCE (HIGHEST PRIORITY)
        if (divergence === 'Bearish') {
            signal = 'PUT';
            baseConfidence = 85;
            strategyUsed = 'Bearish Divergence (PRIORITY #1)';
            trendDesc = `🔴 BEARISH DIVERGENCE DETECTED → STRONG SELL SIGNAL 📉`;
        }
        else if (divergence === 'Bullish') {
            signal = 'CALL';
            baseConfidence = 85;
            strategyUsed = 'Bullish Divergence (PRIORITY #1)';
            trendDesc = `🟢 BULLISH DIVERGENCE DETECTED → STRONG BUY SIGNAL 📈`;
        }
        // PRIORITY 2: OVERSOLD/OVERBOUGHT
        else if (isOversold) {
            signal = 'CALL';
            baseConfidence = 78;
            strategyUsed = 'Oversold Reversal';
            trendDesc = `⚠️ OVERSOLD (RSI: ${rsi.toFixed(0)}) → EXPECTING BOUNCE UP 📈`;
        }
        else if (isOverbought) {
            signal = 'PUT';
            baseConfidence = 78;
            strategyUsed = 'Overbought Reversal';
            trendDesc = `⚠️ OVERBOUGHT (RSI: ${rsi.toFixed(0)}) → EXPECTING PULLBACK DOWN 📉`;
        }
        // PRIORITY 3: TREND FOLLOWING
        else if (trendScore === 1) {
            signal = 'CALL';
            baseConfidence = 68;
            strategyUsed = 'Trend Following';
            trendDesc = `📈 UPTREND → FOLLOW TREND UP 📈`;
        }
        else if (trendScore === -1) {
            signal = 'PUT';
            baseConfidence = 68;
            strategyUsed = 'Trend Following';
            trendDesc = `📉 DOWNTREND → FOLLOW TREND DOWN 📉`;
        }
        // PRIORITY 4: VOTING CONSENSUS
        else if (bullish > bearish + 20 && strategies >= 2) {
            signal = 'CALL';
            baseConfidence = 65;
            strategyUsed = `Bullish Consensus (${strategies} strategies)`;
            trendDesc = `📈 BULLISH CONSENSUS → BUY`;
        }
        else if (bearish > bullish + 20 && strategies >= 2) {
            signal = 'PUT';
            baseConfidence = 65;
            strategyUsed = `Bearish Consensus (${strategies} strategies)`;
            trendDesc = `📉 BEARISH CONSENSUS → SELL`;
        }
        // PRIORITY 5: DEFAULT VWAP
        else {
            signal = price > vwap ? 'CALL' : 'PUT';
            baseConfidence = 55;
            strategyUsed = 'VWAP Bias';
            trendDesc = `⚖️ NEUTRAL → Following VWAP (${price > vwap ? 'ABOVE' : 'BELOW'})`;
        }
        
        // CONFIDENCE ADJUSTMENTS
        let finalConfidence = baseConfidence + sessionBonus;
        
        if (adx >= 40) finalConfidence += 5;
        else if (adx >= 30) finalConfidence += 3;
        else if (adx < 20) finalConfidence -= 5;
        
        if (volatilityPercent > 0.35) finalConfidence += 5;
        else if (volatilityPercent < 0.15) finalConfidence -= 10;
        
        // Historical learning
        const patternId = `${signal}_${strategyUsed.replace(/ /g, '_')}`;
        const historical = getHistoricalWinRate(config.pairName || 'UNKNOWN', tf, patternId);
        if (historical !== null) {
            finalConfidence = Math.floor((finalConfidence * 0.6) + (historical * 0.4));
        }
        
        finalConfidence = Math.min(92, Math.max(45, finalConfidence));
        const intensity = getSignalIntensity(finalConfidence);
        
        let recommendation = '';
        if (finalConfidence >= 85) recommendation = '✅✅✅ EXTREME HIGH PROBABILITY ✅✅✅';
        else if (finalConfidence >= 75) recommendation = '✅✅ STRONG SIGNAL - Good probability ✅✅';
        else if (finalConfidence >= 65) recommendation = '✅ GOOD SIGNAL - Consider taking';
        else if (finalConfidence >= 55) recommendation = '⚠️ WEAK SIGNAL - Trade with caution';
        else recommendation = '⚠️ LOW CONFIDENCE - Better to skip';
        
        return {
            signal: signal,
            confidence: Math.round(finalConfidence),
            intensity: intensity,
            rsi: rsi.toFixed(1),
            adx: adx.toFixed(1),
            adxStrength: adxStrength,
            priceChange: change.toFixed(2),
            trendDirection: trendDirection,
            volatilityPercent: volatilityPercent.toFixed(2),
            divergence: divergence,
            ichimoku: ichimoku || 'Neutral',
            macd: macd || 'Neutral',
            structure: structure || 'Neutral',
            fibonacci: fibonacci || 'Neutral',
            strategyUsed: strategyUsed,
            trend: trendDesc,
            trendAlignment: `📊 Div:${divergence} RSI:${rsi.toFixed(0)} ADX:${adx.toFixed(0)}(${adxStrength}) | ${intensity} (${Math.round(finalConfidence)}%)`,
            patternId: patternId,
            historicalWinRate: historical ? historical.toFixed(1) + '%' : 'Learning...',
            recommendation: recommendation,
            shouldTrade: finalConfidence >= 68 ? '✅ Consider trading' : '⚠️ Consider skipping'
        };
    } catch(e) {
        console.error('Analyzer error:', e);
        return { 
            signal: 'CALL', confidence: 50, intensity: '⚪ LOW', 
            rsi: '50', adx: '20', adxStrength: 'Error',
            trendDirection: 'Unknown', divergence: 'None',
            ichimoku: 'Error', macd: 'Error', structure: 'Error', fibonacci: 'Error',
            recommendation: '⚠️ Error - skip', shouldTrade: '⚠️ Skip'
        };
    }
}

module.exports = { analyzeSignal, recordTradeOutcome };
