// ============================================
// POCKET OPTION LEGENDARY BOT v21.0
// WITH MANUAL SCAN TOGGLE & PAIR SELECTION
// ============================================

const { analyzeSignal } = require('./analyzer.js');
const https = require('https');
const fs = require('fs');

// ============================================
// CONFIGURATION
// ============================================
const ULTIMATE_CONFIG = {
    MIN_CONFIDENCE: 55,
    DELAY_BETWEEN_PAIRS_MS: 500,
    TELEGRAM_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    USE_YAHOO_FINANCE: true,
    DEBUG_MODE: true,
    
    ALLOWED_TIMEFRAMES: ['1m', '5m', '15m', '30m', '1h', '4h'],
    DEFAULT_TIMEFRAME: '15m',
    
    AUTO_SCAN_TIMEFRAMES: {
        '1m':  { enabled: true, interval: 1,  name: '1 MINUTE' },
        '5m':  { enabled: true, interval: 5,  name: '5 MINUTE' },
        '15m': { enabled: true, interval: 15, name: '15 MINUTE (PRIMARY)' },
        '30m': { enabled: true, interval: 30, name: '30 MINUTE' },
        '1h':  { enabled: true, interval: 60, name: '1 HOUR' },
        '4h':  { enabled: true, interval: 240, name: '4 HOUR' }
    },
    
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 1000,
    REQUEST_TIMEOUT_MS: 10000
};

// ============================================
// FOREX PAIRS (40+ Pairs)
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
    { name: 'GBP/SGD', symbol: 'GBPSGD=X', enabled: true },
    { name: 'EUR/SGD', symbol: 'EURSGD=X', enabled: true },
    { name: 'USD/SGD', symbol: 'USDSGD=X', enabled: true },
    { name: 'USD/HKD', symbol: 'USDHKD=X', enabled: true },
    { name: 'USD/MXN', symbol: 'USDMXN=X', enabled: true },
    { name: 'USD/ZAR', symbol: 'USDZAR=X', enabled: true },
    { name: 'USD/NOK', symbol: 'USDNOK=X', enabled: true },
    { name: 'USD/SEK', symbol: 'USDSEK=X', enabled: true },
    { name: 'EUR/TRY', symbol: 'EURTRY=X', enabled: true },
    { name: 'USD/TRY', symbol: 'USDTRY=X', enabled: true }
];

// ============================================
// STATE VARIABLES
// ============================================
let autoScanIntervals = {};
let isScanning = false;
let lastUpdateId = 0;
let botStartTime = Date.now();
let currentManualTimeframe = ULTIMATE_CONFIG.DEFAULT_TIMEFRAME;
let manualScanEnabled = true;  // MANUAL SCAN ON/OFF TOGGLE
let selectedPairs = new Set(PAIRS.map(p => p.name)); // ALL PAIRS SELECTED BY DEFAULT

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
// YAHOO FINANCE DATA FETCHER
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
        debug(`[${timeframe}] Analyzing ${pairData.name}...`);
        const data = await fetchPriceData(pairData, timeframe);
        if (!data || !data.values || data.values.length < 30) {
            debug(`❌ [${timeframe}] Insufficient data for ${pairData.name}`);
            return null;
        }
        
        const analysis = await analyzeSignal(data, { pairName: pairData.name }, timeframe, null, null, [], accountBalance);
        if (analysis && analysis.confidence) {
            log(`✅ [${analysis.timeframe || timeframe}] ${pairData.name}: ${analysis.signal} @ ${analysis.confidence}% | Prob: ${analysis.probability}%`);
        }
        return analysis;
    } catch(e) { 
        debug(`❌ [${timeframe}] Error: ${e.message}`);
        return null; 
    }
}

