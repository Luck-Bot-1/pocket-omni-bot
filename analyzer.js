// ============================================================
// LEGENDARY ANALYZER v6.0 – INSTITUTIONAL GRADE
// ============================================================
const technicalIndicators = require('technicalindicators');
const fs = require('fs');

// ------------------------------------------------------------------
// REAL‑TIME SWING POINTS (NO LOOK‑AHEAD)
// ------------------------------------------------------------------
function findSwingPoints(prices, period = 5, minDistance = 4) {
    const swings = { lows: [], highs: [] };
    // Only use past and present bars: a bar is a swing low if it is the minimum of the last (2*period+1) bars ending at i.
    for (let i = period; i < prices.length; i++) {
        let isLow = true, isHigh = true;
        const leftMin = Math.min(...prices.slice(Math.max(0, i - period), i + 1));
        const rightMin = Math.min(...prices.slice(i, Math.min(prices.length, i + period + 1)));
        if (prices[i] === leftMin && prices[i] === rightMin) isLow = true;
        else isLow = false;

        const leftMax = Math.max(...prices.slice(Math.max(0, i - period), i + 1));
        const rightMax = Math.max(...prices.slice(i, Math.min(prices.length, i + period + 1)));
        if (prices[i] === leftMax && prices[i] === rightMax) isHigh = true;
        else isHigh = false;

        if (isLow) swings.lows.push({ idx: i, price: prices[i] });
        if (isHigh) swings.highs.push({ idx: i, price: prices[i] });
    }
    const filter = (arr) => arr.filter((_, idx) => idx === 0 || (arr[idx].idx - arr[idx-1].idx >= minDistance));
    swings.lows = filter(swings.lows);
    swings.highs = filter(swings.highs);
    return swings;
}

