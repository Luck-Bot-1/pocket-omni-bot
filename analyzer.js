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
        try { if (fs.existsSync(DAILY_LOSS_FILE)) return JSON.parse(fs.readFileSync(DAILY_LOSS_FILE, 'utf8')); } catch(e) {}
        return {};
    }
    saveDailyLoss() { fs.writeFileSync(DAILY_LOSS_FILE, JSON.stringify(this.dailyLossTracker, null, 2)); }

    async analyzePair(pair, timeframe = '5m', userId = null) {
        const cooldownKey = userId ? `${userId}_${pair.name}` : pair.name;
        const lastSignal = this.cooldown.get(cooldownKey);
        if (lastSignal && Date.now() - lastSignal < 120000) {
            const remaining = Math.ceil((120000 - (Date.now() - lastSignal)) / 60000);
            return this.neutral(pair.name, timeframe, `⏱️ Cooldown: ${remaining} min left`);
        }

        const candles = await priceFetcher.fetchOHLCV(pair.symbol, timeframe, 100);
        if (!candles || candles.length < 30) {
            return this.neutral(pair.name, timeframe, '⚠️ Waiting for market data...');
        }

        const sorted = [...candles].sort((a,b) => a.time - b.time);
        const closes = sorted.map(c => c.close);
        const highs = sorted.map(c => c.high);
        const lows = sorted.map(c => c.low);
        const volumes = sorted.map(c => c.volume);

        // RSI (14)
        let rsi = 50;
        try {
            rsi = this.calcRSI(closes, 14);
            if (isNaN(rsi)) rsi = 50;
        } catch(e) { rsi = 50; }

        // Volume spike detection
        const avgVolume = volumes.slice(-20).reduce((a,b) => a + b, 0) / 20;
        const currentVolume = volumes[volumes.length - 1];
        const volumeSpike = currentVolume > avgVolume * 1.3;
        const volumePercent = avgVolume > 0 ? Math.round(currentVolume / avgVolume * 100 - 100) : 0;

        // Simple price trend (last 20 candles)
        const recentCloses = closes.slice(-20);
        const priceChange = ((recentCloses[recentCloses.length-1] - recentCloses[0]) / recentCloses[0]) * 100;
        const isPriceUptrend = priceChange > 0.1;
        const isPriceDowntrend = priceChange < -0.1;

        // EMA (9,21)
        const ema9 = this.calcEMA(closes, 9);
        const ema21 = this.calcEMA(closes, 21);
        const isUptrend = ema9[ema9.length-1] > ema21[ema21.length-1];
        const isDowntrend = ema9[ema9.length-1] < ema21[ema21.length-1];

        // ADX & DMI (for confidence adjustment)
        let adx = 20, plusDI = 25, minusDI = 25;
        try {
            const res = this.calcADX(highs, lows, closes, 14);
            adx = res.adx; plusDI = res.plusDI; minusDI = res.minusDI;
            if (isNaN(adx)) adx = 20;
        } catch(e) { adx = 20; }

        let direction = 'NEUTRAL';
        let confidence = 65;
        let expiry = timeframe === '1m' ? '3 min' : timeframe === '5m' ? '10 min' : '1 hour';
        let reasons = [];
        let stake = '$5 – $10';
        let riskPct = 1;

        // ========== SIGNAL GENERATION (ALWAYS A DIRECTION) ==========
        let callSig = 0;
        let putSig = 0;

        // RSI contribution (40% weight)
        if (rsi < 35) callSig += 40;
        else if (rsi > 65) putSig += 40;
        else if (rsi < 45) callSig += 20;
        else if (rsi > 55) putSig += 20;

        // Price trend contribution (25% weight)
        if (isPriceUptrend) callSig += 25;
        if (isPriceDowntrend) putSig += 25;

        // EMA trend contribution (20% weight)
        if (isUptrend) callSig += 20;
        if (isDowntrend) putSig += 20;

        // DMI contribution (15% weight)
        if (plusDI > minusDI) callSig += 15;
        if (minusDI > plusDI) putSig += 15;

        // Volume spike – boosts the leading side
        if (volumeSpike) {
            if (callSig > putSig) callSig += 10;
            else if (putSig > callSig) putSig += 10;
            reasons.push(`📊 Volume spike: +${volumePercent}%`);
        }

        // Determine direction (always pick the stronger side)
        if (callSig > putSig) {
            direction = 'CALL';
            let rawConf = 65 + Math.min(25, (callSig - putSig) / 3);
            if (adx > 25) rawConf += 8;
            else if (adx > 20) rawConf += 4;
            else if (adx < 15) rawConf -= 5;
            confidence = Math.min(96, Math.max(65, rawConf));
            
            riskPct = confidence >= 80 ? 1.5 : 1;
            stake = confidence >= 80 ? '$10' : '$5 – $10';
            
            reasons.push(`📈 Trade Direction: Upward (${timeframe})`);
            if (rsi < 35) reasons.push(`✅ RSI oversold (${rsi.toFixed(1)}) – bullish signal`);
            if (isUptrend) reasons.push(`✅ Uptrend confirmed (EMA9 > EMA21)`);
            if (plusDI > minusDI) reasons.push(`✅ DMI+ dominates DMI- (${plusDI.toFixed(1)} > ${minusDI.toFixed(1)})`);
            if (priceChange > 0.2) reasons.push(`✅ Price up ${priceChange.toFixed(2)}% in last 20 candles`);
        }
        else if (putSig > callSig) {
            direction = 'PUT';
            let rawConf = 65 + Math.min(25, (putSig - callSig) / 3);
            if (adx > 25) rawConf += 8;
            else if (adx > 20) rawConf += 4;
            else if (adx < 15) rawConf -= 5;
            confidence = Math.min(96, Math.max(65, rawConf));
            
            riskPct = confidence >= 80 ? 1.5 : 1;
            stake = confidence >= 80 ? '$10' : '$5 – $10';
            
            reasons.push(`📉 Trade Direction: Downward (${timeframe})`);
            if (rsi > 65) reasons.push(`✅ RSI overbought (${rsi.toFixed(1)}) – bearish signal`);
            if (isDowntrend) reasons.push(`✅ Downtrend confirmed (EMA9 < EMA21)`);
            if (minusDI > plusDI) reasons.push(`✅ DMI- dominates DMI+ (${minusDI.toFixed(1)} > ${plusDI.toFixed(1)})`);
            if (priceChange < -0.2) reasons.push(`✅ Price down ${Math.abs(priceChange).toFixed(2)}% in last 20 candles`);
        }
        else {
            // Tie breaker: use recent price action (last candle direction)
            if (closes[closes.length-1] > closes[closes.length-2]) {
                direction = 'CALL';
                confidence = 68;
                reasons.push(`📈 Trade Direction: Upward (recent price action)`);
            } else {
                direction = 'PUT';
                confidence = 68;
                reasons.push(`📉 Trade Direction: Downward (recent price action)`);
            }
            riskPct = 1;
            stake = '$5 – $10';
        }

        // ADX context (advice, not blocking)
        if (adx < 20) {
            reasons.push(`💡 ADX ${adx.toFixed(1)} (moderate trend) – use smaller stake`);
            riskPct = Math.max(0.5, riskPct - 0.5);
        } else if (adx > 25) {
            reasons.push(`✅ ADX ${adx.toFixed(1)} (strong trend) – higher probability`);
        }

        reasons.push(`🎯 Confidence: ${confidence}%`);
        reasons.push(`💰 Suggested stake: ${stake} (${riskPct}% of balance)`);
        reasons.push(`⏱️ Expiry: ${expiry}`);

        this.cooldown.set(cooldownKey, Date.now());
        this.saveDailyLoss();
        return { pair: pair.name, direction, confidence, reasons, rsi:Math.round(rsi), adx:Math.round(adx), timeframe, expiry, suggestedStake:stake, suggestedRiskPercent:riskPct };
    }

    calcRSI(values, period) {
        if (values.length < period + 1) return 50;
        let gains = 0, losses = 0;
        for (let i = 1; i <= period; i++) {
            const diff = values[i] - values[i-1];
            if (diff >= 0) gains += diff;
            else losses -= diff;
        }
        let avgGain = gains / period;
        let avgLoss = losses / period;
        let rsi = 100 - 100 / (1 + avgGain / (avgLoss || 0.001));
        for (let i = period + 1; i < values.length; i++) {
            const diff = values[i] - values[i-1];
            avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
            avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
            rsi = 100 - 100 / (1 + avgGain / (avgLoss || 0.001));
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

    calcADX(high, low, close, period) {
        let tr = [], plusDM = [], minusDM = [];
        for (let i = 1; i < close.length; i++) {
            tr.push(Math.max(high[i]-low[i], Math.abs(high[i]-close[i-1]), Math.abs(low[i]-close[i-1])));
            const up = high[i]-high[i-1];
            const down = low[i-1]-low[i];
            plusDM.push(up > down && up > 0 ? up : 0);
            minusDM.push(down > up && down > 0 ? down : 0);
        }
        let atr = tr.slice(0, period).reduce((a,b)=>a+b,0)/period;
        let plusDI = plusDM.slice(0, period).reduce((a,b)=>a+b,0)/period;
        let minusDI = minusDM.slice(0, period).reduce((a,b)=>a+b,0)/period;
        let adx = 100 * Math.abs(plusDI - minusDI) / (plusDI + minusDI || 1);
        for (let i = period; i < tr.length; i++) {
            atr = (atr * (period-1) + tr[i]) / period;
            plusDI = (plusDI * (period-1) + plusDM[i]) / period;
            minusDI = (minusDI * (period-1) + minusDM[i]) / period;
            adx = 100 * Math.abs(plusDI - minusDI) / (plusDI + minusDI || 1);
        }
        return { adx, plusDI, minusDI };
    }

    neutral(pair, timeframe, reason) {
        return { pair, direction:'NEUTRAL', confidence:0, reasons:[reason], rsi:50, adx:20, timeframe, expiry:'N/A', suggestedStake:'N/A', suggestedRiskPercent:0 };
    }

    recordDailyLoss(userId) {
        const today = moment().format('YYYY-MM-DD');
        const cur = this.dailyLossTracker[userId];
        if (!cur || cur.date !== today) this.dailyLossTracker[userId] = { date: today, losses:1 };
        else cur.losses++;
        this.saveDailyLoss();
    }
    resetDailyLoss(userId) {
        const today = moment().format('YYYY-MM-DD');
        const cur = this.dailyLossTracker[userId];
        if (cur && cur.date === today && cur.losses > 0) cur.losses--;
        this.saveDailyLoss();
    }
}
module.exports = new SignalAnalyzer();
