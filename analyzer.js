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

function calculateSMA(values, period) {
    if (values.length < period) return values[values.length - 1];
    const slice = values.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
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
    const smoothTR = tr.slice(-period).reduce((a, b) => a + b, 0) / period;
    const smoothPlus = plusDM.slice(-period).reduce((a, b) => a + b, 0) / period;
    const smoothMinus = minusDM.slice(-period).reduce((a, b) => a + b, 0) / period;
    const plusDI = (smoothPlus / smoothTR) * 100;
    const minusDI = (smoothMinus / smoothTR) * 100;
    const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
    return { adx: dx, plusDI, minusDI };
}

function calculateATR(high, low, close, period = 14) {
    const tr = [];
    for (let i = 1; i < high.length; i++) {
        const hl = high[i] - low[i];
        const hc = Math.abs(high[i] - close[i-1]);
        const lc = Math.abs(low[i] - close[i-1]);
        tr.push(Math.max(hl, hc, lc));
    }
    return tr.slice(-period).reduce((a, b) => a + b, 0) / period;
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

function calculateBollingerBands(closes, period = 20, stdDev = 2) {
    const sma = calculateSMA(closes, period);
    const variance = closes.slice(-period).reduce((sum, price) => sum + Math.pow(price - sma, 2), 0) / period;
    const std = Math.sqrt(variance);
    return { upper: sma + stdDev * std, middle: sma, lower: sma - stdDev * std };
}

// ============================================
// HIGHER TIMEFRAME TREND (PRIMARY FILTER)
// ============================================
function getHigherTimeframeTrend(higherPriceData) {
    if (!higherPriceData || !higherPriceData.values || higherPriceData.values.length < 50) {
        return { trend: 'Neutral', confidence: 50, direction: 0, description: 'Higher timeframe data insufficient' };
    }
    
    const closes = higherPriceData.values.map(c => c.close);
    const highs = higherPriceData.values.map(c => c.high);
    const lows = higherPriceData.values.map(c => c.low);
    const ema20 = calculateEMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);
    const currentPrice = closes[closes.length - 1];
    const { adx, plusDI, minusDI } = calculateADX(highs, lows, closes, 14);
    
    let trend = 'Neutral';
    let confidence = 50;
    let direction = 0;
    let description = '';
    
    if (currentPrice > ema20 && currentPrice > ema50 && ema20 > ema50 && adx > 25 && plusDI > minusDI) {
        trend = 'Strong Bullish';
        confidence = 85;
        direction = 1;
        description = `Strong uptrend - ADX: ${adx.toFixed(1)}`;
    } else if (currentPrice > ema20 && currentPrice > ema50) {
        trend = 'Bullish';
        confidence = 75;
        direction = 1;
        description = `Bullish - Price above 20/50 EMA`;
    } else if (currentPrice > ema20) {
        trend = 'Slightly Bullish';
        confidence = 60;
        direction = 0.5;
        description = `Slightly bullish - Price above 20EMA`;
    } else if (currentPrice < ema20 && currentPrice < ema50 && ema20 < ema50 && adx > 25 && minusDI > plusDI) {
        trend = 'Strong Bearish';
        confidence = 85;
        direction = -1;
        description = `Strong downtrend - ADX: ${adx.toFixed(1)}`;
    } else if (currentPrice < ema20 && currentPrice < ema50) {
        trend = 'Bearish';
        confidence = 75;
        direction = -1;
        description = `Bearish - Price below 20/50 EMA`;
    } else if (currentPrice < ema20) {
        trend = 'Slightly Bearish';
        confidence = 60;
        direction = -0.5;
        description = `Slightly bearish - Price below 20EMA`;
    }
    
    return { trend, confidence, direction, description, ema20, ema50, adx };
}

// ============================================
// STRATEGY 1: TURTLE TREND FOLLOWING (Richard Dennis)
// ============================================
function turtleTrendFollowing(closes, highs, lows, htfDirection) {
    const currentPrice = closes[closes.length - 1];
    const high20 = Math.max(...highs.slice(-20));
    const low20 = Math.min(...lows.slice(-20));
    const atr = calculateATR(highs, lows, closes, 20);
    
    let signal = null;
    let confidence = 0;
    let description = '';
    
    if (htfDirection > 0 && currentPrice > high20 && atr > 0.0005) {
        signal = 'CALL';
        confidence = 82;
        description = `Turtle Breakout UP - 20-day high: ${high20.toFixed(5)}`;
    } else if (htfDirection < 0 && currentPrice < low20 && atr > 0.0005) {
        signal = 'PUT';
        confidence = 82;
        description = `Turtle Breakout DOWN - 20-day low: ${low20.toFixed(5)}`;
    }
    
    return { signal, confidence, description };
}

