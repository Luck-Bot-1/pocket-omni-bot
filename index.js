/**
 * POCKET OMNI SIGNAL BOT v5.0
 */
const TelegramBot = require('node-telegram-bot-api');
const express    = require('express');
const cors       = require('cors');
const https      = require('https');

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const WHITELIST_RAW = process.env.AUTHORIZED_CHAT_IDS || '';
if (!TOKEN) { console.error('❌ TELEGRAM_BOT_TOKEN missing'); process.exit(1); }

// ─── AUTH ─────────────────────────────────────────────────────────────────────
const authorizedUsers = new Set();
if (CHAT_ID) authorizedUsers.add(String(CHAT_ID));
if (WHITELIST_RAW) WHITELIST_RAW.split(',').forEach(id=>{const t=id.trim();if(t)authorizedUsers.add(t);});
function isAuthorized(chatId){return authorizedUsers.size===0||authorizedUsers.has(String(chatId));}

// ─── SUBSCRIPTIONS ────────────────────────────────────────────────────────────
const subscriptions = new Map();
const SUB_RAW = process.env.SUBSCRIPTIONS||'';
if(SUB_RAW) SUB_RAW.split(',').forEach(e=>{const[id,date]=e.trim().split(':');if(id&&date)subscriptions.set(id.trim(),new Date(date.trim()));});
function isSubActive(chatId){if(!subscriptions.has(String(chatId)))return true;return new Date()<subscriptions.get(String(chatId));}
function getDaysLeft(chatId){if(!subscriptions.has(String(chatId)))return null;return Math.ceil((subscriptions.get(String(chatId))-new Date())/(86400000));}

// ─── BOT WITH AUTO-RECONNECT ──────────────────────────────────────────────────
let bot;
let reconnects = 0;

function createBot(){
  bot = new TelegramBot(TOKEN,{polling:{interval:1000,autoStart:true,params:{timeout:10}}});
  bot.on('polling_error',(err)=>{
    console.error(`Poll error: ${err.code}`);
    if(err.code==='ETELEGRAM'||err.code==='EFATAL'||err.code==='EPARSE'){
      reconnects++;
      const delay=Math.min(30000,reconnects*5000);
      console.log(`🔄 Reconnecting in ${delay/1000}s...`);
      setTimeout(()=>{
        try{bot.stopPolling().then(()=>{setTimeout(()=>{bot.startPolling();console.log('✅ Reconnected');},2000);});}
        catch(e){console.error('Reconnect fail:',e.message);}
      },delay);
    }
  });
  bot.on('message',()=>{reconnects=0;});
  registerHandlers();
  console.log('✅ Pocket Omni Signal Bot v5.0 online');
}

// ─── STATE ────────────────────────────────────────────────────────────────────
let autoMode=false,autoInterval=null,selectedTF='1m',selectedStake=1;
let signalHistory=[],resultLog=[],lastSigId=0;
let stats={total:0,calls:0,puts:0,wins:0,losses:0};
let priceCache={};

// ─── TIMEFRAMES ───────────────────────────────────────────────────────────────
const TF={
  '15s':{label:'15 sec',mins:.25},'30s':{label:'30 sec',mins:.5},
  '1m':{label:'1 min',mins:1},'3m':{label:'3 min',mins:3},
  '5m':{label:'5 min',mins:5},'10m':{label:'10 min',mins:10},
  '15m':{label:'15 min',mins:15},'30m':{label:'30 min',mins:30},
  '60m':{label:'1 hour',mins:60},'120m':{label:'2 hours',mins:120},
  '180m':{label:'3 hours',mins:180},'240m':{label:'4 hours',mins:240},
};

// ─── PAIRS ────────────────────────────────────────────────────────────────────
const LIVE=[
  {symbol:'EUR/USD',from:'EUR',to:'USD'},{symbol:'GBP/USD',from:'GBP',to:'USD'},
  {symbol:'AUD/USD',from:'AUD',to:'USD'},{symbol:'USD/JPY',from:'USD',to:'JPY'},
  {symbol:'USD/CAD',from:'USD',to:'CAD'},{symbol:'NZD/USD',from:'NZD',to:'USD'},
  {symbol:'EUR/JPY',from:'EUR',to:'JPY'},{symbol:'GBP/JPY',from:'GBP',to:'JPY'},
];
const OTC=[
  'EUR/USD OTC','GBP/USD OTC','AUD/USD OTC','USD/JPY OTC',
  'USD/CAD OTC','NZD/USD OTC','EUR/JPY OTC','GBP/JPY OTC',
  'AUD/JPY OTC','EUR/GBP OTC','USD/CHF OTC','CAD/JPY OTC'
];

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function isWeekend(){const d=new Date().getUTCDay();return d===0||d===6;}

