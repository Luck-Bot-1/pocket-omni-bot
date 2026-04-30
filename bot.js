// ═══════════════════════════════════════════════════════════════
// OMNI BULLS EYE v7.1 — Rate-Limit Safe Build
// ═══════════════════════════════════════════════════════════════

const TelegramBot = require('node-telegram-bot-api');
const { fetchPriceData, fetchHistoricalData } = require('./pricefetcher');
const { analyzeSignal, backtest } = require('./analyzer');

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

console.log('=== OMNI BOT v7.1 STARTING ===');
console.log('Token exists:', !!TOKEN);
console.log('ChatID exists:', !!CHAT_ID);

if (!TOKEN || !CHAT_ID) { console.error('FATAL: Missing TOKEN or CHAT_ID'); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });
console.log('Bot polling started');

// ── State ──────────────────────────────────────────────────────
let autoMode = false, autoTimer = null;
let expiry = 15, tfInterval = '15min', stake = 5;
let scanInProgress = false; // prevent overlapping scans

const pairStats = {};
function getPairStat(symbol) {
  if (!pairStats[symbol]) pairStats[symbol] = { wins:0, losses:0, skipped:0 };
  return pairStats[symbol];
}

let S = { total:0, wins:0, losses:0, skipped:0, calls:0, puts:0, pnl:0 };
function resetStats() {
  S = { total:0, wins:0, losses:0, skipped:0, calls:0, puts:0, pnl:0 };
  Object.keys(pairStats).forEach(k => delete pairStats[k]);
}

let cbOn = false, cbAt = null, consLoss = 0;
function isCB() {
  if (!cbOn) return false;
  if (Date.now() - cbAt >= 2*60*60*1000) { resetCB(); return false; }
  return true;
}
function setCB()   { cbOn=true; cbAt=Date.now(); }
function resetCB() { cbOn=false; cbAt=null; consLoss=0; }

// ── Pairs ──────────────────────────────────────────────────────
const OTC_PAIRS = [
  { symbol:'EUR/USD OTC', payout:92, cat:'OTC' },
  { symbol:'GBP/USD OTC', payout:92, cat:'OTC' },
  { symbol:'AUD/USD OTC', payout:92, cat:'OTC' },
  { symbol:'AUD/CHF OTC', payout:92, cat:'OTC' },
  { symbol:'EUR/GBP OTC', payout:92, cat:'OTC' },
  { symbol:'EUR/JPY OTC', payout:92, cat:'OTC' },
  { symbol:'GBP/JPY OTC', payout:92, cat:'OTC' },
  { symbol:'AED/CNY OTC', payout:92, cat:'OTC' },
  { symbol:'GBP/AUD OTC', payout:92, cat:'OTC' },
  { symbol:'NZD/USD OTC', payout:90, cat:'OTC' },
  { symbol:'USD/JPY OTC', payout:90, cat:'OTC' },
  { symbol:'AUD/JPY OTC', payout:87, cat:'OTC' },
];

const LIVE_PAIRS = [
  { symbol:'EUR/USD', payout:86, cat:'LIVE' },
  { symbol:'GBP/USD', payout:87, cat:'LIVE' },
  { symbol:'USD/JPY', payout:85, cat:'LIVE' },
  { symbol:'EUR/GBP', payout:87, cat:'LIVE' },
  { symbol:'GBP/JPY', payout:85, cat:'LIVE' },
  { symbol:'EUR/JPY', payout:85, cat:'LIVE' },
  { symbol:'AUD/USD', payout:85, cat:'LIVE' },
  { symbol:'USD/CHF', payout:85, cat:'LIVE' },
];

const CRYPTO_PAIRS = [
  { symbol:'BTC/USD OTC', payout:90, cat:'CRYPTO' },
  { symbol:'ETH/USD OTC', payout:90, cat:'CRYPTO' },
  { symbol:'XRP/USD OTC', payout:88, cat:'CRYPTO' },
  { symbol:'LTC/USD OTC', payout:88, cat:'CRYPTO' },
];

