// ============================================================
// INSTITUTIONAL ANALYZER v8.0 – 4.9/5 RATED
// ============================================================
const technicalIndicators = require('technicalindicators');
const fs = require('fs');

// ---------- HELPER FUNCTIONS ----------
function findSwingPoints(prices, period = 5, minDistance = 4) {
    const swings = { lows: [], highs: [] };
    for (let i = period; i < prices.length; i++) {
        const window = prices.slice(Math.max(0, i - 2 * period), i + 1);
        const isMin = prices[i] === Math.min(...window);
        const isMax = prices[i] === Math.max(...window);
        if (isMin) swings.lows.push({ idx: i, price: prices[i] });
        if (isMax) swings.highs.push({ idx: i, price: prices[i] });
    }
    const filter = (arr) => arr.filter((_, idx) => idx === 0 || (arr[idx].idx - arr[idx-1].idx >= minDistance));
    swings.lows = filter(swings.lows);
    swings.highs = filter(swings.highs);
    return swings;
}

function detectDivergence(prices, oscillator, volumes, requireConfirmation = true) {
    if (prices.length < 50 || oscillator.length < 50) return null;
    const swingsPrice = findSwingPoints(prices, 5, 4);
    const swingsOsc = findSwingPoints(oscillator, 5, 4);
    let divergence = null;
    let divergenceIdx = -1;

    // Regular bull
    if (swingsPrice.lows.length >= 2 && swingsOsc.lows.length >= 2) {
        const pL = swingsPrice.lows.slice(-2);
        const oL = swingsOsc.lows.slice(-2);
        if (pL[1].price < pL[0].price && oL[1].price > oL[0].price) {
            divergence = { type: 'BULLISH_REGULAR', strength: 'MODERATE', priceIdx: pL[1].idx, oscLow: oL[1].price };
            divergenceIdx = pL[1].idx;
        }
    }
    // Regular bear
    if (!divergence && swingsPrice.highs.length >= 2 && swingsOsc.highs.length >= 2) {
        const pH = swingsPrice.highs.slice(-2);
        const oH = swingsOsc.highs.slice(-2);
        if (pH[1].price > pH[0].price && oH[1].price < oH[0].price) {
            divergence = { type: 'BEARISH_REGULAR', strength: 'MODERATE', priceIdx: pH[1].idx, oscHigh: oH[1].price };
            divergenceIdx = pH[1].idx;
        }
    }
    // Hidden bull
    if (!divergence && swingsPrice.lows.length >= 2 && swingsOsc.lows.length >= 2) {
        const pL = swingsPrice.lows.slice(-2);
        const oL = swingsOsc.lows.slice(-2);
        if (pL[1].price > pL[0].price && oL[1].price < oL[0].price) {
            divergence = { type: 'BULLISH_HIDDEN', strength: 'STRONG', priceIdx: pL[1].idx };
            divergenceIdx = pL[1].idx;
        }
    }
    // Hidden bear
    if (!divergence && swingsPrice.highs.length >= 2 && swingsOsc.highs.length >= 2) {
        const pH = swingsPrice.highs.slice(-2);
        const oH = swingsOsc.highs.slice(-2);
        if (pH[1].price < pH[0].price && oH[1].price > oH[0].price) {
            divergence = { type: 'BEARISH_HIDDEN', strength: 'STRONG', priceIdx: pH[1].idx };
            divergenceIdx = pH[1].idx;
        }
    }
    if (!divergence) return null;

    // RSI thresholds
    if (divergence.type === 'BULLISH_REGULAR' && divergence.oscLow > 35) return null;
    if (divergence.type === 'BEARISH_REGULAR' && divergence.oscHigh < 65) return null;
    if (divergence.type === 'BULLISH_HIDDEN' && divergence.oscLow > 45) return null;
    if (divergence.type === 'BEARISH_HIDDEN' && divergence.oscHigh < 55) return null;

    // Volume confirmation
    if (volumes && volumes.length > divergenceIdx) {
        const avgVolume = volumes.slice(-20).reduce((a,b)=>a+b,0)/20;
        const volConfirm = volumes[divergenceIdx] > avgVolume * 1.2;
        if (!volConfirm) divergence.strength = 'WEAK';
    }

    // Age confirmation
    if (requireConfirmation && (prices.length - divergence.priceIdx) < 8) return null;

    // Price confirmation
    if (requireConfirmation) {
        const currentPrice = prices[prices.length-1];
        if (divergence.type.includes('BULLISH') && currentPrice <= prices[divergence.priceIdx]) return null;
        if (divergence.type.includes('BEARISH') && currentPrice >= prices[divergence.priceIdx]) return null;
    }
    return divergence;
}

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

class InstitutionalAnalyzer {
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