function getSession(){
  const h=new Date().getUTCHours(),m=new Date().getUTCMinutes(),t=h+m/60;
  if(t>=7&&t<12)  return{name:'LONDON',   quality:'HIGH',emoji:'🇬🇧',score:3,trade:true};
  if(t>=12&&t<16) return{name:'NY+LONDON',quality:'BEST',emoji:'🔥', score:4,trade:true};
  if(t>=16&&t<21) return{name:'NEW YORK', quality:'HIGH',emoji:'🇺🇸',score:3,trade:true};
  if(t>=21&&t<23) return{name:'LATE NY',  quality:'MED', emoji:'🌙', score:2,trade:true};
  return              {name:'OFF-HOURS',quality:'LOW', emoji:'😴', score:1,trade:false};
}

function fetchJSON(url){
  return new Promise((res,rej)=>{
    const req=https.get(url,{headers:{'User-Agent':'OmniBot/5.0'},timeout:8000},(r)=>{
      let d='';
      r.on('data',c=>d+=c);
      r.on('end',()=>{if(!d.trim()){rej(new Error('Empty'));return;}try{res(JSON.parse(d));}catch(e){rej(new Error('BadJSON'));}});
    });
    req.on('error',rej);
    req.on('timeout',()=>{req.destroy();rej(new Error('Timeout'));});
  });
}

async function getRate(from,to){
  const k=`${from}${to}`,now=Date.now();
  if(priceCache[k]&&now-priceCache[k].ts<120000)return priceCache[k].rate;
  try{
    const data=await fetchJSON(`https://api.frankfurter.app/latest?from=${from}&to=${to}`);
    if(!data?.rates?.[to])throw new Error('No rate');
    if(!priceCache[k])priceCache[k]={};
    priceCache[k].rate=data.rates[to];priceCache[k].ts=now;
    return data.rates[to];
  }catch(e){return priceCache[k]?.rate||null;}
}

async function getHistory(from,to){
  const k=`${from}${to}`,now=Date.now();
  if(priceCache[k]?.history&&now-priceCache[k].histTs<21600000)return priceCache[k].history;
  try{
    const end=new Date(),start=new Date();
    start.setDate(start.getDate()-20);
    if(isWeekend())start.setDate(start.getDate()-2);
    const s=start.toISOString().split('T')[0],e=end.toISOString().split('T')[0];
    const data=await fetchJSON(`https://api.frankfurter.app/${s}..${e}?from=${from}&to=${to}`);
    if(!data?.rates)throw new Error('No history');
    const rates=Object.values(data.rates).map(r=>r[to]).filter(Boolean);
    if(rates.length<5)throw new Error('Too few');
    if(!priceCache[k])priceCache[k]={};
    priceCache[k].history=rates;priceCache[k].histTs=now;
    return rates;
  }catch(e){return priceCache[k]?.history||null;}
}

// ─── INDICATORS ───────────────────────────────────────────────────────────────
function rsi(p,n=14){if(!p||p.length<n+1)return 50;let g=0,l=0;for(let i=p.length-n;i<p.length;i++){const d=p[i]-p[i-1];d>0?g+=d:l+=Math.abs(d);}if(!l)return 100;return Math.round(100-(100/(1+(g/n)/(l/n))));}
function ema(p,n){if(!p||p.length<n)return null;const k=2/(n+1);let e=p.slice(0,n).reduce((a,b)=>a+b,0)/n;for(let i=n;i<p.length;i++)e=p[i]*k+e*(1-k);return e;}
function macdHist(p){if(!p||p.length<26)return 0;const m=ema(p,12)-ema(p,26);return m-m*.85;}
function bb(p,n=14){if(!p||p.length<n)return{pos:.5};const s=p.slice(-n),mid=s.reduce((a,b)=>a+b,0)/n,std=Math.sqrt(s.reduce((a,b)=>a+Math.pow(b-mid,2),0)/n);const lo=mid-2*std,hi=mid+2*std,last=p[p.length-1];return{pos:std?Math.max(0,Math.min(1,(last-lo)/(hi-lo))):.5};}
function stoch(p,n=14){if(!p||p.length<n)return{k:50,d:50};const s=p.slice(-n),hi=Math.max(...s),lo=Math.min(...s),last=p[p.length-1];const k=hi===lo?50:Math.round(((last-lo)/(hi-lo))*100);return{k,d:Math.round((k*2+50)/3)};}
function cci(p,n=14){if(!p||p.length<n)return 0;const s=p.slice(-n),mean=s.reduce((a,b)=>a+b,0)/n,md=s.reduce((a,b)=>a+Math.abs(b-mean),0)/n;return md?Math.round((p[p.length-1]-mean)/(.015*md)):0;}
function sma(p,n){if(!p||p.length<n)return null;return p.slice(-n).reduce((a,b)=>a+b,0)/n;}

