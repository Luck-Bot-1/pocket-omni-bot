const priceFetcher = require('./pricefetcher');
const moment = require('moment-timezone');
const fs = require('fs');
const path = require('path');

const DAILY_LOSS_FILE = path.join(__dirname, 'dailyLoss.json');

class SignalAnalyzer {
    constructor() {
        this.cooldown = new Map();
        this.dailyLossTracker = this.loadDailyLoss();
    }

    loadDailyLoss() {
        try {
            if (fs.existsSync(DAILY_LOSS_FILE)) {
                return JSON.parse(fs.readFileSync(DAILY_LOSS_FILE, 'utf8'));
            }
        } catch(e) {}
        return {};
    }

    saveDailyLoss() {
        try {
            fs.writeFileSync(DAILY_LOSS_FILE, JSON.stringify(this.dailyLossTracker, null, 2));
        } catch(e) {}
    }

    async analyzePair(pair, timeframe = '5m', userId = null) {
        // 1. MARKET SESSION CHECK
        const localHour = moment().tz('Asia/Dhaka').hour();
        const isActiveSession = (localHour >= 13 && localHour <= 21) || (localHour >= 1 && localHour <= 9);
        
        if (!isActiveSession && userId) {
            return this.neutral(pair.name, timeframe, '🌙 Outside active trading hours. Trade during London/Asia sessions.');
        }

        // 2. DAILY LOSS LIMIT
        if (userId) {
            const today = moment().format('YYYY-MM-DD');
            const userLosses = this.dailyLossTracker[userId];
            if (userLosses && userLosses.date === today && userLosses.losses >= 3) {
                return this.neutral(pair.name, timeframe, `⚠️ Daily loss limit reached (${userLosses.losses} losses). Trading paused until tomorrow.`);
            }
        }

        // 3. COOLDOWN
        const cooldownKey = userId ? `${userId}_${pair.name}` : pair.name;
        const lastSignal = this.cooldown.get(cooldownKey);
        if (lastSignal && Date.now() - lastSignal < 180000) {
            const remaining = Math.ceil((180000 - (Date.now() - lastSignal)) / 60000);
            return this.neutral(pair.name, timeframe, `⏱️ Cooldown active. Next signal in ${remaining} min.`);
        }

        // 4. FETCH CANDLES
        const candles = await priceFetcher.fetchOHLCV(pair.symbol, timeframe, 100);
        if (!candles || candles.length < 50) return this.neutral(pair.name, timeframe, 'Insufficient data.');

        // Ensure candles are from newest to oldest (correct order)
        const sortedCandles = [...candles].sort((a, b) => a.time - b.time);
        const closes = sortedCandles.map(c => c.close);
        const highs = sortedCandles.map(c => c.high);
        const lows = sortedCandles.map(c => c.low);
        const volumes = sortedCandles.map(c => c.volume);
        const n = closes.length;

        // 5. CORRECT RSI (14 period standard)
        const rsi = this.calculateRSI(closes, 14);
        const currentRsi = rsi[rsi.length - 1];

        // 6. EMA (9, 21)
        const ema9 = this.calcEMA(closes, 9);
        const ema21 = this.calcEMA(closes, 21);
        const currentEma9 = ema9[ema9.length - 1];
        const currentEma21 = ema21[ema21.length - 1];

        // 7. VOLUME SPIKE
        const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const currentVolume = volumes[volumes.length - 1];
        const volumeSpike = currentVolume > avgVolume * 1.3;
        const volumePercent = Math.round(currentVolume / avgVolume * 100 - 100);

        // 8. HIGHER TIMEFRAME (1H)
        let higherTrend = 'neutral';
        try {
            const higherCandles = await priceFetcher.fetchOHLCV(pair.symbol, '1h', 50, true);
            if (higherCandles && higherCandles.length > 20) {
                const higherCloses = higherCandles.map(c => c.close);
                const higherEma9 = this.calcEMA(higherCloses, 9);
                const higherEma21 = this.calcEMA(higherCloses, 21);
                higherTrend = higherEma9[higherEma9.length - 1] > higherEma21[higherEma21.length - 1] ? 'bullish' : 'bearish';
            }
        } catch(e) {}

        // 9. MACD
        const ema12 = this.calcEMA(closes, 12);
        const ema26 = this.calcEMA(closes, 26);
        const macdLine = ema12.map((v, i) => v - ema26[i]);
        const macdSignal = this.calcEMA(macdLine, 9);
        const currentMacd = macdLine[macdLine.length - 1];
        const currentSignal = macdSignal[macdSignal.length - 1];

        // 10. ADX & DMI (14)
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
        let suggestedRiskPercent = 1;
        let suggestedStake = '$5 – $10';

        // ADX FILTER – No signal in ranging markets (ADX < 15)
        if (adx < 15) {
            reasons.push(`⚠️ ADX ${adx.toFixed(1)} < 15 – ranging market, no signal`);
            reasons.push(`💡 Wait for ADX > 15 before trading`);
            return { pair: pair.name, direction: 'NEUTRAL', confidence: 0, reasons, rsi: Math.round(currentRsi), adx: Math.round(adx), timeframe, expiry, suggestedStake, suggestedRiskPercent };
        }

        // ========== SIGNAL LOGIC WITH CORRECT RSI ==========
        
        // CASE 1: RSI OVERSOLD (<35) + UPTREND = CALL
        if (currentRsi < 35 && plusDI > minusDI) {
            direction = 'CALL';
            confidence = Math.min(92, 80 + Math.floor((35 - currentRsi) / 2));
            if (volumeSpike) confidence = Math.min(92, confidence + 5);
            suggestedRiskPercent = confidence >= 80 ? 2 : 1;
            suggestedStake = confidence >= 80 ? '$10 – $20' : '$5 – $10';
            reasons.push(`✅ RSI oversold (${currentRsi.toFixed(1)}) + bullish trend = CALL`);
            if (volumeSpike) reasons.push(`✅ Volume spike: +${volumePercent}%`);
        }
        // CASE 2: RSI OVERBOUGHT (>65) + DOWNTREND = PUT
        else if (currentRsi > 65 && minusDI > plusDI) {
            direction = 'PUT';
            confidence = Math.min(92, 80 + Math.floor((currentRsi - 65) / 2));
            if (volumeSpike) confidence = Math.min(92, confidence + 5);
            suggestedRiskPercent = confidence >= 80 ? 2 : 1;
            suggestedStake = confidence >= 80 ? '$10 – $20' : '$5 – $10';
            reasons.push(`✅ RSI overbought (${currentRsi.toFixed(1)}) + bearish trend = PUT`);
            if (volumeSpike) reasons.push(`✅ Volume spike: +${volumePercent}%`);
        }
        // CASE 3: Strong trend following (ADX > 25)
        else if (adx > 25 && plusDI > minusDI && plusDI - minusDI > 10) {
            direction = 'CALL';
            confidence = 74;
            reasons.push(`✅ Strong uptrend (ADX ${adx.toFixed(1)}) = CALL`);
        }
        else if (adx > 25 && minusDI > plusDI && minusDI - plusDI > 10) {
            direction = 'PUT';
            confidence = 74;
            reasons.push(`✅ Strong downtrend (ADX ${adx.toFixed(1)}) = PUT`);
        }
        else {
            reasons.push(`❌ No clear setup – RSI ${currentRsi.toFixed(1)}, ADX ${adx.toFixed(1)}`);
            return { pair: pair.name, direction: 'NEUTRAL', confidence: 0, reasons, rsi: Math.round(currentRsi), adx: Math.round(adx), timeframe, expiry, suggestedStake, suggestedRiskPercent };
        }

        confidence = Math.max(60, Math.min(92, confidence));
        
        reasons.push(`📊 Quality: ${confidence >= 85 ? 'HIGH' : confidence >= 75 ? 'MEDIUM' : 'LOW'} | ${confidence}%`);
        reasons.push(`💰 Risk: ${suggestedRiskPercent}% (${suggestedStake})`);
        reasons.push(`⏱️ Expiry: ${expiry}`);

        this.cooldown.set(cooldownKey, Date.now());
        this.saveDailyLoss();

        return { pair: pair.name, direction, confidence, reasons: reasons.slice(0, 8), rsi: Math.round(currentRsi), adx: Math.round(adx), timeframe, expiry, suggestedStake, suggestedRiskPercent };
    }

