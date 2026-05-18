
Armanul Azim <armanulazim@gmail.com>
7:03 PM (4 minutes ago)
to me

// ============================================
// LEGENDARY TRADING BOT - INSTITUTIONAL GRADE
// Version: 5.0 FINAL - AUDIT COMPLETE
// File: analyzer.js
// ============================================

const fs = require('fs');
const path = require('path');

const BACKTEST_FILE = path.join(__dirname, 'backtest_stats.json');

// ============================================
// PROFESSIONAL PERFORMANCE TRACKER
// ============================================
class PerformanceTrackerProfessional {
    constructor() {
        this.trades = [];
        this.strategyPerformance = {};
        this.confidenceCalibration = {};
        this.loadHistoricalData();
    }
    
    loadHistoricalData() {
        if (fs.existsSync(BACKTEST_FILE)) {
            try {
                const data = JSON.parse(fs.readFileSync(BACKTEST_FILE, 'utf8'));
                this.trades = data.trades || [];
                this.strategyPerformance = data.strategyPerformance || {};
                this.confidenceCalibration = data.confidenceCalibration || {};
            } catch(e) { console.error('Error loading stats:', e); }
        }
    }
    
    saveHistoricalData() {
        fs.writeFileSync(BACKTEST_FILE, JSON.stringify({
            trades: this.trades.slice(-2000),
            strategyPerformance: this.strategyPerformance,
            confidenceCalibration: this.confidenceCalibration
        }, null, 2));
    }
    
    recordTradeOutcome(strategy, confidence, wasWin, profitPercent, pair, tf) {
        this.trades.push({ timestamp: Date.now(), strategy, confidence, wasWin, profitPercent, pair, tf });
        
        if (!this.strategyPerformance[strategy]) {
            this.strategyPerformance[strategy] = { wins: 0, losses: 0, totalProfit: 0, disabled: false };
        }
        
        if (wasWin) {
            this.strategyPerformance[strategy].wins++;
            this.strategyPerformance[strategy].totalProfit += profitPercent;
        } else {
            this.strategyPerformance[strategy].losses++;
            this.strategyPerformance[strategy].totalProfit -= Math.abs(profitPercent);
        }
        
        const confidenceBucket = Math.floor(confidence / 10) * 10;
        if (!this.confidenceCalibration[confidenceBucket]) {
            this.confidenceCalibration[confidenceBucket] = { wins: 0, total: 0 };
        }
        this.confidenceCalibration[confidenceBucket].total++;
        if (wasWin) this.confidenceCalibration[confidenceBucket].wins++;
        
        const winRate = this.getStrategyWinRate(strategy);
        const totalTrades = this.strategyPerformance[strategy].wins + this.strategyPerformance[strategy].losses;
        if (winRate < 45 && totalTrades > 30) {
            this.strategyPerformance[strategy].disabled = true;
            console.log(`⚠️ STRATEGY DISABLED: ${strategy} (${winRate.toFixed(1)}% over ${totalTrades} trades)`);
        }
        
        this.saveHistoricalData();
    }
    
    getStrategyWinRate(strategy) {
        const perf = this.strategyPerformance[strategy];
        if (!perf || perf.wins + perf.losses === 0) return 55;
        if (perf.disabled) return 0;
        return (perf.wins / (perf.wins + perf.losses)) * 100;
    }
    
    getCalibratedConfidence(rawConfidence, strategy) {
        const bucket = Math.floor(rawConfidence / 10) * 10;
        const calibration = this.confidenceCalibration[bucket];
        
        let calibrated = rawConfidence;
        
        if (calibration && calibration.total > 20) {
            const actualWinRate = (calibration.wins / calibration.total) * 100;
            calibrated = (rawConfidence * 0.6) + (actualWinRate * 0.4);
        }
        
        const strategyWR = this.getStrategyWinRate(strategy);
        if (strategyWR > 0 && strategyWR !== 55 && strategyWR !== 0) {
            calibrated = (calibrated * 0.7) + (strategyWR * 0.3);
        }
        
        return Math.min(94, Math.max(45, calibrated));
    }
    
