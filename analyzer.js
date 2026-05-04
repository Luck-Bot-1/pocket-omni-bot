const yahooFinance = require('yahoo-finance2').default;
const { io } = require('socket.io-client');

class PriceFetcher {
    constructor() {
        this.socket = null;
        this.wsConnected = false;
        this.ssid = process.env.PO_SSID || null;
        this.isDemo = process.env.PO_DEMO === 'true';
        this.cache = new Map();
        this.cacheTTL = 30000;
        this.pendingRequests = new Map();
    }

    async connectWebSocket() {
        if (this.wsConnected) return true;
        if (!this.ssid) {
            console.log('⚠️ PO_SSID not set – OTC will use fallback');
            return false;
        }
        return new Promise((resolve) => {
            const url = 'wss://ws1.pocketoption.com/socket.io/?EIO=4&transport=websocket';
            this.socket = io(url, { transports: ['websocket'], reconnection: true });
            this.socket.on('connect', () => {
                this.wsConnected = true;
                this.socket.emit('message', this.ssid);
                console.log('✅ Connected to Pocket Option WebSocket');
                resolve(true);
            });
            this.socket.on('connect_error', (err) => {
                console.error('❌ WebSocket error:', err.message);
                resolve(false);
            });
            setTimeout(() => {
                if (!this.wsConnected) {
                    console.log('⚠️ WebSocket timeout – using fallback');
                    resolve(false);
                }
            }, 8000);
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
            'BTC/USD': 'BTC-USD', 'ETH/USD': 'ETH-USD', 'XAU/USD': 'GC=F'
        };
        let liveSymbol = symbol;
        for (const [key, value] of Object.entries(symbolMap)) {
            if (symbol.includes(key)) { liveSymbol = value; break; }
        }
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
            price += (Math.random() - 0.5) * 0.002;
            candles.push({ time: Date.now() - (limit - i) * 60000, open: price, high: price + 0.001, low: price - 0.001, close: price, volume: 100 });
        }
        return candles;
    }

    async fetchOHLCV(symbol, interval = '5m', limit = 100) {
        const cacheKey = `${symbol}_${interval}_${limit}`;
        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.cacheTTL) return cached.data;

        let data = null;
        const isOTC = symbol.toLowerCase().includes('_otc');
        if (isOTC) {
            data = await this.fetchOTCFromWebSocket(symbol, interval, limit);
            if (!data) data = this.generateMockCandles(limit);
        } else {
            data = await this.fetchFromYahoo(symbol, interval, limit);
            if (!data) data = this.generateMockCandles(limit);
        }
        if (data && data.length) this.cache.set(cacheKey, { data, timestamp: Date.now() });
        return data;
    }
}
module.exports = new PriceFetcher();
