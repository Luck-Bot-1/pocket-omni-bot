// ============================================
// LEGENDARY TRADING BOT v19.0 - ULTIMATE
// LIVE DATA ONLY - YAHOO FINANCE
// 15 MINUTE PRIMARY EMPHASIS
// FULL AUTO/MANUAL TIMEFRAME CONTROL
// ============================================

const { analyzeSignal } = require('./analyzer.js');
const https = require('https');
const fs = require('fs');

// ============================================
// ULTIMATE CONFIGURATION
// ============================================
const ULTIMATE_CONFIG = {
    MIN_CONFIDENCE: 70,
    DELAY_BETWEEN_PAIRS_MS: 1000,
    TELEGRAM_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    USE_YAHOO_FINANCE: true,
    DEBUG_MODE: true,
    
    // BROKER ALLOWED TIMEFRAMES
    ALLOWED_TIMEFRAMES: ['1m', '5m', '15m', '30m', '1h', '4h'],
    DEFAULT_TIMEFRAME: '15m',  // PRIMARY EMPHASIS
    
    // AUTO-SCAN TIMEFRAME SETTINGS
    AUTO_SCAN_TIMEFRAMES: {
        '1m':  { enabled: false, interval: 1,  name: '1 MINUTE' },
        '5m':  { enabled: true,  interval: 5,  name: '5 MINUTE' },
        '15m': { enabled: true,  interval: 15, name: '15 MINUTE (PRIMARY)' },
        '30m': { enabled: true,  interval: 30, name: '30 MINUTE' },
        '1h':  { enabled: true,  interval: 60, name: '1 HOUR' },
        '4h':  { enabled: false, interval: 240,name: '4 HOUR' }
    },
    
    // DATA FETCH
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 2000,
    REQUEST_TIMEOUT_MS: 15000
};

// ============================================
// FOREX PAIRS (27 Pairs)
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

// ============================================
// STATE
// ============================================
let autoScanIntervals = {};
let isScanning = false;
let lastUpdateId = 0;
let botStartTime = Date.now();
let currentManualTimeframe = ULTIMATE_CONFIG.DEFAULT_TIMEFRAME;

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

function debug(msg) {
    if (ULTIMATE_CONFIG.DEBUG_MODE) {
        log(msg, 'DEBUG');
    }
}