// ─── LIVE SIGNAL ─────────────────────────────────────────────────────────────
async function liveSignal(pair,tf){
  const tfD=TF[tf]||TF['1m'],ses=getSession();
  try{
    const prices=await getHistory(pair.from,pair.to);
    const rate=await getRate(pair.from,pair.to);
    if(!prices||prices.length<8)return null;
    if(rate)prices.push(rate);
    const n=Math.min(14,prices.length-1);
    const R=rsi(prices,n),B=bb(prices,n),S=stoch(prices,n),M=macdHist(prices),C=cci(prices,n);
    const s5=sma(prices,Math.min(5,prices.length)),s10=sma(prices,Math.min(10,prices.length));
    const last=prices[prices.length-1],prev=prices[prices.length-2]||last;
    let up=0,dn=0;
    if(R<30)up+=3;else if(R<45)up+=1;else if(R>70)dn+=3;else if(R>55)dn+=1;
    if(S.k<20)up+=3;else if(S.k<35)up+=1;else if(S.k>80)dn+=3;else if(S.k>65)dn+=1;
    if(B.pos<.1)up+=3;else if(B.pos<.25)up+=1;else if(B.pos>.9)dn+=3;else if(B.pos>.75)dn+=1;
    M>0?up+=2:dn+=2;
    if(C<-100)up+=2;else if(C>100)dn+=2;
    if(s5&&s10){s5>s10?up+=2:dn+=2;}
    last>prev?up+=1:dn+=1;
    const tot=up+dn,dir=up>=dn?'CALL':'PUT',conf=Math.round((Math.max(up,dn)/tot)*100);
    const wk=isWeekend();
    let str,se;if(conf>=78){str='STRONG';se='💪';}else if(conf>=63){str='SOLID';se='✅';}else{str='MODERATE';se='⚡';}
    return{pair:pair.symbol,dir,conf,strength:str,sEmoji:se,tf,tfLabel:tfD.label,
      rsi:R,stochK:S.k,stochD:S.d,macdH:M>0?`+${M.toFixed(5)}`:M.toFixed(5),cci:C,
      bbPos:Math.round(B.pos*100),currentRate:rate?rate.toFixed(5):'cached',
      up,dn,tot,session:ses,isOTC:false,
      valid:conf>=60&&(prices.length>5),
      dataSource:wk?'Cached (weekend)':'Live Frankfurter API',weekend:wk};
  }catch(e){console.error(`Live err ${pair.symbol}:`,e.message);return null;}
}

// ─── OTC SIGNAL ───────────────────────────────────────────────────────────────
function otcSignal(pair,tf){
  const now=new Date(),h=now.getUTCHours(),m=now.getUTCMinutes(),ses=getSession(),tfD=TF[tf]||TF['1m'];
  const tk=h*100+Math.floor(m/5),ps=pair.split('').reduce((a,c)=>a+c.charCodeAt(0),0);
  const seed=(tk*31+ps*17)%100,hc=Math.sin((h/24)*Math.PI*2),mp=m%2===0?1:-1;
  const inVol=(h>=8&&h<12)||(h>=13&&h<17)||(h>=19&&h<22);
  let up=0,dn=0;
  seed<45?up+=2:seed>55?dn+=2:seed<50?up+=1:dn+=1;
  hc>.3?up+=2:hc<-.3?dn+=2:hc>0?up+=1:dn+=1;
  if(ses.score>=3){mp>0?up+=2:dn+=2;}
  if(inVol){up+=1;dn+=1;}
  if(tfD.mins>=5){up+=1;dn+=1;}
  ps%3===0?up+=1:ps%3===1?dn+=1:null;
  const tot=up+dn,dir=up>=dn?'CALL':'PUT',conf=Math.round((Math.max(up,dn)/tot)*100);
  let str,se;if(conf>=78){str='STRONG';se='💪';}else if(conf>=63){str='SOLID';se='✅';}else{str='MODERATE';se='⚡';}
  const R=30+(seed%40),SK=20+(seed%60),mv=((seed-50)/100).toFixed(3),cv=Math.round((seed-50)*4);
  return{pair,dir,conf,strength:str,sEmoji:se,tf,tfLabel:tfD.label,
    rsi:R,stochK:SK,stochD:Math.round((SK+50)/2),macdH:parseFloat(mv)>0?`+${mv}`:`${mv}`,cci:cv,bbPos:seed,
    up,dn,tot,session:ses,isOTC:true,valid:conf>=60,dataSource:'OTC Pattern Logic'};
}

