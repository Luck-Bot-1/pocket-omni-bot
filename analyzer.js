const indicators = require('technicalindicators');
const priceFetcher = require('./pricefetcher');

class SignalAnalyzer {
    async analyzePair(pair, timeframe = '5m') {
        const ohlcv = await priceFetcher.fetchOHLCV(pair.symbol, timeframe, 200);
        if (!ohlcv || ohlcv.length < 50) return null;

        const closes = ohlcv.map(c => c.close);
        const highs = ohlcv.map(c => c.high);
        const lows = ohlcv.map(c => c.low);

        const rsi = indicators.RSI.calculate({ values: closes, period: 7 });
        const macd = indicators.MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
        const ema9 = indicators.SMA.calculate({ values: closes, period: 9 });
        const ema21 = indicators.SMA.calculate({ values: closes, period: 21 });
        const adx = indicators.ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
        const stoch = indicators.Stochastic.calculate({ high: highs, low: lows, close: closes, period: 14, signalPeriod: 3 });

        const cur = {
            rsi: rsi[rsi.length-1],
            macd: macd[macd.length-1].MACD,
            signal: macd[macd.length-1].signal,
            hist: macd[macd.length-1].histogram,
            ema9: ema9[ema9.length-1],
            ema21: ema21[ema21.length-1],
            adx: adx[adx.length-1].adx,
            plusDI: adx[adx.length-1].plusDI,
            minusDI: adx[adx.length-1].minusDI,
            stochK: stoch[stoch.length-1].k
        };
        const prev = {
            rsi: rsi[rsi.length-2],
            macd: macd[macd.length-2].MACD,
            signal: macd[macd.length-2].signal,
            ema9: ema9[ema9.length-2]
        };

        let score = 0, reasons = [], direction = 'NEUTRAL';

        if (cur.rsi < 30) { score += 30; reasons.push(`RSI oversold (${cur.rsi.toFixed(1)})`); direction = 'CALL'; }
        else if (cur.rsi > 70) { score += 30; reasons.push(`RSI overbought (${cur.rsi.toFixed(1)})`); direction = 'PUT'; }

        const macdBull = cur.macd > cur.signal && prev.macd <= prev.signal;
        const macdBear = cur.macd < cur.signal && prev.macd >= prev.signal;
        if (macdBull) { score += 25; reasons.push('MACD bullish cross'); direction = 'CALL'; }
        else if (macdBear) { score += 25; reasons.push('MACD bearish cross'); direction = 'PUT'; }

        if (cur.ema9 > cur.ema21 && prev.ema9 <= prev.ema21) { score += 20; reasons.push('EMA9 crossed above EMA21'); direction = 'CALL'; }
        else if (cur.ema9 < cur.ema21 && prev.ema9 >= prev.ema21) { score += 20; reasons.push('EMA9 crossed below EMA21'); direction = 'PUT'; }

        if (cur.adx > 25) {
            score += 15; reasons.push(`ADX ${cur.adx.toFixed(1)} strong trend`);
            if (cur.plusDI > cur.minusDI) direction = (direction === 'PUT') ? 'NEUTRAL' : 'CALL';
            else if (cur.minusDI > cur.plusDI) direction = (direction === 'CALL') ? 'NEUTRAL' : 'PUT';
        }

        if (cur.stochK < 20) { score += 10; reasons.push('Stochastic oversold'); if (direction !== 'PUT') direction = 'CALL'; }
        else if (cur.stochK > 80) { score += 10; reasons.push('Stochastic overbought'); if (direction !== 'CALL') direction = 'PUT'; }

        if (direction === 'NEUTRAL' || score < 40) return null;

        const confidence = Math.min(98, Math.max(70, score + (cur.adx > 25 ? 5 : 0)));
        
        // Prepare last 40 candles for chart
        const lastCandles = ohlcv.slice(-40);
        const ema9Values = this.calculateEMA(lastCandles.map(c => c.close), 9);
        const ema21Values = this.calculateEMA(lastCandles.map(c => c.close), 21);

        return {
            pair: pair.name,
            direction,
            confidence,
            reasons: reasons.slice(0,4),
            rsi: Math.round(cur.rsi),
            adx: Math.round(cur.adx),
            timeframe,
            candles: lastCandles,
            ema9: ema9Values,
            ema21: ema21Values
        };
    }

    calculateEMA(values, period) {
        const k = 2 / (period + 1);
        let ema = values[0];
        const result = [ema];
        for (let i = 1; i < values.length; i++) {
            ema = values[i] * k + ema * (1 - k);
            result.push(ema);
        }
        return result;
    }
}
module.exports = new SignalAnalyzer();
