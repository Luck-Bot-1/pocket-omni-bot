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

function calculateSMA(values, period) {
    if (!values || values.length < period) return values[values.length - 1] || 0;
    const slice = values.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
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

function calculateStochastic(highs, lows, closes, period = 14) {
    if (!highs || !lows || !closes || highs.length < period) return 50;
    const recentHigh = Math.max(...highs.slice(-period));
    const recentLow = Math.min(...lows.slice(-period));
    const k = ((closes[closes.length - 1] - recentLow) / (recentHigh - recentLow)) * 100;
    return isNaN(k) ? 50 : k;
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
// METHOD 1: ICHIMOKU CLOUD (FIXED)
// ============================================
function calculateIchimoku(highs, lows, closes) {
    if (!highs || !lows || !closes || highs.length < 52) {
        return { signal: null, confidence: 0, description: 'Insufficient data for Ichimoku' };
    }
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
    
    const currentPrice = closes[closes.length - 1];
    
    if (currentPrice > senkouA && currentPrice > senkouB && tenkan > kijun) {
        return { signal: 'CALL', confidence: 82, description: 'Ichimoku Bullish' };
    }
    if (currentPrice < senkouA && currentPrice < senkouB && tenkan < kijun) {
        return { signal: 'PUT', confidence: 82, description: 'Ichimoku Bearish' };
    }
    return { signal: null, confidence: 0, description: 'Ichimoku Neutral' };
}

// ============================================
// METHOD 2: MACD WITH DIVERGENCE (IMPROVED LOOKBACK)
// ============================================
function calculateMACD(closes) {
    if (!closes || closes.length < 26) return { signal: null, confidence: 0, divergence: 'None' };
    
    const ema12 = calculateEMA(closes, 12);
    const ema26 = calculateEMA(closes, 26);
    const macdLine = ema12 - ema26;
    const signalLine = calculateEMA([macdLine], 9);
    const histogram = macdLine - signalLine;
    
    const macdValues = [];
    for (let i = 0; i < closes.length; i++) {
        const slice = closes.slice(0, i + 1);
        if (slice.length < 26) macdValues.push(0);
        else {
            const e12 = calculateEMA(slice, 12);
            const e26 = calculateEMA(slice, 26);
            macdValues.push(e12 - e26);
        }
    }
    
    let divergence = 'None';
    const lastPrice = closes[closes.length - 1];
    const lastMacd = macdValues[macdValues.length - 1];
    
    // Increased lookback to 50 for better divergence detection
    for (let i = 50; i > 0; i--) {
        const idx = closes.length - 1 - i;
        if (idx < 0) continue;
        if (closes[idx] < lastPrice && macdValues[idx] > lastMacd) divergence = 'Bullish';
        if (closes[idx] > lastPrice && macdValues[idx] < lastMacd) divergence = 'Bearish';
    }
    
    let signal = null;
    let confidence = 0;
    
    if (histogram > 0 && macdLine > signalLine) {
        signal = 'CALL';
        confidence = 75;
    } else if (histogram < 0 && macdLine < signalLine) {
        signal = 'PUT';
        confidence = 75;
    }
    
    if (divergence === 'Bullish' && signal === 'PUT') signal = null;
    if (divergence === 'Bearish' && signal === 'CALL') signal = null;
    
    return { signal, confidence, divergence };
}

// ============================================
// METHOD 3: MARKET STRUCTURE (IMPROVED LOOKBACK)
// ============================================
function detectMarketStructure(closes) {
    if (!closes || closes.length < 50) return { signal: null, confidence: 0, structure: 'Neutral', bos: false, choch: false };
    
    const last50 = closes.slice(-50);
    let swingHighs = [];
    let swingLows = [];
    
    for (let i = 5; i < last50.length - 5; i++) {
        let isSwingHigh = true;
        let isSwingLow = true;
        for (let j = -5; j <= 5; j++) {
            if (j === 0) continue;
            if (last50[i] <= last50[i + j]) isSwingHigh = false;
            if (last50[i] >= last50[i + j]) isSwingLow = false;
        }
        if (isSwingHigh) swingHighs.push(last50[i]);
        if (isSwingLow) swingLows.push(last50[i]);
    }
    
    let structure = 'Neutral';
    let bos = false;
    let choch = false;
    
    if (swingHighs.length >= 2 && swingLows.length >= 2) {
        const higherHighs = swingHighs[swingHighs.length - 1] > swingHighs[swingHighs.length - 2];
        const higherLows = swingLows[swingLows.length - 1] > swingLows[swingLows.length - 2];
        
        if (higherHighs && higherLows) {
            structure = 'Bullish';
            bos = true;
        } else if (!higherHighs && !higherLows) {
            structure = 'Bearish';
            bos = true;
        }
    }
    
    if (structure === 'Bullish' && closes[closes.length - 1] < (swingLows[swingLows.length - 1] || 0)) {
        choch = true;
        structure = 'Potential Reversal to Bearish';
    } else if (structure === 'Bearish' && closes[closes.length - 1] > (swingHighs[swingHighs.length - 1] || Infinity)) {
        choch = true;
        structure = 'Potential Reversal to Bullish';
    }
    
    let signal = null;
    let confidence = 0;
    if (structure === 'Bullish') { signal = 'CALL'; confidence = 78; }
    else if (structure === 'Bearish') { signal = 'PUT'; confidence = 78; }
    else if (structure === 'Potential Reversal to Bullish') { signal = 'CALL'; confidence = 72; }
    else if (structure === 'Potential Reversal to Bearish') { signal = 'PUT'; confidence = 72; }
    
    return { signal, confidence, structure, bos, choch };
}

// ============================================
// METHOD 4: FIBONACCI RETRACEMENT (IMPROVED)
// ============================================
function calculateFibonacci(closes) {
    if (!closes || closes.length < 100) return { signal: null, confidence: 0 };
    
    const swingHigh = Math.max(...closes.slice(-100));
    const swingLow = Math.min(...closes.slice(-100));
    const range = swingHigh - swingLow;
    const currentPrice = closes[closes.length - 1];
    
    const levels = {
        level382: swingLow + range * 0.382,
        level500: swingLow + range * 0.5,
        level618: swingLow + range * 0.618,
        level786: swingLow + range * 0.786
    };
    
    const isUptrend = swingHigh > swingLow && currentPrice > swingLow;
    const isDowntrend = swingLow < swingHigh && currentPrice < swingHigh;
    
    let signal = null;
    let confidence = 0;
    
    if (isUptrend && currentPrice <= levels.level618) {
        signal = 'CALL';
        confidence = 78;
    } else if (isDowntrend && currentPrice >= levels.level618) {
        signal = 'PUT';
        confidence = 78;
    }
    
    return { signal, confidence };
}

// ============================================
// METHOD 5: SESSION ANALYSIS (DYNAMIC)
// ============================================
function getSessionStrength(pair) {
    const now = new Date();
    let hour = now.getHours();
    const day = now.getDay();
    
    // Adjust for DST if needed (simplified)
    const isDST = () => {
        const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
        const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
        return Math.min(jan, jul) !== now.getTimezoneOffset();
    };
    
    if (isDST() && hour > 0) hour -= 1;
    
    let strength = 'Normal';
    let bonus = 0;
    
    if (pair.includes('EUR') || pair.includes('GBP')) {
        if (hour >= 13 && hour <= 22) { strength = 'High (London)'; bonus = 15; }
        else if (hour >= 18 && hour <= 2 || (hour >= 0 && hour <= 2)) { strength = 'Medium (NY)'; bonus = 10; }
        else { strength = 'Low (Asian)'; bonus = 0; }
    } else if (pair.includes('USD') || pair.includes('CAD')) {
        if (hour >= 18 && hour <= 2 || (hour >= 0 && hour <= 2)) { strength = 'High (NY)'; bonus = 15; }
        else if (hour >= 13 && hour <= 22) { strength = 'Medium (London)'; bonus = 10; }
        else { strength = 'Low (Asian)'; bonus = 0; }
    } else if (pair.includes('JPY') || pair.includes('AUD') || pair.includes('NZD')) {
        if (hour >= 1 && hour <= 7) { strength = 'High (Asian)'; bonus = 15; }
        else { strength = 'Low'; bonus = 0; }
    }
    
    // Weekend penalty
    if (day === 0 || day === 6) {
        strength = 'Weekend (Avoid)';
        bonus = -30;
    }
    
    return { strength, bonus };
}

// ============================================
// HIGHER TIMEFRAME TREND
// ============================================
function getHigherTimeframeTrend(higherPriceData) {
    if (!higherPriceData || !higherPriceData.values || higherPriceData.values.length < 50) {
        return { trend: 'Neutral', direction: 0, confidence: 50 };
    }
    
    const closes = higherPriceData.values.map(c => c.close);
    const highs = higherPriceData.values.map(c => c.high);
    const lows = higherPriceData.values.map(c => c.low);
    const ema20 = calculateEMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);
    const currentPrice = closes[closes.length - 1];
    const { adx, plusDI, minusDI } = calculateADX(highs, lows, closes, 14);
    
    if (currentPrice > ema20 && currentPrice > ema50 && ema20 > ema50 && adx > 25 && plusDI > minusDI) {
        return { trend: 'Bullish', direction: 1, confidence: 85 };
    }
    if (currentPrice > ema20 && currentPrice > ema50) {
        return { trend: 'Bullish', direction: 1, confidence: 75 };
    }
    if (currentPrice > ema20) {
        return { trend: 'Slightly Bullish', direction: 0.5, confidence: 60 };
    }
    if (currentPrice < ema20 && currentPrice < ema50 && ema20 < ema50 && adx > 25 && minusDI > plusDI) {
        return { trend: 'Bearish', direction: -1, confidence: 85 };
    }
    if (currentPrice < ema20 && currentPrice < ema50) {
        return { trend: 'Bearish', direction: -1, confidence: 75 };
    }
    if (currentPrice < ema20) {
        return { trend: 'Slightly Bearish', direction: -0.5, confidence: 60 };
    }
    
    return { trend: 'Neutral', direction: 0, confidence: 50 };
}

// ============================================
// SIGNAL INTENSITY
// ============================================
function getSignalIntensity(confidence) {
    if (confidence >= 80) return '🔴🔴🔴 STRONG';
    if (confidence >= 70) return '🟠🟠 MODERATE';
    if (confidence >= 60) return '🟡 WEAK';
    return '⚪ LOW';
}

// ============================================
// MAIN SIGNAL GENERATION
// ============================================
async function analyzeSignal(priceData, config, tf, higherPriceData = null) {
    try {
        const candles = priceData.values;
        if (!candles || candles.length < 100) {
            return {
                signal: 'CALL', confidence: 50, intensity: '⚪ LOW',
                rsi: '50', adx: '20', trend: '⚠️ Need 100+ candles',
                strategyUsed: 'Insufficient Data',
                recommendation: '⚠️ Need more data'
            };
        }
        
        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const currentPrice = closes[closes.length - 1];
        const rsi = calculateRSI(closes, 14);
        const stochK = calculateStochastic(highs, lows, closes, 14);
        const { adx } = calculateADX(highs, lows, closes, 14);
        const priceChange = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
        const vwap = calculateVWAP(candles);
        const vwapPosition = currentPrice > vwap ? 'Above VWAP' : 'Below VWAP';
        const atr = calculateATR(highs, lows, closes, 14);
        const avgPrice = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const volatilityPercent = (atr / avgPrice) * 100;
        
        const higherTimeframe = getHigherTimeframeTrend(higherPriceData);
        const htfDirection = higherTimeframe.direction;
        
        // COLLECT ALL 5 METHOD SIGNALS
        const ichimoku = calculateIchimoku(highs, lows, closes);
        const macd = calculateMACD(closes);
        const structure = detectMarketStructure(closes);
        const fibonacci = calculateFibonacci(closes);
        const session = getSessionStrength(config.pairName || 'UNKNOWN');
        
        // RSI BOUNCE DETECTION (CRITICAL FOR OVERSOLD BOUNCES)
        let rsiBounceSignal = null;
        if (adx >= 35 && rsi < 38) {
            rsiBounceSignal = { signal: 'CALL', confidence: 82 };
        } else if (adx >= 35 && rsi > 62) {
            rsiBounceSignal = { signal: 'PUT', confidence: 82 };
        }
        
        // VOTING SYSTEM
        let bullishVotes = 0;
        let bearishVotes = 0;
        let activeStrategies = 0;
        let votingDetails = [];
        
        // Ichimoku (25 weight)
        if (ichimoku.signal === 'CALL') { bullishVotes += 25; activeStrategies++; votingDetails.push('Ichimoku: Bullish'); }
        else if (ichimoku.signal === 'PUT') { bearishVotes += 25; activeStrategies++; votingDetails.push('Ichimoku: Bearish'); }
        
        // MACD (20 weight)
        if (macd.signal === 'CALL') { bullishVotes += 20; activeStrategies++; votingDetails.push('MACD: Bullish'); }
        else if (macd.signal === 'PUT') { bearishVotes += 20; activeStrategies++; votingDetails.push('MACD: Bearish'); }
        if (macd.divergence === 'Bullish') { bullishVotes += 10; votingDetails.push('MACD Divergence: Bullish'); }
        else if (macd.divergence === 'Bearish') { bearishVotes += 10; votingDetails.push('MACD Divergence: Bearish'); }
        
        // Market Structure (20 weight)
        if (structure.signal === 'CALL') { bullishVotes += 20; activeStrategies++; votingDetails.push(`Structure: ${structure.structure}`); }
        else if (structure.signal === 'PUT') { bearishVotes += 20; activeStrategies++; votingDetails.push(`Structure: ${structure.structure}`); }
        
        // Fibonacci (15 weight)
        if (fibonacci.signal === 'CALL') { bullishVotes += 15; activeStrategies++; votingDetails.push('Fibonacci: Bullish'); }
        else if (fibonacci.signal === 'PUT') { bearishVotes += 15; activeStrategies++; votingDetails.push('Fibonacci: Bearish'); }
        
        // Higher Timeframe (20 weight)
        if (htfDirection > 0) { bullishVotes += 20; votingDetails.push(`HTF: ${higherTimeframe.trend}`); }
        else if (htfDirection < 0) { bearishVotes += 20; votingDetails.push(`HTF: ${higherTimeframe.trend}`); }
        
        // RSI Bounce (overrides)
        if (rsiBounceSignal) {
            if (rsiBounceSignal.signal === 'CALL') bullishVotes += 30;
            else bearishVotes += 30;
            votingDetails.push(`RSI Bounce: ${rsiBounceSignal.signal === 'CALL' ? 'Bullish' : 'Bearish'}`);
        }
        
        // Session Bonus
        votingDetails.push(`Session: ${session.strength} (+${session.bonus}%)`);
        
        // DETERMINE FINAL SIGNAL
        let signal = null;
        let baseConfidence = 50;
        let strategyUsed = '';
        let trendDescription = '';
        
        // Minimum 2 strategies must agree for high confidence
        const minStrategiesRequired = 2;
        
        if (bullishVotes > bearishVotes + 20 && activeStrategies >= minStrategiesRequired) {
            signal = 'CALL';
            baseConfidence = Math.min(92, 60 + bullishVotes);
            strategyUsed = 'Multi-Method Consensus (Strong Bullish)';
            trendDescription = `📈 BULLISH - Votes: ${bullishVotes}/${bearishVotes} (${activeStrategies} strategies)`;
        } else if (bearishVotes > bullishVotes + 20 && activeStrategies >= minStrategiesRequired) {
            signal = 'PUT';
            baseConfidence = Math.min(92, 60 + bearishVotes);
            strategyUsed = 'Multi-Method Consensus (Strong Bearish)';
            trendDescription = `📉 BEARISH - Votes: ${bearishVotes}/${bullishVotes} (${activeStrategies} strategies)`;
        } else if (bullishVotes > bearishVotes) {
            signal = 'CALL';
            baseConfidence = 62;
            strategyUsed = 'Slight Bullish Bias';
            trendDescription = `📈 SLIGHTLY BULLISH - Votes: ${bullishVotes}/${bearishVotes}`;
        } else if (bearishVotes > bullishVotes) {
            signal = 'PUT';
            baseConfidence = 62;
            strategyUsed = 'Slight Bearish Bias';
            trendDescription = `📉 SLIGHTLY BEARISH - Votes: ${bearishVotes}/${bullishVotes}`;
        } else {
            signal = currentPrice > vwap ? 'CALL' : 'PUT';
            baseConfidence = 55;
            strategyUsed = 'VWAP Tiebreaker';
            trendDescription = `Neutral - Following VWAP (${vwapPosition})`;
        }
        
        // Apply session bonus
        let finalConfidence = baseConfidence + session.bonus;
        
        // Volatility filter (avoid chop)
        if (volatilityPercent < 0.12) {
            finalConfidence -= 10;
            trendDescription += ' ⚠️ LOW VOLATILITY - CHOP MARKET';
        }
        
        // ATR multiplier filter
        const atrMultiplier = atr / avgPrice;
        if (atrMultiplier < 0.0005) {
            finalConfidence -= 8;
            trendDescription += ' ⚠️ VERY LOW ATR - AVOID';
        }
        
        // VWAP confirmation bonus
        if ((signal === 'CALL' && currentPrice > vwap) || (signal === 'PUT' && currentPrice < vwap)) {
            finalConfidence += 5;
            trendDescription += ' ✅ VWAP Confirmed';
        }
        
        // Historical learning
        const patternId = `${signal}_${strategyUsed.replace(/ /g, '_')}`;
        const historicalWinRate = getHistoricalWinRate(config.pairName || 'UNKNOWN', tf, patternId);
        
        if (historicalWinRate !== null) {
            finalConfidence = Math.floor((finalConfidence * 0.6) + (historicalWinRate * 0.4));
        }
        
        finalConfidence = Math.min(99, Math.max(45, finalConfidence));
        const intensity = getSignalIntensity(finalConfidence);
        
        let recommendation = '';
        if (finalConfidence >= 80) recommendation = '✅ STRONG SIGNAL - High probability trade';
        else if (finalConfidence >= 70) recommendation = '✅ Good signal - Consider taking the trade';
        else if (finalConfidence >= 60) recommendation = '⚠️ Weak signal - Trade only if you agree';
        else recommendation = '⚠️ LOW CONFIDENCE - Better to skip';
        
        recommendation += ` | Votes: ${bullishVotes}/${bearishVotes} | Session: ${session.strength} | ATR: ${(atrMultiplier * 10000).toFixed(2)}pips`;
        
        return {
            signal: signal,
            confidence: finalConfidence,
            intensity: intensity,
            rsi: rsi.toFixed(1),
            stochK: stochK.toFixed(1),
            adx: adx.toFixed(1),
            priceChange: priceChange.toFixed(2),
            trend: trendDescription,
            strategyUsed: strategyUsed,
            higherTrend: higherTimeframe.trend,
            vwapPosition: vwapPosition,
            volatilityPercent: volatilityPercent.toFixed(2),
            ichimokuSignal: ichimoku.signal || 'Neutral',
            macdSignal: macd.signal || 'Neutral',
            macdDivergence: macd.divergence || 'None',
            structureSignal: structure.structure,
            fibonacciSignal: fibonacci.signal || 'Neutral',
            sessionStrength: session.strength,
            activeStrategies: activeStrategies,
            votingDetails: votingDetails.join(' | '),
            trendAlignment: `📊 ${votingDetails.join(' | ')} → FINAL: ${intensity} (${finalConfidence}%) | RSI: ${rsi.toFixed(1)} | ADX: ${adx.toFixed(1)}`,
            patternId: patternId,
            historicalWinRate: historicalWinRate ? historicalWinRate.toFixed(1) + '%' : 'Learning...',
            recommendation: recommendation,
            shouldTrade: finalConfidence >= 70 ? '✅ Consider trading' : '⚠️ Consider skipping'
        };
        
    } catch (error) {
        console.error('Analyzer error:', error);
        return {
            signal: 'CALL', confidence: 50, intensity: '⚪ LOW',
            rsi: '50', adx: '20', trend: 'Analysis error - using fallback',
            strategyUsed: 'Fallback', recommendation: '⚠️ Error - skip this trade',
            shouldTrade: '⚠️ Error - skip'
        };
    }
}

module.exports = { analyzeSignal, recordTradeOutcome };
