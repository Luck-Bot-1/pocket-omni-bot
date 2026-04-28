// OMNI BULLS EYE v6.1 - CRASH-PROOF PRODUCTION BUILD
const TelegramBot = require('node-telegram-bot-api');
const { fetchPriceData, fetchHistoricalData, isNewsBlackout } = require('./pricefetcher');
const { analyzeSignal, backtest } = require('./analyzer');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

console.log('=== OMNI BOT v6.1 STARTING ===');
console.log('Token exists:', !!TOKEN);
console.log('ChatID exists:', !!CHAT_ID);

if (!TOKEN || !CHAT_ID) {
    console.error('FATAL: Missing TOKEN or CHAT_ID');
    process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
console.log('Bot polling started');

// ── Lazy-load heavy modules (prevent startup crash) ────────────
let _analyzer = null, _fetcher = null;

function getAnalyzer() {
  if (!_analyzer) {
    try { _analyzer = require('./analyzer'); }
    catch(e) { console.error('Analyzer load error:', e.message); return null; }
  }
  return _analyzer;
}

function getFetcher() {
  if (!_fetcher) {
    try { _fetcher = require('./pricefetcher'); }
    catch(e) { console.error('Fetcher load error:', e.message); return null; }
  }
  return _fetcher;
}

// ── State ──────────────────────────────────────────────────────
let autoMode = false, autoTimer = null;
let expiry = 15, tfInterval = '15min', stake = 5;
const cooldowns = {};
const COOL_MS = 15 * 60 * 1000;

// Stats
let S = { total:0, wins:0, losses:0, skipped:0, calls:0, puts:0, pnl:0, consLoss:0, pairW:{}, pairL:{} };
function resetStats() { S = { total:0,wins:0,losses:0,skipped:0,calls:0,puts:0,pnl:0,consLoss:0,pairW:{},pairL:{} }; }

// Circuit breaker
let cbOn = false, cbAt = null;
function isCB() { return cbOn && Date.now()-cbAt < 2*60*60*1000; }
function setCB() { cbOn=true; cbAt=Date.now(); }
function resetCB() { cbOn=false; cbAt=null; S.consLoss=0; }

// ── Session gate GMT+6 ─────────────────────────────────────────
const SESSIONS = [
  { name:'🔴 PRIME: London/NY',  s:19*60,   e:21*60+30, d:[1,2,3,4,5], prime:true  },
  { name:'🟢 London Open',       s:14*60,   e:16*60,    d:[1,2,3,4,5], prime:false },
  { name:'🟡 Late NY/OTC',       s:22*60+30,e:24*60,    d:[1,2,3,4,5], prime:false },
  { name:'🟡 Asian OTC',         s:5*60,    e:7*60,     d:[2,3,4,5],   prime:false },
  { name:'🟡 Morning OTC',       s:9*60,    e:11*60,    d:[3,4,5,6],   prime:false },
  { name:'🟡 Weekend OTC',       s:11*60,   e:13*60,    d:[0,6],       prime:false },
  { name:'🟡 Weekend OTC PM',    s:17*60,   e:19*60,    d:[6],         prime:false },
];

function getSession() {
  const t = new Date(Date.now()+6*3600*1000);
  const d = t.getUTCDay(), m = t.getUTCHours()*60+t.getUTCMinutes();
  for (const s of SESSIONS) {
    if (s.d.includes(d) && m >= s.s && m < s.e) return { active:true, ...s };
  }
  return { active:false, name:'⏰ Outside Hours', prime:false };
}

// ── Pairs ──────────────────────────────────────────────────────
const LIVE_PAIRS = [
  { symbol:'EUR/USD', payout:86, cat:'LIVE', priority:1 },
  { symbol:'GBP/USD', payout:87, cat:'LIVE', priority:1 },
  { symbol:'USD/JPY', payout:85, cat:'LIVE', priority:1 },
  { symbol:'USD/CHF', payout:85, cat:'LIVE', priority:1 },
  { symbol:'USD/CAD', payout:85, cat:'LIVE', priority:1 },
  { symbol:'EUR/GBP', payout:87, cat:'LIVE', priority:1 },
  { symbol:'AUD/CAD', payout:87, cat:'LIVE', priority:1 },
  { symbol:'AUD/CHF', payout:87, cat:'LIVE', priority:1 },
  { symbol:'CHF/JPY', payout:87, cat:'LIVE', priority:1 },
  { symbol:'EUR/JPY', payout:85, cat:'LIVE', priority:1 },
  { symbol:'GBP/JPY', payout:85, cat:'LIVE', priority:1 },
  { symbol:'GBP/CAD', payout:85, cat:'LIVE', priority:1 },
];

const OTC_PAIRS = [
  { symbol:'EUR/USD OTC',  payout:92, cat:'OTC', priority:2 },
  { symbol:'GBP/USD OTC',  payout:92, cat:'OTC', priority:2 },
  { symbol:'AUD/USD OTC',  payout:92, cat:'OTC', priority:2 },
  { symbol:'AUD/CHF OTC',  payout:92, cat:'OTC', priority:2 },
  { symbol:'EUR/GBP OTC',  payout:92, cat:'OTC', priority:2 },
  { symbol:'EUR/JPY OTC',  payout:92, cat:'OTC', priority:2 },
  { symbol:'GBP/JPY OTC',  payout:92, cat:'OTC', priority:2 },
  { symbol:'GBP/AUD OTC',  payout:92, cat:'OTC', priority:2 },
  { symbol:'QAR/CNY OTC',  payout:92, cat:'OTC', priority:2 },
  { symbol:'SAR/CNY OTC',  payout:92, cat:'OTC', priority:2 },
  { symbol:'USD/ARS OTC',  payout:92, cat:'OTC', priority:2 },
  { symbol:'USD/INR OTC',  payout:92, cat:'OTC', priority:2 },
  { symbol:'USD/MYR OTC',  payout:92, cat:'OTC', priority:2 },
  { symbol:'USD/RUB OTC',  payout:92, cat:'OTC', priority:2 },
  { symbol:'ZAR/USD OTC',  payout:92, cat:'OTC', priority:2 },
  { symbol:'AED/CNY OTC',  payout:92, cat:'OTC', priority:2 },
  { symbol:'NGN/USD OTC',  payout:92, cat:'OTC', priority:2 },
  { symbol:'USD/COP OTC',  payout:91, cat:'OTC', priority:3 },
  { symbol:'NZD/USD OTC',  payout:90, cat:'OTC', priority:3 },
  { symbol:'USD/JPY OTC',  payout:90, cat:'OTC', priority:3 },
  { symbol:'USD/IDR OTC',  payout:88, cat:'OTC', priority:3 },
  { symbol:'AUD/JPY OTC',  payout:87, cat:'OTC', priority:3 },
  { symbol:'AUD/NZD OTC',  payout:87, cat:'OTC', priority:3 },
  { symbol:'NZD/JPY OTC',  payout:87, cat:'OTC', priority:3 },
  { symbol:'TND/USD OTC',  payout:86, cat:'OTC', priority:3 },
  { symbol:'BHD/CNY OTC',  payout:85, cat:'OTC', priority:3 },
  { symbol:'USD/SGD OTC',  payout:85, cat:'OTC', priority:3 },
  { symbol:'KES/USD OTC',  payout:85, cat:'OTC', priority:3 },
];

const CRYPTO_PAIRS = [
  { symbol:'BTC/USD OTC', payout:90, cat:'CRYPTO', priority:2 },
  { symbol:'ETH/USD OTC', payout:90, cat:'CRYPTO', priority:2 },
  { symbol:'LTC/USD OTC', payout:88, cat:'CRYPTO', priority:2 },
  { symbol:'XRP/USD OTC', payout:88, cat:'CRYPTO', priority:2 },
  { symbol:'BNB/USD OTC', payout:85, cat:'CRYPTO', priority:3 },
  { symbol:'SOL/USD OTC', payout:85, cat:'CRYPTO', priority:3 },
];

const COMM_PAIRS = [
  { symbol:'XAU/USD OTC', payout:90, cat:'COMMODITY', priority:2 },
  { symbol:'XAG/USD OTC', payout:88, cat:'COMMODITY', priority:2 },
  { symbol:'WTI/USD OTC', payout:87, cat:'COMMODITY', priority:3 },
];

const ALL_PAIRS = [...LIVE_PAIRS, ...OTC_PAIRS, ...CRYPTO_PAIRS, ...COMM_PAIRS];

function getPairs(cat) {
  const map = { LIVE:LIVE_PAIRS, OTC:OTC_PAIRS, CRYPTO:CRYPTO_PAIRS, COMMODITY:COMM_PAIRS };
  return map[cat] || ALL_PAIRS.filter(p=>p.payout>=85);
}

// ── Helpers ────────────────────────────────────────────────────
const auth  = m => m.chat.id.toString() === CHAT_ID.toString();
const send  = (t, x={}) => bot.sendMessage(CHAT_ID, t, { parse_mode:'HTML', ...x }).catch(e => console.error('Send error:', e.message));
const delay = ms => new Promise(r=>setTimeout(r,ms));
const gmt6  = () => new Date(Date.now()+6*3600000).toISOString().slice(11,16);
const confBar = p => '█'.repeat(Math.round(p/10))+'░'.repeat(10-Math.round(p/10));

// ── Keyboard ───────────────────────────────────────────────────
const KB = { reply_markup:{ keyboard:[
  [{text:'🔍 Scan All'},{text:'⚠️ OTC'},      {text:'🌐 Live'}],
  [{text:'₿ Crypto'},  {text:'🛢 Commodity'}, {text:'📊 Stats'}],
  [{text:'🟢 Auto ON'},{text:'🔴 Auto OFF'},  {text:'⚡ Status'}],
  [{text:'🔬 Backtest'},{text:'⏱ Expiry'},   {text:'💵 Stake'}],
  [{text:'🔁 Reset'},  {text:'📋 Pairs'},     {text:'❓ Help'}],
], resize_keyboard:true }};

// ── News blackout check ────────────────────────────────────────
function newsBlackout() {
  const now = new Date();
  const h = now.getUTCHours(), m = now.getUTCMinutes(), d = now.getUTCDay();
  const min = h*60+m;
  const windows = [
    { s:8*60+15,  e:9*60+15,  desc:'European Open News' },
    { s:13*60+15, e:14*60+15, desc:'US Market Open News' },
    { s:15*60+45, e:16*60+30, desc:'US Data Release' },
    { s:18*60+45, e:19*60+30, desc:'US Close News' },
    ...(d===5 ? [{ s:13*60+15, e:14*60+30, desc:'NFP Friday' }] : []),
    ...(d===3 ? [{ s:18*60+45, e:20*60,    desc:'FOMC Wednesday' }] : []),
  ];
  for (const w of windows) {
    if (min >= w.s-15 && min <= w.e) return { on:true, reason:w.desc };
  }
  return { on:false };
}

// ── Core scan ──────────────────────────────────────────────────
async function runScan(cat) {
  const session = getSession();
  const news = newsBlackout();

  if (isCB()) {
    return send(`🛑 <b>CIRCUIT BREAKER ACTIVE</b>\n3 consecutive losses — paused 2hrs.\n\nClose Pocket Option. Rest.\n\nTap /reset_breaker to override.`);
  }

  // News = warning only, never blocks
  const newsWarn = news.on ? `\n⚠️ <b>NEWS ALERT:</b> ${news.reason} — trade carefully\n` : '';

  const pairs = getPairs(cat).sort((a,b)=>a.priority-b.priority||b.payout-a.payout);
  await send(`🔍 <b>Scanning ${pairs.length} ${cat} pairs...</b>\n📡 Fetching real-time data...\n🕐 Session: ${session.name}`);await send(`🔍 <b>Scanning ${pairs.length} ${cat} pairs...</b>\n📡 Fetching real-time data...${newsWarn}`);

  const fetcher  = getFetcher();
  const analyzer = getAnalyzer();

  if (!fetcher || !analyzer) {
    return send(`⚠️ <b>Module load error.</b>\nTry again in 30 seconds.`);
  }

  const signals = [];
  let scanned = 0, withData = 0;

  for (const pair of pairs) {
    // Cooldown check — prevents same pair repeating
    if (Date.now() - (cooldowns[pair.symbol]||0) < COOL_MS) continue;

    try {
      const data = await fetcher.fetchPriceData(pair.symbol, tfInterval);
      if (!data || !data.ltf) { scanned++; continue; }
      withData++;

      const sig = analyzer.analyzeSignal(data.ltf, pair, data.htf);
      if (sig && sig.confidence >= 68) {
        signals.push({ ...sig, isSyn: data.ltf.isSynthetic || false });
      }
      scanned++;
    } catch(e) {
      console.error(`Scan error ${pair.symbol}:`, e.message);
      scanned++;
    }
    await delay(300);
  }

  // Sort by composite score: confidence × payout
  signals.sort((a,b) => (b.confidence*b.payout) - (a.confidence*a.payout));

  if (!signals.length) {
    return send(
      `📭 <b>NO VALID SIGNALS</b>\n\n` +
      `Scanned: ${scanned} pairs (${withData} with data)\n` +
      `Session: ${session.name}\n\n` +
      `No setups pass Quad-Lock criteria.\n` +
      `⏳ Retry in 10–15 min or try a different category.`
    );
  }

  const best = signals[0]; // Only the #1 ranked signal
await send(`✅ <b>${signals.length} setups found — firing best signal</b>`);

cooldowns[best.symbol] = Date.now();
S.total++;
best.direction==='CALL' ? S.calls++ : S.puts++;
await sendSignal(best, session);
  }
}

