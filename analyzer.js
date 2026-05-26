const technicalIndicators = require('technicalindicators');
const pairsConfig = require('./pairs.json');
const { MarketRegimeDetector } = require('./src/core/regimeDetector');
const { PredictiveSignalEngine } = require('./src/core/predictiveEngine');

// ===== TRUE DIVERGENCE DETECTION (swing‑based) =====
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

// ===== KELLY CRITERION SIZER (dynamic) =====
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

    calculateRSI(closes, period) {
        if (closes.length < period + 1) return 50;
        let gains = 0, losses = 0;
        for (let i = 1; i <= period; i++) {
            const diff = closes[i] - closes[i-1];
            diff >= 0 ? gains += diff : losses -= diff;
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
        const rs = avgGain / avgLoss;
        return Math.min(100, Math.max(0, Math.round((100 - 100 / (1 + rs)) * 10) / 10));
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
        return tr.slice(-period).reduce((a, b) => a + b, 0) / period;
    }

    calculateADX(highs, lows, closes, period) {
        if (highs.length < period + 2) return { adx: 20, trend: 'RANGING' };
        try {
            const adx = technicalIndicators.ADX({ high: highs, low: lows, close: closes, period });
            const last = adx[adx.length - 1] || 20;
            let trend = 'RANGING';
            if (last >= 35) trend = 'STRONG_TRENDING';
            else if (last >= 22) trend = 'WEAK_TRENDING';
            return { adx: last, trend };
        } catch { return { adx: 20, trend: 'RANGING' }; }
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

    getCurrentSession() {
        const hour = new Date().getUTCHours();
        if (hour >= 12 && hour < 16) return { session: 'LONDON_NY_OVERLAP', liquidityBoost: 1.5 };
        return { session: 'REGULAR', liquidityBoost: 1.0 };
    }

    calculateProbability(candles, pair, timeframe) {
        try {
            if (!candles || candles.length < 50) return this.neutral("Insufficient data");

            const closes = candles.map(c => c.close);
            const highs = candles.map(c => c.high);
            const lows = candles.map(c => c.low);
            const volumes = candles.map(c => c.volume);
            const price = closes[closes.length - 1];
            const atr = this.calculateATR(highs, lows, closes, 14);
            const vol = (atr / price) * 100;
            const adx = this.calculateADX(highs, lows, closes, this.tech.adxPeriod);
            const rsi = this.calculateRSI(closes, this.tech.rsiPeriod);
            const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;

            // Build RSI array for divergence
            const rsiArr = [];
            for (let i = 30; i <= closes.length; i++) rsiArr.push(this.calculateRSI(closes.slice(0, i), 14));
            const divergence = detectTrueDivergence(closes, rsiArr);

            const regime = this.regimeDetector.detectRegime(adx.adx, vol, rsi);
            const predictive = this.predictive.detectPredictiveEntry(candles);
            const session = this.getCurrentSession();
            const bb = this.calculateBollingerBands(closes, this.tech.bbPeriod, this.tech.bbStdDev);
            const macd = this.calculateMACD(closes, this.tech.macdFast, this.tech.macdSlow, this.tech.macdSignal);

            let direction = "NEUTRAL";
            let prob = 50;
            let active = [];

            if (predictive && predictive.signal !== 'NEUTRAL') {
                direction = predictive.signal;
                prob = predictive.probability;
                active.push({ name: "PREDICTIVE", signal: predictive.signal, probability: predictive.probability });
            }
            if (rsi <= 30 && bb.lower && price <= bb.lower) {
                direction = "CALL";
                prob = Math.max(prob, 75);
                active.push({ name: "MEAN_REVERSION", signal: "CALL", probability: 75 });
            } else if (rsi >= 70 && bb.upper && price >= bb.upper) {
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

            let finalProb = prob * regime.positionMultiplier * session.liquidityBoost;
            if (vol < 0.18) finalProb = Math.min(finalProb, 40);
            else if (vol < 0.25) finalProb = Math.min(finalProb, 55);
            else if (vol >= 0.35 && vol <= 0.85) finalProb *= 1.1;
            if (active.length >= 2) finalProb *= 1.05;
            if (active.length >= 3) finalProb *= 1.1;
            if (divergence && ((direction === "CALL" && divergence.type === "BULLISH") || (direction === "PUT" && divergence.type === "BEARISH")))
                finalProb += 12;

            finalProb = Math.min(98, Math.max(0, Math.round(finalProb)));
            const level = this.getLevel(finalProb);
            const kellyRisk = this.kelly.getRisk(finalProb);
            const stop = Math.min(45, Math.max(10, Math.round((atr / price) * 10000 * 1.5)));
            const tp = Math.round(stop * 1.8);

            return {
                signal: finalProb >= 55 ? direction : "NEUTRAL",
                probability: finalProb,
                probabilityLevel: level.level,
                probabilityEmoji: level.emoji,
                recommendedAction: level.action,
                suggestedRisk: kellyRisk.toFixed(1) + '%',
                rsi: rsi.toFixed(1),
                adx: adx.adx.toFixed(1),
                trend: adx.trend,
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
                version: "16.0-LEGENDARY"
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
        return `${level.emoji} ${level.action} (${prob}%)\n━━━━━━━━━━━━━━━━━━━━━━\n📊 ${stratCount} strategies\n📈 Regime: ${regime.toUpperCase()}\n━━━━━━━━━━━━━━━━━━━━━━\n💡 YOUR DECISION:\n• ${prob}%+ → Full position\n• 70-84% → Normal\n• 55-69% → Cautious\n• <55% → Skip`;
    }

    neutral(reason) {
        return {
            signal: "NEUTRAL", probability: 30, probabilityLevel: "VERY_LOW", probabilityEmoji: "❌",
            recommendedAction: "NO_TRADE", suggestedRisk: "0%", rsi: "50", adx: "20", trend: "UNKNOWN",
            volatility: "0", currentPrice: "0", regime: "unknown", activeStrategies: [], divergence: "None",
            session: "UNKNOWN", guidance: reason, stopLoss: 15, takeProfit: 27, riskRewardRatio: "1.80",
            timestamp: new Date().toISOString(), pair: "UNKNOWN", timeframe: "UNKNOWN", version: "16.0-LEGENDARY"
        };
    }
}

module.exports = { LegendaryAnalyzer };
