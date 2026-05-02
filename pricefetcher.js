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

    // -------------------------------------------------------------
    // Pocket Option WebSocket (for true OTC data)
    // -------------------------------------------------------------
    async connectWebSocket() {
        if (this.wsConnected) return true;
        if (!this.ssid) return false;
        return new Promise((resolve) => {
            const url = 'wss://ws1.pocketoption.com/socket.io/?EIO=4&transport=websocket';
            this.socket = io(url, { transports: ['websocket'] });
            this.socket.on('connect', () => {
                this.wsConnected = true;
                this.socket.emit('message', `42["auth",{"session":"${this.ssid}","isDemo":${this.isDemo ? 1 : 0},"platform":2}]`);
                resolve(true);
            });
            this.socket.on('connect_error', () => resolve(false));
            setTimeout(() => {
                if (!this.wsConnected) resolve(false);
            }, 8000);
        });
    }

    async fetchOTCfromWebSocket(symbol, interval, limit) {
        await this.connectWebSocket();
        if (!this.wsConnected) return null;
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
            return candles.map(c => ({
                time: c.time,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume || 0
            }));
        });
    }

    // -------------------------------------------------------------
    // Yahoo Finance (for live pairs AND fallback for OTC)
    // -------------------------------------------------------------
    async fetchFromYahoo(symbol, interval, limit) {
        try {
            const intervalMap = { '1m':'1m','5m':'5m','15m':'15m','30m':'30m','1h':'60m','4h':'60m','1d':'1d' };
            const yfInterval = intervalMap[interval] || '5m';
            const end = new Date();
            const start = new Date(Date.now() - limit * 60000);
            const result = await yahooFinance.chart(symbol, { interval: yfInterval, period1: start, period2: end });
            if (!result || !result.quotes) return null;
            return result.quotes.filter(q => q.close !== null).map(q => ({
                time: new Date(q.date).getTime(),
                open: q.open,
                high: q.high,
                low: q.low,
                close: q.close,
                volume: q.volume || 0
            }));
        } catch (err) {
            console.error(`Yahoo error for ${symbol}:`, err.message);
            return null;
        }
    }

    // -------------------------------------------------------------
    // Main entry: routes to correct source
    // -------------------------------------------------------------
    async fetchOHLCV(symbol, interval = '5m', limit = 200) {
        const cacheKey = `${symbol}_${interval}_${limit}`;
        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.cacheTTL)
            return cached.data;

        let data = null;
        const isOTC = symbol.toLowerCase().includes('_otc');

        if (isOTC) {
            // 1) Try WebSocket for true OTC data
            data = await this.fetchOTCfromWebSocket(symbol, interval, limit);
            // 2) If WebSocket fails, fallback to Yahoo Finance using base symbol (remove _otc)
            if (!data) {
                const baseSymbol = symbol.replace(/_otc$/, '');
                // Map common symbols to Yahoo format
                let yahooSymbol = baseSymbol;
                if (baseSymbol === 'BTC/USD') yahooSymbol = 'BTC-USD';
                if (baseSymbol === 'ETH/USD') yahooSymbol = 'ETH-USD';
                if (baseSymbol === 'XAU/USD') yahooSymbol = 'GC=F';
                if (baseSymbol === 'XAG/USD') yahooSymbol = 'SI=F';
                if (baseSymbol.includes('/')) yahooSymbol = baseSymbol.replace('/', '');
                console.log(`⚠️ OTC WebSocket failed for ${symbol}, falling back to Yahoo: ${yahooSymbol}`);
                data = await this.fetchFromYahoo(yahooSymbol, interval, limit);
            }
        } else {
            // Live pair – Yahoo Finance only
            data = await this.fetchFromYahoo(symbol, interval, limit);
        }

        // Final fallback (never return null)
        if (!data || data.length < 10) {
            console.warn(`⚠️ No real data for ${symbol}, using mock candles`);
            data = this.generateMockCandles(symbol, limit);
        }

        this.cache.set(cacheKey, { data, timestamp: Date.now() });
        return data;
    }

    // Emergency mock candles (never fail)
    generateMockCandles(symbol, limit) {
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
