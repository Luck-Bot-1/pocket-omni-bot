// ═══════════════════════════════════════════════════════════════
// PRICE FETCHER v3.0 — Production Grade
// Multi-source, multi-timeframe, news blackout filter
// ═══════════════════════════════════════════════════════════════

const https = require('https');
const KEY = process.env.TWELVE_DATA_KEY || 'demo';

const SYMBOL_MAP = {
  // OTC → Real
  'EUR/USD OTC':'EUR/USD','GBP/USD OTC':'GBP/USD','USD/JPY OTC':'USD/JPY',
  'AUD/USD OTC':'AUD/USD','USD/CAD OTC':'USD/CAD','USD/CHF OTC':'USD/CHF',
  'NZD/USD OTC':'NZD/USD','EUR/GBP OTC':'EUR/GBP','EUR/JPY OTC':'EUR/JPY',
  'GBP/JPY OTC':'GBP/JPY','AUD/JPY OTC':'AUD/JPY','AUD/NZD OTC':'AUD/NZD',
  'AUD/CHF OTC':'AUD/CHF','AUD/CAD OTC':'AUD/CAD','NZD/JPY OTC':'NZD/JPY',
  'CHF/JPY OTC':'CHF/JPY','CAD/JPY OTC':'CAD/JPY','USD/MYR OTC':'USD/MYR',
  'USD/INR OTC':'USD/INR','USD/SGD OTC':'USD/SGD','USD/RUB OTC':'USD/RUB',
  'USD/IDR OTC':'USD/IDR','USD/PKR OTC':'USD/PKR','ZAR/USD OTC':'USD/ZAR',
  'AED/CNY OTC':'USD/CNH','SAR/CNY OTC':'USD/CNH','QAR/CNY OTC':'USD/CNH',
  'JOD/CNY OTC':'USD/CNH','BHD/CNY OTC':'USD/CNH','NGN/USD OTC':'USD/NGN',
  'USD/ARS OTC':'USD/ARS','USD/COP OTC':'USD/COP','EUR/HUF OTC':'EUR/HUF',
  'EUR/RUB OTC':'EUR/USD','GBP/AUD OTC':'GBP/AUD','TND/USD OTC':'USD/TND',
  'KES/USD OTC':'USD/KES',
  // Live
  'EUR/USD':'EUR/USD','GBP/USD':'GBP/USD','USD/JPY':'USD/JPY',
  'USD/CHF':'USD/CHF','USD/CAD':'USD/CAD','AUD/CAD':'AUD/CAD',
  'AUD/CHF':'AUD/CHF','CHF/JPY':'CHF/JPY','EUR/GBP':'EUR/GBP',
  'EUR/JPY':'EUR/JPY','GBP/JPY':'GBP/JPY','GBP/CAD':'GBP/CAD',
  // Crypto
  'BTC/USD OTC':'BTC/USD','ETH/USD OTC':'ETH/USD','LTC/USD OTC':'LTC/USD',
  'XRP/USD OTC':'XRP/USD','BNB/USD OTC':'BNB/USD','SOL/USD OTC':'SOL/USD',
  // Commodities
  'XAU/USD OTC':'XAU/USD','XAG/USD OTC':'XAG/USD','WTI/USD OTC':'WTI/USD',
};

const TF_MAP = {
  '1min': { ltf:'1min', htf:'5min'  },
  '5min': { ltf:'5min', htf:'15min' },
  '15min':{ ltf:'15min',htf:'1h'   },
  '30min':{ ltf:'30min',htf:'4h'   },
};

// ── HTTP helper ────────────────────────────────────────────────
function fetchJSON(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); }});
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Twelve Data OHLCV ──────────────────────────────────────────
async function fetchTD(symbol, interval, size = 80) {
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval}&outputsize=${size}&apikey=${KEY}`;
    const d = await fetchJSON(url);
    if (d.status === 'error' || !d.values || d.values.length < 20) return null;
    const v = [...d.values].reverse();
    return {
      opens:   v.map(x => parseFloat(x.open)),
      highs:   v.map(x => parseFloat(x.high)),
      lows:    v.map(x => parseFloat(x.low)),
      closes:  v.map(x => parseFloat(x.close)),
      volumes: v.map(x => parseFloat(x.volume || 0)),
      times:   v.map(x => x.datetime),
      isSynthetic: false, source: 'TwelveData'
    };
  } catch { return null; }
}

// ── Fallback: exchangerate.host ────────────────────────────────
async function fetchFallback(realSym) {
  try {
    const [base, quote] = realSym.split('/');
    const d = await fetchJSON(`https://api.exchangerate.host/latest?base=${base}&symbols=${quote}`);
    if (d.rates?.[quote]) return buildSynthetic(d.rates[quote], realSym);
  } catch {}
  try {
    const [base, quote] = realSym.split('/');
    const d = await fetchJSON(`https://open.er-api.com/v6/latest/${base}`);
    if (d.rates?.[quote]) return buildSynthetic(d.rates[quote], realSym);
  } catch {}
  return null;
}