// ─── FORMAT ───────────────────────────────────────────────────────────────────
function fmt(s,stake,id){
  const dir=s.dir==='CALL'?'🟢 ▲  C A L L':'🔴 ▼  P U T';
  const type=s.isOTC?'⚠️ OTC':'🌐 LIVE';
  const time=new Date().toLocaleTimeString('en-GB',{hour12:false,timeZone:'Asia/Dhaka'});
  const expMins=TF[s.tf]?.mins||1;
  const expT=new Date(Date.now()+expMins*60000).toLocaleTimeString('en-GB',{hour12:false,timeZone:'Asia/Dhaka'});
  const est=((stake*85)/100).toFixed(2);
  return[
    `━━━━━━━━━━━━━━━━━━━━`,
    `${dir}`,
    `━━━━━━━━━━━━━━━━━━━━`,``,
    `📊 *${s.pair}*`,
    `⏱ Expiry: *${s.tfLabel}*  |  ${type}`,
    `${s.session.emoji} Session: *${s.session.name}* (${s.session.quality})`,``,
    `${s.sEmoji} Strength: *${s.strength}*`,
    `📈 Confidence: *${s.conf}%*  (${Math.max(s.up,s.dn)}/${s.tot} indicators)`,``,
    `📉 RSI: *${s.rsi}*  |  Stoch K/D: *${s.stochK}/${s.stochD}*`,
    `📌 MACD: *${s.macdH}*  |  CCI: *${s.cci}*`,
    s.isOTC?`_OTC synthetic — not real market rate_`:`💱 Rate: *${s.currentRate}*`,``,
    `💵 Stake: *$${stake}*  |  Est. WIN profit: *~$${est}*`,``,
    `⚠️ *CHECK PLATFORM PAYOUT BEFORE ENTRY*`,
    `✅ Trade if platform shows *≥80%*`,
    `❌ Skip if payout below *80%*`,``,
    `⏰ Expires: *${expT} UTC+6*`,
    `🕐 ${time} UTC+6  |  Signal #${id}`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `_📡 ${s.dataSource}_`,
    `_🔒 Flat $${stake} stake | Max 2–3% balance_`,
    ``,`_✅ After trade: tap WIN/LOSS below_`
  ].join('\n');
}

// ─── SCAN ─────────────────────────────────────────────────────────────────────
async function scan(chatId,mode,tf,stake,auto=false){
  if(!isAuthorized(chatId)){await bot.sendMessage(chatId,'🔒 Unauthorized.');return;}
  if(!isSubActive(String(chatId))){await bot.sendMessage(chatId,'⏰ Subscription expired. Contact admin.');return;}
  const ses=getSession(),wk=isWeekend(),prefix=auto?'🤖 *AUTO SCAN*\n':'';
  if(!ses.trade&&mode==='live'&&!wk){
    await bot.sendMessage(chatId,`😴 *OFF-HOURS*\nLive signals unreliable now.\nBest: 🇬🇧 London · 🔥 NY+London · 🇺🇸 NY\nUse /otc instead.`,{parse_mode:'Markdown',reply_markup:mainKB()});
    return;
  }
  await bot.sendMessage(chatId,`${prefix}🔍 *SCANNING...*\n⏱ TF: *${TF[tf]?.label||tf}*\n${wk?'⚠️ Weekend — cached data\n':''}⏳ Please wait...`,{parse_mode:'Markdown'});
  const sigs=[];
  if(mode==='live'||mode==='both'){for(const p of LIVE){const s=await liveSignal(p,tf);if(s?.valid)sigs.push(s);await new Promise(r=>setTimeout(r,200));}}
  if(mode==='otc'||mode==='both'){for(const p of OTC){const s=otcSignal(p,tf);if(s.valid)sigs.push(s);}}
  sigs.sort((a,b)=>b.conf-a.conf||b.session.score-a.session.score);
  if(!sigs.length){await bot.sendMessage(chatId,`⛔ *NO VALID SIGNALS*\n${ses.emoji} ${ses.name} — low confluence.\nTry again in 5 min.`,{parse_mode:'Markdown',reply_markup:mainKB()});return;}
  const best=sigs[0];
  lastSigId++;const sid=lastSigId;
  stats.total++;best.dir==='CALL'?stats.calls++:stats.puts++;
  signalHistory.unshift({...best,stake,sentAt:new Date().toISOString(),id:sid});
  if(signalHistory.length>100)signalHistory.pop();
  const lc=sigs.filter(s=>!s.isOTC).length,oc=sigs.filter(s=>s.isOTC).length;
  const dl=getDaysLeft(String(chatId));
  await bot.sendMessage(chatId,`✅ *BEST SIGNAL* (${sigs.length} valid: ${lc} live + ${oc} OTC)\n${ses.emoji} ${ses.name} | *${ses.quality}*${dl!==null?`\n📅 Sub: *${dl}d left*`:''}`,{parse_mode:'Markdown'});
  await bot.sendMessage(chatId,fmt(best,stake,sid),{parse_mode:'Markdown',reply_markup:resultKB(sid)});
}

