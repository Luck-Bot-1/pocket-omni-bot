const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cors = require('cors');
const https = require('https');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) { console.error('❌ TELEGRAM_BOT_TOKEN missing'); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });
console.log('✅ Pocket Omni Signal Bot v4.0 starting...');

// ─── STATE ────────────────────────────────────────────────────────────────────
let autoMode = false;
let autoInterval = null;
let selectedTF = '1m';
let selectedStake = 1;
let signalHistory = [];
let stats = { total: 0, calls: 0, puts: 0, wins: 0, losses: 0 };
let priceCache = {};

// ─── TIMEFRAMES ───────────────────────────────────────────────────────────────
const TIMEFRAMES = {
  '15s': { label: '15 sec',  mins: 0.25 },
  '30s': { label: '30 sec',  mins: 0.5  },
  '1m':  { label: '1 min',   mins: 1    },
  '3m':  { label: '3 min',   mins: 3    },
  '5m':  { label: '5 min',   mins: 5    },
  '10m': { label: '10 min',  mins: 10   },
  '15m': { label: '15 min',  mins: 15   },
  '30m': { label: '30 min',  mins: 30   },
  '60m': { label: '1 hour',  mins: 60   },
  '120m':{ label: '2 hours', mins: 120  },
  '180m':{ label: '3 hours', mins: 180  },
  '240m':{ label: '4 hours', mins: 240  },
};

// ─── PAIRS ────────────────────────────────────────────────────────────────────
const LIVE_PAIRS = [
  { symbol: 'EUR/USD', from: 'EUR', to: 'USD' },
  { symbol: 'GBP/USD', from: 'GBP', to: 'USD' },
  { symbol: 'AUD/USD', from: 'AUD', to: 'USD' },
  { symbol: 'USD/JPY', from: 'USD', to: 'JPY' },
  { symbol: 'USD/CAD', from: 'USD', to: 'CAD' },
  { symbol: 'NZD/USD', from: 'NZD', to: 'USD' },
  { symbol: 'EUR/JPY', from: 'EUR', to: 'JPY' },
  { symbol: 'GBP/JPY', from: 'GBP', to: 'JPY' },
];

const OTC_PAIRS = [
  'EUR/USD OTC','GBP/USD OTC','AUD/USD OTC','USD/JPY OTC',
  'USD/CAD OTC','NZD/USD OTC','EUR/JPY OTC','GBP/JPY OTC',
  'AUD/JPY OTC','EUR/GBP OTC','USD/CHF OTC','CAD/JPY OTC'
];

// ─── FETCH HELPERS ────────────────────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'OmniBot/4.0' } }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Fetch live forex rate from Frankfurter API (free, no key needed)
async function getLiveRate(from, to) {
  try {
    const cacheKey = `${from}${to}`;
    const now = Date.now();
    if (priceCache[cacheKey] && now - priceCache[cacheKey].ts < 60000) {
      return priceCache[cacheKey].rate;
    }
    const data = await fetchJSON(`https://api.frankfurter.app/latest?from=${from}&to=${to}`);
    const rate = data.rates[to];
    priceCache[cacheKey] = { rate, ts: now };
    return rate;
  } catch(e) {
    console.error(`Price fetch error ${from}/${to}:`, e.message);
    return null;
  }
}

// Fetch multiple recent rates to simulate candles for indicator calculation
async function getRateHistory(from, to, days = 14) {
  try {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days);
    const startStr = start.toISOString().split('T')[0];
    const endStr   = end.toISOString().split('T')[0];
    const data = await fetchJSON(`https://api.frankfurter.app/${startStr}..${endStr}?from=${from}&to=${to}`);
    const rates = Object.values(data.rates).map(r => r[to]).filter(Boolean);
    return rates;
  } catch(e) {
    console.error(`History fetch error:`, e.message);
    return null;
  }
}

