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
        // Cooldown check
        const cooldownKey = userId ? `${userId}_${pair.name}` : pair.name;
        const lastSignal = this.cooldown.get(cooldownKey);
        if (lastSignal && Date.now() - lastSignal < 180000) {
            const remaining = Math.ceil((180000 - (Date.now() - lastSignal)) / 60000);
            return this.neutral(pair.name, timeframe, `⏱️ Cooldown: ${remaining} min left.`);
        }

        let direction = 'NEUTRAL';
        let confidence = 0;
        let expiry = timeframe === '1m' ? '3 min' : timeframe === '5m' ? '10 min' : '1 hour';
        let suggestedRiskPercent = 1;
        let suggestedStake = '$5 – $10';
        const reasons = [];

        // ========== USE BUY/SELL PERCENTAGE FROM YOUR CHART ==========
        // Based on your 12:42 AM screenshot:
        // Buy: 47% | Sell: 53% (Slight bearish)
        
        // You MUST update these values based on what you see on your chart
        const buyPercent = 47;   // ← UPDATE from your chart
        const sellPercent = 53;  // ← UPDATE from your chart
        
        // For strong sentiment (70%+), give high confidence signal
        if (sellPercent >= 70) {
            direction = 'PUT';
            confidence = 78 + Math.min(17, sellPercent - 70);
            reasons.push(`✅ Strong bearish sentiment: ${sellPercent}% sell`);
            reasons.push(`➡️ Price likely to continue down`);
        }
        else if (buyPercent >= 70) {
            direction = 'CALL';
            confidence = 78 + Math.min(17, buyPercent - 70);
            reasons.push(`✅ Strong bullish sentiment: ${buyPercent}% buy`);
            reasons.push(`➡️ Price likely to continue up`);
        }
        // Moderate sentiment (55-69%) – lower confidence
        else if (sellPercent > buyPercent) {
            direction = 'PUT';
            confidence = 68 + Math.floor((sellPercent - 50) / 2);
            reasons.push(`🟡 Moderate bearish sentiment: ${sellPercent}% sell`);
        }
        else if (buyPercent > sellPercent) {
            direction = 'CALL';
            confidence = 68 + Math.floor((buyPercent - 50) / 2);
            reasons.push(`🟡 Moderate bullish sentiment: ${buyPercent}% buy`);
        }
        else {
            reasons.push(`❌ No clear sentiment – Buy ${buyPercent}% / Sell ${sellPercent}%`);
            return { pair: pair.name, direction: 'NEUTRAL', confidence: 0, reasons, rsi: 50, adx: 20, timeframe, expiry, suggestedStake, suggestedRiskPercent };
        }

        confidence = Math.min(92, Math.max(65, confidence));
        
        reasons.push(`📊 Confidence: ${confidence}%`);
        reasons.push(`💰 Risk: ${suggestedRiskPercent}% (${suggestedStake})`);
        reasons.push(`⏱️ Expiry: ${expiry}`);

        this.cooldown.set(cooldownKey, Date.now());

        return { pair: pair.name, direction, confidence, reasons: reasons.slice(0, 6), rsi: 50, adx: 20, timeframe, expiry, suggestedStake, suggestedRiskPercent };
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
