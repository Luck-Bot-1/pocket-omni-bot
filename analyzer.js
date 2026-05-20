// ============================================
// POCKET OPTION LEGENDARY BOT v22.0
// INTEGRATED ANALYZER - WORKS WITH BOTH bot.js AND bot-v22.js
// ============================================

const fs = require('fs');
const path = require('path');

// Load pairs from your existing pairs.json if it exists
let PAIRS_LIST = [];
try {
    if (fs.existsSync('pairs.json')) {
        const pairsData = JSON.parse(fs.readFileSync('pairs.json', 'utf8'));
        PAIRS_LIST = pairsData.pairs || pairsData || [];
    }
} catch(e) {
    console.log('⚠️ Could not load pairs.json, using defaults');
}

// Load session config from your existing session.json if it exists
let SESSION_CONFIG = {};
try {
    if (fs.existsSync('session.json')) {
        SESSION_CONFIG = JSON.parse(fs.readFileSync('session.json', 'utf8'));
    }
} catch(e) {}

const BACKTEST_FILE = path.join(__dirname, 'backtest_stats.json');

// ============================================
// CONFIGURATION (MERGED FROM BOTH SOURCES)
// ============================================
const ULTIMATE_CONFIG = {
    MIN_CONFIDENCE: 55,
    SIGNAL_COOLDOWN_MINUTES: 15,
    MAX_CONSECUTIVE_LOSSES: 3,
    
    MIN_VOLATILITY_PERCENT: 0.12,
    MAX_VOLATILITY_PERCENT: 2.50,
    MIN_PIP_MOVEMENT: 3,
    
    MIN_ADX_FOR_TREND: 20,
    MAX_ADX_FOR_MEAN_REVERSION: 25,
    TREND_CONTRADICTION_REJECTION: false,
    
    MIN_RSI_BEARISH: 65,
    MAX_RSI_BULLISH: 35,
    MIN_DIVERGENCE_QUALITY: 50,
    
    MIN_VOLUME_RATIO: 0.60,
    MIN_VOLUME_TREND: 0.30,
    
    RISK_PER_TRADE_PERCENT: 2.0,
    ATR_MULTIPLIER_SL: 1.2,
    ATR_MULTIPLIER_TP: 2.0,
    
    FACTOR_WEIGHTS: {
        momentum: 0.25,
        meanReversion: 0.20,
        volatility: 0.15,
        volume: 0.20,
        divergence: 0.20
    },
    
    // Merge with session.json if available
    SESSIONS: SESSION_CONFIG.sessions || {
        'LONDON_NY': { hours: [13,14,15,16], multiplier: 1.15, tradeable: true },
        'LONDON':    { hours: [8,9,10,11],   multiplier: 1.10, tradeable: true },
        'ASIAN':     { hours: [1,2,3,4,5,6], multiplier: 0.95, tradeable: true },
        'OFF_HOURS': { hours: [0,7,12,17,18,19,20,21,22,23], multiplier: 0.85, tradeable: true }
    },
    
    ALLOWED_TIMEFRAMES: {
        '1m':  { enabled: true, name: '1 MINUTE',  expiry: 1,  minBars: 30,  weight: 0.10 },
        '5m':  { enabled: true, name: '5 MINUTE',  expiry: 5,  minBars: 50,  weight: 0.15 },
        '15m': { enabled: true, name: '15 MINUTE', expiry: 15, minBars: 100, weight: 0.35, PRIMARY: true },
        '30m': { enabled: true, name: '30 MINUTE', expiry: 30, minBars: 100, weight: 0.20 },
        '1h':  { enabled: true, name: '1 HOUR',    expiry: 60, minBars: 150, weight: 0.15 },
        '4h':  { enabled: true, name: '4 HOUR',    expiry: 240,minBars: 100, weight: 0.05 }
    },
    
    AVOID_NEWS_MINUTES: 15,
    HIGH_IMPACT_NEWS: ['NFP', 'CPI', 'FOMC', 'GDP', 'UNEMPLOYMENT', 'PPI', 'PMI']
};

// ============================================
// PERFORMANCE TRACKER (PRESERVED)
// ============================================
class UltimatePerformanceTracker {
    constructor() {
        this.trades = [];
        this.strategyPerformance = {};
        this.lastSignals = {};
        this.strategyLossStreak = {};
        this.ensembleVotes = [];
        this.loadHistoricalData();
    }
    
