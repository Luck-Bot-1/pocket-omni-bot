// ============================================
// POCKET OPTION LEGENDARY BOT v24.0
// TELEGRAM DASHBOARD - 15M AUTO SCAN ONLY
// ============================================

const { analyzeSignal } = require('./analyzer.js');
const https = require('https');
const fs = require('fs');

// ============================================
// CONFIGURATION
// ============================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const ULTIMATE_CONFIG = {
    MIN_CONFIDENCE: 55,
    DELAY_BETWEEN_PAIRS_MS: 500,
    USE_YAHOO_FINANCE: true,
    DEBUG_MODE: true,
    
    ALLOWED_TIMEFRAMES: ['1m', '5m', '15m', '30m', '1h', '4h'],
    DEFAULT_TIMEFRAME: '15m',
    
    // AUTO-SCAN: ONLY 15 MINUTE
    AUTO_SCAN_ENABLED: true,
    AUTO_SCAN_INTERVAL_MINUTES: 15,
    AUTO_SCAN_TIMEFRAME: '15m',
    
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 1000,
    REQUEST_TIMEOUT_MS: 15000
};

// ============================================
// FOREX PAIRS - 28 VALID PAIRS
// ============================================
const PAIRS = [
    { name: 'EUR/USD', symbol: 'EURUSD=X', enabled: true },
    { name: 'GBP/USD', symbol: 'GBPUSD=X', enabled: true },
    { name: 'AUD/USD', symbol: 'AUDUSD=X', enabled: true },
    { name: 'NZD/USD', symbol: 'NZDUSD=X', enabled: true },
    { name: 'USD/CAD', symbol: 'USDCAD=X', enabled: true },
    { name: 'USD/CHF', symbol: 'USDCHF=X', enabled: true },
    { name: 'USD/JPY', symbol: 'USDJPY=X', enabled: true },
    { name: 'AUD/CAD', symbol: 'AUDCAD=X', enabled: true },
    { name: 'AUD/JPY', symbol: 'AUDJPY=X', enabled: true },
    { name: 'CAD/JPY', symbol: 'CADJPY=X', enabled: true },
    { name: 'CHF/JPY', symbol: 'CHFJPY=X', enabled: true },
    { name: 'EUR/AUD', symbol: 'EURAUD=X', enabled: true },
    { name: 'EUR/CAD', symbol: 'EURCAD=X', enabled: true },
    { name: 'EUR/CHF', symbol: 'EURCHF=X', enabled: true },
    { name: 'EUR/GBP', symbol: 'EURGBP=X', enabled: true },
    { name: 'EUR/JPY', symbol: 'EURJPY=X', enabled: true },
    { name: 'EUR/NZD', symbol: 'EURNZD=X', enabled: true },
    { name: 'GBP/AUD', symbol: 'GBPAUD=X', enabled: true },
    { name: 'GBP/CAD', symbol: 'GBPCAD=X', enabled: true },
    { name: 'GBP/CHF', symbol: 'GBPCHF=X', enabled: true },
    { name: 'GBP/JPY', symbol: 'GBPJPY=X', enabled: true },
    { name: 'GBP/NZD', symbol: 'GBPNZD=X', enabled: true },
    { name: 'NZD/CAD', symbol: 'NZDCAD=X', enabled: true },
    { name: 'NZD/JPY', symbol: 'NZDJPY=X', enabled: true },
    { name: 'AUD/NZD', symbol: 'AUDNZD=X', enabled: true },
    { name: 'CAD/CHF', symbol: 'CADCHF=X', enabled: true },
    { name: 'AUD/CHF', symbol: 'AUDCHF=X', enabled: true },
    { name: 'USD/MXN', symbol: 'USDMXN=X', enabled: true }
];

// ============================================
// STATE
// ============================================
let autoScanInterval = null;
let isScanning = false;
let lastUpdateId = 0;
let botStartTime = Date.now();
let currentManualTimeframe = '15m';

