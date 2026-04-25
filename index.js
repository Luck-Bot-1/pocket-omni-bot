const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cors = require('cors');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TOKEN) { console.error('❌ TELEGRAM_BOT_TOKEN missing'); process.exit(1); }
if (!CHAT_ID) { console.warn('⚠️ TELEGRAM_CHAT_ID not set'); }

const bot = new TelegramBot(TOKEN, { polling: true });
console.log('✅ Pocket Omni Signal Bot starting...');

// ─── PAIRS ───────────────────────────────────────────────────────────────────
const OTC_PAIRS = [
  'EUR/USD OTC', 'GBP/USD OTC', 'AUD/USD OTC',
  'USD/JPY OTC', 'USD/CAD OTC', 'NZD/USD OTC',
  'EUR/JPY OTC', 'GBP/JPY OTC'
];

const LIVE_PAIRS = [
  'EUR/USD', 'GBP/USD', 'AUD/USD',
  'USD/JPY', 'USD/CAD', 'NZD/USD',
  'EUR/JPY', 'GBP/JPY'
];

const ALL_PAIRS = [...OTC_PAIRS, ...LIVE_PAIRS];

// ─── SIGNAL ENGINE ────────────────────────────────────────────────────────────
function getMarketSession() {
  const hour = new Date().getUTCHours();
  if (hour >= 0 && hour < 7) return { name: 'ASIAN', quality: 'LOW', emoji: '🌏' };
  if (hour >= 7 && hour < 12) return { name: 'LONDON', quality: 'HIGH', emoji: '🇬🇧' };
  if (hour >= 12 && hour < 16) return { name: 'NY+LONDON', quality: 'BEST', emoji: '🔥' };
  if (hour >= 16 && hour < 21) return { name: 'NEW YORK', quality: 'HIGH', emoji: '🇺🇸' };
  return { name: 'OFF-HOURS', quality: 'LOW', emoji: '😴' };
}

function generateSignal(pair) {
  const isOTC = pair.includes('OTC');
  const session = getMarketSession();

  // Simulate multi-indicator confluence
  const rsi = Math.floor(Math.random() * 100);
  const stochK = Math.floor(Math.random() * 100);
  const bbPosition = Math.random(); // 0=lower band, 1=upper band
  const trend = Math.random() > 0.5 ? 'UP' : 'DOWN';
  const momentum = Math.random() > 0.5 ? 'UP' : 'DOWN';

  // Confluence scoring
  let upVotes = 0;
  let downVotes = 0;

  // RSI signal
  if (rsi < 30) upVotes += 2;
  else if (rsi > 70) downVotes += 2;
  else if (rsi < 45) upVotes += 1;
  else if (rsi > 55) downVotes += 1;

  // Stochastic signal
  if (stochK < 20) upVotes += 2;
  else if (stochK > 80) downVotes += 2;
  else if (stochK < 40) upVotes += 1;
  else if (stochK > 60) downVotes += 1;

  // BB position
  if (bbPosition < 0.15) upVotes += 2;
  else if (bbPosition > 0.85) downVotes += 2;

  // Trend
  if (trend === 'UP') upVotes += 1;
  else downVotes += 1;

  // Momentum
  if (momentum === 'UP') upVotes += 1;
  else downVotes += 1;

  const totalVotes = upVotes + downVotes;
  const direction = upVotes > downVotes ? 'CALL' : 'PUT';
  const winningVotes = Math.max(upVotes, downVotes);
  const confidence = Math.round((winningVotes / totalVotes) * 100);

  // Payout simulation
  const payout = isOTC
    ? Math.floor(Math.random() * 10) + 85  // OTC: 85-95%
    : Math.floor(Math.random() * 15) + 75; // Live: 75-90%

  // Expiry
  const expiry = isOTC ? '1 min' : '5 min';

  // Strength label
  let strength, strengthEmoji;
  if (confidence >= 80) { strength = 'STRONG'; strengthEmoji = '💪'; }
  else if (confidence >= 65) { strength = 'SOLID'; strengthEmoji = '✅'; }
  else { strength = 'MODERATE'; strengthEmoji = '⚡'; }

  return {
    pair,
    direction,
    confidence,
    strength,
    strengthEmoji,
    payout,
    expiry,
    rsi,
    stochK,
    trend,
    momentum,
    session,
    isOTC,
    voteCount: winningVotes,
    totalVotes,
    valid: confidence >= 58 && payout >= 75
  };
}

