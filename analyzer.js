const indicators = require('technicalindicators');
const priceFetcher = require('./pricefetcher');

class SignalAnalyzer {
    constructor() {
        this.minDataPoints = 100;
    }

    async analyzePair(pair, timeframe = '5m', multiTF = true) {
        try {
            const ohlcv = await priceFetcher.fetchOHLCV(pair.symbol, timeframe, 300);
            
            if (!ohlcv || ohlcv.length < this.minDataPoints) {
                return null;
            }

            const closes = ohlcv.map(c => c.close);
            const highs = ohlcv.map(c => c.high);
            const lows = ohlcv.map(c => c.low);
            const volumes = ohlcv.map(c => c.volume);

            // Multi-timeframe analysis
            let multiTFSignal = null;
            if (multiTF) {
                multiTFSignal = await this.checkMultiTimeframe(pair);
                if (multiTFSignal && multiTFSignal.agreement < 2) {
                    return null;
                }
            }

            // Calculate indicators
            const rsi = this.calculateRSI(closes, 7);
            const macd = this.calculateMACD(closes);
            const ema9 = this.calculateEMA(closes, 9);
            const ema21 = this.calculateEMA(closes, 21);
            const bb = this.calculateBollingerBands(closes);
            const adx = this.calculateADX(highs, lows, closes, 14);
            const stoch = this.calculateStochastic(highs, lows, closes);
            const volumeProfile = this.analyzeVolume(volumes);
            
            if (!rsi || !macd || !ema9 || !ema21 || !bb || !adx || !stoch) {
                return null;
            }
            
            const current = {
                rsi: rsi[rsi.length - 1],
                macd: macd.MACD[macd.MACD.length - 1],
                macdSignal: macd.signal[macd.signal.length - 1],
                macdHistogram: macd.MACD_Histogram[macd.MACD_Histogram.length - 1],
                ema9: ema9[ema9.length - 1],
                ema21: ema21[ema21.length - 1],
                bbUpper: bb.upper[bb.upper.length - 1],
                bbLower: bb.lower[bb.lower.length - 1],
                adx: adx.adx[adx.adx.length - 1],
                dmiPlus: adx.plusDI[adx.plusDI.length - 1],
                dmiMinus: adx.minusDI[adx.minusDI.length - 1],
                stochK: stoch.k[stoch.k.length - 1],
                stochD: stoch.d[stoch.d.length - 1],
                volumeRatio: volumeProfile.ratio,
                price: closes[closes.length - 1]
            };

            const prev = {
                rsi: rsi[rsi.length - 2],
                macd: macd.MACD[macd.MACD.length - 2],
                macdSignal: macd.signal[macd.signal.length - 2],
                ema9: ema9[ema9.length - 2],
                ema21: ema21[ema21.length - 2],
                stochK: stoch.k[stoch.k.length - 2]
            };

            const minConfidence = pair.min_confidence || 75;
            const signal = this.generateSignal(current, prev, minConfidence);
            
            if (signal && signal.confidence >= minConfidence) {
                return {
                    pair: pair.name,
                    type: pair.type,
                    direction: signal.direction,
                    confidence: signal.confidence,
                    reasons: signal.reasons,
                    rsi: Math.round(current.rsi),
                    adx: Math.round(current.adx),
                    price: current.price,
                    timeframe: timeframe,
                    multiTFAgreement: multiTFSignal ? multiTFSignal.agreement : 1,
                    timestamp: new Date()
                };
            }
            return null;
        } catch (error) {
            console.error(`Error analyzing ${pair.name}:`, error.message);
            return null;
        }
    }

    calculateRSI(values, period) {
        try {
            return indicators.RSI.calculate({ values, period });
        } catch (error) {
            return null;
        }
    }

    calculateMACD(values) {
        try {
            return indicators.MACD.calculate({
                values,
                fastPeriod: 12,
                slowPeriod: 26,
                signalPeriod: 9,
                SimpleMAOscillator: false,
                SimpleMASignal: false
            });
        } catch (error) {
            return null;
        }
    }

    calculateEMA(values, period) {
        try {
            return indicators.SMA.calculate({ values, period });
        } catch (error) {
            return null;
        }
    }

    calculateBollingerBands(values) {
        try {
            return indicators.BollingerBands.calculate({
                values,
                period: 20,
                stdDev: 2
            });
        } catch (error) {
            return null;
        }
    }

    calculateADX(high, low, close, period) {
        try {
            return indicators.ADX.calculate({ high, low, close, period });
        } catch (error) {
            return null;
        }
    }

    calculateStochastic(high, low, close) {
        try {
            return indicators.Stochastic.calculate({
                high,
                low,
                close,
                period: 14,
                signalPeriod: 3
            });
        } catch (error) {
            return null;
        }
    }