const COMM_PAIRS = [
  { symbol:'XAU/USD OTC', payout:90, cat:'COMMODITY' },
  { symbol:'XAG/USD OTC', payout:88, cat:'COMMODITY' },
];

const ALL_PAIRS = [...OTC_PAIRS, ...LIVE_PAIRS, ...CRYPTO_PAIRS, ...COMM_PAIRS];
function findPair(symbol) { return ALL_PAIRS.find(p => p.symbol === symbol); }

// ── Session info GMT+6 ─────────────────────────────────────────
const SESSIONS = [
  { name:'🔴 London/NY Overlap', s:19*60,    e:21*60+30, d:[1,2,3,4,5] },
  { name:'🟢 London Open',       s:14*60,    e:16*60,    d:[1,2,3,4,5] },
  { name:'🟡 Late NY/OTC',       s:22*60+30, e:24*60,    d:[1,2,3,4,5] },
  { name:'🟡 Asian OTC',         s:5*60,     e:7*60,     d:[2,3,4,5]   },
  { name:'🟡 Morning OTC',       s:9*60,     e:11*60,    d:[3,4,5,6]   },
  { name:'🟡 Weekend OTC',       s:11*60,    e:13*60,    d:[0,6]       },
];

function getSession() {
  const t = new Date(Date.now() + 6*3600*1000);
  const d = t.getUTCDay(), m = t.getUTCHours()*60 + t.getUTCMinutes();
  for (const s of SESSIONS) {
    if (s.d.includes(d) && m >= s.s && m < s.e) return { active:true, ...s };
  }
  return { active:false, name:'⏰ Outside Prime Hours' };
}

function newsCheck() {
  const now = new Date();
  const h = now.getUTCHours(), m = now.getUTCMinutes(), d = now.getUTCDay();
  const min = h*60 + m;
  const windows = [
    { s:8*60+15,  e:9*60+15,  desc:'European Open' },
    { s:13*60+15, e:14*60+15, desc:'US Market Open' },
    { s:15*60+45, e:16*60+30, desc:'US Data Release' },
    { s:18*60+45, e:19*60+30, desc:'US Close' },
    ...(d===5 ? [{ s:13*60+15, e:14*60+30, desc:'NFP Friday' }] : []),
    ...(d===3 ? [{ s:18*60+45, e:20*60,    desc:'FOMC'        }] : []),
  ];
  for (const w of windows) {
    if (min >= w.s-15 && min <= w.e) return { on:true, desc:w.desc };
  }
  return { on:false };
}

// ── Helpers ────────────────────────────────────────────────────
const auth    = m => m.chat.id.toString() === CHAT_ID.toString();
const send    = (t, x={}) => bot.sendMessage(CHAT_ID, t, { parse_mode:'HTML', ...x }).catch(e => console.error('Send error:', e.message));
const delay   = ms => new Promise(r => setTimeout(r, ms));
const gmt6    = () => new Date(Date.now()+6*3600000).toISOString().slice(11,16);
const confBar = p => '█'.repeat(Math.round(p/10)) + '░'.repeat(10-Math.round(p/10));
const pct     = (w, l) => w+l > 0 ? Math.round(w/(w+l)*100) : 0;

// ── Keyboards ──────────────────────────────────────────────────
const KB = { reply_markup:{ keyboard:[
  [{text:'📋 OTC Pairs'}, {text:'🌐 Live Pairs'}, {text:'₿ Crypto'}],
  [{text:'🛢 Commodity'}, {text:'📊 Stats'},       {text:'⚡ Status'}],
  [{text:'🟢 Auto ON'},  {text:'🔴 Auto OFF'},     {text:'🔬 Backtest'}],
  [{text:'⏱ Expiry'},   {text:'💵 Stake'},         {text:'🏆 Best Pairs'}],
  [{text:'🔁 Reset'},    {text:'❓ Help'},          {text:'🛡 Breaker'}],
], resize_keyboard:true }};

function pairKeyboard(pairs) {
  const rows = [];
  for (let i = 0; i < pairs.length; i += 3) {
    rows.push(pairs.slice(i, i+3).map(p => ({
      text: p.symbol,
      callback_data: `SCAN_${p.symbol}`
    })));
  }
  rows.push([{ text:'🔙 Back', callback_data:'BACK' }]);
  return { reply_markup:{ inline_keyboard: rows }};
}

