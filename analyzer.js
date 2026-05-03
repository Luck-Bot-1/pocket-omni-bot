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
        if (lastSignal && Date.now() - lastSignal < 300000) {
            const remaining = Math.ceil((300000 - (Date.now() - lastSignal)) / 60000);
            return this.neutral(pair.name, timeframe, `⏱️ Cooldown active. Next signal in ${remaining} min.`);
        }

        // 4. FETCH CANDLES
        const candles = await priceFetcher.fetchOHLCV(pair.symbol, timeframe, 100);
        if (!candles || candles.length < 50) return this.neutral(pair.name, timeframe, 'Insufficient data.');

        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const volumes = candles.map(c => c.volume);
        const n = closes.length;

        // 5. VOLUME SPIKE
        const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const currentVolume = volumes[volumes.length - 1];
        const volumeSpike = currentVolume > avgVolume * 1.3;
        const volumePercent = Math.round(currentVolume / avgVolume * 100 - 100);

        // 6. RSI (7)
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

        // 7. EMA (9, 21)
        const ema9 = this.calcEMA(closes, 9);
        const ema21 = this.calcEMA(closes, 21);
        const currentEma9 = ema9[ema9.length - 1];
        const currentEma21 = ema21[ema21.length - 1];

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

        // 10. ADX (14)
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

        // ========== FIXED: CRITICAL SIGNAL LOGIC ==========
        
        // CASE 1: RSI OVERSOLD (<35) + STRONG TREND (ADX > 25) = CALL SIGNAL
        if (rsi < 35 && adx > 25) {
            direction = 'CALL';
            confidence = Math.min(98, 85 + Math.floor((35 - rsi) / 2));
            if (volumeSpike) confidence = Math.min(98, confidence + 5);
            suggestedRiskPercent = confidence >= 85 ? 2 : 1.5;
            suggestedStake = confidence >= 85 ? '$10 – $20' : '$10';
            reasons.push(`✅ RSI oversold (${rsi.toFixed(1)}) + strong trend (ADX ${adx.toFixed(1)}) = CALL SIGNAL`);
            reasons.push(`➡️ Price likely to reverse or bounce upward`);
            if (volumeSpike) reasons.push(`✅ Volume spike: +${volumePercent}% confirming reversal`);
        }
        // CASE 2: RSI OVERBOUGHT (>65) + STRONG TREND (ADX > 25) = PUT SIGNAL
        else if (rsi > 65 && adx > 25) {
            direction = 'PUT';
            confidence = Math.min(98, 85 + Math.floor((rsi - 65) / 2));
            if (volumeSpike) confidence = Math.min(98, confidence + 5);
            suggestedRiskPercent = confidence >= 85 ? 2 : 1.5;
            suggestedStake = confidence >= 85 ? '$10 – $20' : '$10';
            reasons.push(`✅ RSI overbought (${rsi.toFixed(1)}) + strong trend (ADX ${adx.toFixed(1)}) = PUT SIGNAL`);
            reasons.push(`➡️ Price likely to reverse or pull back down`);
            if (volumeSpike) reasons.push(`✅ Volume spike: +${volumePercent}% confirming reversal`);
        }
        // CASE 3: RSI OVERSOLD (<40) + DEVELOPING TREND (ADX 20-25) = CALL SIGNAL (Lower confidence)
        else if (rsi < 40 && adx >= 20) {
            direction = 'CALL';
            confidence = 72 + Math.floor((40 - rsi) / 3);
            suggestedRiskPercent = 1;
            suggestedStake = '$5 – $10';
            reasons.push(`🟡 RSI low (${rsi.toFixed(1)}) + developing trend (ADX ${adx.toFixed(1)}) = CALL SIGNAL`);
            reasons.push(`➡️ Moderate confidence – potential bounce`);
        }
        // CASE 4: RSI OVERBOUGHT (>60) + DEVELOPING TREND (ADX 20-25) = PUT SIGNAL (Lower confidence)
        else if (rsi > 60 && adx >= 20) {
            direction = 'PUT';
            confidence = 70 + Math.floor((rsi - 60) / 3);
            suggestedRiskPercent = 1;
            suggestedStake = '$5 – $10';
            reasons.push(`🟡 RSI high (${rsi.toFixed(1)}) + developing trend (ADX ${adx.toFixed(1)}) = PUT SIGNAL`);
            reasons.push(`➡️ Moderate confidence – potential pullback`);
        }
        // CASE 5: Strong trend following (ADX > 25, no RSI extreme)
        else if (adx > 25 && currentEma9 > currentEma21) {
            direction = 'CALL';
            confidence = 76;
            suggestedRiskPercent = 1.5;
            suggestedStake = '$10';
            reasons.push(`✅ Strong uptrend (ADX ${adx.toFixed(1)}) = CALL SIGNAL`);
            reasons.push(`➡️ Follow the trend momentum`);
        }
        else if (adx > 25 && currentEma9 < currentEma21) {
            direction = 'PUT';
            confidence = 76;
            suggestedRiskPercent = 1.5;
            suggestedStake = '$10';
            reasons.push(`✅ Strong downtrend (ADX ${adx.toFixed(1)}) = PUT SIGNAL`);
            reasons.push(`➡️ Follow the trend momentum`);
        }
        // NO SIGNAL
        else {
            reasons.push(`❌ No clear setup – RSI ${rsi.toFixed(1)}, ADX ${adx.toFixed(1)}`);
            if (rsi < 40 && adx > 20) reasons.push(`⚠️ RSI ${rsi.toFixed(1)} + ADX ${adx.toFixed(1)} should be CALL signal. Check market conditions.`);
            if (rsi > 60 && adx > 20) reasons.push(`⚠️ RSI ${rsi.toFixed(1)} + ADX ${adx.toFixed(1)} should be PUT signal. Check market conditions.`);
            return { pair: pair.name, direction: 'NEUTRAL', confidence: 0, reasons, rsi: Math.round(rsi), adx: Math.round(adx), timeframe, expiry, suggestedStake, suggestedRiskPercent };
        }

        // Ensure confidence is between 60-98
        confidence = Math.max(60, Math.min(98, confidence));
        
        let qualityBadge = '';
        if (confidence >= 85) qualityBadge = '🟢 HIGH (4.9⭐)';
        else if (confidence >= 75) qualityBadge = '🟡 MEDIUM (4.5⭐)';
        else if (confidence >= 65) qualityBadge = '🔵 LOW-MEDIUM (4.0⭐)';
        else qualityBadge = '🔵 LOW (3.5⭐)';
        
        reasons.push(`📊 Signal quality: ${qualityBadge} | Confidence: ${confidence}%`);
        reasons.push(`💰 Suggested risk: ${suggestedRiskPercent}% of balance (${suggestedStake})`);
        reasons.push(`⏱️ Expiry: ${expiry}`);

        // Set cooldown
        this.cooldown.set(cooldownKey, Date.now());
        this.saveDailyLoss();

        return { pair: pair.name, direction, confidence, reasons: reasons.slice(0, 8), rsi: Math.round(rsi), adx: Math.round(adx), timeframe, expiry, suggestedStake, suggestedRiskPercent };
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