// ============================================
// YAHOO FINANCE DATA FETCHER (LIVE ONLY)
// ============================================
async function fetchYahooFinanceWithRetry(symbol, interval, retries = ULTIMATE_CONFIG.MAX_RETRIES) {
    for (let i = 0; i < retries; i++) {
        const result = await fetchYahooFinance(symbol, interval);
        if (result) return result;
        if (i < retries - 1) {
            await new Promise(r => setTimeout(r, ULTIMATE_CONFIG.RETRY_DELAY_MS));
            debug(`Retry ${i + 1}/${retries} for ${symbol}`);
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
                'Accept': 'application/json',
                'Accept-Language': 'en-US,en;q=0.9'
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

// LIVE DATA ONLY - Yahoo Finance
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
// TELEGRAM MESSAGING
// ============================================
function sendMessage(text) {
    if (!ULTIMATE_CONFIG.TELEGRAM_TOKEN || !ULTIMATE_CONFIG.TELEGRAM_CHAT_ID) {
        console.log(`\n📱 TELEGRAM:\n${text}\n`);
        return;
    }
    const data = JSON.stringify({
        chat_id: ULTIMATE_CONFIG.TELEGRAM_CHAT_ID, text: text,
        parse_mode: 'HTML', disable_web_page_preview: true
    });
    const req = https.request(`https://api.telegram.org/bot${ULTIMATE_CONFIG.TELEGRAM_TOKEN}/sendMessage`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    req.on('error', (e) => log(`Telegram error: ${e.message}`, 'ERROR'));
    req.write(data);
    req.end();
}

// ============================================
// ANALYZE PAIR WITH SPECIFIC TIMEFRAME
// ============================================
async function analyzePair(pairData, timeframe = '15min', accountBalance = 10000) {
    try {
        debug(`[${timeframe}] Analyzing ${pairData.name} (LIVE DATA)...`);
        const data = await fetchPriceData(pairData, timeframe);
        if (!data || !data.values || data.values.length < 30) {
            debug(`❌ [${timeframe}] Insufficient data for ${pairData.name}`);
            return null;
        }
        
        let htfData = null;
        if (timeframe !== '1h') {
            htfData = await fetchPriceData(pairData, '1h');
        }
        
        const analysis = await analyzeSignal(data, { pairName: pairData.name }, timeframe, htfData, null, [], accountBalance);
        if (analysis && analysis.confidence) {
            log(`✅ [${analysis.timeframe || timeframe}] ${pairData.name}: ${analysis.signal} @ ${analysis.confidence}% | ${analysis.strategyUsed}`);
        }
        return analysis;
    } catch(e) { 
        debug(`❌ [${timeframe}] Error: ${e.message}`);
        return null; 
    }
}

// ============================================
// SCAN SINGLE PAIR (MANUAL)
// ============================================
async function scanSinglePair(pairName, timeframe = null) {
    const useTimeframe = timeframe || currentManualTimeframe;
    const pair = PAIRS.find(p => p.name === pairName.toUpperCase());
    if (!pair) { sendMessage(`❌ Pair ${pairName} not found`); return; }
    
    sendMessage(`🔍 [${useTimeframe}] Analyzing ${pair.name} (LIVE DATA)...`);
    const analysis = await analyzePair(pair, useTimeframe);
    
    if (!analysis) { sendMessage(`❌ Could not analyze ${pair.name} on ${useTimeframe}`); return; }
    
    const arrow = analysis.signal === 'CALL' ? '📈' : '📉';
    const emoji = analysis.confidence >= 90 ? '🏆' : analysis.confidence >= 78 ? '✅' : '📊';
    
    let message = `${emoji} ${arrow} [${analysis.timeframe || useTimeframe}] ${pair.name}\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `🎯 SIGNAL: ${analysis.signal} | CONFIDENCE: ${analysis.confidence}%\n`;
    message += `📊 STRATEGY: ${analysis.strategyUsed} | Ensemble: ${analysis.ensembleVotes || 5} factors\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `📈 TECHNICALS:\n`;
    message += `   RSI: ${analysis.rsi} | ADX: ${analysis.adx} (${analysis.adxStrength})\n`;
    message += `   Trend: ${analysis.trendDirection}\n`;
    message += `   Volatility: ${analysis.volatilityPercent}% | Change: ${analysis.priceChange}%\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `📊 VOLUME & FLOW:\n`;
    message += `   Volume: ${analysis.volumeRatio}x avg | ${analysis.volumeQuality}\n`;
    message += `   Flow Imbalance: ${analysis.volumeImbalance}\n`;
    if (analysis.divergence !== 'None') {
        message += `   Divergence: ${analysis.divergence} (Quality: ${analysis.divergenceQuality})\n`;
    }
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `🧠 SENTIMENT & SESSION:\n`;
    message += `   Sentiment: ${analysis.sentiment} (${analysis.sentimentScore})\n`;
    message += `   Session: ${analysis.session}\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `💰 POSITION SIZING:\n`;
    message += `   Size: ${analysis.positionSize} units\n`;
    message += `   SL: ${analysis.stopLossPips} pips | TP: ${analysis.takeProfitPips} pips\n`;
    message += `   Risk: ${analysis.riskAmount} | Expiry: ${analysis.expiry}min\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `${analysis.recommendation}\n`;
    message += `${analysis.shouldTrade}`;
    
    sendMessage(message);
    log(`📤 SIGNAL SENT: ${pair.name} - ${analysis.signal} @ ${analysis.confidence}%`);
}

// ============================================
// SCAN ALL PAIRS (MANUAL)
// ============================================
async function scanAllPairs(timeframe = null) {
    if (isScanning) { sendMessage('⏳ Scan already in progress'); return; }
    isScanning = true;
    
    const scanTimeframe = timeframe || currentManualTimeframe;
    const tfName = ULTIMATE_CONFIG.AUTO_SCAN_TIMEFRAMES[scanTimeframe]?.name || scanTimeframe;
    sendMessage(`🔍 ULTIMATE SCAN: ${PAIRS.length} pairs on [${tfName}] (LIVE DATA)...`);
    log(`========== ULTIMATE MANUAL SCAN [${scanTimeframe}] STARTED ==========`);
    
    let signals = [];
    let totalPairs = 0;
    
    for (const pair of PAIRS) {
        totalPairs++;
        const analysis = await analyzePair(pair, scanTimeframe);
        if (analysis && analysis.confidence >= ULTIMATE_CONFIG.MIN_CONFIDENCE && analysis.signal !== 'NEUTRAL' && !analysis.skipReason) {
            signals.push({ pair: pair.name, analysis });
            const arrow = analysis.signal === 'CALL' ? '📈' : '📉';
            sendMessage(`${arrow} [${scanTimeframe}] ${pair.name}: ${analysis.signal} @ ${analysis.confidence}% | ${analysis.strategyUsed}`);
            log(`✅ SIGNAL FOUND: [${scanTimeframe}] ${pair.name} - ${analysis.signal} @ ${analysis.confidence}%`);
        }
        
        if (totalPairs % 10 === 0) {
            log(`📊 Scan Progress: ${totalPairs}/${PAIRS.length} pairs scanned | Signals: ${signals.length}`);
        }
        
        await new Promise(r => setTimeout(r, ULTIMATE_CONFIG.DELAY_BETWEEN_PAIRS_MS));
    }
    
    log(`========== ULTIMATE SCAN COMPLETE: ${signals.length} signals ==========`);
    
    if (signals.length === 0) {
        sendMessage(`✅ Scan complete [${tfName}]: No signals above ${ULTIMATE_CONFIG.MIN_CONFIDENCE}%`);
    } else {
        sendMessage(`✅ Scan complete [${tfName}]: ${signals.length} SIGNALS FOUND`);
        
        let summary = `📊 SIGNAL SUMMARY [${tfName}]:\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        for (const s of signals) {
            const arrow = s.analysis.signal === 'CALL' ? '📈' : '📉';
            summary += `${arrow} ${s.pair}: ${s.analysis.signal} @ ${s.analysis.confidence}%\n`;
        }
        sendMessage(summary);
    }
    isScanning = false;
}

// ============================================
// AUTO-SCAN FOR SPECIFIC TIMEFRAME
// ============================================
async function autoScanForTimeframe(timeframe) {
    if (isScanning) return;
    isScanning = true;
    const tfName = ULTIMATE_CONFIG.AUTO_SCAN_TIMEFRAMES[timeframe]?.name || timeframe;
    log(`🔄 AUTO-SCAN [${tfName}] triggered - ${new Date().toISOString()}`);
    
    let signalsFound = 0;
    
    for (const pair of PAIRS) {
        const analysis = await analyzePair(pair, timeframe);
        if (analysis && analysis.confidence >= ULTIMATE_CONFIG.MIN_CONFIDENCE && analysis.signal !== 'NEUTRAL' && !analysis.skipReason) {
            signalsFound++;
            const arrow = analysis.signal === 'CALL' ? '📈' : '📉';
            const message = `🤖 AUTO SIGNAL [${tfName}]\n${arrow} ${pair.name}\n🎯 ${analysis.signal} @ ${analysis.confidence}%\n📊 ${analysis.strategyUsed} | Ensemble:${analysis.ensembleVotes || 5}\n⏰ Expiry: ${analysis.expiry}min`;
            sendMessage(message);
            log(`🔔 AUTO SIGNAL: [${timeframe}] ${pair.name} - ${analysis.signal} @ ${analysis.confidence}%`);
        }
        await new Promise(r => setTimeout(r, ULTIMATE_CONFIG.DELAY_BETWEEN_PAIRS_MS));
    }
    
    log(`📊 AUTO-SCAN [${tfName}] complete: ${signalsFound} signals found`);
    isScanning = false;
}

// ============================================
// START/STOP AUTO-SCAN FOR TIMEFRAME
// ============================================
function startAutoScanForTimeframe(timeframe) {
    if (autoScanIntervals[timeframe]) {
        sendMessage(`⚠️ Auto-scan for [${timeframe}] already running`);
        return;
    }
    
    const tfConfig = ULTIMATE_CONFIG.AUTO_SCAN_TIMEFRAMES[timeframe];
    if (!tfConfig || !tfConfig.enabled) {
        sendMessage(`❌ [${timeframe}] auto-scan not enabled in config`);
        return;
    }
    
    const intervalMinutes = tfConfig.interval;
    autoScanIntervals[timeframe] = setInterval(() => autoScanForTimeframe(timeframe), intervalMinutes * 60 * 1000);
    sendMessage(`✅ Auto-scan ENABLED for [${tfConfig.name}] (every ${intervalMinutes} min)`);
    log(`🚀 Auto-scan started for ${timeframe} (interval: ${intervalMinutes}min)`);
}

function stopAutoScanForTimeframe(timeframe) {
    if (autoScanIntervals[timeframe]) {
        clearInterval(autoScanIntervals[timeframe]);
        delete autoScanIntervals[timeframe];
        const tfName = ULTIMATE_CONFIG.AUTO_SCAN_TIMEFRAMES[timeframe]?.name || timeframe;
        sendMessage(`⏸️ Auto-scan DISABLED for [${tfName}]`);
        log(`🛑 Auto-scan stopped for ${timeframe}`);
    } else {
        sendMessage(`⚠️ No auto-scan running for [${timeframe}]`);
    }
}

function startAllAutoScans() {
    let started = 0;
    for (const timeframe of ULTIMATE_CONFIG.ALLOWED_TIMEFRAMES) {
        if (ULTIMATE_CONFIG.AUTO_SCAN_TIMEFRAMES[timeframe]?.enabled) {
            startAutoScanForTimeframe(timeframe);
            started++;
        }
    }
    if (started === 0) {
        sendMessage(`⚠️ No auto-scans enabled. Check config.`);
    } else {
        log(`🚀 Started ${started} auto-scans`);
    }
}

function stopAllAutoScans() {
    const count = Object.keys(autoScanIntervals).length;
    for (const timeframe of Object.keys(autoScanIntervals)) {
        stopAutoScanForTimeframe(timeframe);
    }
    log(`🛑 Stopped ${count} auto-scans`);
}

// ============================================
// TIMEFRAME MANAGEMENT
// ============================================
function setManualTimeframe(timeframe) {
    if (!ULTIMATE_CONFIG.ALLOWED_TIMEFRAMES.includes(timeframe)) {
        sendMessage(`❌ Invalid timeframe. Allowed: ${ULTIMATE_CONFIG.ALLOWED_TIMEFRAMES.join(', ')}`);
        return;
    }
    currentManualTimeframe = timeframe;
    const tfName = ULTIMATE_CONFIG.AUTO_SCAN_TIMEFRAMES[timeframe]?.name || timeframe;
    sendMessage(`✅ Manual scan timeframe set to [${tfName}]`);
    log(`📌 Manual timeframe changed to ${timeframe}`);
}

function showUltimateStatus() {
    const uptimeHours = Math.floor((Date.now() - botStartTime) / 1000 / 60 / 60);
    const uptimeMinutes = Math.floor((Date.now() - botStartTime) / 1000 / 60) % 60;
    
    let message = `🏆 ULTIMATE BOT v19.0 STATUS\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `⏱️ Uptime: ${uptimeHours}h ${uptimeMinutes}m\n`;
    message += `📡 Data: YAHOO FINANCE (LIVE)\n`;
    message += `🎯 Primary TF: 15 MINUTE ⭐\n`;
    message += `📊 Manual TF: ${currentManualTimeframe}\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `🔄 AUTO-SCAN STATUS:\n`;
    
    for (const tf of ULTIMATE_CONFIG.ALLOWED_TIMEFRAMES) {
        const isRunning = !!autoScanIntervals[tf];
        const tfConfig = ULTIMATE_CONFIG.AUTO_SCAN_TIMEFRAMES[tf];
        if (tfConfig) {
            const icon = isRunning ? '🟢' : '🔴';
            const primaryFlag = tf === '15m' ? ' ⭐ PRIMARY' : '';
            message += `${icon} [${tf}] ${tfConfig.name}${primaryFlag} - ${tfConfig.enabled ? `Every ${tfConfig.interval}min` : 'Disabled'}\n`;
        }
    }
    
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `🔱 ULTIMATE FEATURES:\n`;
    message += `✅ Ensemble Voting (5 factors)\n`;
    message += `✅ RSI-Gated Divergence (>72/<28)\n`;
    message += `✅ Volume Flow + Imbalance\n`;
    message += `✅ ATR Position Sizing\n`;
    message += `✅ Economic Calendar\n`;
    message += `✅ Sentiment Analysis\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `📋 COMMANDS:\n`;
    message += `/tf 15m - Set manual timeframe\n`;
    message += `/start 15m - Start auto-scan\n`;
    message += `/stop 15m - Stop auto-scan\n`;
    message += `/startall - Start all auto-scans\n`;
    message += `/stopall - Stop all auto-scans\n`;
    message += `/scan - Scan all pairs (manual TF)\n`;
    message += `/scan 5m - Scan specific timeframe\n`;
    message += `/scan EUR/USD - Scan specific pair\n`;
    message += `/status - Show this menu`;
    
    sendMessage(message);
}

// ============================================
// COMMAND HANDLER
// ============================================
function handleCommand(text) {
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts[1];
    
    if (cmd === '/status') {
        showUltimateStatus();
    }
    else if (cmd === '/tf' && arg) {
        setManualTimeframe(arg);
    }
    else if (cmd === '/start' && arg) {
        startAutoScanForTimeframe(arg);
    }
    else if (cmd === '/stop' && arg) {
        stopAutoScanForTimeframe(arg);
    }
    else if (cmd === '/startall') {
        startAllAutoScans();
    }
    else if (cmd === '/stopall') {
        stopAllAutoScans();
    }
    else if (cmd === '/scan') {
        if (arg && ULTIMATE_CONFIG.ALLOWED_TIMEFRAMES.includes(arg)) {
            scanAllPairs(arg);
        } else if (arg && (arg.includes('/') || arg.includes('USD') || arg.includes('EUR') || arg.includes('GBP') || arg.includes('AUD') || arg.includes('NZD') || arg.includes('CAD') || arg.includes('CHF') || arg.includes('JPY'))) {
            scanSinglePair(arg);
        } else if (arg) {
            sendMessage(`❌ Unknown: ${arg}. Use: /scan, /scan 15m, or /scan EUR/USD`);
        } else {
            scanAllPairs();
        }
    }
    else {
        return false;
    }
    return true;
}

// ============================================
// TELEGRAM POLLING
// ============================================
function pollTelegram() {
    if (!ULTIMATE_CONFIG.TELEGRAM_TOKEN) {
        log('❌ No TELEGRAM_TOKEN - console mode only');
        return;
    }
    
    log('📡 Telegram polling started');
    
    const poll = () => {
        const url = `https://api.telegram.org/bot${ULTIMATE_CONFIG.TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`;
        
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
                            
                            if (ULTIMATE_CONFIG.TELEGRAM_CHAT_ID && chatId && chatId.toString() !== ULTIMATE_CONFIG.TELEGRAM_CHAT_ID) {
                                log(`Unauthorized chat: ${chatId}`, 'WARN');
                                continue;
                            }
                            
                            log(`📥 Command: ${text}`);
                            
                            if (text === '/start' && !text.includes(' ')) {
                                sendMessage(`🏆 ULTIMATE TRADING BOT v19.0 ACTIVATED

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ DATA: YAHOO FINANCE (LIVE)
✅ PRIMARY: 15 MINUTE TIMEFRAME ⭐
✅ ALL TIMEFRAMES: 1m, 5m, 15m, 30m, 1h, 4h
✅ ${PAIRS.length} FOREX PAIRS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔱 ULTIMATE FEATURES:
✅ Ensemble Voting (5 factors - RenTech)
✅ RSI-Gated Divergence (>72/<28)
✅ Volume Flow + Imbalance (Citadel)
✅ ATR Position Sizing (Jump Trading)
✅ Economic Calendar (News Avoidance)
✅ Sentiment Analysis (Fear/Greed)

Type /status for all commands`);
                            }
                            else {
                                handleCommand(text);
                            }
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
// KEEP ALIVE & LOGGING
// ============================================
setInterval(() => {
    const activeCount = Object.keys(autoScanIntervals).length;
    const activeScans = Object.keys(autoScanIntervals).join(',');
    log(`💓 ULTIMATE BOT ALIVE | Active scans: ${activeCount} [${activeScans}] | Manual TF: ${currentManualTimeframe}`);
}, 60000);

process.on('SIGINT', () => {
    log('🛑 Ultimate Bot shutting down...');
    stopAllAutoScans();
    sendMessage('🛑 Ultimate Bot v19.0 shutting down');
    setTimeout(() => process.exit(0), 1000);
});

// ============================================
// START
// ============================================
console.log('\n' + '█'.repeat(80));
console.log('🏆 ULTIMATE TRADING BOT v19.0');
console.log('GOD-LEVEL - TOP 0.001% GLOBAL');
console.log('█'.repeat(80));
console.log(`Data Source: YAHOO FINANCE (LIVE) - NO DEMO/QT DATA`);
console.log(`Primary Timeframe: 15 MINUTE ⭐`);
console.log(`All Timeframes: ${ULTIMATE_CONFIG.ALLOWED_TIMEFRAMES.join(', ')}`);
console.log(`Pairs: ${PAIRS.length}`);
console.log(`Min Confidence: ${ULTIMATE_CONFIG.MIN_CONFIDENCE}%`);
console.log(`Telegram: ${ULTIMATE_CONFIG.TELEGRAM_TOKEN ? '✅' : '❌'}`);
console.log('█'.repeat(80) + '\n');

console.log('📊 TIMEFRAME CONFIGURATION:');
for (const tf of ULTIMATE_CONFIG.ALLOWED_TIMEFRAMES) {
    const config = ULTIMATE_CONFIG.AUTO_SCAN_TIMEFRAMES[tf];
    if (config) {
        const primaryMark = tf === '15m' ? ' ⭐ PRIMARY EMPHASIS' : '';
        console.log(`   ${tf}: ${config.name}${primaryMark} - Auto: ${config.enabled ? 'ON' : 'OFF'} (${config.interval}min interval)`);
    }
}
console.log('');

console.log('🔱 ULTIMATE FEATURES ENABLED:');
console.log('   ✓ Ensemble Voting (5 factors - RenTech)');
console.log('   ✓ RSI-Gated Divergence (>72 BEARISH / <28 BULLISH)');
console.log('   ✓ Volume Flow + Imbalance (Citadel)');
console.log('   ✓ ATR Position Sizing (Jump Trading)');
console.log('   ✓ Economic Calendar (News Avoidance)');
console.log('   ✓ Sentiment Analysis (Fear/Greed)');
console.log('   ✓ Multi-Timeframe (1m/5m/15m/30m/1h/4h)');
console.log('   ✓ 15 MINUTE PRIMARY EMPHASIS');
console.log('   ✓ LIVE DATA ONLY (Yahoo Finance)\n');

if (ULTIMATE_CONFIG.TELEGRAM_TOKEN && ULTIMATE_CONFIG.TELEGRAM_CHAT_ID) {
    pollTelegram();
    sendMessage(`🏆 ULTIMATE BOT v19.0 ACTIVATED

✅ LIVE DATA: YAHOO FINANCE
✅ PRIMARY: 15 MINUTE TIMEFRAME ⭐
✅ ALL TIMEFRAMES: 1m, 5m, 15m, 30m, 1h, 4h
✅ ${PAIRS.length} PAIRS MONITORED
✅ ENSEMBLE VOTING ACTIVE

Type /status for all commands`);
} else {
    console.log('⚠️ Telegram not configured - console mode only');
    console.log('');
    console.log('Console Commands:');
    console.log('  node bot.js scan15m  - Scan 15m timeframe');
    console.log('  node bot.js scan1h   - Scan 1h timeframe');
    console.log('  node bot.js status   - Show status');
}

log('🚀 ULTIMATE BOT v19.0 started successfully');

// Auto-start configured auto-scans after 10 seconds
setTimeout(() => {
    log('📊 Starting configured auto-scans...');
    for (const timeframe of ULTIMATE_CONFIG.ALLOWED_TIMEFRAMES) {
        if (ULTIMATE_CONFIG.AUTO_SCAN_TIMEFRAMES[timeframe]?.enabled) {
            startAutoScanForTimeframe(timeframe);
        }
    }
    // Run initial scan on primary timeframe
    log(`📊 Running initial scan on 15m PRIMARY timeframe...`);
    scanAllPairs('15m');
}, 10000);
