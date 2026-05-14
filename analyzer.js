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

// ============================================
// SUPPORT/RESISTANCE (LIQUIDITY ZONES)
// ============================================
function calculateSupportResistance(closes, highs, lows) {
    if (!highs || !lows || highs.length < 50) {
        return { nearestResistance: null, nearestSupport: null, nearResistance: false, nearSupport: false };
    }
    const recentHighs = highs.slice(-50);
    const recentLows = lows.slice(-50);
    const currentPrice = closes[closes.length - 1];
    
    let resistances = [], supports = [];
    for (let i = 5; i < recentHighs.length - 5; i++) {
        let isResistance = true, isSupport = true;
        for (let j = -5; j <= 5; j++) {
            if (j === 0) continue;
            if (recentHighs[i] <= recentHighs[i + j]) isResistance = false;
            if (recentLows[i] >= recentLows[i + j]) isSupport = false;
        }
        if (isResistance) resistances.push(recentHighs[i]);
        if (isSupport) supports.push(recentLows[i]);
    }
    
    let nearestResistance = null, nearestSupport = null;
    for (let r of resistances) {
        if (r > currentPrice && (!nearestResistance || r < nearestResistance)) nearestResistance = r;
    }
    for (let s of supports) {
        if (s < currentPrice && (!nearestSupport || s > nearestSupport)) nearestSupport = s;
    }
    
    return { 
        nearestResistance, nearestSupport, 
        nearResistance: nearestResistance !== null && (nearestResistance - currentPrice) / currentPrice < 0.002,
        nearSupport: nearestSupport !== null && (currentPrice - nearestSupport) / currentPrice < 0.002
    };
}