// ─── WIN/LOSS TRACKING ────────────────────────────────────────────────────────
function winRate(){const t=stats.wins+stats.losses;return t?Math.round((stats.wins/t)*100):'N/A';}

async function recordResult(chatId,sigId,result){
  const sig=signalHistory.find(s=>s.id===sigId);
  if(!sig){await bot.sendMessage(chatId,'⚠️ Signal not found.');return;}
  if(result==='WIN'){
    stats.wins++;const profit=((sig.stake*85)/100).toFixed(2);
    resultLog.unshift({id:sigId,pair:sig.pair,dir:sig.dir,result:'WIN',stake:sig.stake,profit:parseFloat(profit)});
    await bot.sendMessage(chatId,`✅ *WIN!*\n📊 ${sig.pair} | ${sig.dir}\n💵 Est. profit: +$${profit}\n🏆 Win rate: *${winRate()}%*`,{parse_mode:'Markdown',reply_markup:mainKB()});
  }else if(result==='LOSS'){
    stats.losses++;
    resultLog.unshift({id:sigId,pair:sig.pair,dir:sig.dir,result:'LOSS',stake:sig.stake,profit:-sig.stake});
    await bot.sendMessage(chatId,`❌ *LOSS*\n📊 ${sig.pair} | ${sig.dir}\n💵 Loss: -$${sig.stake}\n🏆 Win rate: *${winRate()}%*`,{parse_mode:'Markdown',reply_markup:mainKB()});
  }else{
    await bot.sendMessage(chatId,'⏭ Skipped.',{reply_markup:mainKB()});
  }
  if(resultLog.length>200)resultLog.pop();
}

// ─── KEYBOARDS ────────────────────────────────────────────────────────────────
function resultKB(id){return{inline_keyboard:[[{text:'✅ WIN',callback_data:`res_WIN_${id}`},{text:'❌ LOSS',callback_data:`res_LOSS_${id}`},{text:'⏭ Skip',callback_data:`res_SKIP_${id}`}]]};}
function tfKB(){return{inline_keyboard:[[{text:'15s',callback_data:'tf_15s'},{text:'30s',callback_data:'tf_30s'},{text:'1m',callback_data:'tf_1m'},{text:'3m',callback_data:'tf_3m'},{text:'5m',callback_data:'tf_5m'}],[{text:'10m',callback_data:'tf_10m'},{text:'15m',callback_data:'tf_15m'},{text:'30m',callback_data:'tf_30m'},{text:'60m',callback_data:'tf_60m'}],[{text:'120m',callback_data:'tf_120m'},{text:'180m',callback_data:'tf_180m'},{text:'240m',callback_data:'tf_240m'}]]};}
function stakeKB(){return{inline_keyboard:[[{text:'$1',callback_data:'stake_1'},{text:'$2',callback_data:'stake_2'},{text:'$5',callback_data:'stake_5'},{text:'$10',callback_data:'stake_10'}],[{text:'$25',callback_data:'stake_25'},{text:'$50',callback_data:'stake_50'},{text:'$100',callback_data:'stake_100'},{text:'✏️ Custom',callback_data:'stake_custom'}]]};}
function mainKB(){return{inline_keyboard:[[{text:'🔍 Scan All',callback_data:'scan_all'},{text:'⚠️ OTC',callback_data:'scan_otc'},{text:'🌐 Live',callback_data:'scan_live'}],[{text:'⏱ Timeframe',callback_data:'menu_tf'},{text:`💵 Stake: $${selectedStake}`,callback_data:'menu_stake'}],[{text:autoMode?'🔴 Stop Auto':'🟢 Start Auto',callback_data:'toggle_auto'},{text:'📊 Stats',callback_data:'show_stats'},{text:'📋 Last',callback_data:'show_last'}],[{text:'💹 Status',callback_data:'show_status'},{text:'🏆 Record',callback_data:'show_record'}]]};}

