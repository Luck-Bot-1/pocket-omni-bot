// ============================================
// POCKET OPTION LEGENDARY BOT v22.0
// WITH WEB DASHBOARD - COMPLETE INTERFACE
// ============================================

const { analyzeSignal } = require('./analyzer.js');
const https = require('https');
const fs = require('fs');
const path = require('path');

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
// FOREX PAIRS
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
let manualScanEnabled = true;
let selectedPairs = new Set(PAIRS.filter(p => p.enabled).map(p => p.name));
let dashboardServer = null;

// ============================================
// LOGGING
// ============================================
function log(msg, level = 'INFO') {
    const timestamp = new Date().toLocaleTimeString();
    const logMsg = `[${timestamp}] [${level}] ${msg}`;
    console.log(logMsg);
    
    try {
        fs.appendFileSync('bot.log', `[${new Date().toISOString()}] [${level}] ${msg}\n`);
    } catch(e) {}
    
    // Send to dashboard
    sendToDashboard('log', msg);
}

function debug(msg) {
    if (ULTIMATE_CONFIG.DEBUG_MODE) {
        log(msg, 'DEBUG');
    }
}

// ============================================
// DASHBOARD INTEGRATION
// ============================================
function sendToDashboard(type, data) {
    try {
        if (type === 'signal') {
            // Send signal to dashboard API
            const http = require('http');
            const postData = JSON.stringify(data);
            const req = http.request({
                hostname: 'localhost',
                port: 3000,
                path: '/api/signal',
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            req.write(postData);
            req.end();
        }
    } catch(e) {}
}

function updateDashboardStatus() {
    try {
        const http = require('http');
        const postData = JSON.stringify({
            enabledPairs: selectedPairs.size,
            activeScans: Object.keys(autoScanIntervals).length,
            pairsList: PAIRS.map(p => ({ name: p.name, enabled: selectedPairs.has(p.name) })),
            autoscanStatus: ULTIMATE_CONFIG.ALLOWED_TIMEFRAMES.map(tf => ({
                tf: tf,
                name: ULTIMATE_CONFIG.AUTO_SCAN_TIMEFRAMES[tf]?.name || tf,
                running: !!autoScanIntervals[tf]
            }))
        });
        
        const req = http.request({
            hostname: 'localhost',
            port: 3000,
            path: '/api/status-update',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        req.write(postData);
        req.end();
    } catch(e) {}
}

// Check for commands from dashboard
function checkCommands() {
    try {
        if (fs.existsSync('command.txt')) {
            const command = fs.readFileSync('command.txt', 'utf8').trim();
            fs.unlinkSync('command.txt');
            handleCommand(command);
        }
    } catch(e) {}
    
    setTimeout(checkCommands, 1000);
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
            log(`✅ [${analysis.timeframe || timeframe}] ${pairData.name}: ${analysis.signal} @ ${analysis.confidence}% | Prob: ${analysis.probability}% | ${analysis.trendAlignment}`);
            
            // Send to dashboard
            sendToDashboard('signal', {
                pair: pairData.name,
                signal: analysis.signal,
                confidence: analysis.confidence,
                probability: analysis.probability,
                rsi: analysis.rsi,
                adx: analysis.adx,
                trendAlignment: analysis.trendAlignment,
                expiry: analysis.expiry,
                timeframe: analysis.timeframe || timeframe,
                trendDirection: analysis.trendDirection
            });
        }
        return analysis;
    } catch(e) { 
        debug(`❌ [${timeframe}] Error: ${e.message}`);
        return null; 
    }
}

// ============================================
// SCAN FUNCTIONS
// ============================================
async function scanAllPairs(timeframe = null) {
    if (!manualScanEnabled) {
        log(`⚠️ Manual scan is DISABLED`, 'WARN');
        return;
    }
    
    if (isScanning) { 
        log(`⏳ Scan already in progress`, 'WARN');
        return; 
    }
    isScanning = true;
    
    const scanTimeframe = timeframe || currentManualTimeframe;
    const tfName = ULTIMATE_CONFIG.AUTO_SCAN_TIMEFRAMES[scanTimeframe]?.name || scanTimeframe;
    
    const enabledPairs = PAIRS.filter(p => selectedPairs.has(p.name));
    log(`🔍 SCANNING ${enabledPairs.length} SELECTED pairs on [${tfName}]...`);
    
    let signals = [];
    let totalPairs = 0;
    
    for (const pair of enabledPairs) {
        totalPairs++;
        const analysis = await analyzePair(pair, scanTimeframe);
        if (analysis && analysis.confidence >= ULTIMATE_CONFIG.MIN_CONFIDENCE && analysis.signal !== 'NEUTRAL') {
            signals.push({ pair: pair.name, analysis });
        }
        
        if (totalPairs % 10 === 0) {
            log(`📊 Progress: ${totalPairs}/${enabledPairs.length} | Signals: ${signals.length}`);
        }
        
        await new Promise(r => setTimeout(r, ULTIMATE_CONFIG.DELAY_BETWEEN_PAIRS_MS));
    }
    
    log(`========== SCAN COMPLETE: ${signals.length} signals ==========`);
    isScanning = false;
}

// ============================================
// AUTO-SCAN FUNCTIONS
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
            log(`🔔 AUTO SIGNAL: [${timeframe}] ${pair.name} - ${analysis.signal} @ ${analysis.confidence}%`);
        }
        await new Promise(r => setTimeout(r, ULTIMATE_CONFIG.DELAY_BETWEEN_PAIRS_MS));
    }
    
    log(`📊 AUTO-SCAN [${tfName}] complete: ${signalsFound} signals`);
    isScanning = false;
}

