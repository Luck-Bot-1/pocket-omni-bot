const fs = require('fs');
const path = require('path');
const BACKTEST_FILE = path.join(__dirname, 'backtest_stats.json');
const SESSION_CONFIG_FILE = path.join(__dirname, 'session.json');

let sessionConfig = {
    skipAsianFor: [],
    asianHours: [],
    newsSkipMinutes: 0
};
if (fs.existsSync(SESSION_CONFIG_FILE)) {
    try { sessionConfig = JSON.parse(fs.readFileSync(SESSION_CONFIG_FILE, 'utf8')); } catch(e) {}
}

function loadStats() {
    if (!fs.existsSync(BACKTEST_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(BACKTEST_FILE, 'utf8')); } catch(e) { return {}; }
}
function saveStats(stats) { fs.writeFileSync(BACKTEST_FILE, JSON.stringify(stats, null, 2)); }

function recordTradeOutcome(pair, tf, patternId, wasWin, profitPercent = 0) {
    const stats = loadStats();
    const key = `${pair}_${tf}_${patternId}`;
    if (!stats[key]) stats[key] = { total: 0, wins: 0, winRate: 50, totalProfit: 0, trades: [] };
    stats[key].total++;
    if (wasWin) stats[key].wins++;
    stats[key].winRate = (stats[key].wins / stats[key].total) * 100;
    if (profitPercent) stats[key].totalProfit += wasWin ? profitPercent : -Math.abs(profitPercent);
    stats[key].trades.push({ wasWin, profitPercent, timestamp: Date.now() });
    if (stats[key].trades.length > 200) stats[key].trades.shift();
    saveStats(stats);
}

function getRealConfidence(pair, tf, patternId) {
    const stats = loadStats();
    const key = `${pair}_${tf}_${patternId}`;
    if (stats[key] && stats[key].total >= 10) return Math.min(99, Math.max(1, stats[key].winRate));
    return 50;
}

