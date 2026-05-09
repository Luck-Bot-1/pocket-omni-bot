// ============================================
// BOT v14.2 – NON‑BLOCKING, CONCURRENT SIGNALS
// Multiple pending trades, no waiting
// ============================================

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const analyzer = require('./analyzer');
const { fetchPriceData } = require('./pricefetcher');
const pairsConfig = require('./pairs.json');
const fs = require('fs');
const path = require('path');

const bot = new Telegraf(process.env.BOT_TOKEN);
const TRADES_FILE = path.join(__dirname, 'trades.json');

// ------------------------- Data Helpers -------------------------
function loadTrades() {
    if (!fs.existsSync(TRADES_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); } catch(e) { return []; }
}
function saveTrades(trades) { fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2)); }
function addTrade(pair, direction, result, userId) {
    const trades = loadTrades();
    trades.push({ pair, direction, result, userId, timestamp: Date.now() });
    saveTrades(trades);
    // Also update analyzer performance (optional)
    try { analyzer.recordTradeResult({ wasWin: result === 'win', profit: result === 'win' ? 0.8 : -1 }); } catch(e) {}
}
function getWinRate(userId) {
    const trades = loadTrades().filter(t => t.userId === userId);
    if (trades.length === 0) return 'N/A';
    const wins = trades.filter(t => t.result === 'win').length;
    return ((wins / trades.length) * 100).toFixed(1);
}

// ------------------------- Pending Trades (non‑blocking) -------------------------
const pendingTrades = {}; // { tradeId: { pair, signal, timestamp } }

function getExpiryFromTimeframe(tf) {
    const map = { '1m':'2m', '5m':'5m', '15m':'15m', '30m':'30m', '1h':'1h', '4h':'2h', '1d':'12h' };
    return map[tf] || '15m';
}

// ------------------------- Pairs Configuration -------------------------
let cachedAllPairs = null;
function getAllPairs() {
    if (cachedAllPairs) return cachedAllPairs;
    const allPairs = [];
    const categories = ['forex_live', 'forex_otc', 'crypto_otc', 'stocks_otc', 'commodities_otc', 'indices'];
    for (const cat of categories) {
        const pairs = pairsConfig[cat] || [];
        for (const p of pairs) {
            if (p && p.active !== false) {
                allPairs.push({ name: p.name, type: p.type || cat.replace('_otc','').replace('_live',''), active: true });
            }
        }
    }
    cachedAllPairs = allPairs;
    return allPairs;
}
const ALL_PAIRS = getAllPairs();
const TIMEFRAMES = ['1m','5m','15m','30m','1h','4h','1d'];

// ------------------------- Keyboards -------------------------
async function categoryKeyboard() {
    const cats = [
        { id: 'forex_live', label: '💱 Live Pairs', count: ALL_PAIRS.filter(p => p.type === 'forex' && !p.name.includes('_otc')).length },
        { id: 'forex_otc', label: '💱 OTC Pairs', count: ALL_PAIRS.filter(p => p.type === 'forex' && p.name.includes('_otc')).length },
        { id: 'crypto_otc', label: '🪙 Crypto', count: ALL_PAIRS.filter(p => p.type === 'crypto').length },
        { id: 'stocks_otc', label: '📊 Stocks', count: ALL_PAIRS.filter(p => p.type === 'stock').length },
        { id: 'commodities_otc', label: '🛢️ Commodities', count: ALL_PAIRS.filter(p => p.type === 'commodity').length },
        { id: 'indices', label: '📈 Indices', count: ALL_PAIRS.filter(p => p.type === 'index').length }
    ].filter(c => c.count > 0);
    const kb = cats.map(c => [Markup.button.callback(`${c.label} (${c.count})`, `cat_${c.id}`)]);
    kb.push([Markup.button.callback('❌ Cancel', 'cancel')]);
    return Markup.inlineKeyboard(kb);
}
async function pairsKeyboard(catId) {
    let filtered;
    if (catId === 'forex_live') filtered = ALL_PAIRS.filter(p => p.type === 'forex' && !p.name.includes('_otc'));
    else if (catId === 'forex_otc') filtered = ALL_PAIRS.filter(p => p.type === 'forex' && p.name.includes('_otc'));
    else if (catId === 'crypto_otc') filtered = ALL_PAIRS.filter(p => p.type === 'crypto');
    else if (catId === 'stocks_otc') filtered = ALL_PAIRS.filter(p => p.type === 'stock');
    else if (catId === 'commodities_otc') filtered = ALL_PAIRS.filter(p => p.type === 'commodity');
    else if (catId === 'indices') filtered = ALL_PAIRS.filter(p => p.type === 'index');
    else filtered = [];
    const kb = [];
    for (let i = 0; i < filtered.length; i += 2) {
        const row = [Markup.button.callback(filtered[i].name, `pair_${filtered[i].name}`)];
        if (filtered[i+1]) row.push(Markup.button.callback(filtered[i+1].name, `pair_${filtered[i+1].name}`));
        kb.push(row);
    }
    kb.push([Markup.button.callback('🔙 Back', 'back_cats')]);
    return Markup.inlineKeyboard(kb);
}
function timeframeKeyboard(pairName) {
    const kb = TIMEFRAMES.map(tf => [Markup.button.callback(tf, `tf_${pairName}_${tf}`)]);
    kb.push([Markup.button.callback('🔙 Back', `back_pairs_${pairName}`)]);
    return Markup.inlineKeyboard(kb);
}