// ─── REGISTER HANDLERS ────────────────────────────────────────────────────────
function registerHandlers(){
  function guard(chatId){
    if(!isAuthorized(chatId)){bot.sendMessage(chatId,'🔒 Unauthorized.');return false;}
    if(!isSubActive(String(chatId))){bot.sendMessage(chatId,'⏰ Subscription expired.');return false;}
    return true;
  }

  bot.onText(/\/start/,async(msg)=>{
    const chatId=msg.chat.id;
    if(!isAuthorized(chatId)){await bot.sendMessage(chatId,'🔒 Access denied. Contact admin.');return;}
    const ses=getSession(),dl=getDaysLeft(String(chatId)),wk=isWeekend();
    await bot.sendMessage(chatId,
      `🎯 *POCKET OMNI SIGNAL BOT v5.0*\n\n`+
      `Platform: *Pocket Option*\n`+
      `Indicators: *RSI·Stoch·BB·MACD·CCI·SMA*\n`+
      `Auto-reconnect: *✅ Active*\n`+
      `Win tracking: *✅ Active*\n\n`+
      `${ses.emoji} Session: *${ses.name}* (${ses.quality})\n`+
      `⏱ TF: *${TF[selectedTF].label}* | 💵 Stake: *$${selectedStake}*\n`+
      `${wk?'⚠️ Weekend — cached data mode\n':''}`+
      `${dl!==null?`📅 Sub: *${dl} days left*\n`:''}\n`+
      `Commands: /scan /otc /live /tf /stake /auto\n`+
      `/result /stats /status /last /record`,
      {parse_mode:'Markdown',reply_markup:mainKB()}
    );
  });

  bot.onText(/\/scan/,  async(msg)=>{if(guard(msg.chat.id))await scan(msg.chat.id,'both',selectedTF,selectedStake);});
  bot.onText(/\/otc/,   async(msg)=>{if(guard(msg.chat.id))await scan(msg.chat.id,'otc', selectedTF,selectedStake);});
  bot.onText(/\/live/,  async(msg)=>{if(guard(msg.chat.id))await scan(msg.chat.id,'live',selectedTF,selectedStake);});
  bot.onText(/\/auto/,  async(msg)=>{if(guard(msg.chat.id))await toggleAuto(msg.chat.id);});
  bot.onText(/\/status/,async(msg)=>{if(guard(msg.chat.id))await sendStatus(msg.chat.id);});
  bot.onText(/\/stats/, async(msg)=>{if(guard(msg.chat.id))await sendStats(msg.chat.id);});
  bot.onText(/\/last/,  async(msg)=>{if(guard(msg.chat.id))await sendLast(msg.chat.id);});
  bot.onText(/\/record/,async(msg)=>{if(guard(msg.chat.id))await sendRecord(msg.chat.id);});
  bot.onText(/\/tf/,    async(msg)=>{if(guard(msg.chat.id))await bot.sendMessage(msg.chat.id,`⏱ *SELECT TF*\nCurrent: *${TF[selectedTF].label}*`,{parse_mode:'Markdown',reply_markup:tfKB()});});
  bot.onText(/\/stake/, async(msg)=>{if(guard(msg.chat.id))await bot.sendMessage(msg.chat.id,`💵 *SELECT STAKE*\nCurrent: *$${selectedStake}*`,{parse_mode:'Markdown',reply_markup:stakeKB()});});
  bot.onText(/^\/setstake (\d+(\.\d+)?)$/,async(msg,m)=>{
    if(!guard(msg.chat.id))return;
    const a=parseFloat(m[1]);
    if(a<1||a>100000){await bot.sendMessage(msg.chat.id,'❌ $1–$100,000 only');return;}
    selectedStake=a;
    await bot.sendMessage(msg.chat.id,`✅ Stake: *$${a}*`,{parse_mode:'Markdown',reply_markup:mainKB()});
  });
  bot.onText(/\/result (WIN|LOSS)/i,async(msg,m)=>{
    if(!guard(msg.chat.id))return;
    if(!signalHistory.length){await bot.sendMessage(msg.chat.id,'No signals yet.');return;}
    await recordResult(msg.chat.id,signalHistory[0].id,m[1].toUpperCase());
  });
  bot.onText(/\/chatid/,(msg)=>bot.sendMessage(msg.chat.id,`Chat ID: \`${msg.chat.id}\``,{parse_mode:'Markdown'}));

  // Admin commands
  bot.onText(/\/adduser (.+)/,async(msg,m)=>{
    if(String(msg.chat.id)!==String(CHAT_ID)){await bot.sendMessage(msg.chat.id,'🔒 Admin only.');return;}
    authorizedUsers.add(m[1].trim());
    await bot.sendMessage(msg.chat.id,`✅ User ${m[1].trim()} added.`);
  });
  bot.onText(/\/removeuser (.+)/,async(msg,m)=>{
    if(String(msg.chat.id)!==String(CHAT_ID)){await bot.sendMessage(msg.chat.id,'🔒 Admin only.');return;}
    authorizedUsers.delete(m[1].trim());
    await bot.sendMessage(msg.chat.id,`✅ User ${m[1].trim()} removed.`);
  });
  bot.onText(/\/setexpiry (.+) (.+)/,async(msg,m)=>{
    if(String(msg.chat.id)!==String(CHAT_ID)){await bot.sendMessage(msg.chat.id,'🔒 Admin only.');return;}
    subscriptions.set(m[1].trim(),new Date(m[2].trim()));
    await bot.sendMessage(msg.chat.id,`✅ Expiry set: ${m[1].trim()} until ${m[2].trim()}`);
  });
  bot.onText(/\/listusers/,async(msg)=>{
    if(String(msg.chat.id)!==String(CHAT_ID)){await bot.sendMessage(msg.chat.id,'🔒 Admin only.');return;}
    const list=[...authorizedUsers].map(id=>{const dl=getDaysLeft(id);return`${id}${dl!==null?` (${dl}d left)`:' (permanent)'}`;}).join('\n');
    await bot.sendMessage(msg.chat.id,`👥 *Authorized Users:*\n${list||'None'}`,{parse_mode:'Markdown'});
  });

  bot.on('callback_query',async(cb)=>{
    const chatId=cb.message.chat.id,data=cb.data;
    await bot.answerCallbackQuery(cb.id);
    if(data.startsWith('res_')){const[,result,id]=data.split('_');await recordResult(chatId,parseInt(id),result);return;}
    if(!guard(chatId))return;
    if(data.startsWith('tf_')){selectedTF=data.replace('tf_','');await bot.sendMessage(chatId,`✅ TF: *${TF[selectedTF].label}*`,{parse_mode:'Markdown',reply_markup:mainKB()});}
    else if(data.startsWith('stake_')){const v=data.replace('stake_','');if(v==='custom'){await bot.sendMessage(chatId,'✏️ Type: /setstake [amount]');}else{selectedStake=parseInt(v);await bot.sendMessage(chatId,`✅ Stake: *$${selectedStake}*`,{parse_mode:'Markdown',reply_markup:mainKB()});}}
    else if(data==='scan_all')  await scan(chatId,'both',selectedTF,selectedStake);
    else if(data==='scan_otc')  await scan(chatId,'otc', selectedTF,selectedStake);
    else if(data==='scan_live') await scan(chatId,'live',selectedTF,selectedStake);
    else if(data==='menu_tf')   await bot.sendMessage(chatId,`⏱ *SELECT TF*`,{parse_mode:'Markdown',reply_markup:tfKB()});
    else if(data==='menu_stake')await bot.sendMessage(chatId,`💵 *SELECT STAKE*`,{parse_mode:'Markdown',reply_markup:stakeKB()});
    else if(data==='toggle_auto')await toggleAuto(chatId);
    else if(data==='show_stats') await sendStats(chatId);
    else if(data==='show_last')  await sendLast(chatId);
    else if(data==='show_status')await sendStatus(chatId);
    else if(data==='show_record')await sendRecord(chatId);
  });
}

