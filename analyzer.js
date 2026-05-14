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
// TECHNICAL INDICATORS (WITH NULL CHECKS)
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
// STEP 1: MARKET REGIME DETECTION
// ============================================
function detectMarketRegime(highs, lows, closes) {
    const { adx } = calculateADX(highs, lows, closes, 14);
    const atr = calculateATR(highs, lows, closes, 14);
    const avgPrice = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const volatilityPercent = (atr / avgPrice) * 100;
    
    let regime = 'Normal';
    let maxConfidence = 80;
    let canTrade = true;
    let reason = '';
    
    if (volatilityPercent < 0.10) {
        regime = 'EXTREMELY LOW VOLATILITY';
        maxConfidence = 45;
        canTrade = false;
        reason = 'Market is dead - NO TRADE';
    } else if (volatilityPercent < 0.15) {
        regime = 'Low Volatility';
        maxConfidence = 60;
        canTrade = true;
        reason = 'Reduced confidence due to low volatility';
    } else if (volatilityPercent > 0.40) {
        regime = 'High Volatility';
        maxConfidence = 88;
        canTrade = true;
        reason = 'Good volatility for trading';
    }
    
    if (adx > 45) regime += ' | VERY STRONG TREND';
    else if (adx > 25) regime += ' | STRONG TREND';
    else if (adx > 20) regime += ' | DEVELOPING TREND';
    else regime += ' | RANGING';
    
    return { regime, maxConfidence, canTrade, reason, volatilityPercent, adx };
}

// ============================================
// STEP 2: TRUE DIVERGENCE DETECTION (FIXED)
// ============================================
function detectTrueDivergence(price, indicator, lookback = 50, minBars = 8) {
    if (!price || !indicator || price.length < lookback) {
        return { type: 'None', confidence: 0, description: 'Insufficient data' };
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
    
    if (bearishDiv) return { type: 'Bearish', confidence: 78, description: 'Bearish divergence detected' };
    if (bullishDiv) return { type: 'Bullish', confidence: 78, description: 'Bullish divergence detected' };
    return { type: 'None', confidence: 0, description: 'No divergence' };
}

// ============================================
// STEP 3: STRATEGY SIGNALS
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
    return macd > signal ? 'CALL' : (macd < signal ? 'PUT' : null);
}

function getStructureSignal(closes) {
    if (!closes || closes.length < 50) return null;
    const recent = closes.slice(-20);
    const higherHighs = recent[recent.length - 1] > recent[recent.length - 5];
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
    if (price <= level618 && price > low) return 'CALL';
    if (price >= level618 && price < high) return 'PUT';
    return null;
}

function getHigherTimeframeTrend(higherPriceData) {
    if (!higherPriceData || !higherPriceData.values || higherPriceData.values.length < 50) {
        return { trend: 'Neutral', direction: 0 };
    }
    const closes = higherPriceData.values.map(c => c.close);
    const ema20 = calculateEMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);
    const price = closes[closes.length - 1];
    if (price > ema20 && price > ema50) return { trend: 'Bullish', direction: 1 };
    if (price < ema20 && price < ema50) return { trend: 'Bearish', direction: -1 };
    return { trend: 'Neutral', direction: 0 };
}

function getSessionStrength(pair) {
    let hour = new Date().getHours();
    const day = new Date().getDay();
    if (day === 0 || day === 6) return { strength: 'Weekend', bonus: -30 };
    
    let strength = 'Normal', bonus = 0;
    if (pair.includes('EUR') || pair.includes('GBP')) {
        if (hour >= 13 && hour <= 22) { strength = 'High (London)'; bonus = 15; }
        else if (hour >= 18 || hour <= 2) { strength = 'Medium (NY)'; bonus = 10; }
        else { strength = 'Low (Asian)'; bonus = 0; }
    } else if (pair.includes('USD') || pair.includes('CAD')) {
        if (hour >= 18 || hour <= 2) { strength = 'High (NY)'; bonus = 15; }
        else if (hour >= 13 && hour <= 22) { strength = 'Medium (London)'; bonus = 10; }
        else { strength = 'Low (Asian)'; bonus = 0; }
    } else {
        if (hour >= 1 && hour <= 7) { strength = 'High (Asian)'; bonus = 15; }
        else { strength = 'Low'; bonus = 0; }
    }
    return { strength, bonus };
}

function getSignalIntensity(conf) {
    if (conf >= 80) return '🔴🔴🔴 STRONG';
    if (conf >= 70) return '🟠🟠 MODERATE';
    if (conf >= 60) return '🟡 WEAK';
    return '⚪ LOW';
}

