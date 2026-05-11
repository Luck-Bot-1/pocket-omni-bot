const axios = require('axios');
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || '';
const USE_REAL_API = !!(TWELVE_DATA_API_KEY && TWELVE_DATA_API_KEY !== 'your_api_key_here');
const intervalMap = { '1m':'1min','5m':'5min','15m':'15min','30m':'30min','1h':'1h','4h':'4h','1d':'1day' };
const simpleCache = {};

function getSymbol(pairName) {
    let symbol = pairName.replace(' OTC', '');
    if (symbol.includes('/')) symbol = symbol.replace('/', '');
    return symbol;
}

function generateMockData(pairName, timeframe, limit = 200) {
    if (!global._mockWarningShown) {
        console.warn(`⚠️ USING MOCK DATA for ${pairName}. Set TWELVE_DATA_API_KEY for live prices.`);
        global._mockWarningShown = true;
    }
    const values = [];
    const now = new Date();
    let basePrice = 1.1000;
    if (pairName.includes('JPY')) basePrice = 150.00;
    if (pairName.includes('GBP')) basePrice = 1.3000;
    if (pairName.includes('AUD')) basePrice = 0.6700;
    if (pairName.includes('CAD')) basePrice = 1.3500;
    if (pairName.includes('CHF')) basePrice = 0.8900;
    if (pairName.includes('BTC')) basePrice = 60000;
    if (pairName.includes('ETH')) basePrice = 3000;
    if (pairName.includes('Gold')) basePrice = 2300;
    const intervalMinutes = parseInt(timeframe) || 15;
    let trend = 0, volatility = 0.001;
    for (let i = limit; i > 0; i--) {
        const timestamp = new Date(now.getTime() - i * intervalMinutes * 60 * 1000);
        if (Math.random() < 0.1) trend = (Math.random() - 0.5) * 0.0005;
        const change = trend + (Math.random() - 0.5) * volatility;
        const open = basePrice;
        const close = open + change;
        const high = Math.max(open, close) + Math.random() * volatility * 2;
        const low = Math.min(open, close) - Math.random() * volatility * 2;
        values.push({
            datetime: timestamp.toISOString(),
            open: parseFloat(open.toFixed(5)),
            high: parseFloat(high.toFixed(5)),
            low: parseFloat(low.toFixed(5)),
            close: parseFloat(close.toFixed(5)),
            volume: Math.floor(Math.random() * 1000) + 100
        });
        basePrice = close;
    }
    return { values };
}

async function fetchRealData(pairName, timeframe, limit = 200) {
    const symbol = getSymbol(pairName);
    const interval = intervalMap[timeframe];
    if (!interval) throw new Error(`Unsupported timeframe: ${timeframe}`);
    const cacheKey = `${pairName}_${timeframe}_${limit}`;
    if (simpleCache[cacheKey] && (Date.now() - simpleCache[cacheKey].timestamp) < 300000) {
        return simpleCache[cacheKey].data;
    }
    const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval}&outputsize=${limit}&apikey=${TWELVE_DATA_API_KEY}`;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await axios.get(url, { timeout: 10000 });
            if (response.data && response.data.values) {
                const formatted = response.data.values.map(candle => ({
                    datetime: candle.datetime,
                    open: parseFloat(candle.open),
                    high: parseFloat(candle.high),
                    low: parseFloat(candle.low),
                    close: parseFloat(candle.close),
                    volume: parseInt(candle.volume) || 0
                }));
                formatted.reverse();
                const result = { values: formatted };
                simpleCache[cacheKey] = { data: result, timestamp: Date.now() };
                return result;
            }
            throw new Error('Invalid API response');
        } catch (error) {
            console.error(`Twelve Data error (attempt ${attempt}) for ${pairName}:`, error.message);
            if (attempt === 3) return null;
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
    }
    return null;
}

async function fetchPriceData(pairName, timeframe = '15m', options = {}) {
    const limit = options.limit || 200;
    if (USE_REAL_API) {
        const data = await fetchRealData(pairName, timeframe, limit);
        if (data && data.values && data.values.length >= 30) return data;
        console.warn(`Falling back to mock data for ${pairName} (${timeframe})`);
    }
    return generateMockData(pairName, timeframe, limit);
}

module.exports = { fetchPriceData };
