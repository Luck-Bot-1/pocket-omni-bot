// ============================================
// POCKET OPTION BOT v21.0 - WEB DASHBOARD SERVER
// ============================================

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Store signals in memory
let signalsStore = [];
let maxSignals = 200;
let activityLogs = [];

// Load existing signals from file
function loadSignals() {
    try {
        if (fs.existsSync('signals.json')) {
            const data = JSON.parse(fs.readFileSync('signals.json', 'utf8'));
            signalsStore = data;
        }
    } catch(e) {}
}

function saveSignals() {
    try {
        fs.writeFileSync('signals.json', JSON.stringify(signalsStore.slice(-maxSignals), null, 2));
    } catch(e) {}
}

function addLog(message) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `[${timestamp}] ${message}`;
    activityLogs.unshift(logEntry);
    if (activityLogs.length > 200) activityLogs.pop();
    console.log(logEntry);
    
    // Also write to file
    try {
        fs.appendFileSync('dashboard.log', logEntry + '\n');
    } catch(e) {}
}

// Store signal from bot
function addSignal(signalData) {
    signalData.timestamp = new Date().toISOString();
    signalData.time = new Date().toLocaleTimeString();
    signalsStore.unshift(signalData);
    if (signalsStore.length > maxSignals) signalsStore.pop();
    saveSignals();
    addLog(`📡 SIGNAL: ${signalData.pair} - ${signalData.signal} @ ${signalData.confidence}% | ${signalData.trendAlignment}`);
}

// API Routes
app.get('/api/signals', (req, res) => {
    const tf = req.query.tf || '15m';
    const filtered = signalsStore.filter(s => s.timeframe === tf || !s.timeframe);
    res.json(filtered.slice(0, 100));
});

app.get('/api/status', (req, res) => {
    res.json({
        enabledPairs: global.enabledPairsCount || 0,
        activeScans: global.activeScansCount || 0,
        totalSignals: signalsStore.length,
        uptime: process.uptime()
    });
});

app.get('/api/pairs', (req, res) => {
    res.json(global.pairsList || []);
});

app.get('/api/autoscan', (req, res) => {
    res.json(global.autoscanStatus || []);
});

app.get('/api/logs', (req, res) => {
    res.json(activityLogs.slice(0, 100));
});

app.post('/api/signal', (req, res) => {
    const signal = req.body;
    addSignal(signal);
    res.json({ status: 'ok' });
});

app.post('/api/command', (req, res) => {
    const { command } = req.body;
    addLog(`📝 COMMAND: ${command}`);
    
    // Forward command to bot via file
    try {
        fs.writeFileSync('command.txt', command);
    } catch(e) {}
    
    res.json({ status: 'ok' });
});

app.get('/api/check-command', (req, res) => {
    try {
        if (fs.existsSync('command.txt')) {
            const command = fs.readFileSync('command.txt', 'utf8');
            fs.unlinkSync('command.txt');
            res.json({ command });
        } else {
            res.json({ command: null });
        }
    } catch(e) {
        res.json({ command: null });
    }
});

// Serve dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`\n${'█'.repeat(60)}`);
    console.log(`🌐 WEB DASHBOARD AVAILABLE AT: http://localhost:${PORT}`);
    console.log(`${'█'.repeat(60)}\n`);
    addLog(`🚀 Dashboard server started on port ${PORT}`);
});

loadSignals();

module.exports = { addSignal, addLog };