// ============================================
// LOGGING
// ============================================
function log(msg, level = 'INFO') {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] [${level}] ${msg}`);
    try {
        fs.appendFileSync('bot.log', `[${new Date().toISOString()}] [${level}] ${msg}\n`);
    } catch(e) {}
}

// ============================================
// TELEGRAM MESSAGING
// ============================================
function sendTelegramMessage(text) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log(`\n📱 TELEGRAM (MOCK):\n${text}\n`);
        return false;
    }
    
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
        headers: { 'Content-Type': 'application/json' }
    });
    
    req.on('error', (e) => log(`Telegram error: ${e.message}`, 'ERROR'));
    req.write(data);
    req.end();
    
    return true;
}

// ============================================
// FORMAT SIGNAL WITH TECHNICAL REASONING
// ============================================
function formatTelegramSignal(analysis, pairName, timeframe, isAuto = false) {
    const arrow = analysis.signal === 'CALL' ? '📈' : '📉';
    const signalEmoji = analysis.signal === 'CALL' ? '🟢 CALL (UP)' : '🔴 PUT (DOWN)';
    
    let message = '';
    
    // Header
    if (isAuto) {
        message += `🤖 <b>AUTO SIGNAL - 15M PRIMARY</b> 🤖\n`;
    } else {
        message += `${arrow} <b>MANUAL SCAN SIGNAL</b> ${arrow}\n`;
    }
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `<b>📊 ${pairName}</b> | [${analysis.timeframe || timeframe}]\n`;
    message += `<b>🎯 ${signalEmoji}</b>\n`;
    message += `<b>⭐ CONFIDENCE:</b> ${analysis.confidence}% | <b>PROBABILITY:</b> ${analysis.probability}%\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    
    // Technical Reasoning
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
            message += `   → Price made LOWER LOW, RSI made HIGHER LOW\n`;
            message += `   → Classic reversal pattern signaling UPSIDE\n\n`;
        } else {
            message += `   🔄 BEARISH DIVERGENCE (Quality: ${analysis.divergenceQuality}/100)\n`;
            message += `   → Price made HIGHER HIGH, RSI made LOWER HIGH\n`;
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
        message += `   ✅ Trading WITH the trend → +12% confidence bonus\n`;
    } else if (analysis.trendAlignment === 'AGAINST TREND ⚠️') {
        message += `   ⚠️ Trading AGAINST trend → Higher risk-reward potential\n`;
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
    else if (adxValue >= 25) message += `   ADX: ${analysis.adx} (STRONG TREND) → Good trend following opportunity\n`;
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
// YAHOO FINANCE DATA FETCHER
// ============================================
async function fetchYahooFinanceWithRetry(symbol, interval, retries = ULTIMATE_CONFIG.MAX_RETRIES) {
    for (let i = 0; i < retries; i++) {
        const result = await fetchYahooFinance(symbol, interval);
        if (result) return result;
        if (i < retries - 1) {
            await new Promise(r => setTimeout(r, ULTIMATE_CONFIG.RETRY_DELAY_MS));
        }
    }
    return null;
}

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
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (!json.chart?.result?.[0]) { resolve(null); return; }
                    const result = json.chart.result[0];
                    const timestamps = result.timestamp;
                    const quotes = result.indicators.quote[0];
                    if (!timestamps || !quotes || !quotes.open) { resolve(null); return; }
                    const candles = [];
                    for (let i = 0; i < timestamps.length; i++) {
                        if (quotes.open[i] && quotes.high[i] && quotes.low[i] && quotes.close[i]) {
                            candles.push({
                                open: quotes.open[i], high: quotes.high[i], low: quotes.low[i],
                                close: quotes.close[i], volume: quotes.volume[i] || 1000,
                                time: timestamps[i] * 1000
                            });
                        }
                    }
                    resolve(candles.length > 0 ? { values: candles } : null);
                } catch(e) { resolve(null); }
            });
        });
        request.on('error', () => { resolve(null); });
        request.setTimeout(ULTIMATE_CONFIG.REQUEST_TIMEOUT_MS, () => { request.destroy(); resolve(null); });
    });
}

async function fetchPriceData(pair, interval = '15min') {
    let yahooInterval;
    switch(interval) {
        case '1min': yahooInterval = '1m'; break;
        case '5min': yahooInterval = '5m'; break;
        case '15min': yahooInterval = '15m'; break;
        case '30min': yahooInterval = '30m'; break;
        case '1h': yahooInterval = '1h'; break;
        case '4h': yahooInterval = '1h'; break;
        default: yahooInterval = '15m';
    }
    return await fetchYahooFinanceWithRetry(pair.symbol, yahooInterval);
}

