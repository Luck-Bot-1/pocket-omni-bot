// ============================================
// PROFESSIONAL ANALYZER v4.0 – VWAP + Backtest Engine + Divergence Veto
// ============================================

const fs = require('fs');
const path = require('path');

const BACKTEST_FILE = path.join(__dirname, 'backtest_stats.json');
const SESSION_CONFIG_FILE = path.join(__dirname, 'session.json');

// Default session config (UTC+6)
let sessionConfig = {
    skipAsianFor: ['JPY', 'AUD', 'NZD'],
    asianHours: [1, 2, 3, 4, 5, 6, 7],
    newsSkipMinutes: 30
};
if (fs.existsSync(SESSION_CONFIG_FILE)) {
    sessionConfig = JSON.parse(fs.readFileSync(SESSION_CONFIG_FILE, 'utf8'));
}

// ========== Backtest Statistics Management ==========
function loadStats() {
    if (!fs.existsSync(BACKTEST_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(BACKTEST_FILE, 'utf8')); } catch(e) { return {}; }
}
function saveStats(stats) { fs.writeFileSync(BACKTEST_FILE, JSON.stringify(stats, null, 2)); }

// Professional backtest: record trade outcome and update pattern win rate
function recordTradeOutcome(pair, tf, patternId, wasWin, profitPercent = 0) {
    const stats = loadStats();
    const key = `${pair}_${tf}_${patternId}`;
    if (!stats[key]) stats[key] = { total: 0, wins: 0, winRate: 50, totalProfit: 0, trades: [] };
    stats[key].total++;
    if (wasWin) stats[key].wins++;
    stats[key].winRate = (stats[key].wins / stats[key].total) * 100;
    if (profitPercent) stats[key].totalProfit += wasWin ? profitPercent : -Math.abs(profitPercent);
    // Keep only last 200 trades for memory
    stats[key].trades.push({ wasWin, profitPercent, timestamp: Date.now() });
    if (stats[key].trades.length > 200) stats[key].trades.shift();
    saveStats(stats);
}

function getRealConfidence(pair, tf, patternId) {
    const stats = loadStats();
    const key = `${pair}_${tf}_${patternId}`;
    if (stats[key] && stats[key].total >= 10) return Math.min(99, Math.max(1, stats[key].winRate));
    return 50; // default neutral
}

