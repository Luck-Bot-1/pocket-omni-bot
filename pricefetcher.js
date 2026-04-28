// ═══════════════════════════════════════════════════════════════
// OMNI PRICE FETCHER v2.0 — Twelve Data API
// ═══════════════════════════════════════════════════════════════
const fetch = require('node-fetch');
const API_KEY = process.env.API_KEY;
const BASE_URL = 'https://api.twelvedata.com';

// Twelve Data symbol map (their format differs from display names)
const SYMBOL_MAP = {
  'EUR/USD': 'EUR/USD', 'GBP/USD': 'GBP/USD', 'USD/JPY': 'USD/JPY',
  'USD/CHF': 'USD/CHF', 'USD/CAD': 'USD/CAD', 'EUR/GBP': 'EUR/GBP',
  'AUD/CAD': 'AUD/CAD', 'AUD/CHF': 'AUD/CHF', 'CHF/JPY': 'CHF/JPY',
  'EUR/JPY': 'EUR/JPY', 'GBP/JPY': 'GBP/JPY', 'GBP/CAD': 'GBP/CAD',
  // OTC — mapped to their real market equivalent
  'EUR/USD OTC': 'EUR/USD', 'GBP/USD OTC': 'GBP/USD',
  'AUD/USD OTC': 'AUD/USD', 'AUD/CHF OTC': 'AUD/CHF',
  'EUR/GBP OTC': 'EUR/GBP', 'EUR/JPY OTC': 'EUR/JPY',
  'GBP/JPY OTC': 'GBP/JPY', 'GBP/AUD OTC': 'GBP/AUD',
  'NZD/USD OTC': 'NZD/USD', 'USD/JPY OTC': 'USD/JPY',
  'AUD/JPY OTC': 'AUD/JPY', 'AUD/NZD OTC': 'AUD/NZD',
  'NZD/JPY OTC': 'NZD/JPY', 'USD/CAD OTC': 'USD/CAD',
  'USD/CHF OTC': 'USD/CHF', 'USD/SGD OTC': 'USD/SGD',
  'USD/MYR OTC': 'USD/MYR', 'USD/INR OTC': 'USD/INR',
  'USD/RUB OTC': 'USD/RUB', 'USD/COP OTC': 'USD/COP',
  'USD/IDR OTC': 'USD/IDR', 'ZAR/USD OTC': 'USD/ZAR',
  'USD/ARS OTC': 'USD/ARS', 'NGN/USD OTC': 'USD/NGN',
  'QAR/CNY OTC': 'USD/CNY', 'SAR/CNY OTC': 'USD/CNY',
  'AED/CNY OTC': 'USD/CNY', 'TND/USD OTC': 'USD/TND',
  'BHD/CNY OTC': 'USD/BHD', 'KES/USD OTC': 'USD/KES',
  // Crypto
  'BTC/USD OTC': 'BTC/USD', 'ETH/USD OTC': 'ETH/USD',
  'LTC/USD OTC': 'LTC/USD', 'XRP/USD OTC': 'XRP/USD',
  'BNB/USD OTC': 'BNB/USD', 'SOL/USD OTC': 'SOL/USD',
  // Commodity
  'XAU/USD OTC': 'XAU/USD', 'XAG/USD OTC': 'XAG/USD',
  'WTI/USD OTC': 'WTI/USD',
};

// Interval map
const INTERVAL_MAP = {
  '1min': '1min', '5min': '5min', '15min': '15min', '30min': '30min',
};

// Rate limiter — free plan = 8 calls/min
const queue = [];
let processing = false;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function rateLimitedFetch(url) {
  return new Promise((resolve, reject) => {
    queue.push({ url, resolve, reject });
    if (!processing) processQueue();
  });
}

async function processQueue() {
  processing = true;
  while (queue.length > 0) {
    const { url, resolve, reject } = queue.shift();
    try {
      const res = await fetch(url);
      const data = await res.json();
      resolve(data);
    } catch (e) {
      reject(e);
    }
    if (queue.length > 0) await sleep(8000); // 8s gap = safe under 8/min
  }
  processing = false;
}