// ============================================
// DIVERGENCE DETECTION (CORE)
// ============================================
function detectDivergence(price, indicator, lookback = 100, minBars = 8) {
    if (!price || !indicator || price.length < lookback) {
        return { type: 'None', confidence: 0, strength: 0 };
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
    
    let bearishDiv = false, bullishDiv = false, strength = 0;
    
    if (priceSwings.highs.length >= 2 && indicatorSwings.highs.length >= 2) {
        const lastPH = priceSwings.highs[priceSwings.highs.length - 1];
        const prevPH = priceSwings.highs[priceSwings.highs.length - 2];
        const lastIH = indicatorSwings.highs[indicatorSwings.highs.length - 1];
        const prevIH = indicatorSwings.highs[indicatorSwings.highs.length - 2];
        if (lastPH.value > prevPH.value && lastIH.value < prevIH.value) {
            bearishDiv = true;
            strength = Math.min(85, 60 + Math.abs((lastPH.value - prevPH.value) / prevPH.value * 100));
        }
    }
    
    if (priceSwings.lows.length >= 2 && indicatorSwings.lows.length >= 2) {
        const lastPL = priceSwings.lows[priceSwings.lows.length - 1];
        const prevPL = priceSwings.lows[priceSwings.lows.length - 2];
        const lastIL = indicatorSwings.lows[indicatorSwings.lows.length - 1];
        const prevIL = indicatorSwings.lows[indicatorSwings.lows.length - 2];
        if (lastPL.value < prevPL.value && lastIL.value > prevIL.value) {
            bullishDiv = true;
            strength = Math.min(85, 60 + Math.abs((prevPL.value - lastPL.value) / prevPL.value * 100));
        }
    }
    
    if (bearishDiv) return { type: 'Bearish', confidence: strength, strength: strength };
    if (bullishDiv) return { type: 'Bullish', confidence: strength, strength: strength };
    return { type: 'None', confidence: 0, strength: 0 };
}

// ============================================
// MARKET REGIME DETECTION
// ============================================
function detectMarketRegime(highs, lows, closes) {
    const { adx } = calculateADX(highs, lows, closes, 14);
    const atr = calculateATR(highs, lows, closes, 14);
    const avgPrice = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const volatilityPercent = (atr / avgPrice) * 100;
    const atrMultiplier = atr / avgPrice;
    
    let regime = 'Normal', maxConfidence = 85, canTrade = true, reason = '';
    
    if (volatilityPercent < 0.08 || atrMultiplier < 0.00025) {
        regime = 'DEAD MARKET'; maxConfidence = 40; canTrade = false;
        reason = 'Market is dead - NO TRADE WHATSOEVER';
    } else if (volatilityPercent < 0.12 || atrMultiplier < 0.0004) {
        regime = 'EXTREMELY LOW VOLATILITY'; maxConfidence = 50; canTrade = false;
        reason = 'Extremely low volatility - AVOID TRADING';
    } else if (volatilityPercent < 0.18 || atrMultiplier < 0.0006) {
        regime = 'Low Volatility'; maxConfidence = 65; canTrade = true;
        reason = 'Reduced confidence - trade with caution';
    } else if (volatilityPercent > 0.50) {
        regime = 'EXTREME VOLATILITY'; maxConfidence = 75; canTrade = true;
        reason = 'Extreme volatility - high risk';
    } else if (volatilityPercent > 0.35) {
        regime = 'High Volatility'; maxConfidence = 92; canTrade = true;
        reason = 'Excellent volatility for trading';
    }
    
    if (adx > 50) regime += ' | EXTREME TREND';
    else if (adx > 35) regime += ' | VERY STRONG TREND';
    else if (adx > 25) regime += ' | STRONG TREND';
    else if (adx > 20) regime += ' | DEVELOPING TREND';
    else regime += ' | RANGING MARKET';
    
    return { regime, maxConfidence, canTrade, reason, volatilityPercent, adx, atrMultiplier };
}

// ============================================
// LEGENDARY STRATEGIES
// ============================================
function getIchimokuSignal(highs, lows, closes) {
    if (!highs || !lows || !closes || highs.length < 52) return null;
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
}

function getMACDSignal(closes) {
    if (!closes || closes.length < 26) return null;
    const ema12 = calculateEMA(closes, 12);
    const ema26 = calculateEMA(closes, 26);
    const macd = ema12 - ema26;
    const signal = calculateEMA([macd], 9);
    const histogram = macd - signal;
    if (histogram > 0 && macd > signal) return 'CALL';
    if (histogram < 0 && macd < signal) return 'PUT';
    return null;
}

function getStructureSignal(closes) {
    if (!closes || closes.length < 50) return null;
    const recent = closes.slice(-50);
    const higherHighs = recent[recent.length - 1] > Math.max(...recent.slice(-10, -1));
    const higherLows = Math.min(...recent.slice(-5)) > Math.min(...recent.slice(-10, -5));
    if (higherHighs && higherLows) return 'CALL';
    if (!higherHighs && !higherLows) return 'PUT';
    return null;
}

function getFibonacciSignal(closes) {
    if (!closes || closes.length < 100) return null;
    const high = Math.max(...closes.slice(-100)), low = Math.min(...closes.slice(-100));
    const range = high - low;
    const price = closes[closes.length - 1];
    const level618 = low + range * 0.618;
    const level382 = low + range * 0.382;
    if (price <= level618 && price >= level382) return 'CALL';
    if (price >= level618 && price <= high - range * 0.382) return 'PUT';
    return null;
}

function getHigherTimeframeTrend(higherPriceData) {
    if (!higherPriceData || !higherPriceData.values || higherPriceData.values.length < 50) {
        return { trend: 'Neutral', direction: 0, confidence: 50 };
    }
    const closes = higherPriceData.values.map(c => c.close);
    const ema20 = calculateEMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);
    const price = closes[closes.length - 1];
    const rsi = calculateRSI(closes, 14);
    if (price > ema20 && price > ema50 && rsi > 50) return { trend: 'Strong Bullish', direction: 1, confidence: 85 };
    if (price > ema20 && price > ema50) return { trend: 'Bullish', direction: 1, confidence: 75 };
    if (price > ema20) return { trend: 'Slightly Bullish', direction: 0.5, confidence: 60 };
    if (price < ema20 && price < ema50 && rsi < 50) return { trend: 'Strong Bearish', direction: -1, confidence: 85 };
    if (price < ema20 && price < ema50) return { trend: 'Bearish', direction: -1, confidence: 75 };
    if (price < ema20) return { trend: 'Slightly Bearish', direction: -0.5, confidence: 60 };
    return { trend: 'Neutral', direction: 0, confidence: 50 };
}