function buildSynthetic(price, sym) {
  const volMap = { 'XAU':0.8,'XAG':0.015,'WTI':0.3,'BTC':80,'ETH':8,'LTC':1.5,
                   'XRP':0.002,'BNB':2,'SOL':0.5,'JPY':0.04,'GBP':0.0005,
                   'EUR':0.0004,'AUD':0.0004,'NZD':0.0004,'CAD':0.0004,'CHF':0.0004 };
  const vol = volMap[sym.slice(0,3)] || 0.0004;
  const N = 80;
  const opens=[],highs=[],lows=[],closes=[],volumes=[];
  let p = price * (1 - (Math.random()-0.5) * vol * 5);
  let trend = (Math.random()-0.5) * vol * 0.3;
  for (let i=0;i<N;i++) {
    if (Math.random() < 0.06) trend = -trend * (0.5 + Math.random());
    const chg = trend + (Math.random()-0.5)*vol;
    const o=p, c=p+chg;
    const wick = vol*(0.2+Math.random()*0.8);
    opens.push(o); closes.push(c);
    highs.push(Math.max(o,c)+Math.random()*wick);
    lows.push(Math.min(o,c)-Math.random()*wick);
    volumes.push(Math.random()*1000000);
    p = c;
  }
  closes[N-1] = price;
  return { opens,highs,lows,closes,volumes,times:[], isSynthetic:true, source:'Synthetic' };
}

// ── News Blackout Filter ───────────────────────────────────────
// High-impact news times (approximate recurring patterns GMT)
// These are typical recurring high-impact windows
const NEWS_BLACKOUT_WINDOWS_GMT = [
  { day:'*', hour:8,  minute:30, duration:45, desc:'European Open News' },
  { day:'*', hour:13, minute:30, duration:45, desc:'US News (NFP/CPI/etc)' },
  { day:'*', hour:15, minute:0,  duration:30, desc:'US Secondary Data' },
  { day:'*', hour:18, minute:0,  duration:30, desc:'US Close Data' },
  { day:5,   hour:13, minute:30, duration:60, desc:'NFP Friday' }, // Friday
  { day:3,   hour:18, minute:0,  duration:60, desc:'FOMC Wednesday' },  // Wednesday
];

function isNewsBlackout() {
  const now = new Date();
  const gmtH = now.getUTCHours();
  const gmtM = now.getUTCMinutes();
  const day   = now.getUTCDay();
  const gmtTotal = gmtH * 60 + gmtM;

  for (const w of NEWS_BLACKOUT_WINDOWS_GMT) {
    if (w.day !== '*' && w.day !== day) continue;
    const wStart = w.hour * 60 + w.minute;
    const wEnd   = wStart + w.duration;
    if (gmtTotal >= wStart - 15 && gmtTotal <= wEnd) { // 15-min pre-buffer
      return { blackout: true, reason: w.desc };
    }
  }
  return { blackout: false };
}

// ── Main export ────────────────────────────────────────────────
async function fetchPriceData(pocketSym, interval = '15min') {
  const real = SYMBOL_MAP[pocketSym];
  if (!real) return null;
  const tfs  = TF_MAP[interval] || TF_MAP['15min'];

  let ltf = await fetchTD(real, tfs.ltf, 80);
  if (!ltf) ltf = await fetchFallback(real);
  if (!ltf) return null;

  // HTF
  let htf = await fetchTD(real, tfs.htf, 50);
  if (!htf && ltf.closes.length >= 40) {
    htf = {
      closes:  ltf.closes.filter((_,i)=>i%4===0),
      opens:   ltf.opens.filter((_,i)=>i%4===0),
      highs:   ltf.highs.filter((_,i)=>i%4===0),
      lows:    ltf.lows.filter((_,i)=>i%4===0),
      volumes: ltf.volumes.filter((_,i)=>i%4===0),
    };
  }

  return { ltf, htf, realSymbol: real };
}

async function fetchHistoricalData(pocketSym, interval = '15min', size = 200) {
  const real = SYMBOL_MAP[pocketSym];
  if (!real) return null;
  const tfs  = TF_MAP[interval] || TF_MAP['15min'];
  return await fetchTD(real, tfs.ltf, size);
}

module.exports = { fetchPriceData, fetchHistoricalData, isNewsBlackout, SYMBOL_MAP };