// ============================================
// STRATEGY 2: RASCHKE PULLBACK (Linda Raschke)
// ============================================
function raschkePullback(closes, highs, lows, htfDirection) {
    const { adx, plusDI, minusDI } = calculateADX(highs, lows, closes, 14);
    const rsi = calculateRSI(closes, 14);
    const ema20 = calculateEMA(closes, 20);
    const currentPrice = closes[closes.length - 1];
    
    let signal = null;
    let confidence = 0;
    let description = '';
    
    if (htfDirection > 0 && adx >= 25 && adx <= 45 && plusDI > minusDI && rsi >= 40 && rsi <= 60 && Math.abs(currentPrice - ema20) / ema20 < 0.002) {
        signal = 'CALL';
        confidence = 75;
        description = `Raschke Pullback BUY - ADX: ${adx.toFixed(1)}, RSI: ${rsi.toFixed(0)}`;
    } else if (htfDirection < 0 && adx >= 25 && adx <= 45 && minusDI > plusDI && rsi >= 40 && rsi <= 60 && Math.abs(currentPrice - ema20) / ema20 < 0.002) {
        signal = 'PUT';
        confidence = 75;
        description = `Raschke Pullback SELL - ADX: ${adx.toFixed(1)}, RSI: ${rsi.toFixed(0)}`;
    }
    
    return { signal, confidence, description, adx, rsi };
}

// ============================================
// STRATEGY 3: TUDOR JONES REVERSAL (Paul Tudor Jones)
// ============================================
function tudorJonesReversal(closes, highs, lows, htfDirection) {
    const rsi = calculateRSI(closes, 14);
    const rsiValues = [];
    for (let i = 0; i < closes.length; i++) {
        const slice = closes.slice(0, i + 1);
        if (slice.length < 14) rsiValues.push(50);
        else rsiValues.push(calculateRSI(slice, 14));
    }
    const divergence = detectDivergence(closes, rsiValues);
    
    let signal = null;
    let confidence = 0;
    let description = '';
    
    if (rsi < 30 && divergence === 'Bullish') {
        signal = 'CALL';
        confidence = htfDirection > 0 ? 82 : 68;
        description = `Tudor Jones Reversal BUY - Bullish divergence at RSI: ${rsi.toFixed(0)}`;
    } else if (rsi > 70 && divergence === 'Bearish') {
        signal = 'PUT';
        confidence = htfDirection < 0 ? 82 : 68;
        description = `Tudor Jones Reversal SELL - Bearish divergence at RSI: ${rsi.toFixed(0)}`;
    } else if (rsi < 25 && htfDirection > 0) {
        signal = 'CALL';
        confidence = 70;
        description = `Oversold Reversal BUY - RSI: ${rsi.toFixed(0)}`;
    } else if (rsi > 75 && htfDirection < 0) {
        signal = 'PUT';
        confidence = 70;
        description = `Overbought Reversal SELL - RSI: ${rsi.toFixed(0)}`;
    }
    
    return { signal, confidence, description, rsi, divergence };
}

// ============================================
// STRATEGY 4: MINERVINI TREND TEMPLATE (Mark Minervini)
// ============================================
function minerviniTrendTemplate(closes, htfDirection) {
    const ema50 = calculateEMA(closes, 50);
    const ema150 = calculateEMA(closes, 150);
    const currentPrice = closes[closes.length - 1];
    
    let signal = null;
    let confidence = 0;
    let description = '';
    
    const isBullish = currentPrice > ema50 && ema50 > ema150;
    const isBearish = currentPrice < ema50 && ema50 < ema150;
    
    if (isBullish && htfDirection > 0) {
        signal = 'CALL';
        confidence = 78;
        description = `Minervini Trend BUY - Price > 50 > 150 EMA`;
    } else if (isBearish && htfDirection < 0) {
        signal = 'PUT';
        confidence = 78;
        description = `Minervini Trend SELL - Price < 50 < 150 EMA`;
    }
    
    return { signal, confidence, description };
}

