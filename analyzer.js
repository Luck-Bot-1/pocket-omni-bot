const technicalIndicators = require('technicalindicators');
const pairsConfig = require('./pairs.json');
const { MarketRegimeDetector } = require('./src/core/regimeDetector');
const { PredictiveSignalEngine } = require('./src/core/predictiveEngine');

function detectTrueDivergence(closes, rsiValues) {
    if (closes.length < 50 || rsiValues.length < 50) return null;
    const swingLows = [], swingHighs = [];
    for (let i = 5; i < closes.length - 5; i++) {
        let isLow = true, isHigh = true;
        for (let j = -5; j <= 5; j++) {
            if (j === 0) continue;
            if (closes[i] > closes[i + j]) isLow = false;
            if (closes[i] < closes[i + j]) isHigh = false;
        }
        if (isLow) swingLows.push({ price: closes[i], rsi: rsiValues[i] });
        if (isHigh) swingHighs.push({ price: closes[i], rsi: rsiValues[i] });
    }
    if (swingLows.length >= 2) {
        const last = swingLows[swingLows.length - 1];
        const prev = swingLows[swingLows.length - 2];
        if (last.price < prev.price && last.rsi > prev.rsi) {
            const diff = ((last.rsi - prev.rsi) / prev.rsi) * 100;
            return { type: 'BULLISH', strength: diff > 15 ? 'STRONG' : 'WEAK', confidence: Math.min(90, 60 + diff) };
        }
    }
    if (swingHighs.length >= 2) {
        const last = swingHighs[swingHighs.length - 1];
        const prev = swingHighs[swingHighs.length - 2];
        if (last.price > prev.price && last.rsi < prev.rsi) {
            const diff = ((prev.rsi - last.rsi) / prev.rsi) * 100;
            return { type: 'BEARISH', strength: diff > 15 ? 'STRONG' : 'WEAK', confidence: Math.min(90, 60 + diff) };
        }
    }
    return null;
}

class KellyPositionSizer {
    constructor() {
        this.trades = [];
        this.winRate = 0.55;
        this.avgWinLoss = 1.8;
        this.maxRisk = 0.03;
        this.minRisk = 0.005;
        this.kellyFraction = 0.25;
    }
    update(win, pnl) {
        this.trades.push({ win, pnl });
        if (this.trades.length > 200) this.trades.shift();
        const wins = this.trades.filter(t => t.win).length;
        const total = this.trades.length;
        this.winRate = total ? wins / total : 0.55;
        const avgWin = this.trades.filter(t => t.win).reduce((s, t) => s + t.pnl, 0) / (wins || 1);
        const avgLoss = Math.abs(this.trades.filter(t => !t.win).reduce((s, t) => s + t.pnl, 0) / (total - wins || 1));
        this.avgWinLoss = avgWin / (avgLoss || 1);
    }
    getRisk(probability) {
        const winProb = probability / 100;
        const lossProb = 1 - winProb;
        const b = this.avgWinLoss;
        let kelly = (winProb * b - lossProb) / b;
        kelly = Math.max(0, Math.min(this.maxRisk, kelly * this.kellyFraction));
        return Math.max(this.minRisk, Math.min(this.maxRisk, kelly));
    }
}

class LegendaryAnalyzer {
    constructor() {
        this.config = pairsConfig;
        this.tech = this.config.technicalParameters;
        this.probLevels = this.config.probabilityLevels;
        this.regimeDetector = new MarketRegimeDetector();
        this.predictive = new PredictiveSignalEngine();
        this.kelly = new KellyPositionSizer();
    }

    recordTradeResult(win, pnl) {
        this.kelly.update(win, pnl);
    }

    calculateRSI(closes, period) {
        if (!closes || closes.length < period + 1) return 50;
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
        let rsi = 100 - (100 / (1 + rs));
        if (isNaN(rsi) || !isFinite(rsi)) return 50;
        return Math.min(100, Math.max(0, Math.round(rsi * 10) / 10));
    }

    calculateATR(highs, lows, closes, period) {
        if (highs.length < period + 1) return 0.001;
        const tr = [];
        for (let i = 1; i < highs.length; i++) {
            const hl = highs[i] - lows[i];
            const hc = Math.abs(highs[i] - closes[i-1]);
            const lc = Math.abs(lows[i] - closes[i-1]);
            tr.push(Math.max(hl, hc, lc));
        }
        const atr = tr.slice(-period).reduce((a, b) => a + b, 0) / period;
        return isNaN(atr) ? 0.001 : atr;
    }

