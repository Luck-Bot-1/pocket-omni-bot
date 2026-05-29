// ============================================================
// SIMPLE BUT POWERFUL ANALYZER v9.0 – NO FIXED ADX
// ============================================================
const technicalIndicators = require('technicalindicators');
const fs = require('fs');

class SimpleAnalyzer {
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

    // ---------- RELIABLE INDICATORS ----------
    calculateEMA(data, period) {
        if (data.length < period) return data[data.length-1];
        try { return technicalIndicators.EMA({ values: data, period }).slice(-1)[0]; } catch(e) { return data[data.length-1]; }
    }

    calculateRSI(closes, period = 14) {
        if (closes.length < period + 1) return 50;
        try { return technicalIndicators.RSI({ values: closes, period }).slice(-1)[0] || 50; } catch(e) { return 50; }
    }

    calculateATR(highs, lows, closes, period = 14) {
        if (highs.length < period + 1) return 0.001;
        try { return technicalIndicators.ATR({ high: highs, low: lows, close: closes, period }).slice(-1)[0] || 0.001; } catch(e) { return 0.001; }
    }

    // Custom ADX (simple, avoids library issues)
    calculateADX(highs, lows, closes, period = 14) {
        if (highs.length < period + 2) return 20;
        try {
            const adx = technicalIndicators.ADX({ high: highs, low: lows, close: closes, period });
            return adx.slice(-1)[0] || 20;
        } catch(e) {
            // Fallback: compute using price range as proxy
            const range = Math.max(...highs.slice(-20)) - Math.min(...lows.slice(-20));
            const avgPrice = closes.slice(-20).reduce((a,b)=>a+b,0)/20;
            return Math.min(50, Math.max(20, (range/avgPrice)*1000));
        }
    }

    // HMA (zero lag) – custom implementation
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

    // ---------- MAIN SIGNAL (ALWAYS VARYING PROBABILITY) ----------
    calculateProbability(candles, pair, timeframe, htCandles = null) {
        try {
            if (!candles || candles.length < 50) {
                return this.fallbackSignal(pair, timeframe, "Insufficient data");
            }
            const closes = candles.map(c => c.close);
            const highs = candles.map(c => c.high);
            const lows = candles.map(c => c.low);
            const price = closes[closes.length - 1];

            // Core indicators
            const rsi = this.calculateRSI(closes, 14);
            const atr = this.calculateATR(highs, lows, closes, 14);
            const adx = this.calculateADX(highs, lows, closes, 14);
            const ema9 = this.calculateEMA(closes, 9);
            const ema21 = this.calculateEMA(closes, 21);
            const ema50 = this.calculateEMA(closes, 50);
            const hma = this.calculateHMA(closes, 20);
            const hmaSlope = hma.length >= 2 ? hma[hma.length-1] - hma[hma.length-2] : 0;
            const volatility = (atr / price) * 100;

            // Determine trend direction and strength
            let signal = 'NEUTRAL';
            let rawScore = 50;

            // 1. Use HMA slope for early momentum (lowered threshold)
            if (Math.abs(hmaSlope) > 0.0001) {
                if (hmaSlope > 0) {
                    signal = 'CALL';
                    rawScore = 60 + Math.min(25, hmaSlope * 2000);
                } else {
                    signal = 'PUT';
                    rawScore = 60 - Math.min(25, Math.abs(hmaSlope) * 2000);
                }
            }
            // 2. Else use EMA cross (reliable)
            else if (ema9 > ema21) {
                signal = 'CALL';
                const strength = (ema9 - ema21) / price * 100;
                rawScore = 55 + Math.min(20, strength * 10);
            } else if (ema9 < ema21) {
                signal = 'PUT';
                const strength = (ema21 - ema9) / price * 100;
                rawScore = 55 - Math.min(20, strength * 10);
            }

            // 3. If still neutral, use RSI bias
            if (signal === 'NEUTRAL') {
                if (rsi > 55) { signal = 'CALL'; rawScore = 55; }
                else if (rsi < 45) { signal = 'PUT'; rawScore = 55; }
                else { signal = 'CALL'; rawScore = 52; }
            }

            // Adjust score based on ADX (trend strength)
            if (adx > 25) {
                rawScore += 5;
            } else if (adx < 20) {
                rawScore -= 5;
            }

            // Adjust based on RSI extremes
            if (signal === 'CALL' && rsi < 30) rawScore += 10;
            if (signal === 'PUT' && rsi > 70) rawScore += 10;
            if (signal === 'CALL' && rsi > 70) rawScore -= 10;
            if (signal === 'PUT' && rsi < 30) rawScore -= 10;

            // Higher timeframe alignment (if available)
            if (htCandles && htCandles.length >= 50) {
                const htCloses = htCandles.map(c => c.close);
                const htEMA50 = this.calculateEMA(htCloses, 50);
                const htTrend = htCloses[htCloses.length-1] > htEMA50 ? 'BULLISH' : 'BEARISH';
                if ((signal === 'CALL' && htTrend === 'BULLISH') ||
                    (signal === 'PUT' && htTrend === 'BEARISH')) {
                    rawScore += 10;
                } else if ((signal === 'CALL' && htTrend === 'BEARISH') ||
                           (signal === 'PUT' && htTrend === 'BULLISH')) {
                    rawScore -= 10;
                }
            }

            // Clamp rawScore and convert to probability (50-85%)
            rawScore = Math.min(100, Math.max(0, rawScore));
            let probability = Math.round(50 + rawScore * 0.35);
            probability = Math.min(85, Math.max(45, probability));

            // Reduce probability slightly in very low volatility
            if (volatility < 0.1) probability = Math.max(45, probability - 5);

            console.log(`[SIGNAL] ${pair} ${timeframe}: ${signal} prob=${probability}% raw=${rawScore} ADX=${adx.toFixed(0)} RSI=${rsi.toFixed(0)}`);

            // Risk & Position Sizing (simple but robust)
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
                divergence: "None",
                majorTrend: ema50 > price ? "BEARISH" : "BULLISH",
                hmaSlope: hmaSlope.toFixed(6),
                activeFactors: [`HMA slope: ${hmaSlope.toFixed(6)}`, `EMA9/21: ${ema9 > ema21 ? 'CALL' : 'PUT'}`, `RSI: ${rsi.toFixed(0)}`],
                stopLoss: stopPips, takeProfit: tpPips, maxHoldBars: maxBars,
                riskRewardRatio: (tpPips / stopPips).toFixed(2),
                pair, timeframe, timestamp: new Date().toISOString(),
                version: "SIMPLE-v9.0",
                guidance: `${signal} signal generated`
            };
        } catch (err) {
            console.error(`[ERROR] ${pair}: ${err.message}`);
            return this.fallbackSignal(pair, timeframe, err.message);
        }
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
            pair, timeframe, version: "SIMPLE-v9.0", guidance: `Fallback: ${reason}`
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

module.exports = { RobustAnalyzer: SimpleAnalyzer };