// ============================================
// STRATEGY 5: BOLLINGER MEAN REVERSION (John Bollinger)
// ============================================
function bollingerMeanReversion(closes, htfDirection) {
    const bb = calculateBollingerBands(closes, 20, 2);
    const currentPrice = closes[closes.length - 1];
    const rsi = calculateRSI(closes, 14);
    
    let signal = null;
    let confidence = 0;
    let description = '';
    
    if (Math.abs(htfDirection) < 0.5) {
        if (currentPrice <= bb.lower && rsi < 35) {
            signal = 'CALL';
            confidence = 72;
            description = `Bollinger Mean Reversion BUY - Price at lower band, RSI: ${rsi.toFixed(0)}`;
        } else if (currentPrice >= bb.upper && rsi > 65) {
            signal = 'PUT';
            confidence = 72;
            description = `Bollinger Mean Reversion SELL - Price at upper band, RSI: ${rsi.toFixed(0)}`;
        }
    }
    
    return { signal, confidence, description };
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

function getADXStrength(adx) {
    if (adx >= 40) return '🔥 VERY STRONG TREND';
    if (adx >= 25) return '📈 STRONG TREND';
    if (adx >= 20) return '📊 DEVELOPING TREND';
    return '🌀 SIDEWAYS/RANGE';
}

// ============================================
// MAIN STRATEGY ORCHESTRATOR
// ============================================
async function analyzeSignal(priceData, config, tf, higherPriceData = null) {
    try {
        const candles = priceData.values;
        if (!candles || candles.length < 100) {
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
                trend: '⚠️ Need 100+ candles',
                strategyUsed: 'Insufficient Data',
                higherTrend: 'Unknown',
                higherConfidence: 0,
                volatilityPercent: '0',
                trendAlignment: '⚠️ Insufficient data',
                historicalWinRate: null,
                recommendation: '⚠️ Need more historical data'
            };
        }
        
        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const rsi = calculateRSI(closes, 14);
        const { adx } = calculateADX(highs, lows, closes, 14);
        const priceChange = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
        
        // STEP 1: HIGHER TIMEFRAME (PRIMARY FILTER)
        const higherTimeframe = getHigherTimeframeTrend(higherPriceData);
        const htfDirection = higherTimeframe.direction;
        
        // STEP 2: RUN ALL 5 LEGENDARY STRATEGIES
        const turtle = turtleTrendFollowing(closes, highs, lows, htfDirection);
        const raschke = raschkePullback(closes, highs, lows, htfDirection);
        const tudorJones = tudorJonesReversal(closes, highs, lows, htfDirection);
        const minervini = minerviniTrendTemplate(closes, htfDirection);
        const bollinger = bollingerMeanReversion(closes, htfDirection);
        
        let signal = null;
        let strategyUsed = '';
        let trend = '';
        let baseConfidence = 50;
        let description = '';
        
        // STEP 3: STRATEGY PRIORITY
        if (turtle.signal) {
            signal = turtle.signal;
            strategyUsed = 'Turtle Trend Following (Richard Dennis)';
            trend = turtle.description;
            baseConfidence = turtle.confidence;
            description = `20-day breakout strategy`;
        } else if (raschke.signal) {
            signal = raschke.signal;
            strategyUsed = 'Raschke Pullback (Linda Raschke)';
            trend = raschke.description;
            baseConfidence = raschke.confidence;
            description = `ADX: ${raschke.adx.toFixed(1)} | RSI: ${raschke.rsi.toFixed(0)}`;
        } else if (tudorJones.signal) {
            signal = tudorJones.signal;
            strategyUsed = 'Tudor Jones Reversal (Paul Tudor Jones)';
            trend = tudorJones.description;
            baseConfidence = tudorJones.confidence;
            description = `RSI: ${tudorJones.rsi.toFixed(0)} | Divergence: ${tudorJones.divergence}`;
        } else if (minervini.signal) {
            signal = minervini.signal;
            strategyUsed = 'Minervini Trend Template (Mark Minervini)';
            trend = minervini.description;
            baseConfidence = minervini.confidence;
            description = `50/150 EMA alignment`;
        } else if (bollinger.signal) {
            signal = bollinger.signal;
            strategyUsed = 'Bollinger Mean Reversion (John Bollinger)';
            trend = bollinger.description;
            baseConfidence = bollinger.confidence;
            description = `Bollinger Band touch + RSI confirmation`;
        } else {
            // FALLBACK: Follow HTF direction
            if (htfDirection > 0) {
                signal = 'CALL';
                strategyUsed = 'HTF Direction (Primary Filter)';
                trend = `Following Higher Timeframe: ${higherTimeframe.trend}`;
                baseConfidence = 60;
                description = `HTF: ${higherTimeframe.trend}`;
            } else if (htfDirection < 0) {
                signal = 'PUT';
                strategyUsed = 'HTF Direction (Primary Filter)';
                trend = `Following Higher Timeframe: ${higherTimeframe.trend}`;
                baseConfidence = 60;
                description = `HTF: ${higherTimeframe.trend}`;
            } else {
                const ema50 = calculateEMA(closes, 50);
                const currentPrice = closes[closes.length - 1];
                if (currentPrice > ema50) {
                    signal = 'CALL';
                    strategyUsed = 'Ultimate Fallback - EMA50 Bias';
                    trend = 'Trading EMA50 direction (HTF Neutral)';
                    baseConfidence = 55;
                } else {
                    signal = 'PUT';
                    strategyUsed = 'Ultimate Fallback - EMA50 Bias';
                    trend = 'Trading EMA50 direction (HTF Neutral)';
                    baseConfidence = 55;
                }
            }
        }
        
        // STEP 4: VOLATILITY FILTER
        const atr = calculateATR(highs, lows, closes, 20);
        const avgPrice = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const volatilityPercent = (atr / avgPrice) * 100;
        
        if (volatilityPercent < 0.15) {
            baseConfidence -= 10;
            trend += ' ⚠️ LOW VOLATILITY';
        }
        
        // STEP 5: HISTORICAL LEARNING
        const patternId = `${signal}_${strategyUsed.replace(/ /g, '_')}`;
        const historicalWinRate = getHistoricalWinRate(config.pairName || 'UNKNOWN', tf, patternId);
        
        let finalConfidence = baseConfidence;
        if (historicalWinRate !== null) {
            finalConfidence = Math.floor((finalConfidence * 0.6) + (historicalWinRate * 0.4));
        }
        
        finalConfidence = Math.min(99, Math.max(45, finalConfidence));
        const intensity = getSignalIntensity(finalConfidence);
        const adxStrength = getADXStrength(adx);
        
        // STEP 6: RECOMMENDATION
        let recommendation = '';
        if (finalConfidence >= 80) recommendation = '✅ STRONG SIGNAL - High probability trade';
        else if (finalConfidence >= 70) recommendation = '✅ Good signal - Consider taking the trade';
        else if (finalConfidence >= 60) recommendation = '⚠️ Weak signal - Trade only if you agree with direction';
        else recommendation = '⚠️ LOW CONFIDENCE - Better to skip this trade';
        
        recommendation += ` | HTF: ${higherTimeframe.trend} | Volatility: ${volatilityPercent.toFixed(2)}%`;
        
        // FINAL RETURN
        return {
            signal: signal,
            confidence: finalConfidence,
            intensity: intensity,
            rsi: rsi.toFixed(1),
            adx: adx.toFixed(1),
            adxStrength: adxStrength,
            emaRelation: `20EMA: ${calculateEMA(closes, 20).toFixed(5)} | 50EMA: ${calculateEMA(closes, 50).toFixed(5)}`,
            priceChange: priceChange.toFixed(2),
            divergence: 'N/A',
            trend: trend,
            strategyUsed: strategyUsed,
            strategyDescription: description,
            higherTrend: higherTimeframe.trend,
            higherConfidence: higherTimeframe.confidence,
            higherDescription: higherTimeframe.description,
            volatilityPercent: volatilityPercent.toFixed(2),
            trendAlignment: `📊 HTF: ${higherTimeframe.trend} → ${strategyUsed} | ${intensity} (${finalConfidence}%) | ADX: ${adx.toFixed(1)} | RSI: ${rsi.toFixed(1)}`,
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
            strategyDescription: 'Error',
            higherTrend: 'Unknown',
            higherConfidence: 0,
            higherDescription: '',
            volatilityPercent: '0',
            trendAlignment: '⚠️ Fallback direction (50% confidence)',
            patternId: 'error_fallback',
            historicalWinRate: null,
            recommendation: '⚠️ Analysis error - skip this trade',
            shouldTrade: '⚠️ Error - skip'
        };
    }
}

module.exports = { analyzeSignal, recordTradeOutcome };