    loadHistoricalData() {
        try {
            if (fs.existsSync(BACKTEST_FILE)) {
                const data = JSON.parse(fs.readFileSync(BACKTEST_FILE, 'utf8'));
                this.trades = data.trades || [];
                this.strategyPerformance = data.strategyPerformance || {};
                this.lastSignals = data.lastSignals || {};
                this.strategyLossStreak = data.strategyLossStreak || {};
                this.ensembleVotes = data.ensembleVotes || [];
            }
        } catch(e) { this.resetState(); }
    }
    
    resetState() {
        this.trades = [];
        this.strategyPerformance = {};
        this.lastSignals = {};
        this.strategyLossStreak = {};
        this.ensembleVotes = [];
    }
    
    saveHistoricalData() {
        try {
            fs.writeFileSync(BACKTEST_FILE, JSON.stringify({
                trades: this.trades.slice(-2000),
                strategyPerformance: this.strategyPerformance,
                lastSignals: this.lastSignals,
                strategyLossStreak: this.strategyLossStreak,
                ensembleVotes: this.ensembleVotes.slice(-1000)
            }, null, 2));
        } catch(e) {}
    }
    
    recordTradeOutcome(strategy, confidence, wasWin, profitPercent, pair, tf) {
        this.trades.push({ timestamp: Date.now(), strategy, confidence, wasWin, profitPercent, pair, tf });
        
        if (!this.strategyPerformance[strategy]) {
            this.strategyPerformance[strategy] = { wins: 0, losses: 0, totalProfit: 0, disabled: false };
            this.strategyLossStreak[strategy] = 0;
        }
        
        if (wasWin) {
            this.strategyPerformance[strategy].wins++;
            this.strategyPerformance[strategy].totalProfit += profitPercent;
            this.strategyLossStreak[strategy] = 0;
        } else {
            this.strategyPerformance[strategy].losses++;
            this.strategyPerformance[strategy].totalProfit -= Math.abs(profitPercent);
            this.strategyLossStreak[strategy]++;
        }
        
        const winRate = this.getStrategyWinRate(strategy);
        const totalTrades = this.strategyPerformance[strategy].wins + this.strategyPerformance[strategy].losses;
        
        if ((winRate < 45 && totalTrades > 20) || this.strategyLossStreak[strategy] >= ULTIMATE_CONFIG.MAX_CONSECUTIVE_LOSSES) {
            this.strategyPerformance[strategy].disabled = true;
            console.log(`⚠️ STRATEGY DISABLED: ${strategy}`);
        }
        
        this.saveHistoricalData();
    }
    
    getStrategyWinRate(strategy) {
        const perf = this.strategyPerformance[strategy];
        if (!perf || perf.wins + perf.losses === 0) return 55;
        if (perf.disabled) return 0;
        return (perf.wins / (perf.wins + perf.losses)) * 100;
    }
    
    checkCooldown(pair, signal, timeframe) {
        const key = `${pair}_${signal}_${timeframe}`;
        const lastSignal = this.lastSignals[key];
        if (lastSignal && (Date.now() - lastSignal) < ULTIMATE_CONFIG.SIGNAL_COOLDOWN_MINUTES * 60 * 1000) {
            const remaining = Math.round((ULTIMATE_CONFIG.SIGNAL_COOLDOWN_MINUTES * 60 * 1000 - (Date.now() - lastSignal)) / 60000);
            return { allowed: false, reason: `Cooldown: ${remaining} min` };
        }
        return { allowed: true };
    }
    
    recordSignal(pair, signal, timeframe) {
        const key = `${pair}_${signal}_${timeframe}`;
        this.lastSignals[key] = Date.now();
        this.saveHistoricalData();
    }
    
    isNewsEvent() {
        const now = new Date();
        const newsEvents = [
            { hour: 8, minute: 30, name: 'US NFP/CPI', impact: 'HIGH' },
            { hour: 10, minute: 0, name: 'US Fed Rate', impact: 'HIGH' },
            { hour: 4, minute: 30, name: 'UK CPI', impact: 'MEDIUM' },
            { hour: 2, minute: 0, name: 'German GDP', impact: 'MEDIUM' },
            { hour: 14, minute: 0, name: 'US FOMC', impact: 'HIGH' }
        ];
        
        for (const event of newsEvents) {
            const eventTime = new Date();
            eventTime.setHours(event.hour, event.minute, 0, 0);
            const timeDiff = Math.abs(now - eventTime) / 60000;
            if (timeDiff < ULTIMATE_CONFIG.AVOID_NEWS_MINUTES) {
                return { isNews: true, event: event.name, minutesToEvent: Math.round(timeDiff), impact: event.impact };
            }
        }
        return { isNews: false };
    }
    
