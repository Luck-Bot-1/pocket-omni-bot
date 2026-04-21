const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cors = require('cors');

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
if (!TOKEN) { console.error('❌ TELEGRAM_BOT_TOKEN missing'); process.exit(1); }
if (!CHAT_ID) console.warn('⚠️  TELEGRAM_CHAT_ID not set');

const bot = new TelegramBot(TOKEN, { polling: true });
console.log('✅ Pocket Omni Bot FINAL starting...');

const history   = [];
const cooldowns = new Map();
const COOLDOWN  = 180000;

const block = (sig) => {
  if (!sig.valid && !sig.direction)     return `No valid signal`;
  if ((sig.confidence||0) < 58)        return `Low confidence: ${sig.confidence}%`;
  if ((sig.voteCount||0) < 4)          return `Only ${sig.voteCount}/8 votes`;
  const key = sig.pair || sig.asset || 'UNK';
  if (cooldowns.get(key) && Date.now()-cooldowns.get(key) < COOLDOWN)
    return `Cooldown ${Math.ceil((COOLDOWN-(Date.now()-cooldowns.get(key)))/1000)}s`;
  return null;
};

const fmt = (s) => {
  const isOTC = s.mode === 'otc';
  const dir   = s.direction === 'CALL' ? '🟢  ▲  C A L L' : '🔴  ▼  P U T';
  const conf  = s.confidence >= 85 ? '🔥 Strong' : s.confidence >= 75 ? '✅ Solid' : '⚡ Moderate';
  const priceNote = isOTC ? '⚠️ OTC — trade direction, not price'
    : `💵 Price: \`${s.priceStr||'N/A'}\` — verify on chart`;
  const btNote = s.backtestWinRate ? `\n📊 Backtest: *${s.backtestWinRate}%* Grade ${s.backtestGrade||'?'}` : '';
  const te = s.assetType==='crypto'?'₿':s.assetType==='stock'?'📈':s.assetType==='commodity'?'🪙':'💱';

  return [
    `━━━━━━━━━━━━━━━━━━━━`,
    `${dir}`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `${te} *${s.pair||s.asset}*  ⏱ *${s.expiry}*`,
    `${isOTC?"⚡ OTC":"💱 LIVE MARKET"}`,
    ``,
    `_"${s.humanSummary||`${conf} ${s.direction} setup`}"_`,
    ``,
    `📊 Confidence: *${s.confidence}%*  (${s.voteCount||'?'}/8)`,
    `📈 Trend: *${s.trend||'?'}*  Momentum: ${s.momentum||'?'}`,
    `💰 Payout: *${s.payout}%*  Session: ${s.session||'?'}`,
    `${priceNote}`,
    `📡 Source: ${s.source||'Real browser data'}${btNote}`,
    `⏰ ${new Date().toLocaleTimeString('en-GB',{hour12:false,timeZone:'Asia/Dhaka'})} UTC+6`,
    `━━━━━━━━━━━━━━━━━━━━`,
    isOTC ? `_OTC: trade direction only_` : `_Live: verify chart before trading_`,
    `_Stake: 2–3% max · One trade at a time_`,
  ].join('\n');
};

const send = async (sig) => {
  const reason = block(sig);
  if (reason) return { ok:false, reason };
  await bot.sendMessage(CHAT_ID, fmt(sig), { parse_mode:'Markdown' });
  const key = sig.pair||sig.asset||'UNK';
  cooldowns.set(key, Date.now());
  history.unshift({ ...sig, sentAt: new Date().toISOString() });
  if (history.length > 50) history.pop();
  return { ok:true };
};

bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id,
    `🎯 *POCKET OMNI — FINAL*\n\n` +
    `Chat ID: \`${msg.chat.id}\`\n\n` +
    `*Dashboard:* Open PocketOmni_FINAL.html in Chrome browser\n\n` +
    `*Why HTML file instead of Claude artifact?*\n` +
    `Claude artifacts have a sandbox that blocks all data fetching.\n` +
    `An HTML file in Chrome has full network access.\n\n` +
    `*Data sources (all work in browser):*\n` +
    `L1 Binance — crypto + gold (24/7)\n` +
    `L2 ECB Frankfurter — forex (CORS-native, 24/7)\n` +
    `L3 ExchangeRate-API — fallback rates\n` +
    `L4 Cache — last known prices\n\n` +
    `*Commands:* /start /status /last /stats /chatid`,
    { parse_mode:'Markdown' }
  );
});

bot.onText(/\/status/, msg => {
  const up = Math.floor(process.uptime()/60);
  const cds = [...cooldowns.entries()].filter(([,t])=>Date.now()-t<COOLDOWN).map(([k])=>k).join(', ')||'None';
  bot.sendMessage(msg.chat.id,`✅ *ONLINE*\nUptime: ${up}min\nSent: ${history.length}\nCooldowns: ${cds}`,{parse_mode:'Markdown'});
});

bot.onText(/\/last/, msg => {
  if(!history.length){bot.sendMessage(msg.chat.id,'📭 No signals yet.');return;}
  const s=history[0];
  bot.sendMessage(msg.chat.id,`📋 *Last:* ${s.pair||s.asset} ${s.direction} ${s.confidence}% · ${s.voteCount}/8\n${s.sentAt?.slice(0,19).replace('T',' ')}`,{parse_mode:'Markdown'});
});

bot.onText(/\/stats/, msg => {
  if(!history.length){bot.sendMessage(msg.chat.id,'📭 No data.');return;}
  const avg=Math.round(history.reduce((a,b)=>a+(b.confidence||0),0)/history.length);
  const calls=history.filter(s=>s.direction==='CALL').length;
  bot.sendMessage(msg.chat.id,`📊 *Stats*\nTotal: ${history.length} · Avg: ${avg}%\n▲ ${calls}  ▼ ${history.length-calls}`,{parse_mode:'Markdown'});
});

bot.onText(/\/chatid/, msg => bot.sendMessage(msg.chat.id,`Chat ID: \`${msg.chat.id}\``,{parse_mode:'Markdown'}));

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_,res) => res.json({status:'ok',version:'final',uptime:Math.floor(process.uptime()),signalsSent:history.length}));

app.post('/signal', async (req,res) => {
  try {
    const r = await send(req.body);
    if(r.ok) res.json({success:true});
    else res.status(429).json({success:false,reason:r.reason});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/history', (_,res) => res.json(history.slice(0,20)));

const PORT = process.env.PORT||3001;
app.listen(PORT,()=>console.log(`🚀 API on port ${PORT}`));
bot.on('polling_error',e=>console.error('Poll:',e.code));
process.on('unhandledRejection',e=>console.error('Reject:',e?.message));
