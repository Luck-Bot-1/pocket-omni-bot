// ═══════════════════════════════════════════════════════════════
// OMNI ANALYZER v3.0 — 4.6/5 Grade Engine
// RSI Divergence + Volume Scoring + ADX + S/R + Multi-pattern
// ═══════════════════════════════════════════════════════════════

// ── Core Indicators ────────────────────────────────────────────
function calcEMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  if (losses === 0) return 100;
  return parseFloat((100 - (100 / (1 + (gains / period) / (losses / period)))).toFixed(2));
}

function calcRSISeries(prices, period = 14) {
  const result = [];
  for (let i = period; i < prices.length; i++) {
    result.push(calcRSI(prices.slice(0, i + 1), period));
  }
  return result;
}

function calcMACD(prices) {
  const ema12 = calcEMA(prices, 12);
  const ema26 = calcEMA(prices, 26);
  if (!ema12 || !ema26) return { macd: 0, histogram: 0, signal: 0 };
  const macd = ema12 - ema26;
  // Simplified signal
  const macdSeries = prices.map((_, i) => {
    if (i < 26) return 0;
    const e12 = calcEMA(prices.slice(0, i + 1), 12);
    const e26 = calcEMA(prices.slice(0, i + 1), 26);
    return e12 && e26 ? e12 - e26 : 0;
  }).filter(v => v !== 0);
  const signal = calcEMA(macdSeries, 9) || macd;
  return { macd, signal, histogram: macd - signal };
}

function calcStochastic(highs, lows, closes, period = 14) {
  if (!closes || closes.length < period) return { k: 50, d: 50 };
  const h = Math.max(...highs.slice(-period));
  const l = Math.min(...lows.slice(-period));
  if (h === l) return { k: 50, d: 50 };
  const k = ((closes[closes.length - 1] - l) / (h - l)) * 100;
  return { k: parseFloat(k.toFixed(2)), d: parseFloat(k.toFixed(2)) };
}

function calcBollingerBands(prices, period = 20) {
  if (!prices || prices.length < period) return null;
  const slice = prices.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period);
  return {
    upper: mean + 2 * std,
    middle: mean,
    lower: mean - 2 * std,
    std,
    width: ((mean + 2 * std) - (mean - 2 * std)) / mean
  };
}

function calcADX(highs, lows, closes, period = 14) {
  if (!closes || closes.length < period + 1) return { adx: 20, plusDI: 25, minusDI: 25 };
  const trs = [], pdms = [], ndms = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
    const up = highs[i] - highs[i-1], dn = lows[i-1] - lows[i];
    pdms.push(up > dn && up > 0 ? up : 0);
    ndms.push(dn > up && dn > 0 ? dn : 0);
  }
  const atr = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  if (atr === 0) return { adx: 20, plusDI: 25, minusDI: 25 };
  const pDI = (pdms.slice(-period).reduce((a, b) => a + b, 0) / period / atr) * 100;
  const nDI = (ndms.slice(-period).reduce((a, b) => a + b, 0) / period / atr) * 100;
  const adx = pDI + nDI > 0 ? Math.abs(pDI - nDI) / (pDI + nDI) * 100 : 20;
  return {
    adx: parseFloat(adx.toFixed(2)),
    plusDI: parseFloat(pDI.toFixed(2)),
    minusDI: parseFloat(nDI.toFixed(2))
  };
}

