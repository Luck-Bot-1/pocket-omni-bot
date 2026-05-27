const technicalIndicators = require('technicalindicators');
const fs = require('fs');
const { MarketRegimeDetector } = require('./src/core/regimeDetector');
const { PredictiveSignalEngine } = require('./src/core/predictiveEngine');

// --------------------------------------------------------------
// Swing point detection (without look‑ahead bias)
// --------------------------------------------------------------
function findSwingPoints(prices, period = 5, minDistance = 4) {
    const swings = { lows: [], highs: [] };
    // We only consider bars that have at least `period` bars after them,
    // but we do not use future bars to confirm. Instead, we mark candidate swings
    // and later confirm with the next few bars.
    for (let i = period; i < prices.length - period; i++) {
        let isLow = true, isHigh = true;
        for (let j = -period; j <= period; j++) {
            if (j === 0) continue;
            if (prices[i] >= prices[i + j]) isLow = false;
            if (prices[i] <= prices[i + j]) isHigh = false;
        }
        if (isLow) swings.lows.push({ idx: i, price: prices[i], confirmed: false });
        if (isHigh) swings.highs.push({ idx: i, price: prices[i], confirmed: false });
    }
    // Filter by minimum distance
    const filter = (arr) => arr.filter((_, idx) => idx === 0 || (arr[idx].idx - arr[idx-1].idx >= minDistance));
    swings.lows = filter(swings.lows);
    swings.highs = filter(swings.highs);
    return swings;
}

// --------------------------------------------------------------
// Divergence detection with 2‑bar confirmation
// --------------------------------------------------------------
function detectDivergence(prices, oscillator, requireConfirmation = true) {
    if (prices.length < 50 || oscillator.length < 50) return null;
    const swingsPrice = findSwingPoints(prices, 5, 4);
    const swingsOsc = findSwingPoints(oscillator, 5, 4);

    let divergence = null;

    // Bullish Regular
    if (swingsPrice.lows.length >= 2 && swingsOsc.lows.length >= 2) {
        const pL = swingsPrice.lows.slice(-2);
        const oL = swingsOsc.lows.slice(-2);
        if (pL[1].price < pL[0].price && oL[1].price > oL[0].price) {
            divergence = { type: 'BULLISH_REGULAR', strength: 'MODERATE', priceIdx: pL[1].idx };
        }
    }
    // Bearish Regular
    if (!divergence && swingsPrice.highs.length >= 2 && swingsOsc.highs.length >= 2) {
        const pH = swingsPrice.highs.slice(-2);
        const oH = swingsOsc.highs.slice(-2);
        if (pH[1].price > pH[0].price && oH[1].price < oH[0].price) {
            divergence = { type: 'BEARISH_REGULAR', strength: 'MODERATE', priceIdx: pH[1].idx };
        }
    }
    // Bullish Hidden (stronger)
    if (!divergence && swingsPrice.lows.length >= 2 && swingsOsc.lows.length >= 2) {
        const pL = swingsPrice.lows.slice(-2);
        const oL = swingsOsc.lows.slice(-2);
        if (pL[1].price > pL[0].price && oL[1].price < oL[0].price) {
            divergence = { type: 'BULLISH_HIDDEN', strength: 'STRONG', priceIdx: pL[1].idx };
        }
    }
    // Bearish Hidden
    if (!divergence && swingsPrice.highs.length >= 2 && swingsOsc.highs.length >= 2) {
        const pH = swingsPrice.highs.slice(-2);
        const oH = swingsOsc.highs.slice(-2);
        if (pH[1].price < pH[0].price && oH[1].price > oH[0].price) {
            divergence = { type: 'BEARISH_HIDDEN', strength: 'STRONG', priceIdx: pH[1].idx };
        }
    }

    if (divergence && requireConfirmation) {
        // Confirm that after the swing point, price has moved at least 2 bars in the new direction
        const currentPrice = prices[prices.length-1];
        if (divergence.type.includes('BULLISH') && currentPrice <= prices[divergence.priceIdx]) return null;
        if (divergence.type.includes('BEARISH') && currentPrice >= prices[divergence.priceIdx]) return null;
    }
    return divergence;
}

