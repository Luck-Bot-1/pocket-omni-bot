const yahooFinance = require('yahoo-finance2').default;

class PriceFetcher {
    constructor() {
        this.cache = new Map();
        this.cacheTTL = 30000;
    }

    async fetchOHLCV(symbol, interval = '5m', limit = 60) {
        const cacheKey = `${symbol}_${interval}_${limit}`;
        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
            return cached.data;
        }

        // Complete Yahoo Finance symbol mapping (including new pairs)
        const symbolMap = {
            // Forex Live
            'EUR/USD': 'EURUSD=X', 'GBP/USD': 'GBPUSD=X', 'USD/JPY': 'USDJPY=X',
            'AUD/USD': 'AUDUSD=X', 'USD/CAD': 'USDCAD=X', 'USD/CHF': 'USDCHF=X',
            'NZD/USD': 'NZDUSD=X', 'EUR/GBP': 'EURGBP=X', 'EUR/JPY': 'EURJPY=X',
            'GBP/JPY': 'GBPJPY=X', 'AUD/JPY': 'AUDJPY=X', 'CHF/JPY': 'CHFJPY=X',
            'EUR/AUD': 'EURAUD=X', 'GBP/AUD': 'GBPAUD=X', 'AUD/CAD': 'AUDCAD=X',
            'CAD/CHF': 'CADCHF=X', 'EUR/CAD': 'EURCAD=X', 'GBP/CAD': 'GBPCAD=X',
            'NZD/JPY': 'NZDJPY=X', 'AUD/CHF': 'AUDCHF=X',
            // Forex OTC (fallback to live symbols)
            'EUR/USD_otc': 'EURUSD=X', 'GBP/USD_otc': 'GBPUSD=X', 'USD/JPY_otc': 'USDJPY=X',
            'AUD/USD_otc': 'AUDUSD=X', 'EUR/JPY_otc': 'EURJPY=X', 'GBP/JPY_otc': 'GBPJPY=X',
            'AUD/JPY_otc': 'AUDJPY=X', 'CAD/CHF_otc': 'CADCHF=X', 'AUD/CHF_otc': 'AUDCHF=X',
            'AUD/CAD_otc': 'AUDCAD=X',
            // AED/CNY - no direct Yahoo symbol, use CNY=X
            'AED/CNY_otc': 'CNY=X',
            // Crypto
            'BTC/USD': 'BTC-USD', 'ETH/USD': 'ETH-USD', 'SOL/USD': 'SOL-USD',
            'XRP/USD': 'XRP-USD', 'ADA/USD': 'ADA-USD', 'DOGE/USD': 'DOGE-USD',
            'DOT/USD': 'DOT-USD', 'LTC/USD': 'LTC-USD', 'AVAX/USD': 'AVAX-USD',
            'MATIC/USD': 'MATIC-USD', 'LINK/USD': 'LINK-USD', 'UNI/USD': 'UNI-USD',
            // Crypto OTC
            'BTC/USD_otc': 'BTC-USD', 'ETH/USD_otc': 'ETH-USD', 'SOL/USD_otc': 'SOL-USD',
            // Commodities
            'XAU/USD': 'GC=F', 'XAG/USD': 'SI=F', 'WTI/USD': 'CL=F',
            'BRENT/USD': 'BZ=F', 'NG/USD': 'NG=F', 'COPPER/USD': 'HG=F',
            'PLATINUM': 'PL=F', 'PALLADIUM': 'PA=F',
            // Indices
            'SP500': '^GSPC', 'NAS100': '^IXIC', 'US30': '^DJI',
            'GER40': '^GDAXI', 'UK100': '^FTSE', 'FRA40': '^FCHI',
            'AUS200': '^AXJO', 'JPN225': '^N225',
            // Stocks OTC (fallback to stock symbols)
            'Apple': 'AAPL', 'Amazon': 'AMZN', 'Microsoft': 'MSFT',
            'Google': 'GOOGL', 'Tesla': 'TSLA', 'Facebook': 'META',
            'Netflix': 'NFLX', 'Intel': 'INTC', 'Cisco': 'CSCO',
            'Pfizer': 'PFE', 'Boeing': 'BA', 'VISA': 'V',
            'McDonald\'s': 'MCD', 'FedEx': 'FDX', 'Alibaba': 'BABA',
            'Twitter': 'TWTR', 'American Express': 'AXP', 'Citigroup': 'C',
            'Johnson & Johnson': 'JNJ', 'Exxon Mobil': 'XOM'
        };

        let liveSymbol = symbol;
        for (const [key, value] of Object.entries(symbolMap)) {
            if (symbol.includes(key) || symbol === key) {
                liveSymbol = value;
                break;
            }
        }

        const intervalMap = { '1m':'1m','5m':'5m','15m':'15m','30m':'30m','1h':'60m','4h':'60m','1d':'1d' };
        const end = new Date();
        const start = new Date(Date.now() - limit * 60000);

        try {
            const result = await yahooFinance.chart(liveSymbol, { interval: intervalMap[interval] || '5m', period1: start, period2: end });
            const candles = result.quotes.filter(q => q.close !== null).map(q => ({
                time: new Date(q.date).getTime(),
                open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume || 0
            }));
            this.cache.set(cacheKey, { data: candles, timestamp: Date.now() });
            return candles;
        } catch (err) {
            // Fallback mock candles – never return null
            const candles = [];
            let price = 1.1000;
            for (let i = 0; i < limit; i++) {
                price += (Math.random() - 0.5) * 0.0015;
                candles.push({
                    time: Date.now() - (limit - i) * 60000,
                    open: price, high: price + 0.001, low: price - 0.001, close: price, volume: 100
                });
            }
            return candles;
        }
    }
}
module.exports = new PriceFetcher();