// ── Volume Analysis ────────────────────────────────────────────
function analyzeVolume(volumes, closes) {
  if (!volumes || volumes.length < 10) return { trend: 'UNKNOWN', obv: 0, score: 0 };
  
  // On-Balance Volume (OBV)
  let obv = 0;
  const obvSeries = [];
  for (let i = 1; i < Math.min(volumes.length, closes.length); i++) {
    if (closes[i] > closes[i-1])      obv += volumes[i];
    else if (closes[i] < closes[i-1]) obv -= volumes[i];
    obvSeries.push(obv);
  }
  
  // Volume trend: rising or falling
  const recentVol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const avgVol    = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volRatio  = avgVol > 0 ? recentVol / avgVol : 1;
  
  // OBV trend
  const obvTrend = obvSeries.length > 5
    ? (obvSeries[obvSeries.length - 1] > obvSeries[obvSeries.length - 5] ? 'UP' : 'DOWN')
    : 'FLAT';

  let score = 0;
  let trend = 'NEUTRAL';
  
  if (volRatio > 1.3 && obvTrend === 'UP')   { score = 2;  trend = 'BULLISH_STRONG'; }
  else if (volRatio > 1.1 && obvTrend === 'UP')   { score = 1;  trend = 'BULLISH'; }
  else if (volRatio > 1.3 && obvTrend === 'DOWN')  { score = -2; trend = 'BEARISH_STRONG'; }
  else if (volRatio > 1.1 && obvTrend === 'DOWN')  { score = -1; trend = 'BEARISH'; }
  
  return { trend, obv: parseFloat(obv.toFixed(2)), obvTrend, volRatio: parseFloat(volRatio.toFixed(2)), score };
}

// ── RSI Divergence Detection ───────────────────────────────────
// Most powerful reversal signal
function detectDivergence(closes, rsiSeries, lookback = 15) {
  if (!rsiSeries || rsiSeries.length < lookback || closes.length < lookback) {
    return { type: 'NONE', strength: 0 };
  }
  
  const priceSlice = closes.slice(-lookback);
  const rsiSlice   = rsiSeries.slice(-lookback);
  const n = priceSlice.length - 1;
  
  // Find recent swing high/low in price
  let priceLow1Idx = 0, priceHigh1Idx = 0;
  for (let i = 1; i < n - 1; i++) {
    if (priceSlice[i] < priceSlice[priceLow1Idx])  priceLow1Idx = i;
    if (priceSlice[i] > priceSlice[priceHigh1Idx]) priceHigh1Idx = i;
  }
  
  const currentPrice = priceSlice[n];
  const currentRSI   = rsiSlice[n];
  const prevLowPrice = priceSlice[priceLow1Idx];
  const prevLowRSI   = rsiSlice[priceLow1Idx];
  const prevHiPrice  = priceSlice[priceHigh1Idx];
  const prevHiRSI    = rsiSlice[priceHigh1Idx];
  
  // Bullish divergence: price makes lower low, RSI makes higher low
  if (currentPrice < prevLowPrice && currentRSI > prevLowRSI && currentRSI < 45) {
    const strength = Math.abs(currentRSI - prevLowRSI);
    return { type: 'BULLISH_DIVERGENCE', strength: parseFloat(strength.toFixed(1)), bias: 'CALL' };
  }
  
  // Bearish divergence: price makes higher high, RSI makes lower high
  if (currentPrice > prevHiPrice && currentRSI < prevHiRSI && currentRSI > 55) {
    const strength = Math.abs(prevHiRSI - currentRSI);
    return { type: 'BEARISH_DIVERGENCE', strength: parseFloat(strength.toFixed(1)), bias: 'PUT' };
  }
  
  // Hidden bullish: price higher low, RSI lower low (trend continuation)
  if (currentPrice > prevLowPrice && currentRSI < prevLowRSI && currentRSI < 50) {
    return { type: 'HIDDEN_BULLISH', strength: 5, bias: 'CALL' };
  }
  
  // Hidden bearish: price lower high, RSI higher high
  if (currentPrice < prevHiPrice && currentRSI > prevHiRSI && currentRSI > 50) {
    return { type: 'HIDDEN_BEARISH', strength: 5, bias: 'PUT' };
  }
  
  return { type: 'NONE', strength: 0 };
}

// ── Support/Resistance ─────────────────────────────────────────
function findSR(highs, lows, closes, lookback = 30) {
  const levels = [], n = Math.min(lookback, closes.length);
  const rh = highs.slice(-n), rl = lows.slice(-n);
  
  for (let i = 2; i < rh.length - 2; i++) {
    if (rh[i] > rh[i-1] && rh[i] > rh[i-2] && rh[i] > rh[i+1] && rh[i] > rh[i+2])
      levels.push({ price: rh[i], type: 'resistance', strength: 1 });
  }
  for (let i = 2; i < rl.length - 2; i++) {
    if (rl[i] < rl[i-1] && rl[i] < rl[i-2] && rl[i] < rl[i+1] && rl[i] < rl[i+2])
      levels.push({ price: rl[i], type: 'support', strength: 1 });
  }
  
  // Merge nearby levels (cluster)
  const merged = [];
  const threshold = closes[closes.length-1] * 0.002;
  for (const lvl of levels) {
    const existing = merged.find(m => Math.abs(m.price - lvl.price) < threshold);
    if (existing) existing.strength++;
    else merged.push({ ...lvl });
  }
  
  return merged.sort((a, b) => b.strength - a.strength);
}

