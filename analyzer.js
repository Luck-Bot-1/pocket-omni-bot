const technicalIndicators = require('technicalindicators');
const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------------
// Swing point detection (for divergence & market structure)
// ------------------------------------------------------------------
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
    // filter by minimum distance
    const filter = (arr) => arr.filter((_, idx) => idx === 0 || (arr[idx].idx - arr[idx-1].idx >= minDistance));
    swings.lows = filter(swings.lows);
    swings.highs = filter(swings.highs);
    return swings;
}

// ------------------------------------------------------------------
// Divergence detection (Regular & Hidden)
// ------------------------------------------------------------------
function detectDivergence(prices, oscillator) {
    if (prices.length < 50 || oscillator.length < 50) return null;
    const swingsPrice = findSwingPoints(prices, 5, 4);
    const swingsOsc = findSwingPoints(oscillator, 5, 4);
    
    // Bullish Regular: price lower low, oscillator higher low
    let bullishRegular = null;
    if (swingsPrice.lows.length >= 2 && swingsOsc.lows.length >= 2) {
        const pL = swingsPrice.lows.slice(-2);
        const oL = swingsOsc.lows.slice(-2);
        if (pL[1].price < pL[0].price && oL[1].price > oL[0].price)
            bullishRegular = { type: 'BULLISH_REGULAR', strength: 'MODERATE' };
    }
    // Bearish Regular: price higher high, oscillator lower high
    let bearishRegular = null;
    if (swingsPrice.highs.length >= 2 && swingsOsc.highs.length >= 2) {
        const pH = swingsPrice.highs.slice(-2);
        const oH = swingsOsc.highs.slice(-2);
        if (pH[1].price > pH[0].price && oH[1].price < oH[0].price)
            bearishRegular = { type: 'BEARISH_REGULAR', strength: 'MODERATE' };
    }
    // Bullish Hidden: price higher low, oscillator lower low
    let bullishHidden = null;
    if (swingsPrice.lows.length >= 2 && swingsOsc.lows.length >= 2) {
        const pL = swingsPrice.lows.slice(-2);
        const oL = swingsOsc.lows.slice(-2);
        if (pL[1].price > pL[0].price && oL[1].price < oL[0].price)
            bullishHidden = { type: 'BULLISH_HIDDEN', strength: 'STRONG' };
    }
    // Bearish Hidden: price lower high, oscillator higher high
    let bearishHidden = null;
    if (swingsPrice.highs.length >= 2 && swingsOsc.highs.length >= 2) {
        const pH = swingsPrice.highs.slice(-2);
        const oH = swingsOsc.highs.slice(-2);
        if (pH[1].price < pH[0].price && oH[1].price > oH[0].price)
            bearishHidden = { type: 'BEARISH_HIDDEN', strength: 'STRONG' };
    }
    return bullishRegular || bearishRegular || bullishHidden || bearishHidden;
}

