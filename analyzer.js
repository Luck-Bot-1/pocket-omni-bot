const fs = require('fs');
const path = require('path');
const BACKTEST_FILE = path.join(__dirname, 'backtest_stats.json');

// ============================================
// LEGENDARY BACKTEST ENGINE (MONTE CARLO READY)
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
    if (stats[key] && stats[key].total >= 20) return stats[key].winRate;
    return null;
}

// ============================================
// CORE INDICATORS (OPTIMIZED)
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
// INSTITUTIONAL VOLATILITY CAP (RENAISSANCE)
// ============================================
function getVolatilityCap(volatilityPercent) {
    if (volatilityPercent < 0.10) {
        return { maxConfidence: 40, canTrade: false, reason: 'DEAD MARKET - NO TRADE', tier: 'F' };
    }
    if (volatilityPercent < 0.15) {
        return { maxConfidence: 50, canTrade: false, reason: 'EXTREMELY LOW VOLATILITY - SKIP', tier: 'D' };
    }
    if (volatilityPercent < 0.22) {
        return { maxConfidence: 65, canTrade: true, reason: 'LOW VOLATILITY - REDUCED CONFIDENCE', tier: 'C' };
    }
    if (volatilityPercent > 0.45) {
        return { maxConfidence: 92, canTrade: true, reason: 'HIGH VOLATILITY - EXCELLENT', tier: 'A' };
    }
    return { maxConfidence: 80, canTrade: true, reason: 'NORMAL VOLATILITY', tier: 'B' };
}

// ============================================
// INSTITUTIONAL ADX QUALITY (TWO SIGMA)
// ============================================
function getADXQuality(adx) {
    if (adx < 20) return { quality: 'POOR', multiplier: 0.4, description: 'SIDEWAYS - AVOID' };
    if (adx < 25) return { quality: 'WEAK', multiplier: 0.6, description: 'WEAK TREND - CAUTION' };
    if (adx < 35) return { quality: 'FAIR', multiplier: 0.85, description: 'MODERATE TREND' };
    if (adx < 50) return { quality: 'GOOD', multiplier: 1.0, description: 'STRONG TREND' };
    return { quality: 'EXCELLENT', multiplier: 1.15, description: 'EXTREME TREND' };
}

// ============================================
// VOLUME PROFILE (JUMP TRADING)
// ============================================
function getVolumeConfidence(candles) {
    try {
        const volumes = candles.map(c => c.volume || 0);
        const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const currentVolume = volumes[volumes.length - 1] || 0;
        const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;
        
        if (volumeRatio < 0.5) return { confidence: -25, reason: 'EXTREMELY LOW VOLUME - FAKEOUT' };
        if (volumeRatio < 0.8) return { confidence: -15, reason: 'LOW VOLUME' };
        if (volumeRatio > 2.0) return { confidence: 15, reason: 'VERY HIGH VOLUME - STRONG' };
        if (volumeRatio > 1.5) return { confidence: 10, reason: 'HIGH VOLUME CONFIRMATION' };
        return { confidence: 0, reason: 'NORMAL VOLUME' };
    } catch(e) { return { confidence: 0, reason: 'VOLUME UNAVAILABLE' }; }
}

// ============================================
// ORDER BLOCK DETECTION (CITADEL)
// ============================================
function detectOrderBlocks(candles) {
    try {
        const orderBlocks = { bullish: [], bearish: [] };
        for (let i = 2; i < candles.length - 2; i++) {
            const prev = candles[i-1];
            const curr = candles[i];
            if (prev.close < prev.open && curr.close > curr.open && curr.low <= prev.low) {
                orderBlocks.bullish.push({ price: curr.low });
            }
            if (prev.close > prev.open && curr.close < curr.open && curr.high >= prev.high) {
                orderBlocks.bearish.push({ price: curr.high });
            }
        }
        const currentPrice = candles[candles.length - 1].close;
        let nearestBullishOB = null, nearestBearishOB = null;
        for (const ob of orderBlocks.bullish) {
            if (ob.price < currentPrice && (!nearestBullishOB || ob.price > nearestBullishOB.price)) nearestBullishOB = ob;
        }
        for (const ob of orderBlocks.bearish) {
            if (ob.price > currentPrice && (!nearestBearishOB || ob.price < nearestBearishOB.price)) nearestBearishOB = ob;
        }
        return { nearestBullishOB, nearestBearishOB };
    } catch(e) { return { nearestBullishOB: null, nearestBearishOB: null }; }
}