function calculateEMA(values, period) {
    const k = 2 / (period + 1);
    let ema = values[0];
    for (let i = 1; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
    return ema;
}

function calculateVWAP(candles) {
    let cumPV = 0, cumVol = 0;
    for (let i = 0; i < candles.length; i++) {
        const typical = (candles[i].high + candles[i].low + candles[i].close) / 3;
        cumPV += typical * candles[i].volume;
        cumVol += candles[i].volume;
    }
    return cumVol > 0 ? cumPV / cumVol : candles[candles.length-1].close;
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
    for (let i = period+1; i < closes.length; i++) {
        const diff = closes[i] - closes[i-1];
        if (diff >= 0) {
            avgGain = (avgGain * (period-1) + diff) / period;
            avgLoss = (avgLoss * (period-1)) / period;
        } else {
            avgGain = (avgGain * (period-1)) / period;
            avgLoss = (avgLoss * (period-1) - diff) / period;
        }
    }
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function calculateStochastic(highs, lows, closes, period = 14) {
    const recentHigh = Math.max(...highs.slice(-period));
    const recentLow = Math.min(...lows.slice(-period));
    const k = ((closes[closes.length-1] - recentLow) / (recentHigh - recentLow)) * 100;
    return isNaN(k) ? 50 : k;
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
    const lastPrice = price[price.length-1];
    const lastInd = indicator[indicator.length-1];
    let bearish = false, bullish = false;
    let swingHighPrice = -Infinity, swingHighInd = -Infinity;
    let swingLowPrice = Infinity, swingLowInd = Infinity;
    for (let i = lookback; i > 0; i--) {
        const idx = price.length-1-i;
        if (price[idx] > swingHighPrice) { swingHighPrice = price[idx]; swingHighInd = indicator[idx]; }
        if (price[idx] < swingLowPrice) { swingLowPrice = price[idx]; swingLowInd = indicator[idx]; }
    }
    if (swingHighPrice < lastPrice && swingHighInd > lastInd) bearish = true;
    if (swingLowPrice > lastPrice && swingLowInd < lastInd) bullish = true;
    return bearish ? 'Bearish' : (bullish ? 'Bullish' : 'None');
}

function analyzeSingleTF(priceData, tf) {
    const candles = priceData.values;
    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const vwap = calculateVWAP(candles);
    const currentPrice = closes[closes.length-1];
    const vwapPosition = currentPrice > vwap ? 'Above VWAP' : (currentPrice < vwap ? 'Below VWAP' : 'At VWAP');
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const rsi = calculateRSI(closes, 14);
    const stochK = calculateStochastic(highs, lows, closes, 14);
    const { adx, plusDI, minusDI } = calculateADX(highs, lows, closes, 14);
    const priceChange = ((closes[closes.length-1] - closes[0]) / closes[0]) * 100;
    
    const rsiValues = [];
    for (let i = 0; i < closes.length; i++) {
        const slice = closes.slice(0, i+1);
        if (slice.length < 14) rsiValues.push(50);
        else rsiValues.push(calculateRSI(slice, 14));
    }
    const divergence = detectDivergence(closes, rsiValues);
    let signal = null;
    let trend = 'Sideways';
    let strategyUsed = '';
    const emaRelation = ema9 > ema21 ? 'EMA9 > EMA21' : 'EMA9 < EMA21';
    const isUptrend = ema9 > ema21 && plusDI > minusDI;
    const isDowntrend = ema9 < ema21 && minusDI > plusDI;
    
    // STRATEGY 1: TREND FOLLOWING (ADX > 18) - LOWERED FOR MORE SIGNALS
    if (adx > 18 && isUptrend && currentPrice > vwap) {
        signal = 'CALL';
        trend = 'Strong Uptrend';
        strategyUsed = 'Trend Following';
    }
    else if (adx > 18 && isDowntrend && currentPrice < vwap) {
        signal = 'PUT';
        trend = 'Strong Downtrend';
        strategyUsed = 'Trend Following';
    }
    // STRATEGY 2: PULLBACK ENTRY (ADX > 18)
    else if (adx > 18 && isUptrend && (rsi < 40 || stochK < 30)) {
        signal = 'CALL';
        trend = 'Pullback Buy (Dip)';
        strategyUsed = 'Pullback Entry';
    }
    else if (adx > 18 && isDowntrend && (rsi > 60 || stochK > 70)) {
        signal = 'PUT';
        trend = 'Pullback Sell (Bounce)';
        strategyUsed = 'Pullback Entry';
    }
    // STRATEGY 3: REVERSAL (Overbought/Oversold)
    else if (rsi > 75 || stochK > 80) {
        signal = 'PUT';
        trend = 'Overbought Reversal → Sell';
        strategyUsed = 'Reversal (Overbought)';
    }
    else if (rsi < 25 || stochK < 20) {
        signal = 'CALL';
        trend = 'Oversold Reversal → Buy';
        strategyUsed = 'Reversal (Oversold)';
    }
    // STRATEGY 4: RANGE TRADING (ADX < 18)
    else if (adx < 18 && rsi > 70) {
        signal = 'PUT';
        trend = 'Range Top → Sell';
        strategyUsed = 'Range Trading';
    }
    else if (adx < 18 && rsi < 30) {
        signal = 'CALL';
        trend = 'Range Bottom → Buy';
        strategyUsed = 'Range Trading';
    }
    else {
        // NO FORCED SIGNALS - legitimate WAIT only
        signal = 'WAIT';
        strategyUsed = 'No Setup';
    }
    
    // DIVERGENCE VETO (Overrides all strategies)
    if (signal === 'CALL' && divergence === 'Bearish') {
        signal = 'WAIT';
        trend = 'Bearish divergence overrides CALL';
        strategyUsed = 'Divergence Veto';
    }
    if (signal === 'PUT' && divergence === 'Bullish') {
        signal = 'WAIT';
        trend = 'Bullish divergence overrides PUT';
        strategyUsed = 'Divergence Veto';
    }
    
    // EXTREME TREND FILTER (ADX > 55)
    if (adx > 55 && signal !== 'WAIT') {
        signal = 'WAIT';
        trend = 'Extreme trend – waiting for pullback';
        strategyUsed = 'Extreme Trend Filter';
    }
    
    return { signal, trend, strategyUsed, emaRelation, vwap: vwap.toFixed(5), vwapPosition, rsi: rsi.toFixed(1), stochK: stochK.toFixed(1), adx: adx.toFixed(0), dmi: { plus: plusDI, minus: minusDI }, priceChange: priceChange.toFixed(2), divergence };
}

function isCandleOpen(timeframeMinutes, currentDate = new Date()) {
    return true;
}

function isBadSession(pair, currentDate = new Date()) {
    return false;
}

async function analyzeSignal(priceData, config, tf, higherPriceData = null) {
    const pair = config.pairName || 'UNKNOWN';
    const main = analyzeSingleTF(priceData, tf);
    
    if (main.signal === 'WAIT') {
        let reason = main.trend;
        if (main.divergence !== 'None') reason = `${main.divergence} divergence`;
        return { signal: 'WAIT', reason };
    }
    
    const patternId = `${main.emaRelation}_${main.dmi.plus > main.dmi.minus ? 'DMIplus' : 'DMIminus'}_${main.divergence}_${main.strategyUsed.replace(/ /g,'')}`;
    const confidence = getRealConfidence(pair, tf, patternId);
    
    return {
        signal: main.signal,
        confidence: Math.min(99, Math.max(1, confidence)),
        rsi: main.rsi,
        adx: main.adx,
        emaRelation: main.emaRelation,
        dmi: main.dmi,
        priceChange: main.priceChange,
        divergence: main.divergence,
        trend: main.trend,
        strategyUsed: main.strategyUsed,
        trendAlignment: `✅ Strategy: ${main.strategyUsed} | ADX: ${main.adx} | VWAP: ${main.vwapPosition}`,
        vwap: main.vwap,
        vwapPosition: main.vwapPosition,
        patternId
    };
}

module.exports = { analyzeSignal, recordTradeOutcome, isCandleOpen };