    getFearGreedIndex() {
        const hour = new Date().getHours();
        const day = new Date().getDay();
        
        if (day === 0 || day === 6) return { sentiment: 'NEUTRAL', score: 0.50, name: 'Weekend' };
        if (hour >= 13 && hour <= 16) return { sentiment: 'GREED', score: 0.85, name: 'London-NY Overlap' };
        if (hour >= 8 && hour <= 11) return { sentiment: 'GREED', score: 0.75, name: 'London Open' };
        if (hour >= 1 && hour <= 6) return { sentiment: 'FEAR', score: 0.60, name: 'Asian Session' };
        return { sentiment: 'NEUTRAL', score: 0.65, name: 'Off Hours' };
    }
    
    getCalibratedConfidence(rawConfidence, strategy) {
        const strategyWR = this.getStrategyWinRate(strategy);
        let calibrated = rawConfidence;
        if (strategyWR > 0 && strategyWR !== 55 && strategyWR !== 0) {
            calibrated = (rawConfidence * 0.70) + (strategyWR * 0.30);
        }
        return Math.min(94, Math.max(45, calibrated));
    }
    
    shouldSkip(strategy, confidence, pair, signal, timeframe) {
        const newsCheck = this.isNewsEvent();
        if (newsCheck.isNews && newsCheck.impact === 'HIGH') {
            return { skip: true, reason: `📰 ${newsCheck.event} in ${newsCheck.minutesToEvent} min` };
        }
        
        const cooldownCheck = this.checkCooldown(pair, signal, timeframe);
        if (!cooldownCheck.allowed) {
            return { skip: true, reason: cooldownCheck.reason };
        }
        
        const strategyWR = this.getStrategyWinRate(strategy);
        if (strategyWR < 45 && this.strategyPerformance[strategy]?.wins + this.strategyPerformance[strategy]?.losses > 20) {
            return { skip: true, reason: `${strategy}: ${strategyWR.toFixed(1)}% WR` };
        }
        
        const calibrated = this.getCalibratedConfidence(confidence, strategy);
        if (calibrated < ULTIMATE_CONFIG.MIN_CONFIDENCE) {
            return { skip: true, reason: `Confidence ${calibrated.toFixed(0)}% < ${ULTIMATE_CONFIG.MIN_CONFIDENCE}%` };
        }
        
        return { skip: false };
    }
}

const performanceTracker = new UltimatePerformanceTracker();

// ============================================
// CORE INDICATORS (PRESERVED FROM YOUR EXISTING)
// ============================================

function calculateRSI(closes, period = 14) {
    try {
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
        const rsi = 100 - (100 / (1 + rs));
        return isNaN(rsi) ? 50 : rsi;
    } catch(e) { return 50; }
}

function calculateADX(high, low, close, period = 14) {
    try {
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
        return { adx: isNaN(dx) ? 20 : dx, plusDI: isNaN(plusDI) ? 20 : plusDI, minusDI: isNaN(minusDI) ? 20 : minusDI };
    } catch(e) { return { adx: 20, plusDI: 20, minusDI: 20 }; }
}

function calculateATR(high, low, close, period = 14) {
    try {
        if (!high || !low || !close || high.length < period + 1) return 0.001;
        const tr = [];
        for (let i = 1; i < high.length; i++) {
            const hl = high[i] - low[i];
            const hc = Math.abs(high[i] - close[i-1]);
            const lc = Math.abs(low[i] - close[i-1]);
            tr.push(Math.max(hl, hc, lc));
        }
        const atr = tr.slice(-period).reduce((a, b) => a + b, 0) / period;
        return isNaN(atr) ? 0.001 : atr;
    } catch(e) { return 0.001; }
}

