// ============================================
// PRICE FETCHER v11.0 – Multi‑Timeframe + Caching + VWAP support
// ============================================

const axios = require('axios');
const NodeCache = require('node-cache');
const cache = new NodeCache({ stdTTL: 300 });

const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || '';
const USE_REAL_API = !!(TWELVE_DATA_API_KEY && TWELVE_DATA_API_KEY !== 'your_api_key_here');

const intervalMap = {
    '1m': '1min',
    '5m': '5min',
    '15m': '15min',
    '30m': '30min',
    '1h': '1h',
    '4h': '4h',
    '1d': '1day'
};

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
    let trend = 0;
    let volatility = 0.001;

    for (let i = limit; i > 0; i--) {
        const timestamp = new Date(now.getTime() - i * intervalMinutes * 60 * 1000);
                const result = { values: formatted };
                cache.set(cacheKey, result);
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