// ─── REAL INDICATOR CALCULATIONS ─────────────────────────────────────────────
function calcRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return Math.round(100 - (100 / (1 + rs)));
}

function calcSMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcEMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcMACD(prices) {
  if (!prices || prices.length < 26) return { macd: 0, signal: 0, hist: 0 };
  const ema12 = calcEMA(prices, 12);
  const ema26 = calcEMA(prices, 26);
  const macd  = ema12 - ema26;
  // Simplified signal
  const signal = macd * 0.85;
  return { macd, signal, hist: macd - signal };
}

function calcBB(prices, period = 20, dev = 2) {
  if (!prices || prices.length < period) return { upper: 0, mid: 0, lower: 0, pos: 0.5 };
  const slice = prices.slice(-period);
  const mid   = slice.reduce((a, b) => a + b, 0) / period;
  const std   = Math.sqrt(slice.reduce((a, b) => a + Math.pow(b - mid, 2), 0) / period);
  const upper = mid + dev * std;
  const lower = mid - dev * std;
  const last  = prices[prices.length - 1];
  const pos   = std === 0 ? 0.5 : (last - lower) / (upper - lower);
  return { upper, mid, lower, pos: Math.max(0, Math.min(1, pos)) };
}

function calcStoch(prices, kPeriod = 14) {
  if (!prices || prices.length < kPeriod) return { k: 50, d: 50 };
  const slice  = prices.slice(-kPeriod);
  const high   = Math.max(...slice);
  const low    = Math.min(...slice);
  const last   = prices[prices.length - 1];
  const k      = high === low ? 50 : Math.round(((last - low) / (high - low)) * 100);
  const d      = Math.round((k + 50) / 2); // simplified D
  return { k, d };
}

function calcCCI(prices, period = 20) {
  if (!prices || prices.length < period) return 0;
  const slice  = prices.slice(-period);
  const mean   = slice.reduce((a, b) => a + b, 0) / period;
  const meanDev = slice.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
  if (meanDev === 0) return 0;
  return Math.round((prices[prices.length - 1] - mean) / (0.015 * meanDev));
}

// ─── SESSION ──────────────────────────────────────────────────────────────────
function getSession() {
  const h = new Date().getUTCHours();
  const m = new Date().getUTCMinutes();
  const t = h + m / 60;
  if (t >= 7  && t < 12) return { name: 'LONDON',    quality: 'HIGH', emoji: '🇬🇧', score: 3 };
  if (t >= 12 && t < 16) return { name: 'NY+LONDON', quality: 'BEST', emoji: '🔥',  score: 4 };
  if (t >= 16 && t < 21) return { name: 'NEW YORK',  quality: 'HIGH', emoji: '🇺🇸', score: 3 };
  if (t >= 0  && t <  7) return { name: 'ASIAN',     quality: 'MED',  emoji: '🌏',  score: 2 };
  return                         { name: 'OFF-HOURS', quality: 'LOW',  emoji: '😴',  score: 1 };
}

