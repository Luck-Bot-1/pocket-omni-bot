// ============================================
// PRICEFETCHER v7.3 – FINAL AUDITED VERSION
// Supports: Real API (Twelve Data) + Mock fallback
// Format: { values: [{ datetime, open, high, low, close, volume }] }
// ============================================

const axios = require('axios');

// --- CONFIGURATION ---
// Get a free API key from twelvedata.com (or use mock mode)
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || '';
const USE_REAL_API = !!TWELVE_DATA_API_KEY && TWELVE_DATA_API_KEY !== 'your_api_key_here';

// Mapping from pair names (e.g., "EUR/USD") to Twelve Data symbols
function getSymbol(pairName) {
    // Remove " OTC" suffix if present
    let symbol = pairName.replace(' OTC', '').replace('/', '');
    // Crypto: BTC/USD -> BTC/USD (Twelve Data uses same)
    if (pairName.includes('BTC') || pairName.includes('ETH')) return pairName.replace(' ', '');
    return symbol;
}

// --- MOCK DATA GENERATOR (for testing / fallback) ---
function generateMockData(pairName, limit = 200) {
    const values = [];
    const now = new Date();
    let basePrice = 1.1000;
    if (pairName.includes('JPY')) basePrice = 150.00;
    if (pairName.includes('GBP')) basePrice = 1.3000;
    if (pairName.includes('AUD')) basePrice = 0.6700;
    if (pairName.includes('CAD')) basePrice = 1.3500;
    if (pairName.includes('BTC')) basePrice = 60000;
    if (pairName.includes('ETH')) basePrice = 3000;
    if (pairName.includes('Gold')) basePrice = 2300;

    for (let i = limit; i > 0; i--) {
        const timestamp = new Date(now.getTime() - i * 15 * 60 * 1000); // 15m candles
        const change = (Math.random() - 0.5) * 0.002;
        const open = basePrice + (Math.random() - 0.5) * 0.001;
        const close = open + change;
        const high = Math.max(open, close) + Math.random() * 0.001;
        const low = Math.min(open, close) - Math.random() * 0.001;
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

// --- REAL API FETCHER (Twelve Data) ---
async function fetchRealData(pairName, limit = 200) {
    const symbol = getSymbol(pairName);
    const interval = '15min'; // matches your 15m timeframe for signal analysis
    const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval}&outputsize=${limit}&apikey=${TWELVE_DATA_API_KEY}`;
    
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
            // Ensure chronological order (oldest first)
            formatted.reverse();
            return { values: formatted };
        } else {
            throw new Error('Invalid API response');
        }
    } catch (error) {
        console.error(`Twelve Data error for ${pairName}:`, error.message);
        return null;
    }
}

// --- MAIN EXPORT FUNCTION ---
// Options: { limit } – number of candles (default 200)
async function fetchPriceData(pairName, options = {}) {
    const limit = options.limit || 200;
    if (USE_REAL_API) {
        const data = await fetchRealData(pairName, limit);
        if (data && data.values && data.values.length >= 60) {
            return data;
        }
        console.warn(`Falling back to mock data for ${pairName}`);
    }
    // Fallback or mock mode
    return generateMockData(pairName, limit);
}

module.exports = { fetchPriceData };
