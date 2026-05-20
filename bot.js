// ============================================
// POCKET OPTION BOT - FINAL WORKING VERSION
// USD/MXN REMOVED - TELEGRAM INTERFACE ACTIVE
// ============================================

const { analyzeSignal } = require('./analyzer.js');
const https = require('https');
const fs = require('fs');

// ============================================
// CONFIGURATION - READ FROM ENVIRONMENT
// ============================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ============================================
// FOREX PAIRS - USD/MXN REMOVED (27 PAIRS)
// ============================================
const PAIRS = [
    { name: 'EUR/USD', symbol: 'EURUSD=X' },
    { name: 'GBP/USD', symbol: 'GBPUSD=X' },
    { name: 'AUD/USD', symbol: 'AUDUSD=X' },
    { name: 'NZD/USD', symbol: 'NZDUSD=X' },
    { name: 'USD/CAD', symbol: 'USDCAD=X' },
    { name: 'USD/CHF', symbol: 'USDCHF=X' },
    { name: 'USD/JPY', symbol: 'USDJPY=X' },
    { name: 'AUD/CAD', symbol: 'AUDCAD=X' },
    { name: 'AUD/JPY', symbol: 'AUDJPY=X' },
    { name: 'CAD/JPY', symbol: 'CADJPY=X' },
    { name: 'CHF/JPY', symbol: 'CHFJPY=X' },
    { name: 'EUR/AUD', symbol: 'EURAUD=X' },
    { name: 'EUR/CAD', symbol: 'EURCAD=X' },
    { name: 'EUR/CHF', symbol: 'EURCHF=X' },
    { name: 'EUR/GBP', symbol: 'EURGBP=X' },
    { name: 'EUR/JPY', symbol: 'EURJPY=X' },
    { name: 'EUR/NZD', symbol: 'EURNZD=X' },
    { name: 'GBP/AUD', symbol: 'GBPAUD=X' },
    { name: 'GBP/CAD', symbol: 'GBPCAD=X' },
    { name: 'GBP/CHF', symbol: 'GBPCHF=X' },
    { name: 'GBP/JPY', symbol: 'GBPJPY=X' },
    { name: 'GBP/NZD', symbol: 'GBPNZD=X' },
    { name: 'NZD/CAD', symbol: 'NZDCAD=X' },
    { name: 'NZD/JPY', symbol: 'NZDJPY=X' },
    { name: 'AUD/NZD', symbol: 'AUDNZD=X' },
    { name: 'CAD/CHF', symbol: 'CADCHF=X' },
    { name: 'AUD/CHF', symbol: 'AUDCHF=X' }
];

// CONFIGURATION
const MIN_CONFIDENCE = 55;
const DELAY_BETWEEN_PAIRS_MS = 500;

let lastUpdateId = 0;
let botStartTime = Date.now();
let isScanning = false;

// ============================================
// TELEGRAM SEND MESSAGE
// ============================================
function sendTelegramMessage(text) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log(`\n❌ TELEGRAM NOT CONFIGURED!`);
        console.log(`   Please set environment variables:`);
        console.log(`   TELEGRAM_BOT_TOKEN=your_token`);
        console.log(`   TELEGRAM_CHAT_ID=your_chat_id`);
        console.log(`\n📱 MESSAGE (would send to Telegram):\n${text}\n`);
        return false;
    }
    
    console.log(`📤 Sending to Telegram...`);
    
    const data = JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
    });
    
    const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Content-Length': data.length
        }
    }, (res) => {
        let responseData = '';
        res.on('data', chunk => responseData += chunk);
        res.on('end', () => {
            if (res.statusCode === 200) {
                console.log('✅ Telegram message sent successfully');
            } else {
                console.log(`❌ Telegram error: ${res.statusCode}`);
            }
        });
    });
    
    req.on('error', (e) => {
        console.log(`❌ Telegram request failed: ${e.message}`);
    });
    
    req.write(data);
    req.end();
    return true;
}

