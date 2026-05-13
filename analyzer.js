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

function calculateADX(high, low, close, period = 14) {
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
    const smoothTR = tr.slice(-period).reduce((a,b)=>a+b,0)/period;
    const smoothPlus = plusDM.slice(-period).reduce((a,b)=>a+b,0)/period;
    const smoothMinus = minusDM.slice(-period).reduce((a,b)=>a+b,0)/period;
    const plusDI = (smoothPlus / smoothTR) * 100;
    const minusDI = (smoothMinus / smoothTR) * 100;
    const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
    return { adx: dx, plusDI, minusDI };
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
// HIGHER TIMEFRAME TREND DETECTION (CRITICAL FIX)
// ============================================
function getHigherTimeframeTrend(higherPriceData) {
    if (!higherPriceData || !higherPriceData.values || higherPriceData.values.length < 30) {
        return { trend: 'Neutral', confidence: 50, direction: 0 };
    }
    
    const closes = higherPriceData.values.map(c => c.close);
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const currentPrice = closes[closes.length - 1];
    const priceAbove20 = currentPrice > Math.max(...closes.slice(-20));
    const priceBelow20 = currentPrice < Math.min(...closes.slice(-20));
    const last3Closes = closes.slice(-3);
    const isHigherHigh = last3Closes[2] > last3Closes[1];
    const isLowerLow = last3Closes[2] < last3Closes[1];
    
    // Calculate trend strength
    let trend = 'Neutral';
    let confidence = 50;
    let direction = 0; // +1 for bullish, -1 for bearish
    
    if (ema9 > ema21 && priceAbove20 && isHigherHigh) {
        trend = 'Strong Bullish';
        confidence = 85;
        direction = 1;
    } else if (ema9 < ema21 && priceBelow20 && isLowerLow) {
        trend = 'Strong Bearish';
        confidence = 85;
        direction = -1;
    } else if (ema9 > ema21 && priceAbove20) {
        trend = 'Bullish';
        confidence = 75;
        direction = 1;
    } else if (ema9 < ema21 && priceBelow20) {
        trend = 'Bearish';
        confidence = 75;
        direction = -1;
    } else if (ema9 > ema21) {
        trend = 'Slightly Bullish';
        confidence = 60;
        direction = 0.5;
    } else if (ema9 < ema21) {
        trend = 'Slightly Bearish';
        confidence = 60;
        direction = -0.5;
    }
    
    return { trend, confidence, direction };
}

// ============================================
// SIGNAL INTENSITY & ADX STRENGTH
// ============================================
function getSignalIntensity(confidence) {
    if (confidence >= 80) return '🔴🔴🔴 STRONG';
    if (confidence >= 70) return '🟠🟠 MODERATE';
    if (confidence >= 60) return '🟡 WEAK';
    return '⚪ LOW';
}

function getADXStrength(adx) {
    if (adx >= 40) return '🔥 VERY STRONG TREND';
    if (adx >= 25) return '📈 STRONG TREND';
    if (adx >= 20) return '📊 DEVELOPING TREND';
    return '🌀 SIDEWAYS/RANGE';
}

// ============================================
// MAIN SIGNAL GENERATION - HIGHER TF FIRST
// ============================================
async function analyzeSignal(priceData, config, tf, higherPriceData = null) {
    try {
        const candles = priceData.values;
        if (!candles || candles.length < 30) {
            return {
                signal: 'CALL',
                confidence: 50,
                intensity: '⚪ LOW',
                rsi: '50',
                adx: '0',
                adxStrength: 'Insufficient data',
                emaRelation: 'N/A',
                priceChange: '0',
                divergence: 'None',
                trend: '⚠️ Limited data - directional bias applied',
                strategyUsed: 'Fallback',
                higherTrend: 'Unknown',
                higherConfidence: 0,
                trendAlignment: '⚠️ Fallback direction (50% confidence)',
                historicalWinRate: null,
                recommendation: '⚠️ LOW CONFIDENCE - Consider skipping'
            };
        }
        
        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const currentPrice = closes[closes.length - 1];
        const ema9 = calculateEMA(closes, 9);
        const ema21 = calculateEMA(closes, 21);
        const rsi = calculateRSI(closes, 14);
        const { adx, plusDI, minusDI } = calculateADX(highs, lows, closes, 14);
        const priceChange = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
        
        // Trend detection on current timeframe
        const last5Closes = closes.slice(-5);
        const isHigherHigh = last5Closes[4] > last5Closes[3] && last5Closes[3] > last5Closes[2];
        const isLowerLow = last5Closes[4] < last5Closes[3] && last5Closes[3] < last5Closes[2];
        const priceAbove20Candles = currentPrice > Math.max(...closes.slice(-20));
        const priceBelow20Candles = currentPrice < Math.min(...closes.slice(-20));
        const priceAbove50Candles = currentPrice > Math.max(...closes.slice(-50));
        const priceBelow50Candles = currentPrice < Math.min(...closes.slice(-50));
        
        // RSI values for divergence
        const rsiValues = [];
        for (let i = 0; i < closes.length; i++) {
            const slice = closes.slice(0, i + 1);
            if (slice.length < 14) rsiValues.push(50);
            else rsiValues.push(calculateRSI(slice, 14));
        }
        const divergence = detectDivergence(closes, rsiValues);
        
        // HIGHER TIMEFRAME TREND (MOST IMPORTANT)
        const higherTrendData = getHigherTimeframeTrend(higherPriceData);
        const higherTrend = higherTrendData.trend;
        const higherDirection = higherTrendData.direction;
        const higherConfidence = higherTrendData.confidence;
        
        let signal = null;
        let trend = '';
        let strategyUsed = '';
        let baseConfidence = 50;
        let recommendation = '';
        const emaRelation = ema9 > ema21 ? 'EMA9 > EMA21 (Bullish)' : 'EMA9 < EMA21 (Bearish)';
        const adxStrength = getADXStrength(adx);
        
        // ============================================
        // STEP 1: HIGHER TIMEFRAME DETERMINES PRIMARY DIRECTION
        // ============================================
        
        // If higher timeframe is Bullish -> SIGNAL MUST BE CALL
        if (higherDirection > 0) {
            // Higher timeframe says UP - look for confirmation on lower timeframe
            if (adx >= 25 && ema9 > ema21 && priceAbove50Candles) {
                signal = 'CALL';
                trend = `📈 STRONG UPTREND (ADX: ${adx.toFixed(1)})`;
                strategyUsed = 'Trend Following + HTF Confirmed';
                baseConfidence = 88;
            }
            else if (ema9 > ema21 && priceAbove20Candles) {
                signal = 'CALL';
                trend = `📈 Uptrend confirmed (ADX: ${adx.toFixed(1)})`;
                strategyUsed = 'Trend Following + HTF Confirmed';
                baseConfidence = 82;
            }
            else if (rsi <= 35) {
                signal = 'CALL';
                trend = `⚠️ OVERSOLD (RSI: ${rsi.toFixed(0)}) + HTF Bullish → Buy Dip`;
                strategyUsed = 'Oversold Dip Buy';
                baseConfidence = 78;
            }
            else if (divergence === 'Bullish') {
                signal = 'CALL';
                trend = `🟢 BULLISH DIVERGENCE + HTF Bullish`;
                strategyUsed = 'Divergence + HTF';
                baseConfidence = 76;
            }
            else if (isHigherHigh) {
                signal = 'CALL';
                trend = `📈 Higher Highs + HTF Bullish`;
                strategyUsed = 'Price Action';
                baseConfidence = 72;
            }
            else {
                // Default to CALL when higher timeframe is bullish
                signal = 'CALL';
                trend = `📈 HTF Bullish Bias (${higherTrend}) - Following higher timeframe`;
                strategyUsed = 'Higher Timeframe Dominant';
                baseConfidence = 68;
            }
        }
        
        // If higher timeframe is Bearish -> SIGNAL MUST BE PUT
        else if (higherDirection < 0) {
            // Higher timeframe says DOWN - look for confirmation on lower timeframe
            if (adx >= 25 && ema9 < ema21 && priceBelow50Candles) {
                signal = 'PUT';
                trend = `📉 STRONG DOWNTREND (ADX: ${adx.toFixed(1)})`;
                strategyUsed = 'Trend Following + HTF Confirmed';
                baseConfidence = 88;
            }
            else if (ema9 < ema21 && priceBelow20Candles) {
                signal = 'PUT';
                trend = `📉 Downtrend confirmed (ADX: ${adx.toFixed(1)})`;
                strategyUsed = 'Trend Following + HTF Confirmed';
                baseConfidence = 82;
            }
            else if (rsi >= 65) {
                signal = 'PUT';
                trend = `⚠️ OVERBOUGHT (RSI: ${rsi.toFixed(0)}) + HTF Bearish → Sell Rally`;
                strategyUsed = 'Overbought Rally Sell';
                baseConfidence = 78;
            }
            else if (divergence === 'Bearish') {
                signal = 'PUT';
                trend = `🔴 BEARISH DIVERGENCE + HTF Bearish`;
                strategyUsed = 'Divergence + HTF';
                baseConfidence = 76;
            }
            else if (isLowerLow) {
                signal = 'PUT';
                trend = `📉 Lower Lows + HTF Bearish`;
                strategyUsed = 'Price Action';
                baseConfidence = 72;
            }
            else {
                // Default to PUT when higher timeframe is bearish
                signal = 'PUT';
                trend = `📉 HTF Bearish Bias (${higherTrend}) - Following higher timeframe`;
                strategyUsed = 'Higher Timeframe Dominant';
                baseConfidence = 68;
            }
        }
        
        // If higher timeframe is Neutral -> Use lower timeframe signals
        else {
            // STRONG TREND
            if (adx >= 25 && ema9 > ema21 && priceAbove50Candles) {
                signal = 'CALL';
                trend = `📈 STRONG UPTREND (ADX: ${adx.toFixed(1)}) | HTF: Neutral`;
                strategyUsed = 'Trend Following';
                baseConfidence = 78;
            }
            else if (adx >= 25 && ema9 < ema21 && priceBelow50Candles) {
                signal = 'PUT';
                trend = `📉 STRONG DOWNTREND (ADX: ${adx.toFixed(1)}) | HTF: Neutral`;
                strategyUsed = 'Trend Following';
                baseConfidence = 78;
            }
            // DIVERGENCE
            else if (divergence === 'Bullish') {
                signal = 'CALL';
                trend = `🟢 BULLISH DIVERGENCE | HTF: Neutral`;
                strategyUsed = 'Divergence Reversal';
                baseConfidence = 74;
            }
            else if (divergence === 'Bearish') {
                signal = 'PUT';
                trend = `🔴 BEARISH DIVERGENCE | HTF: Neutral`;
                strategyUsed = 'Divergence Reversal';
                baseConfidence = 74;
            }
            // RSI EXTREMES
            else if (rsi >= 70) {
                signal = 'PUT';
                trend = `⚠️ OVERBOUGHT (RSI: ${rsi.toFixed(0)}) | HTF: Neutral`;
                strategyUsed = 'RSI Reversal';
                baseConfidence = 70;
            }
            else if (rsi <= 30) {
                signal = 'CALL';
                trend = `⚠️ OVERSOLD (RSI: ${rsi.toFixed(0)}) | HTF: Neutral`;
                strategyUsed = 'RSI Reversal';
                baseConfidence = 70;
            }
            // EMA CROSS
            else if (ema9 > ema21 && isHigherHigh) {
                signal = 'CALL';
                trend = `📈 EMA Bullish Cross + Higher Highs`;
                strategyUsed = 'EMA Cross';
                baseConfidence = 65;
            }
            else if (ema9 < ema21 && isLowerLow) {
                signal = 'PUT';
                trend = `📉 EMA Bearish Cross + Lower Lows`;
                strategyUsed = 'EMA Cross';
                baseConfidence = 65;
            }
            // DEFAULT - EMA Bias
            else {
                if (ema9 > ema21) {
                    signal = 'CALL';
                    trend = `📈 DEFAULT - EMA Bullish Bias (ADX: ${adx.toFixed(1)})`;
                    strategyUsed = 'Default (EMA Bias)';
                    baseConfidence = 58;
                } else {
                    signal = 'PUT';
                    trend = `📉 DEFAULT - EMA Bearish Bias (ADX: ${adx.toFixed(1)})`;
                    strategyUsed = 'Default (EMA Bias)';
                    baseConfidence = 58;
                }
            }
        }
        
        // ============================================
        // CONFIDENCE ADJUSTMENTS
        // ============================================
        
        // ADX boost
        if (adx >= 40) baseConfidence += 8;
        else if (adx >= 30) baseConfidence += 5;
        else if (adx >= 20) baseConfidence += 2;
        else if (adx < 20) baseConfidence -= 5;
        
        // RSI confirmation
        if ((signal === 'CALL' && rsi < 35) || (signal === 'PUT' && rsi > 65)) {
            baseConfidence += 5;
        }
        
        // Divergence boost
        if ((signal === 'CALL' && divergence === 'Bullish') || (signal === 'PUT' && divergence === 'Bearish')) {
            baseConfidence += 6;
        }
        
        // DMI confirmation
        if ((signal === 'CALL' && plusDI > minusDI + 8) || (signal === 'PUT' && minusDI > plusDI + 8)) {
            baseConfidence += 4;
        }
        
        // Higher timeframe alignment (already factored, but add extra)
        if ((signal === 'CALL' && higherDirection > 0) || (signal === 'PUT' && higherDirection < 0)) {
            baseConfidence += 5;
            trend += ' ✅ ALIGNED WITH HIGHER TF';
        } else if (higherDirection !== 0 && ((signal === 'CALL' && higherDirection < 0) || (signal === 'PUT' && higherDirection > 0))) {
            // This should not happen with our logic, but just in case
            baseConfidence -= 20;
            trend += ' ⚠️⚠️ CONFLICT WITH HIGHER TF - HIGH RISK ⚠️⚠️';
        }
        
        // ============================================
        // HISTORICAL LEARNING
        // ============================================
        const patternId = `${signal}_${strategyUsed.replace(/ /g, '_')}_${higherTrend}`;
        const historicalWinRate = getHistoricalWinRate(config.pairName || 'UNKNOWN', tf, patternId);
        
        let finalConfidence = baseConfidence;
        if (historicalWinRate !== null) {
            finalConfidence = Math.floor((baseConfidence * 0.6) + (historicalWinRate * 0.4));
        }
        
        finalConfidence = Math.min(99, Math.max(45, finalConfidence));
        const intensity = getSignalIntensity(finalConfidence);
        
        // Final recommendation
        if (finalConfidence >= 80) {
            recommendation = '✅ STRONG SIGNAL - High probability trade';
        } else if (finalConfidence >= 70) {
            recommendation = '✅ Good signal - Consider taking the trade';
        } else if (finalConfidence >= 60) {
            recommendation = '⚠️ Weak signal - Trade only if you agree with direction';
        } else {
            recommendation = '⚠️ LOW CONFIDENCE - Better to skip this trade';
        }
        
        // Add higher timeframe info to recommendation
        recommendation += ` | HTF: ${higherTrend} (${higherConfidence}%)`;
        
        return {
            signal: signal,
            confidence: finalConfidence,
            intensity: intensity,
            rsi: rsi.toFixed(1),
            adx: adx.toFixed(1),
            adxStrength: adxStrength,
            emaRelation: emaRelation,
            priceChange: priceChange.toFixed(2),
            divergence: divergence,
            trend: trend,
            strategyUsed: strategyUsed,
            higherTrend: higherTrend,
            higherConfidence: higherConfidence,
            trendAlignment: `📊 HTF: ${higherTrend} (${higherConfidence}%) | ${strategyUsed} | ${intensity} (${finalConfidence}%) | ADX: ${adx.toFixed(1)} | RSI: ${rsi.toFixed(1)}`,
            patternId: patternId,
            historicalWinRate: historicalWinRate ? historicalWinRate.toFixed(1) + '%' : 'Learning...',
            recommendation: recommendation,
            shouldTrade: finalConfidence >= 70 ? '✅ Consider trading' : '⚠️ Consider skipping'
        };
        
    } catch (error) {
        console.error('Analyzer error:', error);
        return {
            signal: 'CALL',
            confidence: 50,
            intensity: '⚪ LOW',
            rsi: '50',
            adx: '0',
            adxStrength: 'Error',
            emaRelation: 'Error',
            priceChange: '0',
            divergence: 'None',
            trend: 'Analysis error - using fallback',
            strategyUsed: 'Fallback',
            higherTrend: 'Unknown',
            higherConfidence: 0,
            trendAlignment: '⚠️ Fallback direction (50% confidence)',
            patternId: 'error_fallback',
            historicalWinRate: null,
            recommendation: '⚠️ Analysis error - skip this trade',
            shouldTrade: '⚠️ Error - skip'
        };
    }
}

module.exports = { analyzeSignal, recordTradeOutcome };