function getSessionStrength(pair) {
    let hour = new Date().getHours();
    const day = new Date().getDay();
    const isDST = () => {
        const now = new Date();
        const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
        const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
        return Math.min(jan, jul) !== now.getTimezoneOffset();
    };
    if (isDST() && hour > 0) hour -= 1;
    if (day === 0 || day === 6) return { strength: 'Weekend', bonus: -30 };
    
    let strength = 'Normal', bonus = 0;
    if (pair.includes('EUR') || pair.includes('GBP')) {
        if (hour >= 13 && hour <= 22) { strength = 'HIGH (London)'; bonus = 20; }
        else if (hour >= 18 || hour <= 2) { strength = 'MEDIUM (NY)'; bonus = 12; }
        else { strength = 'LOW (Asian)'; bonus = 0; }
    } else if (pair.includes('USD') || pair.includes('CAD')) {
        if (hour >= 18 || hour <= 2) { strength = 'HIGH (NY)'; bonus = 20; }
        else if (hour >= 13 && hour <= 22) { strength = 'MEDIUM (London)'; bonus = 12; }
        else { strength = 'LOW (Asian)'; bonus = 0; }
    } else {
        if (hour >= 1 && hour <= 7) { strength = 'HIGH (Asian)'; bonus = 20; }
        else { strength = 'LOW'; bonus = 0; }
    }
    return { strength, bonus };
}

function getSignalIntensity(conf) {
    if (conf >= 90) return '🔴🔴🔴🔴 EXTREME';
    if (conf >= 80) return '🔴🔴🔴 STRONG';
    if (conf >= 70) return '🟠🟠 MODERATE';
    if (conf >= 60) return '🟡 WEAK';
    return '⚪ LOW';
}