    // INSTITUTIONAL ADX WITH OVERRIDE – guarantees ADX >20 when price moves
    calculateADX(highs, lows, closes, period) {
        if (highs.length < period + 2) return { adx: 20, trend: 'RANGING' };
        let adx = 20;
        let trend = 'RANGING';
        try {
            const adxResult = technicalIndicators.ADX({ high: highs, low: lows, close: closes, period });
            adx = adxResult[adxResult.length - 1] || 20;
            if (isNaN(adx) || !isFinite(adx)) adx = 20;
        } catch(e) { adx = 20; }

        // ---- OVERRIDE: If price range > 0.5% over last 20 candles, force ADX > 20 ----
        const last20Closes = closes.slice(-20);
        const minPrice = Math.min(...last20Closes);
        const maxPrice = Math.max(...last20Closes);
        const priceRangePercent = (maxPrice - minPrice) / minPrice * 100;
        if (priceRangePercent > 0.5) {
            // Map range 0.5%..3% to ADX 25..55
            const forcedAdx = Math.min(55, Math.max(25, 25 + (priceRangePercent - 0.5) * 10));
            adx = Math.max(adx, forcedAdx);
        }

        if (adx >= 35) trend = 'STRONG_TRENDING';
        else if (adx >= 22) trend = 'WEAK_TRENDING';
        return { adx: Math.round(adx * 10) / 10, trend };
    }

    calculateBollingerBands(closes, period, stdDev) {
        if (closes.length < period) return { lower: null, upper: null };
        try {
            const bb = technicalIndicators.BollingerBands({ period, values: closes, stdDev });
            const last = bb[bb.length - 1];
            return { lower: last.lower, upper: last.upper };
        } catch { return { lower: null, upper: null }; }
    }

    calculateMACD(closes, fast, slow, signal) {
        if (closes.length < slow + signal) return { cross: 'NEUTRAL' };
        try {
            const macd = technicalIndicators.MACD({ values: closes, fastPeriod: fast, slowPeriod: slow, signalPeriod: signal });
            const last = macd[macd.length - 1];
            let cross = 'NEUTRAL';
            if (macd.length >= 2) {
                const prev = macd[macd.length - 2];
                if (prev.MACD <= prev.signal && last.MACD > last.signal) cross = 'BULLISH';
                else if (prev.MACD >= prev.signal && last.MACD < last.signal) cross = 'BEARISH';
            }
            return { cross };
        } catch { return { cross: 'NEUTRAL' }; }
    }

    calculateEMA(data, period) {
        if (data.length < period) return data;
        const k = 2 / (period + 1);
        let ema = data[0];
        const result = [ema];
        for (let i = 1; i < data.length; i++) {
            ema = data[i] * k + ema * (1 - k);
            result.push(ema);
        }
        return result;
    }

    getCurrentSession() {
        const now = new Date();
        const utcHour = now.getUTCHours();
        const utcDay = now.getUTCDay();

        if (utcDay === 6 || utcDay === 0) return { session: 'WEEKEND', liquidityBoost: 0.9, reason: 'Weekend' };
        if (utcHour >= 0 && utcHour < 7) return { session: 'ASIAN', liquidityBoost: 0.9, reason: 'Asian session' };
        if (utcHour >= 7 && utcHour < 8) return { session: 'LONDON_OPEN', liquidityBoost: 1.0, reason: 'London open' };
        if (utcHour >= 8 && utcHour < 12) return { session: 'LONDON', liquidityBoost: 1.1, reason: 'London session' };
        if (utcHour >= 12 && utcHour < 16) return { session: 'LONDON_NY_OVERLAP', liquidityBoost: 1.2, reason: 'London-NY overlap' };
        if (utcHour >= 16 && utcHour < 20) return { session: 'NEW_YORK', liquidityBoost: 1.1, reason: 'New York session' };
        if (utcHour >= 20 && utcHour < 24) return { session: 'NY_CLOSE', liquidityBoost: 0.9, reason: 'NY close' };
        return { session: 'OTHER', liquidityBoost: 0.9, reason: 'Regular' };
    }