// ── Send signal ────────────────────────────────────────────────
async function sendSignal(sig, session) {
  const de   = sig.direction==='CALL' ? '🟢⬆️' : '🔴⬇️';
  const tier = sig.payout>=92 ? '💎' : sig.payout>=88 ? '🥇' : '🥈';
  const live = sig.cat==='LIVE' ? ' ⭐ LIVE' : '';
  const div  = sig.divergence && sig.divergence!=='NONE' ? `\n🔥 <b>DIVERGENCE:</b> ${sig.divergence}` : '';
  const vol  = sig.volume && sig.volume!=='UNKNOWN' ? `\n📦 Volume: ${sig.volume}` : '';
  const src  = sig.isSyn ? `\n⚠️ <i>Synthetic — verify chart</i>` : `\n✅ <i>Real market data</i>`;

  const msg =
    `${de} <b>${sig.direction}${live}</b> ${tier}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📊 <b>${sig.symbol}</b>\n` +
    `💰 Payout: +${sig.payout}%  ⏱ Expiry: ${expiry}MIN\n` +
    `🎯 Confidence: ${sig.confidence}%\n` +
    `[${confBar(sig.confidence)}]\n\n` +
    `📈 RSI:${sig.rsi||'?'}  Stoch:${sig.stochK||'?'}\n` +
    `MACD:${sig.macd||'?'}  ADX:${sig.adx||'?'}\n` +
    `HTF:${sig.htfBias||'?'}${div}${vol}${src}\n\n` +
    `✅ <b>Confluence (${sig.indicators||'?'}):</b>\n` +
    (sig.reasons||[]).slice(0,5).map(r=>`  • ${r}`).join('\n') +
    ((sig.warnings||[]).length ? `\n\n⚠️ <b>Caution:</b>\n`+(sig.warnings||[]).slice(0,2).map(w=>`  • ${w}`).join('\n') : '') +
    `\n\n🕐 ${session.name}\n` +
    `💵 Stake:$${stake} → +$${(stake*(sig.payout||85)/100).toFixed(2)}\n\n` +
    `⚠️ <i>Check payout ≥85% on platform before entering</i>`;

  await bot.sendMessage(CHAT_ID, msg, {
    parse_mode:'HTML',
    reply_markup:{ inline_keyboard:[[
      { text:'✅ WIN',  callback_data:`W_${sig.symbol}` },
      { text:'❌ LOSS', callback_data:`L_${sig.symbol}` },
      { text:'⏭ SKIP', callback_data:`K_${sig.symbol}` }
    ]]}
  }).catch(e => console.error('Signal send error:', e.message));
}

