// pricefetcher.js – Self-contained realistic mock data (always works)
// No external dependencies, no API calls, no WebSocket needed

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

        // Generate realistic candlestick data
        const candles = [];
        let price = symbol.includes('USD') ? 1.1000 : 100.00;
        const trend = Math.random() > 0.5 ? 0.0002 : -0.0002; // slow trend
        
        for (let i = 0; i < limit; i++) {
            const change = trend + (Math.random() - 0.5) * 0.003;
            price += change;
            const open = price;
            const close = price + (Math.random() - 0.5) * 0.002;
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