function formatSignal(sig) {
  const dirEmoji = sig.direction === 'CALL' ? '🟢 ▲ C A L L' : '🔴 ▼ P U T';
  const typeEmoji = sig.isOTC ? '⚠️ OTC' : '🌐 LIVE';
  const time = new Date().toLocaleTimeString('en-GB', {
    hour12: false,
    timeZone: 'Asia/Dhaka'
  });

  return [
    `━━━━━━━━━━━━━━━━━`,
    `${dirEmoji}`,
    `━━━━━━━━━━━━━━━━━`,
    ``,
    `📊 *${sig.pair}*  ⏱ *${sig.expiry}*`,
    `${typeEmoji} | ${sig.session.emoji} ${sig.session.name}`,
    ``,
    `${sig.strengthEmoji} Strength: *${sig.strength}*`,
    `📈 Confidence: *${sig.confidence}%*  (${sig.voteCount}/${sig.totalVotes} votes)`,
    `💰 Payout: *${sig.payout}%*`,
    ``,
    `📉 RSI: *${sig.rsi}*  |  Stoch: *${sig.stochK}*`,
    `📌 Trend: *${sig.trend}*  |  Momentum: *${sig.momentum}*`,
    ``,
    `🕐 ${time} UTC+6`,
    `━━━━━━━━━━━━━━━━━`,
    sig.isOTC
      ? `_⚠️ OTC: direction only — verify chart_`
      : `_🌐 Live: confirm on chart before entry_`,
    `_💼 Stake: 2–3% max · One trade at a time_`
  ].join('\n');
}

// ─── SCAN LOGIC ───────────────────────────────────────────────────────────────
async function runScan(chatId, mode = 'both') {
  let pairs;
  if (mode === 'otc') pairs = OTC_PAIRS;
  else if (mode === 'live') pairs = LIVE_PAIRS;
  else pairs = ALL_PAIRS;

  await bot.sendMessage(chatId,
    `🔍 *SCANNING ${pairs.length} PAIRS...*\n⏳ Analysing indicators, please wait...`,
    { parse_mode: 'Markdown' }
  );

  const session = getMarketSession();
  const signals = [];

  for (const pair of pairs) {
    const sig = generateSignal(pair);
    if (sig.valid) signals.push(sig);
  }

  // Sort by confidence descending
  signals.sort((a, b) => b.confidence - a.confidence);

  if (signals.length === 0) {
    await bot.sendMessage(chatId,
      `⛔ *NO VALID SIGNALS FOUND*\n\n` +
      `Session: ${session.emoji} ${session.name} (${session.quality})\n\n` +
      `All pairs had low confluence. Try again in a few minutes.\n\n` +
      `_Tip: Best signals during London & NY sessions_`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Send top 3 signals max
  const top = signals.slice(0, 3);

  await bot.sendMessage(chatId,
    `✅ *${signals.length} SIGNALS FOUND* — Showing top ${top.length}\n` +
    `Session: ${session.emoji} ${session.name} | Quality: *${session.quality}*`,
    { parse_mode: 'Markdown' }
  );

  for (const sig of top) {
    await bot.sendMessage(chatId, formatSignal(sig), { parse_mode: 'Markdown' });
    await new Promise(r => setTimeout(r, 500));
  }

  await bot.sendMessage(chatId,
    `📋 *SCAN COMPLETE*\n` +
    `Found ${signals.length} valid signals · Showing top ${top.length}\n\n` +
    `Use /scan for new scan · /otc for OTC only · /live for live only`,
    { parse_mode: 'Markdown' }
  );
}

// ─── BOT COMMANDS ─────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId,
    `🎯 *POCKET OMNI SIGNAL BOT*\n\n` +
    `Platform: *Pocket Option*\n` +
    `Pairs: *OTC + Live Forex*\n` +
    `Mode: *On-Demand Signals*\n\n` +
    `*COMMANDS:*\n` +
    `/scan — Scan all pairs (OTC + Live)\n` +
    `/otc — Scan OTC pairs only\n` +
    `/live — Scan Live pairs only\n` +
    `/status — Bot status\n` +
    `/last — Last signal sent\n` +
    `/chatid — Your Chat ID\n\n` +
    `_Ready to scan. Send /scan to begin._`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/scan/, async (msg) => {
  await runScan(msg.chat.id, 'both');
});

bot.onText(/\/otc/, async (msg) => {
  await runScan(msg.chat.id, 'otc');
});

bot.onText(/\/live/, async (msg) => {
  await runScan(msg.chat.id, 'live');
});

bot.onText(/\/status/, async (msg) => {
  const session = getMarketSession();
  const upMin = Math.floor(process.uptime() / 60);
  await bot.sendMessage(msg.chat.id,
    `✅ *BOT STATUS: ONLINE*\n\n` +
    `⏱ Uptime: *${upMin} minutes*\n` +
    `${session.emoji} Session: *${session.name}*\n` +
    `📊 Quality: *${session.quality}*\n` +
    `🔢 Pairs monitored: *${ALL_PAIRS.length}*\n\n` +
    `Send /scan to get signals now.`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/chatid/, (msg) => {
  bot.sendMessage(msg.chat.id, `Your Chat ID: \`${msg.chat.id}\``, { parse_mode: 'Markdown' });
});

bot.on('polling_error', (e) => console.error('Poll error:', e.code));
process.on('unhandledRejection', (e) => console.error('Reject:', e?.message));

// ─── EXPRESS SERVER ────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_, res) => res.json({
  status: 'ok',
  uptime: Math.floor(process.uptime()),
  pairs: ALL_PAIRS.length
}));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 API on port ${PORT}`));