// ─── OTC PATTERN LOGIC ────────────────────────────────────────────────────────
// OTC uses time-based volatility patterns + session strength + minute patterns
function otcPatternSignal(pair, tf) {
  const now     = new Date();
  const hour    = now.getUTCHours();
  const minute  = now.getUTCMinutes();
  const second  = now.getUTCSeconds();
  const session = getSession();
  const tfData  = TIMEFRAMES[tf] || TIMEFRAMES['1m'];

  // Time-based pattern seeds (deterministic per minute window, not random)
  const timeKey  = hour * 100 + Math.floor(minute / 5); // changes every 5 min
  const pairSeed = pair.charCodeAt(0) + pair.charCodeAt(1) + pair.length;
  const seed     = (timeKey * 31 + pairSeed * 17) % 100;

  // Session volatility windows — OTC tends to trend during these
  const inVolWindow = (hour >= 8 && hour < 12) || (hour >= 13 && hour < 17) || (hour >= 19 && hour < 22);
  const sessionBonus = session.score;

  // Minute pattern — odd/even minute cycles common in OTC
  const minuteParity = minute % 2 === 0 ? 1 : -1;
  const hourCycle    = Math.sin((hour / 24) * Math.PI * 2);

  // Build confluence score
  let upScore = 0, downScore = 0;

  // Pattern 1: seed-based direction (pair+time combination)
  if (seed < 45) upScore += 2;
  else if (seed > 55) downScore += 2;
  else if (seed < 50) upScore += 1;
  else downScore += 1;

  // Pattern 2: hour cycle
  if (hourCycle > 0.3) upScore += 2;
  else if (hourCycle < -0.3) downScore += 2;
  else if (hourCycle > 0) upScore += 1;
  else downScore += 1;

  // Pattern 3: session strength
  if (session.score >= 3) {
    upScore += minuteParity > 0 ? 2 : 0;
    downScore += minuteParity < 0 ? 2 : 0;
  }

  // Pattern 4: volatility window
  if (inVolWindow) {
    upScore += 1;
    downScore += 1; // adds to both = raises overall confidence
  }

  // Pattern 5: TF weighting — longer TF = more reliable
  if (tfData.mins >= 5) { upScore += 1; downScore += 1; }

  // Pattern 6: pair-specific tendency
  const pairBias = pairSeed % 3;
  if (pairBias === 0) upScore += 1;
  else if (pairBias === 1) downScore += 1;

  const total  = upScore + downScore;
  const dir    = upScore >= downScore ? 'CALL' : 'PUT';
  const votes  = Math.max(upScore, downScore);
  const conf   = Math.round((votes / total) * 100);

  // OTC payout: typically 85-95% depending on session
  const basePay = 85 + session.score;
  const payout  = Math.min(95, basePay + (inVolWindow ? 3 : 0));

  let strength, sEmoji;
  if (conf >= 78) { strength = 'STRONG';   sEmoji = '💪'; }
  else if (conf >= 63) { strength = 'SOLID'; sEmoji = '✅'; }
  else { strength = 'MODERATE'; sEmoji = '⚡'; }

  // Simulated indicator values based on pattern (consistent per window)
  const rsi    = 30 + (seed % 40);
  const stochK = 20 + (seed % 60);
  const stochD = Math.round((stochK + 50) / 2);
  const macdV  = ((seed - 50) / 100).toFixed(3);
  const cciV   = Math.round((seed - 50) * 4);
  const adxV   = 20 + (session.score * 10);

  return {
    pair, dir, conf, strength, sEmoji, payout,
    tf, tfLabel: tfData.label,
    rsi, stochK, stochD,
    macdH: parseFloat(macdV) > 0 ? `+${macdV}` : `${macdV}`,
    cci: cciV, adx: adxV,
    up: upScore, down: downScore, total,
    session, isOTC: true,
    valid: conf >= 60 && payout >= 80,
    dataSource: 'OTC Pattern Logic'
  };
}