    // CORRECT RSI CALCULATION (14 period standard)
    calculateRSI(values, period) {
        if (values.length < period + 1) return [50];
        let gains = 0, losses = 0;
        for (let i = 1; i <= period; i++) {
            const diff = values[i] - values[i - 1];
            if (diff >= 0) gains += diff;
            else losses -= diff;
        }
        let avgGain = gains / period;
        let avgLoss = losses / period;
        const rsi = [100 - 100 / (1 + avgGain / (avgLoss || 0.001))];
        for (let i = period + 1; i < values.length; i++) {
            const diff = values[i] - values[i - 1];
            avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
            avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
            rsi.push(100 - 100 / (1 + avgGain / (avgLoss || 0.001)));
        }
        return rsi;
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
        return { pair, direction: 'NEUTRAL', confidence: 0, reasons: [reason], rsi: 50, adx: 20, timeframe, expiry: 'N/A', suggestedStake: 'N/A', suggestedRiskPercent: 0 };
    }

    recordDailyLoss(userId) {
        const today = moment().format('YYYY-MM-DD');
        const current = this.dailyLossTracker[userId];
        if (!current || current.date !== today) {
            this.dailyLossTracker[userId] = { date: today, losses: 1 };
        } else {
            current.losses++;
            this.dailyLossTracker[userId] = current;
        }
        this.saveDailyLoss();
    }

    resetDailyLoss(userId) {
        const today = moment().format('YYYY-MM-DD');
        const current = this.dailyLossTracker[userId];
        if (current && current.date === today && current.losses > 0) {
            current.losses--;
            this.dailyLossTracker[userId] = current;
            this.saveDailyLoss();
        }
    }
}
module.exports = new SignalAnalyzer();