// ------------------------------------------------------------------
// ROBUST ANALYZER – No ADX override, no forced direction, calibrated probabilities
// ------------------------------------------------------------------
class RobustAnalyzer {
    constructor() {
        this.tradeHistory = [];
        this.calibrationFile = './calibration.json';
        this.loadCalibration();
        // logistic regression parameters (fitted from past trades)
        this.logisticBeta0 = -0.5;
        this.logisticBeta1 = 1.2;
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
            }
        } catch(e) { /* ignore */ }
    }

    saveCalibration() {
        try {
            fs.writeFileSync(this.calibrationFile, JSON.stringify({
                trades: this.tradeHistory.slice(-500),
                logisticBeta0: this.logisticBeta0,
                logisticBeta1: this.logisticBeta1
            }, null, 2));
        } catch(e) {}
    }

    recordTradeOutcome(wasWin, rawScore) {
        this.tradeHistory.push({ win: wasWin, rawScore, timestamp: Date.now() });
        if (this.tradeHistory.length > 500) this.tradeHistory.shift();
        this.updateCalibration();
        this.saveCalibration();
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

    // ------------------------- Technical Indicators -------------------------
    calculateRSI(closes, period = 14) {
        if (closes.length < period + 1) return 50;
        try {
            const rsi = technicalIndicators.RSI({ values: closes, period });
            return rsi[rsi.length - 1] || 50;
        } catch(e) { return 50; }
    }

    calculateATR(highs, lows, closes, period = 14) {
        if (highs.length < period + 1) return 0.001;
        try {
            const atr = technicalIndicators.ATR({ high: highs, low: lows, close: closes, period });
            return atr[atr.length - 1] || 0.001;
        } catch(e) { return 0.001; }
    }

    calculateADX(highs, lows, closes, period = 14) {
        if (highs.length < period + 2) return { adx: 20, trend: 'RANGING' };
        try {
            const adx = technicalIndicators.ADX({ high: highs, low: lows, close: closes, period });
            const val = adx[adx.length - 1] || 20;
            let trend = 'RANGING';
            if (val >= 25) trend = 'WEAK_TRENDING';
            if (val >= 40) trend = 'STRONG_TRENDING';
            return { adx: Math.round(val * 10) / 10, trend };
        } catch(e) { return { adx: 20, trend: 'RANGING' }; }
    }

    calculateEMA(data, period) {
        if (data.length < period) return data[data.length - 1];
        try {
            const ema = technicalIndicators.EMA({ values: data, period });
            return ema[ema.length - 1];
        } catch(e) { return data[data.length - 1]; }
    }

    calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
        if (closes.length < slow + signal) return { histogram: 0, macd: 0, signal: 0, cross: 'NEUTRAL' };
        try {
            const macd = technicalIndicators.MACD({ values: closes, fastPeriod: fast, slowPeriod: slow, signalPeriod: signal });
            const last = macd[macd.length - 1];
            let cross = 'NEUTRAL';
            if (macd.length >= 2) {
                const prev = macd[macd.length - 2];
                if (prev.MACD <= prev.signal && last.MACD > last.signal) cross = 'BULLISH';
                else if (prev.MACD >= prev.signal && last.MACD < last.signal) cross = 'BEARISH';
            }
            return { histogram: last.histogram, macd: last.MACD, signal: last.signal, cross };
        } catch(e) { return { histogram: 0, macd: 0, signal: 0, cross: 'NEUTRAL' }; }
    }

    calculateBollingerBands(closes, period = 20, stdDev = 2) {
        if (closes.length < period) return { lower: null, upper: null, middle: null };
        try {
            const bb = technicalIndicators.BollingerBands({ period, values: closes, stdDev });
            const last = bb[bb.length - 1];
            return { lower: last.lower, upper: last.upper, middle: last.middle };
        } catch(e) { return { lower: null, upper: null, middle: null }; }
    }

    // ------------------------- Main Signal Engine -------------------------
    calculateProbability(candles, pair, timeframe) {
        try {
            if (!candles || candles.length < 50) {
                return this.neutral("Insufficient data (<50 candles)");
            }
            const closes = candles.map(c => c.close);
            const highs = candles.map(c => c.high);
            const lows = candles.map(c => c.low);
            const price = closes[closes.length - 1];

            const rsi = this.calculateRSI(closes, 14);
            const atr = this.calculateATR(highs, lows, closes, 14);
            const adxData = this.calculateADX(highs, lows, closes, 14);
            const macd = this.calculateMACD(closes);
            const bb = this.calculateBollingerBands(closes, 20, 2);
            const ema200 = this.calculateEMA(closes, 200);
            const ema20 = this.calculateEMA(closes, 20);
            const ema20Prev = closes.length > 21 ? this.calculateEMA(closes.slice(0, -1), 20) : ema20;
            const volatility = (atr / price) * 100;

            const majorTrend = price > ema200 ? 'BULLISH' : (price < ema200 ? 'BEARISH' : 'NEUTRAL');
            const shortTrend = ema20 > ema20Prev ? 'UP' : (ema20 < ema20Prev ? 'DOWN' : 'FLAT');

            // RSI oscillator array for divergence
            const rsiArray = [];
            for (let i = 30; i <= closes.length; i++) {
                rsiArray.push(this.calculateRSI(closes.slice(0, i), 14));
            }
            const divergence = detectDivergence(closes, rsiArray);

            // ----- Raw score (0-100, >50 bullish) -----
            let rawScore = 50;

            // MACD momentum
            if (macd.histogram > 0) rawScore += 8;
            else if (macd.histogram < 0) rawScore -= 8;
            if (macd.cross === 'BULLISH') rawScore += 10;
            else if (macd.cross === 'BEARISH') rawScore -= 10;

            // RSI with trend context
            if (rsi < 30 && majorTrend === 'BULLISH') rawScore += 12;
            else if (rsi < 25) rawScore += 8;
            else if (rsi > 70 && majorTrend === 'BEARISH') rawScore -= 12;
            else if (rsi > 75) rawScore -= 8;
            else if (rsi > 50) rawScore += 2;
            else if (rsi < 50) rawScore -= 2;

            // Bollinger Bands
            if (bb.lower && price <= bb.lower && majorTrend === 'BULLISH') rawScore += 10;
            else if (bb.lower && price <= bb.lower) rawScore += 4;
            if (bb.upper && price >= bb.upper && majorTrend === 'BEARISH') rawScore -= 10;
            else if (bb.upper && price >= bb.upper) rawScore -= 4;

            // Trend following
            if (shortTrend === 'UP' && adxData.adx >= 25) rawScore += 15;
            else if (shortTrend === 'UP') rawScore += 6;
            else if (shortTrend === 'DOWN' && adxData.adx >= 25) rawScore -= 15;
            else if (shortTrend === 'DOWN') rawScore -= 6;

            // Divergence
            if (divergence) {
                if (divergence.type === 'BULLISH_REGULAR') rawScore += 12;
                else if (divergence.type === 'BULLISH_HIDDEN') rawScore += 16;
                else if (divergence.type === 'BEARISH_REGULAR') rawScore -= 12;
                else if (divergence.type === 'BEARISH_HIDDEN') rawScore -= 16;
            }

            // Reduce confidence in low volatility
            if (volatility < 0.15) rawScore = rawScore * 0.7 + 15;

            rawScore = Math.min(100, Math.max(0, rawScore));
            const probability = this.calibrateProbability(rawScore);

            // Neutral if no clear edge
            if (Math.abs(rawScore - 50) < 8 && !divergence && adxData.adx < 22) {
                return this.neutral("Low conviction – no clear edge");
            }

            let signal = 'NEUTRAL';
            if (probability >= 55) signal = rawScore > 50 ? 'CALL' : (rawScore < 50 ? 'PUT' : 'NEUTRAL');
            if (signal === 'NEUTRAL' && probability >= 52) {
                signal = rawScore > 50 ? 'CALL' : (rawScore < 50 ? 'PUT' : 'NEUTRAL');
            }

            const riskPercent = this.getRiskPercent(probability);
            const stopPips = Math.max(10, Math.min(50, Math.round((atr / price) * 10000 * 1.2)));
            const tpPips = Math.round(stopPips * (probability >= 70 ? 2.0 : 1.5));

            return {
                signal,
                probability,
                rawScore: Math.round(rawScore),
                recommendedAction: this.getAction(probability),
                suggestedRisk: `${riskPercent}%`,
                rsi: rsi.toFixed(1),
                adx: adxData.adx.toFixed(1),
                trendRegime: adxData.trend,
                volatility: volatility.toFixed(2),
                currentPrice: price.toFixed(5),
                divergence: divergence ? `${divergence.type} (${divergence.strength})` : 'None',
                majorTrend,
                activeFactors: this.getActiveFactors(rawScore, divergence, macd, rsi, bb),
                stopLoss: stopPips,
                takeProfit: tpPips,
                riskRewardRatio: (tpPips / stopPips).toFixed(2),
                pair, timeframe,
                timestamp: new Date().toISOString(),
                version: "5.0-ROBUST"
            };
        } catch (err) {
            return this.neutral(`Calculation error: ${err.message}`);
        }
    }

    getRiskPercent(prob) {
        if (prob >= 85) return 2.5;
        if (prob >= 75) return 2.0;
        if (prob >= 65) return 1.5;
        if (prob >= 55) return 0.8;
        return 0;
    }

    getAction(prob) {
        if (prob >= 85) return "STRONG_TRADE";
        if (prob >= 75) return "CONFIDENT_TRADE";
        if (prob >= 65) return "NORMAL_TRADE";
        if (prob >= 55) return "CAUTIOUS_TRADE";
        return "NO_TRADE";
    }

    getActiveFactors(rawScore, divergence, macd, rsi, bb) {
        const factors = [];
        if (divergence) factors.push(divergence.type);
        if (macd.cross !== 'NEUTRAL') factors.push(`MACD_${macd.cross}`);
        if (rsi < 30) factors.push('RSI_OVERSOLD');
        if (rsi > 70) factors.push('RSI_OVERBOUGHT');
        if (bb.lower && rawScore > 55) factors.push('BB_SUPPORT');
        if (bb.upper && rawScore < 45) factors.push('BB_RESISTANCE');
        return factors;
    }

    neutral(reason) {
        return {
            signal: "NEUTRAL",
            probability: 0,
            rawScore: 50,
            recommendedAction: "NO_TRADE",
            suggestedRisk: "0%",
            rsi: "50",
            adx: "20",
            trendRegime: "UNKNOWN",
            volatility: "0",
            currentPrice: "0",
            divergence: "None",
            majorTrend: "NEUTRAL",
            activeFactors: [],
            stopLoss: 15,
            takeProfit: 27,
            riskRewardRatio: "1.80",
            timestamp: new Date().toISOString(),
            pair: "UNKNOWN",
            timeframe: "UNKNOWN",
            version: "5.0-ROBUST",
            guidance: reason
        };
    }
}

module.exports = { RobustAnalyzer, detectDivergence };