// ============================================
// FORMAT COMPLETE SIGNAL WITH PROBABILITY & TREND ALIGNMENT
// ============================================
function formatSignalMessage(analysis, pairName, timeframe, isAuto = false) {
    const arrow = analysis.signal === 'CALL' ? '📈' : '📉';
    const signalEmoji = analysis.signal === 'CALL' ? '🟢 CALL (UP)' : '🔴 PUT (DOWN)';
    const trendEmoji = analysis.trendAlignment === 'WITH TREND ✅' ? '✅' : 
                      analysis.trendAlignment === 'AGAINST TREND ⚠️' ? '⚠️' : '⚪';
    
    let message = '';
    
    // HEADER
    if (isAuto) {
        message += `🤖 AUTO SIGNAL DETECTED 🤖\n`;
    } else {
        message += `🏆 ${arrow} SIGNAL READY ${arrow} 🏆\n`;
    }
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    
    // BASIC INFO
    message += `📊 ${pairName} | [${analysis.timeframe || timeframe}]\n`;
    message += `🎯 ${signalEmoji}\n`;
    message += `⭐ CONFIDENCE: ${analysis.confidence}% | PROBABILITY: ${analysis.probability}%\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    
    // TREND ALIGNMENT (NEW)
    message += `🎯 TREND ALIGNMENT:\n`;
    message += `   ${trendEmoji} ${analysis.trendAlignment}\n`;
    message += `   📈 Market Trend: ${analysis.trendDirection}\n`;
    message += `   ${analysis.trendAlignment === 'WITH TREND ✅' ? '   → Trading WITH the trend (Higher probability)' : 
                analysis.trendAlignment === 'AGAINST TREND ⚠️' ? '   → Trading AGAINST trend (Higher risk-reward)' :
                '   → No clear trend direction (Neutral)'}\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    
    // TECHNICAL INDICATORS
    message += `📈 TECHNICAL INDICATORS:\n`;
    message += `   ┌─────────────────────────────────────┐\n`;
    message += `   │ RSI: ${analysis.rsi} | ${getRsiInterpretation(parseFloat(analysis.rsi))}\n`;
    message += `   │ ADX: ${analysis.adx} | ${analysis.adxStrength}\n`;
    message += `   │ Volatility: ${analysis.volatilityPercent}%\n`;
    message += `   │ Price Change: ${analysis.priceChange}%\n`;
    message += `   └─────────────────────────────────────┘\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    
    // DIVERGENCE INFO
    if (analysis.divergence !== 'None') {
        const divEmoji = analysis.divergence === 'Bullish' ? '📈' : '📉';
        message += `🔄 DIVERGENCE DETECTED:\n`;
        message += `   ${divEmoji} Type: ${analysis.divergence} Divergence\n`;
        message += `   ⭐ Quality: ${analysis.divergenceQuality}/100\n`;
        if (analysis.divergence === 'Bullish') {
            message += `   → Signals potential REVERSAL to UPSIDE\n`;
        } else {
            message += `   → Signals potential REVERSAL to DOWNSIDE\n`;
        }
        message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    }
    
    // VOLUME & FLOW
    message += `📊 VOLUME & ORDER FLOW:\n`;
    message += `   Volume Ratio: ${analysis.volumeRatio}x avg\n`;
    message += `   Flow Imbalance: ${analysis.volumeImbalance}\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    
    // SENTIMENT & SESSION
    message += `🧠 MARKET CONTEXT:\n`;
    message += `   Sentiment: ${analysis.sentiment} (${analysis.sentimentScore})\n`;
    message += `   Session: ${analysis.session} | Multiplier: ${analysis.sessionMultiplier}x\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    
    // TRADE DETAILS
    message += `💰 TRADE EXECUTION:\n`;
    message += `   🎯 ACTION: ${analysis.signal === 'CALL' ? 'BUY CALL OPTION' : 'BUY PUT OPTION'}\n`;
    message += `   ⏱️  EXPIRY: ${analysis.expiry} MINUTES\n`;
    message += `   📊 Strategy: ${analysis.strategyUsed}\n`;
    message += `   🔢 Ensemble Factors: ${analysis.ensembleVotes || 5}/6 active\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    
    // RISK MANAGEMENT
    message += `🛡️ RISK MANAGEMENT:\n`;
    message += `   Stop Loss: ${analysis.stopLossPips} pips\n`;
    message += `   Take Profit: ${analysis.takeProfitPips} pips\n`;
    message += `   Risk Amount: ${analysis.riskAmount}\n`;
    message += `   Risk/Reward: ${analysis.riskReward}\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    
    // RECOMMENDATION
    message += `${analysis.recommendation}\n`;
    message += `${analysis.shouldTrade}\n`;
    message += `🕐 ${new Date().toLocaleString()}`;
    
    return message;
}

function getRsiInterpretation(rsi) {
    if (rsi >= 70) return 'OVEBOUGHT 🔴';
    if (rsi >= 60) return 'Bullish momentum 📈';
    if (rsi >= 40) return 'Neutral ⚪';
    if (rsi >= 30) return 'Bearish momentum 📉';
    return 'OVERSOLD 🟢';
}

// ============================================
// TELEGRAM MESSAGING
// ============================================
function sendMessage(text) {
    if (!ULTIMATE_CONFIG.TELEGRAM_TOKEN || !ULTIMATE_CONFIG.TELEGRAM_CHAT_ID) {
        console.log(`\n📱 SIGNAL:\n${text}\n`);
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
// SCAN SINGLE PAIR (MANUAL) - RESPECTS SELECTED PAIRS
// ============================================
async function scanSinglePair(pairName, timeframe = null) {
    if (!manualScanEnabled) {
        sendMessage(`⚠️ Manual scan is DISABLED. Use /manual_on to enable.`);
        return;
    }
    
    const useTimeframe = timeframe || currentManualTimeframe;
    const pair = PAIRS.find(p => p.name === pairName.toUpperCase());
    if (!pair) { 
        sendMessage(`❌ Pair ${pairName} not found`);
        return; 
    }
    
    sendMessage(`🔍 [${useTimeframe}] Analyzing ${pair.name}...`);
    const analysis = await analyzePair(pair, useTimeframe);
    
    if (!analysis) { 
        sendMessage(`❌ Could not analyze ${pair.name} on ${useTimeframe}`);
        return; 
    }
    
    const message = formatSignalMessage(analysis, pair.name, useTimeframe, false);
    sendMessage(message);
    log(`📤 SIGNAL SENT: ${pair.name} - ${analysis.signal} @ ${analysis.confidence}% | Prob: ${analysis.probability}%`);
}

// ============================================
// SCAN ALL SELECTED PAIRS (MANUAL) - WITH TOGGLE
// ============================================
async function scanAllPairs(timeframe = null) {
    if (!manualScanEnabled) {
        sendMessage(`⚠️ Manual scan is DISABLED. Use /manual_on to enable.`);
        return;
    }
    
    if (isScanning) { 
        sendMessage('⏳ Scan already in progress'); 
        return; 
    }
    isScanning = true;
    
    const scanTimeframe = timeframe || currentManualTimeframe;
    const tfName = ULTIMATE_CONFIG.AUTO_SCAN_TIMEFRAMES[scanTimeframe]?.name || scanTimeframe;
    
    const enabledPairs = PAIRS.filter(p => selectedPairs.has(p.name));
    sendMessage(`🔍 SCANNING ${enabledPairs.length} SELECTED pairs on [${tfName}]...`);
    log(`========== MANUAL SCAN [${scanTimeframe}] STARTED ==========`);
    
    let signals = [];
    let totalPairs = 0;
    
    for (const pair of enabledPairs) {
        totalPairs++;
        const analysis = await analyzePair(pair, scanTimeframe);
        if (analysis && analysis.confidence >= ULTIMATE_CONFIG.MIN_CONFIDENCE && analysis.signal !== 'NEUTRAL') {
            signals.push({ pair: pair.name, analysis });
            log(`🎯 SIGNAL: [${scanTimeframe}] ${pair.name} - ${analysis.signal} @ ${analysis.confidence}% | Prob: ${analysis.probability}% | ${analysis.trendAlignment}`);
            
            const message = formatSignalMessage(analysis, pair.name, scanTimeframe, false);
            sendMessage(message);
        }
        
        if (totalPairs % 10 === 0) {
            log(`📊 Progress: ${totalPairs}/${enabledPairs.length} | Signals: ${signals.length}`);
        }
        
        await new Promise(r => setTimeout(r, ULTIMATE_CONFIG.DELAY_BETWEEN_PAIRS_MS));
    }
    
    log(`========== SCAN COMPLETE: ${signals.length} signals ==========`);
    
    if (signals.length === 0) {
        sendMessage(`✅ Scan complete [${tfName}]: No signals above ${ULTIMATE_CONFIG.MIN_CONFIDENCE}%`);
    } else {
        sendMessage(`✅ Scan complete [${tfName}]: ${signals.length} SIGNALS FOUND`);
        
        let summary = `📊 SIGNAL SUMMARY [${tfName}]:\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        for (const s of signals) {
            const arrow = s.analysis.signal === 'CALL' ? '📈' : '📉';
            summary += `${arrow} ${s.pair}: ${s.analysis.signal} @ ${s.analysis.confidence}% | Prob: ${s.analysis.probability}%\n`;
            summary += `   Trend: ${s.analysis.trendAlignment} | RSI:${s.analysis.rsi} ADX:${s.analysis.adx}\n`;
        }
        sendMessage(summary);
    }
    isScanning = false;
}

