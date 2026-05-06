// ============================================
// ANALYZER v6.0 – FULL TECHNICAL ANALYSIS
// Real RSI, ADX, DMI, MACD from live data
// ============================================

class ProfessionalAnalyzer {
    constructor() {
        this.tradeHistory = [];
        this.performance = { winRate: 0.65, totalTrades: 0, consecutiveWins: 0, consecutiveLosses: 0, totalPnL: 0 };
    }

    analyzeSignal(priceData, pairConfig = { minConfidence: 60 }) {
        if (!priceData?.values?.length >= 50) {
            return { signal: 'WAIT', confidence: 0, reason: 'Insufficient data', rsi: 50, adx: 0, dmi: { plus: 0, minus: 0 }, priceChange: 0 };
        }

        const processed = this.processData(priceData);
        const indicators = this.calcIndicators(processed);
        const scores = this.calcScores(indicators);
        let confidence = this.calcConfidence(scores, indicators);
        
        let signal = 'WAIT';
        
        if (scores.buy > scores.sell && confidence >= pairConfig.minConfidence) {
            if (!indicators.trend.direction.includes('DOWN')) {
                signal = confidence >= 80 ? 'STRONG_CALL' : 'CALL';
            } else {
                confidence = Math.round(confidence * 0.6);
            }
        } 
        else if (scores.sell > scores.buy && confidence >= pairConfig.minConfidence) {
            if (!indicators.trend.direction.includes('UP')) {
                signal = confidence >= 80 ? 'STRONG_PUT' : 'PUT';
            } else {
                confidence = Math.round(confidence * 0.6);
            }
        }

        // Fallback for borderline signals
        if (signal === 'WAIT' && confidence >= 55) {
            if (scores.buy > scores.sell) signal = 'CALL';
            else if (scores.sell > scores.buy) signal = 'PUT';
        }

        // Price change over last 15 candles (approx 3.75 hours)
        const priceChange = ((processed.closes[processed.closes.length-1] - processed.closes[processed.closes.length-16]) / processed.closes[processed.closes.length-16]) * 100;

        return { 
            signal, 
            confidence, 
            trend: indicators.trend.direction,
            emaRelation: `EMA9 ${indicators.ema9 > indicators.ema21 ? '>' : '<'} EMA21`,
            rsi: Math.round(indicators.rsi),
            adx: Math.round(indicators.adx || 0),
            dmi: { plus: indicators.dmi?.plus?.toFixed(1) || 0, minus: indicators.dmi?.minus?.toFixed(1) || 0 },
            priceChange: priceChange.toFixed(2),
            reason: this.generateReason(scores, indicators, priceChange)
        };
    }

    processData(priceData) {
        const values = priceData.values.slice(0, 60).reverse();
        return {
            closes: values.map(v => parseFloat(v.close)),
            highs: values.map(v => parseFloat(v.high)),
            lows: values.map(v => parseFloat(v.low)),
        };
    }

    calcIndicators(data) {
        const trend = this.calcTrend(data.closes);
        const ema9 = this.calcEMA(data.closes, 9);
        const ema21 = this.calcEMA(data.closes, 21);
        const rsi = this.calcRSI(data.closes, 14);
        const macd = this.calcMACD(data.closes);
        const sr = this.calcSupportResistance(data.highs, data.lows);
        const adx = this.calcADX(data.highs, data.lows, data.closes, 14);
        const dmi = this.calcDMI(data.highs, data.lows, data.closes, 14);
        return { trend, ema9, ema21, rsi, macd, sr, adx, dmi };
    }

    calcTrend(closes) {
        const ema9 = this.calcEMA(closes, 9);
        const ema21 = this.calcEMA(closes, 21);
        if (ema9 > ema21) return { direction: 'UP', strength: 60 };
        if (ema9 < ema21) return { direction: 'DOWN', strength: 60 };
        return { direction: 'SIDEWAYS', strength: 30 };
    }