function calculateHullMA(data, period = 20) {
    try {
        if (!data || !Array.isArray(data) || data.length < period) {
            return data && data.length ? data[data.length - 1] : 0;
        }
        const halfPeriod = Math.floor(period / 2);
        const sqrtPeriod = Math.floor(Math.sqrt(period));
        const wma = (values, p) => {
            if (!values || values.length < p) return values ? values[values.length - 1] : 0;
            let weightSum = 0, sum = 0;
            for (let i = 0; i < p; i++) {
                const weight = p - i;
                sum += values[values.length - 1 - i] * weight;
                weightSum += weight;
            }
            return weightSum === 0 ? 0 : sum / weightSum;
        };
        const wmaHalf = wma(data, halfPeriod);
        const wmaFull = wma(data, period);
        const hullRaw = 2 * wmaHalf - wmaFull;
        const hullMA = wma([hullRaw], sqrtPeriod);
        return isNaN(hullMA) ? data[data.length - 1] : hullMA;
    } catch(e) { return data && data.length ? data[data.length - 1] : 0; }
}

function calculateVWAP(candles) {
    try {
        if (!candles || candles.length === 0) return 1.0;
        let cumPV = 0, cumVol = 0;
        for (let i = 0; i < candles.length; i++) {
            const typical = (candles[i].high + candles[i].low + candles[i].close) / 3;
            cumPV += typical * (candles[i].volume || 1000);
            cumVol += candles[i].volume || 1000;
        }
        return cumVol > 0 ? cumPV / cumVol : candles[candles.length - 1].close;
    } catch(e) { return 1.0; }
}

function calculateVolumeConfidence(candles) {
    try {
        if (!candles || candles.length < 30) return { confidence: 0, reason: 'INSUFFICIENT', volumeRatio: 1, volumeTrend: 0, imbalance: 0 };
        
        const volumes = candles.map(c => c.volume || 1000);
        const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const currentVolume = volumes[volumes.length - 1] || 1000;
        const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;
        
        if (volumeRatio < 0.40) {
            return { confidence: -40, reason: `LOW VOLUME: ${(volumeRatio*100).toFixed(0)}%`, volumeRatio, volumeTrend: 0, imbalance: 0 };
        }
        
        const recentVolumes = volumes.slice(-15);
        let increasingCount = 0;
        for (let i = 1; i < recentVolumes.length; i++) {
            if (recentVolumes[i] > recentVolumes[i-1]) increasingCount++;
        }
        const volumeTrend = increasingCount / 14;
        
        let bullVolume = 0, bearVolume = 0;
        for (let i = candles.length - 15; i < candles.length; i++) {
            if (candles[i].close > candles[i].open) bullVolume += candles[i].volume || 1000;
            else bearVolume += candles[i].volume || 1000;
        }
        const imbalance = (bullVolume - bearVolume) / (bullVolume + bearVolume);
        
        let confidence = 0;
        if (volumeRatio > 1.3) confidence += 20;
        else if (volumeRatio > 1.0) confidence += 10;
        confidence += volumeTrend * 10;
        confidence += Math.abs(imbalance) * 15;
        
        return { confidence: Math.min(35, confidence), reason: volumeRatio > 1.1 ? 'GOOD VOLUME' : 'NORMAL', volumeRatio, volumeTrend, imbalance };
    } catch(e) { 
        return { confidence: 0, reason: 'NORMAL', volumeRatio: 1, volumeTrend: 0, imbalance: 0 }; 
    }
}

// ============================================
// DIVERGENCE DETECTION
// ============================================

function findSignificantSwings(data, minBars = 6, depthPercent = 0.0020) {
    try {
        const highs = [], lows = [];
        for (let i = minBars; i < data.length - minBars; i++) {
            let isHigh = true, isLow = true;
            let highDepth = 0, lowDepth = 0;
            for (let j = -minBars; j <= minBars; j++) {
                if (j === 0) continue;
                if (data[i] <= data[i + j]) isHigh = false;
                if (data[i] >= data[i + j]) isLow = false;
                if (isHigh) highDepth = Math.max(highDepth, Math.abs(data[i] - data[i + j]) / data[i]);
                if (isLow) lowDepth = Math.max(lowDepth, Math.abs(data[i] - data[i + j]) / data[i]);
            }
            if (isHigh && highDepth >= depthPercent) highs.push({ value: data[i], index: i, depth: highDepth });
            if (isLow && lowDepth >= depthPercent) lows.push({ value: data[i], index: i, depth: lowDepth });
        }
        return { highs, lows };
    } catch(e) { return { highs: [], lows: [] }; }
}

