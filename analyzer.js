// ============================================================
// PRAGMATIC ANALYZER v5.0 – GUARANTEED SIGNALS
// ============================================================
const technicalIndicators = require('technicalindicators');
const fs = require('fs');

// Helper: swing points (simplified, no look‑ahead)
function findSwingPoints(prices, period = 5, minDistance = 4) {
    const swings = { lows: [], highs: [] };
    for (let i = period; i < prices.length - period; i++) {
        let isLow = true, isHigh = true;
        for (let j = -period; j <= period; j++) {
            if (j === 0) continue;
            if (prices[i] >= prices[i + j]) isLow = false;
            if (prices[i] <= prices[i + j]) isHigh = false;
        }
        if (isLow) swings.lows.push({ idx: i, price: prices[i] });
        if (isHigh) swings.highs.push({ idx: i, price: prices[i] });
    }
    const filter = (arr) => arr.filter((_, idx) => idx === 0 || (arr[idx].idx - arr[idx-1].idx >= minDistance));
    swings.lows = filter(swings.lows);
    swings.highs = filter(swings.highs);
    return swings;
}

// Divergence detection (simplified)
function detectDivergence(prices, oscillator, requireConfirmation = true) {
    if (prices.length < 50 || oscillator.length < 50) return null;
    const swingsPrice = findSwingPoints(prices, 5, 4);
    const swingsOsc = findSwingPoints(oscillator, 5, 4);
    let divergence = null;
    if (swingsPrice.lows.length >= 2 && swingsOsc.lows.length >= 2) {
        const pL = swingsPrice.lows.slice(-2);
        const oL = swingsOsc.lows.slice(-2);
        if (pL[1].price < pL[0].price && oL[1].price > oL[0].price)
            divergence = { type: 'BULLISH_REGULAR', strength: 'MODERATE', priceIdx: pL[1].idx };
    }
    if (!divergence && swingsPrice.highs.length >= 2 && swingsOsc.highs.length >= 2) {
        const pH = swingsPrice.highs.slice(-2);
        const oH = swingsOsc.highs.slice(-2);
        if (pH[1].price > pH[0].price && oH[1].price < oH[0].price)
            divergence = { type: 'BEARISH_REGULAR', strength: 'MODERATE', priceIdx: pH[1].idx };
    }
    if (!divergence && swingsPrice.lows.length >= 2 && swingsOsc.lows.length >= 2) {
        const pL = swingsPrice.lows.slice(-2);
        const oL = swingsOsc.lows.slice(-2);
        if (pL[1].price > pL[0].price && oL[1].price < oL[0].price)
            divergence = { type: 'BULLISH_HIDDEN', strength: 'STRONG', priceIdx: pL[1].idx };
    }
    if (!divergence && swingsPrice.highs.length >= 2 && swingsOsc.highs.length >= 2) {
        const pH = swingsPrice.highs.slice(-2);
        const oH = swingsOsc.highs.slice(-2);
        if (pH[1].price < pH[0].price && oH[1].price > oH[0].price)
            divergence = { type: 'BEARISH_HIDDEN', strength: 'STRONG', priceIdx: pH[1].idx };
    }
    if (divergence && requireConfirmation) {
        const currentPrice = prices[prices.length-1];
        if (divergence.type.includes('BULLISH') && currentPrice <= prices[divergence.priceIdx]) return null;
        if (divergence.type.includes('BEARISH') && currentPrice >= prices[divergence.priceIdx]) return null;
    }
    return divergence;
}

// Hull Moving Average
function calculateHMA(data, period) {
    if (data.length < period * 2) return data.slice();
    const half = Math.floor(period / 2);
    const sqrt = Math.floor(Math.sqrt(period));
    const wma = (values, len) => {
        let weightSum = 0, valSum = 0;
        for (let i = 0; i < len; i++) {
            const w = len - i;
            weightSum += w;
            valSum += values[values.length - 1 - i] * w;
        }
        return valSum / weightSum;
    };
    const hma = [];
    for (let i = period * 2; i <= data.length; i++) {
        const seg = data.slice(i - period * 2, i);
        const wma1 = wma(seg, period);
        const wma2 = wma(seg, half);
        const raw = 2 * wma2 - wma1;
        const smoothed = wma([raw], sqrt);
        hma.push(smoothed);
    }
    return hma;
}

class RobustAnalyzer {
    constructor(initialCapital = 10000) {
        this.tradeHistory = [];
        this.calibrationFile = './calibration.json';
        this.loadCalibration();
        this.logisticBeta0 = -0.5;
        this.logisticBeta1 = 1.2;
        this.equityCurve = [initialCapital];
        this.riskMultiplier = 1;
        this.maxDrawdown = 0.15;
    }