// ============================================
// TEST TELEGRAM CONNECTION ON STARTUP
// ============================================
function testTelegramConnection() {
    console.log('\n🔍 TESTING TELEGRAM CONNECTION...');
    
    if (!TELEGRAM_TOKEN) {
        console.log('❌ TELEGRAM_BOT_TOKEN is NOT set!');
        return false;
    }
    
    if (!TELEGRAM_CHAT_ID) {
        console.log('❌ TELEGRAM_CHAT_ID is NOT set!');
        return false;
    }
    
    console.log(`✅ Token found: ${TELEGRAM_TOKEN.substring(0, 10)}...`);
    console.log(`✅ Chat ID found: ${TELEGRAM_CHAT_ID}`);
    
    const testMessage = `🏆 <b>POCKET OPTION BOT IS ONLINE!</b> 🏆

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ <b>STATUS:</b> OPERATIONAL
✅ <b>PAIRS:</b> ${PAIRS.length} FOREX PAIRS
✅ <b>AUTO-SCAN:</b> 15 MINUTE (every 15 min)
✅ <b>MIN CONFIDENCE:</b> ${MIN_CONFIDENCE}%
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

<b>📋 TELEGRAM COMMANDS:</b>
/start - Welcome & menu
/status - Bot status
/scan - Manual scan (15m)
/scan5m - Manual scan (5m)
/scan1h - Manual scan (1h)
/help - All commands

<b>⚡ Bot will send signals automatically every 15 minutes</b>`;
    
    sendTelegramMessage(testMessage);
    return true;
}

// ============================================
// FORMAT SIGNAL MESSAGE (COMPLETE INTERFACE)
// ============================================
function formatSignalMessage(analysis, pairName, timeframe, isAuto = false) {
    const arrow = analysis.signal === 'CALL' ? '📈' : '📉';
    const signalText = analysis.signal === 'CALL' ? '🟢 CALL (UP)' : '🔴 PUT (DOWN)';
    
    let message = '';
    
    // Header
    if (isAuto) {
        message += `🤖 <b>AUTO SIGNAL - 15M PRIMARY</b> 🤖\n`;
    } else {
        message += `${arrow} <b>MANUAL SCAN SIGNAL</b> ${arrow}\n`;
    }
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `<b>📊 ${pairName}</b> | [${timeframe}]\n`;
    message += `<b>🎯 ${signalText}</b>\n`;
    message += `<b>⭐ CONFIDENCE:</b> ${analysis.confidence}% | <b>PROBABILITY:</b> ${analysis.probability || analysis.confidence}%\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    
    // TECHNICAL REASONING
    message += `<b>📊 TECHNICAL REASONING WHY ${analysis.signal === 'CALL' ? 'CALL' : 'PUT'}:</b>\n\n`;
    
    // 1. RSI Analysis
    let rsiValue = parseFloat(analysis.rsi);
    let rsiReason = '';
    if (rsiValue < 30) rsiReason = `RSI is OVERSOLD (${analysis.rsi}) → Price likely to bounce UP`;
    else if (rsiValue > 70) rsiReason = `RSI is OVERBOUGHT (${analysis.rsi}) → Price likely to drop DOWN`;
    else if (analysis.signal === 'CALL' && rsiValue < 40) rsiReason = `RSI is low (${analysis.rsi}) → Bullish momentum building`;
    else if (analysis.signal === 'PUT' && rsiValue > 60) rsiReason = `RSI is high (${analysis.rsi}) → Bearish momentum building`;
    else rsiReason = `RSI at ${analysis.rsi} → Neutral momentum`;
    message += `1️⃣ <b>RSI ANALYSIS:</b>\n   ${rsiReason}\n\n`;
    
    // 2. Divergence
    if (analysis.divergence !== 'None') {
        message += `2️⃣ <b>DIVERGENCE DETECTED:</b>\n`;
        if (analysis.divergence === 'Bullish') {
            message += `   🔄 BULLISH DIVERGENCE (Quality: ${analysis.divergenceQuality}/100)\n`;
            message += `   → Price made LOWER LOW\n`;
            message += `   → RSI made HIGHER LOW\n`;
            message += `   → Classic reversal pattern signaling UPSIDE\n\n`;
        } else {
            message += `   🔄 BEARISH DIVERGENCE (Quality: ${analysis.divergenceQuality}/100)\n`;
            message += `   → Price made HIGHER HIGH\n`;
            message += `   → RSI made LOWER HIGH\n`;
            message += `   → Classic reversal pattern signaling DOWNSIDE\n\n`;
        }
    } else {
        message += `2️⃣ <b>DIVERGENCE:</b>\n   No divergence detected\n\n`;
    }
    
    // 3. Trend Analysis
    message += `3️⃣ <b>TREND ANALYSIS:</b>\n`;
    message += `   Market Trend: ${analysis.trendDirection}\n`;
    message += `   Signal Direction: ${analysis.signal}\n`;
    if (analysis.trendAlignment === 'WITH TREND ✅') {
        message += `   ✅ Trading WITH the trend → Higher probability\n`;
    } else if (analysis.trendAlignment === 'AGAINST TREND ⚠️') {
        message += `   ⚠️ Trading AGAINST trend → Higher risk-reward\n`;
    } else {
        message += `   ⚪ No clear trend direction\n`;
    }
    message += `\n`;
    
    // 4. Volume Analysis
    message += `4️⃣ <b>VOLUME & ORDER FLOW:</b>\n`;
    message += `   Volume Ratio: ${analysis.volumeRatio}x average\n`;
    message += `   Flow Imbalance: ${analysis.volumeImbalance}\n`;
    let flowAnalysis = parseFloat(analysis.volumeImbalance);
    if (flowAnalysis > 15) message += `   → Strong buying pressure detected\n`;
    else if (flowAnalysis < -15) message += `   → Strong selling pressure detected\n`;
    else message += `   → Balanced order flow\n`;
    message += `\n`;
    
    // 5. ADX Analysis
    let adxValue = parseFloat(analysis.adx);
    message += `5️⃣ <b>TREND STRENGTH (ADX):</b>\n`;
    if (adxValue >= 40) message += `   ADX: ${analysis.adx} (EXTREME TREND) → Strong directional movement\n`;
    else if (adxValue >= 25) message += `   ADX: ${analysis.adx} (STRONG TREND) → Good trend following\n`;
    else if (adxValue >= 18) message += `   ADX: ${analysis.adx} (WEAK TREND) → Mean reversion likely\n`;
    else message += `   ADX: ${analysis.adx} (SIDEWAYS) → Range-bound market\n`;
    message += `\n`;
    
    // 6. Session Analysis
    message += `6️⃣ <b>SESSION ANALYSIS:</b>\n`;
    message += `   Session: ${analysis.session}\n`;
    message += `   Multiplier: ${analysis.sessionMultiplier || '1.00'}x\n`;
    if (analysis.session === 'LONDON_NY_OVERLAP') message += `   → BEST trading session - High liquidity\n`;
    else if (analysis.session === 'LONDON_OPEN') message += `   → GOOD liquidity - London open\n`;
    else if (analysis.session === 'ASIAN') message += `   → Lower volatility - Asian session\n`;
    else message += `   → Reduced liquidity - Off hours\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    
    // Trade Execution
    message += `<b>💰 TRADE EXECUTION:</b>\n`;
    message += `   🎯 ACTION: ${analysis.signal === 'CALL' ? 'BUY CALL OPTION' : 'BUY PUT OPTION'}\n`;
    message += `   ⏱️  EXPIRY: ${analysis.expiry} MINUTES\n`;
    message += `   📊 Strategy: ${analysis.strategyUsed}\n`;
    message += `   🔢 Ensemble Factors: ${analysis.ensembleVotes || 5}/6 active\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    
    // Risk Management
    message += `<b>🛡️ RISK MANAGEMENT:</b>\n`;
    message += `   Stop Loss: ${analysis.stopLossPips} pips\n`;
    message += `   Take Profit: ${analysis.takeProfitPips} pips\n`;
    message += `   Risk Amount: ${analysis.riskAmount}\n`;
    message += `   Risk/Reward: ${analysis.riskReward}\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    
    // Final Verdict
    message += `<b>${analysis.recommendation}</b>\n`;
    message += `<b>${analysis.shouldTrade}</b>\n`;
    message += `🕐 ${new Date().toLocaleString()}`;
    
    return message;
}