// ------------------------- Bot Actions -------------------------
bot.start(async (ctx) => {
    const userId = ctx.from.id;
    await ctx.replyWithMarkdown(`🚀 *PULSE OMNI BOT v14.2* – High Quality, Non‑Blocking\nActive pairs: ${ALL_PAIRS.length}\nYour win rate: ${getWinRate(userId)}%\nSelect asset category:`, await categoryKeyboard());
});

bot.action(/cat_(.+)/, async (ctx) => {
    const cat = ctx.match[1];
    await ctx.answerCbQuery();
    await ctx.editMessageText(`📊 *${cat.replace('_',' ').toUpperCase()} pairs:*`, await pairsKeyboard(cat));
});
bot.action(/pair_(.+)/, async (ctx) => {
    const pair = ctx.match[1];
    await ctx.answerCbQuery();
    await ctx.editMessageText(`📈 *${pair}*\nSelect timeframe:`, timeframeKeyboard(pair));
});
bot.action(/tf_(.+)_(.+)/, async (ctx) => {
    const [pairName, tf] = [ctx.match[1], ctx.match[2]];
    const userId = ctx.from.id;
    if (!TIMEFRAMES.includes(tf)) {
        await ctx.answerCbQuery('Invalid timeframe');
        return ctx.reply('❌ Invalid timeframe.');
    }
    await ctx.answerCbQuery(`Analyzing ${pairName}...`);
    await ctx.editMessageText(`🔄 Analyzing ${pairName} (${tf})...`);

    const pair = ALL_PAIRS.find(p => p.name === pairName);
    if (!pair) return ctx.reply('❌ Pair not found.');

    try {
        const priceData = await fetchPriceData(pairName);
        if (!priceData || !priceData.values || priceData.values.length < 60) throw new Error('Invalid price data');
        const result = await analyzer.analyzeSignal(priceData, { minConfidence: 50, type: pair.type }, tf);
        if (!result || result.signal === 'WAIT') {
            return ctx.reply(`⚠️ No high-confidence signal for ${pairName} on ${tf}.\n\nReason: ${result?.reason || 'Confidence too low'}`);
        }

        const tradeId = `${pairName}_${Date.now()}_${Math.random().toString(36).substr(2,6)}`;
        pendingTrades[tradeId] = { pair: pairName, signal: result.signal, timestamp: Date.now() };

        const dirEmoji = result.signal === 'CALL' ? '📈' : '📉';
        let confEmoji = result.confidence >= 80 ? '🟢' : (result.confidence >= 65 ? '🟡' : '🔴');
        const expiry = getExpiryFromTimeframe(tf);
        let trendDisplay = 'Sideways';
        if (result.trend.includes('UP')) trendDisplay = 'Upward';
        else if (result.trend.includes('DOWN')) trendDisplay = 'Downward';
        let analysisText = `*Analysis:*\n- Trade Direction: ${trendDisplay} (${tf})\n- ${result.emaRelation}\n`;
        const dmiPlus = parseFloat(result.dmi.plus) || 0, dmiMinus = parseFloat(result.dmi.minus) || 0;
        if (dmiPlus > dmiMinus) analysisText += `- DMI+ dominates (${dmiPlus.toFixed(1)} > ${dmiMinus.toFixed(1)})\n`;
        else analysisText += `- DMI- dominates (${dmiMinus.toFixed(1)} > ${dmiPlus.toFixed(1)})\n`;
        analysisText += `- Price ${result.priceChange >= 0 ? 'up' : 'down'} ${Math.abs(result.priceChange)}%\n`;
        if (result.adx > 25) analysisText += `- ADX ${result.adx} (trending)\n`;
        analysisText += `- Confidence: ${result.confidence}%`;
        const trendLine = `📌 *Trend Alignment:* ${result.trendAlignment}`;
        const divergenceLine = result.divergence !== 'None' ? `🔄 *Divergence:* ${result.divergence}\n` : '';
        const caption = `🔔 *SIGNAL: ${pairName} (${tf})*\n${dirEmoji} ${result.signal} | ${confEmoji} ${result.confidence}%\n📊 RSI: ${result.rsi} (5m: ${result.rsi5}) | ADX: ${result.adx}\n${divergenceLine}\n${analysisText}\n\n${trendLine}\n\n⏱️ *Expiry:* ${expiry}\n📈 *Your win rate:* ${getWinRate(userId)}%\n💰 *Risk:* 1.5% of balance`;
        await ctx.replyWithMarkdown(caption);
        await ctx.reply('📝 Record this trade after expiry?', Markup.inlineKeyboard([
            [Markup.button.callback('✅ WIN', `win_${tradeId}`)],
            [Markup.button.callback('❌ LOSS', `loss_${tradeId}`)],
            [Markup.button.callback('⏭️ SKIP', `skip_${tradeId}`)]
        ]));
    } catch (err) {
        console.error('Signal error:', err);
        await ctx.reply('⚠️ Could not generate signal. Try another pair or timeframe.');
    }
});

