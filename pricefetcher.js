const { io } = require('socket.io-client');

class PriceFetcher {
    constructor() {
        this.socket = null;
        this.isConnected = false;
        this.cache = new Map();
        this.cacheTTL = 30000;
        this.pendingRequests = new Map();
        this.ssid = process.env.PO_SSID || null;
        this.isDemo = process.env.PO_DEMO === 'true' || true;
    }

    async connect() {
        if (this.isConnected) return true;

        return new Promise((resolve, reject) => {
            const socketUrl = 'wss://ws1.pocketoption.com/socket.io/?EIO=4&transport=websocket';
            
            this.socket = io(socketUrl, {
                transports: ['websocket'],
                reconnection: true,
                reconnectionAttempts: 5
            });

            this.socket.on('connect', () => {
                console.log('✅ Connected to Pocket Option');
                this.isConnected = true;
                if (this.ssid) this.authenticate();
                resolve(true);
            });

            this.socket.on('connect_error', (error) => {
                console.error('❌ Connection error:', error);
                reject(error);
            });

            this.socket.on('message', (data) => {
                this.handleMessage(data);
            });
        });
    }

    authenticate() {
        if (!this.socket || !this.ssid) return;
        
        // If SSID already includes the full 42["auth",...] payload, use it directly
        let authMessage = this.ssid;
        if (!authMessage.startsWith('42["auth"')) {
            authMessage = `42["auth",${JSON.stringify({ session: this.ssid, isDemo: this.isDemo ? 1 : 0, platform: 2 })}]`;
        }
        
        this.socket.emit('message', authMessage);
        console.log('🔐 Authenticated with Pocket Option');
    }

    handleMessage(data) {
        try {
            const parsed = JSON.parse(data);
            
            if (Array.isArray(parsed) && parsed[0] === 'price-update') {
                const priceData = parsed[1];
                const symbol = priceData.asset;
                const price = priceData.price;
                
                if (symbol) {
                    this.cache.set(`price_${symbol}`, {
                        price: price,
                        timestamp: Date.now(),
                        bid: priceData.bid,
                        ask: priceData.ask
                    });
                }
            }
            
            if (Array.isArray(parsed) && parsed[0] === 'candles') {
                const requestId = parsed[1]?.requestId;
                const candles = parsed[1]?.data;
                
                if (requestId && this.pendingRequests.has(requestId)) {
                    const resolve = this.pendingRequests.get(requestId);
                    resolve(candles);
                    this.pendingRequests.delete(requestId);
                }
            }
        } catch (error) {
            // Not JSON, ignore
        }
    }

    async fetchOHLCV(symbol, interval = '60', limit = 200) {
        // Ensure _otc suffix
        let otcSymbol = symbol;
        if (!symbol.toLowerCase().includes('_otc')) {
            otcSymbol = `${symbol}_otc`;
        }
        
        const cacheKey = `${otcSymbol}_${interval}_${limit}`;
        const cached = this.cache.get(cacheKey);
        
        if (cached && (Date.now() - cached.timestamp) < this.cacheTTL) {
            return cached.data;
        }

        if (!this.isConnected) {
            await this.connect();
        }

        return new Promise((resolve, reject) => {
            const requestId = `candles_${Date.now()}_${Math.random()}`;
            this.pendingRequests.set(requestId, resolve);
            
            setTimeout(() => {
                if (this.pendingRequests.has(requestId)) {
                    this.pendingRequests.delete(requestId);
                    reject(new Error(`Timeout for ${otcSymbol}`));
                }
            }, 10000);
            
            const requestMessage = JSON.stringify([
                "candles",
                {
                    asset: otcSymbol,
                    interval: parseInt(interval),
                    period: limit,
                    requestId: requestId
                }
            ]);
            
            this.socket?.emit('message', requestMessage);
        }).then(candles => {
            const formattedCandles = candles.map(candle => ({
                time: candle.time,
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                volume: candle.volume || 0
            }));
            
            this.cache.set(cacheKey, {
                data: formattedCandles,
                timestamp: Date.now()
            });
            
            return formattedCandles;
        }).catch(error => {
            console.error(`Error fetching ${otcSymbol}:`, error.message);
            return null;
        });
    }

    async fetchCurrentPrice(symbol) {
        let otcSymbol = symbol;
        if (!symbol.toLowerCase().includes('_otc')) {
            otcSymbol = `${symbol}_otc`;
        }
        
        const cached = this.cache.get(`price_${otcSymbol}`);
        if (cached && (Date.now() - cached.timestamp) < 5000) {
            return cached.price;
        }
        
        if (!this.isConnected) {
            await this.connect();
        }
        
        const subscribeMessage = JSON.stringify([
            "subscribe",
            { asset: otcSymbol }
        ]);
        
        this.socket?.emit('message', subscribeMessage);
        
        return new Promise((resolve) => {
            const checkCache = setInterval(() => {
                const cachedPrice = this.cache.get(`price_${otcSymbol}`);
                if (cachedPrice && (Date.now() - cachedPrice.timestamp) < 10000) {
                    clearInterval(checkCache);
                    resolve(cachedPrice.price);
                }
            }, 100);
            
            setTimeout(() => {
                clearInterval(checkCache);
                resolve(null);
            }, 5000);
        });
    }

    disconnect() {
        if (this.socket) {
            this.socket.disconnect();
            this.isConnected = false;
        }
    }
}

module.exports = new PriceFetcher();