// ============================================
// RISK-REWARD (DE SHAW)
// ============================================
function calculateRiskReward(highs, lows, closes, signal, entryPrice) {
    try {
        const atr = calculateATR(highs, lows, closes, 14);
        const recentHighs = highs.slice(-20);
        const recentLows = lows.slice(-20);
        let stopLoss, takeProfit, riskReward;
        if (signal === 'CALL') {
            const swingLow = Math.min(...recentLows);
            stopLoss = swingLow - atr * 0.75;
            takeProfit = entryPrice + (entryPrice - stopLoss) * 2.5;
            riskReward = (takeProfit - entryPrice) / (entryPrice - stopLoss);
        } else {
            const swingHigh = Math.max(...recentHighs);
            stopLoss = swingHigh + atr * 0.75;
            takeProfit = entryPrice - (stopLoss - entryPrice) * 2.5;
            riskReward = (entryPrice - takeProfit) / (stopLoss - entryPrice);
        }
        return { riskReward: riskReward || 1, isValid: (riskReward || 0) >= 1.8 };
    } catch(e) { return { riskReward: 1, isValid: false }; }
}

// ============================================
// SESSION FILTER
// ============================================
function getInstitutionalSession(pair) {
    try {
        const hour = new Date().getHours();
        const day = new Date().getDay();
        if (day === 0 || day === 6) return { quality: 'POOR', multiplier: 0.3, session: 'WEEKEND' };
        if (hour >= 13 && hour <= 16) return { quality: 'EXCELLENT', multiplier: 1.5, session: 'LONDON_NY_OVERLAP' };
        if (hour >= 8 && hour <= 10) return { quality: 'EXCELLENT', multiplier: 1.4, session: 'LONDON_OPEN' };
        if (hour >= 17 && hour <= 19) return { quality: 'GOOD', multiplier: 1.3, session: 'NY_OPEN' };
        if (hour >= 1 && hour <= 6) return { quality: 'POOR', multiplier: 0.5, session: 'ASIAN' };
        return { quality: 'FAIR', multiplier: 0.8, session: 'OFF_HOURS' };
    } catch(e) { return { quality: 'FAIR', multiplier: 0.8, session: 'UNKNOWN' }; }
}

// ============================================
// SENTIMENT INDICATOR
// ============================================
function getSentiment(rsi, adx, volatilityPercent) {
    if (rsi > 75 && adx > 30 && volatilityPercent > 0.25) {
        return { sentiment: 'EXTREME GREED', bias: 'BEARISH', confidence: 85 };
    }
    if (rsi < 25 && adx > 30 && volatilityPercent > 0.25) {
        return { sentiment: 'EXTREME FEAR', bias: 'BULLISH', confidence: 85 };
    }
    if (rsi > 65) return { sentiment: 'GREED', bias: 'BEARISH', confidence: 65 };
    if (rsi < 35) return { sentiment: 'FEAR', bias: 'BULLISH', confidence: 65 };
    return { sentiment: 'NEUTRAL', bias: 'NEUTRAL', confidence: 50 };
}

// ============================================
// NEWS FILTER
// ============================================
function isNewsEvent() {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTimestamp = currentHour * 60 + currentMinute;
    
    const newsTimes = {
        'NFP': { start: 510, end: 540 },
        'CPI': { start: 510, end: 540 },
        'FOMC': { start: 1080, end: 1140 },
        'ECB': { start: 630, end: 660 },
        'BOJ': { start: 0, end: 30 }
    };
    
    for (const [event, times] of Object.entries(newsTimes)) {
        if (currentTimestamp >= times.start - 30 && currentTimestamp <= times.end + 30) {
            return { isNews: true, event: event };
        }
    }
    return { isNews: false, event: null };
}

// ============================================
// INSTITUTIONAL DIVERGENCE (REQUIRES EXTREMES)
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

// ============================================
// LEGENDARY STRATEGIES
// ============================================
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

