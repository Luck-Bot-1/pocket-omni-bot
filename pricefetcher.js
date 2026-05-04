const axios = require('axios');

class PriceFetcher {
    constructor() {
        this.cache = new Map();
        this.cacheTTL = 30000;
    }

    async fetchOHLCV(symbol, interval = '5m', limit = 100) {
        const cacheKey = `${symbol}_${interval}_${limit}`;
        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.cacheTTL) return cached.data;

        const yahooSymbol = this.getYahooSymbol(symbol);
        const intervalMap = { '1m':'1m','5m':'5m','15m':'15m','30m':'30m','1h':'1h','4h':'1h','1d':'1d' };
        const range = this.getRange(limit, interval);
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=${intervalMap[interval] || '5m'}&range=${range}`;

        try {
            const response = await axios.get(url, { timeout: 10000 });
            const result = response.data.chart.result[0];
            if (!result) throw new Error('No data');
            const timestamps = result.timestamp;
            const quote = result.indicators.quote[0];
            const candles = [];
            for (let i = 0; i < timestamps.length; i++) {
                if (quote.close[i] !== null && quote.close[i] !== undefined) {
                    candles.push({
                        time: timestamps[i] * 1000,
                        open: quote.open[i],
                        high: quote.high[i],
                        low: quote.low[i],
                        close: quote.close[i],
                        volume: quote.volume[i] || 0
                    });
                }
            }
            if (candles.length < 10) throw new Error('Not enough candles');
            this.cache.set(cacheKey, { data: candles, timestamp: Date.now() });
            console.log(`✅ ${symbol}: ${candles.length} candles`);
            return candles;
        } catch (err) {
            console.error(`❌ ${symbol}: ${err.message}`);
            console.log(`⚠️ Using mock candles for ${symbol}`);
            return this.generateMockCandles(limit);
        }
    }

    getYahooSymbol(symbol) {
        const map = {
            'EUR/USD': 'EURUSD=X', 'GBP/USD': 'GBPUSD=X', 'USD/JPY': 'USDJPY=X',
            'AUD/USD': 'AUDUSD=X', 'USD/CAD': 'USDCAD=X', 'USD/CHF': 'USDCHF=X',
            'NZD/USD': 'NZDUSD=X', 'EUR/GBP': 'EURGBP=X', 'EUR/JPY': 'EURJPY=X',
            'GBP/JPY': 'GBPJPY=X', 'AUD/JPY': 'AUDJPY=X', 'CHF/JPY': 'CHFJPY=X',
            'EUR/AUD': 'EURAUD=X', 'GBP/AUD': 'GBPAUD=X', 'AUD/CAD': 'AUDCAD=X',
            'CAD/CHF': 'CADCHF=X', 'EUR/CAD': 'EURCAD=X', 'GBP/CAD': 'GBPCAD=X',
            'NZD/JPY': 'NZDJPY=X', 'AUD/CHF': 'AUDCHF=X',
            'BTC/USD': 'BTC-USD', 'ETH/USD': 'ETH-USD', 'SOL/USD': 'SOL-USD',
            'XRP/USD': 'XRP-USD', 'ADA/USD': 'ADA-USD', 'DOGE/USD': 'DOGE-USD',
            'LTC/USD': 'LTC-USD', 'DOT/USD': 'DOT-USD', 'AVAX/USD': 'AVAX-USD',
            'MATIC/USD': 'MATIC-USD', 'LINK/USD': 'LINK-USD',
            'XAU/USD': 'GC=F', 'XAG/USD': 'SI=F', 'WTI/USD': 'CL=F', 'BRENT/USD': 'BZ=F',
            'SP500': '^GSPC', 'NAS100': '^IXIC', 'US30': '^DJI',
            'GER40': '^GDAXI', 'UK100': '^FTSE', 'FRA40': '^FCHI',
            'AUS200': '^AXJO', 'JPN225': '^N225'
        };
        return map[symbol] || symbol;
    }

    getRange(limit, interval) {
        if (interval === '1m') return '1d';
        if (interval === '5m') return '5d';
        if (interval === '15m') return '1mo';
        if (interval === '30m') return '1mo';
        if (interval === '1h') return '1mo';
        return '1mo';
    }

    generateMockCandles(limit) {
        const candles = [];
        let price = 1.1000;
        const trend = Math.random() > 0.5 ? 0.0002 : -0.0002;
        for (let i = 0; i < limit; i++) {
            price += trend + (Math.random() - 0.5) * 0.002;
            candles.push({
                time: Date.now() - (limit - i) * 60000,
                open: price,
                high: price + 0.001,
                low: price - 0.001,
                close: price,
                volume: 100
            });
        }
        return candles;
    }
}
module.exports = new PriceFetcher();