// ── Core single-pair scan ──────────────────────────────────────
async function scanPair(pair) {
  if (isCB()) {
    const remaining = Math.ceil((2*60*60*1000 - (Date.now()-cbAt)) / 60000);
    return send(`🛑 <b>CIRCUIT BREAKER ACTIVE</b>\n3 consecutive losses — paused.\nAuto-resets in <b>${remaining} min</b>.\n\nTap 🛡 Breaker to override.`);
  }

  // Prevent overlapping scans — each scan = 1 API call, don't stack
  if (scanInProgress) {
    return send(`⏳ <b>Scan in progress...</b>\nPlease wait for current scan to complete.`);
  }

  scanInProgress = true;

  const session = getSession();
  const news    = newsCheck();
  const newsWarn = news.on ? `\n⚠️ <b>NEWS ALERT: ${news.desc}</b> — trade carefully` : '';
  const sessInfo = session.active
    ? `📅 ${session.name}`
    : `📅 Outside prime hours — OTC pairs recommended`;

  await send(`🔍 <b>Scanning ${pair.symbol}...</b>\n${sessInfo}${newsWarn}`);

  let data = null;
  try {
    // Single fetch attempt — queue in pricefetcher handles rate limiting
    data = await fetchPriceData(pair.symbol, tfInterval);
  } catch(e) {
    console.error(`Fetch failed for ${pair.symbol}:`, e.message);
  } finally {
    scanInProgress = false;
  }

  if (!data || !data.ltf) {
    return send(
      `📡 <b>No data for ${pair.symbol}</b>\n\n` +
      `Possible reasons:\n` +
      `• API rate limit — wait 60 seconds\n` +
      `• Pair not available on Twelve Data\n` +
      `• Network issue\n\n` +
      `Try another pair or wait 1 minute.`
    );
  }

  let sig = null;
  try {
    sig = analyzeSignal(data.ltf, pair, data.htf);
  } catch(e) {
    console.error('Analyzer error:', e.message);
    return send(`⚠️ Analysis error for ${pair.symbol}. Try again.`);
  }

  if (!sig || sig.confidence < 60) {
    const ps = getPairStat(pair.symbol);
    return send(
      `📭 <b>NO SETUP — ${pair.symbol}</b>\n\n` +
      `${sessInfo}\n` +
      `Payout: ${pair.payout}% | TF: ${tfInterval}\n\n` +
      `Indicators not aligned for a clean entry.\n` +
      `⏳ Try again in 10–15 min or pick another pair.\n\n` +
      `Your record on this pair: ${ps.wins}W / ${ps.losses}L`
    );
  }

  S.total++;
  sig.direction === 'CALL' ? S.calls++ : S.puts++;
  await sendSignal(sig, session, newsWarn);
}