function getNearestSR(price, levels, threshold = 0.0015) {
  for (const lvl of levels) {
    if (Math.abs(price - lvl.price) / price <= threshold) return lvl;
  }
  return null;
}

// ── Candle Patterns ────────────────────────────────────────────
function detectPatterns(opens, closes, highs, lows) {
  const patterns = [];
  const n = closes.length;
  if (n < 4) return patterns;
  
  const c = closes[n-1], o = opens[n-1], h = highs[n-1], l = lows[n-1];
  const c1 = closes[n-2], o1 = opens[n-2], h1 = highs[n-2], l1 = lows[n-2];
  const c2 = closes[n-3], o2 = opens[n-3];
  const body = Math.abs(c - o), body1 = Math.abs(c1 - o1);
  const range = h - l;
  const uw = h - Math.max(o, c), lw = Math.min(o, c) - l;
  
  if (body < range * 0.1)                                   patterns.push({ name:'Doji',             bias:'NEUTRAL', w:1 });
  if (c1 < o1 && c > o && c > o1 && o < c1)                patterns.push({ name:'Bullish Engulfing', bias:'CALL',    w:4 });
  if (c1 > o1 && c < o && c < o1 && o > c1)                patterns.push({ name:'Bearish Engulfing', bias:'PUT',     w:4 });
  if (lw > body * 2.5 && uw < body * 0.5 && c > o)         patterns.push({ name:'Hammer',            bias:'CALL',    w:3 });
  if (uw > body * 2.5 && lw < body * 0.5 && c < o)         patterns.push({ name:'Shooting Star',     bias:'PUT',     w:3 });
  if (lw > body * 3)                                        patterns.push({ name:'Bullish Pin Bar',   bias:'CALL',    w:4 });
  if (uw > body * 3)                                        patterns.push({ name:'Bearish Pin Bar',   bias:'PUT',     w:4 });
  if (c > o && c1 > o1 && c2 > o2)                         patterns.push({ name:'3 Bull Candles',    bias:'CALL',    w:2 });
  if (c < o && c1 < o1 && c2 < o2)                         patterns.push({ name:'3 Bear Candles',    bias:'PUT',     w:2 });
  if (c1 > o1 && body < body1 * 0.3 && c < c1)             patterns.push({ name:'Bearish Harami',    bias:'PUT',     w:2 });
  if (c1 < o1 && body < body1 * 0.3 && c > c1)             patterns.push({ name:'Bullish Harami',    bias:'CALL',    w:2 });
  if (c > Math.max(o1, c1) && o < Math.min(o1, c1))        patterns.push({ name:'Morning Star',      bias:'CALL',    w:3 });
  if (c < Math.min(o1, c1) && o > Math.max(o1, c1))        patterns.push({ name:'Evening Star',      bias:'PUT',     w:3 });
  
  return patterns;
}

// ── HTF Bias ───────────────────────────────────────────────────
function getHTFBias(htfData) {
  if (!htfData || !htfData.closes || htfData.closes.length < 26) return 'NEUTRAL';
  const ema9  = calcEMA(htfData.closes, 9);
  const ema21 = calcEMA(htfData.closes, 21);
  const rsi   = calcRSI(htfData.closes);
  if (!ema9 || !ema21) return 'NEUTRAL';
  const emaBias = ema9 > ema21 * 1.0002 ? 'BULLISH' : ema9 < ema21 * 0.9998 ? 'BEARISH' : 'NEUTRAL';
  const rsiBias = rsi > 55 ? 'BULLISH' : rsi < 45 ? 'BEARISH' : 'NEUTRAL';
  if (emaBias === rsiBias) return emaBias;
  if (emaBias !== 'NEUTRAL') return emaBias;
  return 'NEUTRAL';
}

