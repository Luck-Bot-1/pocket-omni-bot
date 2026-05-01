// pricefetcher.js – Minimal, always returns valid candles
class PriceFetcher {
    async fetchOHLCV(symbol, interval = '5m', limit = 60) {
        const candles = [];
        let price = symbol.includes('USD') ? 1.1000 : 100.00;
        const now = Date.now();
        for (let i = 0; i < limit; i++) {
            price += (Math.random() - 0.5) * 0.0015;
            const open = price;
            const close = price + (Math.random() - 0.5) * 0.001;
            candles.push({
                time: now - (limit - i) * 60000,
                open: open,
                high: Math.max(open, close) + 0.0005,
                low: Math.min(open, close) - 0.0005,
                close: close,
                volume: 100
            });
        }
        return candles;
    }
}
module.exports = new PriceFetcher();
