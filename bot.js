// ═══════════════════════════════════════════════════════════════
// OMNI BULLS EYE v7.2 — HTML-Free Build (fixes Telegram error)
// ═══════════════════════════════════════════════════════════════

const TelegramBot = require('node-telegram-bot-api');
const { fetchPriceData, fetchHistoricalData } = require('./pricefetcher');
const { analyzeSignal, backtest } = require('./analyzer');

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

console.log('=== OMNI BOT v7.2 STARTING ===');
console.log('Token exists:', !!TOKEN);
console.log('ChatID exists:', !!CHAT_ID);

if (!TOKEN || !CHAT_ID) { console.error('FATAL: Missing TOKEN or CHAT_ID'); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });
console.log('Bot polling started');

// ── State ──────────────────────────────────────────────────────
let autoMode = false, autoTimer = null;
let expiry = 15, tfInterval = '15min', stake = 5;
let scanInProgress = false;

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

// ── Sessions GMT+6 ─────────────────────────────────────────────
const SESSIONS = [
  { name:'London/NY Overlap', s:19*60,    e:21*60+30, d:[1,2,3,4,5] },
  { name:'London Open',       s:14*60,    e:16*60,    d:[1,2,3,4,5] },
  { name:'Late NY/OTC',       s:22*60+30, e:24*60,    d:[1,2,3,4,5] },
  { name:'Asian OTC',         s:5*60,     e:7*60,     d:[2,3,4,5]   },
  { name:'Morning OTC',       s:9*60,     e:11*60,    d:[3,4,5,6]   },
  { name:'Weekend OTC',       s:11*60,    e:13*60,    d:[0,6]       },
];