    calcADX(highs, lows, closes, period = 14) {
        if (closes.length < period + 1) return 0;
        const tr = [], plusDM = [], minusDM = [];
        for (let i = 1; i < closes.length; i++) {
            const highDiff = highs[i] - highs[i-1];
            const lowDiff = lows[i-1] - lows[i];
            const trueRange = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
            tr.push(trueRange);
            plusDM.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
            minusDM.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);
        }
        const atr = tr.slice(-period).reduce((a,b)=>a+b,0)/period;
        const avgPlusDM = plusDM.slice(-period).reduce((a,b)=>a+b,0)/period;
        const avgMinusDM = minusDM.slice(-period).reduce((a,b)=>a+b,0)/period;
        const plusDI = (avgPlusDM / atr) * 100;
        const minusDI = (avgMinusDM / atr) * 100;
        const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
        return isNaN(dx) ? 0 : dx;
    }

    calcDMI(highs, lows, closes, period = 14) {
        if (closes.length < period + 1) return { plus: 0, minus: 0 };
        const tr = [], plusDM = [], minusDM = [];
        for (let i = 1; i < closes.length; i++) {
            const highDiff = highs[i] - highs[i-1];
            const lowDiff = lows[i-1] - lows[i];
            const trueRange = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
            tr.push(trueRange);
            plusDM.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
            minusDM.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);
        }
        const atr = tr.slice(-period).reduce((a,b)=>a+b,0)/period;
        const avgPlusDM = plusDM.slice(-period).reduce((a,b)=>a+b,0)/period;
        const avgMinusDM = minusDM.slice(-period).reduce((a,b)=>a+b,0)/period;
        const plusDI = (avgPlusDM / atr) * 100;
        const minusDI = (avgMinusDM / atr) * 100;
        return { plus: plusDI, minus: minusDI };
    }

    calcScores(indicators) {
        let buy = 0, sell = 0;
        if (indicators.trend.direction === 'UP') buy += 40;
        else if (indicators.trend.direction === 'DOWN') sell += 40;
        if (indicators.sr.nearSupport) buy += 25;
        if (indicators.sr.nearResistance) sell += 25;
        if (indicators.rsi < 30) buy += 20;
        else if (indicators.rsi > 70) sell += 20;
        if (indicators.macd.histogram > 0) buy += 15;
        else if (indicators.macd.histogram < 0) sell += 15;
        return { buy, sell };
    }

    calcConfidence(scores, indicators) {
        let conf = Math.max(scores.buy, scores.sell);
        if (this.performance.consecutiveLosses >= 3) conf *= 0.7;
        return Math.min(Math.round(conf), 98);
    }

    calcRSI(closes, period) {
        let gains = 0, losses = 0;
        for (let i = closes.length - period; i < closes.length; i++) {
            const change = closes[i] - closes[i-1];
            if (change > 0) gains += change;
            else losses -= change;
        }
        const avgGain = gains / period, avgLoss = losses / period;
        if (avgLoss === 0) return 100;
        return 100 - (100 / (1 + (avgGain / avgLoss)));
    }

    calcEMA(data, period) {
        const k = 2 / (period + 1);
        let ema = data[0];
        for (let i = 1; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
        return ema;
    }

    calcMACD(closes, fast = 12, slow = 26, signal = 9) {
        const emaFast = this.calcEMA(closes, fast);
        const emaSlow = this.calcEMA(closes, slow);
        const macdLine = emaFast - emaSlow;
        const signalLine = this.calcEMA([macdLine], signal);
        return { histogram: macdLine - signalLine, macd: macdLine, signal: signalLine };
    }

    calcSupportResistance(highs, lows, lookback = 20) {
        const recentLows = lows.slice(-lookback), recentHighs = highs.slice(-lookback);
        const currentPrice = (highs[highs.length-1] + lows[lows.length-1]) / 2;
        const support = Math.min(...recentLows), resistance = Math.max(...recentHighs);
        const distToSupport = ((currentPrice - support) / currentPrice) * 100;
        const distToResistance = ((resistance - currentPrice) / currentPrice) * 100;
        return { nearSupport: distToSupport < 0.5, nearResistance: distToResistance < 0.5 };
    }

    generateReason(scores, indicators, priceChange) {
        if (scores.buy > scores.sell) {
            let reason = '';
            if (indicators.trend.direction === 'UP') reason += `Uptrend confirmed (${indicators.ema9 > indicators.ema21 ? 'EMA9 > EMA21' : 'EMA9 < EMA21'}). `;
            if (indicators.adx > 25) reason += `ADX ${indicators.adx.toFixed(1)} (strong trend). `;
            if (indicators.dmi.plus > indicators.dmi.minus) reason += `DMI+ ${indicators.dmi.plus.toFixed(1)} dominates DMI- ${indicators.dmi.minus.toFixed(1)}. `;
            reason += `Price ${priceChange > 0 ? 'up' : 'down'} ${Math.abs(priceChange).toFixed(2)}%.`;
            return reason;
        } else if (scores.sell > scores.buy) {
            let reason = '';
            if (indicators.trend.direction === 'DOWN') reason += `Downtrend confirmed (${indicators.ema9 > indicators.ema21 ? 'EMA9 > EMA21' : 'EMA9 < EMA21'}). `;
            if (indicators.adx > 25) reason += `ADX ${indicators.adx.toFixed(1)} (strong trend). `;
            if (indicators.dmi.minus > indicators.dmi.plus) reason += `DMI- ${indicators.dmi.minus.toFixed(1)} dominates DMI+ ${indicators.dmi.plus.toFixed(1)}. `;
            reason += `Price ${priceChange > 0 ? 'up' : 'down'} ${Math.abs(priceChange).toFixed(2)}%.`;
            return reason;
        }
        return 'Mixed signals – waiting for clear direction.';
    }

    async runBacktest(historicalData, startingBalance = 1000) {
        if (!historicalData?.length >= 100) return { error: 'Need 100+ candles' };
        let balance = startingBalance, trades = [], correct = 0, total = 0;
        for (let i = 100; i < historicalData.length - 15; i++) {
            const signal = this.analyzeSignal({ values: historicalData.slice(0, i + 1) }, { minConfidence: 55 });
            if (signal.signal !== 'WAIT') {
                total++;
                const entry = parseFloat(historicalData[i].close);
                const exit = parseFloat(historicalData[i + 15].close);
                const wasWin = (signal.signal.includes('CALL') && exit > entry) || (signal.signal.includes('PUT') && exit < entry);
                if (wasWin) correct++;
                const profit = (balance * 0.02) * (wasWin ? 0.72 : -0.85);
                balance += profit;
                trades.push({ wasWin, profitPercent: (profit / (balance - profit)) * 100 });
            }
        }
        const wins = trades.filter(t => t.wasWin).length;
        return { summary: { totalTrades: trades.length, winRate: trades.length ? (wins / trades.length) * 100 : 0, finalBalance: balance, signalAccuracy: total ? (correct / total) * 100 : 0 } };
    }

    recordTradeResult(result) {
        this.tradeHistory.push(result);
        const recent = this.tradeHistory.slice(-50);
        const wins = recent.filter(t => t.wasWin).length;
        this.performance.winRate = recent.length ? wins / recent.length : 0.65;
        this.performance.totalTrades = this.tradeHistory.length;
        if (result.wasWin) {
            this.performance.consecutiveWins++;
            this.performance.consecutiveLosses = 0;
        } else {
            this.performance.consecutiveLosses++;
            this.performance.consecutiveWins = 0;
        }
        return this.performance;
    }

    getPerformanceStats() { return this.performance; }
}

const analyzer = new ProfessionalAnalyzer();

module.exports = {
    analyzeSignal: (data, config) => analyzer.analyzeSignal(data, config),
    runBacktest: (data, balance) => analyzer.runBacktest(data, balance),
    recordTradeResult: (result) => analyzer.recordTradeResult(result),
    getPerformanceStats: () => analyzer.getPerformanceStats()
};
