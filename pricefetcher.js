const axios = require('axios');

const YAHOO_BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const simpleCache = {};

function getYahooSymbol(pairName) {
    let symbol = pairName.replace(' OTC', '');
    symbol = symbol.replace('/', '');
    // Add =X suffix for forex pairs (Yahoo Finance requirement)
    if (!symbol.includes('BTC') && !symbol.includes('ETH') && !symbol.includes('Gold') && !symbol.includes('XAU')) {
        symbol = symbol + '=X';
    }
    return symbol;
}

function getInterval(timeframe) {
    const map = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '60m', '4h': '60m', '1d': '1d' };
    return map[timeframe] || '15m';
}

function getRange(limit) {
    if (limit <= 60) return '1d';
    if (limit <= 200) return '5d';
    return '1mo';
}

function generateMockData(pairName, timeframe, limit = 200) {
    if (!global._mockWarningShown) {
        console.warn(`⚠️ USING MOCK DATA for ${pairName}. Yahoo Finance may be rate limited.`);
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
    const symbol = getYahooSymbol(pairName);
    const interval = getInterval(timeframe);
    const range = getRange(limit);
    
    const cacheKey = `${pairName}_${timeframe}_${limit}`;
    if (simpleCache[cacheKey] && (Date.now() - simpleCache[cacheKey].timestamp) < 60000) {
        return simpleCache[cacheKey].data;
    }
    
    const url = `${YAHOO_BASE_URL}${symbol}?interval=${interval}&range=${range}&includePrePost=false`;
    
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await axios.get(url, { timeout: 10000 });
            if (response.data && response.data.chart && response.data.chart.result && response.data.chart.result[0]) {
                const result = response.data.chart.result[0];
                const timestamps = result.timestamp;
                const quote = result.indicators.quote[0];
                if (!timestamps || !quote || !quote.open) throw new Error('No data');
                const formatted = [];
                for (let idx = 0; idx < timestamps.length; idx++) {
                    if (quote.open[idx] !== null && quote.close[idx] !== null) {
                        formatted.push({
                            datetime: new Date(timestamps[idx] * 1000).toISOString(),
                            open: parseFloat(quote.open[idx]),
                            high: parseFloat(quote.high[idx]),
                            low: parseFloat(quote.low[idx]),
                            close: parseFloat(quote.close[idx]),
                            volume: parseInt(quote.volume[idx]) || 0
                        });
                    }
                }
                if (formatted.length < 30) throw new Error('Insufficient data');
                const finalResult = { values: formatted };
                simpleCache[cacheKey] = { data: finalResult, timestamp: Date.now() };
                console.log(`✅ Yahoo Finance LIVE: ${pairName} (${timeframe}) – ${formatted.length} candles`);
                return finalResult;
            }
            throw new Error('Invalid Yahoo Finance response');
        } catch (error) {
            console.error(`Yahoo Finance error (attempt ${attempt}) for ${pairName}:`, error.message);
            if (attempt === 3) return null;
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
    }
    return null;
}

async function fetchPriceData(pairName, timeframe = '15m', options = {}) {
    const limit = options.limit || 200;
    const data = await fetchRealData(pairName, timeframe, limit);
    if (data && data.values && data.values.length >= 30) return data;
    console.warn(`⚠️ Using mock data for ${pairName} (${timeframe})`);
    return generateMockData(pairName, timeframe, limit);
}

module.exports = { fetchPriceData };