// ============================================
// CONTROL FUNCTIONS
// ============================================
function enableManualScan() {
    manualScanEnabled = true;
    log(`✅ MANUAL SCAN ENABLED`);
}

function disableManualScan() {
    manualScanEnabled = false;
    log(`⏸️ MANUAL SCAN DISABLED`);
}

function enablePair(pairName) {
    const pair = PAIRS.find(p => p.name === pairName.toUpperCase());
    if (!pair) {
        log(`❌ Pair ${pairName} not found`, 'ERROR');
        return;
    }
    selectedPairs.add(pair.name);
    log(`✅ Enabled: ${pair.name}`);
}

function disablePair(pairName) {
    const pair = PAIRS.find(p => p.name === pairName.toUpperCase());
    if (!pair) {
        log(`❌ Pair ${pairName} not found`, 'ERROR');
        return;
    }
    selectedPairs.delete(pair.name);
    log(`❌ Disabled: ${pair.name}`);
}

function enableAllPairs() {
    PAIRS.forEach(p => selectedPairs.add(p.name));
    log(`✅ ENABLED ALL ${PAIRS.length} PAIRS`);
}

function disableAllPairs() {
    selectedPairs.clear();
    log(`❌ DISABLED ALL PAIRS`);
}

function setManualTimeframe(timeframe) {
    if (!ULTIMATE_CONFIG.ALLOWED_TIMEFRAMES.includes(timeframe)) {
        log(`❌ Invalid timeframe: ${timeframe}`, 'ERROR');
        return;
    }
    currentManualTimeframe = timeframe;
    log(`✅ Manual timeframe set to ${timeframe}`);
}

function startAutoScanForTimeframe(timeframe) {
    if (autoScanIntervals[timeframe]) {
        log(`⚠️ Auto-scan for ${timeframe} already running`);
        return;
    }
    
    const tfConfig = ULTIMATE_CONFIG.AUTO_SCAN_TIMEFRAMES[timeframe];
    if (!tfConfig) {
        log(`❌ Invalid timeframe: ${timeframe}`, 'ERROR');
        return;
    }
    
    const intervalMinutes = tfConfig.interval;
    autoScanIntervals[timeframe] = setInterval(() => autoScanForTimeframe(timeframe), intervalMinutes * 60 * 1000);
    log(`✅ Auto-scan ENABLED for ${tfConfig.name} (every ${intervalMinutes} min)`);
    updateDashboardStatus();
}

