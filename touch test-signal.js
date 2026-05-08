// test-signal.js - Run this to find the correct direction
require('dotenv').config();
const { fetchPriceData } = require('./pricefetcher');

async function test() {
    console.log('=== SIGNAL DIRECTION TEST ===\n');
    
    const pairs = ['EUR/USD', 'GBP/USD', 'USD/CAD'];
    
    for (const pair of pairs) {
        const data = await fetchPriceData(pair);
        const closes = data.values.map(v => v.close);
        const len = closes.length;
        
        const ema9 = calcEMA(closes, 9);
        const ema21 = calcEMA(closes, 21);
        const priceChange = ((closes[len-1] - closes[len-16]) / closes[len-16]) * 100;
        const isUptrend = ema9 > ema21 && priceChange > 0;
        const isDowntrend = ema9 < ema21 && priceChange < 0;
        
        console.log(`${pair}:`);
        console.log(`  EMA9 ${ema9 > ema21 ? '>' : '<'} EMA21`);
        console.log(`  Price change: ${priceChange.toFixed(2)}%`);
        console.log(`  Market: ${isUptrend ? 'UPTREND' : isDowntrend ? 'DOWNTREND' : 'SIDEWAYS'}`);
        console.log(`  Suggested signal: ${isUptrend ? 'CALL (BUY)' : isDowntrend ? 'PUT (SELL)' : 'WAIT'}`);
        console.log('');
    }
}

function calcEMA(data, period) {
    const k = 2 / (period + 1);
    let ema = data[0];
    for (let i = 1; i < data.length; i++) {
        ema = data[i] * k + ema * (1 - k);
    }
    return ema;
}

test();
