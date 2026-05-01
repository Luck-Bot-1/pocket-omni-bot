// analyzer.js – Real technical indicators, always returns a signal
const indicators = require('technicalindicators');
const priceFetcher = require('./pricefetcher');

class SignalAnalyzer {
    async analyzePair(pair, timeframe = '5m') {
        try {
            // Fetch OHLCV data (mock or real)
            const ohlcv = await priceFetcher.fetchOHLCV(pair.symbol, timeframe, 200);
            if (!ohlcv || ohlcv.length < 50) {
                console.log(`⚠️ No data for ${pair.symbol}`);
                return null;
            }

            const closes = ohlcv.map(c => c.close);
            const highs = ohlcv.map(c => c.high);
            const lows = ohlcv.map(c => c.low);

            // Calculate all indicators
            const rsi = indicators.RSI.calculate({ values: closes, period: 7 });
            const macd = indicators.MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
            const ema9 = indicators.SMA.calculate({ values: closes, period: 9 });
            const ema21 = indicators.SMA.calculate({ values: closes, period: 21 });
            const adx = indicators.ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
            const stoch = indicators.Stochastic.calculate({ high: highs, low: lows, close: closes, period: 14, signalPeriod: 3 });

            // Ensure we have valid values
            if (!rsi.length || !macd.length || !ema9.length || !ema21.length || !adx.length || !stoch.length) {
                console.log(`⚠️ Indicator calculation failed for ${pair.symbol}`);
                return null;
            }

            const cur = {
                rsi: rsi[rsi.length - 1],
                macd: macd[macd.length - 1].MACD,
                signal: macd[macd.length - 1].signal,
                hist: macd[macd.length - 1].histogram,
                ema9: ema9[ema9.length - 1],
                ema21: ema21[ema21.length - 1],
                adx: adx[adx.length - 1].adx,
                plusDI: adx[adx.length - 1].plusDI,
                minusDI: adx[adx.length - 1].minusDI,
                stochK: stoch[stoch.length - 1].k,
                stochD: stoch[stoch.length - 1].d
            };
            const prev = {
                macd: macd[macd.length - 2]?.MACD || cur.macd,
                signal: macd[macd.length - 2]?.signal || cur.signal,
                ema9: ema9[ema9.length - 2] || cur.ema9,
                ema21: ema21[ema21.length - 2] || cur.ema21
            };

            let score = 0;
            const reasons = [];
            let direction = 'NEUTRAL';

            // RSI (30% weight)
            if (cur.rsi < 30) {
                score += 30;
                reasons.push(`RSI oversold (${cur.rsi.toFixed(1)}) – bullish reversal`);
                direction = 'CALL';
            } else if (cur.rsi > 70) {
                score += 30;
                reasons.push(`RSI overbought (${cur.rsi.toFixed(1)}) – bearish reversal`);
                direction = 'PUT';
            } else if (cur.rsi < 40) {
                score += 15;
                reasons.push(`RSI rising from low (${cur.rsi.toFixed(1)})`);
                direction = direction === 'NEUTRAL' ? 'CALL' : direction;
            } else if (cur.rsi > 60) {
                score += 15;
                reasons.push(`RSI falling from high (${cur.rsi.toFixed(1)})`);
                direction = direction === 'NEUTRAL' ? 'PUT' : direction;
            }

            // MACD (25% weight)
            const macdBullish = cur.macd > cur.signal && prev.macd <= prev.signal;
            const macdBearish = cur.macd < cur.signal && prev.macd >= prev.signal;
            if (macdBullish) {
                score += 25;
                reasons.push('MACD bullish crossover');
                direction = 'CALL';
            } else if (macdBearish) {
                score += 25;
                reasons.push('MACD bearish crossover');
                direction = 'PUT';
            } else if (cur.macd > cur.signal) {
                score += 12;
                reasons.push('MACD above signal (bullish momentum)');
                if (direction === 'NEUTRAL') direction = 'CALL';
            } else if (cur.macd < cur.signal) {
                score += 12;
                reasons.push('MACD below signal (bearish momentum)');
                if (direction === 'NEUTRAL') direction = 'PUT';
            }

            // EMA cross (20% weight)
            const emaBullish = cur.ema9 > cur.ema21 && prev.ema9 <= prev.ema21;
            const emaBearish = cur.ema9 < cur.ema21 && prev.ema9 >= prev.ema21;
            if (emaBullish) {
                score += 20;
                reasons.push('EMA9 crossed above EMA21 (uptrend)');
                direction = 'CALL';
            } else if (emaBearish) {
                score += 20;
                reasons.push('EMA9 crossed below EMA21 (downtrend)');
                direction = 'PUT';
            } else if (cur.ema9 > cur.ema21) {
                score += 10;
                reasons.push('EMA9 above EMA21 – bullish alignment');
                if (direction === 'NEUTRAL') direction = 'CALL';
            } else if (cur.ema9 < cur.ema21) {
                score += 10;
                reasons.push('EMA9 below EMA21 – bearish alignment');
                if (direction === 'NEUTRAL') direction = 'PUT';
            }

            // ADX trend strength (15% weight)
            if (cur.adx > 25) {
                score += 15;
                reasons.push(`Strong trend (ADX: ${cur.adx.toFixed(1)})`);
                if (cur.plusDI > cur.minusDI) {
                    reasons.push('DMI+ dominant (bullish trend)');
                    if (direction === 'NEUTRAL') direction = 'CALL';
                } else if (cur.minusDI > cur.plusDI) {
                    reasons.push('DMI- dominant (bearish trend)');
                    if (direction === 'NEUTRAL') direction = 'PUT';
                }
            } else if (cur.adx > 20) {
                score += 8;
                reasons.push(`Developing trend (ADX: ${cur.adx.toFixed(1)})`);
            }

            // Stochastic (10% weight)
            if (cur.stochK < 20) {
                score += 10;
                reasons.push('Stochastic oversold – bounce expected');
                if (direction === 'NEUTRAL') direction = 'CALL';
                else if (direction === 'PUT') direction = 'NEUTRAL';
            } else if (cur.stochK > 80) {
                score += 10;
                reasons.push('Stochastic overbought – pullback expected');
                if (direction === 'NEUTRAL') direction = 'PUT';
                else if (direction === 'CALL') direction = 'NEUTRAL';
            }

            // Final decision
            if (direction === 'NEUTRAL' || score < 40) {
                // If still neutral, use RSI-based fallback
                if (cur.rsi < 45) direction = 'CALL';
                else if (cur.rsi > 55) direction = 'PUT';
                else return null;
            }

            // Confidence score (scaled 70-98)
            let confidence = Math.min(98, Math.max(70, score + (cur.adx > 25 ? 5 : 0)));

            // Prepare chart data (last 40 candles)
            const lastCandles = ohlcv.slice(-40);
            const closesLast = lastCandles.map(c => c.close);
            const ema9Values = this.calculateEMA(closesLast, 9);
            const ema21Values = this.calculateEMA(closesLast, 21);

            return {
                pair: pair.name,
                direction,
                confidence,
                reasons: reasons.slice(0, 4),
                rsi: Math.round(cur.rsi),
                adx: Math.round(cur.adx),
                timeframe,
                candles: lastCandles,
                ema9: ema9Values,
                ema21: ema21Values
            };
        } catch (err) {
            console.error(`Analyzer error for ${pair.name}:`, err.message);
            return null;
        }
    }

    calculateEMA(values, period) {
        if (!values.length) return [];
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