// ============================================
// ANALYZE PAIR
// ============================================
async function analyzePair(pairData, timeframe = '15min', accountBalance = 10000) {
    try {
        const data = await fetchPriceData(pairData, timeframe);
        if (!data || !data.values || data.values.length < 30) {
            return null;
        }
        
        const analysis = await analyzeSignal(data, { pairName: pairData.name }, timeframe, null, null, [], accountBalance);
        return analysis;
    } catch(e) { 
        return null; 
    }
}

// ============================================
// MANUAL SCAN - ALL TIMEFRAMES
// ============================================
async function scanAllPairs(timeframe = null) {
    if (isScanning) { 
        sendTelegramMessage("⏳ Scan already in progress");
        return; 
    }
    isScanning = true;
    
    const scanTimeframe = timeframe || currentManualTimeframe;
    const tfName = scanTimeframe.toUpperCase();
    
    sendTelegramMessage(`🔍 MANUAL SCAN: ${PAIRS.length} pairs on [${tfName}]...`);
    log(`========== MANUAL SCAN [${scanTimeframe}] STARTED ==========`);
    
    let signals = 0;
    
    for (const pair of PAIRS) {
        const analysis = await analyzePair(pair, scanTimeframe);
        if (analysis && analysis.confidence >= ULTIMATE_CONFIG.MIN_CONFIDENCE && analysis.signal !== 'NEUTRAL') {
            signals++;
            const message = formatTelegramSignal(analysis, pair.name, scanTimeframe, false);
            sendTelegramMessage(message);
            log(`📤 SIGNAL: ${pair.name} - ${analysis.signal} @ ${analysis.confidence}%`);
            await new Promise(r => setTimeout(r, 1000));
        }
        await new Promise(r => setTimeout(r, ULTIMATE_CONFIG.DELAY_BETWEEN_PAIRS_MS));
    }
    
    log(`========== MANUAL SCAN COMPLETE: ${signals} signals ==========`);
    
    if (signals === 0) {
        sendTelegramMessage(`✅ Manual scan [${tfName}] complete: No signals above ${ULTIMATE_CONFIG.MIN_CONFIDENCE}%`);
    } else {
        sendTelegramMessage(`✅ Manual scan [${tfName}] complete: ${signals} SIGNALS SENT`);
    }
    isScanning = false;
}

// ============================================
// AUTO-SCAN - ONLY 15 MINUTE
// ============================================
async function autoScan15m() {
    if (isScanning) return;
    isScanning = true;
    
    log(`🔄 AUTO-SCAN [15 MINUTE PRIMARY] - ${new Date().toLocaleTimeString()}`);
    
    let signalsFound = 0;
    
    for (const pair of PAIRS) {
        const analysis = await analyzePair(pair, '15min');
        if (analysis && analysis.confidence >= ULTIMATE_CONFIG.MIN_CONFIDENCE && analysis.signal !== 'NEUTRAL') {
            signalsFound++;
            const message = formatTelegramSignal(analysis, pair.name, '15m', true);
            sendTelegramMessage(message);
            log(`🔔 AUTO SIGNAL: [15m] ${pair.name} - ${analysis.signal} @ ${analysis.confidence}%`);
            await new Promise(r => setTimeout(r, 1000));
        }
        await new Promise(r => setTimeout(r, ULTIMATE_CONFIG.DELAY_BETWEEN_PAIRS_MS));
    }
    
    log(`📊 AUTO-SCAN [15 MINUTE] complete: ${signalsFound} signals`);
    isScanning = false;
}

// ============================================
// SCAN SPECIFIC PAIR
// ============================================
async function scanSinglePair(pairName, timeframe = null) {
    const useTimeframe = timeframe || currentManualTimeframe;
    const pair = PAIRS.find(p => p.name === pairName.toUpperCase());
    
    if (!pair) {
        sendTelegramMessage(`❌ Pair ${pairName} not found. Available: ${PAIRS.map(p => p.name).join(', ')}`);
        return;
    }
    
    sendTelegramMessage(`🔍 Analyzing ${pair.name} on [${useTimeframe}]...`);
    const analysis = await analyzePair(pair, useTimeframe);
    
    if (!analysis || analysis.confidence < ULTIMATE_CONFIG.MIN_CONFIDENCE || analysis.signal === 'NEUTRAL') {
        sendTelegramMessage(`⚠️ No signal for ${pair.name} on ${useTimeframe}`);
        return;
    }
    
    const message = formatTelegramSignal(analysis, pair.name, useTimeframe, false);
    sendTelegramMessage(message);
    log(`📤 SIGNAL: ${pair.name} - ${analysis.signal} @ ${analysis.confidence}%`);
}