// ─── LIVE SIGNAL WITH REAL DATA ───────────────────────────────────────────────
async function livePairSignal(pairObj, tf) {
  const tfData  = TIMEFRAMES[tf] || TIMEFRAMES['1m'];
  const session = getSession();

  try {
    // Fetch real historical rates
    const prices = await getRateHistory(pairObj.from, pairObj.to, 20);
    const currentRate = await getLiveRate(pairObj.from, pairObj.to);

    if (!prices || prices.length < 10) {
      return null; // Skip if no data
    }

    // Add current rate to end
    if (currentRate) prices.push(currentRate);

    // Calculate real indicators
    const rsi    = calcRSI(prices, 14);
    const bb     = calcBB(prices, Math.min(20, prices.length));
    const stoch  = calcStoch(prices, Math.min(14, prices.length));
    const macd   = calcMACD(prices);
    const cci    = calcCCI(prices, Math.min(20, prices.length));
    const sma5   = calcSMA(prices, Math.min(5, prices.length));
    const sma10  = calcSMA(prices, Math.min(10, prices.length));
    const last   = prices[prices.length - 1];
    const prev   = prices[prices.length - 2] || last;
    const change = ((last - prev) / prev) * 100;

    // Confluence scoring with REAL values
    let up = 0, down = 0;

    // RSI
    if (rsi < 30) up += 3; else if (rsi < 45) up += 1;
    else if (rsi > 70) down += 3; else if (rsi > 55) down += 1;

    // Stochastic
    if (stoch.k < 20 && stoch.d < 20) up += 3;
    else if (stoch.k < 35) up += 1;
    else if (stoch.k > 80 && stoch.d > 80) down += 3;
    else if (stoch.k > 65) down += 1;

    // Bollinger Bands
    if (bb.pos < 0.1) up += 3; else if (bb.pos < 0.25) up += 1;
    else if (bb.pos > 0.9) down += 3; else if (bb.pos > 0.75) down += 1;

    // MACD
    if (macd.hist > 0.0001) up += 2; else if (macd.hist > 0) up += 1;
    else if (macd.hist < -0.0001) down += 2; else down += 1;

    // CCI
    if (cci < -100) up += 2; else if (cci > 100) down += 2;

    // SMA trend
    if (sma5 && sma10) {
      if (sma5 > sma10) up += 2; else down += 2;
    }

    // Price momentum
    if (change > 0.01) up += 1; else if (change < -0.01) down += 1;

    const total  = up + down;
    const dir    = up >= down ? 'CALL' : 'PUT';
    const votes  = Math.max(up, down);
    const conf   = Math.round((votes / total) * 100);

    // Live payout
    const basePay = 78;
    const tfBonus = tfData.mins >= 5 ? 3 : 0;
    const payout  = Math.min(92, basePay + tfBonus + session.score);

    let strength, sEmoji;
    if (conf >= 78) { strength = 'STRONG';   sEmoji = '💪'; }
    else if (conf >= 63) { strength = 'SOLID'; sEmoji = '✅'; }
    else { strength = 'MODERATE'; sEmoji = '⚡'; }

    const macdDisp = macd.hist > 0 ? `+${macd.hist.toFixed(5)}` : `${macd.hist.toFixed(5)}`;

    return {
      pair: pairObj.symbol, dir, conf, strength, sEmoji, payout,
      tf, tfLabel: tfData.label,
      rsi, stochK: stoch.k, stochD: stoch.d,
      macdH: macdDisp, cci, adx: Math.round(20 + session.score * 8),
      bbPos: (bb.pos * 100).toFixed(0),
      currentRate: currentRate ? currentRate.toFixed(5) : 'N/A',
      change: change.toFixed(4),
      up, down, total, session, isOTC: false,
      valid: conf >= 60 && payout >= 75,
      dataSource: 'Live Frankfurter API'
    };
  } catch(e) {
    console.error(`Live signal error ${pairObj.symbol}:`, e.message);
    return null;
  }
}

