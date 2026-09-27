/**
 * candleConfluence.js
 * 16-parameter intraday candle-structure confidence score.
 * Complementary to scoreSignal() (OI/technical weighted score) — this scores
 * STRUCTURAL RELIABILITY of the current move (validated 2026-09-27 against real
 * AXISBANK and ZYDUSLIFE 15m sessions: score>=60 -> ~80-87% directional accuracy,
 * score<50 -> near coin-flip 35-55%). Used as a CAP/GATE, same pattern as the
 * existing TRANSITION regime cap in /signal-analysis — never blended into
 * SIGNAL_WEIGHTS, since it measures a different thing than direction confidence.
 *
 * Input: rawCandles = the SAME raw array Angel One returns and /market-bias
 *        already has as `g` (or `k`, today's slice) — each row:
 *        [timestamp, open, high, low, close, volume] as strings.
 *        Needs rawCandles.length >= 4 (first 3 real candles are baseline,
 *        matches the manual validation exercise).
 *
 * vwap / macdHist: pass the ALREADY-COMPUTED values from /market-bias
 *        (H and $ in that function) — do not recompute.
 */

function toCandle(row) {
  return {
    time: row[0],
    open: parseFloat(row[1]),
    high: parseFloat(row[2]),
    low: parseFloat(row[3]),
    close: parseFloat(row[4]),
    volume: parseFloat(row[5]) || 0,
  };
}

function closeStrength(h, l, c) {
  if (h === l) return 50;
  return ((c - l) / (h - l)) * 100;
}