// ── Send signal card ───────────────────────────────────────────
async function sendSignal(sig, session, newsWarn='') {
  const de   = sig.direction==='CALL' ? '🟢⬆️' : '🔴⬇️';
  const tier = sig.payout>=92 ? '💎' : sig.payout>=88 ? '🥇' : '🥈';
  const live = sig.cat==='LIVE' ? ' ⭐ LIVE' : '';
  const div  = sig.divergence && sig.divergence!=='NONE' ? `\n🔥 <b>DIVERGENCE:</b> ${sig.divergence}` : '';
  const ps   = getPairStat(sig.symbol);
  const wr   = pct(ps.wins, ps.losses);

// REPLACE WITH:
  // Sanitize all values — escape < and > to prevent Telegram HTML parse errors
  const san = v => String(v||'?').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const sanReasons = (arr) => (arr||[]).map(r => san(r));

  const msg =
    `${de} <b>${sig.direction}${live}</b> ${tier}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📊 <b>${san(sig.symbol)}</b>\n` +
    `💰 Payout: +${sig.payout}%  ⏱ Expiry: ${expiry}MIN\n` +
    `🎯 Confidence: ${sig.confidence}%\n` +
    `[${confBar(sig.confidence)}]\n\n` +
    `📈 RSI: ${san(sig.rsi)}  Stoch: ${san(sig.stochK)}\n` +
    `MACD: ${san(sig.macd)}  ADX: ${san(sig.adx)}\n` +
    `HTF Bias: ${san(sig.htfBias)}${div}\n\n` +
    `✅ <b>Confluence (${san(sig.indicators)}):</b>\n` +
    sanReasons(sig.reasons).slice(0,5).map(r=>`  • ${r}`).join('\n') +
    (sanReasons(sig.warnings).length ? `\n\n⚠️ <b>Caution:</b>\n`+sanReasons(sig.warnings).slice(0,2).map(w=>`  • ${w}`).join('\n') : '') +
    `\n\n📅 ${san(session.name||'OTC Session')}` +
    `${newsWarn}\n` +
    `💵 Stake: $${stake} → Win: +$${(stake*sig.payout/100).toFixed(2)} | Loss: -$${stake}\n` +
    `📌 Your record: ${ps.wins}W/${ps.losses}L${ps.wins+ps.losses>0?` (${wr}% WR)`:''}\n\n` +
    `⚠️ <i>Verify payout on Pocket Option before entering</i>`;

  await bot.sendMessage(CHAT_ID, msg, {
    parse_mode:'HTML',
    reply_markup:{ inline_keyboard:[[
      { text:'✅ WIN',  callback_data:`W_${sig.symbol}` },
      { text:'❌ LOSS', callback_data:`L_${sig.symbol}` },
      { text:'⏭ SKIP', callback_data:`K_${sig.symbol}` },
    ]]}
  }).catch(e => console.error('Signal send error:', e.message));
}

