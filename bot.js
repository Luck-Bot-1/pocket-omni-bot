require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const analyzer = require('./analyzer');
const pairsConfig = require('./pairs.json');

const bot = new Telegraf(process.env.BOT_TOKEN);

const ALL_PAIRS = [
    ...(pairsConfig.forex_live || []),
    ...(pairsConfig.commodities || []),
    ...(pairsConfig.crypto || []),
    ...(pairsConfig.indices || [])
].filter(p => p && p.active !== false);

const TIMEFRAMES = ['1m','5m','15m','30m','1h','4h','1d'];

async function categoryKeyboard() {
    const cats = [
        { type:'forex', label:'💱 Forex', count:ALL_PAIRS.filter(p=>p.type==='forex').length },
        { type:'crypto', label:'🪙 Crypto', count:ALL_PAIRS.filter(p=>p.type==='crypto').length },
        { type:'commodity', label:'🛢️ Commodities', count:ALL_PAIRS.filter(p=>p.type==='commodity').length },
        { type:'index', label:'📈 Indices', count:ALL_PAIRS.filter(p=>p.type==='index').length }
    ].filter(c=>c.count>0);
    const kb = cats.map(c=>[Markup.button.callback(`${c.label} (${c.count})`, `cat_${c.type}`)]);
    kb.push([Markup.button.callback('❌ Cancel', 'cancel')]);
    return Markup.inlineKeyboard(kb);
}

async function pairsKeyboard(cat) {
    const pairs = ALL_PAIRS.filter(p=>p.type===cat);
    const kb = [];
    for(let i=0;i<pairs.length;i+=2) {
        const row = [Markup.button.callback(pairs[i].name, `pair_${pairs[i].name}`)];
        if(pairs[i+1]) row.push(Markup.button.callback(pairs[i+1].name, `pair_${pairs[i+1].name}`));
        kb.push(row);
    }
    kb.push([Markup.button.callback('🔙 Back', 'back_cats')]);
    return Markup.inlineKeyboard(kb);
}

function timeframeKeyboard(pairName) {
    const kb = TIMEFRAMES.map(tf=>[Markup.button.callback(tf, `tf_${pairName}_${tf}`)]);
    kb.push([Markup.button.callback('🔙 Back', `back_pairs_${pairName}`)]);
    return Markup.inlineKeyboard(kb);
}

bot.start(async (ctx) => {
    await ctx.replyWithMarkdown('🚀 *PULSE OMNI BOT v4.7*\nSelect asset category:', await categoryKeyboard());
});

bot.action(/cat_(.+)/, async (ctx) => {
    const cat = ctx.match[1];
    await ctx.answerCbQuery();
    await ctx.editMessageText(`📊 *${cat.toUpperCase()} pairs:*`, await pairsKeyboard(cat));
});

bot.action(/pair_(.+)/, async (ctx) => {
    const pair = ctx.match[1];
    await ctx.answerCbQuery();
    await ctx.editMessageText(`📈 *${pair}*\nSelect timeframe:`, timeframeKeyboard(pair));
});

bot.action(/tf_(.+)_(.+)/, async (ctx) => {
    const [pairName, tf] = [ctx.match[1], ctx.match[2]];
    await ctx.answerCbQuery(`Analyzing ${pairName}...`);
    await ctx.editMessageText(`🔄 Analyzing ${pairName} (${tf})...`);

    const pair = ALL_PAIRS.find(p => p.name === pairName);
    const signal = await analyzer.analyzePair(pair, tf, true);
    if (!signal) {
        await ctx.reply('⚠️ Could not generate signal. Try another timeframe.');
        return;
    }

    const dirEmoji = signal.direction === 'CALL' ? '📈' : '📉';
    const confEmoji = signal.confidence >= 85 ? '🟢' : (signal.confidence >= 75 ? '🟡' : '🔴');
    const reasons = signal.reasons.slice(0,3).map(r => `• ${r}`).join('\n');
    await ctx.replyWithMarkdown(
        `🔔 *SIGNAL: ${pairName} (${tf})*\n` +
        `${dirEmoji} ${signal.direction} | ${confEmoji} ${signal.confidence}%\n` +
        `📊 RSI:${signal.rsi} ADX:${signal.adx}\n` +
        `💡 *Reasons:*\n${reasons}\n\n` +
        `⏱️ Expiry: ${tf==='1m'?'3 min':tf==='5m'?'10 min':'1 hour'}`
    );
    await ctx.reply('🔄 *Another analysis?*', await categoryKeyboard());
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
    await ctx.reply('Fetching top signals...');
    const signals = [];
    for (const p of ALL_PAIRS.slice(0,15)) {
        const s = await analyzer.analyzePair(p, '5m', true);
        if (s && s.confidence >= 75) signals.push(s);
        if (signals.length >= 3) break;
    }
    if (signals.length === 0) {
        await ctx.reply('No signals now. Use /start and select a pair.');
        return;
    }
    let msg = '🔥 *TOP SIGNALS*\n';
    signals.forEach(s => {
        msg += `\n*${s.pair}*: ${s.direction} (${s.confidence}%)\nRSI ${s.rsi} ADX ${s.adx}`;
    });
    await ctx.replyWithMarkdown(msg);
});

bot.command('pairs', async (ctx) => {
    const counts = {
        forex: ALL_PAIRS.filter(p=>p.type==='forex').length,
        crypto: ALL_PAIRS.filter(p=>p.type==='crypto').length,
        commodity: ALL_PAIRS.filter(p=>p.type==='commodity').length,
        index: ALL_PAIRS.filter(p=>p.type==='index').length
    };
    await ctx.replyWithMarkdown(
        `📊 *Available pairs:* ${ALL_PAIRS.length}\n` +
        `💱 Forex: ${counts.forex}\n🪙 Crypto: ${counts.crypto}\n🛢️ Commodities: ${counts.commodity}\n📈 Indices: ${counts.index}\n\n` +
        `Send /start to analyze.`
    );
});

bot.launch().then(() => console.log('✅ Bot online with full interface'));