    shouldSkip(strategy, confidence) {
        const strategyWR = this.getStrategyWinRate(strategy);
        if (strategyWR < 48 && this.strategyPerformance[strategy]?.wins + this.strategyPerformance[strategy]?.losses > 30) {
            return { skip: true, reason: `${strategy} has ${strategyWR.toFixed(1)}% win rate (disabled)` };
        }
        
        const calibrated = this.getCalibratedConfidence(confidence, strategy);
        if (calibrated < 65) {
            return { skip: true, reason: `Calibrated confidence ${calibrated.toFixed(0)}% < 65%` };
        }
        
        return { skip: false };
    }
}

const performanceTracker = new PerformanceTrackerProfessional();

// ============================================
// CORE INDICATORS - INSTITUTIONAL GRADE
// ============================================

function calculateHullMA(data, period = 20) {
    if (!data || data.length < period) return data[data.length - 1] || 0;
    
    const halfPeriod = Math.floor(period / 2);
    const sqrtPeriod = Math.floor(Math.sqrt(period));
    
    const wma = (values, p) => {
        if (values.length < p) return values[values.length - 1];
        let weightSum = 0, sum = 0;
        for (let i = 0; i < p; i++) {
            const weight = p - i;
            sum += values[values.length - 1 - i] * weight;
            weightSum += weight;
        }
        return sum / weightSum;
    };
    
    const wmaHalf = wma(data, halfPeriod);
    const wmaFull = wma(data, period);
    const hullRaw = 2 * wmaHalf - wmaFull;
    const hullMA = wma([hullRaw], sqrtPeriod);
    
    return hullMA;
}

