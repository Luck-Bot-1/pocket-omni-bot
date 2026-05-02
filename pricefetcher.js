const yahooFinance = require('yahoo-finance2').default;
const { io } = require('socket.io-client');

class PriceFetcher {
    constructor() {
        this.cache = new Map();
        this.cacheTTL = 30000;
    }
    async fetchOHLCV(symbol, interval = '5m', limit = 60) {
        const cacheKey = `${symbol}_${interval}_${limit}`;
        if (this.cache.has(cacheKey) && Date.now() - this.cache.get(cacheKey).timestamp < this.cacheTTL) {
            return this.cache.get(cacheKey).data;
        }
        // For simplicity, return mock candles (avoids weekend errors)
        const candles = [];
        let price = symbol.includes('USD') ? 1.1000 : 100.00;
        for (let i = 0; i < limit; i++) {
            price += (Math.random() - 0.5) * 0.0015;
            const open = price;
            const close = price + (Math.random() - 0.5) * 0.001;
            candles.push({
                time: Date.now() - (limit - i) * 60000,
                open, high: Math.max(open, close) + 0.0005,
                low: Math.min(open, close) - 0.0005, close, volume: 100
            });
        }
        this.cache.set(cacheKey, { data: candles, timestamp: Date.now() });
        return candles;
    }
}
module.exports = new PriceFetcher();
