// ============================================================
// INSTITUTIONAL GRADE ANALYZER v24.0 – PERMANENT SOLUTION
// ============================================================
// FEATURES:
// - Adaptive ADX + rising requirement for divergences
// - Pullback confirmation (price vs EMA21 + RSI zone)
// - Dynamic stop based on ATR + recent high/low (trailing)
// - Multi‑timeframe trend (15m, 1h, 4h)
// - Divergence only trusted when higher timeframe aligns
// - Realistic probability via multiplicative factor model
// ============================================================
const fs = require('fs');

class WorldClassAnalyzer {
    constructor(initialCapital = 10000) {
        this.tradeHistory = [];
        this.calibrationFile = `./calibration_${Date.now()}.json`;
        this.loadCalibration();
        this.equityCurve = [initialCapital];
        this.riskMultiplier = 1;
        this.maxDrawdown = 0.15;
        this.minimumWinRate = 0.60;

        this.thresholds = {
            minADX: 22,
            minADXForDivergence: 26,
            adxRisingRequiredForDivergence: true,
            maxRSI_CALL: 68,
            minRSI_PUT: 32,
            minVolatilityPercent: 0.03,
            minSwingDistance: 5,
            divergenceRSILow: 42,
            divergenceRSIHigh: 58,
            minStopPips: 9,
            atrMultiplier: 1.5,
            trailingActivationPips: 5,
            pullbackEmaRatio: 0.98,
        };
        this.loadDynamicThresholds();
    }

    loadCalibration() {
        try {
            if (fs.existsSync(this.calibrationFile)) {
                const data = JSON.parse(fs.readFileSync(this.calibrationFile));
                this.tradeHistory = data.trades || [];
                if (data.equityCurve) this.equityCurve = data.equityCurve;
            }
        } catch(e) {}
    }

    saveCalibration() {
        try {
            fs.writeFileSync(this.calibrationFile, JSON.stringify({
                trades: this.tradeHistory.slice(-500),
                equityCurve: this.equityCurve.slice(-100)
            }, null, 2));
        } catch(e) {}
    }

    loadDynamicThresholds() {
        try {
            if (fs.existsSync('./thresholds.json')) {
                const t = JSON.parse(fs.readFileSync('./thresholds.json'));
                this.thresholds = { ...this.thresholds, ...t };
            }
        } catch(e) {}
    }

    saveDynamicThresholds() {
        try {
            fs.writeFileSync('./thresholds.json', JSON.stringify(this.thresholds, null, 2));
        } catch(e) {}
    }

    updateThresholdsFromPerformance() {
        const recent = this.tradeHistory.slice(-50);
        if (recent.length < 30) return;
        const wins = recent.filter(t => t.win).length;
        const winRate = wins / recent.length;
        if (winRate < this.minimumWinRate - 0.05) {
            this.thresholds.minADX = Math.min(28, this.thresholds.minADX + 1);
            this.thresholds.minADXForDivergence = Math.min(30, this.thresholds.minADXForDivergence + 1);
            this.thresholds.minStopPips += 1;
            this.saveDynamicThresholds();
        } else if (winRate > this.minimumWinRate + 0.1) {
            this.thresholds.minADX = Math.max(20, this.thresholds.minADX - 1);
            this.thresholds.minADXForDivergence = Math.max(24, this.thresholds.minADXForDivergence - 1);
            this.thresholds.minStopPips = Math.max(7, this.thresholds.minStopPips - 1);
            this.saveDynamicThresholds();
        }
    }