function calculateDivergenceQuality(priceSwings, indSwings) {
    try {
        let quality = 50;
        if (priceSwings.highs.length >= 2 && indSwings.highs.length >= 2) quality += 10;
        if (priceSwings.lows.length >= 2 && indSwings.lows.length >= 2) quality += 10;
        return Math.min(100, quality);
    } catch(e) { return 0; }
}

function detectDivergence(price, indicator) {
    try {
        if (!price || !indicator || price.length < 60) return { type: 'None', strength: 0, quality: 0 };
        
        const priceSwings = findSignificantSwings(price, 6, 0.0020);
        const indSwings = findSignificantSwings(indicator, 6, 0.0015);
        let divergence = { type: 'None', strength: 0, quality: 0 };
        
        if (priceSwings.highs.length >= 2 && indSwings.highs.length >= 2) {
            const lastPH = priceSwings.highs[priceSwings.highs.length - 1].value;
            const prevPH = priceSwings.highs[priceSwings.highs.length - 2].value;
            const lastIH = indSwings.highs[indSwings.highs.length - 1].value;
            const prevIH = indSwings.highs[indSwings.highs.length - 2].value;
            
            if (lastPH > prevPH && lastIH < prevIH && lastIH > ULTIMATE_CONFIG.MIN_RSI_BEARISH) {
                divergence = {
                    type: 'Bearish',
                    strength: Math.min(40, ((lastPH - prevPH) / prevPH * 100) + ((prevIH - lastIH) / prevIH * 100)),
                    quality: calculateDivergenceQuality(priceSwings, indSwings)
                };
            }
        }
        
        if (priceSwings.lows.length >= 2 && indSwings.lows.length >= 2) {
            const lastPL = priceSwings.lows[priceSwings.lows.length - 1].value;
            const prevPL = priceSwings.lows[priceSwings.lows.length - 2].value;
            const lastIL = indSwings.lows[indSwings.lows.length - 1].value;
            const prevIL = indSwings.lows[indSwings.lows.length - 2].value;
            
            if (lastPL < prevPL && lastIL > prevIL && lastIL < ULTIMATE_CONFIG.MAX_RSI_BULLISH) {
                divergence = {
                    type: 'Bullish',
                    strength: Math.min(40, ((prevPL - lastPL) / prevPL * 100) + ((lastIL - prevIL) / prevIL * 100)),
                    quality: calculateDivergenceQuality(priceSwings, indSwings)
                };
            }
        }
        
        return divergence;
    } catch(e) { return { type: 'None', strength: 0, quality: 0 }; }
}

function calculateFactorScores(candles, rsi, adx, priceChange, volumeRatio) {
    let momentumFactor = 0;
    if (priceChange > 0.3) momentumFactor = 0.8;
    else if (priceChange > 0.15) momentumFactor = 0.6;
    else if (priceChange > 0) momentumFactor = 0.5;
    else if (priceChange > -0.15) momentumFactor = 0.4;
    else if (priceChange > -0.3) momentumFactor = 0.3;
    else momentumFactor = 0.2;
    
    let meanReversionFactor = 0;
    if (rsi < 30 || rsi > 70) meanReversionFactor = 0.8;
    else if (rsi < 35 || rsi > 65) meanReversionFactor = 0.6;
    else if (rsi < 40 || rsi > 60) meanReversionFactor = 0.4;
    else meanReversionFactor = 0.3;
    
    let volatilityFactor = 0;
    if (adx > 35) volatilityFactor = 0.8;
    else if (adx > 25) volatilityFactor = 0.6;
    else if (adx > 18) volatilityFactor = 0.4;
    else volatilityFactor = 0.3;
    
    let volumeFactor = Math.min(0.85, volumeRatio / 1.5);
    
    return { momentumFactor, meanReversionFactor, volatilityFactor, volumeFactor };
}

function validateMarketConditions(volatilityPercent, atr, price) {
    try {
        const expectedPipMovement = (atr / price) * 10000;
        
        if (volatilityPercent < 0.08) {
            return { tradeable: false, reason: `💀 DEAD MARKET: ${volatilityPercent}% vol`, penalty: 50 };
        }
        
        if (volatilityPercent > 3.0) {
            return { tradeable: false, reason: `⚠️ EXTREME VOL: ${volatilityPercent}%`, penalty: 50 };
        }
        
        if (expectedPipMovement < 2) {
            return { tradeable: false, reason: `💀 LOW MOVEMENT: ${expectedPipMovement.toFixed(1)} pips`, penalty: 30 };
        }
        
        return { tradeable: true, reason: '✅ VALID', penalty: 0 };
    } catch(e) { return { tradeable: true, reason: 'Default', penalty: 0 }; }
}

