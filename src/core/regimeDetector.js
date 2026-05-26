class MarketRegimeDetector {
    constructor() {
        this.regimeConfig = {
            strongTrending: { minADX: 35, weight: 1.3, strategies: { trend: 0.55, reversion: 0.10, breakout: 0.25, momentum: 0.10 } },
            weakTrending: { minADX: 22, maxADX: 35, weight: 1.0, strategies: { trend: 0.40, reversion: 0.20, breakout: 0.20, momentum: 0.20 } },
            ranging: { maxADX: 22, weight: 0.6, strategies: { trend: 0.10, reversion: 0.60, breakout: 0.10, momentum: 0.20 } },
            highVolatility: { minVolatility: 1.2, weight: 0.5, strategies: { trend: 0.20, reversion: 0.30, breakout: 0.40, momentum: 0.10 } },
            extreme: { minRSI: 85, orMaxRSI: 15, weight: 1.5, strategies: { trend: 0.15, reversion: 0.70, breakout: 0.05, momentum: 0.10 } }
        };
        this.currentRegime = 'ranging';
        this.regimeHistory = [];
    }
    
    detectRegime(adx, volatility, rsi) {
        let detectedRegime = 'ranging';
        if (adx >= 35) detectedRegime = 'strongTrending';
        else if (adx >= 22) detectedRegime = 'weakTrending';
        if (volatility >= 1.2) detectedRegime = 'highVolatility';
        if (rsi <= 15 || rsi >= 85) detectedRegime = 'extreme';
        
        this.regimeHistory.push({ regime: detectedRegime, timestamp: Date.now() });
        if (this.regimeHistory.length > 100) this.regimeHistory.shift();
        
        const cfg = this.regimeConfig[detectedRegime] || this.regimeConfig.ranging;
        this.currentRegime = detectedRegime;
        return {
            regime: detectedRegime,
            positionMultiplier: cfg.weight,
            strategyWeights: cfg.strategies
        };
    }
}
module.exports = { MarketRegimeDetector };