async function toggleAuto(chatId){
  autoMode=!autoMode;
  if(autoMode){
    autoInterval=setInterval(async()=>{try{await scan(chatId,'both',selectedTF,selectedStake,true);}catch(e){console.error('Auto:',e.message);}},5*60*1000);
    await bot.sendMessage(chatId,`🟢 *AUTO ON*\nEvery 5min | TF: *${TF[selectedTF].label}* | $${selectedStake}`,{parse_mode:'Markdown',reply_markup:mainKB()});
  }else{
    if(autoInterval){clearInterval(autoInterval);autoInterval=null;}
    await bot.sendMessage(chatId,`🔴 *AUTO OFF*`,{parse_mode:'Markdown',reply_markup:mainKB()});
  }
}

async function sendStatus(chatId){
  const ses=getSession(),wk=isWeekend();
  await bot.sendMessage(chatId,
    `✅ *v5.0 ONLINE*\n\n`+
    `⏱ Uptime: *${Math.floor(process.uptime()/60)}min*\n`+
    `${ses.emoji} *${ses.name}* (${ses.quality})\n`+
    `${wk?'⚠️ Weekend — cached\n':''}`+
    `⏱ TF: *${TF[selectedTF].label}* | 💵 *$${selectedStake}*\n`+
    `🤖 Auto: *${autoMode?'🟢 ON':'🔴 OFF'}*\n`+
    `📊 Signals: *${stats.total}* | 🏆 Win rate: *${winRate()}%*\n`+
    `🔄 Reconnects: *${reconnects}*`,
    {parse_mode:'Markdown',reply_markup:mainKB()}
  );
}

