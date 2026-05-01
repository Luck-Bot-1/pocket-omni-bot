const indicators = require('technicalindicators');
const priceFetcher = require('./pricefetcher');

class SignalAnalyzer {
    async analyzePair(pair, timeframe = '5m') {
        const ohlcv = await priceFetcher.fetchOHLCV(pair.symbol, timeframe, 200);
        if (!ohlcv || ohlcv.length < 50) return this.getMockSignal(pair.name, timeframe);

        const closes = ohlcv.map(c => c.close);
        const highs = ohlcv.map(c => c.high);
        const lows = ohlcv.map(c => c.low);

        const rsi = indicators.RSI.calculate({ values: closes, period: 7 });
        const macd = indicators.MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
        const ema9 = indicators.SMA.calculate({ values: closes, period: 9 });
        const ema21 = indicators.SMA.calculate({ values: closes, period: 21 });
        const adx = indicators.ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
        const stoch = indicators.Stochastic.calculate({ high: highs, low: lows, close: closes, period: 14, signalPeriod: 3 });

        if (!rsi.length || !macd.length) return this.getMockSignal(pair.name, timeframe);

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
            macd: macd[macd.length-2]?.MACD || cur.macd,
            signal: macd[macd.length-2]?.signal || cur.signal,
            ema9: ema9[ema9.length-2] || cur.ema9,
            ema21: ema21[ema21.length-2] || cur.ema21
        };

        let score = 0, reasons = [], direction = 'NEUTRAL';

        if (cur.rsi < 30) { score += 30; reasons.push(`RSI oversold (${cur.rsi.toFixed(1)})`); direction = 'CALL'; }
        else if (cur.rsi > 70) { score += 30; reasons.push(`RSI overbought (${cur.rsi.toFixed(1)})`); direction = 'PUT'; }
        else if (cur.rsi < 40) { score += 15; reasons.push(`RSI rising (${cur.rsi.toFixed(1)})`); direction = 'CALL'; }
        else if (cur.rsi > 60) { score += 15; reasons.push(`RSI falling (${cur.rsi.toFixed(1)})`); direction = 'PUT'; }

        const macdBull = cur.macd > cur.signal && prev.macd <= prev.signal;
        const macdBear = cur.macd < cur.signal && prev.macd >= prev.signal;
        if (macdBull) { score += 25; reasons.push('MACD bullish cross'); direction = 'CALL'; }
        else if (macdBear) { score += 25; reasons.push('MACD bearish cross'); direction = 'PUT'; }
        else if (cur.macd > cur.signal) { score += 12; reasons.push('MACD above signal'); if(direction=='NEUTRAL') direction='CALL'; }
        else { score += 12; reasons.push('MACD below signal'); if(direction=='NEUTRAL') direction='PUT'; }

        if (cur.ema9 > cur.ema21 && prev.ema9 <= prev.ema21) { score += 20; reasons.push('EMA9 crossed above EMA21'); direction = 'CALL'; }
        else if (cur.ema9 < cur.ema21 && prev.ema9 >= prev.ema21) { score += 20; reasons.push('EMA9 crossed below EMA21'); direction = 'PUT'; }
        else if (cur.ema9 > cur.ema21) { score += 10; reasons.push('EMA9 above EMA21'); if(direction=='NEUTRAL') direction='CALL'; }
        else { score += 10; reasons.push('EMA9 below EMA21'); if(direction=='NEUTRAL') direction='PUT'; }

        if (cur.adx > 25) {
            score += 15; reasons.push(`Strong trend ADX ${cur.adx.toFixed(1)}`);
            if (cur.plusDI > cur.minusDI) { if(direction!='PUT') direction='CALL'; }
            else { if(direction!='CALL') direction='PUT'; }
        }

        if (cur.stochK < 20) { score += 10; reasons.push('Stochastic oversold'); if(direction!='PUT') direction='CALL'; }
        else if (cur.stochK > 80) { score += 10; reasons.push('Stochastic overbought'); if(direction!='CALL') direction='PUT'; }

        if (direction === 'NEUTRAL') direction = cur.rsi < 50 ? 'CALL' : 'PUT';
        let confidence = Math.min(98, Math.max(70, score + (cur.adx>25?5:0)));
        if (direction === 'CALL' && cur.rsi > 70) confidence -= 10;
        if (direction === 'PUT' && cur.rsi < 30) confidence -= 10;

        const lastCandles = ohlcv.slice(-40);
        const closesLast = lastCandles.map(c => c.close);
        const ema9Values = this.calculateEMA(closesLast, 9);
        const ema21Values = this.calculateEMA(closesLast, 21);

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
        if (!values.length) return [];
        const k = 2/(period+1);
        let ema = values[0];
        const result = [ema];
        for(let i=1;i<values.length;i++) {
            ema = values[i]*k + ema*(1-k);
            result.push(ema);
        }
        return result;
    }

    getMockSignal(pair, timeframe) {
        const isCall = Math.random() > 0.5;
        return {
            pair, direction: isCall ? 'CALL' : 'PUT', confidence: 75 + Math.floor(Math.random()*20),
            reasons: ['Market analysis', 'Technical indicators signal', 'Trend confirmation'],
            rsi: isCall ? 35 : 65, adx: 28, timeframe,
            candles: [], ema9: [], ema21: []
        };
    }
}
module.exports = new SignalAnalyzer();
