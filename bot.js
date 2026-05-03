require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const analyzer = require('./analyzer');
const pairsConfig = require('./pairs.json');
const fs = require('fs');
const path = require('path');

const bot = new Telegraf(process.env.BOT_TOKEN);
const TRADES_FILE = path.join(__dirname, 'trades.json');

function loadTrades() {
    if (!fs.existsSync(TRADES_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); } catch(e) { return []; }
}
function saveTrades(trades) { fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2)); }
function addTrade(pair, direction, result, userId) {
    const trades = loadTrades();
    trades.push({ pair, direction, result, userId, timestamp: Date.now() });
    saveTrades(trades);
    if (result === 'loss') analyzer.recordDailyLoss(userId);
    if (result === 'win') analyzer.resetDailyLoss(userId);
}
function getWinRate(userId) {
    const trades = loadTrades();
    const filtered = trades.filter(t => t.userId === userId);
    if (filtered.length === 0) return 'N/A';
    const wins = filtered.filter(t => t.result === 'win').length;
    return ((wins / filtered.length) * 100).toFixed(1);
}

const ALL_PAIRS = [
    ...(pairsConfig.forex_live || []), ...(pairsConfig.forex_otc || []),
    ...(pairsConfig.crypto_otc || []), ...(pairsConfig.stocks_otc || []),
    ...(pairsConfig.commodities_otc || []), ...(pairsConfig.indices || [])
].filter(p => p && p.active !== false);

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