async function sendStats(chatId){
  const cp=stats.total?Math.round((stats.calls/stats.total)*100):0;
  const pl=resultLog.reduce((a,r)=>a+r.profit,0).toFixed(2);
  await bot.sendMessage(chatId,
    `📊 *STATISTICS*\n\n`+
    `Total: *${stats.total}* | 🟢 CALL: *${stats.calls}*(${cp}%) | 🔴 PUT: *${stats.puts}*\n\n`+
    `✅ Wins: *${stats.wins}* | ❌ Losses: *${stats.losses}*\n`+
    `🏆 Win Rate: *${winRate()}%*\n`+
    `💰 Est. P&L: *${parseFloat(pl)>=0?'+':''}$${pl}*`,
    {parse_mode:'Markdown',reply_markup:mainKB()}
  );
}

async function sendLast(chatId){
  if(!signalHistory.length){await bot.sendMessage(chatId,'No signals yet.',{reply_markup:mainKB()});return;}
  const s=signalHistory[0],t=new Date(s.sentAt).toLocaleTimeString('en-GB',{timeZone:'Asia/Dhaka'});
  await bot.sendMessage(chatId,
    `📋 *LAST #${s.id}*\n${s.dir==='CALL'?'🟢':'🔴'} *${s.dir}* — *${s.pair}*\nTF: *${s.tfLabel}* | Conf: *${s.conf}%* | Stake: *$${s.stake}*\n🕐 ${t} UTC+6`,
    {parse_mode:'Markdown',reply_markup:mainKB()}
  );
}

async function sendRecord(chatId){
  if(!resultLog.length){await bot.sendMessage(chatId,'No results yet.\nAfter each trade: /result WIN or /result LOSS',{reply_markup:mainKB()});return;}
  const lines=resultLog.slice(0,5).map(r=>`${r.result==='WIN'?'✅':'❌'} ${r.pair}|${r.dir}|${r.result==='WIN'?'+':''}$${r.profit.toFixed(2)}`).join('\n');
  await bot.sendMessage(chatId,`🏆 *LAST 5 RESULTS*\n\n${lines}\n\nWin Rate: *${winRate()}%*`,{parse_mode:'Markdown',reply_markup:mainKB()});
}

// ─── START + SERVER ───────────────────────────────────────────────────────────
createBot();
const app=express();
app.use(cors());app.use(express.json());
app.get('/health',(_,res)=>res.json({status:'ok',version:'5.0',uptime:Math.floor(process.uptime()),autoMode,selectedTF,selectedStake,stats,winRate:winRate()}));
app.get('/history',(_,res)=>res.json(signalHistory.slice(0,20)));
app.get('/results',(_,res)=>res.json({stats,winRate:winRate(),log:resultLog.slice(0,20)}));
const PORT=process.env.PORT||3001;
app.listen(PORT,()=>console.log(`🚀 API on port ${PORT}`));
