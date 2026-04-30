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
                    return null; // Not enough timeframe agreement
                }
            }

            // Calculate all indicators
            const rsi = this.calculateRSI(closes, 7);
            const macd = this.calculateMACD(closes);
            const ema9 = this.calculateEMA(closes, 9);
            const ema21 = this.calculateEMA(closes, 21);
            const bb = this.calculateBollingerBands(closes);
            const adx = this.calculateADX(highs, lows, closes, 14);
            const stoch = this.calculateStochastic(highs, lows, closes);
            const volumeProfile = this.analyzeVolume(volumes);
            
            // Check if we have valid indicator values
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
                bbMiddle: bb.middle[bb.middle.length - 1],
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
                stochK: stoch.k[stoch.k.length - 2],
                stochD: stoch.d[stoch.d.length - 2]
            };

            // Generate signal with confidence
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
            console.error('RSI calculation error:', error.message);
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
            console.error('MACD calculation error:', error.message);
            return null;
        }
    }

    calculateEMA(values, period) {
        try {
            return indicators.SMA.calculate({ values, period });
        } catch (error) {
            console.error('EMA calculation error:', error.message);
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
            console.error('Bollinger Bands calculation error:', error.message);
            return null;
        }
    }

    calculateADX(high, low, close, period) {
        try {
            return indicators.ADX.calculate({ high, low, close, period });
        } catch (error) {
            console.error('ADX calculation error:', error.message);
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
            console.error('Stochastic calculation error:', error.message);
            return null;
        }
    }

    analyzeVolume(volumes) {
        try {
            const volumeMA = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
            const currentVolume = volumes[volumes.length - 1];
            const ratio = currentVolume / volumeMA;
            
            return {
                ratio: ratio,
                spike: ratio > 1.5,
                dry: ratio < 0.5
            };
        } catch (error) {
            console.error('Volume analysis error:', error.message);
            return { ratio: 1, spike: false, dry: false };
        }
    }

    generateSignal(current, prev, minConfidence) {
        let confidence = 0;
        const reasons = [];
        let bullishScore = 0;
        let bearishScore = 0;

        // 1. RSI (30% weight)
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
            reasons.push(`RSI rising from low: ${current.rsi.toFixed(1)}`);
        } else if (current.rsi > 60) {
            bearishScore += 15;
            confidence += 10;
            reasons.push(`RSI falling from high: ${current.rsi.toFixed(1)}`);
        } else {
            // Neutral RSI
            confidence += 5;
        }

        // 2. MACD (25% weight)
        const macdBullish = current.macd > current.macdSignal && prev.macd <= prev.macdSignal;
        const macdBearish = current.macd < current.macdSignal && prev.macd >= prev.macdSignal;
        
        if (macdBullish) {
            bullishScore += 25;
            confidence += 25;
            reasons.push('MACD bullish crossover');
        } else if (macdBearish) {
            bearishScore += 25;
            confidence += 25;
            reasons.push('MACD bearish crossover');
        } else if (current.macdHistogram > 0 && current.macdHistogram > prev.macdHistogram) {
            bullishScore += 12;
            confidence += 12;
            reasons.push('MACD histogram rising');
        } else if (current.macdHistogram < 0 && current.macdHistogram < prev.macdHistogram) {
            bearishScore += 12;
            confidence += 12;
            reasons.push('MACD histogram falling');
        } else if (current.macdHistogram > 0) {
            bullishScore += 6;
            confidence += 6;
            reasons.push('MACD positive zone');
        } else if (current.macdHistogram < 0) {
            bearishScore += 6;
            confidence += 6;
            reasons.push('MACD negative zone');
        }

        // 3. EMA Cross (20% weight)
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
            reasons.push('EMA9 above EMA21 (uptrend)');
        } else if (current.ema9 < current.ema21) {
            bearishScore += 10;
            confidence += 10;
            reasons.push('EMA9 below EMA21 (downtrend)');
        } else {
            confidence += 5;
        }

        // 4. ADX Trend Strength (15% weight)
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
        } else if (current.adx > 20) {
            confidence += 5;
            reasons.push(`Developing trend (ADX: ${current.adx.toFixed(1)})`);
        } else {
            reasons.push(`Weak trend (ADX: ${current.adx.toFixed(1)})`);
        }

        // 5. Stochastic (10% weight)
        if (current.stochK < 20 && prev.stochK <= 20 && current.stochK > prev.stochK) {
            bullishScore += 10;
            confidence += 10;
            reasons.push('Stochastic bullish divergence');
        } else if (current.stochK > 80 && prev.stochK >= 80 && current.stochK < prev.stochK) {
            bearishScore += 10;
            confidence += 10;
            reasons.push('Stochastic bearish divergence');
        } else if (current.stochK < 30) {
            bullishScore += 5;
            confidence += 5;
            reasons.push('Stochastic oversold');
        } else if (current.stochK > 70) {
            bearishScore += 5;
            confidence += 5;
            reasons.push('Stochastic overbought');
        }

        // 6. Volume confirmation (bonus)
        if (current.volumeRatio > 1.5) {
            confidence += 5;
            if (bullishScore > bearishScore) {
                reasons.push('Volume spike confirms bullish move');
            } else if (bearishScore > bullishScore) {
                reasons.push('Volume spike confirms bearish move');
            }
        }

        // Determine final direction
        let direction = 'NEUTRAL';
        if (bullishScore > bearishScore && bullishScore >= 35) {
            direction = 'CALL';
        } else if (bearishScore > bullishScore && bearishScore >= 35) {
            direction = 'PUT';
        } else {
            confidence = Math.max(40, confidence - 20);
        }

        // Cap confidence between 0-98
        confidence = Math.min(98, Math.max(0, confidence));
        
        // Bonus confidence for strong signals
        if (direction === 'CALL' && bullishScore > 70) {
            confidence = Math.min(98, confidence + 5);
        }
        if (direction === 'PUT' && bearishScore > 70) {
            confidence = Math.min(98, confidence + 5);
        }

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
                if (result && result.direction) {
                    signals.push(result.direction);
                }
            } catch (error) {
                console.error(`Multi-timeframe error for ${pair.name} on ${tf}:`, error.message);
            }
            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        
        if (signals.length >= 2) {
            const allSame = signals.every(s => s === signals[0]);
            return {
                agreement: signals.length,
                direction: allSame ? signals[0] : null
            };
        }
        
        return null;
    }
}

module.exports = new SignalAnalyzer();