// ============================================
// TELEGRAM COMMAND HANDLER
// ============================================
function handleCommand(text) {
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts[1];
    
    if (cmd === '/start') {
        const welcome = `🏆 <b>POCKET OPTION LEGENDARY BOT v24.0</b> 🏆
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ <b>STATUS:</b> ONLINE
✅ <b>DATA:</b> YAHOO FINANCE (LIVE)
✅ <b>AUTO-SCAN:</b> 15 MINUTE ONLY ⭐
✅ <b>MANUAL TFs:</b> 1m, 5m, 15m, 30m, 1h, 4h
✅ <b>PAIRS:</b> ${PAIRS.length} FOREX PAIRS
✅ <b>MIN CONFIDENCE:</b> ${ULTIMATE_CONFIG.MIN_CONFIDENCE}%
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

<b>📋 COMMANDS:</b>
/status - Show bot status
/scan - Scan all pairs (15m)
/scan 5m - Scan specific timeframe
/scan EUR/USD - Scan specific pair
/start_auto - Start 15m auto-scan
/stop_auto - Stop auto-scan
/help - Show this menu

<b>📊 SIGNAL INCLUDES:</b>
✅ RSI with interpretation
✅ ADX with trend strength
✅ Divergence detection
✅ Volume flow analysis
✅ Session multiplier
✅ Technical reasoning WHY`;
        sendTelegramMessage(welcome);
    }
    else if (cmd === '/help') {
        const help = `📋 <b>COMMAND LIST</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
/status - Show bot status
/scan - Scan all pairs (15m)
/scan 5m - Scan specific timeframe
/scan EUR/USD - Scan specific pair
/start_auto - Start 15m auto-scan
/stop_auto - Stop auto-scan
/help - Show this menu

<b>⏰ TIMEFRAMES:</b>
<b>AUTO-SCAN:</b> 15 MINUTE ONLY ⭐
<b>MANUAL SCAN:</b> 1m, 5m, 15m, 30m, 1h, 4h

<b>📊 AVAILABLE PAIRS (${PAIRS.length}):</b>
${PAIRS.map(p => p.name).join(', ')}`;
        sendTelegramMessage(help);
    }
    else if (cmd === '/status') {
        const uptimeHours = Math.floor((Date.now() - botStartTime) / 1000 / 60 / 60);
        const uptimeMinutes = Math.floor((Date.now() - botStartTime) / 1000 / 60) % 60;
        const autoRunning = autoScanInterval ? '🟢 RUNNING (15m)' : '🔴 STOPPED';
        
        const status = `🏆 <b>BOT STATUS</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⏱️ Uptime: ${uptimeHours}h ${uptimeMinutes}m
📡 Data: YAHOO FINANCE (LIVE)
🎯 AUTO-SCAN: 15 MINUTE ONLY ⭐
👥 Pairs: ${PAIRS.length} FOREX PAIRS
🔄 Auto-Scan: ${autoRunning}
📊 Manual TF: ${currentManualTimeframe}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Bot is fully operational`;
        sendTelegramMessage(status);
    }
    else if (cmd === '/start_auto') {
        if (autoScanInterval) {
            sendTelegramMessage("⚠️ Auto-scan already running (15m)");
            return;
        }
        autoScanInterval = setInterval(autoScan15m, ULTIMATE_CONFIG.AUTO_SCAN_INTERVAL_MINUTES * 60 * 1000);
        sendTelegramMessage("✅ 15m AUTO-SCAN STARTED (scanning every 15 minutes)");
        log("🚀 Auto-scan started for 15m PRIMARY");
        autoScan15m();
    }
    else if (cmd === '/stop_auto') {
        if (autoScanInterval) {
            clearInterval(autoScanInterval);
            autoScanInterval = null;
            sendTelegramMessage("⏸️ 15m AUTO-SCAN STOPPED");
            log("🛑 Auto-scan stopped");
        } else {
            sendTelegramMessage("⚠️ No auto-scan running");
        }
    }
    else if (cmd === '/scan') {
        if (arg && ['1m', '5m', '15m', '30m', '1h', '4h'].includes(arg)) {
            currentManualTimeframe = arg;
            scanAllPairs(arg);
        } else if (arg && (arg.includes('/') || arg.includes('USD') || arg.includes('EUR') || arg.includes('GBP'))) {
            scanSinglePair(arg);
        } else if (arg) {
            sendTelegramMessage(`❌ Unknown: ${arg}. Use: /scan, /scan 15m, or /scan EUR/USD`);
        } else {
            scanAllPairs();
        }
    }
    else {
        sendTelegramMessage(`❌ Unknown command: ${text}\nType /help for available commands`);
    }
}