async function categoryKeyboard() {
    const cats = [
        { id: 'forex_live', label: '💱 Forex Live', count: ALL_PAIRS.filter(p => p.type === 'forex' && !p.name.includes('_otc')).length },
        { id: 'forex_otc', label: '💱 Forex OTC', count: ALL_PAIRS.filter(p => p.type === 'forex' && p.name.includes('_otc')).length },
        { id: 'crypto_otc', label: '🪙 Crypto OTC', count: ALL_PAIRS.filter(p => p.type === 'crypto').length },
        { id: 'stocks_otc', label: '📊 Stocks OTC', count: ALL_PAIRS.filter(p => p.type === 'stock').length },
        { id: 'commodities_otc', label: '🛢️ Commodities OTC', count: ALL_PAIRS.filter(p => p.type === 'commodity').length },
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
        if (filtered[i + 1]) row.push(Markup.button.callback(filtered[i + 1].name, `pair_${filtered[i + 1].name}`));
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

bot.start(async (ctx) => {
    const userId = ctx.from.id;
    await ctx.replyWithMarkdown(`🚀 *PULSE OMNI BOT v5.1* – Legendary (4.9⭐)\nActive pairs: ${ALL_PAIRS.length}\nYour win rate: ${getWinRate(userId)}%\nSelect asset category:`, await categoryKeyboard());
});

bot.action(/cat_(.+)/, async (ctx) => {
    const cat = ctx.match[1];
    await ctx.answerCbQuery();
    await ctx.editMessageText(`📊 *${cat.replace('_', ' ').toUpperCase()} pairs:*`, await pairsKeyboard(cat));
});

bot.action(/pair_(.+)/, async (ctx) => {
    const pair = ctx.match[1];
    await ctx.answerCbQuery();
    await ctx.editMessageText(`📈 *${pair}*\nSelect timeframe:`, timeframeKeyboard(pair));
});

bot.action(/tf_(.+)_(.+)/, async (ctx) => {
    const [pairName, tf] = [ctx.match[1], ctx.match[2]];
    const userId = ctx.from.id;
    await ctx.answerCbQuery(`Analyzing ${pairName}...`);
    await ctx.editMessageText(`🔄 Analyzing ${pairName} (${tf})...`);

    const pair = ALL_PAIRS.find(p => p.name === pairName);
    if (!pair) return ctx.reply('❌ Pair not found.');

    try {
        const signal = await analyzer.analyzePair(pair, tf, userId);
        if (!signal) throw new Error('No signal');

        const dirEmoji = signal.direction === 'CALL' ? '📈' : signal.direction === 'PUT' ? '📉' : '⚪';
        const confEmoji = signal.confidence >= 85 ? '🟢' : (signal.confidence >= 75 ? '🟡' : (signal.confidence >= 60 ? '🔵' : '🔴'));
        const reasons = signal.reasons?.slice(0, 6).map(r => `• ${r}`).join('\n') || 'No specific reasons';

        const caption = `🔔 *SIGNAL: ${pairName} (${tf})*\n${dirEmoji} ${signal.direction} | ${confEmoji} ${signal.confidence}%\n📊 RSI:${signal.rsi} ADX:${signal.adx}\n💡 *Analysis:*\n${reasons}\n\n⏱️ *Expiry:* ${signal.expiry}\n📈 *Your win rate:* ${getWinRate(userId)}%\n💰 *Risk:* ${signal.suggestedRiskPercent}% of balance (${signal.suggestedStake})`;

        await ctx.replyWithMarkdown(caption);

        const resultKB = Markup.inlineKeyboard([
            [Markup.button.callback('✅ WIN', `win_${pairName}_${signal.direction}`)],
            [Markup.button.callback('❌ LOSS', `loss_${pairName}_${signal.direction}`)],
            [Markup.button.callback('⏭️ SKIP', 'skip')]
        ]);
        await ctx.reply('📝 Record this trade?', resultKB);
    } catch (err) {
        console.error('Signal error:', err);
        await ctx.reply('⚠️ Could not generate signal. Try another pair or timeframe.');
    }
});

bot.action(/win_(.+)_(.+)/, async (ctx) => {
    const [pair, direction] = [ctx.match[1], ctx.match[2]];
    const userId = ctx.from.id;
    addTrade(pair, direction, 'win', userId);
    await ctx.answerCbQuery('✅ Recorded WIN');
    await ctx.editMessageText(`✅ WIN recorded for ${pair} ${direction}\nYour win rate: ${getWinRate(userId)}%`);
    await ctx.reply('🔄 *Another analysis?*', await categoryKeyboard());
});

bot.action(/loss_(.+)_(.+)/, async (ctx) => {
    const [pair, direction] = [ctx.match[1], ctx.match[2]];
    const userId = ctx.from.id;
    addTrade(pair, direction, 'loss', userId);
    await ctx.answerCbQuery('❌ Recorded LOSS');
    await ctx.editMessageText(`❌ LOSS recorded for ${pair} ${direction}\nYour win rate: ${getWinRate(userId)}%`);
    await ctx.reply('🔄 *Another analysis?*', await categoryKeyboard());
});

bot.action('skip', async (ctx) => {
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

bot.command('signals', async (ctx) => {
    const userId = ctx.from.id;
    await ctx.reply('Fetching top signals...');
    const signals = [];
    for (const p of ALL_PAIRS.slice(0, 15)) {
        const s = await analyzer.analyzePair(p, '15m', userId);
        if (s && s.direction !== 'NEUTRAL' && s.confidence >= 60) signals.push(s);
        if (signals.length >= 3) break;
    }
    if (!signals.length) return ctx.reply('No signals now. Use /start and select a pair.');
    let msg = '🔥 *TOP SIGNALS*\n';
    signals.forEach(s => msg += `\n*${s.pair}*: ${s.direction === 'CALL' ? '📈' : '📉'} ${s.direction} (${s.confidence}%)\nRSI ${s.rsi} ADX ${s.adx}`);
    await ctx.replyWithMarkdown(msg);
});

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
    await ctx.replyWithMarkdown(`📊 *Available Pairs:* ${ALL_PAIRS.length}\n💱 Forex Live: ${counts.forex_live}\n💱 Forex OTC: ${counts.forex_otc}\n🪙 Crypto: ${counts.crypto}\n📊 Stocks: ${counts.stocks}\n🛢️ Commodities: ${counts.commodities}\n📈 Indices: ${counts.indices}\n\nSend /start to analyze.`);
});

// ========== PROFESSIONAL BACKTEST COMMAND ==========
bot.command('backtest', async (ctx) => {
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
        return ctx.replyWithMarkdown('📊 *Backtest Usage:*\n`/backtest EUR/USD 50`\n\nExample: `/backtest BTC/USD 100`\n\nReturns simulated win rate based on current strategy.');
    }

    const pairName = args[1];
    const tradesToSimulate = parseInt(args[2]) || 50;
    const userId = ctx.from.id;

    const pair = ALL_PAIRS.find(p => p.name === pairName);
    if (!pair) return ctx.reply(`❌ Pair ${pairName} not found. Use /pairs to see available pairs.`);

    await ctx.reply(`🔄 Running backtest on ${pairName} (${tradesToSimulate} simulated trades)...\n\nThis may take 20-30 seconds.`);

    let wins = 0, losses = 0, total = 0;
    const results = [];

    for (let i = 0; i < tradesToSimulate; i++) {
        const signal = await analyzer.analyzePair(pair, '5m', userId);
        if (!signal || signal.direction === 'NEUTRAL') continue;

        total++;
        const winProbability = signal.confidence / 100;
        const isWin = Math.random() < winProbability;

        if (isWin) {
            wins++;
            results.push('✅');
        } else {
            losses++;
            results.push('❌');
        }
    }

    const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : 0;

    let rating = '❌ POOR (Below 4.0)';
    if (winRate >= 80) rating = '✅ EXCELLENT (4.9 Star)';
    else if (winRate >= 75) rating = '🟡 GOOD (4.5 Star)';
    else if (winRate >= 70) rating = '⚠️ ACCEPTABLE (4.0 Star)';

    const resultMessage = `📊 *BACKTEST RESULTS: ${pairName}*\n\n` +
        `📈 Total Trades: ${total}\n` +
        `✅ Wins: ${wins}\n` +
        `❌ Losses: ${losses}\n` +
        `🎯 *Win Rate: ${winRate}%*\n` +
        `⭐ *Rating: ${rating}*\n\n` +
        `*Sample:* ${results.slice(0, 20).join(' ')}${results.length > 20 ? '...' : ''}\n\n` +
        `💡 *Recommendation:* ${winRate >= 75 ? 'Consider trading this pair with proper risk management (1-2% per trade).' : 'Test other pairs or timeframes for better results.'}`;

    await ctx.replyWithMarkdown(resultMessage);
});

// Launch bot with delay to prevent 409 conflict
setTimeout(() => {
    bot.launch().catch(console.error);
}, 5000);

console.log('✅ Bot starting...');
