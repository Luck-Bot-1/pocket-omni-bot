const axios = require('axios');

const YAHOO_BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const simpleCache = {};

// ============================================
// INSTITUTIONAL CACHE MANAGEMENT
// ============================================
function getCacheTTL(timeframe) {
    const ttlMap = {
        '1m': 20, '5m': 60, '15m': 120, '30m': 300, '1h': 600, '4h': 1800, '1d': 3600
    };
    return ttlMap[timeframe] || 120;
}

function getYahooSymbol(pairName) {
    let symbol = pairName.replace(' OTC', '');
    symbol = symbol.replace('/', '');
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

// ============================================
// DATA VALIDATION (INSTITUTIONAL GRADE)
// ============================================
function validateCandle(candle, index) {
    const required = ['open', 'high', 'low', 'close', 'volume'];
    for (const field of required) {
        if (candle[field] === undefined || candle[field] === null || isNaN(candle[field])) {
            return false;
        }
    }
    if (candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0) return false;
    if (candle.high < candle.low) return false;
    if (candle.volume < 0) return false;
    return true;
}

function imputeMissingCandle(candle, prevCandle, nextCandle) {
    const imputed = { ...candle };
    if (candle.open === null || isNaN(candle.open)) {
        imputed.open = prevCandle ? prevCandle.close : (nextCandle ? nextCandle.close : candle.close);
    }
    if (candle.high === null || isNaN(candle.high)) {
        imputed.high = Math.max(imputed.open, imputed.close);
    }
    if (candle.low === null || isNaN(candle.low)) {
        imputed.low = Math.min(imputed.open, imputed.close);
    }
    if (candle.close === null || isNaN(candle.close)) {
        imputed.close = prevCandle ? prevCandle.close : (nextCandle ? nextCandle.close : imputed.open);
    }
    if (candle.volume === null || isNaN(candle.volume)) {
        imputed.volume = prevCandle ? prevCandle.volume : 1000;
    }
    return imputed;
}

function checkDataCompleteness(candles, requiredPercent = 95) {
    const total = candles.length;
    let validCount = 0;
    for (const candle of candles) {
        if (validateCandle(candle, 0)) validCount++;
    }
    const completeness = (validCount / total) * 100;
    return { isValid: completeness >= requiredPercent, completeness, validCount, totalCount: total };
}

function validateTimestampOrder(candles) {
    for (let i = 1; i < candles.length; i++) {
        const prevTime = new Date(candles[i-1].datetime).getTime();
        const currTime = new Date(candles[i].datetime).getTime();
        if (currTime <= prevTime) return false;
    }
    return true;
}

function removePriceOutliers(candles, threshold = 3) {
    const prices = candles.map(c => c.close);
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
    const stdDev = Math.sqrt(variance);
    return candles.filter(candle => Math.abs((candle.close - mean) / stdDev) <= threshold);
}

// ============================================
// REALISTIC MOCK DATA (FOR TESTING)
// ============================================
function generateRealisticMockData(pairName, timeframe, limit = 200) {
    if (!global._mockWarningShown) {
        console.warn(`⚠️ USING MOCK DATA for ${pairName}. Live data requires API key.`);
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
    let trend = 0, volatility = 0.001, momentum = 0;
    
    for (let i = limit; i > 0; i--) {
        const meanReversion = (1.1000 - basePrice) * 0.01;
        momentum = momentum * 0.9 + (Math.random() - 0.5) * volatility;
        volatility = volatility * 0.95 + Math.random() * 0.0001;
        const change = trend + meanReversion + momentum + (Math.random() - 0.5) * volatility;
        
        const timestamp = new Date(now.getTime() - i * intervalMinutes * 60 * 1000);
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
        if (Math.random() < 0.05) trend = (Math.random() - 0.5) * 0.001;
    }
    return { values };
}

// ============================================
// FETCH WITH EXPONENTIAL BACKOFF
// ============================================
async function fetchWithRetry(url, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await axios.get(url, { timeout: 10000 });
            if (response.data && response.data.chart && response.data.chart.result) {
                return response;
            }
            throw new Error('Invalid response');
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            const delay = Math.min(1000 * Math.pow(2, i) + Math.random() * 1000, 10000);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// ============================================
// MAIN FETCH FUNCTION (INSTITUTIONAL GRADE)
// ============================================
async function fetchRealData(pairName, timeframe, limit = 200) {
    const symbol = getYahooSymbol(pairName);
    const interval = getInterval(timeframe);
    const range = getRange(limit);
    const ttl = getCacheTTL(timeframe);
    
    const cacheKey = `${pairName}_${timeframe}_${limit}`;
    if (simpleCache[cacheKey] && (Date.now() - simpleCache[cacheKey].timestamp) < ttl * 1000) {
        return simpleCache[cacheKey].data;
    }
    
    const url = `${YAHOO_BASE_URL}${symbol}?interval=${interval}&range=${range}&includePrePost=false`;
    
    try {
        const response = await fetchWithRetry(url, 3);
        const result = response.data.chart.result[0];
        const timestamps = result.timestamp;
        const quote = result.indicators.quote[0];
        
        if (!timestamps || !quote || !quote.open) throw new Error('No data');
        
        let formatted = [];
        for (let idx = 0; idx < timestamps.length; idx++) {
            if (quote.open[idx] !== null && quote.close[idx] !== null) {
                let candle = {
                    datetime: new Date(timestamps[idx] * 1000).toISOString(),
                    open: parseFloat(quote.open[idx]),
                    high: parseFloat(quote.high[idx]),
                    low: parseFloat(quote.low[idx]),
                    close: parseFloat(quote.close[idx]),
                    volume: parseInt(quote.volume[idx]) || 0
                };
                
                // Impute missing values if needed
                if (!validateCandle(candle, idx)) {
                    const prevCandle = idx > 0 ? formatted[formatted.length - 1] : null;
                    candle = imputeMissingCandle(candle, prevCandle, null);
                }
                formatted.push(candle);
            }
        }
        
        if (formatted.length < 30) throw new Error('Insufficient data');
        
        // Validate timestamp order
        if (!validateTimestampOrder(formatted)) {
            formatted.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
        }
        
        // Remove outliers
        formatted = removePriceOutliers(formatted, 3);
        
        // Check data completeness
        const completeness = checkDataCompleteness(formatted, 90);
        if (!completeness.isValid) {
            console.warn(`Data completeness low: ${completeness.completeness.toFixed(1)}% for ${pairName}`);
        }
        
        const finalResult = { values: formatted };
        simpleCache[cacheKey] = { data: finalResult, timestamp: Date.now() };
        console.log(`✅ Yahoo Finance: ${pairName} (${timeframe}) – ${formatted.length} candles (${completeness.completeness.toFixed(0)}% complete)`);
        return finalResult;
        
    } catch (error) {
        console.error(`Yahoo Finance error for ${pairName}:`, error.message);
        return null;
    }
}

async function fetchPriceData(pairName, timeframe = '15m', options = {}) {
    const limit = options.limit || 200;
    const data = await fetchRealData(pairName, timeframe, limit);
    if (data && data.values && data.values.length >= 30) return data;
    console.warn(`⚠️ Using mock data for ${pairName} (${timeframe})`);
    return generateRealisticMockData(pairName, timeframe, limit);
}

module.exports = { fetchPriceData };