// ============================================
// TELEGRAM POLLING
// ============================================
function pollTelegram() {
    if (!TELEGRAM_TOKEN) {
        log('❌ No TELEGRAM_TOKEN - console mode only');
        return;
    }
    
    log('📡 Telegram polling started');
    
    const poll = () => {
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`;
        
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.ok && json.result) {
                        for (const update of json.result) {
                            lastUpdateId = update.update_id;
                            const text = update.message?.text || '';
                            const chatId = update.message?.chat?.id;
                            
                            if (TELEGRAM_CHAT_ID && chatId && chatId.toString() !== TELEGRAM_CHAT_ID) {
                                log(`Unauthorized chat: ${chatId}`, 'WARN');
                                continue;
                            }
                            
                            log(`📥 Command: ${text}`);
                            handleCommand(text);
                        }
                    }
                } catch(e) {}
                setTimeout(poll, 2000);
            });
        }).on('error', () => setTimeout(poll, 5000));
    };
    poll();
}

// ============================================
// KEEP ALIVE
// ============================================
setInterval(() => {
    log(`💓 BOT ALIVE | Auto-scan: ${autoScanInterval ? 'ON (15m)' : 'OFF'} | Pairs: ${PAIRS.length}`);
}, 60000);

process.on('SIGINT', () => {
    log('🛑 Bot shutting down...');
    if (autoScanInterval) clearInterval(autoScanInterval);
    setTimeout(() => process.exit(0), 1000);
});

// ============================================
// START
// ============================================
console.log('\n' + '█'.repeat(80));
console.log('🏆 POCKET OPTION LEGENDARY BOT v24.0');
console.log('15M AUTO-SCAN ONLY - MANUAL FOR OTHER TFs');
console.log('█'.repeat(80));
console.log(`Data Source: YAHOO FINANCE (LIVE)`);
console.log(`AUTO-SCAN: 15 MINUTE ONLY ⭐`);
console.log(`Manual Timeframes: 1m, 5m, 15m, 30m, 1h, 4h`);
console.log(`Pairs: ${PAIRS.length} (All valid Yahoo Finance symbols)`);
console.log(`Min Confidence: ${ULTIMATE_CONFIG.MIN_CONFIDENCE}%`);
console.log(`Telegram: ${TELEGRAM_TOKEN ? '✅ CONFIGURED' : '❌ NOT CONFIGURED'}`);
console.log('█'.repeat(80) + '\n');

console.log('📊 VALID PAIRS (28 pairs):');
PAIRS.forEach((p, i) => {
    console.log(`   ${(i+1).toString().padStart(2)}. ${p.name}`);
});
console.log('');

if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    pollTelegram();
    sendTelegramMessage(`🏆 <b>POCKET OPTION BOT v24.0 ACTIVATED</b> 🏆

✅ DATA: YAHOO FINANCE (LIVE)
✅ AUTO-SCAN: 15 MINUTE ONLY ⭐
✅ MANUAL TFs: 1m, 5m, 15m, 30m, 1h, 4h
✅ ${PAIRS.length} VALID FOREX PAIRS

Type /help for all commands`);
} else {
    console.log('⚠️ Telegram not configured - set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
    console.log('');
    console.log('To configure on Railway:');
    console.log('1. Go to Dashboard → Variables');
    console.log('2. Add TELEGRAM_BOT_TOKEN = your_bot_token');
    console.log('3. Add TELEGRAM_CHAT_ID = your_chat_id');
    console.log('4. Redeploy');
}

log('🚀 BOT v24.0 started successfully');

// Start 15m auto-scan
setTimeout(() => {
    log('📊 Starting 15m PRIMARY auto-scan...');
    autoScanInterval = setInterval(autoScan15m, ULTIMATE_CONFIG.AUTO_SCAN_INTERVAL_MINUTES * 60 * 1000);
    sendTelegramMessage("✅ 15m AUTO-SCAN ENABLED (scanning every 15 minutes)");
    autoScan15m();
}, 10000);