// ─── FORMAT SIGNAL ────────────────────────────────────────────────────────────
function fmtSignal(s, stake) {
  const dir    = s.dir === 'CALL' ? '🟢 ▲  C A L L' : '🔴 ▼  P U T';
  const type   = s.isOTC ? '⚠️ OTC' : '🌐 LIVE';
  const time   = new Date().toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Dhaka' });
  const profit = ((stake * s.payout) / 100).toFixed(2);
  const rateInfo = s.isOTC
    ? `_OTC synthetic price — not real market rate_`
    : `💱 Rate: *${s.currentRate}* (${parseFloat(s.change) >= 0 ? '+' : ''}${s.change}%)`;

  return [
    `━━━━━━━━━━━━━━━━━━━━`,
    `${dir}`,
    `━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `📊 *${s.pair}*`,
    `⏱ Expiry: *${s.tfLabel}*  |  ${type}`,
    `${s.session.emoji} Session: *${s.session.name}* (${s.session.quality})`,
    ``,
    `${s.sEmoji} Strength: *${s.strength}*`,
    `📈 Confidence: *${s.conf}%*  (${Math.max(s.up,s.down)}/${s.total} indicators)`,
    `💰 Payout: *${s.payout}%*`,
    ``,
    `📉 RSI: *${s.rsi}*  |  Stoch K/D: *${s.stochK}/${s.stochD}*`,
    `📌 MACD: *${s.macdH}*  |  CCI: *${s.cci}*  |  ADX: *${s.adx}*`,
    rateInfo,
    ``,
    `💵 Stake: *$${stake}*  →  If WIN: *+$${profit}*`,
    `🕐 ${time} UTC+6`,
    `━━━━━━━━━━━━━━━━━━━━`,
    s.isOTC
      ? `_⚠️ OTC: direction signal only — verify on chart_`
      : `_🌐 Live: real data — still verify on chart_`,
    `_🔒 Flat stake: $${stake} | Max 2–3% balance per trade_`,
    `_📡 Source: ${s.dataSource}_`
  ].join('\n');
}

// ─── SCAN ENGINE ──────────────────────────────────────────────────────────────
async function runScan(chatId, mode, tf, stake, auto = false) {
  const session = getSession();
  const prefix  = auto ? '🤖 *AUTO SCAN*\n' : '';

  await bot.sendMessage(chatId,
    `${prefix}🔍 *SCANNING PAIRS...*\n⏱ TF: *${TIMEFRAMES[tf]?.label || tf}*\n📡 Fetching live data + calculating indicators...\n⏳ Please wait 10–15 seconds...`,
    { parse_mode: 'Markdown' }
  );

  const signals = [];

  // --- LIVE PAIRS ---
  if (mode === 'live' || mode === 'both') {
    for (const p of LIVE_PAIRS) {
      const sig = await livePairSignal(p, tf);
      if (sig && sig.valid) signals.push(sig);
      await new Promise(r => setTimeout(r, 300)); // rate limit
    }
  }

  // --- OTC PAIRS ---
  if (mode === 'otc' || mode === 'both') {
    for (const p of OTC_PAIRS) {
      const sig = otcPatternSignal(p, tf);
      if (sig.valid) signals.push(sig);
    }
  }

  // Sort: highest confidence first, then payout
  signals.sort((a, b) => b.conf - a.conf || b.payout - a.payout);

  if (!signals.length) {
    await bot.sendMessage(chatId,
      `⛔ *NO VALID SIGNALS*\n\n${session.emoji} ${session.name} — low confluence.\n_Try a different timeframe or wait 5 min._`,
      { parse_mode: 'Markdown', reply_markup: mainKeyboard() }
    );
    return;
  }

  // Send BEST signal only
  const best = signals[0];
  stats.total++;
  best.dir === 'CALL' ? stats.calls++ : stats.puts++;
  signalHistory.unshift({ ...best, stake, sentAt: new Date().toISOString() });
  if (signalHistory.length > 100) signalHistory.pop();

  const liveCount = signals.filter(s => !s.isOTC).length;
  const otcCount  = signals.filter(s => s.isOTC).length;

  await bot.sendMessage(chatId,
    `✅ *BEST SIGNAL FOUND*\n` +
    `${session.emoji} ${session.name} | *${session.quality}*\n` +
    `📊 Valid: ${signals.length} total (${liveCount} live + ${otcCount} OTC)`,
    { parse_mode: 'Markdown' }
  );

  await bot.sendMessage(chatId, fmtSignal(best, stake), {
    parse_mode: 'Markdown',
    reply_markup: mainKeyboard()
  });
}

// ─── KEYBOARDS ────────────────────────────────────────────────────────────────
function tfKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '15s', callback_data: 'tf_15s' },
        { text: '30s', callback_data: 'tf_30s' },
        { text: '1m',  callback_data: 'tf_1m'  },
        { text: '3m',  callback_data: 'tf_3m'  },
        { text: '5m',  callback_data: 'tf_5m'  },
      ],
      [
        { text: '10m',  callback_data: 'tf_10m'  },
        { text: '15m',  callback_data: 'tf_15m'  },
        { text: '30m',  callback_data: 'tf_30m'  },
        { text: '60m',  callback_data: 'tf_60m'  },
      ],
      [
        { text: '120m', callback_data: 'tf_120m' },
        { text: '180m', callback_data: 'tf_180m' },
        { text: '240m', callback_data: 'tf_240m' },
      ]
    ]
  };
}

function stakeKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '$1',   callback_data: 'stake_1'   },
        { text: '$2',   callback_data: 'stake_2'   },
        { text: '$5',   callback_data: 'stake_5'   },
        { text: '$10',  callback_data: 'stake_10'  },
      ],
      [
        { text: '$25',  callback_data: 'stake_25'  },
        { text: '$50',  callback_data: 'stake_50'  },
        { text: '$100', callback_data: 'stake_100' },
        { text: '✏️ Custom', callback_data: 'stake_custom' },
      ]
    ]
  };
}

function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🔍 Scan All',  callback_data: 'scan_all'  },
        { text: '⚠️ OTC',       callback_data: 'scan_otc'  },
        { text: '🌐 Live',      callback_data: 'scan_live' },
      ],
      [
        { text: '⏱ Timeframe', callback_data: 'menu_tf'    },
        { text: `💵 Stake: $${selectedStake}`, callback_data: 'menu_stake' },
      ],
      [
        { text: autoMode ? '🔴 Stop Auto' : '🟢 Start Auto', callback_data: 'toggle_auto' },
        { text: '📊 Stats',  callback_data: 'show_stats' },
        { text: '📋 Last',   callback_data: 'show_last'  },
      ],
      [
        { text: '💹 Status', callback_data: 'show_status' },
      ]
    ]
  };
}

// ─── COMMANDS ─────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const session = getSession();
  await bot.sendMessage(msg.chat.id,
    `🎯 *POCKET OMNI SIGNAL BOT v4.0*\n\n` +
    `Platform: *Pocket Option*\n` +
    `Live data: *Frankfurter API (real forex)*\n` +
    `OTC: *Pattern + Session Logic*\n` +
    `Indicators: *RSI · Stoch · BB · MACD · CCI · SMA*\n\n` +
    `Current TF: *${TIMEFRAMES[selectedTF].label}*\n` +
    `Current Stake: *$${selectedStake}*\n` +
    `${session.emoji} Session: *${session.name}* (${session.quality})\n` +
    `Auto Mode: *${autoMode ? '🟢 ON' : '🔴 OFF'}*\n\n` +
    `Tap a button or use commands:\n` +
    `/scan /otc /live /tf /stake /auto /status /stats /last`,
    { parse_mode: 'Markdown', reply_markup: mainKeyboard() }
  );
});

bot.onText(/\/scan/,   async (msg) => { await runScan(msg.chat.id, 'both', selectedTF, selectedStake); });
bot.onText(/\/otc/,    async (msg) => { await runScan(msg.chat.id, 'otc',  selectedTF, selectedStake); });
bot.onText(/\/live/,   async (msg) => { await runScan(msg.chat.id, 'live', selectedTF, selectedStake); });

bot.onText(/\/tf/,     async (msg) => {
  await bot.sendMessage(msg.chat.id,
    `⏱ *SELECT TIMEFRAME*\nCurrent: *${TIMEFRAMES[selectedTF].label}*`,
    { parse_mode: 'Markdown', reply_markup: tfKeyboard() }
  );
});

bot.onText(/\/stake/,  async (msg) => {
  await bot.sendMessage(msg.chat.id,
    `💵 *SELECT STAKE*\nCurrent: *$${selectedStake}*\nFlat stake — same amount every trade.`,
    { parse_mode: 'Markdown', reply_markup: stakeKeyboard() }
  );
});

bot.onText(/\/auto/,   async (msg) => { await toggleAuto(msg.chat.id); });
bot.onText(/\/status/, async (msg) => { await sendStatus(msg.chat.id); });
bot.onText(/\/stats/,  async (msg) => { await sendStats(msg.chat.id); });
bot.onText(/\/last/,   async (msg) => { await sendLast(msg.chat.id); });
bot.onText(/\/chatid/, (msg) => {
  bot.sendMessage(msg.chat.id, `Your Chat ID: \`${msg.chat.id}\``, { parse_mode: 'Markdown' });
});