    loadCalibration() {
        try {
            if (fs.existsSync(this.calibrationFile)) {
                const data = JSON.parse(fs.readFileSync(this.calibrationFile));
                this.tradeHistory = data.trades || [];
                if (data.logisticBeta0 && data.logisticBeta1) {
                    this.logisticBeta0 = data.logisticBeta0;
                    this.logisticBeta1 = data.logisticBeta1;
                }
                if (data.equityCurve) this.equityCurve = data.equityCurve;
            }
        } catch(e) {}
    }

    saveCalibration() {
        try {
            fs.writeFileSync(this.calibrationFile, JSON.stringify({
                trades: this.tradeHistory.slice(-500),
                logisticBeta0: this.logisticBeta0,
                logisticBeta1: this.logisticBeta1,
                equityCurve: this.equityCurve.slice(-100)
            }, null, 2));
        } catch(e) {}
    }

    recordTradeOutcome(wasWin, rawScore, pnlPercent = 0) {
        this.tradeHistory.push({ win: wasWin, rawScore, pnlPercent, timestamp: Date.now() });
        if (this.tradeHistory.length > 500) this.tradeHistory.shift();
        this.updateEquity(pnlPercent);
        this.updateCalibration();
        this.saveCalibration();
    }

    updateEquity(pnlPercent) {
        const newEquity = this.equityCurve[this.equityCurve.length-1] * (1 + pnlPercent/100);
        this.equityCurve.push(newEquity);
        if (this.equityCurve.length > 100) this.equityCurve.shift();
        const peak = Math.max(...this.equityCurve);
        const drawdown = (peak - newEquity) / peak;
        if (drawdown > this.maxDrawdown) this.riskMultiplier = 0.5;
        else this.riskMultiplier = 1;
    }

    updateCalibration() {
        const recent = this.tradeHistory.slice(-200);
        if (recent.length < 50) return;
        let beta0 = this.logisticBeta0, beta1 = this.logisticBeta1;
        const lr = 0.01;
        for (let iter = 0; iter < 100; iter++) {
            let grad0 = 0, grad1 = 0;
            for (let t of recent) {
                const z = beta0 + beta1 * (t.rawScore / 50 - 1);
                const p = 1 / (1 + Math.exp(-z));
                const error = t.win ? 1 - p : 0 - p;
                grad0 += error;
                grad1 += error * (t.rawScore / 50 - 1);
            }
            beta0 += lr * grad0 / recent.length;
            beta1 += lr * grad1 / recent.length;
        }
        this.logisticBeta0 = beta0;
        this.logisticBeta1 = beta1;
    }

    calibrateProbability(rawScore) {
        const z = this.logisticBeta0 + this.logisticBeta1 * (rawScore / 50 - 1);
        let prob = 1 / (1 + Math.exp(-z));
        prob = Math.min(0.95, Math.max(0.05, prob));
        return Math.round(prob * 100);
    }

    // ---------- Indicators ----------
    calculateRSI(closes, period = 14) {
        if (closes.length < period + 1) return 50;
        try { return technicalIndicators.RSI({ values: closes, period }).slice(-1)[0] || 50; } catch(e) { return 50; }
    }
    calculateATR(highs, lows, closes, period = 14) {
        if (highs.length < period + 1) return 0.001;
        try { return technicalIndicators.ATR({ high: highs, low: lows, close: closes, period }).slice(-1)[0] || 0.001; } catch(e) { return 0.001; }
    }
    calculateADX(highs, lows, closes, period = 14) {
        if (highs.length < period + 2) return { adx: 20, trend: 'RANGING' };
        try {
            const adx = technicalIndicators.ADX({ high: highs, low: lows, close: closes, period }).slice(-1)[0] || 20;
            let trend = 'RANGING';
            if (adx >= 25) trend = 'WEAK_TRENDING';
            if (adx >= 40) trend = 'STRONG_TRENDING';
            return { adx: Math.round(adx * 10) / 10, trend };
        } catch(e) { return { adx: 20, trend: 'RANGING' }; }
    }
    calculateEMA(data, period) {
        if (data.length < period) return data[data.length-1];
        try { return technicalIndicators.EMA({ values: data, period }).slice(-1)[0]; } catch(e) { return data[data.length-1]; }
    }
    calculateBollingerBands(closes, period = 20, stdDev = 2) {
        if (closes.length < period) return { lower: null, upper: null };
        try {
            const bb = technicalIndicators.BollingerBands({ period, values: closes, stdDev }).slice(-1)[0];
            return { lower: bb.lower, upper: bb.upper };
        } catch(e) { return { lower: null, upper: null }; }
    }