function getSignalIntensity(conf) {
    if (conf >= 90) return '🏆🏆🏆 LEGENDARY';
    if (conf >= 85) return '🔴🔴🔴🔴 EXTREME';
    if (conf >= 75) return '🔴🔴🔴 STRONG';
    if (conf >= 65) return '🟠🟠 MODERATE';
    if (conf >= 55) return '🟡 WEAK';
    return '⚪ LOW';
}

// ============================================
// MAIN LEGENDARY SIGNAL GENERATION
// ============================================
async function analyzeSignal(priceData, config, tf, higherPriceData = null, lowerPriceData = null) {
    try {
        const candles = priceData.values;
        if (!candles || candles.length < 100) {
            return { 
                signal: 'CALL', confidence: 50, intensity: '⚪ LOW', 
                rsi: '50', adx: '20', adxStrength: 'Insufficient',
                trendDirection: 'Unknown', divergence: 'None',
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
        
        // ============================================
        // INSTITUTIONAL FILTERS (PRIORITY ORDER)
        // ============================================
        
        // 1. NEWS FILTER (HIGHEST PRIORITY)
        const news = isNewsEvent();
        if (news.isNews) {
            const fallbackSignal = price > vwap ? 'CALL' : 'PUT';
            return {
                signal: fallbackSignal, confidence: 40, intensity: '⚪ LOW',
                rsi: rsi.toFixed(1), adx: adx.toFixed(1), adxStrength: adxStrength,
                trendDirection: 'Unknown', divergence: 'None',
                recommendation: `⚠️ ${news.event} NEWS EVENT - NO TRADE ZONE`, shouldTrade: '⚠️ Skip'
            };
        }
        
        // 2. VOLATILITY CAP
        const volatilityCap = getVolatilityCap(volatilityPercent);
        if (!volatilityCap.canTrade) {
            const fallbackSignal = price > vwap ? 'CALL' : 'PUT';
            return { 
                signal: fallbackSignal, confidence: volatilityCap.maxConfidence, intensity: '⚪ LOW',
                rsi: rsi.toFixed(1), adx: adx.toFixed(1), adxStrength: adxStrength,
                trendDirection: 'Unknown', divergence: 'None',
                recommendation: `⚠️ ${volatilityCap.reason}`, shouldTrade: '⚠️ Skip'
            };
        }
        
        // 3. ADX QUALITY
        const adxQuality = getADXQuality(adx);
        
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
        
        // 4. SENTIMENT
        const sentiment = getSentiment(rsi, adx, volatilityPercent);
        
        // 5. DIVERGENCE (REQUIRES RSI EXTREMES)
        const rsiVals = getRSIValues(closes);
        const rawDivergence = detectDivergence(closes, rsiVals, 100, 8);
        let divergence = 'None';
        const isOversold = rsi < 30;
        const isOverbought = rsi > 70;
        
        if (rawDivergence === 'Bullish' && isOversold) divergence = 'Bullish';
        else if (rawDivergence === 'Bearish' && isOverbought) divergence = 'Bearish';
        
        // 6. VOLUME CONFIRMATION
        const volumeConf = getVolumeConfidence(candles);
        
        // 7. ORDER BLOCKS
        const orderBlocks = detectOrderBlocks(candles);
        
        // 8. RISK-REWARD
        const rr = calculateRiskReward(highs, lows, closes, 'CALL', price);
        
        // 9. SESSION
        const institutionalSession = getInstitutionalSession(config.pairName || '');
        
        // ============================================
        // STRATEGY VOTING (INSTITUTIONAL WEIGHTS)
        // ============================================
        let bullish = 0, bearish = 0, strategies = 0;
        
        // Ichimoku (25 weight)
        const ichimoku = getIchimokuSignal(highs, lows, closes);
        if (ichimoku === 'CALL') { bullish += 25; strategies++; }
        else if (ichimoku === 'PUT') { bearish += 25; strategies++; }
        
        // MACD (20 weight)
        const macd = getMACDSignal(closes);
        if (macd === 'CALL') { bullish += 20; strategies++; }
        else if (macd === 'PUT') { bearish += 20; strategies++; }
        
        // Structure (20 weight)
        const structure = getStructureSignal(closes);
        if (structure === 'CALL') { bullish += 20; strategies++; }
        else if (structure === 'PUT') { bearish += 20; strategies++; }
        
        // Fibonacci (15 weight)
        const fibonacci = getFibonacciSignal(closes);
        if (fibonacci === 'CALL') { bullish += 15; strategies++; }
        else if (fibonacci === 'PUT') { bearish += 15; strategies++; }
        
        // Sentiment (15 weight)
        if (sentiment.bias === 'BULLISH') { bullish += 15; strategies++; }
        else if (sentiment.bias === 'BEARISH') { bearish += 15; strategies++; }
        
        // Divergence (20 weight)
        if (divergence === 'Bullish') { bullish += 20; strategies++; }
        else if (divergence === 'Bearish') { bearish += 20; strategies++; }
        
        // Higher Timeframe (20 weight)
        const htf = getHigherTimeframeTrend(higherPriceData);
        if (htf.direction > 0) { bullish += 20; }
        else if (htf.direction < 0) { bearish += 20; }
        
        // VWAP (10 weight)
        if (price > vwap) { bullish += 10; }
        else { bearish += 10; }
        
        // ============================================
        // SIGNAL DETERMINATION
        // ============================================
        let signal = null;
        let baseConfidence = 55;
        let strategyUsed = '';
        let trendDesc = '';
        
        if (divergence === 'Bearish') {
            signal = 'PUT';
            baseConfidence = 90;
            strategyUsed = 'INSTITUTIONAL BEARISH DIVERGENCE';
            trendDesc = `🔴 LEGENDARY BEARISH DIVERGENCE (RSI: ${rsi.toFixed(0)}) → SELL 📉`;
        }
        else if (divergence === 'Bullish') {
            signal = 'CALL';
            baseConfidence = 90;
            strategyUsed = 'INSTITUTIONAL BULLISH DIVERGENCE';
            trendDesc = `🟢 LEGENDARY BULLISH DIVERGENCE (RSI: ${rsi.toFixed(0)}) → BUY 📈`;
        }
        else if (isOversold) {
            signal = 'CALL';
            baseConfidence = 80;
            strategyUsed = 'OVERSOLD REVERSAL';
            trendDesc = `⚠️ OVERSOLD (RSI: ${rsi.toFixed(0)}) → BOUNCE UP 📈`;
        }
        else if (isOverbought) {
            signal = 'PUT';
            baseConfidence = 80;
            strategyUsed = 'OVERBOUGHT REVERSAL';
            trendDesc = `⚠️ OVERBOUGHT (RSI: ${rsi.toFixed(0)}) → PULLBACK DOWN 📉`;
        }
        else if (trendScore === 1 && bullish > bearish + 30) {
            signal = 'CALL';
            baseConfidence = 75;
            strategyUsed = 'STRONG TREND FOLLOWING';
            trendDesc = `📈 STRONG UPTREND → BUY 📈`;
        }
        else if (trendScore === -1 && bearish > bullish + 30) {
            signal = 'PUT';
            baseConfidence = 75;
            strategyUsed = 'STRONG TREND FOLLOWING';
            trendDesc = `📉 STRONG DOWNTREND → SELL 📉`;
        }
        else if (bullish > bearish + 30 && strategies >= 3) {
            signal = 'CALL';
            baseConfidence = 70;
            strategyUsed = `BULLISH CONSENSUS (${strategies} strategies)`;
            trendDesc = `📈 STRONG BULLISH CONSENSUS → BUY`;
        }
        else if (bearish > bullish + 30 && strategies >= 3) {
            signal = 'PUT';
            baseConfidence = 70;
            strategyUsed = `BEARISH CONSENSUS (${strategies} strategies)`;
            trendDesc = `📉 STRONG BEARISH CONSENSUS → SELL`;
        }
        else {
            signal = price > vwap ? 'CALL' : 'PUT';
            baseConfidence = 50;
            strategyUsed = 'VWAP BIAS';
            trendDesc = `⚖️ NEUTRAL → Following VWAP`;
        }
        
        // ============================================
        // APPLY ALL FILTERS
        // ============================================
        let finalConfidence = baseConfidence;
        
        // Apply volatility cap
        finalConfidence = Math.min(finalConfidence, volatilityCap.maxConfidence);
        
        // Apply ADX multiplier
        finalConfidence = Math.floor(finalConfidence * adxQuality.multiplier);
        
        // Apply volume confidence
        finalConfidence += volumeConf.confidence;
        
        // Apply risk-reward
        if (!rr.isValid) finalConfidence -= 20;
        else finalConfidence += 8;
        
        // Apply order block bonus
        if (signal === 'CALL' && orderBlocks.nearestBullishOB && 
            Math.abs(price - orderBlocks.nearestBullishOB.price) / price < 0.002) {
            finalConfidence += 15;
            trendDesc += ` ✅ NEAR BULLISH ORDER BLOCK`;
        }
        if (signal === 'PUT' && orderBlocks.nearestBearishOB && 
            Math.abs(price - orderBlocks.nearestBearishOB.price) / price < 0.002) {
            finalConfidence += 15;
            trendDesc += ` ✅ NEAR BEARISH ORDER BLOCK`;
        }
        
        // Apply session multiplier
        finalConfidence = Math.floor(finalConfidence * institutionalSession.multiplier);
        
        // Apply sentiment alignment
        if ((signal === 'CALL' && sentiment.bias === 'BULLISH') ||
            (signal === 'PUT' && sentiment.bias === 'BEARISH')) {
            finalConfidence += 10;
            trendDesc += ` ✅ SENTIMENT ALIGNED: ${sentiment.sentiment}`;
        }
        
        // Higher timeframe alignment
        if ((signal === 'CALL' && htf.direction === 1) ||
            (signal === 'PUT' && htf.direction === -1)) {
            finalConfidence += 10;
            trendDesc += ` ✅ HTF ALIGNED: ${htf.trend}`;
        }
        if ((signal === 'CALL' && htf.direction === -1) ||
            (signal === 'PUT' && htf.direction === 1)) {
            finalConfidence = Math.min(finalConfidence, 55);
            trendDesc += ` ⚠️ HTF CONFLICT: ${htf.trend}`;
        }
        
        // Historical learning (requires 20+ trades)
        const patternId = `${signal}_${strategyUsed.replace(/ /g, '_')}`;
        const historical = getHistoricalWinRate(config.pairName || 'UNKNOWN', tf, patternId);
        if (historical !== null) {
            finalConfidence = Math.floor((finalConfidence * 0.7) + (historical * 0.3));
        }
        
        finalConfidence = Math.min(volatilityCap.maxConfidence, Math.max(45, finalConfidence));
        const intensity = getSignalIntensity(finalConfidence);
        
        let recommendation = '';
        if (finalConfidence >= 90) recommendation = '🏆🏆🏆 LEGENDARY SIGNAL - HIGHEST PROBABILITY 🏆🏆🏆';
        else if (finalConfidence >= 85) recommendation = '✅✅✅ EXTREME HIGH PROBABILITY ✅✅✅';
        else if (finalConfidence >= 75) recommendation = '✅✅ STRONG SIGNAL - Good probability ✅✅';
        else if (finalConfidence >= 65) recommendation = '✅ GOOD SIGNAL - Consider taking';
        else if (finalConfidence >= 55) recommendation = '⚠️ WEAK SIGNAL - Trade with caution';
        else recommendation = '⚠️ LOW CONFIDENCE - Better to skip';
        
        if (adxQuality.multiplier < 0.8) recommendation += ` ⚠️ ${adxQuality.description}`;
        if (volumeConf.confidence < 0) recommendation += ` ⚠️ ${volumeConf.reason}`;
        
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
            sentiment: sentiment.sentiment,
            volumeQuality: volumeConf.reason,
            adxQuality: adxQuality.description,
            session: institutionalSession.session,
            strategyUsed: strategyUsed,
            trend: trendDesc,
            riskReward: rr.riskReward.toFixed(1),
            recommendation: recommendation,
            shouldTrade: finalConfidence >= 70 ? '✅ Consider trading' : '⚠️ Consider skipping'
        };
    } catch(e) {
        console.error('Analyzer error:', e);
        return { 
            signal: 'CALL', confidence: 50, intensity: '⚪ LOW', 
            rsi: '50', adx: '20', adxStrength: 'Error',
            trendDirection: 'Unknown', divergence: 'None',
            recommendation: '⚠️ Error - skip', shouldTrade: '⚠️ Skip'
        };
    }
}

module.exports = { analyzeSignal, recordTradeOutcome };