    calculateProbability(candles, pair, timeframe, forceMockDirection = false) {
        try {
            const session = this.getCurrentSession();

            if (!candles || !Array.isArray(candles) || candles.length < 50) {
                return this.neutral("Insufficient data (less than 50 candles)");
            }
            let limitedCandles = candles.filter(c => 
                c && typeof c.open === 'number' && typeof c.high === 'number' &&
                typeof c.low === 'number' && typeof c.close === 'number' &&
                typeof c.time === 'number'
            );
            if (limitedCandles.length < 50) return this.neutral("Insufficient valid candles");

            const maxCandles = 300;
            if (limitedCandles.length > maxCandles) limitedCandles = limitedCandles.slice(-maxCandles);
            const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
            limitedCandles = limitedCandles.filter(c => c.time > sevenDaysAgo);
            if (limitedCandles.length < 50) return this.neutral("Insufficient recent data");

            const closes = limitedCandles.map(c => c.close);
            const highs = limitedCandles.map(c => c.high);
            const lows = limitedCandles.map(c => c.low);
            const volumes = limitedCandles.map(c => c.volume);
            const price = closes[closes.length - 1];
            const atr = this.calculateATR(highs, lows, closes, 14);
            const vol = (atr / price) * 100;
            const adxData = this.calculateADX(highs, lows, closes, this.tech.adxPeriod);
            const rsi = this.calculateRSI(closes, this.tech.rsiPeriod);

            const rsiArr = [];
            for (let i = 30; i <= closes.length; i++) rsiArr.push(this.calculateRSI(closes.slice(0, i), 14));
            const divergence = detectTrueDivergence(closes, rsiArr);

            const regime = this.regimeDetector.detectRegime(adxData.adx, vol, rsi);
            const predictive = this.predictive.detectPredictiveEntry(limitedCandles);
            const bb = this.calculateBollingerBands(closes, this.tech.bbPeriod, this.tech.bbStdDev);
            const macd = this.calculateMACD(closes, this.tech.macdFast, this.tech.macdSlow, this.tech.macdSignal);

            const volFactor = Math.min(1, Math.max(0, (vol - 0.2) / 1.3));
            const rsiLowDynamic = Math.max(20, Math.min(35, 30 - volFactor * 10));
            const rsiHighDynamic = Math.min(80, Math.max(65, 70 + volFactor * 10));

            let direction = "NEUTRAL";
            let prob = 50;
            let active = [];

            if (predictive && predictive.signal !== 'NEUTRAL') {
                direction = predictive.signal;
                prob = predictive.probability;
                active.push({ name: "PREDICTIVE", signal: predictive.signal, probability: predictive.probability });
            }
            if (rsi <= rsiLowDynamic && bb.lower && price <= bb.lower) {
                direction = "CALL";
                prob = Math.max(prob, 75);
                active.push({ name: "MEAN_REVERSION", signal: "CALL", probability: 75 });
            } else if (rsi >= rsiHighDynamic && bb.upper && price >= bb.upper) {
                direction = "PUT";
                prob = Math.max(prob, 75);
                active.push({ name: "MEAN_REVERSION", signal: "PUT", probability: 75 });
            }
            if (macd.cross === 'BULLISH') {
                if (direction === "NEUTRAL") direction = "CALL";
                prob = Math.max(prob, 70);
                active.push({ name: "MOMENTUM", signal: "CALL", probability: 70 });
            } else if (macd.cross === 'BEARISH') {
                if (direction === "NEUTRAL") direction = "PUT";
                prob = Math.max(prob, 70);
                active.push({ name: "MOMENTUM", signal: "PUT", probability: 70 });
            }

            // Micro‑trend fallback
            if (direction === "NEUTRAL") {
                const ema5 = this.calculateEMA(closes, 5);
                const ema5Prev = ema5[ema5.length - 2];
                const ema5Curr = ema5[ema5.length - 1];
                const microTrend = ema5Curr > ema5Prev ? 'BULLISH' : (ema5Curr < ema5Prev ? 'BEARISH' : 'NEUTRAL');
                const momentum3 = (closes[closes.length - 1] - closes[closes.length - 4]) / closes[closes.length - 4] * 100;

                if (microTrend === 'BULLISH' && momentum3 > 0) {
                    direction = "CALL";
                    prob = 55;
                    active.push({ name: "MICRO_TREND", signal: "CALL", probability: 55 });
                } else if (microTrend === 'BEARISH' && momentum3 < 0) {
                    direction = "PUT";
                    prob = 55;
                    active.push({ name: "MICRO_TREND", signal: "PUT", probability: 55 });
                } else {
                    const priceChange = (closes[closes.length - 1] - closes[closes.length - 4]) / closes[closes.length - 4] * 100;
                    if (priceChange > 0.05) {
                        direction = "CALL";
                        prob = 50;
                        active.push({ name: "PRICE_MOMENTUM", signal: "CALL", probability: 50 });
                    } else if (priceChange < -0.05) {
                        direction = "PUT";
                        prob = 50;
                        active.push({ name: "PRICE_MOMENTUM", signal: "PUT", probability: 50 });
                    }
                }
            }

            let finalProb = prob * regime.positionMultiplier * session.liquidityBoost;
            if (vol >= 0.35 && vol <= 0.85) finalProb *= 1.1;

            if (active.length >= 2) finalProb *= 1.05;
            if (active.length >= 3) finalProb *= 1.1;
            if (divergence && ((direction === "CALL" && divergence.type === "BULLISH") || (direction === "PUT" && divergence.type === "BEARISH")))
                finalProb += 12;

            finalProb = Math.min(98, Math.max(0, Math.round(finalProb)));

            if (forceMockDirection && (direction === "NEUTRAL" || finalProb < 30)) {
                const lastChange = closes[closes.length - 1] - closes[closes.length - 2];
                direction = lastChange > 0 ? "CALL" : (lastChange < 0 ? "PUT" : "CALL");
                finalProb = Math.max(finalProb, 35);
                active.push({ name: "FORCED_DIRECTION", signal: direction, probability: finalProb });
            }

            if (finalProb < 25) {
                return this.neutral(`Signal probability ${finalProb}% < 25% – very low confidence`);
            }

            const level = this.getLevel(finalProb);
            let kellyRisk = this.kelly.getRisk(finalProb);
            if (vol < 0.18) kellyRisk *= 0.5;

            const stop = Math.min(45, Math.max(10, Math.round((atr / price) * 10000 * 1.5)));
            const tp = Math.round(stop * 1.8);

            return {
                signal: direction,
                probability: finalProb,
                probabilityLevel: level.level,
                probabilityEmoji: level.emoji,
                recommendedAction: level.action,
                suggestedRisk: kellyRisk.toFixed(1) + '%',
                rsi: rsi.toFixed(1),
                adx: adxData.adx.toFixed(1),
                trend: adxData.trend,
                volatility: vol.toFixed(2),
                currentPrice: price.toFixed(5),
                regime: regime.regime,
                activeStrategies: active,
                divergence: divergence ? `${divergence.type} (${divergence.strength})` : 'None',
                session: session.session,
                guidance: this.buildGuidance(level, finalProb, active.length, regime.regime),
                stopLoss: stop,
                takeProfit: tp,
                riskRewardRatio: (tp / stop).toFixed(2),
                timestamp: new Date().toISOString(),
                pair, timeframe,
                version: "41.0-ADX-OVERRIDE"
            };
        } catch (e) { return this.neutral(`Error: ${e.message}`); }
    }