// ============================================
// AUTO-SCAN - RESPECTS SELECTED PAIRS
// ============================================
async function autoScanForTimeframe(timeframe) {
    if (isScanning) return;
    isScanning = true;
    const tfName = ULTIMATE_CONFIG.AUTO_SCAN_TIMEFRAMES[timeframe]?.name || timeframe;
    log(`🔄 AUTO-SCAN [${tfName}] - ${new Date().toLocaleTimeString()}`);
    
    const enabledPairs = PAIRS.filter(p => selectedPairs.has(p.name));
    let signalsFound = 0;
    
    for (const pair of enabledPairs) {
        const analysis = await analyzePair(pair, timeframe);
        if (analysis && analysis.confidence >= ULTIMATE_CONFIG.MIN_CONFIDENCE && analysis.signal !== 'NEUTRAL') {
            signalsFound++;
            const message = formatSignalMessage(analysis, pair.name, timeframe, true);
            sendMessage(message);
            log(`🔔 AUTO SIGNAL: [${timeframe}] ${pair.name} - ${analysis.signal} @ ${analysis.confidence}% | Prob: ${analysis.probability}%`);
        }
        await new Promise(r => setTimeout(r, ULTIMATE_CONFIG.DELAY_BETWEEN_PAIRS_MS));
    }
    
    log(`📊 AUTO-SCAN [${tfName}] complete: ${signalsFound} signals`);
    isScanning = false;
}

