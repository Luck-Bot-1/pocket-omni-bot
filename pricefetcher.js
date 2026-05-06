// ============================================
// PRICEFETCHER v6.0 - REAL TWELVE DATA API
// Live market data | Professional rate limiting
// ============================================

const API_KEY = process.env.API_KEY;

if (!API_KEY) {
    console.error('❌ CRITICAL: TWELVE DATA API_KEY not set in Railway variables');
    console.error('➡️ Go to Railway → Variables → Add API_KEY = your_twelvedata_key');
    process.exit(1);
}

const TRADING_UNIVERSE = [
    { symbol: 'EUR/USD', enabled: true, minConfidence: 60 },
    { symbol: 'GBP/USD', enabled: true, minConfidence: 60 },
    { symbol: 'USD/JPY', enabled: true, minConfidence: 60 },
    { symbol: 'XAU/USD', enabled: true, minConfidence: 65 },
    { symbol: 'BTC/USD', enabled: true, minConfidence: 65 }
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
const cache = new Map();
const CACHE_TTL = 60000;

async function fetchPriceData(pair) {
    const cached = cache.get(pair);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.log(`📦 Cache hit for ${pair}`);
        return cached.data;
    }

    if (!rateLimiter.canRequest()) {
        console.log(`⏳ Rate limit for ${pair}, waiting...`);
        await new Promise(r => setTimeout(r, 8000));
    }

    try {
        const url = `https://api.twelvedata.com/time_series?symbol=${pair}&interval=15min&outputsize=60&apikey=${API_KEY}`;
        console.log(`📡 Fetching REAL live data for ${pair}...`);
        const response = await fetch(url);
        const data = await response.json();

        if (data.status === 'error') {
            console.error(`⚠️ API error for ${pair}:`, data.message);
            return null;
        }

        if (!data.values || data.values.length < 30) {
            console.warn(`⚠️ Insufficient data for ${pair}`);
            return null;
        }

        cache.set(pair, { data, timestamp: Date.now() });
        rateLimiter.record();
        console.log(`✅ Got REAL data for ${pair} (${data.values.length} candles)`);
        return data;
    } catch (err) {
        console.error(`❌ Network error for ${pair}:`, err.message);
        return null;
    }
}

async function fetchAllPairs() {
    const results = [];
    for (const pair of TRADING_UNIVERSE.filter(p => p.enabled)) {
        const data = await fetchPriceData(pair.symbol);
        if (data) results.push({ pair: pair.symbol, data });
        await new Promise(r => setTimeout(r, 9000));
    }
    return results;
}

function getEnabledPairs() {
    return TRADING_UNIVERSE.filter(p => p.enabled).map(p => p.symbol);
}

module.exports = { fetchPriceData, fetchAllPairs, getEnabledPairs, TRADING_UNIVERSE };