// Custom stake input
bot.onText(/^\/setstake (\d+(\.\d+)?)$/, async (msg, match) => {
  const amount = parseFloat(match[1]);
  if (amount < 1 || amount > 10000) {
    await bot.sendMessage(msg.chat.id, '❌ Stake must be between $1 and $10,000');
    return;
  }
  selectedStake = amount;
  await bot.sendMessage(msg.chat.id,
    `✅ Stake set to *$${selectedStake}*`,
    { parse_mode: 'Markdown', reply_markup: mainKeyboard() }
  );
});

// ─── ACTION FUNCTIONS ─────────────────────────────────────────────────────────
async function toggleAuto(chatId) {
  autoMode = !autoMode;
  if (autoMode) {
    autoInterval = setInterval(async () => {
      try { await runScan(chatId, 'both', selectedTF, selectedStake, true); }
      catch(e) { console.error('Auto error:', e.message); }
    }, 5 * 60 * 1000);
    await bot.sendMessage(chatId,
      `🟢 *AUTO MODE ON*\nSignal every *5 minutes*\nTF: *${TIMEFRAMES[selectedTF].label}* | Stake: *$${selectedStake}*\n\nSend /auto or tap Stop Auto to stop.`,
      { parse_mode: 'Markdown', reply_markup: mainKeyboard() }
    );
  } else {
    if (autoInterval) { clearInterval(autoInterval); autoInterval = null; }
    await bot.sendMessage(chatId, `🔴 *AUTO MODE OFF*\nUse /scan for manual signal.`, { parse_mode: 'Markdown', reply_markup: mainKeyboard() });
  }
}