function getSessionMultiplier() {
    try {
        const hour = new Date().getHours();
        const day = new Date().getDay();
        
        if (day === 0 || day === 6) return { multiplier: 0.80, name: 'WEEKEND', tradeable: true };
        if (hour >= 13 && hour <= 16) return { multiplier: 1.15, name: 'LONDON_NY_OVERLAP', tradeable: true };
        if (hour >= 8 && hour <= 11) return { multiplier: 1.10, name: 'LONDON_OPEN', tradeable: true };
        if (hour >= 1 && hour <= 6) return { multiplier: 0.95, name: 'ASIAN', tradeable: true };
        return { multiplier: 0.85, name: 'OFF_HOURS', tradeable: true };
    } catch(e) { return { multiplier: 1.0, name: 'UNKNOWN', tradeable: true }; }
}

function calculatePositionSize(accountBalance, atr, price, confidence) {
    const riskPercent = ULTIMATE_CONFIG.RISK_PER_TRADE_PERCENT;
    let positionSize = (accountBalance * (riskPercent / 100)) / (atr * ULTIMATE_CONFIG.ATR_MULTIPLIER_SL);
    const confidenceMultiplier = 0.7 + ((confidence - 50) / 100);
    const finalSize = positionSize * confidenceMultiplier;
    return {
        size: Math.min(finalSize, accountBalance * 0.10 / price),
        stopLoss: atr * ULTIMATE_CONFIG.ATR_MULTIPLIER_SL,
        takeProfit: atr * ULTIMATE_CONFIG.ATR_MULTIPLIER_TP,
        riskAmount: accountBalance * (riskPercent / 100)
    };
}

function calculateOptimalExpiry(atr, price, volatilityPercent, timeframe) {
    try {
        const tfConfig = ULTIMATE_CONFIG.ALLOWED_TIMEFRAMES[timeframe];
        const baseExpiry = tfConfig?.expiry || 15;
        if (volatilityPercent > 0.80) return Math.max(1, Math.floor(baseExpiry * 0.6));
        if (volatilityPercent < 0.15) return Math.min(60, baseExpiry * 1.5);
        return baseExpiry;
    } catch(e) { return 15; }
}

// ============================================
// MAIN ANALYSIS ENGINE
// ============================================