// ============================================
// YAHOO FINANCE FETCHER
// ============================================
async function fetchYahooFinance(symbol, interval = '15m') {
    return new Promise((resolve) => {
        let period1;
        switch(interval) {
            case '1m': period1 = Math.floor((Date.now() / 1000) - (1 * 24 * 60 * 60)); break;
            case '5m': period1 = Math.floor((Date.now() / 1000) - (3 * 24 * 60 * 60)); break;
            case '15m': period1 = Math.floor((Date.now() / 1000) - (7 * 24 * 60 * 60)); break;
            case '30m': period1 = Math.floor((Date.now() / 1000) - (14 * 24 * 60 * 60)); break;
            case '1h': period1 = Math.floor((Date.now() / 1000) - (30 * 24 * 60 * 60)); break;
            case '4h': period1 = Math.floor((Date.now() / 1000) - (60 * 24 * 60 * 60)); break;
            default: period1 = Math.floor((Date.now() / 1000) - (7 * 24 * 60 * 60));
        }
        const period2 = Math.floor(Date.now() / 1000);
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=${interval}`;
        
        const request = https.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (!json.chart?.result?.[0]) { resolve(null); return; }
                    const result = json.chart.result[0];
                    const quotes = result.indicators.quote[0];
                    if (!quotes || !quotes.open) { resolve(null); return; }
                    const candles = [];
                    for (let i = 0; i < result.timestamp.length; i++) {
                        if (quotes.open[i] && quotes.high[i] && quotes.low[i] && quotes.close[i]) {
                            candles.push({
                                open: quotes.open[i],
                                high: quotes.high[i],
                                low: quotes.low[i],
                                close: quotes.close[i],
                                volume: quotes.volume[i] || 1000,
                                time: result.timestamp[i] * 1000
                            });
                        }
                    }
                    resolve(candles.length > 0 ? { values: candles } : null);
                } catch(e) { resolve(null); }
            });
        });
        request.on('error', () => { resolve(null); });
        request.setTimeout(10000, () => { request.destroy(); resolve(null); });
    });
}

async function analyzePair(pair, timeframe = '15min') {
    try {
        let yahooInterval = '15m';
        if (timeframe === '1min') yahooInterval = '1m';
        else if (timeframe === '5min') yahooInterval = '5m';
        else if (timeframe === '15min') yahooInterval = '15m';
        else if (timeframe === '30min') yahooInterval = '30m';
        else if (timeframe === '1h') yahooInterval = '1h';
        else if (timeframe === '4h') yahooInterval = '1h';
        
        const data = await fetchYahooFinance(pair.symbol, yahooInterval);
        if (!data || !data.values || data.values.length < 30) return null;
        
        const analysis = await analyzeSignal(data, { pairName: pair.name }, timeframe);
        return analysis;
    } catch(e) {
        return null;
    }
}

// ============================================
// AUTO SCAN 15M (EVERY 15 MINUTES)
// ============================================
async function autoScan15m() {
    if (isScanning) return;
    isScanning = true;
    
    console.log(`\n🔄 AUTO-SCAN [15 MINUTE] - ${new Date().toLocaleTimeString()}`);
    sendTelegramMessage(`🔄 <b>15m AUTO-SCAN STARTED</b>\nScanning ${PAIRS.length} pairs...`);
    
    let signalsFound = 0;
    
    for (const pair of PAIRS) {
        const analysis = await analyzePair(pair, '15min');
        if (analysis && analysis.confidence >= MIN_CONFIDENCE && analysis.signal !== 'NEUTRAL') {
            signalsFound++;
            const message = formatSignalMessage(analysis, pair.name, '15m', true);
            sendTelegramMessage(message);
            console.log(`🔔 SIGNAL: ${pair.name} - ${analysis.signal} @ ${analysis.confidence}%`);
            await new Promise(r => setTimeout(r, 1000));
        }
        await new Promise(r => setTimeout(r, DELAY_BETWEEN_PAIRS_MS));
    }
    
    console.log(`✅ AUTO-SCAN complete: ${signalsFound} signals`);
    if (signalsFound === 0) {
        sendTelegramMessage(`✅ <b>15m AUTO-SCAN COMPLETE</b>\nNo signals above ${MIN_CONFIDENCE}% this cycle.`);
    } else {
        sendTelegramMessage(`✅ <b>15m AUTO-SCAN COMPLETE</b>\nFound ${signalsFound} signals. Check above for details.`);
    }
    isScanning = false;
}

// ============================================
// MANUAL SCAN (ANY TIMEFRAME)
// ============================================
async function manualScan(timeframe = '15min') {
    if (isScanning) {
        sendTelegramMessage("⏳ Scan already in progress. Please wait.");
        return;
    }
    isScanning = true;
    
    const tfDisplay = timeframe === '15min' ? '15m' : timeframe === '5min' ? '5m' : timeframe === '1h' ? '1h' : timeframe;
    sendTelegramMessage(`🔍 <b>MANUAL SCAN [${tfDisplay}]</b>\nScanning ${PAIRS.length} pairs...`);
    
    let signals = 0;
    for (const pair of PAIRS) {
        const analysis = await analyzePair(pair, timeframe);
        if (analysis && analysis.confidence >= MIN_CONFIDENCE && analysis.signal !== 'NEUTRAL') {
            signals++;
            const message = formatSignalMessage(analysis, pair.name, tfDisplay, false);
            sendTelegramMessage(message);
            await new Promise(r => setTimeout(r, 1000));
        }
        await new Promise(r => setTimeout(r, DELAY_BETWEEN_PAIRS_MS));
    }
    
    if (signals === 0) {
        sendTelegramMessage(`✅ <b>MANUAL SCAN [${tfDisplay}] COMPLETE</b>\nNo signals above ${MIN_CONFIDENCE}%.`);
    } else {
        sendTelegramMessage(`✅ <b>MANUAL SCAN [${tfDisplay}] COMPLETE</b>\nFound ${signals} signals. Check above for details.`);
    }
    isScanning = false;
}

// ============================================
// TELEGRAM COMMAND HANDLER (INTERFACE)
// ============================================
function handleCommand(text) {
    console.log(`📥 Command received: ${text}`);
    const cmd = text.toLowerCase().trim();
    
    if (cmd === '/start') {
        sendTelegramMessage(`🏆 <b>POCKET OPTION LEGENDARY BOT</b> 🏆
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ <b>STATUS:</b> ONLINE 🟢
✅ <b>DATA:</b> YAHOO FINANCE (LIVE)
✅ <b>PAIRS:</b> ${PAIRS.length} FOREX PAIRS
✅ <b>AUTO-SCAN:</b> 15 MINUTE (every 15 min)
✅ <b>MANUAL TFs:</b> 1m, 5m, 15m, 30m, 1h, 4h
✅ <b>MIN CONFIDENCE:</b> ${MIN_CONFIDENCE}%
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

<b>📋 AVAILABLE COMMANDS:</b>

┌─────────────────────────────────────┐
│ <b>📊 STATUS & INFO</b>                 │
├─────────────────────────────────────┤
│ /start  - Welcome & menu            │
│ /status - Bot status                │
│ /help   - All commands              │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│ <b>🔍 MANUAL SCAN</b>                    │
├─────────────────────────────────────┤
│ /scan   - Scan all pairs (15m)      │
│ /scan5m - Scan all pairs (5m)       │
│ /scan1h - Scan all pairs (1h)       │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│ <b>🤖 AUTO-SCAN CONTROL</b>              │
├─────────────────────────────────────┤
│ Auto-scan runs EVERY 15 minutes     │
│ No command needed - fully automatic │
└─────────────────────────────────────┘

<b>📊 SIGNAL INCLUDES:</b>
✅ RSI with interpretation
✅ ADX with trend strength  
✅ Divergence detection
✅ Volume flow analysis
✅ Session multiplier
✅ Position sizing (SL/TP)
✅ Complete technical reasoning

<i>Bot will send signals automatically every 15 minutes</i>`);
    }
    else if (cmd === '/status') {
        const uptimeHours = Math.floor((Date.now() - botStartTime) / 1000 / 60 / 60);
        const uptimeMinutes = Math.floor((Date.now() - botStartTime) / 1000 / 60) % 60;
        
        sendTelegramMessage(`📊 <b>BOT STATUS REPORT</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⏱️ <b>Uptime:</b> ${uptimeHours}h ${uptimeMinutes}m
📡 <b>Data Source:</b> Yahoo Finance (LIVE)
👥 <b>Monitored Pairs:</b> ${PAIRS.length}
🎯 <b>Auto-Scan:</b> 15 MINUTE (every 15 min)
📈 <b>Min Confidence:</b> ${MIN_CONFIDENCE}%
🔄 <b>Scan Status:</b> ${isScanning ? 'SCANNING...' : 'IDLE'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Bot is fully operational

<i>Signals will appear here automatically when detected</i>`);
    }
    else if (cmd === '/scan') {
        manualScan('15min');
    }
    else if (cmd === '/scan5m') {
        manualScan('5min');
    }
    else if (cmd === '/scan1h') {
        manualScan('1h');
    }
    else if (cmd === '/help') {
        sendTelegramMessage(`📋 <b>COMPLETE COMMAND LIST</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

<b>📊 STATUS COMMANDS:</b>
/start  - Welcome message with menu
/status - Show bot status
/help   - Show this help menu

<b>🔍 MANUAL SCAN COMMANDS:</b>
/scan   - Scan all ${PAIRS.length} pairs on 15m
/scan5m - Scan all pairs on 5m timeframe
/scan1h - Scan all pairs on 1h timeframe

<b>🤖 AUTO-SCAN:</b>
Auto-scan runs automatically EVERY 15 MINUTES
No manual control needed - just wait for signals!

<b>📊 WHAT EACH SIGNAL INCLUDES:</b>
• RSI (Oversold/Overbought analysis)
• ADX (Trend strength: Strong/Weak/Sideways)
• Divergence (Bullish/Bearish with quality %)
• Trend direction with alignment
• Volume flow and order imbalance
• Session analysis with multiplier
• Stop Loss & Take Profit levels
• Risk/Reward ratio
• Complete technical reasoning

<b>⏰ TIMEFRAMES:</b>
AUTO-SCAN: 15 MINUTE ONLY ⭐
MANUAL SCAN: 1m, 5m, 15m, 30m, 1h, 4h

<i>Bot sends signals automatically every 15 minutes</i>`);
    }
    else {
        sendTelegramMessage(`❌ <b>Unknown command:</b> ${text}

Type <b>/help</b> to see all available commands.

Available commands:
/start - Welcome menu
/status - Bot status
/scan - Manual scan (15m)
/scan5m - Manual scan (5m)
/scan1h - Manual scan (1h)
/help - This help menu`);
    }
}

// ============================================
// TELEGRAM POLLING (getUpdates method)
// ============================================
function pollTelegram() {
    if (!TELEGRAM_TOKEN) {
        console.log('❌ No TELEGRAM_TOKEN - Cannot poll');
        return;
    }
    
    console.log('📡 Starting Telegram polling...');
    console.log('💡 Send /start to your bot on Telegram to test');
    
    const poll = () => {
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`;
        
        const req = https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.ok && json.result) {
                        for (const update of json.result) {
                            lastUpdateId = update.update_id;
                            const messageText = update.message?.text;
                            const chatId = update.message?.chat?.id;
                            
                            if (chatId && TELEGRAM_CHAT_ID && chatId.toString() !== TELEGRAM_CHAT_ID) {
                                console.log(`⚠️ Unauthorized chat: ${chatId}`);
                                continue;
                            }
                            
                            if (messageText) {
                                handleCommand(messageText);
                            }
                        }
                    }
                } catch(e) {
                    console.log(`Polling error: ${e.message}`);
                }
                setTimeout(poll, 2000);
            });
        });
        
        req.on('error', (e) => {
            console.log(`Polling request error: ${e.message}`);
            setTimeout(poll, 5000);
        });
        
        req.end();
    };
    
    poll();
}