    analyzeVolume(volumes) {
        try {
            const volumeMA = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
            const currentVolume = volumes[volumes.length - 1];
            const ratio = currentVolume / volumeMA;
            return { ratio, spike: ratio > 1.5, dry: ratio < 0.5 };
        } catch (error) {
            return { ratio: 1, spike: false, dry: false };
        }
    }

    generateSignal(current, prev, minConfidence) {
        let confidence = 0;
        const reasons = [];
        let bullishScore = 0;
        let bearishScore = 0;

        // RSI (30%)
        if (current.rsi < 30) {
            bullishScore += 30;
            confidence += 20;
            reasons.push(`RSI oversold: ${current.rsi.toFixed(1)}`);
        } else if (current.rsi > 70) {
            bearishScore += 30;
            confidence += 20;
            reasons.push(`RSI overbought: ${current.rsi.toFixed(1)}`);
        } else if (current.rsi < 40) {
            bullishScore += 15;
            confidence += 10;
            reasons.push(`RSI rising: ${current.rsi.toFixed(1)}`);
        } else if (current.rsi > 60) {
            bearishScore += 15;
            confidence += 10;
            reasons.push(`RSI falling: ${current.rsi.toFixed(1)}`);
        }

        // MACD (25%)
        const macdBullish = current.macd > current.macdSignal && prev.macd <= prev.macdSignal;
        const macdBearish = current.macd < current.macdSignal && prev.macd >= prev.macdSignal;
        if (macdBullish) {
            bullishScore += 25;
            confidence += 25;
            reasons.push('MACD bullish cross');
        } else if (macdBearish) {
            bearishScore += 25;
            confidence += 25;
            reasons.push('MACD bearish cross');
        } else if (current.macdHistogram > 0 && current.macdHistogram > prev.macdHistogram) {
            bullishScore += 12;
            confidence += 12;
            reasons.push('MACD histogram rising');
        } else if (current.macdHistogram < 0 && current.macdHistogram < prev.macdHistogram) {
            bearishScore += 12;
            confidence += 12;
            reasons.push('MACD histogram falling');
        }

        // EMA (20%)
        if (current.ema9 > current.ema21 && prev.ema9 <= prev.ema21) {
            bullishScore += 20;
            confidence += 20;
            reasons.push('EMA9 crossed above EMA21');
        } else if (current.ema9 < current.ema21 && prev.ema9 >= prev.ema21) {
            bearishScore += 20;
            confidence += 20;
            reasons.push('EMA9 crossed below EMA21');
        } else if (current.ema9 > current.ema21) {
            bullishScore += 10;
            confidence += 10;
            reasons.push('EMA9 above EMA21');
        } else if (current.ema9 < current.ema21) {
            bearishScore += 10;
            confidence += 10;
            reasons.push('EMA9 below EMA21');
        }

        // ADX (15%)
        if (current.adx > 25) {
            confidence += 10;
            reasons.push(`Strong trend (ADX: ${current.adx.toFixed(1)})`);
            if (current.dmiPlus > current.dmiMinus) {
                bullishScore += 10;
                confidence += 5;
                reasons.push('DMI+ dominant');
            } else if (current.dmiMinus > current.dmiPlus) {
                bearishScore += 10;
                confidence += 5;
                reasons.push('DMI- dominant');
            }
        }

        // Stochastic (10%)
        if (current.stochK < 20 && prev.stochK <= 20 && current.stochK > prev.stochK) {
            bullishScore += 10;
            confidence += 10;
            reasons.push('Stochastic bullish divergence');
        } else if (current.stochK > 80 && prev.stochK >= 80 && current.stochK < prev.stochK) {
            bearishScore += 10;
            confidence += 10;
            reasons.push('Stochastic bearish divergence');
        }

        let direction = 'NEUTRAL';
        if (bullishScore > bearishScore && bullishScore >= 35) {
            direction = 'CALL';
        } else if (bearishScore > bullishScore && bearishScore >= 35) {
            direction = 'PUT';
        } else {
            confidence = Math.max(40, confidence - 20);
        }

        confidence = Math.min(98, Math.max(0, confidence));

        if (direction !== 'NEUTRAL' && confidence >= minConfidence) {
            return { direction, confidence, reasons: reasons.slice(0, 5) };
        }
        return null;
    }

    async checkMultiTimeframe(pair) {
        const timeframes = ['1m', '5m', '15m'];
        const signals = [];
        for (const tf of timeframes) {
            try {
                const result = await this.analyzePair(pair, tf, false);
                if (result && result.direction) signals.push(result.direction);
            } catch (error) {}
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (signals.length >= 2 && signals.every(s => s === signals[0])) {
            return { agreement: signals.length, direction: signals[0] };
        }
        return null;
    }
}

module.exports = new SignalAnalyzer();
