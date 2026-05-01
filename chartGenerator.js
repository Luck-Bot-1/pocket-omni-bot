const moment = require('moment');

function generateChart(pairName, timeframe, candles, signal, ema9, ema21) {
    // Ensure valid candles
    let validCandles = candles;
    if (!validCandles || validCandles.length < 10) {
        validCandles = [];
        let price = 1.1000;
        for (let i = 0; i < 40; i++) {
            price += (Math.random() - 0.5) * 0.002;
            validCandles.push({
                time: Date.now() - (40 - i) * 60000,
                open: price,
                high: price + 0.001,
                low: price - 0.001,
                close: price,
                volume: 100
            });
        }
    }

    // Ensure EMAs match candle length
    let validEma9 = ema9;
    let validEma21 = ema21;
    if (!validEma9 || validEma9.length !== validCandles.length) {
        const closes = validCandles.map(c => c.close);
        validEma9 = calculateEMA(closes, 9);
        validEma21 = calculateEMA(closes, 21);
    }

    const labels = validCandles.map(c => moment(c.time).format('HH:mm'));
    const ohlc = validCandles.map(c => [c.open, c.high, c.low, c.close]);
    const lastPrice = validCandles[validCandles.length-1].close;
    const arrow = signal.direction === 'CALL' ? '▲' : '▼';
    const arrowColor = signal.direction === 'CALL' ? '00FF00' : 'FF0000';

    // Build Chart.js config as JSON string for Image-Charts
    const chartData = {
        type: 'candlestick',
        data: {
            labels: labels,
            datasets: [
                {
                    label: `${pairName} (${timeframe})`,
                    data: ohlc,
                    type: 'candlestick',
                    borderColor: '#333',
                    backgroundColor: (ctx) => ctx.raw[0] <= ctx.raw[3] ? '#00c853' : '#d50000',
                    borderWidth: 1
                },
                { label: 'EMA9', data: validEma9, type: 'line', borderColor: '#ffa726', borderWidth: 2, fill: false, pointRadius: 0 },
                { label: 'EMA21', data: validEma21, type: 'line', borderColor: '#42a5f5', borderWidth: 2, fill: false, pointRadius: 0 },
                { label: `${signal.direction} Entry`, data: [{ x: labels.length-1, y: lastPrice }], type: 'scatter', pointStyle: 'arrow', pointRadius: 12, pointBackgroundColor: arrowColor, showLine: false }
            ]
        },
        options: {
            responsive: true,
            plugins: { legend: { position: 'top' }, title: { display: true, text: `${pairName} – ${signal.direction} (${signal.confidence}%)` } },
            scales: { x: { title: { display: true, text: 'Time' } }, y: { title: { display: true, text: 'Price' } } }
        }
    };
    const encoded = encodeURIComponent(JSON.stringify(chartData));
    // Use Image‑Charts (no regional block, free 1000 requests/day)
    return `https://image-charts.com/chart.js?chs=800x500&cht=js&chd=${encoded}&chan=900000`;
}

function calculateEMA(values, period) {
    if (!values.length) return [];
    const k = 2 / (period + 1);
    let ema = values[0];
    const result = [ema];
    for (let i = 1; i < values.length; i++) {
        ema = values[i] * k + ema * (1 - k);
        result.push(ema);
    }
    return result;
}
module.exports = { generateChart };