    // ---------- Main signal (guaranteed to trigger often) ----------
    calculateProbability(candles, pair, timeframe, htCandles = null) {
        try {
            if (!candles || candles.length < 50) return this.neutral("Insufficient data");
            const closes = candles.map(c => c.close);
            const highs = candles.map(c => c.high);
            const lows = candles.map(c => c.low);
            const price = closes[closes.length - 1];

            const rsi = this.calculateRSI(closes, 14);
            const atr = this.calculateATR(highs, lows, closes, 14);
            const adxData = this.calculateADX(highs, lows, closes, 14);
            const bb = this.calculateBollingerBands(closes, 20, 2);
            const ema200 = this.calculateEMA(closes, 200);
            const volatility = (atr / price) * 100;

            // Simplified regime
            const isTrending = adxData.adx >= 25;
            const mode = isTrending ? 'TREND' : 'RANGE';
            const majorTrend = price > ema200 ? 'BULLISH' : (price < ema200 ? 'BEARISH' : 'NEUTRAL');

            const hma = calculateHMA(closes, 20);
            const hmaSlope = hma.length >= 2 ? hma[hma.length-1] - hma[hma.length-2] : 0;

            const rsiArray = [];
            for (let i = 30; i <= closes.length; i++) rsiArray.push(this.calculateRSI(closes.slice(0, i), 14));
            const divergence = detectDivergence(closes, rsiArray, true);

            let signal = 'NEUTRAL';
            let rawScore = 50;
            let reason = "";

            // Always try to produce a signal unless market is extremely quiet
            if (mode === 'TREND') {
                if (Math.abs(hmaSlope) > 0.0001) {
                    signal = hmaSlope > 0 ? 'CALL' : 'PUT';
                    rawScore = 65 + Math.min(20, Math.abs(hmaSlope) * 10000);
                    reason = `Trend: HMA ${signal === 'CALL' ? 'up' : 'down'}`;
                } else if (divergence) {
                    signal = divergence.type.includes('BULLISH') ? 'CALL' : 'PUT';
                    rawScore = 70;
                    reason = `Trend: ${divergence.type}`;
                } else {
                    // Fallback: use RSI bias
                    if (rsi > 55) { signal = 'CALL'; rawScore = 55; reason = "Trend: RSI >55"; }
                    else if (rsi < 45) { signal = 'PUT'; rawScore = 55; reason = "Trend: RSI <45"; }
                    else { signal = 'CALL'; rawScore = 50; reason = "Trend: neutral, default CALL"; }
                }
            } else { // RANGE
                if (rsi < 35 && bb.lower && price <= bb.lower) {
                    signal = 'CALL'; rawScore = 70; reason = "Range: oversold + BB";
                } else if (rsi > 65 && bb.upper && price >= bb.upper) {
                    signal = 'PUT'; rawScore = 70; reason = "Range: overbought + BB";
                } else if (divergence) {
                    signal = divergence.type.includes('BULLISH') ? 'CALL' : 'PUT';
                    rawScore = 75; reason = `Range: ${divergence.type}`;
                } else {
                    // Fallback: use moving average slope
                    const ema9 = this.calculateEMA(closes, 9);
                    const ema21 = this.calculateEMA(closes, 21);
                    if (ema9 > ema21) { signal = 'CALL'; rawScore = 55; reason = "Range: EMA9 > EMA21"; }
                    else { signal = 'PUT'; rawScore = 55; reason = "Range: EMA9 < EMA21"; }
                }
            }

            // Trend alignment bonus/penalty
            if (signal !== 'NEUTRAL') {
                if ((signal === 'CALL' && majorTrend === 'BULLISH') || (signal === 'PUT' && majorTrend === 'BEARISH')) {
                    rawScore += 10; reason += " + trend aligned";
                } else if ((signal === 'CALL' && majorTrend === 'BEARISH') || (signal === 'PUT' && majorTrend === 'BULLISH')) {
                    rawScore -= 10; reason += " - against trend";
                }
            }

            rawScore = Math.min(100, Math.max(0, rawScore));
            let probability = this.calibrateProbability(rawScore);
            // Ensure probability is at least 45% to always have signals (for testing)
            if (probability < 45) probability = 45;

            console.log(`[SIGNAL] ${pair} ${timeframe}: ${signal} prob=${probability}% raw=${rawScore} reason=${reason}`);

            // Risk & Sizing
            const baseRisk = this.getBaseRiskPercent(probability);
            const kelly = this.calculateKellyFactor();
            const volFactor = Math.min(1.5, Math.max(0.5, 0.0025 / (atr/price)));
            const ddFactor = this.riskMultiplier;
            let finalRisk = baseRisk * kelly * volFactor * ddFactor;
            finalRisk = Math.min(3.0, Math.max(0.3, finalRisk));

            const spreadPips = 0.8;
            let stopPips = Math.max(10, Math.min(50, Math.round((atr / price) * 10000 * 1.2)));
            stopPips = Math.round(stopPips + spreadPips/2 + 0.5);
            let tpPips = (mode === 'TREND') ? Math.round(stopPips * 2.5) : Math.round(stopPips * 1.5);
            tpPips = Math.max(stopPips * 1.2, Math.round(tpPips - spreadPips/2));
            const maxBars = (timeframe === '1m' ? 60 : (timeframe === '5m' ? 24 : 12));

            return {
                signal, probability, rawScore: Math.round(rawScore),
                recommendedAction: this.getAction(probability),
                suggestedRisk: `${finalRisk.toFixed(2)}%`,
                rsi: rsi.toFixed(1), adx: adxData.adx.toFixed(1),
                trendRegime: adxData.trend, marketRegime: mode,
                volatility: volatility.toFixed(2), currentPrice: price.toFixed(5),
                divergence: divergence ? `${divergence.type} (${divergence.strength})` : 'None',
                majorTrend, hmaSlope: hmaSlope.toFixed(6),
                activeFactors: this.getActiveFactors(rawScore, divergence, signal, rsi, bb),
                stopLoss: stopPips, takeProfit: tpPips, maxHoldBars: maxBars,
                riskRewardRatio: (tpPips / stopPips).toFixed(2),
                pair, timeframe, timestamp: new Date().toISOString(),
                version: "PRAGMATIC-v5.0", guidance: reason
            };
        } catch (err) {
            return this.neutral(`Error: ${err.message}`);
        }
    }

