const priceFetcher = require('./pricefetcher');

class SignalAnalyzer {
    async analyzePair(pair, timeframe = '5m') {
        const candles = await priceFetcher.fetchOHLCV(pair.symbol, timeframe, 100);
        if (!candles || candles.length < 50) return this.neutral(pair.name, timeframe, 'Insufficient data');

        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const volumes = candles.map(c => c.volume);
        const n = closes.length;

        // Volume spike detection
        const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const currentVolume = volumes[volumes.length - 1];
        const volumeSpike = currentVolume > avgVolume * 1.5;

        // RSI (7)
        let rsi = 50;
        try {
            let gains = 0, losses = 0;
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
        } catch(e) { rsi = 50; }

        // EMA (9, 21)
        const ema9 = this.calcEMA(closes, 9);
        const ema21 = this.calcEMA(closes, 21);
        const currentEma9 = ema9[ema9.length - 1];
        const currentEma21 = ema21[ema21.length - 1];
        const prevEma9 = ema9[ema9.length - 2];
        const prevEma21 = ema21[ema21.length - 2];

        // MACD (12, 26, 9)
        const ema12 = this.calcEMA(closes, 12);
        const ema26 = this.calcEMA(closes, 26);
        const macdLine = ema12.map((v, i) => v - ema26[i]);
        const macdSignal = this.calcEMA(macdLine, 9);
        const currentMacd = macdLine[macdLine.length - 1];
        const currentSignal = macdSignal[macdSignal.length - 1];
        const prevMacd = macdLine[macdLine.length - 2];
        const prevSignal = macdSignal[macdSignal.length - 2];

        // ADX (14)
        let adx = 20, plusDI = 25, minusDI = 25;
        try {
            const tr = [], plusDM = [], minusDM = [];
            for (let i = 1; i < n; i++) {
                tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
                const up = highs[i] - highs[i-1], down = lows[i-1] - lows[i];
                plusDM.push(up > down && up > 0 ? up : 0);
                minusDM.push(down > up && down > 0 ? down : 0);
            }
            let atr = tr.slice(0,14).reduce((a,b)=>a+b,0)/14;
            plusDI = plusDM.slice(0,14).reduce((a,b)=>a+b,0)/14;
            minusDI = minusDM.slice(0,14).reduce((a,b)=>a+b,0)/14;
            adx = 100 * Math.abs(plusDI - minusDI) / (plusDI + minusDI || 1);
            for (let i = 14; i < tr.length; i++) {
                atr = (atr*13 + tr[i])/14;
                plusDI = (plusDI*13 + plusDM[i])/14;
                minusDI = (minusDI*13 + minusDM[i])/14;
                adx = 100 * Math.abs(plusDI - minusDI) / (plusDI + minusDI || 1);
            }
        } catch(e) { adx = 20; }

        const reasons = [];
        let direction = 'NEUTRAL';
        let confidence = 0;
        let expiry = timeframe === '1m' ? '3 min' : timeframe === '5m' ? '10 min' : '1 hour';
        let suggestedStake = '$5 – $10 (1-2% of balance)';

        // ADX FILTER: No signal in ranging markets
        if (adx < 20) {
            reasons.push(`⚠️ ADX ${adx.toFixed(1)} < 20 – ranging market, no signal`);
            reasons.push(`💡 Wait for ADX > 20 before trading`);
            return { pair: pair.name, direction: 'NEUTRAL', confidence: 0, reasons, rsi: Math.round(rsi), adx: Math.round(adx), timeframe, expiry, suggestedStake };
        }

        const isUptrend = currentEma9 > currentEma21;
        const isDowntrend = currentEma9 < currentEma21;
        const emaBull = currentEma9 > currentEma21 && prevEma9 <= prevEma21;
        const emaBear = currentEma9 < currentEma21 && prevEma9 >= prevEma21;
        const macdBull = currentMacd > currentSignal && prevMacd <= prevSignal;
        const macdBear = currentMacd < currentSignal && prevMacd >= prevSignal;

        // STRATEGY: RSI Extreme + Confirmation
        if (rsi < 30 && (isUptrend || emaBull || macdBull)) {
            direction = 'CALL';
            confidence = Math.min(98, 85 + Math.floor((30 - rsi) / 2));
            if (volumeSpike) confidence = Math.min(98, confidence + 5);
            reasons.push(`✅ RSI oversold (${rsi.toFixed(1)}) + uptrend confirmation`);
            if (volumeSpike) reasons.push(`✅ Volume spike confirms momentum`);
        } else if (rsi > 70 && (isDowntrend || emaBear || macdBear)) {
            direction = 'PUT';
            confidence = Math.min(98, 85 + Math.floor((rsi - 70) / 2));
            if (volumeSpike) confidence = Math.min(98, confidence + 5);
            reasons.push(`✅ RSI overbought (${rsi.toFixed(1)}) + downtrend confirmation`);
            if (volumeSpike) reasons.push(`✅ Volume spike confirms momentum`);
        } else if (adx > 30 && isUptrend && plusDI > minusDI + 10) {
            direction = 'CALL';
            confidence = 78;
            reasons.push(`✅ Strong uptrend (ADX ${adx.toFixed(1)}, DMI+ ${plusDI.toFixed(1)})`);
        } else if (adx > 30 && isDowntrend && minusDI > plusDI + 10) {
            direction = 'PUT';
            confidence = 78;
            reasons.push(`✅ Strong downtrend (ADX ${adx.toFixed(1)}, DMI- ${minusDI.toFixed(1)})`);
        } else {
            reasons.push(`❌ No clear setup – RSI ${rsi.toFixed(1)}, ADX ${adx.toFixed(1)}`);
            return { pair: pair.name, direction: 'NEUTRAL', confidence: 0, reasons, rsi: Math.round(rsi), adx: Math.round(adx), timeframe, expiry, suggestedStake };
        }

        confidence = Math.max(70, Math.min(98, confidence));
        reasons.push(`💡 Suggested stake: ${suggestedStake}`);
        reasons.push(`⏱️ Expiry: ${expiry}`);

        return { pair: pair.name, direction, confidence, reasons: reasons.slice(0, 5), rsi: Math.round(rsi), adx: Math.round(adx), timeframe, expiry, suggestedStake };
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

    neutral(pair, timeframe, reason) {
        return { pair, direction: 'NEUTRAL', confidence: 0, reasons: [reason], rsi: 50, adx: 20, timeframe, expiry: 'N/A', suggestedStake: 'N/A' };
    }
}
module.exports = new SignalAnalyzer();
