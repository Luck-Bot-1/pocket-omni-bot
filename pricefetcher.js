const API_KEY = process.env.API_KEY;

if (!API_KEY) {
    console.error('❌ API_KEY not set');
    process.exit(1);
}

const TRADING_UNIVERSE = [
    { symbol: 'EUR/USD', enabled: true, minConfidence: 70 },
    { symbol: 'GBP/USD', enabled: true, minConfidence: 70 },
    { symbol: 'USD/JPY', enabled: true, minConfidence: 70 },
    { symbol: 'XAU/USD', enabled: true, minConfidence: 75 },
    { symbol: 'BTC/USD', enabled: true, minConfidence: 75 }
];

class RateLimiter {
    constructor() {
        this.requests = 0;
        this.lastReset = Date.now();
    }
    canRequest() {
        const now = Date.now();
        if (now - this.lastReset >= 60000) {
            this.requests = 0;
            this.lastReset = now;
        }
        return this.requests < 7;
    }
    record() { this.requests++; }
}

const rateLimiter = new RateLimiter();

async function fetchPriceData(pair) {
    if (!rateLimiter.canRequest()) {
        console.log(`⏳ Rate limit for ${pair}`);
        return null;
    }
    try {
        const url = `https://api.twelvedata.com/time_series?symbol=${pair}&interval=15min&outputsize=60&apikey=${API_KEY}`;
        console.log(`📡 Fetching ${pair}...`);
        const response = await fetch(url);
        const data = await response.json();
        if (data.status === 'error' || !data.values) {
            console.error(`⚠️ API error ${pair}:`, data.message);
            return null;
        }
        rateLimiter.record();
        console.log(`✅ Got ${pair} (${data.values.length} candles)`);
        return data;
    } catch (err) {
        console.error(`❌ Error ${pair}:`, err.message);
        return null;
    }
}

async function fetchAllPairs() {
    const results = [];
    for (const pair of TRADING_UNIVERSE.filter(p => p.enabled)) {
        const data = await fetchPriceData(pair.symbol);
        if (data) results.push({ pair: pair.symbol, data });
        await new Promise(r => setTimeout(r, 8000));
    }
    return results;
}

function getEnabledPairs() {
    return TRADING_UNIVERSE.filter(p => p.enabled).map(p => p.symbol);
}

module.exports = { fetchPriceData, fetchAllPairs, getEnabledPairs, TRADING_UNIVERSE };