    getBaseRiskPercent(prob) {
        if (prob >= 85) return 2.5;
        if (prob >= 75) return 2.0;
        if (prob >= 65) return 1.5;
        if (prob >= 55) return 0.8;
        return 0.5;
    }

    calculateKellyFactor() {
        const trades = this.tradeHistory.slice(-50);
        if (trades.length < 20) return 0.25;
        const wins = trades.filter(t => t.win).length;
        const winRate = wins / trades.length;
        const avgWin = trades.filter(t => t.win).reduce((a,b)=>a+b.pnlPercent,0) / (wins || 1);
        const avgLoss = Math.abs(trades.filter(t => !t.win).reduce((a,b)=>a+b.pnlPercent,0) / (trades.length - wins || 1));
        const kelly = (winRate * (avgWin/avgLoss) - (1-winRate)) / (avgWin/avgLoss);
        return Math.min(0.25, Math.max(0.05, kelly));
    }

    getAction(prob) {
        if (prob >= 85) return "STRONG_TRADE";
        if (prob >= 75) return "CONFIDENT_TRADE";
        if (prob >= 65) return "NORMAL_TRADE";
        if (prob >= 55) return "CAUTIOUS_TRADE";
        return "NO_TRADE";
    }

    getActiveFactors(rawScore, divergence, signal, rsi, bb) {
        const factors = [];
        if (divergence) factors.push(divergence.type);
        if (signal === 'CALL' && rsi < 30) factors.push('RSI_OVERSOLD');
        if (signal === 'PUT' && rsi > 70) factors.push('RSI_OVERBOUGHT');
        if (bb.lower && rawScore > 55) factors.push('BB_SUPPORT');
        if (bb.upper && rawScore < 45) factors.push('BB_RESISTANCE');
        return factors;
    }

    neutral(reason) {
        return {
            signal: "NEUTRAL", probability: 0, rawScore: 50,
            recommendedAction: "NO_TRADE", suggestedRisk: "0%",
            rsi: "50", adx: "20", trendRegime: "UNKNOWN", marketRegime: "unknown",
            volatility: "0", currentPrice: "0", divergence: "None", majorTrend: "NEUTRAL",
            hmaSlope: "0", activeFactors: [], stopLoss: 15, takeProfit: 27,
            maxHoldBars: 12, riskRewardRatio: "1.80", timestamp: new Date().toISOString(),
            pair: "UNKNOWN", timeframe: "UNKNOWN", version: "PRAGMATIC-v5.0", guidance: reason
        };
    }
}

module.exports = { RobustAnalyzer, detectDivergence };
