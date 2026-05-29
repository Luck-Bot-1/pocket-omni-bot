// ============================================================
// WORLD‑CLASS ANALYZER v13.0 – INSTITUTIONAL QUALITY
// ============================================================
const fs = require('fs');

class WorldClassAnalyzer {
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

    // ---------- NATIVE INDICATORS (FAST & RELIABLE) ----------
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
        if (highs.length < period + 2) return 20;
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
        if (dx.length < period) return 20;
        let adx = dx.slice(0, period).reduce((a,b)=>a+b,0) / period;
        for (let i = period; i < dx.length; i++) adx = (adx * (period - 1) + dx[i]) / period;
        return Math.min(60, Math.max(0, adx));
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
            hma.push(wma([raw], sqrt));
        }
        return hma;
    }

    // ---------- ENHANCED DIVERGENCE (WITH RSI THRESHOLDS) ----------
    detectDivergence(prices, oscillator) {
        if (prices.length < 30 || oscillator.length < 30) return null;
        const findSwingLows = (arr) => {
            const lows = [];
            for (let i = 2; i < arr.length - 2; i++) {
                if (arr[i] < arr[i-1] && arr[i] < arr[i-2] && arr[i] < arr[i+1] && arr[i] < arr[i+2])
                    lows.push({ idx: i, val: arr[i] });
            }
            return lows;
        };
        const findSwingHighs = (arr) => {
            const highs = [];
            for (let i = 2; i < arr.length - 2; i++) {
                if (arr[i] > arr[i-1] && arr[i] > arr[i-2] && arr[i] > arr[i+1] && arr[i] > arr[i+2])
                    highs.push({ idx: i, val: arr[i] });
            }
            return highs;
        };
        const priceLows = findSwingLows(prices);
        const oscLows = findSwingLows(oscillator);
        const priceHighs = findSwingHighs(prices);
        const oscHighs = findSwingHighs(oscillator);
        // Bullish regular (price lower low, oscillator higher low) + RSI < 45 at the swing
        if (priceLows.length >= 2 && oscLows.length >= 2) {
            const pLast = priceLows.slice(-2);
            const oLast = oscLows.slice(-2);
            if (pLast[1].val < pLast[0].val && oLast[1].val > oLast[0].val && oLast[1].val < 45)
                return "BULLISH_REGULAR";
        }
        // Bearish regular (price higher high, oscillator lower high) + RSI > 55 at the swing
        if (priceHighs.length >= 2 && oscHighs.length >= 2) {
            const pLast = priceHighs.slice(-2);
            const oLast = oscHighs.slice(-2);
            if (pLast[1].val > pLast[0].val && oLast[1].val < oLast[0].val && oLast[1].val > 55)
                return "BEARISH_REGULAR";
        }
        // Hidden divergences (stronger) – no RSI threshold needed
        if (priceLows.length >= 2 && oscLows.length >= 2) {
            const pLast = priceLows.slice(-2);
            const oLast = oscLows.slice(-2);
            if (pLast[1].val > pLast[0].val && oLast[1].val < oLast[0].val)
                return "BULLISH_HIDDEN";
        }
        if (priceHighs.length >= 2 && oscHighs.length >= 2) {
            const pLast = priceHighs.slice(-2);
            const oLast = oscHighs.slice(-2);
            if (pLast[1].val < pLast[0].val && oLast[1].val > oLast[0].val)
                return "BEARISH_HIDDEN";
        }
        return null;
    }

    // ---------- MAIN SIGNAL ENGINE (WORLD-CLASS) ----------
    calculateProbability(candles, pair, timeframe, htCandles = null) {
        try {
            if (!candles || candles.length < 50) {
                return this.fallbackSignal(pair, timeframe, "Insufficient data");
            }
            const closes = candles.map(c => c.close);
            const highs = candles.map(c => c.high);
            const lows = candles.map(c => c.low);
            const price = closes[closes.length - 1];

            const rsi = this.calculateRSI(closes, 14);
            const atr = this.calculateATR(highs, lows, closes, 14);
            const adx = this.calculateADX(highs, lows, closes, 14);
            const ema9 = this.calculateEMA(closes, 9);
            const ema21 = this.calculateEMA(closes, 21);
            const ema50 = this.calculateEMA(closes, 50);
            const hma = this.calculateHMA(closes, 20);
            const hmaSlope = hma.length >= 2 ? hma[hma.length-1] - hma[hma.length-2] : 0;
            const volatility = (atr / price) * 100;

            // ----- QUALITY FILTERS (WORLD-CLASS) -----
            // 1. Dead market: ultra-low volatility -> no trade
            if (volatility < 0.05) {
                console.log(`[SKIP] ${pair} ${timeframe}: ultra-low volatility (${volatility.toFixed(2)}%)`);
                return this.neutral("Ultra-low volatility");
            }
            // 2. Very low ADX (<15) -> no trade (chop zone)
            if (adx < 15) {
                console.log(`[SKIP] ${pair} ${timeframe}: ADX=${adx.toFixed(0)} < 15 (ranging, no trend)`);
                return this.neutral("ADX too low (ranging market)");
            }

            // Compute divergence with RSI swings
            const rsiArray = [];
            for (let i = 30; i <= closes.length; i++) {
                rsiArray.push(this.calculateRSI(closes.slice(0, i), 14));
            }
            const divergence = this.detectDivergence(closes, rsiArray);
            const majorTrend = price > ema50 ? "BULLISH" : "BEARISH";

            // Determine direction and raw score (0-100)
            let signal = 'NEUTRAL';
            let rawScore = 50;

            // Primary: HMA slope (zero lag)
            if (Math.abs(hmaSlope) > 0.00015) {
                if (hmaSlope > 0) {
                    signal = 'CALL';
                    rawScore = 65 + Math.min(25, hmaSlope * 2000);
                } else {
                    signal = 'PUT';
                    rawScore = 65 - Math.min(25, Math.abs(hmaSlope) * 2000);
                }
            }
            // Secondary: EMA cross
            else if (ema9 > ema21) {
                signal = 'CALL';
                const strength = (ema9 - ema21) / price * 100;
                rawScore = 58 + Math.min(22, strength * 12);
            } else if (ema9 < ema21) {
                signal = 'PUT';
                const strength = (ema21 - ema9) / price * 100;
                rawScore = 58 - Math.min(22, strength * 12);
            } else {
                // Neutral: RSI bias
                if (rsi > 55) { signal = 'CALL'; rawScore = 55; }
                else if (rsi < 45) { signal = 'PUT'; rawScore = 55; }
                else { signal = 'CALL'; rawScore = 52; }
            }

            // ---- ADX WEIGHT (very important) ----
            if (adx > 30) rawScore += 12;      // strong trend
            else if (adx > 25) rawScore += 6;   // moderate trend
            else if (adx < 20) rawScore -= 8;   // weak trend (but ADX>15 already, so not too harsh)

            // RSI extreme adjustments
            if (signal === 'CALL' && rsi < 30) rawScore += 14;
            if (signal === 'PUT' && rsi > 70) rawScore += 14;
            if (signal === 'CALL' && rsi > 70) rawScore -= 12;
            if (signal === 'PUT' && rsi < 30) rawScore -= 12;

            // Divergence adjustment (strong bonus)
            if (divergence) {
                if ((signal === 'CALL' && divergence.includes('BULLISH')) ||
                    (signal === 'PUT' && divergence.includes('BEARISH'))) {
                    rawScore += 18;
                } else {
                    rawScore -= 12; // divergence against signal
                }
            }

            // Higher timeframe alignment (mandatory for high confidence)
            let htTrend = 'NEUTRAL';
            let htBonus = 0;
            if (htCandles && htCandles.length >= 50) {
                const htCloses = htCandles.map(c => c.close);
                const htEMA50 = this.calculateEMA(htCloses, 50);
                htTrend = htCloses[htCloses.length-1] > htEMA50 ? 'BULLISH' : 'BEARISH';
                if ((signal === 'CALL' && htTrend === 'BULLISH') ||
                    (signal === 'PUT' && htTrend === 'BEARISH')) {
                    htBonus = 12;
                    rawScore += 12;
                } else if ((signal === 'CALL' && htTrend === 'BEARISH') ||
                           (signal === 'PUT' && htTrend === 'BULLISH')) {
                    htBonus = -15;
                    rawScore -= 15;
                }
            } else {
                // No higher timeframe data – reduce confidence a bit
                rawScore -= 5;
            }

            // Clamp rawScore and compute probability (45-95%)
            rawScore = Math.min(100, Math.max(0, rawScore));
            let probability = Math.round(45 + rawScore * 0.5);
            probability = Math.min(92, Math.max(50, probability));

            // Final quality gate: if probability < 60 after all adjustments, skip
            if (probability < 60) {
                console.log(`[SKIP] ${pair} ${timeframe}: probability ${probability}% < 60% after filtering`);
                return this.neutral(`Probability ${probability}% below threshold (60%)`);
            }

            const withTrend = (signal === 'CALL' && majorTrend === 'BULLISH') ||
                              (signal === 'PUT' && majorTrend === 'BEARISH');
            // If against major trend and no divergence or strong momentum, lower confidence
            if (!withTrend && !divergence && Math.abs(hmaSlope) < 0.0002) {
                probability = Math.min(probability, 65);
                console.log(`[WARN] ${pair}: signal against trend, probability capped at ${probability}%`);
            }

            console.log(`[SIGNAL] ${pair} ${timeframe}: ${signal} prob=${probability}% raw=${rawScore.toFixed(2)} ADX=${adx.toFixed(0)} RSI=${rsi.toFixed(0)} Div=${divergence || 'none'} WithTrend=${withTrend}`);

            // Risk & Position Sizing
            const baseRisk = probability >= 85 ? 2.5 : (probability >= 75 ? 2.0 : (probability >= 65 ? 1.5 : 1.0));
            const kelly = this.calculateKellyFactor();
            const volFactor = Math.min(1.5, Math.max(0.6, 0.0025 / (atr/price)));
            const ddFactor = this.riskMultiplier;
            let finalRisk = baseRisk * kelly * volFactor * ddFactor;
            finalRisk = Math.min(3.5, Math.max(0.4, finalRisk));

            // ADX based risk adjustment: stronger trend allows higher risk
            if (adx > 35) finalRisk = Math.min(4.0, finalRisk * 1.2);
            if (adx < 18) finalRisk = finalRisk * 0.6;

            let stopPips = Math.max(8, Math.min(55, Math.round((atr / price) * 10000 * 1.3)));
            let tpPips = Math.round(stopPips * (adx > 25 ? 2.2 : 1.6));
            const maxBars = (timeframe === '1m' ? 60 : 12);

            return {
                signal, probability, rawScore: Math.round(rawScore),
                recommendedAction: probability >= 85 ? "STRONG_TRADE" : (probability >= 75 ? "CONFIDENT_TRADE" : (probability >= 65 ? "NORMAL_TRADE" : "CAUTIOUS_TRADE")),
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
                    withTrend ? '✅ With trend' : '⚠️ Against trend',
                    adx > 25 ? `🔥 ADX=${adx.toFixed(0)} trending` : `ADX=${adx.toFixed(0)} ranging`
                ].filter(f => f),
                stopLoss: stopPips, takeProfit: tpPips, maxHoldBars: maxBars,
                riskRewardRatio: (tpPips / stopPips).toFixed(2),
                pair, timeframe, timestamp: new Date().toISOString(),
                version: "WORLDCLASS-v13.0",
                guidance: `${signal} signal (${withTrend ? 'with' : 'against'} trend) | ADX ${adx.toFixed(0)} | RSI ${rsi.toFixed(0)}`
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
            pair: "UNKNOWN", timeframe: "UNKNOWN", version: "WORLDCLASS-v13.0", guidance: reason
        };
    }

    fallbackSignal(pair, timeframe, reason) {
        console.log(`[FALLBACK] ${pair}: ${reason} -> no trade`);
        return this.neutral(`Fallback: ${reason}`);
    }

    calculateKellyFactor() {
        const trades = this.tradeHistory.slice(-50);
        if (trades.length < 20) return 0.25;
        const wins = trades.filter(t => t.win).length;
        const winRate = wins / trades.length;
        const avgWin = trades.filter(t => t.win).reduce((a,b)=>a+b.pnlPercent,0) / (wins || 1);
        const avgLoss = Math.abs(trades.filter(t => !t.win).reduce((a,b)=>a+b.pnlPercent,0) / (trades.length - wins || 1));
        const kelly = (winRate * (avgWin/avgLoss) - (1-winRate)) / (avgWin/avgLoss);
        return Math.min(0.3, Math.max(0.05, kelly));
    }
}

module.exports = { RobustAnalyzer: WorldClassAnalyzer };