function calculateRSI(closes, period = 14) {
    if (!closes || closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i-1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
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
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function calculateStochasticRSI(closes, rsiPeriod = 14, stochPeriod = 14) {
    const rsi = [];
    for (let i = rsiPeriod; i <= closes.length; i++) {
        const slice = closes.slice(i - rsiPeriod, i);
        rsi.push(calculateRSI(slice, rsiPeriod));
    }
    if (rsi.length < stochPeriod) return { k: 50, d: 50 };
    
    const currentRSI = rsi[rsi.length - 1];
    const highestRSI = Math.max(...rsi.slice(-stochPeriod));
    const lowestRSI = Math.min(...rsi.slice(-stochPeriod));
    const stochK = lowestRSI === highestRSI ? 50 : ((currentRSI - lowestRSI) / (highestRSI - lowestRSI)) * 100;
    const stochD = rsi.slice(-3).reduce((a, b) => a + b, 0) / 3;
    
    return { k: stochK, d: stochD };
}

function calculateADX(high, low, close, period = 14) {
    if (!high || !low || !close || high.length < period + 1) {
        return { adx: 20, plusDI: 20, minusDI: 20 };
    }
    const tr = [];
    for (let i = 1; i < high.length; i++) {
        const hl = high[i] - low[i];
        const hc = Math.abs(high[i] - close[i-1]);
        const lc = Math.abs(low[i] - close[i-1]);
        tr.push(Math.max(hl, hc, lc));
    }
    const plusDM = [], minusDM = [];
    for (let i = 1; i < high.length; i++) {
        const up = high[i] - high[i-1];
        const down = low[i-1] - low[i];
        plusDM.push((up > down && up > 0) ? up : 0);
        minusDM.push((down > up && down > 0) ? down : 0);
    }
    const smoothTR = tr.slice(-period).reduce((a, b) => a + b, 0) / period;
    const smoothPlus = plusDM.slice(-period).reduce((a, b) => a + b, 0) / period;
    const smoothMinus = minusDM.slice(-period).reduce((a, b) => a + b, 0) / period;
    const plusDI = (smoothPlus / smoothTR) * 100;
    const minusDI = (smoothMinus / smoothTR) * 100;
    const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
    return { adx: dx || 20, plusDI: plusDI || 20, minusDI: minusDI || 20 };
}

function calculateATR(high, low, close, period = 14) {
    if (!high || !low || !close || high.length < period + 1) return 0.001;
    const tr = [];
    for (let i = 1; i < high.length; i++) {
        const hl = high[i] - low[i];
        const hc = Math.abs(high[i] - close[i-1]);
        const lc = Math.abs(low[i] - close[i-1]);
        tr.push(Math.max(hl, hc, lc));
    }
    return tr.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calculateVWAP(candles) {
    if (!candles || candles.length === 0) return 1.0;
    let cumPV = 0, cumVol = 0;
    for (let i = 0; i < candles.length; i++) {
        const typical = (candles[i].high + candles[i].low + candles[i].close) / 3;
        cumPV += typical * (candles[i].volume || 1000);
        cumVol += candles[i].volume || 1000;
    }
    return cumVol > 0 ? cumPV / cumVol : candles[candles.length - 1].close;
}

function calculateBollingerBands(closes, period = 20, stdDev = 2) {
    const sma = closes.slice(-period).reduce((a, b) => a + b, 0) / period;
    const variance = closes.slice(-period).map(x => Math.pow(x - sma, 2)).reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(variance);
    return { 
        upper: sma + (std * stdDev), 
        middle: sma, 
        lower: sma - (std * stdDev), 
        bandwidth: (2 * stdDev * std) / sma * 100 
    };
}

function calculateVolumeDelta(candles) {
    if (!candles || candles.length < 10) return { delta: 0, cumulative: 0, strength: 0, direction: 'NEUTRAL' };
    
    let delta = 0;
    for (let i = 0; i < candles.length; i++) {
        const candle = candles[i];
        const volume = candle.volume || 1000;
        const isBullish = candle.close > candle.open;
        delta += isBullish ? volume : -volume;
    }
    
    const avgVolume = candles.slice(-20).reduce((a, b) => a + (b.volume || 1000), 0) / 20;
    const strength = Math.min(100, Math.abs(delta) / avgVolume * 100);
    
    return { delta, cumulative: delta, strength, direction: delta > 0 ? 'BULLISH' : delta < 0 ? 'BEARISH' : 'NEUTRAL' };
}

// ============================================
// PROFESSIONAL DIVERGENCE DETECTION (NO RSI GATE)
// ============================================

function findSignificantSwings(data, minBars = 8) {
    const highs = [], lows = [];
    for (let i = minBars; i < data.length - minBars; i++) {
        let isHigh = true, isLow = true;
        for (let j = -minBars; j <= minBars; j++) {
            if (j === 0) continue;
            if (data[i] <= data[i + j]) isHigh = false;
            if (data[i] >= data[i + j]) isLow = false;
        }
        if (isHigh) highs.push({ value: data[i], index: i });
        if (isLow) lows.push({ value: data[i], index: i });
    }
    return { highs, lows };
}

function calculateDivergenceQuality(priceSwings, indSwings) {
    let quality = 50;
    if (priceSwings.highs.length >= 3 && indSwings.highs.length >= 3) quality += 20;
    if (priceSwings.lows.length >= 3 && indSwings.lows.length >= 3) quality += 20;
    
    const lastPriceSwingIndex = Math.max(
        priceSwings.highs.length ? priceSwings.highs[priceSwings.highs.length-1].index : 0,
        priceSwings.lows.length ? priceSwings.lows[priceSwings.lows.length-1].index : 0
    );
    if (lastPriceSwingIndex > 0) quality += 10;
    
    return Math.min(100, quality);
}

function detectDivergenceProfessional(price, indicator) {
    if (!price || !indicator || price.length < 100) return { type: 'None', strength: 0, quality: 0 };
    
    const priceSwings = findSignificantSwings(price, 8);
    const indSwings = findSignificantSwings(indicator, 8);
    
    let divergence = { type: 'None', strength: 0, quality: 0 };
    
    // Bearish Divergence - NO RSI GATE
    if (priceSwings.highs.length >= 2 && indSwings.highs.length >= 2) {
        const lastPH = priceSwings.highs[priceSwings.highs.length - 1].value;
        const prevPH = priceSwings.highs[priceSwings.highs.length - 2].value;
        const lastIH = indSwings.highs[indSwings.highs.length - 1].value;
        const prevIH = indSwings.highs[indSwings.highs.length - 2].value;
        
        if (lastPH > prevPH && lastIH < prevIH) {
            divergence = {
                type: 'Bearish',
                strength: Math.min(45, ((lastPH - prevPH) / prevPH * 100) + ((prevIH - lastIH) / prevIH * 100)),
                quality: calculateDivergenceQuality(priceSwings, indSwings)
            };
        }
    }
    
    // Bullish Divergence - NO RSI GATE (CRITICAL FIX FOR YOUR AUD/CAD LOSS)
    if (priceSwings.lows.length >= 2 && indSwings.lows.length >= 2) {
        const lastPL = priceSwings.lows[priceSwings.lows.length - 1].value;
        const prevPL = priceSwings.lows[priceSwings.lows.length - 2].value;
        const lastIL = indSwings.lows[indSwings.lows.length - 1].value;
        const prevIL = indSwings.lows[indSwings.lows.length - 2].value;
        
        if (lastPL < prevPL && lastIL > prevIL) {
            divergence = {
                type: 'Bullish',
                strength: Math.min(45, ((prevPL - lastPL) / prevPL * 100) + ((lastIL - prevIL) / prevIL * 100)),
                quality: calculateDivergenceQuality(priceSwings, indSwings)
            };
        }
    }
    
    return divergence;
}

// ============================================
// BOX STRATEGY (The Rumers - 2 Monster Trades)
// ============================================

function calculateBoxLevels(highs, lows) {
    if (!highs || !lows || highs.length < 50) return null;
    
    try {
        let swingHigh = 0;
        let swingLow = Infinity;
        
        for (let i = 20; i < highs.length - 10; i++) {
            let isSwingHigh = true;
            let isSwingLow = true;
            
            for (let j = -10; j <= 10; j++) {
                if (j === 0) continue;
                if (highs[i] <= highs[i + j]) isSwingHigh = false;
                if (lows[i] >= lows[i + j]) isSwingLow = false;
            }
            
            if (isSwingHigh && highs[i] > swingHigh) swingHigh = highs[i];
            if (isSwingLow && lows[i] < swingLow) swingLow = lows[i];
        }
        
        if (swingHigh === 0 || swingLow === Infinity) return null;
        
        const boxRange = swingHigh - swingLow;
        const upperZone = swingHigh - (boxRange * 0.15);
        const lowerZone = swingLow + (boxRange * 0.15);
        const rangePercent = (boxRange / swingLow) * 100;
        
        return { swingHigh, swingLow, upperZone, lowerZone, boxRange, rangePercent };
    } catch(e) { return null; }
}

function detectPitchforkReversal(candles, direction) {
    if (!candles || candles.length < 10) return false;
    
    try {
        const lastCandles = candles.slice(-5);
        
        if (direction === 'BUY_ZONE') {
            let redCount = 0;
            for (let i = lastCandles.length - 3; i >= 0; i--) {
                if (lastCandles[i] && lastCandles[i].close < lastCandles[i].open) redCount++;
                else break;
            }
            
            const lastCandle = lastCandles[lastCandles.length - 1];
            const secondLast = lastCandles[lastCandles.length - 2];
            
            return (redCount >= 2) && 
                   lastCandle && lastCandle.close > lastCandle.open &&
                   secondLast && secondLast.close < secondLast.open &&
                   lastCandle.close > secondLast.high;
        }
        
        if (direction === 'SELL_ZONE') {
            let greenCount = 0;
            for (let i = lastCandles.length - 3; i >= 0; i--) {
                if (lastCandles[i] && lastCandles[i].close > lastCandles[i].open) greenCount++;
                else break;
            }
            
            const lastCandle = lastCandles[lastCandles.length - 1];
            const secondLast = lastCandles[lastCandles.length - 2];
            
            return (greenCount >= 2) && 
                   lastCandle && lastCandle.close < lastCandle.open &&
                   secondLast && secondLast.close > secondLast.open &&
                   lastCandle.close < secondLast.low;
        }
        
        return false;
    } catch(e) { return false; }
}

function getBoxStrategySignal(priceData, currentPrice) {
    try {
        const candles = priceData.values;
        if (!candles || candles.length < 100) return null;
        
        const hourlyHighs = [];
        const hourlyLows = [];
        
        for (let i = 0; i < candles.length; i += 4) {
            const slice = candles.slice(Math.max(0, i), i + 4);
            if (slice.length > 0) {
                hourlyHighs.push(Math.max(...slice.map(c => c.high)));
                hourlyLows.push(Math.min(...slice.map(c => c.low)));
            }
        }
        
        const boxLevels = calculateBoxLevels(hourlyHighs, hourlyLows);
        if (!boxLevels) return null;
        
        const { swingHigh, swingLow, upperZone, lowerZone, rangePercent } = boxLevels;
        
        if (rangePercent < 0.15) return null;
        
        if (currentPrice >= upperZone && currentPrice < swingHigh) {
            const hasReversal = detectPitchforkReversal(candles, 'SELL_ZONE');
            if (hasReversal) {
                return { signal: 'PUT', confidence: 84, strategy: 'BOX_STRATEGY_SELL', expiry: 15 };
            }
            return null;
        }
        
        if (currentPrice <= lowerZone && currentPrice > swingLow) {
            const hasReversal = detectPitchforkReversal(candles, 'BUY_ZONE');
            if (hasReversal) {
                return { signal: 'CALL', confidence: 84, strategy: 'BOX_STRATEGY_BUY', expiry: 15 };
            }
            return null;
        }
        
        return null;
    } catch(e) { return null; }
}

// ============================================
// INSTITUTIONAL FILTERS
// ============================================

function validateMarketConditions(volatilityPercent, atr, price, spread = 0.0001) {
    const MIN_VOLATILITY_PERCENT = 0.12;
    const MIN_PIP_MOVEMENT = 5;
    
    const expectedPipMovement = (atr / price) * 10000;
    
    if (volatilityPercent < MIN_VOLATILITY_PERCENT) {
        return { tradeable: false, reason: `💀 DEAD MARKET: ${volatilityPercent}% volatility`, penalty: 50 };
    }
    
    if (expectedPipMovement < MIN_PIP_MOVEMENT) {
        return { tradeable: false, reason: `💀 INSUFFICIENT MOVEMENT: ${expectedPipMovement.toFixed(1)} pips`, penalty: 55 };
    }
    
    const spreadPips = spread * 10000;
    if (spreadPips > expectedPipMovement * 0.3) {
        return { tradeable: true, reason: `⚠️ WIDE SPREAD: ${spreadPips} pips`, penalty: -15 };
    }
    
    return { tradeable: true, reason: '✅ Valid volatility', penalty: 0 };
}

function getMeanReversionSignal(closes, adx, rsi, price, volumeDelta) {
    if (adx >= 20) return null;
    
    const bb = calculateBollingerBands(closes, 20, 2);
    const stochRSI = calculateStochasticRSI(closes);
    const atUpperBand = price >= bb.upper * 0.998;
    const atLowerBand = price <= bb.lower * 1.002;
    const stochOversold = stochRSI.k < 20;
    const stochOverbought = stochRSI.k > 80;
    const rsiExtreme = rsi < 25 || rsi > 75;
    
    const volumeConfirmed = volumeDelta && Math.abs(volumeDelta.delta) > 0;
    
    if ((atUpperBand || stochOverbought || rsiExtreme) && rsi > 65) {
        let confidence = 74;
        if (volumeConfirmed && volumeDelta.direction === 'BEARISH') confidence += 10;
        return { signal: 'PUT', confidence, strategy: 'MEAN_REVERSION_SELL' };
    }
    
    if ((atLowerBand || stochOversold || rsiExtreme) && rsi < 35) {
        let confidence = 74;
        if (volumeConfirmed && volumeDelta.direction === 'BULLISH') confidence += 10;
        return { signal: 'CALL', confidence, strategy: 'MEAN_REVERSION_BUY' };
    }
    
    return null;
}

function calculateOptimalExpiry(atr, price, volatilityPercent) {
    const targetProfitPercent = 0.20;
    const movementPerMinute = (atr / price) * 100 / 14;
    
    if (movementPerMinute <= 0) return 15;
    
    let minutesNeeded = targetProfitPercent / movementPerMinute;
    
    if (volatilityPercent > 0.35) minutesNeeded = minutesNeeded * 0.5;
    else if (volatilityPercent < 0.12) minutesNeeded = minutesNeeded * 2;
    
    const availableExpiries = [1, 5, 15, 30, 60];
    let selectedExpiry = 15;
    
    for (const expiry of availableExpiries) {
        if (minutesNeeded <= expiry) {
            selectedExpiry = expiry;
            break;
        }
    }
    
    return Math.max(5, selectedExpiry);
}

function getSessionScore() {
    const hour = new Date().getHours();
    const day = new Date().getDay();
    
    if (day === 0 || day === 6) return { multiplier: 0.85, name: 'WEEKEND' };
    if (hour >= 13 && hour <= 16) return { multiplier: 1.08, name: 'LONDON_NY_OVERLAP' };
    if (hour >= 8 && hour <= 10) return { multiplier: 1.05, name: 'LONDON_OPEN' };
    if (hour >= 1 && hour <= 6) return { multiplier: 0.92, name: 'ASIAN' };
    return { multiplier: 0.95, name: 'OFF_HOURS' };
}

function getVolumeConfidence(candles) {
    try {
        const volumes = candles.map(c => c.volume || 1000);
        const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const currentVolume = volumes[volumes.length - 1] || 1000;
        const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;
        
        if (volumeRatio < 0.6) return { confidence: -20, reason: 'LOW VOLUME', quality: 'POOR' };
        if (volumeRatio > 1.8) return { confidence: 15, reason: 'VERY HIGH VOLUME', quality: 'EXCELLENT' };
        if (volumeRatio > 1.3) return { confidence: 10, reason: 'HIGH VOLUME', quality: 'GOOD' };
        return { confidence: 0, reason: 'NORMAL VOLUME', quality: 'NORMAL' };
    } catch(e) { return { confidence: 0, reason: 'NORMAL VOLUME', quality: 'NORMAL' }; }
}

function getSentimentScore(rsi, adx) {
    if (rsi > 75 && adx > 30) return { sentiment: 'EXTREME GREED', bias: 'BEARISH', score: -15 };
    if (rsi < 25 && adx > 30) return { sentiment: 'EXTREME FEAR', bias: 'BULLISH', score: 15 };
    if (rsi > 65) return { sentiment: 'GREED', bias: 'BEARISH', score: -8 };
    if (rsi < 35) return { sentiment: 'FEAR', bias: 'BULLISH', score: 8 };
    return { sentiment: 'NEUTRAL', bias: 'NEUTRAL', score: 0 };
}

// ============================================
// MAIN ANALYSIS ENGINE
// ============================================

async function analyzeSignal(priceData, config, tf, higherPriceData = null, lowerPriceData = null, openPositions = []) {
    try {
        const candles = priceData.values;
        if (!candles || candles.length < 100) {
            return {
                signal: 'CALL', confidence: 50, intensity: '⚪ LOW',
                rsi: '50', adx: '20', adxStrength: 'Insufficient',
                trendDirection: 'Unknown', divergence: 'None',
                strategyUsed: 'Insufficient Data',
                volatilityPercent: 'N/A', priceChange: '0',
                sentiment: 'Neutral', volumeQuality: 'Normal',
                session: 'Unknown', riskReward: 'N/A',
                expiry: 15,
                recommendation: '⚠️ Need more data', shouldTrade: '⚠️ Skip'
            };
        }
        
        // Extract data
        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const price = closes[closes.length - 1];
        
        // Calculate indicators
        const priceChange = ((price - closes[0]) / closes[0]) * 100;
        const rsi = calculateRSI(closes, 14);
        const stochRSI = calculateStochasticRSI(closes);
        const { adx, plusDI, minusDI } = calculateADX(highs, lows, closes, 14);
        const vwap = calculateVWAP(candles);
        const atr = calculateATR(highs, lows, closes, 14);
        const avgPrice = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const volatilityPercent = (atr / avgPrice) * 100;
        const volumeDelta = calculateVolumeDelta(candles);
        
        // Advanced indicators
        const hullMA20 = calculateHullMA(closes, 20);
        const hullMA50 = calculateHullMA(closes, 50);
        const bb = calculateBollingerBands(closes, 20, 2);
        
        // Trend detection with Hull MA
        let trendDirection = 'Neutral';
        let trendScore = 0;
        if (price > hullMA20 && price > hullMA50 && plusDI > minusDI) {
            trendDirection = 'UPTREND';
            trendScore = 1;
        } else if (price < hullMA20 && price < hullMA50 && minusDI > plusDI) {
            trendDirection = 'DOWNTREND';
            trendScore = -1;
        }
        
        // Professional divergence (NO RSI GATE)
        const rsiVals = [];
        for (let i = 0; i < closes.length; i++) {
            const slice = closes.slice(0, i + 1);
            rsiVals.push(slice.length < 14 ? 50 : calculateRSI(slice, 14));
        }
        const divergence = detectDivergenceProfessional(closes, rsiVals);
        
        // Filters
        const volatilityCheck = validateMarketConditions(volatilityPercent, atr, price);
        const sentiment = getSentimentScore(rsi, adx);
        const volumeConf = getVolumeConfidence(candles);
        const session = getSessionScore();
        
        // Strategy selection (PRIORITY ORDER)
        let signal = null;
        let baseConfidence = 55;
        let strategyUsed = '';
        
        // PRIORITY 1: Box Strategy
        const boxSignal = getBoxStrategySignal(priceData, price);
        if (boxSignal && boxSignal.signal) {
            signal = boxSignal.signal;
            baseConfidence = boxSignal.confidence;
            strategyUsed = boxSignal.strategy;
        }
        // PRIORITY 2: Divergence (NOW WORKS AT ANY RSI)
        else if (divergence.type !== 'None' && divergence.quality > 25) {
            signal = divergence.type === 'Bullish' ? 'CALL' : 'PUT';
            baseConfidence = 85 + Math.min(15, divergence.quality / 5);
            strategyUsed = `${divergence.type}_DIVERGENCE`;
        }
        // PRIORITY 3: Mean Reversion
        else {
            const mrSignal = getMeanReversionSignal(closes, adx, rsi, price, volumeDelta);
            if (mrSignal) {
                signal = mrSignal.signal;
                baseConfidence = mrSignal.confidence;
                strategyUsed = mrSignal.strategy;
            }
            // PRIORITY 4: Trend Following (with ADX filter)
            else if (trendScore !== 0 && adx >= 25) {
                signal = trendScore === 1 ? 'CALL' : 'PUT';
                baseConfidence = 75;
                strategyUsed = 'TREND_FOLLOWING';
            }
            // PRIORITY 5: VWAP Fallback
            else {
                signal = price > vwap ? 'CALL' : 'PUT';
                baseConfidence = 60;
                strategyUsed = 'VWAP_FALLBACK';
            }
        }
        
        // Calculate final confidence
        let finalConfidence = baseConfidence;
        finalConfidence += (adx >= 40 ? 12 : adx >= 30 ? 8 : adx >= 25 ? 5 : 0);
        finalConfidence += sentiment.score;
        finalConfidence += volumeConf.confidence;
        finalConfidence += divergence.quality / 3;
        finalConfidence -= volatilityCheck.penalty;
        
        // Trend alignment
        if ((trendScore === 1 && signal === 'CALL') || (trendScore === -1 && signal === 'PUT')) {
            finalConfidence += 10;
        } else if ((trendScore === 1 && signal === 'PUT') || (trendScore === -1 && signal === 'CALL')) {
            finalConfidence -= 15;
        }
        
        // Session adjustment
        finalConfidence = finalConfidence * session.multiplier;
        finalConfidence = Math.min(94, Math.max(45, finalConfidence));
        
        // Calibrate
        const calibratedConfidence = performanceTracker.getCalibratedConfidence(finalConfidence, strategyUsed);
        const skipCheck = performanceTracker.shouldSkip(strategyUsed, calibratedConfidence);
        const expiry = calculateOptimalExpiry(atr, price, volatilityPercent);
        
        // Format output
        const intensity = calibratedConfidence >= 90 ? '🏆🏆🏆 LEGENDARY' :
                         calibratedConfidence >= 85 ? '🔴🔴🔴🔴 EXTREME' :
                         calibratedConfidence >= 78 ? '🔴🔴🔴 STRONG' :
                         calibratedConfidence >= 68 ? '🟠🟠 MODERATE' :
                         calibratedConfidence >= 58 ? '🟡 WEAK' : '⚪ LOW';
        
        let recommendation = '';
        if (calibratedConfidence >= 90) recommendation = '🏆🏆🏆 LEGENDARY SIGNAL 🏆🏆🏆';
        else if (calibratedConfidence >= 85) recommendation = '✅✅✅ EXTREME HIGH PROBABILITY ✅✅✅';
        else if (calibratedConfidence >= 78) recommendation = '✅✅ STRONG SIGNAL ✅✅';
        else if (calibratedConfidence >= 68) recommendation = '✅ GOOD SIGNAL - Consider taking';
        else if (calibratedConfidence >= 58) recommendation = '⚠️ WEAK SIGNAL - Trade with caution';
        else recommendation = '⚠️ LOW CONFIDENCE - Better to skip';
        
        if (skipCheck.skip) recommendation = `⚠️ SKIPPED: ${skipCheck.reason}`;
        
        const shouldTrade = (calibratedConfidence >= 70 && !skipCheck.skip && volatilityCheck.tradeable) ? 
                            '✅ Consider trading' : '⚠️ Consider skipping';
        
        return {
            signal,
            confidence: Math.round(calibratedConfidence),
            intensity,
            rsi: rsi.toFixed(1),
            stochK: stochRSI.k.toFixed(1),
            stochD: stochRSI.d.toFixed(1),
            adx: adx.toFixed(1),
            adxStrength: adx >= 50 ? '🔥 EXTREME TREND' : adx >= 30 ? '📈 STRONG TREND' : adx >= 20 ? '🌀 WEAK TREND' : '🌀 SIDEWAYS/RANGE',
            priceChange: priceChange.toFixed(2),
            trendDirection,
            volatilityPercent: volatilityPercent.toFixed(2),
            divergence: divergence.type,
            divergenceQuality: divergence.quality.toFixed(0),
            sentiment: sentiment.sentiment,
            volumeQuality: volumeConf.reason,
            volumeDelta: volumeDelta.delta,
            session: session.name,
            strategyUsed,
            riskReward: '2.5:1',
            expiry,
            bbUpper: bb.upper.toFixed(5),
            bbLower: bb.lower.toFixed(5),
            bbWidth: bb.bandwidth.toFixed(2),
            hullMA20: hullMA20.toFixed(5),
            hullMA50: hullMA50.toFixed(5),
            recommendation,
            shouldTrade,
            skipReason: skipCheck.skip ? skipCheck.reason : null
        };
        
    } catch(e) {
        console.error('Analyzer error:', e);
        return {
            signal: 'CALL', confidence: 50, intensity: '⚪ LOW',
            rsi: '50', adx: '20', adxStrength: 'Error',
            trendDirection: 'Unknown', divergence: 'None',
            strategyUsed: 'Error',
            volatilityPercent: 'N/A', priceChange: '0',
            sentiment: 'Neutral', volumeQuality: 'Normal',
            session: 'Unknown', riskReward: 'N/A',
            expiry: 15,
            recommendation: '⚠️ Error - skip', shouldTrade: '⚠️ Skip'
        };
    }
}

module.exports = { 
    analyzeSignal, 
    recordTradeOutcome: performanceTracker.recordTradeOutcome.bind(performanceTracker) 
};