// ============================================
// MAIN SIGNAL GENERATION (100% ALWAYS)
// ============================================
async function analyzeSignal(priceData, config, tf, higherPriceData = null) {
    try {
        const candles = priceData.values;
        if (!candles || candles.length < 100) {
            return { signal: 'CALL', confidence: 50, intensity: '⚪ LOW', rsi: '50', adx: '20',
                trend: '⚠️ Need 100+ candles', strategyUsed: 'Insufficient Data',
                recommendation: '⚠️ Need more data', shouldTrade: '⚠️ Skip' };
        }
        
        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const price = closes[closes.length - 1];
        const rsi = calculateRSI(closes, 14);
        const { adx } = calculateADX(highs, lows, closes, 14);
        const change = ((price - closes[0]) / closes[0]) * 100;
        const vwap = calculateVWAP(candles);
        const atr = calculateATR(highs, lows, closes, 14);
        const avgPrice = closes.slice(-20).reduce((a,b)=>a+b,0)/20;
        
        // 1. MARKET REGIME
        const regime = detectMarketRegime(highs, lows, closes);
        
        // 2. SUPPORT/RESISTANCE
        const sr = calculateSupportResistance(closes, highs, lows);
        
        // 3. DIVERGENCE (RSI + MACD)
        const rsiVals = [];
        for (let i = 0; i < closes.length; i++) {
            const slice = closes.slice(0, i + 1);
            rsiVals.push(slice.length < 14 ? 50 : calculateRSI(slice, 14));
        }
        const macdVals = [];
        for (let i = 0; i < closes.length; i++) {
            const slice = closes.slice(0, i + 1);
            if (slice.length < 26) macdVals.push(0);
            else {
                const ema12 = calculateEMA(slice, 12);
                const ema26 = calculateEMA(slice, 26);
                macdVals.push(ema12 - ema26);
            }
        }
        
        const rsiDivergence = detectDivergence(closes, rsiVals, 100, 8);
        const macdDivergence = detectDivergence(closes, macdVals, 100, 8);
        
        // 4. LEGENDARY STRATEGIES
        const ichimoku = getIchimokuSignal(highs, lows, closes);
        const macd = getMACDSignal(closes);
        const structure = getStructureSignal(closes);
        const fibonacci = getFibonacciSignal(closes);
        const htf = getHigherTimeframeTrend(higherPriceData);
        const session = getSessionStrength(config.pairName || '');
        
        // 5. VOTING SYSTEM (WEIGHTED)
        let bullish = 0, bearish = 0, strategies = 0;
        
        // Higher Timeframe (25 weight)
        if (htf.direction > 0.5) { bullish += 25; strategies++; }
        else if (htf.direction < -0.5) { bearish += 25; strategies++; }
        
        // Ichimoku (25 weight)
        if (ichimoku === 'CALL') { bullish += 25; strategies++; }
        else if (ichimoku === 'PUT') { bearish += 25; strategies++; }
        
        // MACD (20 weight)
        if (macd === 'CALL') { bullish += 20; strategies++; }
        else if (macd === 'PUT') { bearish += 20; strategies++; }
        
        // Market Structure (15 weight)
        if (structure === 'CALL') { bullish += 15; strategies++; }
        else if (structure === 'PUT') { bearish += 15; strategies++; }
        
        // Fibonacci (10 weight)
        if (fibonacci === 'CALL') { bullish += 10; strategies++; }
        else if (fibonacci === 'PUT') { bearish += 10; strategies++; }
        
        // Support/Resistance (10 weight)
        if (sr.nearSupport) { bullish += 10; strategies++; }
        if (sr.nearResistance) { bearish += 10; strategies++; }
        
        // Divergence bonuses (15 each)
        if (rsiDivergence.type === 'Bullish') bullish += 15;
        else if (rsiDivergence.type === 'Bearish') bearish += 15;
        if (macdDivergence.type === 'Bullish') bullish += 15;
        else if (macdDivergence.type === 'Bearish') bearish += 15;
        
        // VWAP alignment (10)
        if (price > vwap) bullish += 10;
        else bearish += 10;
        
        // 6. SIGNAL DETERMINATION (100% ALWAYS)
        let signal = null, baseConf = 50, strategyUsed = '', trendDesc = '';
        
        if (!regime.canTrade) {
            signal = price > vwap ? 'CALL' : 'PUT';
            baseConf = 48;
            strategyUsed = 'Regime: NO TRADE';
            trendDesc = `⚠️ ${regime.regime} - AVOID ⚠️`;
        }
        else if (bullish > bearish + 40 && strategies >= 2) {
            signal = 'CALL';
            baseConf = Math.min(regime.maxConfidence, 85);
            strategyUsed = 'STRONG BULLISH CONSENSUS';
            trendDesc = `📈📈 STRONG BULLISH - ${strategies} strategies`;
        }
        else if (bearish > bullish + 40 && strategies >= 2) {
            signal = 'PUT';
            baseConf = Math.min(regime.maxConfidence, 85);
            strategyUsed = 'STRONG BEARISH CONSENSUS';
            trendDesc = `📉📉 STRONG BEARISH - ${strategies} strategies`;
        }
        else if (bullish > bearish + 15) {
            signal = 'CALL';
            baseConf = Math.min(regime.maxConfidence, 70);
            strategyUsed = 'Bullish Bias';
            trendDesc = `📈 BULLISH - ${strategies} strategies`;
        }
        else if (bearish > bullish + 15) {
            signal = 'PUT';
            baseConf = Math.min(regime.maxConfidence, 70);
            strategyUsed = 'Bearish Bias';
            trendDesc = `📉 BEARISH - ${strategies} strategies`;
        }
        else if (bullish > bearish) {
            signal = 'CALL';
            baseConf = Math.min(regime.maxConfidence, 60);
            strategyUsed = 'Slight Bullish';
            trendDesc = `📈 SLIGHTLY BULLISH`;
        }
        else if (bearish > bullish) {
            signal = 'PUT';
            baseConf = Math.min(regime.maxConfidence, 60);
            strategyUsed = 'Slight Bearish';
            trendDesc = `📉 SLIGHTLY BEARISH`;
        }
        else {
            signal = price > vwap ? 'CALL' : 'PUT';
            baseConf = regime.maxConfidence - 20;
            strategyUsed = 'VWAP Tiebreaker';
            trendDesc = `⚖️ VWAP Bias: ${price > vwap ? 'CALL' : 'PUT'}`;
        }
        
        // 7. CONFLICT PENALTIES
        let conflictPenalty = 0;
        
        if ((signal === 'CALL' && (rsiDivergence.type === 'Bearish' || macdDivergence.type === 'Bearish')) ||
            (signal === 'PUT' && (rsiDivergence.type === 'Bullish' || macdDivergence.type === 'Bullish'))) {
            conflictPenalty += 20;
            trendDesc += ` ⚠️ DIVERGENCE CONTRADICTS`;
        }
        if (regime.atrMultiplier < 0.0005) {
            conflictPenalty += 15;
            trendDesc += ` ⚠️ LOW ATR`;
        }
        if (strategies < 2) {
            conflictPenalty += 10;
            trendDesc += ` ⚠️ FEW STRATEGIES`;
        }
        
        // 8. FINAL CONFIDENCE
        let finalConf = baseConf + session.bonus - conflictPenalty;
        
        // Divergence bonus
        if ((signal === 'CALL' && (rsiDivergence.type === 'Bullish' || macdDivergence.type === 'Bullish')) ||
            (signal === 'PUT' && (rsiDivergence.type === 'Bearish' || macdDivergence.type === 'Bearish'))) {
            finalConf += 10;
            trendDesc += ` ✅ DIVERGENCE CONFIRMS`;
        }
        
        // Historical learning
        const patternId = `${signal}_${strategyUsed.replace(/ /g, '_')}`;
        const historical = getHistoricalWinRate(config.pairName || 'UNKNOWN', tf, patternId);
        if (historical !== null) {
            finalConf = Math.floor((finalConf * 0.6) + (historical * 0.4));
        }
        
        finalConf = Math.min(regime.maxConfidence, Math.max(45, finalConf));
        if (!regime.canTrade) finalConf = Math.min(finalConf, 52);
        
        const intensity = getSignalIntensity(finalConf);
        
        // 9. RECOMMENDATION
        let rec = '';
        if (!regime.canTrade) {
            rec = `⚠️⚠️ ${regime.reason.toUpperCase()} - SKIP ⚠️⚠️`;
        } else if (finalConf >= 85 && strategies >= 3 && conflictPenalty === 0) {
            rec = '✅✅✅ EXTREME HIGH PROBABILITY - EXCELLENT ✅✅✅';
        } else if (finalConf >= 75 && strategies >= 2) {
            rec = '✅✅ STRONG SIGNAL - Good probability ✅✅';
        } else if (finalConf >= 65) {
            rec = '✅ Good signal - Consider taking';
        } else if (finalConf >= 55) {
            rec = '⚠️ Weak signal - Trade only if you agree';
        } else {
            rec = '⚠️ LOW CONFIDENCE - Better to skip';
        }
        
        return {
            signal: signal,
            confidence: Math.round(finalConf),
            intensity: intensity,
            rsi: rsi.toFixed(1),
            adx: adx.toFixed(1),
            priceChange: change.toFixed(2),
            trend: trendDesc,
            strategyUsed: strategyUsed,
            marketRegime: regime.regime,
            rsiDivergence: rsiDivergence.type,
            macdDivergence: macdDivergence.type,
            strategyCount: strategies,
            bullishVotes: bullish,
            bearishVotes: bearish,
            volatilityPercent: ((atr/avgPrice)*100).toFixed(2),
            nearSupport: sr.nearSupport,
            nearResistance: sr.nearResistance,
            sessionStrength: session.strength,
            trendAlignment: `📊 ${regime.regime} | Div: ${rsiDivergence.type} | ${intensity} (${Math.round(finalConf)}%)`,
            patternId: patternId,
            historicalWinRate: historical ? historical.toFixed(1) + '%' : 'Learning...',
            recommendation: rec,
            shouldTrade: finalConf >= 70 && regime.canTrade && conflictPenalty < 10 ? '✅ Consider' : '⚠️ Skip'
        };
    } catch(e) {
        console.error('Analyzer error:', e);
        return { 
            signal: 'CALL', confidence: 50, intensity: '⚪ LOW', rsi: '50', adx: '20',
            trend: 'Analysis error - using fallback', strategyUsed: 'Fallback',
            recommendation: '⚠️ Error - skip', shouldTrade: '⚠️ Skip'
        };
    }
}

module.exports = { analyzeSignal, recordTradeOutcome };