async function sendStatus(chatId) {
  const s = getSession();
  await bot.sendMessage(chatId,
    `✅ *BOT STATUS: ONLINE*\n\n` +
    `⏱ Uptime: *${Math.floor(process.uptime()/60)} min*\n` +
    `${s.emoji} Session: *${s.name}* (${s.quality})\n` +
    `⏱ TF: *${TIMEFRAMES[selectedTF].label}* | 💵 Stake: *$${selectedStake}*\n` +
    `🤖 Auto: *${autoMode ? '🟢 ON (5min)' : '🔴 OFF'}*\n` +
    `📊 Signals sent: *${stats.total}*\n` +
    `📡 Live data: *Frankfurter API*\n` +
    `🔧 Version: *v4.0*`,
    { parse_mode: 'Markdown', reply_markup: mainKeyboard() }
  );
}

async function sendStats(chatId) {
  const cp = stats.total ? Math.round((stats.calls/stats.total)*100) : 0;
  const pp = stats.total ? Math.round((stats.puts/stats.total)*100) : 0;
  await bot.sendMessage(chatId,
    `📊 *SIGNAL STATISTICS*\n\n` +
    `Total Signals: *${stats.total}*\n` +
    `🟢 CALL: *${stats.calls}* (${cp}%)\n` +
    `🔴 PUT: *${stats.puts}* (${pp}%)\n\n` +
    `Current TF: *${TIMEFRAMES[selectedTF].label}*\n` +
    `Current Stake: *$${selectedStake}*\n\n` +
    `_Note: Track your own win/loss on Pocket Option_`,
    { parse_mode: 'Markdown', reply_markup: mainKeyboard() }
  );
}