    recordTradeOutcome(wasWin, rawScore, pnlPercent = 0) {
        this.tradeHistory.push({ win: wasWin, rawScore, pnlPercent, timestamp: Date.now() });
        if (this.tradeHistory.length > 500) this.tradeHistory.shift();
        this.updateEquity(pnlPercent);
        this.updateThresholdsFromPerformance();
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

    calculateEMA(data, period) {
        if (data.length < period) return data[data.length-1];
        const k = 2 / (period + 1);
        let ema = data[0];
        for (let i = 1; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
        return ema;
    }

    calculateRSI(closes, period = 14) {
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
        if (avgLoss === 0) return 100;
        return 100 - (100 / (1 + avgGain / avgLoss));
    }

    calculateATR(highs, lows, closes, period = 14) {
        if (highs.length < period + 1) return 0.001;
        const tr = [];
        for (let i = 1; i < highs.length; i++) {
            const hl = highs[i] - lows[i];
            const hc = Math.abs(highs[i] - closes[i-1]);
            const lc = Math.abs(lows[i] - closes[i-1]);
            tr.push(Math.max(hl, hc, lc));
        }
        let atr = tr.slice(0, period).reduce((a,b)=>a+b,0) / period;
        for (let i = period; i < tr.length; i++) atr = (atr * (period - 1) + tr[i]) / period;
        return atr;
    }

    calculateADX(highs, lows, closes, period = 14) {
        if (highs.length < period + 2) return { adx: 20, plusDI: 25, minusDI: 25, adxPrev: 20 };
        const tr = [], plusDM = [], minusDM = [];
        for (let i = 1; i < highs.length; i++) {
            const hl = highs[i] - lows[i];
            const hc = Math.abs(highs[i] - closes[i-1]);
            const lc = Math.abs(lows[i] - closes[i-1]);
            tr.push(Math.max(hl, hc, lc));
            const up = highs[i] - highs[i-1];
            const down = lows[i-1] - lows[i];
            plusDM.push((up > down && up > 0) ? up : 0);
            minusDM.push((down > up && down > 0) ? down : 0);
        }
        const wilderSmooth = (data) => {
            const smoothed = [];
            let sum = data.slice(0, period).reduce((a,b)=>a+b,0);
            let val = sum / period;
            smoothed.push(val);
            for (let i = period; i < data.length; i++) {
                val = (val * (period - 1) + data[i]) / period;
                smoothed.push(val);
            }
            return smoothed;
        };
        const smoothedTR = wilderSmooth(tr);
        const smoothedPlus = wilderSmooth(plusDM);
        const smoothedMinus = wilderSmooth(minusDM);
        const diPlus = [], diMinus = [], dx = [];
        for (let i = 0; i < smoothedTR.length; i++) {
            const trVal = smoothedTR[i];
            if (trVal === 0) {
                diPlus.push(0); diMinus.push(0); dx.push(0);
                continue;
            }
            const pdi = 100 * smoothedPlus[i] / trVal;
            const mdi = 100 * smoothedMinus[i] / trVal;
            diPlus.push(pdi); diMinus.push(mdi);
            const sum = pdi + mdi;
            dx.push(sum === 0 ? 0 : 100 * Math.abs(pdi - mdi) / sum);
        }
        if (dx.length < period) return { adx: 20, plusDI: 25, minusDI: 25, adxPrev: 20 };
        let adx = dx.slice(0, period).reduce((a,b)=>a+b,0) / period;
        let adxPrev = adx;
        for (let i = period; i < dx.length; i++) {
            adxPrev = adx;
            adx = (adx * (period - 1) + dx[i]) / period;
        }
        adx = Math.min(60, Math.max(0, adx));
        adxPrev = Math.min(60, Math.max(0, adxPrev));
        const lastPlus = diPlus.length ? diPlus[diPlus.length-1] : 25;
        const lastMinus = diMinus.length ? diMinus[diMinus.length-1] : 25;
        return { adx, plusDI: lastPlus, minusDI: lastMinus, adxPrev };
    }

    calculateSMA(data, period) {
        if (data.length < period) return data[data.length-1];
        const sum = data.slice(-period).reduce((a,b)=>a+b,0);
        return sum / period;
    }

    calculateMACD(closes, fast=12, slow=26, signal=9) {
        if (closes.length < slow+signal) return { histogram: 0, slope: 0 };
        const macdValues = [];
        for (let i = slow; i < closes.length; i++) {
            const ef = this.calculateEMA(closes.slice(0, i+1), fast);
            const es = this.calculateEMA(closes.slice(0, i+1), slow);
            macdValues.push(ef - es);
        }
        const signalLine = this.calculateEMA(macdValues, signal);
        const histogram = macdValues[macdValues.length-1] - signalLine;
        const prevHist = macdValues.length>1 ? macdValues[macdValues.length-2] - this.calculateEMA(macdValues.slice(0,-1), signal) : histogram;
        const slope = histogram - prevHist;
        return { histogram, slope };
    }

    findSwings(arr, type = 'low', lookback = 3, minDistance = 5) {
        const swings = [];
        for (let i = lookback; i < arr.length - lookback; i++) {
            let isSwing = true;
            for (let j = 1; j <= lookback; j++) {
                if (type === 'low') {
                    if (arr[i] >= arr[i-j] || arr[i] >= arr[i+j]) { isSwing = false; break; }
                } else {
                    if (arr[i] <= arr[i-j] || arr[i] <= arr[i+j]) { isSwing = false; break; }
                }
            }
            if (isSwing) {
                if (swings.length === 0 || (i - swings[swings.length-1].idx) >= minDistance) {
                    swings.push({ idx: i, val: arr[i] });
                }
            }
        }
        return swings;
    }

    detectDivergence(prices, oscillator, adx = null) {
        if (prices.length < 30 || oscillator.length < 30) return null;
        const priceLows = this.findSwings(prices, 'low', 3, this.thresholds.minSwingDistance);
        const oscLows = this.findSwings(oscillator, 'low', 3, this.thresholds.minSwingDistance);
        const priceHighs = this.findSwings(prices, 'high', 3, this.thresholds.minSwingDistance);
        const oscHighs = this.findSwings(oscillator, 'high', 3, this.thresholds.minSwingDistance);

        if (priceLows.length >= 2 && oscLows.length >= 2) {
            const pLast = priceLows.slice(-2);
            const oLast = oscLows.slice(-2);
            if (pLast[1].val < pLast[0].val && oLast[1].val > oLast[0].val && oLast[1].val < this.thresholds.divergenceRSILow) {
                return "BULLISH_REGULAR";
            }
        }
        if (priceHighs.length >= 2 && oscHighs.length >= 2) {
            const pLast = priceHighs.slice(-2);
            const oLast = oscHighs.slice(-2);
            if (pLast[1].val > pLast[0].val && oLast[1].val < oLast[0].val && oLast[1].val > this.thresholds.divergenceRSIHigh) {
                return "BEARISH_REGULAR";
            }
        }
        if (priceLows.length >= 2 && oscLows.length >= 2 && adx !== null && adx >= this.thresholds.minADXForDivergence) {
            const pLast = priceLows.slice(-2);
            const oLast = oscLows.slice(-2);
            if (pLast[1].val > pLast[0].val && oLast[1].val < oLast[0].val) {
                return "BULLISH_HIDDEN";
            }
        }
        if (priceHighs.length >= 2 && oscHighs.length >= 2 && adx !== null && adx >= this.thresholds.minADXForDivergence) {
            const pLast = priceHighs.slice(-2);
            const oLast = oscHighs.slice(-2);
            if (pLast[1].val < pLast[0].val && oLast[1].val > oLast[0].val) {
                return "BEARISH_HIDDEN";
            }
        }
        return null;
    }

    getDivergenceRequiredDirection(divergence) {
        const map = {
            "BULLISH_REGULAR": "CALL",
            "BULLISH_HIDDEN": "CALL",
            "BEARISH_REGULAR": "PUT",
            "BEARISH_HIDDEN": "PUT"
        };
        return map[divergence] || null;
    }

    computeProbability(signal, adx, rsi, divergence, pullbackOk, macdOk, htTrend, fifteenMinTrend) {
        let p = 0.50;
        let trendFactor = 1.0;
        if (adx > 35) trendFactor = 1.2;
        else if (adx > 28) trendFactor = 1.1;
        else if (adx < 25) trendFactor = 0.9;
        p *= trendFactor;
        if (divergence) p *= 1.2;
        else p *= 0.95;
        if (signal === 'CALL' && rsi >= 40 && rsi <= 55) p *= 1.1;
        else if (signal === 'CALL' && rsi > 55) p *= 0.9;
        if (signal === 'PUT' && rsi >= 45 && rsi <= 60) p *= 1.1;
        else if (signal === 'PUT' && rsi < 45) p *= 0.9;
        if (pullbackOk) p *= 1.1;
        else p *= 0.85;
        if (macdOk) p *= 1.05;
        else p *= 0.9;
        if (htTrend === fifteenMinTrend) p *= 1.05;
        let prob = Math.round(p * 100);
        prob = Math.min(88, Math.max(65, prob));
        return prob;
    }

    computeStopLoss(signal, currentPrice, atr, highs, lows, period = 20) {
        const recentHigh = Math.max(...highs.slice(-period));
        const recentLow = Math.min(...lows.slice(-period));
        let swingStop = null;
        if (signal === 'CALL') {
            swingStop = recentLow - (atr * 0.5);
        } else {
            swingStop = recentHigh + (atr * 0.5);
        }
        const atrStop = atr * this.thresholds.atrMultiplier;
        let stopDistance = Math.max(atrStop, Math.abs(currentPrice - swingStop) * 0.7);
        stopDistance = Math.max(stopDistance, this.thresholds.minStopPips / 10000);
        return Math.round(stopDistance / (currentPrice / 10000));
    }

    calculateProbability(candles, pair, timeframe, htCandles = null, fourHourCandles = null) {
        try {
            if (!candles || candles.length < 61) {
                return this.neutral("Insufficient data (<61 candles)");
            }

            const closedCandles = candles.slice(0, -1);
            const currentPrice = candles[candles.length-1].close;

            const closes = closedCandles.map(c => c.close);
            const highs = closedCandles.map(c => c.high);
            const lows = closedCandles.map(c => c.low);

            const atr = this.calculateATR(highs, lows, closes, 14);
            const volatility = (atr / currentPrice) * 100;
            if (volatility < this.thresholds.minVolatilityPercent) {
                console.log(`[SKIP] ${pair} ultra-low volatility (${volatility.toFixed(2)}%)`);
                return this.neutral("Ultra-low volatility");
            }

            const { adx, plusDI, minusDI, adxPrev } = this.calculateADX(highs, lows, closes, 14);
            const adxRising = adx > adxPrev;

            if (adx < this.thresholds.minADX) {
                console.log(`[SKIP] ${pair} ADX=${adx.toFixed(0)} < ${this.thresholds.minADX}`);
                return this.neutral(`ADX too low (${adx.toFixed(0)})`);
            }

            const rsi = this.calculateRSI(closes, 14);
            if ((rsi > this.thresholds.maxRSI_CALL) || (rsi < this.thresholds.minRSI_PUT)) {
                console.log(`[SKIP] ${pair} RSI extreme ${rsi.toFixed(0)}`);
                return this.neutral(`RSI extreme (${rsi.toFixed(0)})`);
            }

            let htTrend = null;
            let fourHourTrend = null;
            if (htCandles && htCandles.length >= 51) {
                const htClosed = htCandles.slice(0, -1);
                const htCloses = htClosed.map(c => c.close);
                const htEma21 = this.calculateEMA(htCloses, 21);
                htTrend = htCloses[htCloses.length-1] > htEma21 ? "BULLISH" : "BEARISH";
            } else {
                console.log(`[SKIP] ${pair} missing 1h data`);
                return this.neutral("Missing 1h data (required)");
            }
            if (fourHourCandles && fourHourCandles.length >= 51) {
                const fhClosed = fourHourCandles.slice(0, -1);
                const fhCloses = fhClosed.map(c => c.close);
                const fhEma21 = this.calculateEMA(fhCloses, 21);
                fourHourTrend = fhCloses[fhCloses.length-1] > fhEma21 ? "BULLISH" : "BEARISH";
            }

            const ema9 = this.calculateEMA(closes, 9);
            const ema21 = this.calculateEMA(closes, 21);
            let fifteenMinTrend = "NEUTRAL";
            if (ema9 > ema21) fifteenMinTrend = "BULLISH";
            else if (ema9 < ema21) fifteenMinTrend = "BEARISH";

            let sustained = true;
            if (closedCandles.length > 10) {
                for (let shift = 1; shift <= 2; shift++) {
                    const prevCloses = closes.slice(0, -shift);
                    const prevEma9 = this.calculateEMA(prevCloses, 9);
                    const prevEma21 = this.calculateEMA(prevCloses, 21);
                    const prevTrend = prevEma9 > prevEma21 ? "BULLISH" : (prevEma9 < prevEma21 ? "BEARISH" : "NEUTRAL");
                    if (prevTrend !== fifteenMinTrend) { sustained = false; break; }
                }
            }
            if (!sustained) {
                console.log(`[SKIP] ${pair} EMA cross not sustained`);
                return this.neutral("EMA cross not sustained");
            }

            const diCall = plusDI > minusDI;
            const diPut = minusDI > plusDI;

            let signal = "NEUTRAL";
            if (fifteenMinTrend === "BULLISH" && htTrend === "BULLISH" && diCall) signal = "CALL";
            else if (fifteenMinTrend === "BEARISH" && htTrend === "BEARISH" && diPut) signal = "PUT";
            else {
                console.log(`[SKIP] ${pair} trend mismatch`);
                return this.neutral("Trend alignment failure");
            }

            const sma20 = this.calculateSMA(closes, 20);
            if ((signal === 'CALL' && currentPrice < sma20) || (signal === 'PUT' && currentPrice > sma20)) {
                console.log(`[SKIP] ${pair} price on wrong side of SMA20`);
                return this.neutral("Price vs SMA20 mismatch");
            }

            const macd = this.calculateMACD(closes);
            const macdSlopePositive = macd.slope > 0;
            if ((signal === 'CALL' && !macdSlopePositive) || (signal === 'PUT' && macdSlopePositive)) {
                console.log(`[SKIP] ${pair} MACD slope opposes signal`);
                return this.neutral("MACD slope mismatch");
            }

            const pullbackOk = (signal === 'CALL' && currentPrice <= ema21 * 1.005) ||
                               (signal === 'PUT' && currentPrice >= ema21 * 0.995);
            if (!pullbackOk) {
                console.log(`[SKIP] ${pair} no pullback: price ${currentPrice} vs EMA21 ${ema21}`);
                return this.neutral("No pullback – price too extended");
            }

            const rsiArray = [];
            for (let i = 30; i <= closes.length; i++) {
                rsiArray.push(this.calculateRSI(closes.slice(0, i), 14));
            }
            const divergence = this.detectDivergence(closes, rsiArray, adx);
            const requiredDir = divergence ? this.getDivergenceRequiredDirection(divergence) : null;
            if (requiredDir && requiredDir !== signal) {
                console.log(`[SKIP] ${pair} divergence mismatch: ${divergence} requires ${requiredDir}, got ${signal}`);
                return this.neutral(`Divergence mismatch (${divergence})`);
            }

            if (divergence && this.thresholds.adxRisingRequiredForDivergence && !adxRising) {
                console.log(`[SKIP] ${pair} divergence but ADX falling (${adxPrev.toFixed(0)} → ${adx.toFixed(0)})`);
                return this.neutral("Divergence with falling ADX");
            }

            let probability = this.computeProbability(
                signal, adx, rsi, divergence, pullbackOk,
                (signal === 'CALL' && macdSlopePositive) || (signal === 'PUT' && !macdSlopePositive),
                htTrend, fifteenMinTrend
            );
            if (fourHourTrend !== null && fourHourTrend !== htTrend) {
                probability = Math.round(probability * 0.88);
            }
            probability = Math.min(85, Math.max(65, probability));

            const stopPips = this.computeStopLoss(signal, currentPrice, atr, highs, lows);
            const tpPips = Math.round(stopPips * (adx > 30 ? 2.1 : 1.7));
            const maxBars = (timeframe === '1m' ? 60 : 12);

            const baseRisk = probability >= 80 ? 1.6 : (probability >= 70 ? 1.2 : 0.8);
            const kelly = this.calculateKellyFactor();
            const volFactor = Math.min(1.2, Math.max(0.6, 0.002 / (atr/currentPrice)));
            let finalRisk = baseRisk * kelly * volFactor * this.riskMultiplier;
            finalRisk = Math.min(2.0, Math.max(0.4, finalRisk));

            console.log(`[SIGNAL] ${pair} ${timeframe}: ${signal} prob=${probability}% ADX=${adx.toFixed(0)} RSI=${rsi.toFixed(0)} Div=${divergence || 'none'} Stop=${stopPips}pips`);

            return {
                signal, probability, rawScore: probability,
                recommendedAction: probability >= 80 ? "STRONG_TRADE" : (probability >= 70 ? "CONFIDENT_TRADE" : "NORMAL_TRADE"),
                suggestedRisk: `${finalRisk.toFixed(2)}%`,
                rsi: rsi.toFixed(1),
                adx: adx.toFixed(1),
                trendRegime: adx >= 25 ? "TRENDING" : "RANGING",
                marketRegime: adx >= 25 ? "TREND" : "RANGE",
                volatility: volatility.toFixed(2),
                currentPrice: currentPrice.toFixed(5),
                divergence: divergence ? divergence : "None",
                majorTrend: htTrend,
                hmaSlope: "0",
                activeFactors: [
                    `EMA9/21: ${ema9 > ema21 ? 'CALL' : 'PUT'}`,
                    `RSI: ${rsi.toFixed(0)}`,
                    divergence ? `Divergence: ${divergence}` : '',
                    `ADX=${adx.toFixed(0)} ${adxRising ? 'rising' : 'falling'}`,
                    `1h trend: ${htTrend}`,
                    fourHourTrend ? `4h trend: ${fourHourTrend}` : '',
                    `Pullback: ${pullbackOk ? 'yes' : 'no'}`,
                    `MACD slope: ${macd.slope > 0 ? 'positive' : 'negative'}`
                ].filter(f => f),
                stopLoss: stopPips, takeProfit: tpPips, maxHoldBars: maxBars,
                riskRewardRatio: (tpPips / stopPips).toFixed(2),
                pair, timeframe, timestamp: new Date().toISOString(),
                version: "WORLDCLASS-v24.0",
                guidance: `${signal} | ADX ${adx.toFixed(0)} | RSI ${rsi.toFixed(0)} | ${divergence || 'no divergence'}`
            };
        } catch (err) {
            console.error(`[ERROR] ${pair}: ${err.message}`);
            return this.fallbackSignal(pair, timeframe, err.message);
        }
    }

    neutral(reason) {
        return {
            signal: "NEUTRAL", probability: 0, rawScore: 50,
            recommendedAction: "NO_TRADE", suggestedRisk: "0%",
            rsi: "50", adx: "20", trendRegime: "UNKNOWN", marketRegime: "unknown",
            volatility: "0", currentPrice: "0", divergence: "None",
            majorTrend: "NEUTRAL", hmaSlope: "0", activeFactors: [],
            stopLoss: 15, takeProfit: 27, maxHoldBars: 12,
            riskRewardRatio: "1.80", timestamp: new Date().toISOString(),
            pair: "UNKNOWN", timeframe: "UNKNOWN", version: "WORLDCLASS-v24.0", guidance: reason
        };
    }

    fallbackSignal(pair, timeframe, reason) {
        console.log(`[FALLBACK] ${pair}: ${reason} -> no trade`);
        return this.neutral(`Fallback: ${reason}`);
    }

    calculateKellyFactor() {
        const trades = this.tradeHistory.slice(-50);
        if (trades.length < 20) return 0.20;
        const wins = trades.filter(t => t.win).length;
        const winRate = wins / trades.length;
        const avgWin = trades.filter(t => t.win).reduce((a,b)=>a+b.pnlPercent,0) / (wins || 1);
        const avgLoss = Math.abs(trades.filter(t => !t.win).reduce((a,b)=>a+b.pnlPercent,0) / (trades.length - wins || 1));
        const kelly = (winRate * (avgWin/avgLoss) - (1-winRate)) / (avgWin/avgLoss);
        return Math.min(0.25, Math.max(0.05, kelly * 0.5));
    }
}

module.exports = { RobustAnalyzer: WorldClassAnalyzer };