function getSession() {
  const t = new Date(Date.now() + 6*3600*1000);
  const d = t.getUTCDay(), m = t.getUTCHours()*60 + t.getUTCMinutes();
  for (const s of SESSIONS) {
    if (s.d.includes(d) && m >= s.s && m < s.e) return { active:true, ...s };
  }
  return { active:false, name:'Outside Prime Hours' };
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

// NO parse_mode — plain text only, zero HTML errors ever
const send    = (txt, opts={}) => bot.sendMessage(CHAT_ID, txt, opts).catch(e => console.error('Send error:', e.message));
const delay   = ms => new Promise(r => setTimeout(r, ms));
const gmt6    = () => new Date(Date.now()+6*3600000).toISOString().slice(11,16);
const confBar = p => '█'.repeat(Math.round(p/10)) + '░'.repeat(10-Math.round(p/10));
const pct     = (w,l) => w+l>0 ? Math.round(w/(w+l)*100) : 0;

// Strip ALL special characters that could break Telegram
const clean = v => String(v||'?').replace(/[<>&"']/g,'').trim();

// ── Keyboards ──────────────────────────────────────────────────
const KB = { reply_markup:{ keyboard:[
  [{text:'📋 OTC Pairs'},{text:'🌐 Live Pairs'},{text:'₿ Crypto'}],
  [{text:'🛢 Commodity'},{text:'📊 Stats'},     {text:'⚡ Status'}],
  [{text:'🟢 Auto ON'}, {text:'🔴 Auto OFF'},   {text:'🔬 Backtest'}],
  [{text:'⏱ Expiry'},  {text:'💵 Stake'},       {text:'🏆 Best Pairs'}],
  [{text:'🔁 Reset'},   {text:'❓ Help'},        {text:'🛡 Breaker'}],
], resize_keyboard:true }};

function pairKeyboard(pairs) {
  const rows = [];
  for (let i = 0; i < pairs.length; i += 3) {
    rows.push(pairs.slice(i,i+3).map(p => ({
      text: p.symbol,
      callback_data: `SCAN_${p.symbol}`
    })));
  }
  rows.push([{ text:'🔙 Back', callback_data:'BACK' }]);
  return { reply_markup:{ inline_keyboard: rows }};
}

// ── Core scan ──────────────────────────────────────────────────
async function scanPair(pair) {
  if (isCB()) {
    const rem = Math.ceil((2*60*60*1000-(Date.now()-cbAt))/60000);
    return send(`🛑 CIRCUIT BREAKER ACTIVE\n3 consecutive losses — paused.\nAuto-resets in ${rem} min.\n\nTap Breaker to override.`);
  }

  if (scanInProgress) {
    return send(`⏳ Scan in progress...\nPlease wait for current scan to complete.`);
  }

  scanInProgress = true;
  const session  = getSession();
  const news     = newsCheck();
  const newsWarn = news.on ? `\n⚠️ NEWS ALERT: ${news.desc} — trade carefully` : '';
  const sessInfo = session.active ? `📅 ${session.name}` : `📅 Outside prime hours — OTC pairs recommended`;

  await send(`🔍 Scanning ${pair.symbol}...\n${sessInfo}${newsWarn}`);

  let data = null;
  try {
    data = await fetchPriceData(pair.symbol, tfInterval);
  } catch(e) {
    console.error(`Fetch failed for ${pair.symbol}:`, e.message);
  } finally {
    scanInProgress = false;
  }

  if (!data || !data.ltf) {
    return send(
      `📡 No data for ${pair.symbol}\n\n` +
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
      `📭 NO SETUP — ${pair.symbol}\n\n` +
      `${sessInfo}\n` +
      `Payout: ${pair.payout}% | TF: ${tfInterval}\n\n` +
      `Indicators not aligned for a clean entry.\n` +
      `⏳ Try again in 10-15 min or pick another pair.\n\n` +
      `Your record on this pair: ${ps.wins}W / ${ps.losses}L`
    );
  }

  S.total++;
  sig.direction==='CALL' ? S.calls++ : S.puts++;
  await sendSignal(sig, session, newsWarn);
}

// ── Signal card — PLAIN TEXT ONLY, zero HTML ───────────────────
async function sendSignal(sig, session, newsWarn='') {
  const de   = sig.direction==='CALL' ? '🟢 CALL ⬆️' : '🔴 PUT ⬇️';
  const tier = sig.payout>=92 ? '💎' : sig.payout>=88 ? '🥇' : '🥈';
  const live = sig.cat==='LIVE' ? ' ⭐LIVE' : '';
  const div  = sig.divergence && sig.divergence!=='NONE'
    ? `\n🔥 DIVERGENCE: ${clean(sig.divergence)}` : '';
  const ps   = getPairStat(sig.symbol);
  const wr   = pct(ps.wins, ps.losses);

  const reasonLines = (sig.reasons||[]).slice(0,5)
    .map(r => `  • ${clean(r)}`).join('\n');
  const warnLines = (sig.warnings||[]).length
    ? '\n\n⚠️ Caution:\n' + (sig.warnings||[]).slice(0,2).map(w=>`  • ${clean(w)}`).join('\n')
    : '';

  const msg =
    `${de}${live} ${tier}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📊 ${clean(sig.symbol)}\n` +
    `💰 Payout: +${sig.payout}%  ⏱ Expiry: ${expiry}MIN\n` +
    `🎯 Confidence: ${sig.confidence}%\n` +
    `[${confBar(sig.confidence)}]\n\n` +
    `📈 RSI: ${clean(sig.rsi)}  Stoch: ${clean(sig.stochK)}\n` +
    `MACD: ${clean(sig.macd)}  ADX: ${clean(sig.adx)}\n` +
    `HTF Bias: ${clean(sig.htfBias)}${div}\n\n` +
    `✅ Confluence (${clean(sig.indicators)}):\n` +
    reasonLines +
    warnLines +
    `\n\n📅 ${clean(session.name||'OTC Session')}` +
    `${newsWarn}\n` +
    `💵 Stake: $${stake} -> Win: +$${(stake*sig.payout/100).toFixed(2)} | Loss: -$${stake}\n` +
    `📌 Record: ${ps.wins}W/${ps.losses}L${ps.wins+ps.losses>0?` (${wr}% WR)`:''}\n\n` +
    `⚠️ Verify payout on Pocket Option before entering`;

  await bot.sendMessage(CHAT_ID, msg, {
    reply_markup:{ inline_keyboard:[[
      { text:'✅ WIN',  callback_data:`W_${sig.symbol}` },
      { text:'❌ LOSS', callback_data:`L_${sig.symbol}` },
      { text:'⏭ SKIP', callback_data:`K_${sig.symbol}` },
    ]]}
  }).catch(e => console.error('Signal send error:', e.message));
}

// ── Backtest ───────────────────────────────────────────────────
async function runBacktest() {
  await send(`🔬 BACKTESTING top OTC pairs...\n⏳ This takes 2-3 minutes`);
  const results = [];
  for (const pair of OTC_PAIRS.slice(0,3)) {
    try {
      await send(`⏳ Testing ${pair.symbol}...`);
      const d = await fetchHistoricalData(pair.symbol, tfInterval, 150);
      if (!d || d.closes.length < 50) continue;
      const r = backtest(d, pair, 80);
      if (r) results.push(r);
    } catch(e) { console.error('Backtest error:', e.message); }
  }
  if (!results.length) return send(`📭 No backtest data. API limit reached. Try in 2 minutes.`);
  results.sort((a,b) => b.winRate - a.winRate);
  let msg = `🔬 BACKTEST RESULTS (${tfInterval})\n━━━━━━━━━━━━━━━━━━━━\n`;
  for (const r of results) {
    const g = r.winRate>=70?'🟢':r.winRate>=58?'🟡':'🔴';
    msg += `${g} ${r.pair} [Grade: ${r.grade}]\n`;
    msg += `  ${r.total} signals | W:${r.wins} L:${r.losses} | WR: ${r.winRate}%\n`;
    msg += `  P&L: ${r.pnl>=0?'+':''}$${r.pnl} | Avg Conf: ${r.avgConf}%\n\n`;
  }
  msg += `🏆 Best: ${results[0].pair} (${results[0].winRate}% WR)`;
  return send(msg);
}

// ── Auto scan ──────────────────────────────────────────────────
async function autoScan() {
  if (isCB() || scanInProgress) return;
  for (const pair of OTC_PAIRS.slice(0,3)) {
    try {
      const data = await fetchPriceData(pair.symbol, tfInterval);
      if (!data || !data.ltf) continue;
      const sig = analyzeSignal(data.ltf, pair, data.htf);
      if (sig && sig.confidence >= 60) {
        S.total++;
        sig.direction==='CALL' ? S.calls++ : S.puts++;
        await sendSignal(sig, getSession(), newsCheck().on ? `\n⚠️ NEWS: ${newsCheck().desc}` : '');
        return;
      }
    } catch(e) { console.error('Auto scan error:', e.message); }
  }
  send(`📭 Auto scan — No clean setups found. Retrying in 15 min.`);
}

// ── Message handler ────────────────────────────────────────────
bot.on('message', async msg => {
  if (!auth(msg)) return;
  const t = (msg.text||'').trim();
  console.log('Message received:', t);
  try {
    if (t==='📋 OTC Pairs')  return bot.sendMessage(CHAT_ID, '⚠️ Select OTC pair to scan:', pairKeyboard(OTC_PAIRS));
    if (t==='🌐 Live Pairs') return bot.sendMessage(CHAT_ID, '🌐 Select LIVE pair to scan:', pairKeyboard(LIVE_PAIRS));
    if (t==='₿ Crypto')      return bot.sendMessage(CHAT_ID, '₿ Select CRYPTO pair to scan:', pairKeyboard(CRYPTO_PAIRS));
    if (t==='🛢 Commodity')  return bot.sendMessage(CHAT_ID, '🛢 Select COMMODITY pair to scan:', pairKeyboard(COMM_PAIRS));
    if (t==='📊 Stats')      return sendStats();
    if (t==='⚡ Status')     return sendStatus();
    if (t==='🔬 Backtest')   return runBacktest();
    if (t==='🏆 Best Pairs') return sendBestPairs();
    if (t==='🛡 Breaker')    return sendBreaker();
    if (t==='❓ Help' || t==='/start') return sendHelp();
    if (t==='🔁 Reset') { resetStats(); return send(`🔁 Session reset. All stats cleared.`, KB); }

    if (t==='🟢 Auto ON') {
      if (autoMode) return send(`⚡ Auto mode already running.`);
      autoMode = true;
      send(`🟢 AUTO MODE ON\nScanning top 3 OTC pairs every 15 min.`);
      autoScan();
      autoTimer = setInterval(autoScan, 15*60*1000);
      return;
    }
    if (t==='🔴 Auto OFF') {
      autoMode = false;
      if (autoTimer) { clearInterval(autoTimer); autoTimer=null; }
      return send(`🔴 AUTO MODE OFF`);
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
      return bot.sendMessage(CHAT_ID, '💵 Select stake:', { reply_markup:{ inline_keyboard:[
        [{text:'$1',callback_data:'ST_1'},{text:'$5',callback_data:'ST_5'},{text:'$10',callback_data:'ST_10'},{text:'$15',callback_data:'ST_15'}],
        [{text:'$20',callback_data:'ST_20'},{text:'$25',callback_data:'ST_25'},{text:'$30',callback_data:'ST_30'},{text:'$50',callback_data:'ST_50'}],
      ]}});
    }
  } catch(e) {
    console.error('Handler error:', e.message);
    send(`⚠️ Error processing command. Try again.`);
  }
});

// ── Callback handler ───────────────────────────────────────────
bot.on('callback_query', async q => {
  if (q.message.chat.id.toString() !== CHAT_ID.toString()) return;
  const d = q.data||'';
  try {
    await bot.answerCallbackQuery(q.id).catch(()=>{});
    if (d==='BACK')     return bot.sendMessage(CHAT_ID, '🏠 Main menu', KB);
    if (d==='CB_RESET') { resetCB(); return send(`✅ Circuit breaker reset. Trade carefully.`); }
    if (d==='CB_KEEP')  return;

    if (d.startsWith('SCAN_')) {
      const pair = findPair(d.slice(5));
      if (!pair) return send(`⚠️ Pair not found.`);
      return scanPair(pair);
    }
    if (d.startsWith('TF_')) {
      const p = d.split('_'); tfInterval=p[1]; expiry=parseInt(p[2]);
      return send(`⏱ Expiry set to ${expiry} MIN (${tfInterval} candles)`);
    }
    if (d.startsWith('ST_')) {
      stake = parseFloat(d.split('_')[1]);
      return send(`💵 Stake set to $${stake}\nPotential win: +$${(stake*0.92).toFixed(2)} at 92% payout`);
    }

    const act=d.slice(0,1), sym=d.slice(2), ps=getPairStat(sym);
    if (act==='W') {
      S.wins++; consLoss=0; S.pnl+=stake*0.92; ps.wins++;
      send(`✅ WIN — ${sym}\nSession: ${S.wins}W/${S.losses}L (${pct(S.wins,S.losses)}% WR)\nP&L: +$${S.pnl.toFixed(2)}\n${sym}: ${ps.wins}W/${ps.losses}L`);
    } else if (act==='L') {
      S.losses++; consLoss++; S.pnl-=stake; ps.losses++;
      send(`❌ LOSS — ${sym}\nSession: ${S.wins}W/${S.losses}L (${pct(S.wins,S.losses)}% WR)\nP&L: $${S.pnl.toFixed(2)}\nConsecutive losses: ${consLoss}`);
      if (consLoss>=3) { setCB(); send(`🛑 CIRCUIT BREAKER TRIGGERED\n3 consecutive losses.\n\nSTOP TRADING NOW.\nProtect your capital.\n\nAuto-resets in 2 hours.\nTap Breaker to override.`); }
    } else if (act==='K') { S.skipped++; ps.skipped++; }
  } catch(e) { console.error('Callback error:', e.message); }
});

// ── Info functions ─────────────────────────────────────────────
function sendStats() {
  const wr = pct(S.wins,S.losses);
  const grade = wr>=70?'A':wr>=60?'B':wr>=50?'C':'D';
  return send(
    `📊 SESSION STATISTICS\n━━━━━━━━━━━━━━━━━━━━\n` +
    `Signals: ${S.total} | CALL:${S.calls} | PUT:${S.puts}\n` +
    `Wins: ${S.wins} | Losses: ${S.losses} | Skipped: ${S.skipped}\n` +
    `Win Rate: ${wr}% [Grade: ${grade}]\n` +
    `P&L: ${S.pnl>=0?'+':''}$${S.pnl.toFixed(2)}\n` +
    `Consecutive losses: ${consLoss}\n` +
    `Circuit Breaker: ${isCB()?'ACTIVE':'Clear'}\n` +
    `Expiry: ${expiry} MIN | Stake: $${stake}`
  );
}

function sendStatus() {
  const s=getSession(), n=newsCheck();
  return send(
    `⚡ BOT STATUS v7.2\n━━━━━━━━━━━━━━━━━━━━\n` +
    `Online: ✅\n` +
    `Auto Mode: ${autoMode?'ON':'OFF'}\n` +
    `Expiry: ${expiry} MIN | TF: ${tfInterval}\n` +
    `Stake: $${stake}\n` +
    `Session: ${s.name} ${s.active?'✅':'⚠️'}\n` +
    `News: ${n.on?`⚠️ ${n.desc}`:'Clear'}\n` +
    `Breaker: ${isCB()?'ACTIVE':'Clear'}\n` +
    `GMT+6: ${gmt6()}`
  );
}

function sendBestPairs() {
  const entries = Object.entries(pairStats)
    .filter(([,v])=>v.wins+v.losses>0)
    .map(([sym,v])=>({sym,wr:pct(v.wins,v.losses),...v}))
    .sort((a,b)=>b.wr-a.wr);
  if (!entries.length) return send(`🏆 No pair history yet.\nStart trading to build your pair stats.`);
  let msg = `🏆 YOUR BEST PAIRS THIS SESSION\n━━━━━━━━━━━━━━━━━━━━\n`;
  for (const e of entries.slice(0,8)) {
    const g = e.wr>=70?'🟢':e.wr>=55?'🟡':'🔴';
    msg += `${g} ${e.sym}: ${e.wins}W/${e.losses}L — ${e.wr}% WR\n`;
  }
  return send(msg);
}

function sendBreaker() {
  if (!isCB()) return send(`🛡 Circuit Breaker: CLEAR\nTrading is active.`);
  const rem = Math.ceil((2*60*60*1000-(Date.now()-cbAt))/60000);
  return bot.sendMessage(CHAT_ID,
    `🛑 CIRCUIT BREAKER ACTIVE\nAuto-resets in ${rem} min.\n\nOverride and resume trading?`,
    { reply_markup:{ inline_keyboard:[[
      { text:'✅ Yes, resume', callback_data:'CB_RESET' },
      { text:'❌ Keep paused', callback_data:'CB_KEEP'  },
    ]]}}
  );
}

function sendHelp() {
  return send(
    `🎯 OMNI BULLS EYE v7.2\n━━━━━━━━━━━━━━━━━━━━\n\n` +
    `How to use:\n` +
    `1. Tap a category (OTC/Live/Crypto/Commodity)\n` +
    `2. Select your pair\n` +
    `3. Bot returns CALL / PUT / NO SETUP\n` +
    `4. Verify payout on Pocket Option\n` +
    `5. Enter trade then tap WIN/LOSS/SKIP\n\n` +
    `Protections:\n` +
    `- Circuit breaker after 3 losses\n` +
    `- News alerts\n` +
    `- Per-pair tracking\n` +
    `- Auto breaker reset: 2 hours\n\n` +
    `Pairs: 12 OTC | 8 Live | 4 Crypto | 2 Commodity\n\n` +
    `Recommended: Expiry 15MIN | Stake 2-3% of balance`,
    KB
  );
}

// ── Boot ───────────────────────────────────────────────────────
setTimeout(() => {
  send(
    `🚀 OMNI BULLS EYE v7.2 — ONLINE\n━━━━━━━━━━━━━━━━━━━━\n` +
    `✅ HTML-free build — zero parse errors\n` +
    `✅ Rate-limit safe\n` +
    `✅ Scan lock active\n` +
    `✅ Circuit breaker active\n` +
    `✅ Analyzer v4.1 loaded\n\n` +
    `Tap OTC Pairs to start your first scan`,
    KB
  );
  console.log('Boot message sent');
}, 3000);

console.log('=== Bot setup complete, waiting for messages ===');