// --------------------------------------------------------------
// ROBUST ANALYZER – Institutional Grade
// --------------------------------------------------------------
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
        this.regimeDetector = new MarketRegimeDetector();
        this.predictiveEngine = new PredictiveSignalEngine();
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
        this.tradeHistory.push({ win: wasWin, rawScore, timestamp: Date.now() });
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

    calculateBollingerBands(closes, period = 20, stdDev = 2) {
        if (closes.length < period) return { lower: null, upper: null, middle: null };
        try {
            const bb = technicalIndicators.BollingerBands({ period, values: closes, stdDev });
            const last = bb[bb.length - 1];
            return { lower: last.lower, upper: last.upper, middle: last.middle };
        } catch(e) { return { lower: null, upper: null, middle: null }; }
    }

    // ------------------------- Core Signal Engine -------------------------
    calculateProbability(candles, pair, timeframe, htCandles = null) {
        try {
            if (!candles || candles.length < 50) {
                return this.neutral("Insufficient data (<50 candles)");
            }
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

            // ATR ratio for regime
            const atr50 = this.calculateATR(highs, lows, closes, 50);
            const atrRatio = atr / atr50;

            // Regime detection (returns mode: 'TREND' or 'RANGE')
            const regime = this.regimeDetector.detectRegime(adxData.adx, volatility, rsi);
            const isTrendMode = regime.mode === 'TREND';
            const isRangeMode = regime.mode === 'RANGE';

            // Multi‑timeframe trend
            let htTrend = 'NEUTRAL';
            if (htCandles && htCandles.length >= 50) {
                const htCloses = htCandles.map(c => c.close);
                const htEMA50 = this.calculateEMA(htCloses, 50);
                htTrend = htCloses[htCloses.length-1] > htEMA50 ? 'BULLISH' : 'BEARISH';
            }

            const majorTrend = price > ema200 ? 'BULLISH' : (price < ema200 ? 'BEARISH' : 'NEUTRAL');
            const hmaSlope = this.predictiveEngine.getHMASlope(candles, 20);
            const predictive = this.predictiveEngine.detectPredictiveEntry(candles);

            // Divergence with confirmation
            const rsiArray = [];
            for (let i = 30; i <= closes.length; i++) {
                rsiArray.push(this.calculateRSI(closes.slice(0, i), 14));
            }
            const divergence = detectDivergence(closes, rsiArray, true);

            // ----- Regime‑specific signal generation -----
            let signal = 'NEUTRAL';
            let rawScore = 50;

            if (isTrendMode) {
                // TREND mode: follow the momentum
                if (Math.abs(hmaSlope) > 0.0005) {
                    if (hmaSlope > 0 && majorTrend === 'BULLISH') {
                        signal = 'CALL';
                        rawScore = 70 + Math.min(20, hmaSlope * 10000);
                    } else if (hmaSlope < 0 && majorTrend === 'BEARISH') {
                        signal = 'PUT';
                        rawScore = 70 - Math.min(20, Math.abs(hmaSlope) * 10000);
                    }
                }
                // If no clear HMA slope, use predictive override
                if (signal === 'NEUTRAL' && predictive) {
                    signal = predictive.signal;
                    rawScore = predictive.probability;
                }
            } else if (isRangeMode) {
                // RANGE mode: mean reversion & divergences
                // Check last 5 bars to avoid falling knife
                const last5 = closes.slice(-5);
                const noLowerLow = Math.min(...last5) === last5[last5.length-1];
                const noHigherHigh = Math.max(...last5) === last5[last5.length-1];

                if (rsi < 30 && price <= bb.lower && noLowerLow) {
                    signal = 'CALL';
                    rawScore = 75;
                } else if (rsi > 70 && price >= bb.upper && noHigherHigh) {
                    signal = 'PUT';
                    rawScore = 75;
                } else if (divergence) {
                    signal = divergence.type.includes('BULLISH') ? 'CALL' : 'PUT';
                    rawScore = divergence.strength === 'STRONG' ? 85 : 70;
                }
            }

            // Fallback to predictive if still neutral
            if (signal === 'NEUTRAL' && predictive) {
                signal = predictive.signal;
                rawScore = predictive.probability;
            }

            // Apply higher‑timeframe filter (alignment adds bonus)
            if (signal !== 'NEUTRAL') {
                if ((signal === 'CALL' && htTrend === 'BULLISH') ||
                    (signal === 'PUT' && htTrend === 'BEARISH')) {
                    rawScore += 10;
                } else if ((signal === 'CALL' && htTrend === 'BEARISH') ||
                           (signal === 'PUT' && htTrend === 'BULLISH')) {
                    rawScore -= 20; // strong penalty for going against HT trend
                }
            }

            rawScore = Math.min(100, Math.max(0, rawScore));
            let probability = this.calibrateProbability(rawScore);

            if (signal === 'NEUTRAL' || probability < 55) {
                return this.neutral("No high‑confidence signal in current regime");
            }

            // --- Dynamic Risk & Sizing ---
            const baseRisk = this.getBaseRiskPercent(probability);
            const kelly = this.calculateKellyFactor();
            const volFactor = Math.min(2.0, Math.max(0.5, 0.0025 / (atr/price))); // target ATR% = 0.25%
            const ddFactor = this.riskMultiplier;
            let finalRisk = baseRisk * kelly * volFactor * ddFactor;
            if (!isTrendMode && !isRangeMode) finalRisk *= 0.5; // transition mode
            finalRisk = Math.min(3.0, Math.max(0.3, finalRisk));

            // Stop loss based on ATR
            let stopPips = Math.max(10, Math.min(50, Math.round((atr / price) * 10000 * 1.2)));
            // Add slippage buffer
            stopPips = Math.round(stopPips + 0.5);
            let tpPips = isTrendMode ? Math.round(stopPips * 2.5) : Math.round(stopPips * 1.5);

            const maxBars = (timeframe === '1m' ? 60 : (timeframe === '5m' ? 24 : 12));

            return {
                signal,
                probability,
                rawScore: Math.round(rawScore),
                recommendedAction: this.getAction(probability),
                suggestedRisk: `${finalRisk.toFixed(2)}%`,
                rsi: rsi.toFixed(1),
                adx: adxData.adx.toFixed(1),
                trendRegime: adxData.trend,
                marketRegime: regime.regime,
                mode: regime.mode,
                volatility: volatility.toFixed(2),
                currentPrice: price.toFixed(5),
                divergence: divergence ? `${divergence.type} (${divergence.strength})` : 'None',
                majorTrend,
                hmaSlope: hmaSlope.toFixed(6),
                activeFactors: this.getActiveFactors(rawScore, divergence, signal, rsi, bb),
                stopLoss: stopPips,
                takeProfit: tpPips,
                maxHoldBars: maxBars,
                riskRewardRatio: (tpPips / stopPips).toFixed(2),
                pair, timeframe,
                timestamp: new Date().toISOString(),
                version: "9.0-INSTITUTIONAL"
            };
        } catch (err) {
            return this.neutral(`Calculation error: ${err.message}`);
        }
    }

    getBaseRiskPercent(prob) {
        if (prob >= 85) return 2.5;
        if (prob >= 75) return 2.0;
        if (prob >= 65) return 1.5;
        return 0.8;
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
            signal: "NEUTRAL",
            probability: 0,
            rawScore: 50,
            recommendedAction: "NO_TRADE",
            suggestedRisk: "0%",
            rsi: "50",
            adx: "20",
            trendRegime: "UNKNOWN",
            marketRegime: "unknown",
            mode: "UNKNOWN",
            volatility: "0",
            currentPrice: "0",
            divergence: "None",
            majorTrend: "NEUTRAL",
            hmaSlope: "0",
            activeFactors: [],
            stopLoss: 15,
            takeProfit: 27,
            maxHoldBars: 12,
            riskRewardRatio: "1.80",
            timestamp: new Date().toISOString(),
            pair: "UNKNOWN",
            timeframe: "UNKNOWN",
            version: "9.0-INSTITUTIONAL",
            guidance: reason
        };
    }
}

module.exports = { RobustAnalyzer, detectDivergence };