// WIN / LOSS / SKIP handlers (non‑blocking, by tradeId)
bot.action(/win_(.+)/, async (ctx) => {
    const tradeId = ctx.match[1];
    const trade = pendingTrades[tradeId];
    if (!trade) { await ctx.answerCbQuery('Trade not found or already recorded'); return; }
    addTrade(trade.pair, trade.signal, 'win', ctx.from.id);
    delete pendingTrades[tradeId];
    await ctx.answerCbQuery('✅ Recorded WIN');
    await ctx.editMessageText(`✅ WIN recorded for ${trade.pair} ${trade.signal}\nYour win rate: ${getWinRate(ctx.from.id)}%`);
    await ctx.reply('🔄 *Another analysis?*', await categoryKeyboard());
});
bot.action(/loss_(.+)/, async (ctx) => {
    const tradeId = ctx.match[1];
    const trade = pendingTrades[tradeId];
    if (!trade) { await ctx.answerCbQuery('Trade not found or already recorded'); return; }
    addTrade(trade.pair, trade.signal, 'loss', ctx.from.id);
    delete pendingTrades[tradeId];
    await ctx.answerCbQuery('❌ Recorded LOSS');
    await ctx.editMessageText(`❌ LOSS recorded for ${trade.pair} ${trade.signal}\nYour win rate: ${getWinRate(ctx.from.id)}%`);
    await ctx.reply('🔄 *Another analysis?*', await categoryKeyboard());
});
bot.action(/skip_(.+)/, async (ctx) => {
    const tradeId = ctx.match[1];
    if (pendingTrades[tradeId]) delete pendingTrades[tradeId];
    await ctx.answerCbQuery('Skipped');
    await ctx.editMessageText('Skipped. Use /start for new analysis.');
});

bot.action('back_cats', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('Select asset category:', await categoryKeyboard());
});
bot.action(/back_pairs_(.+)/, async (ctx) => {
    const pair = ctx.match[1];
    await ctx.answerCbQuery();
    await ctx.editMessageText(`📈 *${pair}*\nSelect timeframe:`, timeframeKeyboard(pair));
});
bot.action('cancel', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.deleteMessage();
    await ctx.reply('Cancelled. Send /start again.');
});

// Simple commands (optional, keep your existing)
bot.command('stats', async (ctx) => {
    const userId = ctx.from.id;
    const trades = loadTrades().filter(t => t.userId === userId);
    const wins = trades.filter(t => t.result === 'win').length;
    const losses = trades.filter(t => t.result === 'loss').length;
    await ctx.replyWithMarkdown(`📊 *Your Trade Stats*\nTotal: ${trades.length}\n✅ Wins: ${wins}\n❌ Losses: ${losses}\n📈 Win rate: ${getWinRate(userId)}%`);
});
bot.command('pairs', async (ctx) => {
    const counts = {
        forex_live: ALL_PAIRS.filter(p => p.type === 'forex' && !p.name.includes('_otc')).length,
        forex_otc: ALL_PAIRS.filter(p => p.type === 'forex' && p.name.includes('_otc')).length,
        crypto: ALL_PAIRS.filter(p => p.type === 'crypto').length,
        stocks: ALL_PAIRS.filter(p => p.type === 'stock').length,
        commodities: ALL_PAIRS.filter(p => p.type === 'commodity').length,
        indices: ALL_PAIRS.filter(p => p.type === 'index').length
    };
    await ctx.replyWithMarkdown(`📊 *Available Pairs:* ${ALL_PAIRS.length}\n💱 Live Forex: ${counts.forex_live}\n💱 OTC Forex: ${counts.forex_otc}\n🪙 Crypto: ${counts.crypto}\n📊 Stocks: ${counts.stocks}\n🛢️ Commodities: ${counts.commodities}\n📈 Indices: ${counts.indices}\n\nSend /start to analyze.`);
});
bot.command('backtest', async (ctx) => { /* optional – keep your existing */ });

bot.launch().catch(console.error);
console.log('✅ Bot v14.2 started – Non‑blocking, Concurrent Trades');
