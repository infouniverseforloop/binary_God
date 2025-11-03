// riskManager.js — combines manipDetector + news + sentiment => riskScore
const manip = require('./manipulationDetector');
const news = require('./newsFilter');
const sentiment = require('./sentimentEngine');

async function computeRisk({ symbol, bars, manip: manipInfo, sentiment: sent }){
  const manipScore = (manipInfo && manipInfo.score) || (manip.detect([], bars).score || 0);
  const newsRes = await news.checkHighImpactWindow(symbol);
  const newsPenalty = newsRes && newsRes.isHighImpact ? 40 : 0;
  const sentimentScore = sent || sentiment.getSentiment(symbol) || 50;
  const riskScore = Math.min(100, Math.round(manipScore + newsPenalty + (50 - (sentimentScore/1.5))));
  return { riskScore, manipScore, newsRes, sentimentScore };
}

module.exports = { computeRisk };