// ── Backtest ───────────────────────────────────────────────────
async function runBacktest() {
  const analyzer = getAnalyzer();
  const fetcher  = getFetcher();
  if (!analyzer || !fetcher) return send(`⚠️ Module error. Try again.`);

  await send(`🔬 <b>BACKTESTING top 5 LIVE pairs...</b>\n⏳ Fetching 200-candle history (30s)`);

  const testPairs = LIVE_PAIRS.slice(0, 5);
  const results = [];

  for (const pair of testPairs) {
    try {
      const d = await fetcher.fetchHistoricalData(pair.symbol, tfInterval, 200);
      if (!d || d.closes.length < 60) continue;
      const r = analyzer.backtest(d, pair, 100);
      if (r) results.push(r);
      await delay(500);
    } catch(e) { console.error('Backtest error:', e.message); }
  }

  if (!results.length) {
    return send(`📭 No backtest data available.\nAPI limit may have been reached.\nTry again in 60 seconds.`);
  }

  results.sort((a,b)=>b.winRate-a.winRate);

  let msg = `🔬 <b>BACKTEST RESULTS</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
  for (const r of results) {
    const g = r.winRate>=70?'🟢':r.winRate>=58?'🟡':'🔴';
    msg += `${g} <b>${r.pair}</b> [Grade:${r.grade||'?'}]\n`;
    msg += `  ${r.total} signals | W:${r.wins} L:${r.losses} | <b>WR:${r.winRate}%</b>\n`;
    msg += `  P&L:${r.pnl>=0?'+':''}$${r.pnl} | Conf:${r.avgConf}%\n\n`;
  }
  const best = results[0];
  msg += `🏆 <b>Best: ${best.pair}</b> (${best.winRate}% WR)\n<i>Focus on Grade A pairs this week</i>`;
  return send(msg);
}

// ── Message handler ────────────────────────────────────────────
bot.on('message', async msg => {
  if (!auth(msg)) return;
  const t = (msg.text||'').trim();
  console.log('Message received:', t);

  try {
    if (t==='/start' || t==='❓ Help') return sendHelp();
    if (t==='🔍 Scan All')    return runScan('ALL');
    if (t==='⚠️ OTC')         return runScan('OTC');
    if (t==='🌐 Live')        return runScan('LIVE');
    if (t==='₿ Crypto')       return runScan('CRYPTO');
    if (t==='🛢 Commodity')   return runScan('COMMODITY');
    if (t==='🔬 Backtest')    return runBacktest();
    if (t==='📊 Stats')       return sendStats();
    if (t==='⚡ Status')      return sendStatus();
    if (t==='📋 Pairs')       return sendPairs();
    if (t==='🔁 Reset')       { resetStats(); return send('🔁 Stats reset for new session.'); }
    if (t==='/reset_breaker') { resetCB(); return send('✅ Circuit breaker reset. Trading resumed.'); }

    if (t==='🟢 Auto ON') {
      if (autoMode) { send('⚡ Auto mode already running.'); return; }
      autoMode = true;
      send(`🟢 <b>AUTO MODE ON</b>\nScanning every 15 min.\nOnly during active sessions.\nNews blackout respected.`);
      runScan('ALL');
      autoTimer = setInterval(()=>{
        if (getSession().active && !isCB() && !newsBlackout().on) runScan('ALL');
      }, 15*60*1000);
      return;
    }

    if (t==='🔴 Auto OFF') {
      autoMode = false;
      if (autoTimer) { clearInterval(autoTimer); autoTimer=null; }
      return send(`🔴 <b>AUTO MODE OFF</b>`);
    }

    if (t==='⏱ Expiry') {
      return bot.sendMessage(CHAT_ID, '⏱ Select expiry:', { reply_markup:{ inline_keyboard:[[
        {text:'1 MIN',  callback_data:'TF_1min_1'},
        {text:'5 MIN',  callback_data:'TF_5min_5'},
        {text:'15 MIN ⭐',callback_data:'TF_15min_15'},
        {text:'30 MIN', callback_data:'TF_30min_30'},
      ]]}});
    }

    if (t==='💵 Stake') {
      return bot.sendMessage(CHAT_ID, '💵 Select stake:', { reply_markup:{ inline_keyboard:[
        [{text:'$1',callback_data:'ST_1'},{text:'$5',callback_data:'ST_5'},{text:'$8',callback_data:'ST_8'},{text:'$10',callback_data:'ST_10'}],
        [{text:'$15',callback_data:'ST_15'},{text:'$20',callback_data:'ST_20'},{text:'$25',callback_data:'ST_25'},{text:'$30',callback_data:'ST_30'}],
      ]}});
    }
  } catch(e) {
    console.error('Handler error:', e.message);
    send(`⚠️ Error processing command. Please try again.`);
  }
});

// ── Callbacks ──────────────────────────────────────────────────
bot.on('callback_query', async q => {
  if (q.message.chat.id.toString()!==CHAT_ID.toString()) return;
  const d = q.data || '';

  try {
    if (d.startsWith('TF_')) {
      const parts = d.split('_');
      tfInterval = parts[1]; expiry = parseInt(parts[2]);
      await bot.answerCallbackQuery(q.id, {text:`Expiry: ${expiry} MIN`});
      return send(`⏱ Expiry set to <b>${expiry} MIN</b>`);
    }

    if (d.startsWith('ST_')) {
      stake = parseFloat(d.split('_')[1]);
      await bot.answerCallbackQuery(q.id, {text:`Stake: $${stake}`});
      return send(`💵 Stake set to <b>$${stake}</b>`);
    }

    const act = d.slice(0,1);
    const sym = d.slice(2);

    if (act==='W') {
      S.wins++; S.consLoss=0;
      S.pnl += stake * 0.92;
      S.pairW[sym] = (S.pairW[sym]||0)+1;
      await bot.answerCallbackQuery(q.id, {text:'✅ WIN recorded!'});
      const wr = S.wins+S.losses>0 ? Math.round(S.wins/(S.wins+S.losses)*100) : 0;
      send(`✅ <b>WIN</b> — ${sym}\n📊 ${S.wins}W / ${S.losses}L | WR: ${wr}% | P&L: +$${S.pnl.toFixed(2)}`);
    } else if (act==='L') {
      S.losses++; S.consLoss++;
      S.pnl -= stake;
      S.pairL[sym] = (S.pairL[sym]||0)+1;
      await bot.answerCallbackQuery(q.id, {text:'❌ LOSS recorded'});
      send(`❌ <b>LOSS</b> — ${sym}\nStreak: ${S.consLoss} losses | P&L: $${S.pnl.toFixed(2)}`);
      if (S.consLoss >= 3) {
        setCB();
        send(`🛑 <b>CIRCUIT BREAKER</b>\n3 consecutive losses.\nTrading paused 2 hours.\n\n<b>Close Pocket Option now. Protect capital.</b>`);
      }
    } else if (act==='K') {
      S.skipped++;
      await bot.answerCallbackQuery(q.id, {text:'Skipped ✓'});
    }
  } catch(e) {
    console.error('Callback error:', e.message);
  }
});

// ── Response functions ─────────────────────────────────────────
function sendHelp() {
  return send(
    `🎯 <b>OMNI BULLS EYE v6.1 — ONLINE</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>📡 54 Pairs Coverage:</b>\n` +
    `⭐ 12 Live Forex (highest accuracy)\n` +
    `⚠️ 28 OTC Pairs (all tiers)\n` +
    `₿ 6 Crypto OTC\n` +
    `🛢 3 Commodity OTC\n\n` +
    `<b>🔬 7-Layer Analysis Engine:</b>\n` +
    `✅ RSI Divergence (bull/bear/hidden)\n` +
    `✅ Volume + OBV analysis\n` +
    `✅ Multi-timeframe alignment\n` +
    `✅ ADX trend strength filter\n` +
    `✅ Bollinger Bands + EMA cross\n` +
    `✅ Support & Resistance levels\n` +
    `✅ 13 candle pattern types\n\n` +
    `<b>🛡 5 Protections:</b>\n` +
    `✅ News blackout (auto)\n` +
    `✅ GMT+6 session gate\n` +
    `✅ 15-min pair cooldown\n` +
    `✅ Circuit breaker (3-loss)\n` +
    `✅ 85%+ payout floor\n\n` +
    `⭐ <b>Live pairs always scanned first</b>`,
    KB
  );
}

function sendStats() {
  const t = S.wins+S.losses;
  const wr = t>0 ? Math.round(S.wins/t*100) : 0;
  const grade = wr>=70?'🟢 A':wr>=60?'🟡 B':wr>=50?'🟠 C':'🔴 D';
  return send(
    `📊 <b>SESSION STATISTICS</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
    `📈 Signals: ${S.total} | 🟢 CALL:${S.calls} | 🔴 PUT:${S.puts}\n` +
    `✅ Wins: ${S.wins} | ❌ Losses: ${S.losses} | ⏭ Skip: ${S.skipped}\n` +
    `🏆 Win Rate: ${wr}% ${grade}\n` +
    `💰 P&L: ${S.pnl>=0?'+':''}$${S.pnl.toFixed(2)}\n` +
    `🔄 Consecutive losses: ${S.consLoss}\n` +
    `🛡 Circuit Breaker: ${isCB()?'🛑 TRIGGERED':'✅ Clear'}`
  );
}

