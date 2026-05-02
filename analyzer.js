const priceFetcher = require('./pricefetcher');

class SignalAnalyzer {
    async analyzePair(pair, timeframe = '5m') {
        const candles = await priceFetcher.fetchOHLCV(pair.symbol, timeframe, 100);
        if (!candles || candles.length < 50) return this.getNeutralSignal(pair.name, timeframe, 'Insufficient data');

        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const n = closes.length;

        // ========== RSI (7) ==========
        let gains = 0, losses = 0;
        let rsi = 50; // default
        try {
            for (let i = n - 7; i < n; i++) {
                const diff = closes[i] - closes[i - 1];
                if (diff >= 0) gains += diff;
                else losses -= diff;
            }
            let avgGain = gains / 7, avgLoss = losses / 7;
            rsi = 100 - 100 / (1 + avgGain / (avgLoss || 0.001));
            for (let i = n - 6; i < n; i++) {
                const diff = closes[i] - closes[i - 1];
                avgGain = (avgGain * 6 + Math.max(diff, 0)) / 7;
                avgLoss = (avgLoss * 6 + Math.max(-diff, 0)) / 7;
                rsi = 100 - 100 / (1 + avgGain / (avgLoss || 0.001));
            }
        } catch(e) {
            rsi = 50;
        }

        // ========== EMA (9, 21) ==========
        const ema9 = this.calcEMA(closes, 9);
        const ema21 = this.calcEMA(closes, 21);
        const currentEma9 = ema9[ema9.length - 1];
        const currentEma21 = ema21[ema21.length - 1];
        const prevEma9 = ema9[ema9.length - 2];
        const prevEma21 = ema21[ema21.length - 2];

        // ========== MACD (12, 26, 9) ==========
        const ema12 = this.calcEMA(closes, 12);
        const ema26 = this.calcEMA(closes, 26);
        const macdLine = ema12.map((v, i) => v - ema26[i]);
        const macdSignal = this.calcEMA(macdLine, 9);
        const currentMacd = macdLine[macdLine.length - 1];
        const currentSignal = macdSignal[macdSignal.length - 1];
        const prevMacd = macdLine[macdLine.length - 2];
        const prevSignal = macdSignal[macdSignal.length - 2];

        // ========== ADX (14) ==========
        let adx = 20;
        try {
            const tr = [], plusDM = [], minusDM = [];
            for (let i = 1; i < n; i++) {
                tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
                const upMove = highs[i] - highs[i - 1];
                const downMove = lows[i - 1] - lows[i];
                plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
                minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
            }
            let atr = tr.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
            let plusDI = plusDM.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
            let minusDI = minusDM.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
            adx = 100 * Math.abs(plusDI - minusDI) / (plusDI + minusDI || 1);
            for (let i = 14; i < tr.length; i++) {
                atr = (atr * 13 + tr[i]) / 14;
                plusDI = (plusDI * 13 + plusDM[i]) / 14;
                minusDI = (minusDI * 13 + minusDM[i]) / 14;
                adx = 100 * Math.abs(plusDI - minusDI) / (plusDI + minusDI || 1);
            }
        } catch(e) {
            adx = 20;
        }

        // ========== DECISION LOGIC ==========
        const reasons = [];

        // ADX FILTER: No signal in ranging markets (ADX < 20)
        if (adx < 20) {
            reasons.push(`⚠️ ADX ${adx.toFixed(1)} < 20 – ranging market, no signal`);
            return { pair: pair.name, direction: 'NEUTRAL', confidence: 0, reasons, rsi: Math.round(rsi), adx: Math.round(adx), timeframe };
        }

        const isUptrend = currentEma9 > currentEma21;
        const isDowntrend = currentEma9 < currentEma21;
        const emaBullishCross = currentEma9 > currentEma21 && prevEma9 <= prevEma21;
        const emaBearishCross = currentEma9 < currentEma21 && prevEma9 >= prevEma21;
        const macdBullishCross = currentMacd > currentSignal && prevMacd <= prevSignal;
        const macdBearishCross = currentMacd < currentSignal && prevMacd >= prevSignal;
        const isStrongTrend = adx > 25;
        const plusDI = 30, minusDI = 20; // simplified for brevity

        // RSI EXTREME + CONFIRMATION
        if (rsi < 30 && (isUptrend || emaBullishCross || macdBullishCross)) {
            const confidence = Math.min(98, 85 + Math.floor((30 - rsi) / 2));
            reasons.push(`✅ RSI oversold (${rsi.toFixed(1)}) + uptrend confirmation`);
            return { pair: pair.name, direction: 'CALL', confidence, reasons: reasons.slice(0, 4), rsi: Math.round(rsi), adx: Math.round(adx), timeframe };
        } else if (rsi > 70 && (isDowntrend || emaBearishCross || macdBearishCross)) {
            const confidence = Math.min(98, 85 + Math.floor((rsi - 70) / 2));
            reasons.push(`✅ RSI overbought (${rsi.toFixed(1)}) + downtrend confirmation`);
            return { pair: pair.name, direction: 'PUT', confidence, reasons: reasons.slice(0, 4), rsi: Math.round(rsi), adx: Math.round(adx), timeframe };
        }
        // STRONG TREND FOLLOWING
        else if (adx > 30 && isUptrend) {
            reasons.push(`✅ Strong uptrend (ADX ${adx.toFixed(1)})`);
            return { pair: pair.name, direction: 'CALL', confidence: 78, reasons: reasons.slice(0, 4), rsi: Math.round(rsi), adx: Math.round(adx), timeframe };
        } else if (adx > 30 && isDowntrend) {
            reasons.push(`✅ Strong downtrend (ADX ${adx.toFixed(1)})`);
            return { pair: pair.name, direction: 'PUT', confidence: 78, reasons: reasons.slice(0, 4), rsi: Math.round(rsi), adx: Math.round(adx), timeframe };
        } else {
            reasons.push(`❌ No clear setup – RSI ${rsi.toFixed(1)}, ADX ${adx.toFixed(1)}`);
            return { pair: pair.name, direction: 'NEUTRAL', confidence: 0, reasons, rsi: Math.round(rsi), adx: Math.round(adx), timeframe };
        }
    }

    calcEMA(values, period) {
        const k = 2 / (period + 1);
        let ema = values[0];
        const result = [ema];
        for (let i = 1; i < values.length; i++) {
            ema = values[i] * k + ema * (1 - k);
            result.push(ema);
        }
        return result;
    }

    getNeutralSignal(pair, timeframe, reason) {
        return {
            pair: pair, direction: 'NEUTRAL', confidence: 0,
            reasons: [reason], rsi: 50, adx: 20, timeframe
        };
    }
}
module.exports = new SignalAnalyzer();
