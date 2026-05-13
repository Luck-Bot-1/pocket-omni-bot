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

function getSignalIntensity(confidence) {
    if (confidence >= 80) return '🔴🔴🔴 STRONG';
    if (confidence >= 70) return '🟠🟠 MODERATE';
    if (confidence >= 60) return '🟡 WEAK';
    return '⚪ LOW';
}

async function analyzeSignal(priceData, config, tf, higherPriceData = null) {
    try {
        const candles = priceData.values;
        if (!candles || candles.length < 30) {
            return {
                signal: 'CALL',
                confidence: 50,
                intensity: '⚪ LOW',
                rsi: '50',
                emaRelation: 'Insufficient data',
                priceChange: '0',
                divergence: 'None',
                trend: 'Limited data - direction uncertain',
                strategyUsed: 'Fallback',
                trendAlignment: '⚠️ Fallback direction (50% confidence)',
                historicalWinRate: null
            };
        }
        
        const closes = candles.map(c => c.close);
        const currentPrice = closes[closes.length - 1];
        const ema9 = calculateEMA(closes, 9);
        const ema21 = calculateEMA(closes, 21);
        const rsi = calculateRSI(closes, 14);
        const priceChange = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
        
        const last3Closes = closes.slice(-3);
        const isHigherHigh = last3Closes[2] > last3Closes[1];
        const isLowerLow = last3Closes[2] < last3Closes[1];
        const priceAbove20Candles = currentPrice > Math.max(...closes.slice(-20));
        const priceBelow20Candles = currentPrice < Math.min(...closes.slice(-20));
        
        const rsiValues = [];
        for (let i = 0; i < closes.length; i++) {
            const slice = closes.slice(0, i + 1);
            if (slice.length < 14) rsiValues.push(50);
            else rsiValues.push(calculateRSI(slice, 14));
        }
        const divergence = detectDivergence(closes, rsiValues);
        
        let signal = null;
        let trend = '';
        let strategyUsed = '';
        let baseConfidence = 50;
        const emaRelation = ema9 > ema21 ? 'EMA9 > EMA21 (Bullish)' : 'EMA9 < EMA21 (Bearish)';
        
        // SIGNAL DETERMINATION WITH CONFIDENCE SCORES
        
        // 1. TREND FOLLOWING (Highest confidence)
        if (ema9 > ema21 && priceAbove20Candles) {
            signal = 'CALL';
            trend = '📈 Strong Uptrend';
            strategyUsed = 'Trend Following';
            baseConfidence = 80;
        }
        else if (ema9 < ema21 && priceBelow20Candles) {
            signal = 'PUT';
            trend = '📉 Strong Downtrend';
            strategyUsed = 'Trend Following';
            baseConfidence = 80;
        }
        
        // 2. DIVERGENCE (High confidence reversal)
        else if (divergence === 'Bullish') {
            signal = 'CALL';
            trend = '🟢 Bullish Divergence';
            strategyUsed = 'Divergence Reversal';
            baseConfidence = 75;
        }
        else if (divergence === 'Bearish') {
            signal = 'PUT';
            trend = '🔴 Bearish Divergence';
            strategyUsed = 'Divergence Reversal';
            baseConfidence = 75;
        }
        
        // 3. RSI EXTREMES (Good reversal signal)
        else if (rsi > 75) {
            signal = 'PUT';
            trend = '⚠️ Strongly Overbought (RSI ' + rsi.toFixed(0) + ')';
            strategyUsed = 'RSI Extreme Reversal';
            baseConfidence = 76;
        }
        else if (rsi < 25) {
            signal = 'CALL';
            trend = '⚠️ Strongly Oversold (RSI ' + rsi.toFixed(0) + ')';
            strategyUsed = 'RSI Extreme Reversal';
            baseConfidence = 76;
        }
        else if (rsi > 65) {
            signal = 'PUT';
            trend = '⚠️ Overbought (RSI ' + rsi.toFixed(0) + ')';
            strategyUsed = 'RSI Reversal';
            baseConfidence = 68;
        }
        else if (rsi < 35) {
            signal = 'CALL';
            trend = '⚠️ Oversold (RSI ' + rsi.toFixed(0) + ')';
            strategyUsed = 'RSI Reversal';
            baseConfidence = 68;
        }
        
        // 4. EMA CROSS + Price Action
        else if (ema9 > ema21 && isHigherHigh) {
            signal = 'CALL';
            trend = '📈 EMA Bullish + Higher High';
            strategyUsed = 'EMA Cross';
            baseConfidence = 70;
        }
        else if (ema9 < ema21 && isLowerLow) {
            signal = 'PUT';
            trend = '📉 EMA Bearish + Lower Low';
            strategyUsed = 'EMA Cross';
            baseConfidence = 70;
        }
        
        // 5. MOMENTUM
        else if (priceChange > 0.15) {
            signal = 'CALL';
            trend = '⚡ Strong Up Momentum (' + priceChange.toFixed(2) + '%)';
            strategyUsed = 'Momentum';
            baseConfidence = 66;
        }
        else if (priceChange < -0.15) {
            signal = 'PUT';
            trend = '⚡ Strong Down Momentum (' + Math.abs(priceChange).toFixed(2) + '%)';
            strategyUsed = 'Momentum';
            baseConfidence = 66;
        }
        else if (priceChange > 0.08) {
            signal = 'CALL';
            trend = '⚡ Up Momentum (' + priceChange.toFixed(2) + '%)';
            strategyUsed = 'Momentum';
            baseConfidence = 60;
        }
        else if (priceChange < -0.08) {
            signal = 'PUT';
            trend = '⚡ Down Momentum (' + Math.abs(priceChange).toFixed(2) + '%)';
            strategyUsed = 'Momentum';
            baseConfidence = 60;
        }
        
        // 6. DEFAULT – EMA Bias (Lowest confidence)
        else {
            if (ema9 > ema21) {
                signal = 'CALL';
                trend = '📈 Neutral - EMA Bullish Bias';
                strategyUsed = 'Default (EMA Bias)';
                baseConfidence = 55;
            } else {
                signal = 'PUT';
                trend = '📉 Neutral - EMA Bearish Bias';
                strategyUsed = 'Default (EMA Bias)';
                baseConfidence = 55;
            }
        }
        
        // Adjust confidence based on RSI strength
        if (signal === 'CALL' && rsi < 30) {
            baseConfidence += 5;
        } else if (signal === 'PUT' && rsi > 70) {
            baseConfidence += 5;
        }
        
        // Adjust for divergence strength
        if (divergence !== 'None') {
            baseConfidence += 3;
        }
        
        // Get historical win rate for this pattern
        const patternId = `${emaRelation}_${strategyUsed.replace(/ /g, '_')}_${divergence}`;
        const historicalWinRate = getHistoricalWinRate(config.pairName || 'UNKNOWN', tf, patternId);
        
        // Final confidence: weighted average of base confidence and historical win rate
        let finalConfidence = baseConfidence;
        if (historicalWinRate !== null) {
            finalConfidence = Math.floor((baseConfidence * 0.6) + (historicalWinRate * 0.4));
        }
        
        finalConfidence = Math.min(99, Math.max(50, finalConfidence));
        const intensity = getSignalIntensity(finalConfidence);
        
        return {
            signal: signal,
            confidence: finalConfidence,
            intensity: intensity,
            rsi: rsi.toFixed(1),
            emaRelation: emaRelation,
            priceChange: priceChange.toFixed(2),
            divergence: divergence,
            trend: trend,
            strategyUsed: strategyUsed,
            trendAlignment: `✅ ${strategyUsed} | ${intensity} (${finalConfidence}%) | Direction: ${signal === 'CALL' ? 'UP ⬆️' : 'DOWN ⬇️'}`,
            patternId: patternId,
            historicalWinRate: historicalWinRate ? historicalWinRate.toFixed(1) + '%' : 'Insufficient data'
        };
        
    } catch (error) {
        console.error('Analyzer error:', error);
        return {
            signal: 'CALL',
            confidence: 50,
            intensity: '⚪ LOW',
            rsi: '50',
            emaRelation: 'Error',
            priceChange: '0',
            divergence: 'None',
            trend: 'Analysis error - using fallback',
            strategyUsed: 'Fallback',
            trendAlignment: '⚠️ Fallback direction (50% confidence)',
            patternId: 'error_fallback',
            historicalWinRate: null
        };
    }
}

module.exports = { analyzeSignal, recordTradeOutcome };
