const yahooFinance = require('yahoo-finance2').default;
const { io } = require('socket.io-client');

class PriceFetcher {
    constructor() {
        this.socket = null;
        this.wsConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.ssid = process.env.PO_SSID || null;
        this.isDemo = process.env.PO_DEMO === 'true';
        this.cache = new Map();
        this.cacheTTL = 30000;
        this.multiTTCache = new Map();
        this.multiTTL = 60000;
        this.pendingRequests = new Map();
    }

    async connectWebSocket() {
        if (this.wsConnected) return true;
        if (!this.ssid) return false;
        return new Promise((resolve) => {
            const url = 'wss://ws1.pocketoption.com/socket.io/?EIO=4&transport=websocket';
            this.socket = io(url, { transports: ['websocket'], reconnection: true, reconnectionAttempts: this.maxReconnectAttempts });
            this.socket.on('connect', () => {
                this.wsConnected = true;
                this.reconnectAttempts = 0;
                this.socket.emit('message', `42["auth",{"session":"${this.ssid}","isDemo":${this.isDemo ? 1 : 0},"platform":2}]`);
                console.log('✅ WebSocket connected');
                resolve(true);
            });
            this.socket.on('connect_error', () => {
                this.reconnectAttempts++;
                if (this.reconnectAttempts >= this.maxReconnectAttempts) resolve(false);
            });
            setTimeout(() => { if (!this.wsConnected) resolve(false); }, 10000);
        });
    }

    async fetchOTCFromWebSocket(symbol, interval, limit) {
        await this.connectWebSocket();
        if (!this.wsConnected) return null;
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

    async fetchFromYahoo(symbol, interval, limit) {
        const symbolMap = {
            'EUR/USD': 'EURUSD=X', 'GBP/USD': 'GBPUSD=X', 'USD/JPY': 'USDJPY=X',
            'AUD/USD': 'AUDUSD=X', 'USD/CAD': 'USDCAD=X', 'USD/CHF': 'USDCHF=X',
            'BTC/USD': 'BTC-USD', 'ETH/USD': 'ETH-USD', 'XAU/USD': 'GC=F',
            'SP500': '^GSPC', 'NAS100': '^IXIC', 'US30': '^DJI'
        };
        const liveSymbol = symbolMap[symbol] || symbol;
        const intervalMap = { '1m':'1m','5m':'5m','15m':'15m','30m':'30m','1h':'60m','4h':'60m','1d':'1d' };
        const end = new Date();
        const start = new Date(Date.now() - limit * 60000);
        try {
            const result = await yahooFinance.chart(liveSymbol, { interval: intervalMap[interval] || '5m', period1: start, period2: end });
            return result.quotes.filter(q => q.close).map(q => ({ time: new Date(q.date).getTime(), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume || 0 }));
        } catch (err) { return null; }
    }

    generateMockCandles(limit) {
        const candles = [];
        let price = 1.1000;
        for (let i = 0; i < limit; i++) {
            price += (Math.random() - 0.5) * 0.0015;
            candles.push({ time: Date.now() - (limit - i) * 60000, open: price, high: price + 0.001, low: price - 0.001, close: price, volume: 100 });
        }
        return candles;
    }

    async fetchOHLCV(symbol, interval = '5m', limit = 60, isHigherTF = false) {
        const cache = isHigherTF ? this.multiTTCache : this.cache;
        const ttl = isHigherTF ? this.multiTTL : this.cacheTTL;
        const cacheKey = `${symbol}_${interval}_${limit}`;
        const cached = cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < ttl) return cached.data;
        
        let data = null;
        const isOTC = symbol.toLowerCase().includes('_otc');
        if (isOTC) {
            data = await this.fetchOTCFromWebSocket(symbol, interval, limit);
            if (!data) {
                const liveSymbol = symbol.replace(/_otc$/, '');
                data = await this.fetchFromYahoo(liveSymbol, interval, limit);
            }
            if (!data) data = this.generateMockCandles(limit);
        } else {
            data = await this.fetchFromYahoo(symbol, interval, limit);
            if (!data) data = this.generateMockCandles(limit);
        }
        cache.set(cacheKey, { data, timestamp: Date.now() });
        return data;
    }
}
module.exports = new PriceFetcher();