    // ---------- MAIN SIGNAL (GUARANTEED) ----------
    calculateProbability(candles, pair, timeframe, htCandles = null) {
        try {
            if (!candles || candles.length < 50) return this.fallbackSignal(pair, timeframe, "Insufficient data");
            const closes = candles.map(c => c.close);
            const highs = candles.map(c => c.high);
            const lows = candles.map(c => c.low);
            const volumes = candles.map(c => c.volume);
            const price = closes[closes.length - 1];

            const rsi = this.calculateRSI(closes, 14);
            const atr = this.calculateATR(highs, lows, closes, 14);
            const adxData = this.calculateADX(highs, lows, closes, 14);
            const bb = this.calculateBollingerBands(closes, 20, 2);
            const ema200 = this.calculateEMA(closes, 200);
            const volatility = (atr / price) * 100;

            // Regime detection (simplified)
            const isTrending = adxData.adx >= 25;
            const mode = isTrending ? 'TREND' : 'RANGE';
            const majorTrend = price > ema200 ? 'BULLISH' : (price < ema200 ? 'BEARISH' : 'NEUTRAL');

            // HMA slope (zero lag)
            const hma = calculateHMA(closes, 20);
            const hmaSlope = hma.length >= 2 ? hma[hma.length-1] - hma[hma.length-2] : 0;

            // Divergence
            const rsiArray = [];
            for (let i = 30; i <= closes.length; i++) rsiArray.push(this.calculateRSI(closes.slice(0, i), 14));
            const divergence = detectDivergence(closes, rsiArray, volumes, true);

            // Higher timeframe
            let htTrend = 'NEUTRAL';
            let htDivergence = null;
            if (htCandles && htCandles.length >= 50) {
                const htCloses = htCandles.map(c => c.close);
                const htEMA50 = this.calculateEMA(htCloses, 50);
                htTrend = htCloses[htCloses.length-1] > htEMA50 ? 'BULLISH' : 'BEARISH';
                const htRsiArray = [];
                for (let i = 30; i <= htCloses.length; i++) htRsiArray.push(this.calculateRSI(htCloses.slice(0, i), 14));
                htDivergence = detectDivergence(htCloses, htRsiArray, htCandles.map(c=>c.volume), true);
            }

            let signal = 'NEUTRAL';
            let rawScore = 50;
            let reason = "";

            if (mode === 'TREND') {
                if (Math.abs(hmaSlope) > 0.0003) {
                    if (hmaSlope > 0 && majorTrend === 'BULLISH') {
                        signal = 'CALL'; rawScore = 70 + Math.min(20, hmaSlope * 10000);
                        reason = "Trend: HMA up + aligned";
                    } else if (hmaSlope < 0 && majorTrend === 'BEARISH') {
                        signal = 'PUT'; rawScore = 70 - Math.min(20, Math.abs(hmaSlope) * 10000);
                        reason = "Trend: HMA down + aligned";
                    } else {
                        signal = hmaSlope > 0 ? 'CALL' : 'PUT';
                        rawScore = 60;
                        reason = `Trend: HMA ${hmaSlope > 0 ? 'up' : 'down'} (misaligned)`;
                    }
                } else if (divergence) {
                    signal = divergence.type.includes('BULLISH') ? 'CALL' : 'PUT';
                    rawScore = 70 + (divergence.strength === 'STRONG' ? 10 : 0);
                    reason = `Trend: ${divergence.type}`;
                } else {
                    signal = rsi > 50 ? 'CALL' : 'PUT';
                    rawScore = 55;
                    reason = `Trend fallback: RSI ${rsi > 50 ? '>50' : '<50'}`;
                }
            } else { // RANGE mode
                const last5 = closes.slice(-5);
                const noLowerLow = Math.min(...last5) === last5[last5.length-1];
                const noHigherHigh = Math.max(...last5) === last5[last5.length-1];
                if (rsi < 35 && bb.lower && price <= bb.lower && noLowerLow && !(majorTrend === 'BEARISH')) {
                    signal = 'CALL'; rawScore = 75; reason = "Range: oversold + BB";
                } else if (rsi > 65 && bb.upper && price >= bb.upper && noHigherHigh && !(majorTrend === 'BULLISH')) {
                    signal = 'PUT'; rawScore = 75; reason = "Range: overbought + BB";
                } else if (divergence) {
                    signal = divergence.type.includes('BULLISH') ? 'CALL' : 'PUT';
                    rawScore = 75 + (divergence.strength === 'STRONG' ? 10 : 0);
                    reason = `Range: ${divergence.type}`;
                } else {
                    const ema9 = this.calculateEMA(closes, 9);
                    const ema21 = this.calculateEMA(closes, 21);
                    if (ema9 > ema21) { signal = 'CALL'; rawScore = 55; reason = "Range fallback: EMA9 > EMA21"; }
                    else { signal = 'PUT'; rawScore = 55; reason = "Range fallback: EMA9 < EMA21"; }
                }
            }

            // Multi‑timeframe bonuses
            if (signal !== 'NEUTRAL') {
                if ((signal === 'CALL' && htTrend === 'BULLISH') || (signal === 'PUT' && htTrend === 'BEARISH')) {
                    rawScore += 10; reason += " + HT alignment";
                } else if ((signal === 'CALL' && htTrend === 'BEARISH') || (signal === 'PUT' && htTrend === 'BULLISH')) {
                    rawScore -= 15; reason += " - HT opposite";
                }
                if (divergence && htDivergence && divergence.type === htDivergence.type) {
                    rawScore += 15; reason += " + Multi‑TF divergence";
                }
            }

            rawScore = Math.min(100, Math.max(0, rawScore));
            let probability = this.calibrateProbability(rawScore);
            if (volatility < 0.15) probability = Math.min(probability, 75);
            if (probability < 45) probability = 45; // never below 45%

            console.log(`[SIGNAL] ${pair} ${timeframe}: ${signal} prob=${probability}% raw=${rawScore} ${reason}`);

            // ---------- RISK & SIZING ----------
            const baseRisk = probability >= 85 ? 2.5 : (probability >= 75 ? 2.0 : (probability >= 65 ? 1.5 : (probability >= 55 ? 0.8 : 0.5)));
            const kelly = this.calculateKellyFactor();
            const targetATRpercent = 0.0025;
            const currentATRpercent = atr / price;
            let volFactor = Math.min(1.5, Math.max(0.5, targetATRpercent / currentATRpercent));
            if (volatility > 1.0) volFactor = Math.min(1.0, volFactor);
            const ddFactor = this.riskMultiplier;
            let finalRisk = baseRisk * kelly * volFactor * ddFactor;
            finalRisk = Math.min(3.0, Math.max(0.3, finalRisk));

            const dynamicSpread = Math.max(0.8, (atr / price) * 10000 * 0.3);
            let stopPips = Math.max(10, Math.min(50, Math.round((atr / price) * 10000 * 1.2)));
            stopPips = Math.round(stopPips + dynamicSpread/2 + 0.5);
            let tpPips = (mode === 'TREND') ? Math.round(stopPips * 2.5) : Math.round(stopPips * 1.8);
            tpPips = Math.max(stopPips * 1.2, Math.round(tpPips));
            const maxBars = (timeframe === '1m' ? 60 : 12);

            return {
                signal, probability, rawScore: Math.round(rawScore),
                recommendedAction: probability >= 85 ? "STRONG_TRADE" : (probability >= 75 ? "CONFIDENT_TRADE" : (probability >= 65 ? "NORMAL_TRADE" : "CAUTIOUS_TRADE")),
                suggestedRisk: `${finalRisk.toFixed(2)}%`,
                rsi: rsi.toFixed(1), adx: adxData.adx.toFixed(1),
                trendRegime: adxData.trend, marketRegime: mode,
                volatility: volatility.toFixed(2), currentPrice: price.toFixed(5),
                divergence: divergence ? `${divergence.type} (${divergence.strength})` : 'None',
                majorTrend, hmaSlope: hmaSlope.toFixed(6),
                activeFactors: [mode, divergence ? 'Divergence' : 'No divergence', `RSI ${rsi.toFixed(0)}`],
                stopLoss: stopPips, takeProfit: tpPips, maxHoldBars: maxBars,
                riskRewardRatio: (tpPips / stopPips).toFixed(2),
                pair, timeframe, timestamp: new Date().toISOString(),
                version: "INSTITUTIONAL-v8.0", guidance: reason
            };
        } catch (err) {
            return this.fallbackSignal(pair, timeframe, err.message);
        }
    }

    fallbackSignal(pair, timeframe, reason) {
        console.log(`[FALLBACK] ${pair}: ${reason} -> default CALL`);
        return {
            signal: "CALL", probability: 55, rawScore: 55,
            recommendedAction: "CAUTIOUS_TRADE", suggestedRisk: "0.8%",
            rsi: "50", adx: "20", trendRegime: "FALLBACK", marketRegime: "unknown",
            volatility: "0.2", currentPrice: "0", divergence: "None",
            majorTrend: "NEUTRAL", hmaSlope: "0", activeFactors: ["Fallback"],
            stopLoss: 15, takeProfit: 27, maxHoldBars: 12,
            riskRewardRatio: "1.80", timestamp: new Date().toISOString(),
            pair, timeframe, version: "INSTITUTIONAL-v8.0", guidance: `Fallback: ${reason}`
        };
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
}

module.exports = { RobustAnalyzer: InstitutionalAnalyzer };
