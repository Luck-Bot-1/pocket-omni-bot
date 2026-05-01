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
        this.fallbackMode = !this.ssid;
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
            this.socket.on('connect_error', () => { this.fallbackMode = true; resolve(false); });
            setTimeout(() => { if (!this.connected) { this.fallbackMode = true; resolve(false); } }, 5000);
        });
    }

    async fetchOTC(symbol, interval, limit) {
        await this.connectWebSocket();
        if (!this.connected) return null;
        const requestId = `candles_${Date.now()}_${Math.random()}`;
        return new Promise((resolve) => {
            this.pendingRequests.set(requestId, resolve);
            setTimeout(() => { this.pendingRequests.delete(requestId); resolve(null); }, 10000);
            this.socket.emit('message', JSON.stringify(["candles", { asset: symbol, interval: parseInt(interval), period: limit, requestId }]));
        }).then(candles => {
            if (!candles) return null;
            return candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 }));
        });
    }

    async fetchLive(symbol, interval, limit) {
        try {
            const intervalMap = { '1m':'1m','5m':'5m','15m':'15m','30m':'30m','1h':'1h','4h':'1h','1d':'1d' };
            const yfInterval = intervalMap[interval] || '5m';
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

    generateMock(symbol, limit) {
        const candles = [];
        let price = symbol.includes('USD') ? 1.1000 : 100.00;
        const trend = Math.random() > 0.5 ? 0.0002 : -0.0002;
        for (let i = 0; i < limit; i++) {
            const change = trend + (Math.random() - 0.5) * 0.003;
            price += change;
            const open = price;
            const close = price + (Math.random() - 0.5) * 0.002;
            const high = Math.max(open, close) + Math.random() * 0.001;
            const low = Math.min(open, close) - Math.random() * 0.001;
            candles.push({
                time: Date.now() - (limit - i) * 60000,
                open, high, low, close,
                volume: 100 + Math.random() * 200
            });
        }
        return candles;
    }

    async fetchOHLCV(symbol, interval = '5m', limit = 200) {
        const cacheKey = `${symbol}_${interval}_${limit}`;
        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.cacheTTL) return cached.data;

        let data = null;
        const isOTC = symbol.toLowerCase().includes('_otc');
        if (isOTC) {
            data = await this.fetchOTC(symbol, interval, limit);
            if (!data && this.fallbackMode) data = this.generateMock(symbol, limit);
        } else {
            data = await this.fetchLive(symbol, interval, limit);
            if (!data) data = this.generateMock(symbol, limit);
        }
        if (data) {
            this.cache.set(cacheKey, { data, timestamp: Date.now() });
            return data;
        }
        return this.generateMock(symbol, limit);
    }
}
module.exports = new PriceFetcher();