// ============================================
// MAIN SIGNAL GENERATION
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
        
        // 2. DIVERGENCE
        const rsiVals = [];
        for (let i = 0; i < closes.length; i++) {
            const slice = closes.slice(0, i+1);
            rsiVals.push(slice.length < 14 ? 50 : calculateRSI(slice, 14));
        }
        const divergence = detectTrueDivergence(closes, rsiVals, 50, 8);
        
        // 3. STRATEGIES
        const ichimoku = getIchimokuSignal(highs, lows, closes);
        const macd = getMACDSignal(closes);
        const structure = getStructureSignal(closes);
        const fibonacci = getFibonacciSignal(closes);
        const htf = getHigherTimeframeTrend(higherPriceData);
        const session = getSessionStrength(config.pairName || '');
        
        // 4. VOTING
        let bullish = 0, bearish = 0, strategies = 0;
        if (ichimoku === 'CALL') { bullish += 25; strategies++; }
        else if (ichimoku === 'PUT') { bearish += 25; strategies++; }
        if (macd === 'CALL') { bullish += 20; strategies++; }
        else if (macd === 'PUT') { bearish += 20; strategies++; }
        if (structure === 'CALL') { bullish += 20; strategies++; }
        else if (structure === 'PUT') { bearish += 20; strategies++; }
        if (fibonacci === 'CALL') { bullish += 15; strategies++; }
        else if (fibonacci === 'PUT') { bearish += 15; strategies++; }
        if (htf.direction > 0) bullish += 20;
        else if (htf.direction < 0) bearish += 20;
        if (divergence.type === 'Bullish') bullish += 15;
        else if (divergence.type === 'Bearish') bearish += 15;
        
        // 5. SIGNAL
        let signal = null, baseConf = 50, strategyUsed = '', trendDesc = '';
        
        if (!regime.canTrade) {
            signal = price > vwap ? 'CALL' : 'PUT';
            baseConf = 48;
            strategyUsed = 'NO TRADE REGIME';
            trendDesc = `⚠️ ${regime.regime} - ${regime.reason}`;
        }
        else if (bullish > bearish + 25 && strategies >= 2) {
            signal = 'CALL';
            baseConf = Math.min(regime.maxConfidence, 70 + (bullish/10));
            strategyUsed = 'Strong Bullish Consensus';
            trendDesc = `📈 BULLISH - ${strategies} strategies | ${regime.regime}`;
        }
        else if (bearish > bullish + 25 && strategies >= 2) {
            signal = 'PUT';
            baseConf = Math.min(regime.maxConfidence, 70 + (bearish/10));
            strategyUsed = 'Strong Bearish Consensus';
            trendDesc = `📉 BEARISH - ${strategies} strategies | ${regime.regime}`;
        }
        else if (bullish > bearish) {
            signal = 'CALL';
            baseConf = Math.min(regime.maxConfidence - 5, 60);
            strategyUsed = 'Slight Bullish Bias';
            trendDesc = `📈 SLIGHTLY BULLISH - ${regime.regime}`;
        }
        else if (bearish > bullish) {
            signal = 'PUT';
            baseConf = Math.min(regime.maxConfidence - 5, 60);
            strategyUsed = 'Slight Bearish Bias';
            trendDesc = `📉 SLIGHTLY BEARISH - ${regime.regime}`;
        }
        else {
            signal = price > vwap ? 'CALL' : 'PUT';
            baseConf = regime.maxConfidence - 15;
            strategyUsed = 'VWAP Tiebreaker';
            trendDesc = `Neutral - Following VWAP | ${regime.regime}`;
        }
        
        // 6. CONFLICT PENALTIES
        if ((signal === 'CALL' && divergence.type === 'Bearish') ||
            (signal === 'PUT' && divergence.type === 'Bullish')) {
            baseConf = Math.max(baseConf - 15, 45);
            trendDesc += ` ⚠️ DIVERGENCE CONTRADICTS`;
        }
        if (regime.volatilityPercent < 0.18) {
            baseConf = Math.min(baseConf, 65);
            trendDesc += ` ⚠️ LOW VOLATILITY CAP`;
        }
        
        // 7. HISTORICAL LEARNING
        const patternId = `${signal}_${strategyUsed.replace(/ /g, '_')}`;
        const historical = getHistoricalWinRate(config.pairName || 'UNKNOWN', tf, patternId);
        let finalConf = baseConf + session.bonus;
        if (historical !== null) finalConf = Math.floor((finalConf * 0.6) + (historical * 0.4));
        finalConf = Math.min(regime.maxConfidence, Math.max(45, finalConf));
        
        const intensity = getSignalIntensity(finalConf);
        
        let rec = '';
        if (finalConf >= 75 && regime.canTrade && strategies >= 2) rec = '✅ STRONG SIGNAL - High probability';
        else if (finalConf >= 70) rec = '✅ Good signal - Consider taking';
        else if (finalConf >= 60) rec = '⚠️ Weak signal - Trade only if you agree';
        else rec = '⚠️ LOW CONFIDENCE - Better to skip';
        if (!regime.canTrade) rec += ` ⚠️ ${regime.reason.toUpperCase()}`;
        
        return {
            signal, confidence: finalConf, intensity,
            rsi: rsi.toFixed(1), adx: adx.toFixed(1), priceChange: change.toFixed(2),
            trend: trendDesc, strategyUsed, marketRegime: regime.regime,
            divergenceType: divergence.type, divergenceDesc: divergence.description,
            strategyCount: strategies, bullishVotes: bullish, bearishVotes: bearish,
            volatilityPercent: ((atr/avgPrice)*100).toFixed(2),
            trendAlignment: `📊 ${regime.regime} | Div: ${divergence.type} | ${strategies} strategies | ${intensity} (${finalConf}%)`,
            patternId, historicalWinRate: historical ? historical.toFixed(1)+'%' : 'Learning...',
            recommendation: rec, shouldTrade: finalConf >= 70 && regime.canTrade && strategies >= 2 ? '✅ Consider' : '⚠️ Skip'
        };
    } catch(e) {
        console.error('Analyzer error:', e);
        return { signal: 'CALL', confidence: 50, intensity: '⚪ LOW', rsi: '50', adx: '20',
            trend: 'Error', strategyUsed: 'Fallback', recommendation: '⚠️ Error - skip', shouldTrade: '⚠️ Skip' };
    }
}

module.exports = { analyzeSignal, recordTradeOutcome };