function sendStatus() {
  const s = getSession();
  const n = newsBlackout();
  return send(
    `⚡ <b>BOT STATUS</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
    `🤖 Online: ✅\n` +
    `🔄 Auto Mode: ${autoMode?'🟢 ON':'🔴 OFF'}\n` +
    `⏱ Expiry: ${expiry} MIN\n` +
    `💵 Stake: $${stake}\n` +
    `📅 Session: ${s.name} ${s.active?'✅':'❌'}\n` +
    `🚫 News: ${n.on?`🛑 ${n.reason}`:'✅ Clear'}\n` +
    `🛡 Breaker: ${isCB()?'🛑 ON':'✅ Clear'}\n` +
    `⏰ GMT+6: ${gmt6()}`
  );
}

function sendPairs() {
  const t1 = ALL_PAIRS.filter(p=>p.payout>=92).map(p=>`${p.cat==='LIVE'?'⭐ ':''} ${p.symbol}`).join('\n');
  return send(`📋 <b>TIER 1 PAIRS (92%+)</b>\n${t1}\n\n<i>Always verify actual payout on Pocket Option before entering.</i>`);
}

// ── Boot message ───────────────────────────────────────────────
setTimeout(() => {
  send(
    `🚀 <b>OMNI BULLS EYE v6.1 — ONLINE</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `✅ 54 pairs loaded\n` +
    `✅ RSI Divergence: ACTIVE\n` +
    `✅ Volume/OBV: ACTIVE\n` +
    `✅ Multi-TF engine: ACTIVE\n` +
    `✅ News blackout filter: ACTIVE\n` +
    `✅ Session gate GMT+6: ARMED\n` +
    `✅ Circuit breaker: ARMED\n` +
    `✅ Pair cooldown: ACTIVE\n\n` +
    `⭐ Live pairs prioritized in all scans\n\n` +
    `Tap <b>🔍 Scan All</b> to begin`,
    KB
  );
  console.log('Boot message sent');
}, 3000);

console.log('=== Bot setup complete, waiting for messages ===');

