// ============================================
// OMNI_POCKET_BOT v3.0 - ANALYZER
// GOD-LEVEL SIGNAL GENERATION
// ============================================

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
    const rsi = 100 - (100 / (1 + rs));
    return isNaN(rsi) ? 50 : rsi;
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
    return { adx: isNaN(dx) ? 20 : dx, plusDI: isNaN(plusDI) ? 20 : plusDI, minusDI: isNaN(minusDI) ? 20 : minusDI };
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
    const atr = tr.slice(-period).reduce((a, b) => a + b, 0) / period;
    return isNaN(atr) ? 0.001 : atr;
}

function calculateEMA(data, period) {
    const k = 2 / (period + 1);
    let ema = data[0];
    const result = [ema];
    for (let i = 1; i < data.length; i++) {
        ema = data[i] * k + ema * (1 - k);
        result.push(ema);
    }
    return result;
}

function analyzeSignal(candles, pairName, timeframe) {
    try {
        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const price = closes[closes.length - 1];
        
        const rsi = calculateRSI(closes, 14);
        const { adx, plusDI, minusDI } = calculateADX(highs, lows, closes, 14);
        const atr = calculateATR(highs, lows, closes, 14);
        const ema20 = calculateEMA(closes, 20);
        const ema50 = calculateEMA(closes, 50);
        const currentEMA20 = ema20[ema20.length - 1];
        const currentEMA50 = ema50[ema50.length - 1];
        
        const avgPrice = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const volatility = (atr / avgPrice) * 100;
        
        // Trend detection
        let trend = "NEUTRAL";
        let trendStrength = 0;
        
        if (price > currentEMA20 && price > currentEMA50 && plusDI > minusDI && adx > 25) {
            trend = "UPTREND";
            trendStrength = 1;
        } else if (price < currentEMA20 && price < currentEMA50 && minusDI > plusDI && adx > 25) {
            trend = "DOWNTREND";
            trendStrength = -1;
        } else if (adx > 25) {
            trend = trendStrength === 1 ? "UPTREND" : (trendStrength === -1 ? "DOWNTREND" : "TRENDING");
        } else {
            trend = "SIDEWAYS";
        }
        
        // Signal determination
        let signal = "NEUTRAL";
        let confidence = 50;
        let direction = "";
        
        // RSI-based signals (PRIMARY)
        if (rsi < 30) {
            signal = "CALL";
            confidence = 65 + (30 - rsi);
            direction = `RSI is OVERSOLD at ${rsi.toFixed(1)} → Price likely to bounce UP`;
        } 
        else if (rsi > 70) {
            signal = "PUT";
            confidence = 65 + (rsi - 70);
            direction = `RSI is OVERBOUGHT at ${rsi.toFixed(1)} → Price likely to drop DOWN`;
        }
        // Trend-based signals (SECONDARY)
        else if (trend === "UPTREND" && rsi < 60) {
            signal = "CALL";
            confidence = 55 + (adx / 4);
            direction = `Strong UPTREND with ADX ${adx.toFixed(1)} → Continue higher`;
        }
        else if (trend === "DOWNTREND" && rsi > 40) {
            signal = "PUT";
            confidence = 55 + (adx / 4);
            direction = `Strong DOWNTREND with ADX ${adx.toFixed(1)} → Continue lower`;
        }
        // Momentum signals (TERTIARY)
        else if (adx > 30 && plusDI > minusDI && rsi < 55) {
            signal = "CALL";
            confidence = 55;
            direction = `Bullish momentum detected (ADX ${adx.toFixed(1)})`;
        }
        else if (adx > 30 && minusDI > plusDI && rsi > 45) {
            signal = "PUT";
            confidence = 55;
            direction = `Bearish momentum detected (ADX ${adx.toFixed(1)})`;
        }
        
        // Confidence adjustments
        if (adx < 20 && signal !== "NEUTRAL") {
            confidence -= 15;
            direction += ` ⚠️ Weak trend (ADX ${adx.toFixed(1)}) - Reduce position size`;
        }
        
        if (volatility < 0.12) {
            confidence -= 20;
            direction += ` ⚠️ Low volatility market - Skip or minimal risk`;
        }
        
        if ((trend === "UPTREND" && signal === "CALL") || (trend === "DOWNTREND" && signal === "PUT")) {
            confidence += 10;
            direction += ` ✅ Trading WITH the trend`;
        }
        
        if ((trend === "UPTREND" && signal === "PUT") || (trend === "DOWNTREND" && signal === "CALL")) {
            confidence -= 15;
            direction += ` ⚠️ Trading AGAINST trend - High risk!`;
        }
        
        confidence = Math.min(85, Math.max(30, Math.round(confidence)));
        
        if (confidence < 50) {
            signal = "NEUTRAL";
            direction = "Insufficient confidence - No trade";
        }
        
        // Expiry and risk management
        let expiry = 15;
        if (timeframe === '1m') expiry = 2;
        else if (timeframe === '5m') expiry = 5;
        else if (timeframe === '15m') expiry = 15;
        else if (timeframe === '30m') expiry = 30;
        else if (timeframe === '1h') expiry = 60;
        else if (timeframe === '4h') expiry = 240;
        
        const atrPips = (atr / price) * 10000;
        let stopLoss = Math.max(5, Math.round(atrPips * 1.5));
        let takeProfit = Math.round(stopLoss * 1.8);
        
        if (volatility < 0.2) {
            stopLoss = Math.max(3, Math.round(stopLoss * 0.7));
            takeProfit = Math.round(stopLoss * 1.8);
        } else if (volatility > 1.0) {
            stopLoss = Math.min(30, Math.round(stopLoss * 1.3));
            takeProfit = Math.round(stopLoss * 1.8);
        }
        
        return {
            signal,
            confidence,
            rsi: rsi.toFixed(1),
            adx: adx.toFixed(1),
            trend,
            volatility: volatility.toFixed(2),
            direction,
            expiry,
            stopLoss,
            takeProfit,
            timestamp: new Date().toISOString()
        };
        
    } catch(e) {
        console.error("Analysis error:", e);
        return {
            signal: "NEUTRAL",
            confidence: 0,
            rsi: "50",
            adx: "20",
            trend: "ERROR",
            volatility: "0",
            direction: "Analysis error",
            expiry: 15,
            stopLoss: 10,
            takeProfit: 18
        };
    }
}

module.exports = { analyzeSignal };