function computeCandleConfluence(rawCandles, { vwap, macdHist, sectorPeersUp, sectorPeersTotal } = {}) {
  if (!rawCandles || rawCandles.length < 4) {
    return { score: null, earned: 0, max: 64, breakdown: {}, gate: 'INSUFFICIENT_DATA' };
  }

  const candles = rawCandles.map(toCandle);
  const cur = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const first = candles[0]; // session's first candle (09:15)

  let earned = 0;
  const max = 64; // 16 factors x 4 pts
  const breakdown = {};

  // ---------- STRUCTURE (16 pts) ----------
  const gapUp = cur.open >= first.open;
  breakdown.gapDirection = gapUp ? 4 : 0;
  earned += breakdown.gapDirection;

  const orbHigh = first.high, orbLow = first.low;
  const orbBreak = cur.close > orbHigh || cur.close < orbLow;
  breakdown.orbBreak = orbBreak ? 4 : 0;
  earned += breakdown.orbBreak;

  const cs = closeStrength(cur.high, cur.low, cur.close);
  const strongClose = cs >= 70 || cs <= 30;
  breakdown.closeStrength = strongClose ? 4 : (cs >= 55 || cs <= 45 ? 2 : 0);
  earned += breakdown.closeStrength;

  let higherLowCount = 0;
  for (let i = candles.length - 1; i > Math.max(0, candles.length - 5); i--) {
    if (candles[i].low > candles[i - 1].low) higherLowCount++;
    else break;
  }
  breakdown.higherLowSeq = higherLowCount >= 3 ? 4 : higherLowCount >= 2 ? 3 : higherLowCount >= 1 ? 2 : 0;
  earned += breakdown.higherLowSeq;

  // ---------- VOLUME (16 pts) ----------
  const lookback = Math.min(10, candles.length - 1);
  const avgVol = candles.slice(-1 - lookback, -1).reduce((s, c) => s + c.volume, 0) / lookback;
  const volRatio = avgVol > 0 ? cur.volume / avgVol : 1;
  breakdown.volVsAvg = volRatio >= 1.5 ? 4 : volRatio >= 1.1 ? 2 : 0;
  earned += breakdown.volVsAvg;

  const last3 = candles.slice(-3).map(c => c.volume);
  const volRising = last3.length === 3 && last3[2] > last3[1] && last3[1] >= last3[0] * 0.8;
  const volFalling = last3.length === 3 && last3[2] < last3[1] && last3[1] <= last3[0] * 1.2;
  breakdown.volTrend = volRising ? 4 : volFalling ? 2 : 0;
  earned += breakdown.volTrend;

  const curGreen = cur.close >= cur.open;
  const volConfirmsDirection = (curGreen && volRising) || (!curGreen && volRising && cs <= 30);
  breakdown.volOnDownVsUp = volConfirmsDirection ? 4 : 0;
  earned += breakdown.volOnDownVsUp;

  const priceProgress = Math.abs(cur.close - prev.close);
  const priceStalling = priceProgress < (cur.high - cur.low) * 0.15;
  const divergenceWarning = volRising && priceStalling;
  breakdown.volDivergence = divergenceWarning ? 0 : 4;
  earned += breakdown.volDivergence;

  // ---------- MOMENTUM (16 pts) ----------
  const aboveVwap = typeof vwap === 'number' ? cur.close > vwap : null;
  breakdown.vwapPosition = aboveVwap === null ? 2 : (aboveVwap ? 4 : 0);
  earned += breakdown.vwapPosition;

  breakdown.macdSignal = typeof macdHist === 'number' ? (Math.abs(macdHist) > 0 ? (macdHist > 0 ? 4 : 0) : 2) : 2;
  earned += breakdown.macdSignal;

  let consecutive = 1;
  for (let i = candles.length - 1; i > 0; i--) {
    const a = candles[i].close >= candles[i].open;
    const b = candles[i - 1].close >= candles[i - 1].open;
    if (a === b) consecutive++;
    else break;
  }
  breakdown.consecutiveCount = consecutive >= 3 ? 4 : consecutive === 2 ? 2 : 0;
  earned += breakdown.consecutiveCount;

  let sectorScore = 2;
  if (typeof sectorPeersUp === 'number' && typeof sectorPeersTotal === 'number' && sectorPeersTotal > 0) {
    const pct = sectorPeersUp / sectorPeersTotal;
    sectorScore = (curGreen && pct >= 0.6) || (!curGreen && pct <= 0.4) ? 4 : (pct >= 0.4 && pct <= 0.6 ? 2 : 0);
  }
  breakdown.sectorAlignment = sectorScore;
  earned += sectorScore;

  // ---------- TIMING (16 pts) ----------
  const timeStr = cur.time && cur.time.includes(' ') ? cur.time.split(' ')[1] : (cur.time || '10:00');
  const [hh, mm] = timeStr.split(':').map(Number);
  const minutesSinceOpen = (hh * 60 + (mm || 0)) - (9 * 60 + 15);
  let sessionScore;
  if (minutesSinceOpen < 45) sessionScore = 1;
  else if (minutesSinceOpen < 285) sessionScore = 4;
  else sessionScore = 2;
  breakdown.sessionStage = sessionScore;
  earned += sessionScore;

  const gapPct = first.open ? Math.abs((cur.open - first.open) / first.open) * 100 : 0;
  breakdown.newsGapFlag = gapPct > 1.5 ? 1 : 4;
  earned += breakdown.newsGapFlag;

  const body = Math.abs(cur.close - cur.open);
  const range = cur.high - cur.low;
  const wickRatio = range > 0 ? (range - body) / range : 0;
  breakdown.rejectionWick = wickRatio > 0.6 ? 0 : wickRatio > 0.4 ? 2 : 4;
  earned += breakdown.rejectionWick;

  const highs = candles.slice(0, -1).map(c => c.high);
  const lows = candles.slice(0, -1).map(c => c.low);
  const aboveHighs = highs.filter(h => h > cur.close);
  const belowLows = lows.filter(l => l < cur.close);
  const nearestRes = aboveHighs.length ? Math.min(...aboveHighs) : null;
  const nearestSup = belowLows.length ? Math.max(...belowLows) : null;
  const distToRes = nearestRes !== null ? ((nearestRes - cur.close) / cur.close) * 100 : 5;
  const distToSup = nearestSup !== null ? ((cur.close - nearestSup) / cur.close) * 100 : 5;
  const roomToMove = curGreen ? distToRes : distToSup;
  breakdown.distanceToResistance = roomToMove > 0.5 ? 4 : roomToMove > 0.2 ? 2 : 0;
  earned += breakdown.distanceToResistance;

  const score = Math.round((earned / max) * 100);

  let gate;
  if (score < 50) gate = 'WEAK_CAP';
  else if (score >= 60) gate = 'STRONG';
  else gate = 'ELIGIBLE';

  // Directional lean, so this can be checked against Dilip formula's CE/PE call --
  // current candle direction + VWAP position, same signals already scored above.
  // BULLISH -> agrees with a CE signal, BEARISH -> agrees with a PE signal.
  const direction = curGreen && (aboveVwap !== false) ? 'BULLISH'
    : !curGreen && (aboveVwap !== true) ? 'BEARISH'
    : 'MIXED';

  return { score, earned, max, breakdown, gate, direction };
}

module.exports = { computeCandleConfluence, closeStrength };
