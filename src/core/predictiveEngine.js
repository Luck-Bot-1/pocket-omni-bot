class PredictiveSignalEngine {
    calculateHMA(data, period) {
        if (data.length < period * 2) return data;
        const half = Math.floor(period / 2);
        const sqrt = Math.floor(Math.sqrt(period));
        const wma = (values, len) => {
            let weightSum = 0, valSum = 0;
            for (let i = 0; i < len; i++) {
                const w = len - i;
                weightSum += w;
                valSum += values[values.length - 1 - i] * w;
            }
            return valSum / weightSum;
        };
        const hma = [];
        for (let i = period * 2; i <= data.length; i++) {
            const seg = data.slice(i - period * 2, i);
            const wma1 = wma(seg, period);
            const wma2 = wma(seg, half);
            const raw = 2 * wma2 - wma1;
            const smoothed = wma([raw], sqrt);
            hma.push(smoothed);
        }
        return hma;
    }

    detectPredictiveEntry(candles) {
        const closes = candles.map(c => c.close);
        if (closes.length < 40) return null;
        const hma = this.calculateHMA(closes, 20);
        if (hma.length < 6) return null;
        const curr = hma[hma.length - 1];
        const prev = hma[hma.length - 2];
        const prev2 = hma[hma.length - 3];
        const slope = curr - prev;
        const acc = slope - (prev - prev2);
        if (slope > 0.0001 && acc > 0) return { signal: 'CALL', probability: 75 };
        if (slope < -0.0001 && acc < 0) return { signal: 'PUT', probability: 75 };
        return null;
    }
}
module.exports = { PredictiveSignalEngine };