// ============================================
// PAIR SELECTION MANAGEMENT
// ============================================
function enablePair(pairName) {
    const pair = PAIRS.find(p => p.name === pairName.toUpperCase());
    if (!pair) {
        sendMessage(`❌ Pair ${pairName} not found`);
        return;
    }
    selectedPairs.add(pair.name);
    sendMessage(`✅ Enabled: ${pair.name}`);
    log(`Pair enabled: ${pair.name}`);
}

function disablePair(pairName) {
    const pair = PAIRS.find(p => p.name === pairName.toUpperCase());
    if (!pair) {
        sendMessage(`❌ Pair ${pairName} not found`);
        return;
    }
    selectedPairs.delete(pair.name);
    sendMessage(`❌ Disabled: ${pair.name}`);
    log(`Pair disabled: ${pair.name}`);
}

function enableAllPairs() {
    PAIRS.forEach(p => selectedPairs.add(p.name));
    sendMessage(`✅ ENABLED ALL ${PAIRS.length} PAIRS`);
    log(`All pairs enabled`);
}

function disableAllPairs() {
    selectedPairs.clear();
    sendMessage(`❌ DISABLED ALL PAIRS`);
    log(`All pairs disabled`);
}

function showSelectedPairs() {
    const enabledList = Array.from(selectedPairs).sort();
    const message = `📊 SELECTED PAIRS (${enabledList.length}/${PAIRS.length}):\n${enabledList.join(', ')}`;
    sendMessage(message);
}

// ============================================
// MANUAL SCAN TOGGLE
// ============================================
function enableManualScan() {
    manualScanEnabled = true;
    sendMessage(`✅ MANUAL SCAN ENABLED - You can now use /scan commands`);
    log(`Manual scan enabled`);
}

function disableManualScan() {
    manualScanEnabled = false;
    sendMessage(`⏸️ MANUAL SCAN DISABLED - /scan commands will be ignored`);
    log(`Manual scan disabled`);
}

// ============================================
// AUTO-SCAN CONTROL
// ============================================
function startAutoScanForTimeframe(timeframe) {
    if (autoScanIntervals[timeframe]) {
        sendMessage(`⚠️ Auto-scan for [${timeframe}] already running`);
        return;
    }
    
    const tfConfig = ULTIMATE_CONFIG.AUTO_SCAN_TIMEFRAMES[timeframe];
    if (!tfConfig) {
        sendMessage(`❌ [${timeframe}] invalid`);
        return;
    }
    
    const intervalMinutes = tfConfig.interval;
    autoScanIntervals[timeframe] = setInterval(() => autoScanForTimeframe(timeframe), intervalMinutes * 60 * 1000);
    sendMessage(`✅ Auto-scan ENABLED for [${tfConfig.name}] (every ${intervalMinutes} min)`);
    log(`🚀 Auto-scan started for ${timeframe}`);
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
    sendMessage(`✅ Started ${started} auto-scans (1m/5m/15m/30m/1h/4h)`);
}