// ── Fetch candle data ──────────────────────────────────────────
async function fetchPriceData(displaySymbol, interval = '15min') {
  try {
    const symbol = SYMBOL_MAP[displaySymbol];
    if (!symbol) return null;

    const tf = INTERVAL_MAP[interval] || '15min';
    const url = `${BASE_URL}/time_series?symbol=${symbol}&interval=${tf}&outputsize=60&apikey=${API_KEY}`;

    const data = await rateLimitedFetch(url);

    if (!data || data.status === 'error' || !data.values || data.values.length < 30) {
      console.log(`No data for ${symbol}:`, data?.message || 'empty');
      return null;
    }

    // Twelve Data returns newest first — reverse to oldest first
    const candles = data.values.reverse();

    const opens   = candles.map(c => parseFloat(c.open));
    const highs   = candles.map(c => parseFloat(c.high));
    const lows    = candles.map(c => parseFloat(c.low));
    const closes  = candles.map(c => parseFloat(c.close));
    const volumes = candles.map(c => parseFloat(c.volume || 0));

    const ltf = { opens, highs, lows, closes, volumes, isSynthetic: displaySymbol.includes('OTC') };

    // HTF: fetch 1H data for bias
    let htf = null;
    try {
      const htfUrl = `${BASE_URL}/time_series?symbol=${symbol}&interval=1h&outputsize=30&apikey=${API_KEY}`;
      const htfData = await rateLimitedFetch(htfUrl);
      if (htfData && htfData.values && htfData.values.length >= 26) {
        const hc = htfData.values.reverse();
        htf = { closes: hc.map(c => parseFloat(c.close)) };
      }
    } catch (e) {
      // HTF optional — continue without it
    }

    return { ltf, htf };

  } catch (e) {
    console.error(`fetchPriceData error ${displaySymbol}:`, e.message);
    return null;
  }
}

// ── Fetch historical data for backtest ────────────────────────
async function fetchHistoricalData(displaySymbol, interval = '15min', outputsize = 200) {
  try {
    const symbol = SYMBOL_MAP[displaySymbol];
    if (!symbol) return null;

    const tf = INTERVAL_MAP[interval] || '15min';
    const url = `${BASE_URL}/time_series?symbol=${symbol}&interval=${tf}&outputsize=${outputsize}&apikey=${API_KEY}`;

    const data = await rateLimitedFetch(url);
    if (!data || data.status === 'error' || !data.values) return null;

    const candles = data.values.reverse();
    return {
      opens:   candles.map(c => parseFloat(c.open)),
      highs:   candles.map(c => parseFloat(c.high)),
      lows:    candles.map(c => parseFloat(c.low)),
      closes:  candles.map(c => parseFloat(c.close)),
      volumes: candles.map(c => parseFloat(c.volume || 0)),
    };
  } catch (e) {
    console.error(`fetchHistoricalData error:`, e.message);
    return null;
  }
}

// ── News blackout (kept for compatibility) ────────────────────
function isNewsBlackout() {
  const now = new Date();
  const h = now.getUTCHours(), m = now.getUTCMinutes(), d = now.getUTCDay();
  const min = h * 60 + m;
  const windows = [
    { s: 8*60+15,  e: 9*60+15  },
    { s: 13*60+15, e: 14*60+15 },
    { s: 15*60+45, e: 16*60+30 },
    { s: 18*60+45, e: 19*60+30 },
    ...(d===5 ? [{ s: 13*60+15, e: 14*60+30 }] : []),
    ...(d===3 ? [{ s: 18*60+45, e: 20*60    }] : []),
  ];
  return windows.some(w => min >= w.s - 15 && min <= w.e);
}

module.exports = { fetchPriceData, fetchHistoricalData, isNewsBlackout };