// ========== Technical Indicators ==========
function calculateEMA(values, period) {
    const k = 2 / (period + 1);
    let ema = values[0];
    for (let i = 1; i < values.length; i++) {
        ema = values[i] * k + ema * (1 - k);
    }
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
    let avgGain = gains / period;
    let avgLoss = losses / period;
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

// Enhanced divergence detection with swing highs/lows
function detectDivergence(price, indicator, lookback = 20) {
    const lastPrice = price[price.length-1];
    const lastInd = indicator[indicator.length-1];
    let bearish = false, bullish = false;
    // Find recent swing high/low
    let swingHighPrice = -Infinity, swingHighInd = -Infinity;
    let swingLowPrice = Infinity, swingLowInd = Infinity;
    for (let i = lookback; i > 0; i--) {
        const idx = price.length-1-i;
        if (price[idx] > swingHighPrice) {
            swingHighPrice = price[idx];
            swingHighInd = indicator[idx];
        }
        if (price[idx] < swingLowPrice) {
            swingLowPrice = price[idx];
            swingLowInd = indicator[idx];
        }
    }
    if (swingHighPrice < lastPrice && swingHighInd > lastInd) bearish = true;
    if (swingLowPrice > lastPrice && swingLowInd < lastInd) bullish = true;
    return bearish ? 'Bearish' : (bullish ? 'Bullish' : 'None');
}

// ========== Core single‑timeframe analysis ==========
function analyzeSingleTF(priceData, tf, type = 'forex') {
    const candles = priceData.values;
    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    
    // VWAP
    const vwap = calculateVWAP(candles);
    const currentPrice = closes[closes.length-1];
    const vwapPosition = currentPrice > vwap ? 'Above VWAP' : (currentPrice < vwap ? 'Below VWAP' : 'At VWAP');
    
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const rsi = calculateRSI(closes, 14);
    const stochK = calculateStochastic(highs, lows, closes, 14);
    const { adx, plusDI, minusDI } = calculateADX(highs, lows, closes, 14);
    const priceChange = ((closes[closes.length-1] - closes[0]) / closes[0]) * 100;
    
    // RSI divergence
    const rsiValues = [];
    for (let i = 0; i < closes.length; i++) {
        const slice = closes.slice(0, i+1);
        if (slice.length < 14) rsiValues.push(50);
        else rsiValues.push(calculateRSI(slice, 14));
    }
    const divergence = detectDivergence(closes, rsiValues);
    
    // Initial signal
    let signal = null;
    let trend = 'Sideways';
    const emaRelation = ema9 > ema21 ? 'EMA9 > EMA21' : 'EMA9 < EMA21';
    
    if (ema9 > ema21 && plusDI > minusDI && currentPrice > vwap) {
        signal = 'CALL';
        trend = 'Upward';
    } else if (ema9 < ema21 && minusDI > plusDI && currentPrice < vwap) {
        signal = 'PUT';
        trend = 'Downward';
    } else if (ema9 > ema21 && plusDI > minusDI) {
        signal = 'CALL'; // allow even if slightly off VWAP
        trend = 'Upward';
    } else if (ema9 < ema21 && minusDI > plusDI) {
        signal = 'PUT';
        trend = 'Downward';
    } else {
        signal = 'WAIT';
    }
    
    // Divergence veto (OVERRIDES)
    if (signal === 'CALL' && divergence === 'Bearish') signal = 'WAIT';
    if (signal === 'PUT' && divergence === 'Bullish') signal = 'WAIT';
    
    // Overbought/oversold veto
    if (signal === 'CALL' && (rsi > 75 || stochK > 80)) signal = 'WAIT';
    if (signal === 'PUT' && (rsi < 25 || stochK < 20)) signal = 'WAIT';
    
    // Extreme trend: wait for pullback
    if (adx > 45) signal = 'WAIT';
    
    return {
        signal,
        trend,
        emaRelation,
        vwap: vwap.toFixed(5),
        vwapPosition,
        rsi: rsi.toFixed(1),
        stochK: stochK.toFixed(1),
        adx: adx.toFixed(0),
        dmi: { plus: plusDI, minus: minusDI },
        priceChange: priceChange.toFixed(2),
        divergence,
        confidence: 0
    };
}

// ========== Multi‑timeframe & Filters ==========
function getHigherTF(tf) {
    const map = { '1m':'5m', '5m':'15m', '15m':'1h', '30m':'1h', '1h':'4h', '4h':'1d', '1d':'1w' };
    return map[tf] || '1h';
}

function isCandleOpen(timeframeMinutes, currentDate = new Date()) {
    const minutes = currentDate.getMinutes();
    const remainder = minutes % timeframeMinutes;
    // Allow entry within first 10% of candle (e.g., first 1.5 minutes of a 15m candle)
    const graceMinutes = Math.max(1, Math.floor(timeframeMinutes * 0.1));
    return remainder <= graceMinutes;
}

function isBadSession(pair, currentDate = new Date()) {
    const hour = currentDate.getHours();
    const shouldSkip = sessionConfig.skipAsianFor.some(currency => pair.includes(currency));
    if (shouldSkip && sessionConfig.asianHours.includes(hour)) return true;
    return false;
}

function isNewsEvent() {
    // Stub – integrate with economic calendar API if needed
    return false;
}

// ========== Main Exported Function ==========
async function analyzeSignal(priceData, config, tf, higherPriceData = null) {
    const pair = config.pairName || 'UNKNOWN';
    const timeframeMinutes = parseInt(tf);
    if (isNaN(timeframeMinutes)) return { signal: 'WAIT', reason: 'Invalid timeframe' };
    
    // 1. Candle open filter
    if (!isCandleOpen(timeframeMinutes)) {
        return { signal: 'WAIT', reason: `Enter only within first 10% of ${tf} candle (next :00, :15, etc.)` };
    }
    // 2. Session filter
    if (isBadSession(pair)) {
        return { signal: 'WAIT', reason: `Skipping ${pair} during Asian session (low volatility)` };
    }
    // 3. News filter
    if (isNewsEvent()) {
        return { signal: 'WAIT', reason: 'High‑impact news event imminent' };
    }
    
    // 4. Main timeframe analysis
    const main = analyzeSingleTF(priceData, tf, config.type);
    if (main.signal === 'WAIT') {
        let reason = main.divergence !== 'None' ? `${main.divergence} divergence` : 'No clear trend';
        if (main.adx > 45) reason = 'Extreme trend – waiting for pullback';
        if (main.rsi > 75 || main.stochK > 80) reason = 'Overbought';
        return { signal: 'WAIT', reason };
    }
    
    // 5. Higher timeframe confirmation (if available)
    let trendAlignment = 'Single timeframe only';
    if (higherPriceData) {
        const higherTF = getHigherTF(tf);
        const higher = analyzeSingleTF(higherPriceData, higherTF, config.type);
        if (higher.signal !== main.signal) {
            return { signal: 'WAIT', reason: `Higher timeframe (${higherTF}) shows ${higher.signal} – conflict` };
        }
        trendAlignment = `✅ Aligned with ${higherTF} (${higher.signal})`;
    }
    
    // 6. Pattern ID and real confidence
    const patternId = `${main.emaRelation}_${main.dmi.plus > main.dmi.minus ? 'DMIplus' : 'DMIminus'}_${main.divergence}_vwap${main.vwapPosition.replace(' ','')}`;
    const confidence = getRealConfidence(pair, tf, patternId);
    
    // 7. Final return
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
        trendAlignment,
        vwap: main.vwap,
        vwapPosition: main.vwapPosition,
        patternId,
        expirySuggestion: tf === '15m' ? '15m' : (tf === '5m' ? '5m' : '15m')
    };
}

module.exports = { analyzeSignal, recordTradeOutcome, getHigherTF, isCandleOpen };