function stopAllAutoScans() {
    const count = Object.keys(autoScanIntervals).length;
    for (const timeframe of Object.keys(autoScanIntervals)) {
        stopAutoScanForTimeframe(timeframe);
    }
    sendMessage(`⏸️ Stopped ${count} auto-scans`);
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
}

// ============================================
// STATUS DISPLAY
// ============================================
function showUltimateStatus() {
    const uptimeHours = Math.floor((Date.now() - botStartTime) / 1000 / 60 / 60);
    const uptimeMinutes = Math.floor((Date.now() - botStartTime) / 1000 / 60) % 60;
    
    let message = `🏆 POCKET OPTION BOT v21.0 STATUS\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `⏱️ Uptime: ${uptimeHours}h ${uptimeMinutes}m\n`;
    message += `📡 Data: YAHOO FINANCE (LIVE)\n`;
    message += `🎯 Primary: 15 MINUTE ⭐\n`;
    message += `📊 Manual TF: ${currentManualTimeframe}\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `⚙️ CONTROLS:\n`;
    message += `   Manual Scan: ${manualScanEnabled ? '🟢 ENABLED' : '🔴 DISABLED'}\n`;
    message += `   Selected Pairs: ${selectedPairs.size}/${PAIRS.length}\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `🔄 AUTO-SCAN:\n`;
    
    for (const tf of ULTIMATE_CONFIG.ALLOWED_TIMEFRAMES) {
        const isRunning = !!autoScanIntervals[tf];
        const tfConfig = ULTIMATE_CONFIG.AUTO_SCAN_TIMEFRAMES[tf];
        if (tfConfig) {
            const icon = isRunning ? '🟢' : '🔴';
            const primaryFlag = tf === '15m' ? ' ⭐' : '';
            message += `${icon} [${tf}] ${tfConfig.name}${primaryFlag}\n`;
        }
    }
    
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `📋 COMMANDS:\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `🔘 MANUAL SCAN CONTROL:\n`;
    message += `   /manual_on - Enable manual scanning\n`;
    message += `   /manual_off - Disable manual scanning\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `🔘 PAIR SELECTION:\n`;
    message += `   /enable EUR/USD - Enable specific pair\n`;
    message += `   /disable EUR/USD - Disable specific pair\n`;
    message += `   /enable_all - Enable all pairs\n`;
    message += `   /disable_all - Disable all pairs\n`;
    message += `   /pairs - Show selected pairs\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `🔘 TIMEFRAME:\n`;
    message += `   /tf 15m - Set manual timeframe\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `🔘 AUTO-SCAN:\n`;
    message += `   /start 15m - Start auto-scan\n`;
    message += `   /stop 15m - Stop auto-scan\n`;
    message += `   /startall - Start all auto-scans\n`;
    message += `   /stopall - Stop all auto-scans\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `🔘 SCAN:\n`;
    message += `   /scan - Scan all selected pairs\n`;
    message += `   /scan 15m - Scan specific timeframe\n`;
    message += `   /scan EUR/USD - Scan specific pair\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `🔘 OTHER:\n`;
    message += `   /status - Show this menu\n`;
    
    sendMessage(message);
}

// ============================================
// COMMAND HANDLER
// ============================================
function handleCommand(text) {
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts[1];
    
    // Manual scan control
    if (cmd === '/manual_on') {
        enableManualScan();
    }
    else if (cmd === '/manual_off') {
        disableManualScan();
    }
    // Pair selection
    else if (cmd === '/enable' && arg) {
        enablePair(arg);
    }
    else if (cmd === '/disable' && arg) {
        disablePair(arg);
    }
    else if (cmd === '/enable_all') {
        enableAllPairs();
    }
    else if (cmd === '/disable_all') {
        disableAllPairs();
    }
    else if (cmd === '/pairs') {
        showSelectedPairs();
    }
    // Status
    else if (cmd === '/status') {
        showUltimateStatus();
    }
    // Timeframe
    else if (cmd === '/tf' && arg) {
        setManualTimeframe(arg);
    }
    // Auto-scan control
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
    // Scan commands
    else if (cmd === '/scan') {
        if (!manualScanEnabled) {
            sendMessage(`⚠️ Manual scan is DISABLED. Use /manual_on to enable.`);
        } else if (arg && ULTIMATE_CONFIG.ALLOWED_TIMEFRAMES.includes(arg)) {
            scanAllPairs(arg);
        } else if (arg && (arg.includes('/') || arg.includes('USD') || arg.includes('EUR') || arg.includes('GBP'))) {
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
                                sendMessage(`🏆 POCKET OPTION BOT v21.0 ACTIVATED

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ DATA: YAHOO FINANCE (LIVE)
✅ PRIMARY: 15 MINUTE TIMEFRAME ⭐
✅ ALL TIMEFRAMES: 1m, 5m, 15m, 30m, 1h, 4h
✅ ${PAIRS.length} FOREX PAIRS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✨ NEW FEATURES v21.0:
✅ PROBABILITY % added to signals
✅ WITH TREND / AGAINST TREND indicator
✅ MANUAL SCAN ON/OFF toggle
✅ PAIR SELECTION with enable/disable buttons
✅ Auto-scan respects selected pairs only

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
// KEEP ALIVE
// ============================================
setInterval(() => {
    const activeCount = Object.keys(autoScanIntervals).length;
    log(`💓 BOT ALIVE | Manual scan: ${manualScanEnabled ? 'ON' : 'OFF'} | Selected pairs: ${selectedPairs.size} | Active scans: ${activeCount}`);
}, 60000);

process.on('SIGINT', () => {
    log('🛑 Bot shutting down...');
    stopAllAutoScans();
    sendMessage('🛑 Bot v21.0 shutting down');
    setTimeout(() => process.exit(0), 1000);
});

// ============================================
// START
// ============================================
console.log('\n' + '█'.repeat(80));
console.log('🏆 POCKET OPTION LEGENDARY BOT v21.0');
console.log('WITH PROBABILITY, TREND ALIGNMENT, MANUAL TOGGLE & PAIR SELECTION');
console.log('█'.repeat(80));
console.log(`Data Source: YAHOO FINANCE (LIVE)`);
console.log(`Primary Timeframe: 15 MINUTE ⭐`);
console.log(`All Timeframes: ${ULTIMATE_CONFIG.ALLOWED_TIMEFRAMES.join(', ')}`);
console.log(`Pairs: ${PAIRS.length}`);
console.log(`Min Confidence: ${ULTIMATE_CONFIG.MIN_CONFIDENCE}%`);
console.log(`Telegram: ${ULTIMATE_CONFIG.TELEGRAM_TOKEN ? '✅' : '❌'}`);
console.log('█'.repeat(80) + '\n');

console.log('✨ NEW FEATURES v21.0:');
console.log('   ✓ PROBABILITY % - Historical win rate adjusted');
console.log('   ✓ WITH TREND / AGAINST TREND - Clear trend alignment');
console.log('   ✓ MANUAL SCAN ON/OFF - /manual_on, /manual_off');
console.log('   ✓ PAIR SELECTION - /enable, /disable, /enable_all, /disable_all');
console.log('   ✓ Auto-scan respects selected pairs only');
console.log('');

if (ULTIMATE_CONFIG.TELEGRAM_TOKEN && ULTIMATE_CONFIG.TELEGRAM_CHAT_ID) {
    pollTelegram();
    sendMessage(`🏆 POCKET OPTION BOT v21.0 ACTIVATED

✨ NEW FEATURES:
✅ PROBABILITY % - Shows win probability
✅ WITH TREND/AGAINST TREND - Clear trend alignment
✅ MANUAL SCAN ON/OFF toggle
✅ PAIR SELECTION buttons

Type /status for all commands`);
} else {
    console.log('⚠️ Telegram not configured - console mode only');
}

log('🚀 POCKET OPTION BOT v21.0 started');

// Auto-start all enabled auto-scans
setTimeout(() => {
    log('📊 Starting all auto-scans...');
    startAllAutoScans();
    log(`📊 Running initial scan on 15m PRIMARY...`);
    scanAllPairs('15m');
}, 5000);
