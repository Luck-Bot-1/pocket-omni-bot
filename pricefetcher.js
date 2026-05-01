// pricefetcher.js – Generates realistic mock candlestick data
// No external APIs, always returns valid data for charts
class PriceFetcher {
    constructor() {
        this.cache = new Map();
        this.cacheTTL = 30000;
    }

    async fetchOHLCV(symbol, interval = '5m', limit = 200) {
        const cacheKey = `${symbol}_${interval}_${limit}`;
        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
            return cached.data;
        }

        // Generate realistic candlestick data with trend and volatility
        const candles = [];
        let price = symbol.includes('USD') ? 1.1000 : 100.00;
        // Random walk with slight trend
        const trend = Math.random() > 0.5 ? 0.00015 : -0.00015;
        for (let i = 0; i < limit; i++) {
            const change = trend + (Math.random() - 0.5) * 0.002;
            price += change;
            const open = price;
            const close = price + (Math.random() - 0.5) * 0.0015;
            const high = Math.max(open, close) + Math.random() * 0.001;
            const low = Math.min(open, close) - Math.random() * 0.001;
            candles.push({
                time: Date.now() - (limit - i) * 60000,
                open: open,
                high: high,
                low: low,
                close: close,
                volume: 100 + Math.random() * 200
            });
        }
        this.cache.set(cacheKey, { data: candles, timestamp: Date.now() });
        return candles;
    }
}
module.exports = new PriceFetcher();