// ------------------------------------------------------------------
// DIVERGENCE DETECTION (CONFIRMED + VOLUME + AGE)
// ------------------------------------------------------------------
function detectDivergence(prices, oscillator, volumes, requireConfirmation = true) {
    if (prices.length < 50 || oscillator.length < 50) return null;
    const swingsPrice = findSwingPoints(prices, 5, 4);
    const swingsOsc = findSwingPoints(oscillator, 5, 4);
    let divergence = null;
    let divergenceIdx = -1;

    // Bullish Regular
    if (swingsPrice.lows.length >= 2 && swingsOsc.lows.length >= 2) {
        const pL = swingsPrice.lows.slice(-2);
        const oL = swingsOsc.lows.slice(-2);
        if (pL[1].price < pL[0].price && oL[1].price > oL[0].price) {
            divergence = { type: 'BULLISH_REGULAR', strength: 'MODERATE', priceIdx: pL[1].idx, oscLow: oL[1].price };
            divergenceIdx = pL[1].idx;
        }
    }
    // Bearish Regular
    if (!divergence && swingsPrice.highs.length >= 2 && swingsOsc.highs.length >= 2) {
        const pH = swingsPrice.highs.slice(-2);
        const oH = swingsOsc.highs.slice(-2);
        if (pH[1].price > pH[0].price && oH[1].price < oH[0].price) {
            divergence = { type: 'BEARISH_REGULAR', strength: 'MODERATE', priceIdx: pH[1].idx, oscHigh: oH[1].price };
            divergenceIdx = pH[1].idx;
        }
    }
    // Bullish Hidden (stronger)
    if (!divergence && swingsPrice.lows.length >= 2 && swingsOsc.lows.length >= 2) {
        const pL = swingsPrice.lows.slice(-2);
        const oL = swingsOsc.lows.slice(-2);
        if (pL[1].price > pL[0].price && oL[1].price < oL[0].price) {
            divergence = { type: 'BULLISH_HIDDEN', strength: 'STRONG', priceIdx: pL[1].idx };
            divergenceIdx = pL[1].idx;
        }
    }
    // Bearish Hidden
    if (!divergence && swingsPrice.highs.length >= 2 && swingsOsc.highs.length >= 2) {
        const pH = swingsPrice.highs.slice(-2);
        const oH = swingsOsc.highs.slice(-2);
        if (pH[1].price < pH[0].price && oH[1].price > oH[0].price) {
            divergence = { type: 'BEARISH_HIDDEN', strength: 'STRONG', priceIdx: pH[1].idx };
            divergenceIdx = pH[1].idx;
        }
    }

    if (!divergence) return null;

    // RSI threshold for regular divergence
    if (divergence.type === 'BULLISH_REGULAR' && divergence.oscLow > 35) return null;
    if (divergence.type === 'BEARISH_REGULAR' && divergence.oscHigh < 65) return null;

    // Volume confirmation
    if (volumes && volumes.length > divergenceIdx) {
        const avgVolume = volumes.slice(-20).reduce((a,b)=>a+b,0)/20;
        const volConfirm = volumes[divergenceIdx] > avgVolume * 1.2;
        if (!volConfirm) divergence.strength = 'WEAK';
    }

    // Swing point age must be at least 8 bars old
    if (requireConfirmation && (prices.length - divergence.priceIdx) < 8) return null;

    // 2‑bar price confirmation after swing
    if (requireConfirmation) {
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

    // ---------- Main signal (institutional grade) ----------
    calculateProbability(candles, pair, timeframe, htCandles = null) {
        try {
            if (!candles || candles.length < 50) return this.neutral("Insufficient data");
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

            // Ultra‑low volatility filter
            if (volatility < 0.05) return this.neutral("Ultra‑low volatility – no trade");

            const atr50 = this.calculateATR(highs, lows, closes, 50);
            const atrRatio = atr / atr50;
            const isTrending = (adxData.adx >= 25 && atrRatio >= 1.0);
            const isRanging = (adxData.adx <= 22 && atrRatio <= 0.8);
            const mode = isTrending ? 'TREND' : (isRanging ? 'RANGE' : 'TRANSITION');

            // Higher timeframe processing (closed candles only)
            let htTrend = 'NEUTRAL';
            let htDivergence = null;
            let processedHtCandles = null;
            if (htCandles && htCandles.length >= 50) {
                processedHtCandles = [...htCandles];
                const lastHtTime = processedHtCandles[processedHtCandles.length-1].time;
                const now = Date.now();
                const htIntervalMs = 3600000; // 1 hour
                if (now - lastHtTime < htIntervalMs) {
                    processedHtCandles.pop(); // remove open candle
                }
                if (processedHtCandles.length >= 50) {
                    const htCloses = processedHtCandles.map(c => c.close);
                    const htEMA50 = this.calculateEMA(htCloses, 50);
                    htTrend = htCloses[htCloses.length-1] > htEMA50 ? 'BULLISH' : 'BEARISH';
                    const htRsiArray = [];
                    for (let i = 30; i <= htCloses.length; i++) {
                        htRsiArray.push(this.calculateRSI(htCloses.slice(0, i), 14));
                    }
                    htDivergence = detectDivergence(htCloses, htRsiArray, processedHtCandles.map(c=>c.volume), true);
                }
            }

            const majorTrend = price > ema200 ? 'BULLISH' : (price < ema200 ? 'BEARISH' : 'NEUTRAL');
            const hma = calculateHMA(closes, 20);
            const hmaSlope = hma.length >= 2 ? hma[hma.length-1] - hma[hma.length-2] : 0;

            const rsiArray = [];
            for (let i = 30; i <= closes.length; i++) rsiArray.push(this.calculateRSI(closes.slice(0, i), 14));
            const divergence = detectDivergence(closes, rsiArray, volumes, true);

            let signal = 'NEUTRAL';
            let rawScore = 50;
            let reason = "";

            if (mode === 'TREND') {
                if (Math.abs(hmaSlope) > 0.0003) {
                    if (hmaSlope > 0 && majorTrend === 'BULLISH') {
                        signal = 'CALL'; rawScore = 70 + Math.min(20, hmaSlope * 10000);
                        reason = "Trend: HMA up + trend aligned";
                    } else if (hmaSlope < 0 && majorTrend === 'BEARISH') {
                        signal = 'PUT'; rawScore = 70 - Math.min(20, Math.abs(hmaSlope) * 10000);
                        reason = "Trend: HMA down + trend aligned";
                    } else {
                        reason = `Trend: HMA slope (${hmaSlope.toFixed(6)}) misaligned`;
                    }
                } else if (divergence) {
                    signal = divergence.type.includes('BULLISH') ? 'CALL' : 'PUT';
                    rawScore = 70 + (divergence.strength === 'STRONG' ? 10 : 0);
                    reason = `Trend: ${divergence.type}`;
                } else {
                    reason = `Trend: HMA flat (${hmaSlope.toFixed(6)}), no divergence`;
                }
            } else if (mode === 'RANGE') {
                const last5 = closes.slice(-5);
                const noLowerLow = Math.min(...last5) === last5[last5.length-1];
                const noHigherHigh = Math.max(...last5) === last5[last5.length-1];
                if (rsi < 35 && bb.lower && price <= bb.lower && noLowerLow) {
                    signal = 'CALL'; rawScore = 70;
                    reason = "Range: oversold + BB";
                } else if (rsi > 65 && bb.upper && price >= bb.upper && noHigherHigh) {
                    signal = 'PUT'; rawScore = 70;
                    reason = "Range: overbought + BB";
                } else if (divergence) {
                    signal = divergence.type.includes('BULLISH') ? 'CALL' : 'PUT';
                    rawScore = 75 + (divergence.strength === 'STRONG' ? 10 : 0);
                    reason = `Range: ${divergence.type}`;
                } else {
                    // Fallback: volatility-adjusted
                    if (volatility > 0.3 && Math.abs(hmaSlope) > 0.0001) {
                        signal = hmaSlope > 0 ? 'CALL' : 'PUT';
                        rawScore = 60;
                        reason = "Range fallback: HMA slope";
                    } else if (rsi > 55) {
                        signal = 'CALL'; rawScore = 55;
                        reason = "Range fallback: RSI >55";
                    } else if (rsi < 45) {
                        signal = 'PUT'; rawScore = 55;
                        reason = "Range fallback: RSI <45";
                    } else {
                        reason = "Range: no signal";
                    }
                }
                // Trend penalty in range mode
                if (signal === 'CALL' && majorTrend === 'BEARISH') {
                    rawScore -= 15; reason += " - bearish trend penalty";
                } else if (signal === 'PUT' && majorTrend === 'BULLISH') {
                    rawScore -= 15; reason += " - bullish trend penalty";
                }
            } else {
                reason = `Transition mode (ADX=${adxData.adx.toFixed(1)}) – no entries`;
            }

            if (signal !== 'NEUTRAL') {
                // Multi‑timeframe alignment bonus
                if ((signal === 'CALL' && htTrend === 'BULLISH') || (signal === 'PUT' && htTrend === 'BEARISH')) {
                    rawScore += 10; reason += " + HT alignment";
                } else if ((signal === 'CALL' && htTrend === 'BEARISH') || (signal === 'PUT' && htTrend === 'BULLISH')) {
                    rawScore -= 20; reason += " - HT opposite";
                }
                // Multi‑timeframe divergence bonus
                if (divergence && htDivergence && divergence.type === htDivergence.type) {
                    rawScore += 15; reason += " + Multi‑TF divergence";
                }
            }

            rawScore = Math.min(100, Math.max(0, rawScore));
            let probability = this.calibrateProbability(rawScore);
            if (volatility < 0.15) probability = Math.min(probability, 70); // dead market cap

            if (signal === 'NEUTRAL' || probability < 45) {
                console.log(`[NEUTRAL] ${pair} ${timeframe}: ${reason} (score=${rawScore.toFixed(0)}%, prob=${probability}%)`);
                return this.neutral(reason);
            }

            console.log(`[SIGNAL] ${pair} ${timeframe}: ${signal} prob=${probability}% raw=${rawScore} reason=${reason}`);

            // ---------- RISK & SIZING (with spread model) ----------
            const baseRisk = this.getBaseRiskPercent(probability);
            const kelly = this.calculateKellyFactor();
            const targetATRpercent = 0.0025;
            const currentATRpercent = atr / price;
            if (currentATRpercent < 0.0005) return this.neutral("ATR too low");
            let volFactor = Math.min(1.5, Math.max(0.5, targetATRpercent / currentATRpercent));
            const ddFactor = this.riskMultiplier;
            let finalRisk = baseRisk * kelly * volFactor * ddFactor;
            if (mode === 'TRANSITION') finalRisk *= 0.5;
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
                version: "LEGENDARY-v6.0", guidance: reason
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
        if (signal === 'CALL' && rsi < 35) factors.push('RSI_OVERSOLD');
        if (signal === 'PUT' && rsi > 65) factors.push('RSI_OVERBOUGHT');
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
            pair: "UNKNOWN", timeframe: "UNKNOWN", version: "LEGENDARY-v6.0", guidance: reason
        };
    }
}

module.exports = { RobustAnalyzer, detectDivergence };