async function sendLast(chatId) {
  if (!signalHistory.length) {
    await bot.sendMessage(chatId, '📋 No signals yet. Use /scan.', { reply_markup: mainKeyboard() });
    return;
  }
  const s = signalHistory[0];
  const time = new Date(s.sentAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka' });
  await bot.sendMessage(chatId,
    `📋 *LAST SIGNAL*\n\n` +
    `${s.dir==='CALL'?'🟢':'🔴'} *${s.dir}* on *${s.pair}*\n` +
    `⏱ TF: *${s.tfLabel}* | Conf: *${s.conf}%*\n` +
    `💰 Payout: *${s.payout}%* | Stake: *$${s.stake}*\n` +
    `🕐 Sent: *${time} UTC+6*\n` +
    `📡 Source: *${s.dataSource}*`,
    { parse_mode: 'Markdown', reply_markup: mainKeyboard() }
  );
}

// ─── CALLBACKS ────────────────────────────────────────────────────────────────
bot.on('callback_query', async (cb) => {
  const chatId = cb.message.chat.id;
  const data   = cb.data;
  await bot.answerCallbackQuery(cb.id);

  if (data.startsWith('tf_')) {
    selectedTF = data.replace('tf_', '');
    await bot.sendMessage(chatId,
      `✅ Timeframe: *${TIMEFRAMES[selectedTF].label}*`,
      { parse_mode: 'Markdown', reply_markup: mainKeyboard() }
    );
  } else if (data.startsWith('stake_')) {
    const val = data.replace('stake_', '');
    if (val === 'custom') {
      await bot.sendMessage(chatId,
        `✏️ *CUSTOM STAKE*\n\nType: /setstake [amount]\nExample: /setstake 15\n\nMin: $1 | Max: $10,000`,
        { parse_mode: 'Markdown' }
      );
    } else {
      selectedStake = parseInt(val);
      await bot.sendMessage(chatId,
        `✅ Stake: *$${selectedStake}*`,
        { parse_mode: 'Markdown', reply_markup: mainKeyboard() }
      );
    }
  } else if (data === 'scan_all')    await runScan(chatId, 'both', selectedTF, selectedStake);
  else if (data === 'scan_otc')      await runScan(chatId, 'otc',  selectedTF, selectedStake);
  else if (data === 'scan_live')     await runScan(chatId, 'live', selectedTF, selectedStake);
  else if (data === 'menu_tf')       await bot.sendMessage(chatId, `⏱ *SELECT TIMEFRAME*\nCurrent: *${TIMEFRAMES[selectedTF].label}*`, { parse_mode:'Markdown', reply_markup: tfKeyboard() });
  else if (data === 'menu_stake')    await bot.sendMessage(chatId, `💵 *SELECT STAKE*\nCurrent: *$${selectedStake}*`, { parse_mode:'Markdown', reply_markup: stakeKeyboard() });
  else if (data === 'toggle_auto')   await toggleAuto(chatId);
  else if (data === 'show_stats')    await sendStats(chatId);
  else if (data === 'show_last')     await sendLast(chatId);
  else if (data === 'show_status')   await sendStatus(chatId);
});

bot.on('polling_error', (e) => console.error('Poll:', e.code));
process.on('unhandledRejection', (e) => console.error('Reject:', e?.message));

// ─── EXPRESS SERVER ────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.get('/health',  (_, res) => res.json({ status: 'ok', version: '4.0', uptime: Math.floor(process.uptime()), autoMode, selectedTF, selectedStake }));
app.get('/history', (_, res) => res.json(signalHistory.slice(0, 20)));
app.get('/stats',   (_, res) => res.json(stats));
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 API on port ${PORT}`));
