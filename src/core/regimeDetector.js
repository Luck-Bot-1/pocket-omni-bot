/**
 * Market Regime Detector – Institutional Grade
 * Uses ADX, ATR ratio, and RSI to classify market conditions.
 */
class MarketRegimeDetector {
    constructor() {
        this.regimeConfig = {
            strongTrending: { minADX: 35, weight: 1.3 },
            weakTrending: { minADX: 22, maxADX: 35, weight: 1.0 },
            ranging: { maxADX: 22, weight: 0.6 },
            highVolatility: { minVolatility: 1.2, weight: 0.5 },
            extreme: { minRSI: 85, orMaxRSI: 15, weight: 1.5 }
        };
        this.currentRegime = 'ranging';
        this.regimeHistory = [];
    }

    /**
     * Detect market regime based on ADX, volatility (ATR/price %), and RSI.
     * @param {number} adx - Current ADX value
     * @param {number} volatilityPercent - ATR/price * 100
     * @param {number} rsi - Current RSI
     * @returns {object} { regime, positionMultiplier, mode }
     */
    detectRegime(adx, volatilityPercent, rsi) {
        let detectedRegime = 'ranging';
        let mode = 'RANGE';

        if (adx >= 35) {
            detectedRegime = 'strongTrending';
            mode = 'TREND';
        } else if (adx >= 22) {
            detectedRegime = 'weakTrending';
            mode = 'TREND';
        } else {
            detectedRegime = 'ranging';
            mode = 'RANGE';
        }

        if (volatilityPercent >= 1.2) {
            detectedRegime = 'highVolatility';
            mode = 'TREND'; // high volatility often aligns with trends
        }
        if (rsi <= 15 || rsi >= 85) {
            detectedRegime = 'extreme';
            mode = 'RANGE'; // extreme RSI is a mean‑reversion signal
        }

        this.regimeHistory.push({ regime: detectedRegime, timestamp: Date.now() });
        if (this.regimeHistory.length > 100) this.regimeHistory.shift();

        const cfg = this.regimeConfig[detectedRegime] || this.regimeConfig.ranging;
        this.currentRegime = detectedRegime;

        return {
            regime: detectedRegime,
            positionMultiplier: cfg.weight,
            mode: mode               // 'TREND' or 'RANGE'
        };
    }
}

module.exports = { MarketRegimeDetector };