// ── Backtest ───────────────────────────────────────────────────
async function runBacktest() {
  await send(`🔬 <b>BACKTESTING top OTC pairs...</b>\n⏳ This takes ~2 minutes (rate-limit safe)`);
  const testPairs = OTC_PAIRS.slice(0, 3); // reduced to 3 pairs to save credits
  const results = [];

  for (const pair of testPairs) {
    try {
      await send(`⏳ Testing ${pair.symbol}...`);
      const d = await fetchHistoricalData(pair.symbol, tfInterval, 150);
      if (!d || d.closes.length < 50) continue;
      const r = backtest(d, pair, 80);
      if (r) results.push(r);
      // pricefetcher queue handles delay — no extra delay needed here
    } catch(e) { console.error('Backtest error:', e.message); }
  }

  if (!results.length) {
    return send(`📭 No backtest data available.\nAPI limit reached. Try again in 2 minutes.`);
  }

  results.sort((a,b) => b.winRate - a.winRate);
  let msg = `🔬 <b>BACKTEST RESULTS (${tfInterval})</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
  for (const r of results) {
    const g = r.winRate>=70?'🟢':r.winRate>=58?'🟡':'🔴';
    msg += `${g} <b>${r.pair}</b> [Grade: ${r.grade}]\n`;
    msg += `  ${r.total} signals | W:${r.wins} L:${r.losses} | WR:<b>${r.winRate}%</b>\n`;
    msg += `  P&L: ${r.pnl>=0?'+':''}$${r.pnl} | Avg Conf: ${r.avgConf}%\n\n`;
  }
  const best = results[0];
  msg += `🏆 <b>Best pair: ${best.pair}</b> (${best.winRate}% WR)\n<i>Focus on this pair this session</i>`;
  return send(msg);
}

// ── Auto scan — ONE pair per cycle, queue handles spacing ──────
async function autoScan() {
  if (isCB()) return;
  if (scanInProgress) return; // skip if manual scan happening

  for (const pair of OTC_PAIRS.slice(0, 3)) {
    try {
      const data = await fetchPriceData(pair.symbol, tfInterval);
      if (!data || !data.ltf) continue;
      const sig = analyzeSignal(data.ltf, pair, data.htf);
      if (sig && sig.confidence >= 60) {
        const session = getSession();
        const news    = newsCheck();
        const nw      = news.on ? `\n⚠️ NEWS: ${news.desc}` : '';
        S.total++;
        sig.direction==='CALL' ? S.calls++ : S.puts++;
        await sendSignal(sig, session, nw);
        return; // only 1 signal per auto cycle
      }
      // pricefetcher queue already waits 10s between calls — no extra delay needed
    } catch(e) { console.error('Auto scan error:', e.message); }
  }
  send(`📭 <b>Auto scan complete</b> — No clean setups found.\nRetrying in 15 min.`);
}

// ── Message handler ────────────────────────────────────────────
bot.on('message', async msg => {
  if (!auth(msg)) return;
  const t = (msg.text||'').trim();
  console.log('Message received:', t);

  try {
    if (t==='📋 OTC Pairs')  return bot.sendMessage(CHAT_ID, '⚠️ <b>Select OTC pair to scan:</b>', { parse_mode:'HTML', ...pairKeyboard(OTC_PAIRS) });
    if (t==='🌐 Live Pairs') return bot.sendMessage(CHAT_ID, '🌐 <b>Select LIVE pair to scan:</b>', { parse_mode:'HTML', ...pairKeyboard(LIVE_PAIRS) });
    if (t==='₿ Crypto')      return bot.sendMessage(CHAT_ID, '₿ <b>Select CRYPTO pair to scan:</b>', { parse_mode:'HTML', ...pairKeyboard(CRYPTO_PAIRS) });
    if (t==='🛢 Commodity')  return bot.sendMessage(CHAT_ID, '🛢 <b>Select COMMODITY pair to scan:</b>', { parse_mode:'HTML', ...pairKeyboard(COMM_PAIRS) });
    if (t==='📊 Stats')      return sendStats();
    if (t==='⚡ Status')     return sendStatus();
    if (t==='🔬 Backtest')   return runBacktest();
    if (t==='🏆 Best Pairs') return sendBestPairs();
    if (t==='🛡 Breaker')    return sendBreaker();
    if (t==='❓ Help' || t==='/start') return sendHelp();
    if (t==='🔁 Reset') {
      resetStats();
      return send(`🔁 <b>Session reset.</b>\nAll stats and pair history cleared.`, KB);
    }

    if (t==='🟢 Auto ON') {
      if (autoMode) return send(`⚡ Auto mode already running. Scanning every 15 min.`);
      autoMode = true;
      send(`🟢 <b>AUTO MODE ON</b>\nScanning top 3 OTC pairs every 15 min.\nCircuit breaker respected.`);
      autoScan();
      autoTimer = setInterval(autoScan, 15*60*1000);
      return;
    }

    if (t==='🔴 Auto OFF') {
      autoMode = false;
      if (autoTimer) { clearInterval(autoTimer); autoTimer=null; }
      return send(`🔴 <b>AUTO MODE OFF</b>`);
    }

    if (t==='⏱ Expiry') {
      return bot.sendMessage(CHAT_ID, '⏱ Select expiry:', { reply_markup:{ inline_keyboard:[[
        {text:'1 MIN',     callback_data:'TF_1min_1'},
        {text:'5 MIN',     callback_data:'TF_5min_5'},
        {text:'15 MIN ⭐', callback_data:'TF_15min_15'},
        {text:'30 MIN',    callback_data:'TF_30min_30'},
      ]]}});
    }

    if (t==='💵 Stake') {
      return bot.sendMessage(CHAT_ID, '💵 Select stake amount:', { reply_markup:{ inline_keyboard:[
        [{text:'$1',callback_data:'ST_1'},{text:'$5',callback_data:'ST_5'},{text:'$10',callback_data:'ST_10'},{text:'$15',callback_data:'ST_15'}],
        [{text:'$20',callback_data:'ST_20'},{text:'$25',callback_data:'ST_25'},{text:'$30',callback_data:'ST_30'},{text:'$50',callback_data:'ST_50'}],
      ]}});
    }

  } catch(e) {
    console.error('Handler error:', e.message);
    send(`⚠️ Error processing command. Please try again.`);
  }
});

// ── Callback handler ───────────────────────────────────────────
bot.on('callback_query', async q => {
  if (q.message.chat.id.toString() !== CHAT_ID.toString()) return;
  const d = q.data || '';

  try {
    await bot.answerCallbackQuery(q.id).catch(()=>{});

    if (d === 'BACK')       return bot.sendMessage(CHAT_ID, '🏠 Main menu', KB);
    if (d === 'CB_RESET')   { resetCB(); return send(`✅ <b>Circuit breaker reset.</b> Trade carefully.`); }
    if (d === 'CB_KEEP')    return;

    if (d.startsWith('SCAN_')) {
      const symbol = d.slice(5);
      const pair   = findPair(symbol);
      if (!pair) return send(`⚠️ Pair not found: ${symbol}`);
      return scanPair(pair);
    }

    if (d.startsWith('TF_')) {
      const parts = d.split('_');
      tfInterval = parts[1]; expiry = parseInt(parts[2]);
      return send(`⏱ Expiry set to <b>${expiry} MIN</b> (${tfInterval} candles)`);
    }

    if (d.startsWith('ST_')) {
      stake = parseFloat(d.split('_')[1]);
      return send(`💵 Stake set to <b>$${stake}</b>\nPotential win: +$${(stake*0.92).toFixed(2)} at 92% payout`);
    }

    const act = d.slice(0,1);
    const sym = d.slice(2);
    const ps  = getPairStat(sym);

    if (act==='W') {
      S.wins++; consLoss=0; S.pnl += stake * 0.92; ps.wins++;
      const wr = pct(S.wins, S.losses);
      send(`✅ <b>WIN</b> — ${sym}\n📊 Session: ${S.wins}W/${S.losses}L (${wr}% WR)\n💰 P&L: +$${S.pnl.toFixed(2)}\n📌 ${sym}: ${ps.wins}W/${ps.losses}L`);
    } else if (act==='L') {
      S.losses++; consLoss++; S.pnl -= stake; ps.losses++;
      const wr = pct(S.wins, S.losses);
      send(`❌ <b>LOSS</b> — ${sym}\n📊 Session: ${S.wins}W/${S.losses}L (${wr}% WR)\n💰 P&L: $${S.pnl.toFixed(2)}\n🔴 Consecutive losses: ${consLoss}`);
      if (consLoss >= 3) {
        setCB();
        send(`🛑 <b>CIRCUIT BREAKER TRIGGERED</b>\n3 consecutive losses.\n\n<b>STOP TRADING NOW.</b>\nProtect your capital.\n\nAuto-resets in 2 hours.\nTap 🛡 Breaker to override.`);
      }
    } else if (act==='K') {
      S.skipped++; ps.skipped++;
    }

  } catch(e) {
    console.error('Callback error:', e.message);
  }
});

// ── Info functions ─────────────────────────────────────────────
function sendStats() {
  const t  = S.wins + S.losses;
  const wr = pct(S.wins, S.losses);
  const grade = wr>=70?'🟢 A':wr>=60?'🟡 B':wr>=50?'🟠 C':'🔴 D';
  return send(
    `📊 <b>SESSION STATISTICS</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
    `📈 Signals: ${S.total} | 🟢 CALL:${S.calls} | 🔴 PUT:${S.puts}\n` +
    `✅ Wins: ${S.wins} | ❌ Losses: ${S.losses} | ⏭ Skip: ${S.skipped}\n` +
    `🏆 Win Rate: ${wr}% ${grade}\n` +
    `💰 P&L: ${S.pnl>=0?'+':''}$${S.pnl.toFixed(2)}\n` +
    `🔴 Consecutive losses: ${consLoss}\n` +
    `🛡 Circuit Breaker: ${isCB()?'🛑 ACTIVE':'✅ Clear'}\n` +
    `⏱ Expiry: ${expiry} MIN | 💵 Stake: $${stake}`
  );
}

