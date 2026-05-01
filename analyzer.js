const indicators = require('technicalindicators');
const priceFetcher = require('./pricefetcher');

class SignalAnalyzer {
    constructor() {
        this.minDataPoints = 50;
    }

    async analyzePair(pair, timeframe = '5m', multiTF = true) {
        try {
            const intervalMap = { '1m':'1m','5m':'5m','15m':'15m','30m':'30m','1h':'1h','4h':'4h','1d':'1d' };
            const ohlcv = await priceFetcher.fetchOHLCV(pair.symbol, intervalMap[timeframe] || '5m', 200);
            if (!ohlcv || ohlcv.length < this.minDataPoints) return null;

            const closes = ohlcv.map(c => c.close);
            const highs = ohlcv.map(c => c.high);
            const lows = ohlcv.map(c => c.low);
            const volumes = ohlcv.map(c => c.volume);

            // Indicators
            const rsi = indicators.RSI.calculate({ values: closes, period: 7 });
            const macd = indicators.MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
            const ema9 = indicators.SMA.calculate({ values: closes, period: 9 });
            const ema21 = indicators.SMA.calculate({ values: closes, period: 21 });
            const bb = indicators.BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
            const adx = indicators.ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
            const stoch = indicators.Stochastic.calculate({ high: highs, low: lows, close: closes, period: 14, signalPeriod: 3 });

            if (!rsi || !macd || !ema9 || !ema21 || !bb || !adx || !stoch) return null;

            const current = {
                rsi: rsi[rsi.length-1],
                macd: macd[macd.length-1].MACD,
                macdSignal: macd[macd.length-1].signal,
                macdHistogram: macd[macd.length-1].histogram,
                ema9: ema9[ema9.length-1],
                ema21: ema21[ema21.length-1],
                bbUpper: bb[bb.length-1].upper,
                bbLower: bb[bb.length-1].lower,
                adx: adx[adx.length-1].adx,
                dmiPlus: adx[adx.length-1].plusDI,
                dmiMinus: adx[adx.length-1].minusDI,
                stochK: stoch[stoch.length-1].k,
                stochD: stoch[stoch.length-1].d,
                price: closes[closes.length-1]
            };
            const prev = {
                rsi: rsi[rsi.length-2],
                macd: macd[macd.length-2].MACD,
                macdSignal: macd[macd.length-2].signal,
                ema9: ema9[ema9.length-2]
            };

            // Scoring
            let bull = 0, bear = 0, conf = 0, reasons = [];

            if (current.rsi < 30) { bull+=30; conf+=20; reasons.push(`RSI oversold ${current.rsi.toFixed(1)}`); }
            else if (current.rsi > 70) { bear+=30; conf+=20; reasons.push(`RSI overbought ${current.rsi.toFixed(1)}`); }
            else if (current.rsi < 40) { bull+=15; conf+=10; reasons.push(`RSI rising ${current.rsi.toFixed(1)}`); }
            else if (current.rsi > 60) { bear+=15; conf+=10; reasons.push(`RSI falling ${current.rsi.toFixed(1)}`); }

            const macdCrossUp = (current.macd > current.macdSignal && prev.macd <= prev.macdSignal);
            const macdCrossDown = (current.macd < current.macdSignal && prev.macd >= prev.macdSignal);
            if (macdCrossUp) { bull+=25; conf+=25; reasons.push('MACD bullish cross'); }
            else if (macdCrossDown) { bear+=25; conf+=25; reasons.push('MACD bearish cross'); }
            else if (current.macdHistogram > 0 && current.macdHistogram > prev.macdHistogram) { bull+=12; conf+=12; reasons.push('MACD histogram rising'); }
            else if (current.macdHistogram < 0 && current.macdHistogram < prev.macdHistogram) { bear+=12; conf+=12; reasons.push('MACD histogram falling'); }

            if (current.ema9 > current.ema21 && prev.ema9 <= prev.ema21) { bull+=20; conf+=20; reasons.push('EMA9 crossed above EMA21'); }
            else if (current.ema9 < current.ema21 && prev.ema9 >= prev.ema21) { bear+=20; conf+=20; reasons.push('EMA9 crossed below EMA21'); }
            else if (current.ema9 > current.ema21) { bull+=10; conf+=10; reasons.push('EMA9 above EMA21'); }
            else if (current.ema9 < current.ema21) { bear+=10; conf+=10; reasons.push('EMA9 below EMA21'); }

            if (current.adx > 25) {
                conf+=10; reasons.push(`ADX ${current.adx.toFixed(1)} strong trend`);
                if (current.dmiPlus > current.dmiMinus) { bull+=10; conf+=5; reasons.push('DMI+ dominant'); }
                else if (current.dmiMinus > current.dmiPlus) { bear+=10; conf+=5; reasons.push('DMI- dominant'); }
            }

            if (current.stochK < 20 && stoch[stoch.length-2].k <= 20) { bull+=10; conf+=10; reasons.push('Stochastic oversold'); }
            else if (current.stochK > 80 && stoch[stoch.length-2].k >= 80) { bear+=10; conf+=10; reasons.push('Stochastic overbought'); }

            let direction = 'NEUTRAL';
            if (bull > bear && bull >= 35) direction = 'CALL';
            else if (bear > bull && bear >= 35) direction = 'PUT';
            else conf = Math.max(40, conf-20);
            conf = Math.min(98, Math.max(0, conf));

            if (direction !== 'NEUTRAL' && conf >= (pair.min_confidence || 75))
                return {
                    pair: pair.name, direction, confidence: Math.round(conf), reasons: reasons.slice(0,4),
                    rsi: Math.round(current.rsi), adx: Math.round(current.adx), timeframe
                };
            return null;
        } catch(e) { console.error('Analyzer error:', e.message); return null; }
    }
}
module.exports = new SignalAnalyzer();
