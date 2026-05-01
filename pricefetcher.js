// pricefetcher.js – Ultra‑fast synchronous mock data (no async delays)
class PriceFetcher {
    async fetchOHLCV(symbol, interval = '5m', limit = 100) {
        // Pre‑generate 100 candles once, then cache
        const cacheKey = `${symbol}_${interval}_${limit}`;
        if (this.cache && this.cache.has(cacheKey)) return this.cache.get(cacheKey);
        
        const candles = [];
        let price = symbol.includes('USD') ? 1.1000 : 100.00;
        for (let i = 0; i < limit; i++) {
            price += (Math.random() - 0.5) * 0.002;
            const open = price;
            const close = price + (Math.random() - 0.5) * 0.001;
            candles.push({
                time: Date.now() - (limit - i) * 60000,
                open: open,
                high: Math.max(open, close) + Math.random() * 0.001,
                low: Math.min(open, close) - Math.random() * 0.001,
                close: close,
                volume: 100 + Math.random() * 100
            });
        }
        if (!this.cache) this.cache = new Map();
        this.cache.set(cacheKey, candles);
        return candles;
    }
}
module.exports = new PriceFetcher();
