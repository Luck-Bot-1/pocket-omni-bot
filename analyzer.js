// ============================================================
// INSTITUTIONAL ANALYZER v10.0 – NATIVE INDICATORS (NO LIBRARY)
// ============================================================
const fs = require('fs');

class InstitutionalAnalyzer {
    constructor(initialCapital = 10000) {
        this.tradeHistory = [];
        this.calibrationFile = './calibration.json';
        this.loadCalibration();
        this.equityCurve = [initialCapital];
        this.riskMultiplier = 1;
        this.maxDrawdown = 0.15;
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

    recordTradeOutcome(wasWin, rawScore, pnlPercent = 0) {
        this.tradeHistory.push({ win: wasWin, rawScore, pnlPercent, timestamp: Date.now() });
        if (this.tradeHistory.length > 500) this.tradeHistory.shift();
        this.updateEquity(pnlPercent);
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

    // ---------- NATIVE INDICATOR IMPLEMENTATIONS ----------
    calculateEMA(data, period) {
        if (data.length < period) return data[data.length-1];
        const k = 2 / (period + 1);
        let ema = data[0];
        for (let i = 1; i < data.length; i++) {
            ema = data[i] * k + ema * (1 - k);
        }
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
        let avgGain = gains / period;
        let avgLoss = losses / period;
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
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
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
        for (let i = period; i < tr.length; i++) {
            atr = (atr * (period - 1) + tr[i]) / period;
        }
        return atr;
    }

    calculateADX(highs, lows, closes, period = 14) {
        if (highs.length < period + 2) return 20;
        const tr = [];
        const plusDM = [];
        const minusDM = [];
        for (let i = 1; i < highs.length; i++) {
            const hl = highs[i] - lows[i];
            const hc = Math.abs(highs[i] - closes[i-1]);
            const lc = Math.abs(lows[i] - closes[i-1]);
            tr.push(Math.max(hl, hc, lc));
            const up = highs[i] - highs[i-1];
            const down = lows[i-1] - lows[i];
            if (up > down && up > 0) plusDM.push(up);
            else plusDM.push(0);
            if (down > up && down > 0) minusDM.push(down);
            else minusDM.push(0);
        }
        const smooth = (values) => {
            let sum = values.slice(0, period).reduce((a,b)=>a+b,0);
            let smoothed = sum / period;
            for (let i = period; i < values.length; i++) {
                smoothed = (smoothed * (period - 1) + values[i]) / period;
            }
            return smoothed;
        };
        const atr = smooth(tr);
        const plusDI = 100 * smooth(plusDM) / atr;
        const minusDI = 100 * smooth(minusDM) / atr;
        const dx = 100 * Math.abs(plusDI - minusDI) / (plusDI + minusDI);
        let adx = 20;
        const dxArr = [];
        for (let i = 0; i < dx.length; i++) {
            if (i >= period-1) {
                const sum = dxArr.slice(-period).reduce((a,b)=>a+b,0) / period;
                adx = sum;
            }
            dxArr.push(dx[i]);
        }
        return Math.min(60, Math.max(10, adx));
    }

    calculateHMA(data, period) {
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

    // ---------- DIVERGENCE DETECTION (SIMPLIFIED) ----------
    detectDivergence(prices, oscillator) {
        if (prices.length < 30 || oscillator.length < 30) return null;
        // Find last two swing lows/highs
        const findSwingLows = (arr) => {
            const lows = [];
            for (let i = 2; i < arr.length - 2; i++) {
                if (arr[i] < arr[i-1] && arr[i] < arr[i-2] && arr[i] < arr[i+1] && arr[i] < arr[i+2]) {
                    lows.push({ idx: i, val: arr[i] });
                }
            }
            return lows;
        };
        const findSwingHighs = (arr) => {
            const highs = [];
            for (let i = 2; i < arr.length - 2; i++) {
                if (arr[i] > arr[i-1] && arr[i] > arr[i-2] && arr[i] > arr[i+1] && arr[i] > arr[i+2]) {
                    highs.push({ idx: i, val: arr[i] });
                }
            }
            return highs;
        };
        const priceLows = findSwingLows(prices);
        const oscLows = findSwingLows(oscillator);
        const priceHighs = findSwingHighs(prices);
        const oscHighs = findSwingHighs(oscillator);
        // Bullish regular divergence
        if (priceLows.length >= 2 && oscLows.length >= 2) {
            const pLast = priceLows.slice(-2);
            const oLast = oscLows.slice(-2);
            if (pLast[1].val < pLast[0].val && oLast[1].val > oLast[0].val) {
                return "BULLISH_REGULAR";
            }
        }
        // Bearish regular divergence
        if (priceHighs.length >= 2 && oscHighs.length >= 2) {
            const pLast = priceHighs.slice(-2);
            const oLast = oscHighs.slice(-2);
            if (pLast[1].val > pLast[0].val && oLast[1].val < oLast[0].val) {
                return "BEARISH_REGULAR";
            }
        }
        // Bullish hidden divergence
        if (priceLows.length >= 2 && oscLows.length >= 2) {
            const pLast = priceLows.slice(-2);
            const oLast = oscLows.slice(-2);
            if (pLast[1].val > pLast[0].val && oLast[1].val < oLast[0].val) {
                return "BULLISH_HIDDEN";
            }
        }
        // Bearish hidden divergence
        if (priceHighs.length >= 2 && oscHighs.length >= 2) {
            const pLast = priceHighs.slice(-2);
            const oLast = oscHighs.slice(-2);
            if (pLast[1].val < pLast[0].val && oLast[1].val > oLast[0].val) {
                return "BEARISH_HIDDEN";
            }
        }
        return null;
    }

    // ---------- MAIN SIGNAL ENGINE ----------
    calculateProbability(candles, pair, timeframe, htCandles = null) {
        try {
            if (!candles || candles.length < 50) {
                return this.fallbackSignal(pair, timeframe, "Insufficient data");
            }
            const closes = candles.map(c => c.close);
            const highs = candles.map(c => c.high);
            const lows = candles.map(c => c.low);
            const price = closes[closes.length - 1];

            // Core indicators (native)
            const rsi = this.calculateRSI(closes, 14);
            const atr = this.calculateATR(highs, lows, closes, 14);
            const adx = this.calculateADX(highs, lows, closes, 14);
            const ema9 = this.calculateEMA(closes, 9);
            const ema21 = this.calculateEMA(closes, 21);
            const ema50 = this.calculateEMA(closes, 50);
            const hma = this.calculateHMA(closes, 20);
            const hmaSlope = hma.length >= 2 ? hma[hma.length-1] - hma[hma.length-2] : 0;
            const volatility = (atr / price) * 100;

            // Divergence (RSI vs price)
            const divergence = this.detectDivergence(closes, this.calculateRSIArray(closes));

            // Trend direction
            const majorTrend = price > ema50 ? "BULLISH" : "BEARISH";
            const isWithTrend = false; // will set below

            // Determine signal and raw score
            let signal = 'NEUTRAL';
            let rawScore = 50;

            // Primary momentum: HMA slope
            if (Math.abs(hmaSlope) > 0.0001) {
                if (hmaSlope > 0) {
                    signal = 'CALL';
                    rawScore = 60 + Math.min(25, hmaSlope * 2000);
                } else {
                    signal = 'PUT';
                    rawScore = 60 - Math.min(25, Math.abs(hmaSlope) * 2000);
                }
            }
            // Secondary: EMA cross
            else if (ema9 > ema21) {
                signal = 'CALL';
                const strength = (ema9 - ema21) / price * 100;
                rawScore = 55 + Math.min(20, strength * 10);
            } else if (ema9 < ema21) {
                signal = 'PUT';
                const strength = (ema21 - ema9) / price * 100;
                rawScore = 55 - Math.min(20, strength * 10);
            }

            // Fallback to RSI bias
            if (signal === 'NEUTRAL') {
                if (rsi > 55) signal = 'CALL';
                else if (rsi < 45) signal = 'PUT';
                else signal = 'CALL';
                rawScore = 55;
            }

            // Adjust for ADX trend strength
            if (adx > 30) rawScore += 8;
            else if (adx > 25) rawScore += 4;
            else if (adx < 20) rawScore -= 4;

            // Adjust for RSI extremes
            if (signal === 'CALL' && rsi < 30) rawScore += 12;
            if (signal === 'PUT' && rsi > 70) rawScore += 12;
            if (signal === 'CALL' && rsi > 70) rawScore -= 10;
            if (signal === 'PUT' && rsi < 30) rawScore -= 10;

            // Divergence adjustment
            if (divergence) {
                if ((signal === 'CALL' && divergence.includes('BULLISH')) ||
                    (signal === 'PUT' && divergence.includes('BEARISH'))) {
                    rawScore += 15;
                } else {
                    rawScore -= 10;
                }
            }

            // Higher timeframe alignment
            let htTrend = 'NEUTRAL';
            if (htCandles && htCandles.length >= 50) {
                const htCloses = htCandles.map(c => c.close);
                const htEMA50 = this.calculateEMA(htCloses, 50);
                htTrend = htCloses[htCloses.length-1] > htEMA50 ? 'BULLISH' : 'BEARISH';
                if ((signal === 'CALL' && htTrend === 'BULLISH') ||
                    (signal === 'PUT' && htTrend === 'BEARISH')) {
                    rawScore += 10;
                } else if ((signal === 'CALL' && htTrend === 'BEARISH') ||
                           (signal === 'PUT' && htTrend === 'BULLISH')) {
                    rawScore -= 15;
                }
            }

            // Clamp rawScore and compute probability (45% – 85%)
            rawScore = Math.min(100, Math.max(0, rawScore));
            let probability = Math.round(50 + rawScore * 0.35);
            probability = Math.min(85, Math.max(45, probability));

            // Reduce in dead markets
            if (volatility < 0.1) probability = Math.max(45, probability - 8);

            // Determine if signal is with or against major trend
            const withTrend = (signal === 'CALL' && majorTrend === 'BULLISH') ||
                              (signal === 'PUT' && majorTrend === 'BEARISH');

            console.log(`[SIGNAL] ${pair} ${timeframe}: ${signal} prob=${probability}% raw=${rawScore} ADX=${adx.toFixed(0)} RSI=${rsi.toFixed(0)} Div=${divergence || 'none'} WithTrend=${withTrend}`);

            // Risk & position sizing
            const baseRisk = probability >= 75 ? 2.0 : (probability >= 65 ? 1.5 : (probability >= 55 ? 1.0 : 0.8));
            const kelly = this.calculateKellyFactor();
            const volFactor = Math.min(1.5, Math.max(0.5, 0.0025 / (atr/price)));
            const ddFactor = this.riskMultiplier;
            let finalRisk = baseRisk * kelly * volFactor * ddFactor;
            finalRisk = Math.min(3.0, Math.max(0.3, finalRisk));

            let stopPips = Math.max(10, Math.min(50, Math.round((atr / price) * 10000 * 1.2)));
            let tpPips = Math.round(stopPips * 1.8);
            const maxBars = (timeframe === '1m' ? 60 : 12);

            return {
                signal, probability, rawScore: Math.round(rawScore),
                recommendedAction: probability >= 75 ? "CONFIDENT_TRADE" : (probability >= 65 ? "NORMAL_TRADE" : "CAUTIOUS_TRADE"),
                suggestedRisk: `${finalRisk.toFixed(2)}%`,
                rsi: rsi.toFixed(1),
                adx: adx.toFixed(1),
                trendRegime: adx >= 25 ? "TRENDING" : "RANGING",
                marketRegime: adx >= 25 ? "TREND" : "RANGE",
                volatility: volatility.toFixed(2),
                currentPrice: price.toFixed(5),
                divergence: divergence ? divergence : "None",
                majorTrend: majorTrend,
                hmaSlope: hmaSlope.toFixed(6),
                activeFactors: [
                    `HMA slope: ${hmaSlope.toFixed(6)}`,
                    `EMA9/21: ${ema9 > ema21 ? 'CALL' : 'PUT'}`,
                    `RSI: ${rsi.toFixed(0)}`,
                    divergence ? `Divergence: ${divergence}` : '',
                    withTrend ? '✅ With trend' : '⚠️ Against trend'
                ].filter(f => f),
                stopLoss: stopPips, takeProfit: tpPips, maxHoldBars: maxBars,
                riskRewardRatio: (tpPips / stopPips).toFixed(2),
                pair, timeframe, timestamp: new Date().toISOString(),
                version: "INSTITUTIONAL-v10.0",
                guidance: `${signal} signal generated (${withTrend ? 'with' : 'against'} major trend)`
            };
        } catch (err) {
            console.error(`[ERROR] ${pair}: ${err.message}`);
            return this.fallbackSignal(pair, timeframe, err.message);
        }
    }

    calculateRSIArray(closes) {
        const rsiValues = [];
        for (let i = 30; i <= closes.length; i++) {
            rsiValues.push(this.calculateRSI(closes.slice(0, i), 14));
        }
        return rsiValues;
    }

    fallbackSignal(pair, timeframe, reason) {
        console.log(`[FALLBACK] ${pair}: ${reason} -> default CALL`);
        return {
            signal: "CALL", probability: 55, rawScore: 55,
            recommendedAction: "CAUTIOUS_TRADE", suggestedRisk: "0.8%",
            rsi: "50", adx: "20", trendRegime: "UNKNOWN", marketRegime: "unknown",
            volatility: "0.2", currentPrice: "0", divergence: "None",
            majorTrend: "NEUTRAL", hmaSlope: "0", activeFactors: ["Fallback"],
            stopLoss: 15, takeProfit: 27, maxHoldBars: 12,
            riskRewardRatio: "1.80", timestamp: new Date().toISOString(),
            pair, timeframe, version: "INSTITUTIONAL-v10.0", guidance: `Fallback: ${reason}`
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