// ============================================
// START BOT
// ============================================
console.log('\n' + '█'.repeat(70));
console.log('🏆 POCKET OPTION LEGENDARY BOT');
console.log('█'.repeat(70));
console.log(`📊 Pairs: ${PAIRS.length} (USD/MXN REMOVED)`);
console.log(`🎯 Min Confidence: ${MIN_CONFIDENCE}%`);
console.log(`🤖 Auto-scan: 15m (every 15 min)`);
console.log(`📡 Manual TFs: 1m, 5m, 15m, 30m, 1h, 4h`);
console.log('█'.repeat(70) + '\n');

console.log('📋 VALID PAIRS (27 pairs):');
PAIRS.forEach((p, i) => {
    console.log(`   ${(i+1).toString().padStart(2)}. ${p.name}`);
});
console.log('');

// Test Telegram connection
testTelegramConnection();

// Start Telegram polling
if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    pollTelegram();
} else {
    console.log('\n⚠️ TELEGRAM NOT CONFIGURED!');
    console.log('   To fix, add these environment variables in Railway:');
    console.log('   1. TELEGRAM_BOT_TOKEN = your_bot_token');
    console.log('   2. TELEGRAM_CHAT_ID = your_chat_id');
    console.log('\n   How to get them:');
    console.log('   - Talk to @BotFather on Telegram to create bot and get token');
    console.log('   - Send message to your bot, then visit:');
    console.log('     https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates');
    console.log('   - Copy your chat_id from the response\n');
}

// Start auto-scan after 10 seconds
setTimeout(() => {
    console.log('📊 Starting 15m auto-scan...');
    sendTelegramMessage('🤖 <b>15m AUTO-SCAN ENABLED</b>\n\nI will now scan all pairs every 15 minutes and send signals when detected.\n\nFirst scan starting now...');
    autoScan15m();
    setInterval(autoScan15m, 15 * 60 * 1000);
}, 10000);

// Keep alive
setInterval(() => {
    const uptimeMin = Math.floor((Date.now() - botStartTime) / 1000 / 60);
    console.log(`💓 Bot alive | Uptime: ${uptimeMin} min | Pairs: ${PAIRS.length}`);
}, 60000);

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Bot shutting down...');
    sendTelegramMessage('🛑 <b>Bot is shutting down</b>\n\nNo further signals will be sent.');
    setTimeout(() => process.exit(0), 2000);
});
