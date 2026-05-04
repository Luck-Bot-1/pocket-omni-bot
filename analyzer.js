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
        if (lastSignal && Date.now() - lastSignal < 180000) {
            const remaining = Math.ceil((180000 - (Date.now() - lastSignal)) / 60000);
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

        let rsi = 50;
        try {
            rsi = this.calcRSI(closes, 14);
            if (isNaN(rsi)) rsi = 50;
        } catch(e) { rsi = 50; }

        const ema9 = this.calcEMA(closes, 9);
        const ema21 = this.calcEMA(closes, 21);
        const isUptrend = ema9[ema9.length-1] > ema21[ema21.length-1];
        const isDowntrend = ema9[ema9.length-1] < ema21[ema21.length-1];

        let adx = 20, plusDI = 25, minusDI = 25;
        try {
            const res = this.calcADX(highs, lows, closes, 14);
            adx = res.adx; plusDI = res.plusDI; minusDI = res.minusDI;
            if (isNaN(adx)) adx = 20;
        } catch(e) { adx = 20; }

        let direction = 'NEUTRAL';
        let confidence = 0;
        let expiry = timeframe === '1m' ? '3 min' : timeframe === '5m' ? '10 min' : '1 hour';
        let reasons = [];
        let stake = '$5 – $10';
        let riskPct = 1;

        const MIN_ADX = 12;
        const RSI_OVERSOLD = 35;
        const RSI_OVERBOUGHT = 65;

        if (adx < MIN_ADX) {
            reasons.push(`⚠️ ADX ${adx.toFixed(1)} < ${MIN_ADX} – ranging, no signal`);
            return { pair: pair.name, direction: 'NEUTRAL', confidence:0, reasons, rsi:Math.round(rsi), adx:Math.round(adx), timeframe, expiry, suggestedStake:stake, suggestedRiskPercent:riskPct };
        }

        // Aurix‑style text explanations (no charts)
        if (rsi < RSI_OVERSOLD && isUptrend && plusDI > minusDI) {
            direction = 'CALL';
            confidence = Math.min(92, 82 + Math.floor((RSI_OVERSOLD - rsi)/2));
            riskPct = confidence >= 82 ? 1.5 : 1;
            stake = confidence >= 82 ? '$10' : '$5 – $10';
            reasons.push(`📈 Trade Direction: Upward`);
            reasons.push(`✅ RSI oversold (${rsi.toFixed(1)}) – reversal expected`);
            reasons.push(`✅ ADX confirms a strong uptrend (${adx.toFixed(1)})`);
            reasons.push(`✅ DMI+ dominates DMI- (${plusDI.toFixed(1)} > ${minusDI.toFixed(1)}) – rising`);
        }
        else if (rsi > RSI_OVERBOUGHT && isDowntrend && minusDI > plusDI) {
            direction = 'PUT';
            confidence = Math.min(92, 82 + Math.floor((rsi - RSI_OVERBOUGHT)/2));
            riskPct = confidence >= 82 ? 1.5 : 1;
            stake = confidence >= 82 ? '$10' : '$5 – $10';
            reasons.push(`📉 Trade Direction: Downward`);
            reasons.push(`✅ RSI overbought (${rsi.toFixed(1)}) – reversal expected`);
            reasons.push(`✅ ADX confirms a strong downtrend (${adx.toFixed(1)})`);
            reasons.push(`✅ DMI- dominates DMI+ (${minusDI.toFixed(1)} > ${plusDI.toFixed(1)}) – rising`);
        }
        else if (adx > 25 && isUptrend && plusDI > minusDI) {
            direction = 'CALL';
            confidence = 74;
            reasons.push(`📈 Trade Direction: Upward`);
            reasons.push(`✅ ADX confirms a developing uptrend (${adx.toFixed(1)})`);
            reasons.push(`✅ DMI+ dominates DMI- – follow momentum`);
        }
        else if (adx > 25 && isDowntrend && minusDI > plusDI) {
            direction = 'PUT';
            confidence = 74;
            reasons.push(`📉 Trade Direction: Downward`);
            reasons.push(`✅ ADX confirms a developing downtrend (${adx.toFixed(1)})`);
            reasons.push(`✅ DMI- dominates DMI+ – follow momentum`);
        }
        else {
            reasons.push(`❌ No clear setup – RSI ${rsi.toFixed(1)}, ADX ${adx.toFixed(1)}`);
            return { pair: pair.name, direction: 'NEUTRAL', confidence:0, reasons, rsi:Math.round(rsi), adx:Math.round(adx), timeframe, expiry, suggestedStake:stake, suggestedRiskPercent:riskPct };
        }

        confidence = Math.max(65, Math.min(92, confidence));
        reasons.push(`🎯 Confidence: ${confidence}%`);
        reasons.push(`💰 Risk: ${riskPct}% (${stake})`);
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