// ── Main Analysis Function ─────────────────────────────────────
function analyzeSignal(priceData, pair, htfData = null) {
  const { opens, highs, lows, closes, volumes } = priceData;
  if (!closes || closes.length < 30) return null;

  const price = closes[closes.length - 1];
  
  // ── Calculate all indicators
  const rsi        = calcRSI(closes);
  const rsiSeries  = calcRSISeries(closes);
  const macd       = calcMACD(closes);
  const stoch      = calcStochastic(highs, lows, closes);
  const ema9       = calcEMA(closes, 9);
  const ema21      = calcEMA(closes, 21);
  const ema50      = calcEMA(closes, 50);
  const bb         = calcBollingerBands(closes);
  const adx        = calcADX(highs, lows, closes);
  const srLevels   = findSR(highs, lows, closes);
  const nearSR     = getNearestSR(price, srLevels);
  const patterns   = detectPatterns(opens, closes, highs, lows);
  const divergence = detectDivergence(closes, rsiSeries);
  const volData    = analyzeVolume(volumes, closes);
  const htfBias    = getHTFBias(htfData);

  let callScore = 0, putScore = 0;
  const reasons = [], warnings = [];

  // ── DIVERGENCE (highest weight — most reliable reversal signal)
  if (divergence.type === 'BULLISH_DIVERGENCE') {
    callScore += 5;
    reasons.push(`🔥 RSI Bullish Divergence (strength: ${divergence.strength}) — high-confidence CALL`);
  } else if (divergence.type === 'BEARISH_DIVERGENCE') {
    putScore += 5;
    reasons.push(`🔥 RSI Bearish Divergence (strength: ${divergence.strength}) — high-confidence PUT`);
  } else if (divergence.type === 'HIDDEN_BULLISH') {
    callScore += 3;
    reasons.push(`Hidden Bullish Divergence — trend continuation CALL`);
  } else if (divergence.type === 'HIDDEN_BEARISH') {
    putScore += 3;
    reasons.push(`Hidden Bearish Divergence — trend continuation PUT`);
  }

  // ── HTF ALIGNMENT (gate — misalignment is a warning)
  if (htfBias === 'BULLISH')      { callScore += 2; reasons.push(`HTF Bias: BULLISH — higher TF confirms`); }
  else if (htfBias === 'BEARISH') { putScore  += 2; reasons.push(`HTF Bias: BEARISH — higher TF confirms`); }
  else                            { warnings.push(`HTF bias neutral — no higher TF confirmation`); }

  // ── RSI
  if      (rsi < 25) { callScore += 3; reasons.push(`RSI extreme oversold (${rsi}) — reversal imminent`); }
  else if (rsi < 35) { callScore += 2; reasons.push(`RSI oversold (${rsi}) — CALL zone`); }
  else if (rsi < 45) { callScore += 1; reasons.push(`RSI below midline (${rsi})`); }
  else if (rsi > 75) { putScore  += 3; reasons.push(`RSI extreme overbought (${rsi}) — reversal imminent`); }
  else if (rsi > 65) { putScore  += 2; reasons.push(`RSI overbought (${rsi}) — PUT zone`); }
  else if (rsi > 55) { putScore  += 1; reasons.push(`RSI above midline (${rsi})`); }
  else               { warnings.push(`RSI neutral (${rsi}) — no clear bias`); }

  // ── MACD
  if (macd.histogram > 0 && macd.macd > 0)        { callScore += 2; reasons.push(`MACD bullish + positive histogram`); }
  else if (macd.histogram > 0 && macd.macd <= 0)  { callScore += 1; reasons.push(`MACD histogram turning bullish`); }
  else if (macd.histogram < 0 && macd.macd < 0)   { putScore  += 2; reasons.push(`MACD bearish + negative histogram`); }
  else if (macd.histogram < 0 && macd.macd >= 0)  { putScore  += 1; reasons.push(`MACD histogram turning bearish`); }

  // ── STOCHASTIC
  if      (stoch.k < 15) { callScore += 3; reasons.push(`Stoch deeply oversold K=${stoch.k.toFixed(0)} — CALL`); }
  else if (stoch.k < 25) { callScore += 2; reasons.push(`Stoch oversold K=${stoch.k.toFixed(0)}`); }
  else if (stoch.k > 85) { putScore  += 3; reasons.push(`Stoch deeply overbought K=${stoch.k.toFixed(0)} — PUT`); }
  else if (stoch.k > 75) { putScore  += 2; reasons.push(`Stoch overbought K=${stoch.k.toFixed(0)}`); }

  // ── EMA
  if (ema9 && ema21) {
    if (ema9 > ema21 * 1.0002)      { callScore += 1; reasons.push(`EMA9 above EMA21 — uptrend`); }
    else if (ema9 < ema21 * 0.9998) { putScore  += 1; reasons.push(`EMA9 below EMA21 — downtrend`); }
  }
  if (ema50) {
    if (price > ema50)      { callScore += 1; reasons.push(`Price above EMA50 — macro bullish`); }
    else if (price < ema50) { putScore  += 1; reasons.push(`Price below EMA50 — macro bearish`); }
  }

  // ── BOLLINGER BANDS
  if (bb) {
    const bbPct = (price - bb.lower) / (bb.upper - bb.lower);
    if      (price <= bb.lower)  { callScore += 3; reasons.push(`Price at/below lower BB — mean reversion CALL`); }
    else if (bbPct < 0.15)       { callScore += 2; reasons.push(`Price near lower BB (${(bbPct*100).toFixed(0)}%)`); }
    else if (price >= bb.upper)  { putScore  += 3; reasons.push(`Price at/above upper BB — mean reversion PUT`); }
    else if (bbPct > 0.85)       { putScore  += 2; reasons.push(`Price near upper BB (${(bbPct*100).toFixed(0)}%)`); }
    if (bb.width < 0.005)        { warnings.push(`BB squeeze — breakout imminent, direction unclear`); }
  }

  // ── SUPPORT/RESISTANCE
  if (nearSR) {
    if (nearSR.type === 'support')    { callScore += 3; reasons.push(`Price at key support (strength: ${nearSR.strength}) — bounce CALL`); }
    else if (nearSR.type === 'resistance') { putScore += 3; reasons.push(`Price at key resistance (strength: ${nearSR.strength}) — rejection PUT`); }
  }

  // ── ADX TREND STRENGTH
  if (adx.adx < 15) {
    warnings.push(`ADX ${adx.adx} — weak trend, signal less reliable`);
    // Reduce scores by 20% in ranging market
    callScore *= 0.8; putScore *= 0.8;
  } else if (adx.adx > 30) {
    // Strong trend — boost the trending direction
    if (adx.plusDI > adx.minusDI) { callScore += 1; reasons.push(`ADX ${adx.adx} strong trend — bullish DI dominant`); }
    else                           { putScore  += 1; reasons.push(`ADX ${adx.adx} strong trend — bearish DI dominant`); }
  }

  // ── VOLUME (when available)
  if (volData.trend !== 'UNKNOWN') {
    if (volData.score > 0)      { callScore += volData.score; reasons.push(`Volume: ${volData.trend} (OBV ${volData.obvTrend})`); }
    else if (volData.score < 0) { putScore  += Math.abs(volData.score); reasons.push(`Volume: ${volData.trend} (OBV ${volData.obvTrend})`); }
  }

  // ── CANDLE PATTERNS
  for (const p of patterns) {
    if      (p.bias === 'CALL')    { callScore += p.w; reasons.push(`Pattern: ${p.name} → CALL`); }
    else if (p.bias === 'PUT')     { putScore  += p.w; reasons.push(`Pattern: ${p.name} → PUT`); }
    else                           { warnings.push(`Pattern: ${p.name} (neutral)`); }
  }

  // ── Minimum confluence: need 5+ reasons
  if (reasons.length < 5) return null;

  const total = callScore + putScore;
  if (total < 5) return null;

  const direction = callScore > putScore ? 'CALL' : 'PUT';
  let confidence  = Math.round((Math.max(callScore, putScore) / total) * 100);
  
  // Cap and minimum
  confidence = Math.min(Math.max(confidence, 60), 97);
  if (confidence < 65) return null;

  // Live pair confidence bonus (real data = higher reliability)
  if (pair.cat === 'LIVE') confidence = Math.min(confidence + 3, 97);

  // Divergence signal = high-confidence signal
  if (divergence.type !== 'NONE') confidence = Math.min(confidence + 5, 97);

  return {
    symbol:       pair.symbol,
    direction,
    confidence,
    payout:       pair.payout,
    cat:          pair.cat,
    rsi:          rsi.toFixed(1),
    macd:         macd.macd.toFixed(6),
    macdHist:     macd.histogram.toFixed(6),
    stochK:       stoch.k.toFixed(1),
    adx:          adx.adx.toFixed(1),
    plusDI:       adx.plusDI.toFixed(1),
    minusDI:      adx.minusDI.toFixed(1),
    ema9:         ema9 ? ema9.toFixed(5) : 'N/A',
    ema21:        ema21 ? ema21.toFixed(5) : 'N/A',
    htfBias,
    divergence:   divergence.type,
    volume:       volData.trend,
    srCount:      srLevels.length,
    patterns:     patterns.map(p => p.name),
    indicators:   `${reasons.length}/${reasons.length + warnings.length}`,
    reasons:      reasons.slice(0, 7),
    warnings:     warnings.slice(0, 3),
    currentPrice: price,
    callScore:    parseFloat(callScore.toFixed(1)),
    putScore:     parseFloat(putScore.toFixed(1))
  };
}