    getLevel(p) {
        const l = this.probLevels;
        if (p >= l.legendary.min) return l.legendary;
        if (p >= l.exceptional.min) return l.exceptional;
        if (p >= l.high.min) return l.high;
        if (p >= l.good.min) return l.good;
        if (p >= l.moderate.min) return l.moderate;
        if (p >= l.low.min) return l.low;
        return l.veryLow;
    }

    buildGuidance(level, prob, stratCount, regime) {
        let msg = `${level.emoji} ${level.action} (${prob}%)\n━━━━━━━━━━━━━━━━━━━━━━\n📊 ${stratCount} strategies\n📈 Regime: ${regime.toUpperCase()}\n━━━━━━━━━━━━━━━━━━━━━━\n💡 YOUR DECISION:\n• ${prob}%+ → Consider position (${level.risk} risk)\n• 25-54% → Very cautious or skip`;
        return msg;
    }

    neutral(reason) {
        return {
            signal: "NEUTRAL", probability: 0, probabilityLevel: "VERY_LOW", probabilityEmoji: "❌",
            recommendedAction: "NO_TRADE", suggestedRisk: "0%", rsi: "50", adx: "20", trend: "UNKNOWN",
            volatility: "0", currentPrice: "0", regime: "unknown", activeStrategies: [], divergence: "None",
            session: "UNKNOWN", guidance: reason, stopLoss: 15, takeProfit: 27, riskRewardRatio: "1.80",
            timestamp: new Date().toISOString(), pair: "UNKNOWN", timeframe: "UNKNOWN", version: "41.0-ADX-OVERRIDE"
        };
    }
}

module.exports = { LegendaryAnalyzer };
