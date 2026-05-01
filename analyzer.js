// SIMPLIFIED ANALYZER – always returns a mock signal (for testing the bot interface)
// Replace with real data later when WebSocket works

class SignalAnalyzer {
    async analyzePair(pair, timeframe = '5m', multiTF = true) {
        // Generate a random but realistic-looking signal
        const isCall = Math.random() > 0.5;
        const confidence = Math.floor(75 + Math.random() * 20); // 75-95%
        const rsi = isCall ? Math.floor(25 + Math.random() * 15) : Math.floor(55 + Math.random() * 15);
        const adx = Math.floor(20 + Math.random() * 30);
        
        const reasons = [];
        if (isCall) {
            reasons.push(`RSI oversold (${rsi}) – bullish reversal`);
            reasons.push(`MACD histogram turning positive`);
            reasons.push(`EMA9 crossing above EMA21`);
            if (adx > 25) reasons.push(`ADX confirms strong uptrend (${adx})`);
        } else {
            reasons.push(`RSI overbought (${rsi}) – bearish reversal`);
            reasons.push(`MACD histogram turning negative`);
            reasons.push(`EMA9 crossing below EMA21`);
            if (adx > 25) reasons.push(`ADX confirms strong downtrend (${adx})`);
        }
        
        return {
            pair: pair.name,
            direction: isCall ? 'CALL' : 'PUT',
            confidence: confidence,
            reasons: reasons.slice(0, 4),
            rsi: rsi,
            adx: adx,
            timeframe: timeframe
        };
    }
}

module.exports = new SignalAnalyzer();