function stopAutoScanForTimeframe(timeframe) {
    if (autoScanIntervals[timeframe]) {
        clearInterval(autoScanIntervals[timeframe]);
        delete autoScanIntervals[timeframe];
        log(`⏸️ Auto-scan DISABLED for ${timeframe}`);
        updateDashboardStatus();
    } else {
        log(`⚠️ No auto-scan running for ${timeframe}`);
    }
}

function startAllAutoScans() {
    for (const timeframe of ULTIMATE_CONFIG.ALLOWED_TIMEFRAMES) {
        if (ULTIMATE_CONFIG.AUTO_SCAN_TIMEFRAMES[timeframe]?.enabled) {
            startAutoScanForTimeframe(timeframe);
        }
    }
    log(`✅ Started all auto-scans`);
}

function stopAllAutoScans() {
    for (const timeframe of Object.keys(autoScanIntervals)) {
        stopAutoScanForTimeframe(timeframe);
    }
    log(`⏸️ Stopped all auto-scans`);
}

// ============================================
// COMMAND HANDLER
// ============================================
function handleCommand(text) {
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts[1];
    
    log(`📝 Command received: ${text}`);
    
    if (cmd === '/manual_on') {
        enableManualScan();
    }
    else if (cmd === '/manual_off') {
        disableManualScan();
    }
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
        } else if (arg) {
            log(`❌ Unknown command: ${text}`, 'ERROR');
        } else {
            scanAllPairs();
        }
    }
    else if (cmd === '/status') {
        showStatus();
    }
    else {
        log(`❌ Unknown command: ${text}`, 'ERROR');
    }
}

function showStatus() {
    log(`\n${'═'.repeat(60)}`);
    log(`🏆 BOT STATUS v22.0`);
    log(`${'═'.repeat(60)}`);
    log(`📡 Manual Scan: ${manualScanEnabled ? 'ENABLED' : 'DISABLED'}`);
    log(`👥 Enabled Pairs: ${selectedPairs.size}/${PAIRS.length}`);
    log(`🔄 Active Auto-Scans: ${Object.keys(autoScanIntervals).length}`);
    log(`📊 Current Manual TF: ${currentManualTimeframe}`);
    log(`${'═'.repeat(60)}\n`);
}

// ============================================
// STARTUP
// ============================================
console.log('\n' + '█'.repeat(80));
console.log('🏆 POCKET OPTION LEGENDARY BOT v22.0');
console.log('WITH WEB DASHBOARD - COMPLETE VISIBLE INTERFACE');
console.log('█'.repeat(80));
console.log(`Data Source: YAHOO FINANCE (LIVE)`);
console.log(`Primary Timeframe: 15 MINUTE ⭐`);
console.log(`All Timeframes: ${ULTIMATE_CONFIG.ALLOWED_TIMEFRAMES.join(', ')}`);
console.log(`Pairs: ${PAIRS.length}`);
console.log(`Min Confidence: ${ULTIMATE_CONFIG.MIN_CONFIDENCE}%`);
console.log('█'.repeat(80) + '\n');

console.log('🌐 TO ACCESS WEB DASHBOARD:');
console.log('   1. Make sure server.js is running: node server.js');
console.log('   2. Open browser to: http://localhost:3000');
console.log('');

log('🚀 POCKET OPTION BOT v22.0 started');
log('💡 Web dashboard available at http://localhost:3000');

// Start checking for commands
setTimeout(() => {
    checkCommands();
    log('📡 Command listener started');
}, 2000);

// Auto-start all enabled auto-scans
setTimeout(() => {
    log('📊 Starting configured auto-scans...');
    startAllAutoScans();
    log(`📊 Running initial scan on 15m PRIMARY...`);
    scanAllPairs('15m');
}, 5000);

// Keep alive
setInterval(() => {
    const activeCount = Object.keys(autoScanIntervals).length;
    log(`💓 BOT ALIVE | Manual: ${manualScanEnabled ? 'ON' : 'OFF'} | Pairs: ${selectedPairs.size} | Scans: ${activeCount}`);
    updateDashboardStatus();
}, 60000);

process.on('SIGINT', () => {
    log('🛑 Bot shutting down...');
    stopAllAutoScans();
    setTimeout(() => process.exit(0), 1000);
});