// ═══════════════════════════════════════════════════════════════
// BACKTESTING ENGINE
// ═══════════════════════════════════════════════════════════════
function backtest(priceData, pair, periods = 80) {
  const { opens, highs, lows, closes, volumes } = priceData;
  if (!closes || closes.length < 50) return null;

  let wins = 0, losses = 0, skipped = 0;
  const trades = [];
  const minWindow = 40;

  for (let i = minWindow; i < Math.min(closes.length - 3, periods + minWindow); i++) {
    const slice = {
      opens:   opens?.slice(0, i) || [],
      highs:   highs.slice(0, i),
      lows:    lows.slice(0, i),
      closes:  closes.slice(0, i),
      volumes: volumes?.slice(0, i) || [],
    };
    
    const sig = analyzeSignal(slice, pair, null);
    if (!sig || sig.confidence < 68) { skipped++; continue; }

    // Check next 3 candles for confirmation (not just 1)
    const entryPrice = closes[i];
    const exit1 = closes[i + 1];
    const exit3 = closes[i + 3] || closes[closes.length - 1];
    
    // Win if direction correct at both exit1 AND exit3
    const dir1 = exit1 > entryPrice ? 'CALL' : 'PUT';
    const dir3 = exit3 > entryPrice ? 'CALL' : 'PUT';
    const won  = sig.direction === dir1 && sig.direction === dir3;

    if (won) wins++; else losses++;
    trades.push({ i, dir: sig.direction, conf: sig.confidence, won, entry: entryPrice, exit: exit1 });
  }

  const total   = wins + losses;
  const winRate = total > 0 ? Math.round(wins / total * 100) : 0;
  const pnl     = (wins * (pair.payout / 100) - losses).toFixed(2);
  const avgConf = trades.length > 0
    ? Math.round(trades.reduce((a, b) => a + b.conf, 0) / trades.length)
    : 0;

  // Calculate streak info
  let maxStreak = 0, curStreak = 0, maxLoss = 0, curLoss = 0;
  for (const t of trades) {
    if (t.won) { curStreak++; maxStreak = Math.max(maxStreak, curStreak); curLoss = 0; }
    else       { curLoss++;   maxLoss   = Math.max(maxLoss, curLoss);   curStreak = 0; }
  }

  return {
    pair: pair.symbol, cat: pair.cat,
    total, wins, losses, skipped,
    winRate, pnl, avgConf,
    maxWinStreak: maxStreak,
    maxLossStreak: maxLoss,
    grade: winRate >= 70 ? 'A' : winRate >= 60 ? 'B' : winRate >= 50 ? 'C' : 'D'
  };
}

module.exports = { analyzeSignal, backtest };