function sendStatus() {
  const s = getSession();
  const n = newsCheck();
  return send(
    `⚡ <b>BOT STATUS v7.1</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
    `🤖 Online: ✅\n` +
    `🔄 Auto Mode: ${autoMode?'🟢 ON':'🔴 OFF'}\n` +
    `⏱ Expiry: ${expiry} MIN | TF: ${tfInterval}\n` +
    `💵 Stake: $${stake}\n` +
    `📅 Session: ${s.name} ${s.active?'✅':'⚠️'}\n` +
    `🚫 News: ${n.on?`⚠️ ${n.desc}`:'✅ Clear'}\n` +
    `🛡 Breaker: ${isCB()?'🛑 ACTIVE':'✅ Clear'}\n` +
    `⏰ GMT+6: ${gmt6()}`
  );
}

function sendBestPairs() {
  const entries = Object.entries(pairStats)
    .filter(([,v]) => v.wins+v.losses > 0)
    .map(([sym,v]) => ({ sym, wr:pct(v.wins,v.losses), ...v }))
    .sort((a,b) => b.wr-a.wr);

  if (!entries.length) return send(`🏆 <b>No pair history yet.</b>\nStart trading to build your pair stats.`);

  let msg = `🏆 <b>YOUR BEST PAIRS THIS SESSION</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
  for (const e of entries.slice(0,8)) {
    const g = e.wr>=70?'🟢':e.wr>=55?'🟡':'🔴';
    msg += `${g} <b>${e.sym}</b>: ${e.wins}W/${e.losses}L — ${e.wr}% WR\n`;
  }
  return send(msg);
}

function sendBreaker() {
  if (!isCB()) return send(`🛡 <b>Circuit Breaker: CLEAR</b>\nTrading is active. No losses streak.`);
  const remaining = Math.ceil((2*60*60*1000-(Date.now()-cbAt))/60000);
  return bot.sendMessage(CHAT_ID,
    `🛑 <b>CIRCUIT BREAKER ACTIVE</b>\nAuto-resets in ${remaining} min.\n\nOverride and resume trading?`,
    { parse_mode:'HTML', reply_markup:{ inline_keyboard:[[
      { text:'✅ Yes, resume trading', callback_data:'CB_RESET' },
      { text:'❌ No, keep paused',     callback_data:'CB_KEEP'  },
    ]]}}
  );
}

function sendHelp() {
  return send(
    `🎯 <b>OMNI BULLS EYE v7.1</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>How to use:</b>\n` +
    `1. Tap a category (OTC/Live/Crypto/Commodity)\n` +
    `2. Select your pair from the list\n` +
    `3. Bot scans and returns CALL/PUT/NO SETUP\n` +
    `4. Verify payout on Pocket Option\n` +
    `5. Enter trade, then tap WIN/LOSS/SKIP\n\n` +
    `<b>🛡 Protections:</b>\n` +
    `✅ Circuit breaker — stops after 3 losses\n` +
    `✅ News alerts — warns but never blocks\n` +
    `✅ Per-pair tracking — know your best pairs\n` +
    `✅ Auto reset — breaker clears after 2hrs\n` +
    `✅ Rate-limit safe — 1 API call per scan\n\n` +
    `<b>📊 Pairs coverage:</b>\n` +
    `⚠️ 12 OTC pairs (92%+ payout priority)\n` +
    `🌐 8 Live forex pairs\n` +
    `₿ 4 Crypto OTC\n` +
    `🛢 2 Commodity OTC\n\n` +
    `<b>⏱ Recommended settings:</b>\n` +
    `Expiry: 15 MIN | Stake: 2-3% of balance`,
    KB
  );
}

// ── Boot ───────────────────────────────────────────────────────
setTimeout(() => {
  send(
    `🚀 <b>OMNI BULLS EYE v7.1 — ONLINE</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `✅ Rate-limit safe (1 call per scan)\n` +
    `✅ Scan lock — no overlapping requests\n` +
    `✅ Auto circuit breaker reset: 2hrs\n` +
    `✅ Per-pair win tracking active\n` +
    `✅ News alerts active\n\n` +
    `<b>Tap 📋 OTC Pairs to start your first scan</b>`,
    KB
  );
  console.log('Boot message sent');
}, 3000);

console.log('=== Bot setup complete, waiting for messages ===');