async function analyzeSignal(priceData, config, tf, higherPriceData = null, lowerPriceData = null, openPositions = [], accountBalance = 10000) {
    if (!priceData || !priceData.values || !Array.isArray(priceData.values) || priceData.values.length < 30) {
        return createErrorResponse(tf);
    }
    
    try {
        const candles = priceData.values;
        const pairName = config?.pairName || 'UNKNOWN';
        const timeframe = tf || '15m';
        const tfConfig = ULTIMATE_CONFIG.ALLOWED_TIMEFRAMES[timeframe] || { name: timeframe, expiry: 15 };
        
        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const price = closes[closes.length - 1];
        
        const priceChange = ((price - closes[0]) / closes[0]) * 100;
        const rsi = calculateRSI(closes, 14);
        const { adx, plusDI, minusDI } = calculateADX(highs, lows, closes, 14);
        const vwap = calculateVWAP(candles);
        const atr = calculateATR(highs, lows, closes, 14);
        const avgPrice = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const volatilityPercent = (atr / avgPrice) * 100;
        const hullMA20 = calculateHullMA(closes, 20);
        
        const volumeConf = calculateVolumeConfidence(candles);
        
        const rsiVals = [];
        for (let i = 0; i < closes.length; i++) {
            const slice = closes.slice(0, i + 1);
            rsiVals.push(slice.length < 14 ? 50 : calculateRSI(slice, 14));
        }
        const divergence = detectDivergence(closes, rsiVals);
        
        let trendDirection = 'Neutral';
        let trendScore = 0;
        if (price > hullMA20 && plusDI > minusDI && adx >= ULTIMATE_CONFIG.MIN_ADX_FOR_TREND) {
            trendDirection = 'UPTREND';
            trendScore = 1;
        } else if (price < hullMA20 && minusDI > plusDI && adx >= ULTIMATE_CONFIG.MIN_ADX_FOR_TREND) {
            trendDirection = 'DOWNTREND';
            trendScore = -1;
        }
        
        const factors = calculateFactorScores(candles, rsi, adx, priceChange, volumeConf.volumeRatio);
        const sentiment = performanceTracker.getFearGreedIndex();
        const session = getSessionMultiplier();
        
        // ENSEMBLE SIGNAL GENERATION
        let signals = [];
        let weights = [];
        
        if (divergence.type !== 'None' && divergence.quality >= ULTIMATE_CONFIG.MIN_DIVERGENCE_QUALITY) {
            signals.push(divergence.type === 'Bullish' ? 'CALL' : 'PUT');
            weights.push(ULTIMATE_CONFIG.FACTOR_WEIGHTS.divergence);
        }
        
        if (factors.momentumFactor > 0.5) {
            signals.push(priceChange > 0 ? 'CALL' : 'PUT');
            weights.push(ULTIMATE_CONFIG.FACTOR_WEIGHTS.momentum);
        }
        
        if (factors.meanReversionFactor > 0.5 && adx <= ULTIMATE_CONFIG.MAX_ADX_FOR_MEAN_REVERSION) {
            signals.push(rsi < 40 ? 'CALL' : (rsi > 60 ? 'PUT' : (priceChange > 0 ? 'CALL' : 'PUT')));
            weights.push(ULTIMATE_CONFIG.FACTOR_WEIGHTS.meanReversion);
        }
        
        if (Math.abs(volumeConf.imbalance) > 0.2) {
            signals.push(volumeConf.imbalance > 0 ? 'CALL' : 'PUT');
            weights.push(ULTIMATE_CONFIG.FACTOR_WEIGHTS.volume);
        }
        
        if (trendScore !== 0 && adx >= ULTIMATE_CONFIG.MIN_ADX_FOR_TREND) {
            signals.push(trendScore === 1 ? 'CALL' : 'PUT');
            weights.push(ULTIMATE_CONFIG.FACTOR_WEIGHTS.volatility);
        }
        
        signals.push(price > vwap ? 'CALL' : 'PUT');
        weights.push(0.10);
        
        let callWeight = 0, putWeight = 0, totalWeight = 0;
        for (let i = 0; i < signals.length; i++) {
            if (signals[i] === 'CALL') callWeight += weights[i];
            else if (signals[i] === 'PUT') putWeight += weights[i];
            totalWeight += weights[i];
        }
        
        let finalSignal = 'NEUTRAL';
        let ensembleConfidence = 0;
        
        if (totalWeight > 0) {
            const callPercentage = (callWeight / totalWeight) * 100;
            const putPercentage = (putWeight / totalWeight) * 100;
            
            if (callPercentage > putPercentage) {
                finalSignal = 'CALL';
                ensembleConfidence = callPercentage;
            } else {
                finalSignal = 'PUT';
                ensembleConfidence = putPercentage;
            }
        }
        
        // CONFIDENCE & PROBABILITY CALCULATION
        let finalConfidence = ensembleConfidence;
        finalConfidence += (adx >= 35 ? 10 : adx >= 25 ? 6 : adx >= 18 ? 3 : 0);
        finalConfidence += volumeConf.confidence;
        finalConfidence += divergence.quality / 6;
        finalConfidence += sentiment.score * 8;
        
        // TREND ALIGNMENT
        let trendAlignment = 'NEUTRAL';
        let trendAlignmentBonus = 0;
        
        if ((trendScore === 1 && finalSignal === 'CALL') || (trendScore === -1 && finalSignal === 'PUT')) {
            trendAlignment = 'WITH TREND ✅';
            trendAlignmentBonus = 12;
            finalConfidence += 12;
        } else if ((trendScore === 1 && finalSignal === 'PUT') || (trendScore === -1 && finalSignal === 'CALL')) {
            trendAlignment = 'AGAINST TREND ⚠️';
            trendAlignmentBonus = 5;
            finalConfidence += 5;
        }
        
        if (finalSignal === 'CALL' && rsi < 35) finalConfidence += 8;
        if (finalSignal === 'PUT' && rsi > 65) finalConfidence += 8;
        
        finalConfidence = finalConfidence * session.multiplier;
        finalConfidence = Math.min(96, Math.max(45, finalConfidence));
        
        // PROBABILITY %
        const historicalWR = performanceTracker.getStrategyWinRate('ULTIMATE_ENSEMBLE');
        let probability = finalConfidence;
        if (historicalWR > 55 && historicalWR !== 55) {
            probability = (finalConfidence * 0.6) + (historicalWR * 0.4);
        }
        probability = Math.min(94, Math.max(45, probability));
        
        const calibratedConfidence = performanceTracker.getCalibratedConfidence(finalConfidence, 'ULTIMATE_ENSEMBLE');
        const skipCheck = performanceTracker.shouldSkip('ULTIMATE_ENSEMBLE', calibratedConfidence, pairName, finalSignal, timeframe);
        
        if (!skipCheck.skip) {
            performanceTracker.recordSignal(pairName, finalSignal, timeframe);
        }
        
        const position = calculatePositionSize(accountBalance, atr, price, calibratedConfidence);
        const expiry = calculateOptimalExpiry(atr, price, volatilityPercent, timeframe);
        
        const intensity = calibratedConfidence >= 90 ? '🏆🏆🏆 ULTIMATE' :
                         calibratedConfidence >= 85 ? '🔴🔴🔴 EXTREME' :
                         calibratedConfidence >= 78 ? '🔴🔴 STRONG' :
                         calibratedConfidence >= 68 ? '🟠 MODERATE' :
                         calibratedConfidence >= 58 ? '🟡 WEAK' : '⚪ LOW';
        
        return {
            signal: finalSignal,
            confidence: Math.round(calibratedConfidence),
            probability: Math.round(probability),
            intensity,
            rsi: rsi.toFixed(1),
            adx: adx.toFixed(1),
            adxStrength: adx >= 40 ? 'STRONG TREND' : adx >= 25 ? 'WEAK TREND' : 'SIDEWAYS',
            priceChange: priceChange.toFixed(2),
            trendDirection,
            trendAlignment,
            trendAlignmentBonus,
            volatilityPercent: volatilityPercent.toFixed(2),
            divergence: divergence.type,
            divergenceQuality: divergence.quality.toFixed(0),
            volumeQuality: volumeConf.reason,
            volumeRatio: volumeConf.volumeRatio?.toFixed(2) || '1.00',
            volumeImbalance: `${(volumeConf.imbalance*100).toFixed(1)}%`,
            sentiment: sentiment.sentiment,
            sentimentScore: sentiment.score.toFixed(2),
            session: session.name,
            sessionMultiplier: session.multiplier,
            strategyUsed: 'ULTIMATE_ENSEMBLE',
            ensembleVotes: signals.length,
            riskReward: `${ULTIMATE_CONFIG.ATR_MULTIPLIER_SL}:${ULTIMATE_CONFIG.ATR_MULTIPLIER_TP}`,
            expiry,
            positionSize: position.size.toFixed(4),
            stopLossPips: (position.stopLoss / price * 10000).toFixed(1),
            takeProfitPips: (position.takeProfit / price * 10000).toFixed(1),
            riskAmount: `$${position.riskAmount.toFixed(2)}`,
            recommendation: calibratedConfidence >= 75 ? '✅ STRONG SIGNAL - Consider trading' : 
                           calibratedConfidence >= 65 ? '⚠️ MODERATE SIGNAL - Low risk size' :
                           '⚠️ WEAK SIGNAL - Skip or minimal size',
            shouldTrade: (calibratedConfidence >= ULTIMATE_CONFIG.MIN_CONFIDENCE && !skipCheck.skip) ? '✅ READY TO EXECUTE' : '⚠️ SKIP',
            skipReason: skipCheck.skip ? skipCheck.reason : null,
            timeframe: tfConfig.name,
            timestamp: new Date().toISOString()
        };
        
    } catch(e) {
        console.error('Analyzer error:', e);
        return createErrorResponse(tf);
    }
}

function createErrorResponse(timeframe) {
    return {
        signal: 'NEUTRAL', confidence: 50, probability: 50, intensity: 'LOW',
        rsi: '50', adx: '20', adxStrength: 'Error', trendDirection: 'Unknown',
        trendAlignment: 'UNKNOWN', divergence: 'None', strategyUsed: 'Error',
        volatilityPercent: 'N/A', priceChange: '0', volumeQuality: 'Normal',
        session: 'Unknown', riskReward: 'N/A', expiry: 15,
        recommendation: 'ERROR - Check data', shouldTrade: 'SKIP',
        timeframe: timeframe || '15m'
    };
}

module.exports = { 
    analyzeSignal, 
    recordTradeOutcome: performanceTracker.recordTradeOutcome.bind(performanceTracker)
};
