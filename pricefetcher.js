const yahooFinance = require('yahoo-finance2').default;
const { io } = require('socket.io-client');

class PriceFetcher {
    constructor() {
        this.socket = null;
        this.connected = false;
        this.ssid = process.env.PO_SSID || null;
        this.isDemo = process.env.PO_DEMO === 'true';
        this.cache = new Map();
        this.cacheTTL = 30000;
        this.pendingRequests = new Map();
    }

    async connectWebSocket() {
        if (this.connected) return true;
        if (!this.ssid) return false;
        return new Promise((resolve) => {
            const url = 'wss://ws1.pocketoption.com/socket.io/?EIO=4&transport=websocket';
            this.socket = io(url, { transports: ['websocket'] });
            this.socket.on('connect', () => {
                this.connected = true;
                this.socket.emit('message', `42["auth",{"session":"${this.ssid}","isDemo":${this.isDemo ? 1 : 0},"platform":2}]`);
                resolve(true);
            });
            this.socket.on('connect_error', () => resolve(false));
            setTimeout(() => resolve(false), 8000);
        });
    }

    async fetchOTC(symbol, interval, limit) {
        await this.connectWebSocket();
        if (!this.connected) return null;
        const requestId = `candles_${Date.now()}_${Math.random()}`;
        return new Promise((resolve) => {
            this.pendingRequests.set(requestId, resolve);
            setTimeout(() => {
                this.pendingRequests.delete(requestId);
                resolve(null);
            }, 10000);
            this.socket.emit('message', JSON.stringify(["candles", { asset: symbol, interval: parseInt(interval), period: limit, requestId }]));
        }).then(candles => {
            if (!candles) return null;
            return candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 }));
        });
    }

    async fetchLive(symbol, interval, limit) {
        try {
            const yfInterval = { '1m':'1m','5m':'5m','15m':'15m','30m':'30m','1h':'60m','4h':'60m','1d':'1d' }[interval] || '5m';
            const end = new Date();
            const start = new Date(Date.now() - limit * 60000);
            const result = await yahooFinance.chart(symbol, { interval: yfInterval, period1: start, period2: end });
            return result.quotes.filter(q => q.close).map(q => ({
                time: new Date(q.date).getTime(),
                open: q.open,
                high: q.high,
                low: q.low,
                close: q.close,
                volume: q.volume || 0
            }));
        } catch (err) {
            return null;
        }
    }

    async fetchOHLCV(symbol, interval = '5m', limit = 200) {
        const cacheKey = `${symbol}_${interval}_${limit}`;
        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.cacheTTL) return cached.data;

        const isOTC = symbol.toLowerCase().includes('_otc');
        const data = isOTC ? await this.fetchOTC(symbol, interval, limit) : await this.fetchLive(symbol, interval, limit);
        if (data && data.length) {
            this.cache.set(cacheKey, { data, timestamp: Date.now() });
            return data;
        }
        return null;
    }
}
module.exports = new PriceFetcher();
