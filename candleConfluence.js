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

/**
 * projectNextCandle (2026-09-28, rebuilt to match the manual AXISBANK/ZYDUSLIFE
 * blind-projection methodology the user validated by hand -- see uploaded PDF
 * "AxisBank_25Sep2026_24Candle_Blind_Projection": each candle was projected from
 * the SAME 16-parameter Structure/Volume/Momentum/Timing confluence framework
 * (close strength %, ORB break, higher-low sequence, volume trend/divergence,
 * rejection wicks, consecutive-candle count) computed on PRIOR real/projected
 * candles only -- never a simple 3-4-number vote average. Validated result:
 * 14/20 correct direction (70%), 10/20 near-exact, high-confluence (score>=60)
 * candles right 85% of the time vs 43% (near coin-flip) for low-confluence ones.
 * Recurring bias noted in that exercise: consistently UNDERSHOT the magnitude of
 * strong continuation candles -- kept in mind below (magnitude scales with score,
 * not capped low).
 *
 * Method now:
 *  1. Run computeCandleConfluence() on the growing series (real + already-
 *     projected candles) -- reuses the SAME Structure/Volume/Momentum/Timing
 *     breakdown as the validated exercise, zero new API calls (all inputs are
 *     values /market-bias already computed).
 *  2. Direction = the confluence breakdown's own directional lean: close-vs-VWAP
 *     position + current candle's close-strength (is it closing near its high or
 *     low) + higher-low/lower-high structure + EMA slope -- the same signals the
 *     manual exercise read off each candle, not a flat vote average.
 *  3. Magnitude = confluence score scaled against ATR -- higher score (score>=60,
 *     "STRONG" gate) projects a FULLER range move (matches the "undershot strong
 *     continuation candles" lesson: don't underweight high-confluence candles).
 *     Lower score (WEAK_CAP) projects a small/tentative move, mirroring the near-
 *     coin-flip accuracy observed at low confluence in the validation exercise.
 *  4. A small deterministic per-step variation (seeded, not random each click)
 *     keeps the run from being mechanically identical every step once real
 *     candles run out -- the manual exercise had genuine misses (6/20, candles 6,
 *     12, 13, 22, 23, 21) even at reasonable confluence scores, so a projection
 *     that is ALWAYS right in the same direction for 20 straight steps is itself
 *     unrealistic; this keeps the model honest about its own known ~70% hit rate
 *     without collapsing into flatness.
 */
function projectNextCandle(rawCandles, { vwap, ema20, ema50, atr, volRatio, oiVote, macdHist, stepIndex } = {}) {
  // 3 candles is the stated minimum (e.g. entering a stock just after 9:45, once
  // the first three 15m candles of the session exist).
  if (!rawCandles || rawCandles.length < 3) {
    return { projected: null, bias: 'NEUTRAL', confidence: 0, gate: 'INSUFFICIENT_DATA' };
  }
  const candles = rawCandles.map(toCandle);
  const cur = candles[candles.length - 1];
  const curGreen = cur.close >= cur.open;

  // Run the SAME 16-parameter confluence framework the manual exercise used,
  // on the current (real + already-projected) series. computeCandleConfluence
  // needs >=4 candles; below that, fall back to a light EMA/VWAP read only.
  const conf = candles.length >= 4
    ? computeCandleConfluence(rawCandles, { vwap, macdHist })
    : { score: 50, gate: 'ELIGIBLE', direction: 'MIXED', breakdown: {} };

  // Structural direction lean -- mirrors how the manual exercise actually read
  // each candle: close strength (closing near high = bullish continuation,
  // near low = bearish), higher-low/lower-high structure, EMA slope, VWAP
  // position. Each contributes to a single directional score, not separate
  // independent votes averaged together.
  const cs = closeStrength(cur.high, cur.low, cur.close);
  let dirScore = 0;
  dirScore += cs >= 70 ? 2 : cs >= 55 ? 1 : cs <= 30 ? -2 : cs <= 45 ? -1 : 0;
  if (typeof ema20 === 'number' && typeof ema50 === 'number') {
    dirScore += ema20 > ema50 ? 1.5 : ema20 < ema50 ? -1.5 : 0;
  }
  if (typeof vwap === 'number') {
    dirScore += cur.close > vwap ? 1 : cur.close < vwap ? -1 : 0;
  }
  // Higher-low / lower-high structure over the last few candles (same read as
  // the manual exercise's "higher-low held/broken" parameter checks).
  let structTrend = 0;
  if (candles.length >= 3) {
    const a = candles[candles.length - 1], b = candles[candles.length - 2], c = candles[candles.length - 3];
    if (a.low > b.low && b.low > c.low) structTrend = 1.5;
    else if (a.high < b.high && b.high < c.high) structTrend = -1.5;
  }
  dirScore += structTrend;
  // Option-chain OI writer/buyer bias (2026-09-28, user request: "oi volume
  // writers buyers supports for prediction") -- real money positioning, added
  // as its own weighted term alongside the structural read.
  const oiVoteVal = typeof oiVote === 'number' ? Math.max(-1, Math.min(1, oiVote)) : 0;
  dirScore += oiVoteVal * 1.5;

  // Deterministic per-step "genuine miss" allowance -- the manual exercise was
  // right 70% of the time, not 100%; a model that's mechanically always-right
  // in one direction for 20 straight candles is less realistic than one that
  // occasionally pauses/pulls back, same as real candles 6/12/13/21/22/23 did.
  const seed = ((stepIndex || 0) * 9301 + 49297) % 233280;
  const missRoll = seed / 233280;
  // ~30% of steps get a genuine direction flip (not just a weakened same-
  // direction call) -- matches the PDF's real "Wrong" verdicts (candles 6, 12,
  // 13, 22, 23 were FULL misses, direction wrong, not partial). A model that
  // weakens-but-never-flips on a "miss" still produces a monotonic run; an
  // actual ~70% hit rate needs the other ~30% to genuinely go the other way,
  // same as real 15m candles do (pullback/consolidation bars, not just smaller
  // continuation bars).
  const isMissStep = typeof stepIndex === 'number' && missRoll < 0.3;
  if (isMissStep) dirScore = -dirScore * 0.7; // genuine flip, slightly damped vs a full-strength reversal

  const scoreConfidence = conf.score != null ? conf.score / 100 : 0.5;
  const bias = Math.abs(dirScore) < 0.5 ? 'NEUTRAL' : dirScore > 0 ? 'BULLISH' : 'BEARISH';

  // Magnitude scales UP with confluence score (2026-09-28 fix per the PDF's own
  // "recurring bias: consistently undershot the magnitude of strong continuation
  // candles" finding) -- a high-confluence candle should project a fuller move,
  // not a timid one. Range floor 0.5x, up to 1.3x ATR at STRONG (score>=60).
  const rangeATR = typeof atr === 'number' && atr > 0 ? atr : (cur.high - cur.low) || cur.close * 0.003;
  const volAdjust = typeof volRatio === 'number' ? Math.max(0.6, Math.min(1.6, volRatio)) : 1;
  const magnitudeScale = 0.5 + scoreConfidence * 0.8; // 0.5x (score=0) .. 1.3x (score=100)
  const expectedRange = rangeATR * volAdjust * magnitudeScale;

  const dirNorm = Math.max(-1, Math.min(1, dirScore / 4)); // normalize dirScore to -1..1
  const projectedOpen = cur.close;
  const projectedClose = parseFloat((cur.close + dirNorm * expectedRange * 0.6).toFixed(2));
  const projectedHigh = parseFloat((Math.max(projectedOpen, projectedClose) + expectedRange * 0.25).toFixed(2));
  const projectedLow = parseFloat((Math.min(projectedOpen, projectedClose) - expectedRange * 0.25).toFixed(2));

  return {
    projected: { open: projectedOpen, high: projectedHigh, low: projectedLow, close: projectedClose },
    bias,
    confidence: parseFloat(((Math.abs(dirNorm) + scoreConfidence) / 2).toFixed(2)),
    confluenceScore: conf.score,
    votes: { dirScore, structTrend, oiVote: oiVoteVal, isMissStep, closeStrength: cs },
    gate: conf.gate,
  };
}

/**
 * projectSessionCandles (2026-09-28, updated same day per user request: "instead of
 * projection all 20.. take real candle data.. if I ask at 10:25 u'll get 5 real
 * candles, if I ask at 12:50 u'll get 14 real candles.. so it helps bcoz all chart
 * not always red or green, its mix -- u'll get more prediction"). The real-candle
 * count is now DYNAMIC, taken from however many 15m candles actually exist today
 * at the moment Research is run -- NOT a fixed 3. Only the remaining slots to the
 * 3:00 PM candle are projected, so the later in the session you research, the more
 * real (genuinely mixed, not synthetic) candles anchor the read and the fewer are
 * projected. A full NSE session (9:15-3:00, one 15m candle per slot, stopping at
 * the 3:00 PM candle rather than continuing to 3:15/3:30) is 23 candle slots total.
 * Minimum real candles to attempt a projection stays at 3 (per original spec --
 * "after 9:45").
 *
 * This chains projectNextCandle() forward: each projected candle becomes an input
 * for projecting the one after it, same inputs recomputed from the growing series
 * each step (EMA20/50, ATR, VWAP-drift proxy, volRatio decaying toward 1 as we get
 * further from real data). Zero new API calls -- runs entirely on the real candle
 * array already fetched.
 *
 * Verdict: majority vote across the projected candles (more green -> BULLISH, more
 * red -> BEARISH, tie -> NEUTRAL), per explicit user choice over a simple
 * last-candle-close-vs-first-candle-open comparison.
 */
const SESSION_TOTAL_CANDLES = 23; // 9:15 through the 3:00 PM candle, 15m each
const MIN_REAL_CANDLES = 3; // minimum real candles required to attempt a projection

function projectSessionCandles(rawCandles, { vwap, ema20, ema50, atr, volRatio, oiVote, macdHist } = {}) {
  if (!rawCandles || rawCandles.length < MIN_REAL_CANDLES) {
    return { candles: [], verdict: 'NEUTRAL', greenCount: 0, redCount: 0, gate: 'INSUFFICIENT_DATA', realCount: rawCandles ? rawCandles.length : 0 };
  }
  // Real candle count is whatever actually exists today, capped at the session
  // total (defensive -- shouldn't exceed 23 in practice). Remaining slots to
  // 3:00 PM get projected -- fewer as the day goes on and more real data exists.
  const realCount = Math.min(rawCandles.length, SESSION_TOTAL_CANDLES);
  const projectedCount = Math.max(0, SESSION_TOTAL_CANDLES - realCount);

  // Work on a growing plain-OHLCV array in the same [time,open,high,low,close,volume]
  // shape projectNextCandle expects, so each iteration can reuse it unmodified.
  const series = rawCandles.map(r => r.slice ? r.slice() : r);
  const baseCandles = series.map(toCandle);
  let runningEma20 = typeof ema20 === 'number' ? ema20 : baseCandles[baseCandles.length - 1].close;
  let runningEma50 = typeof ema50 === 'number' ? ema50 : baseCandles[baseCandles.length - 1].close;
  const baseAtr = typeof atr === 'number' && atr > 0 ? atr : null;

  // VWAP running state (2026-09-28 fix, user report: "vwap candles wrong"). The
  // passed-in `vwap` is the REAL session VWAP as of the last real candle, but it
  // was previously reused UNCHANGED across every projected step -- so once price
  // projected away from it, the VWAP-vote kept firing the SAME direction every
  // single step, self-reinforcing a monotonic red or green run instead of acting
  // as independent information. Fix: track real cumulative (sum(typicalPrice*vol),
  // sum(vol)) from the real candles, then roll it forward with each projected
  // candle's own typical price (weighted by the real session's average volume per
  // candle, since projected candles have no real volume) so VWAP genuinely drifts
  // toward wherever price is projected to go, same as it would intraday.
  let vwapNumerator = 0, vwapDenominator = 0;
  baseCandles.forEach(c => {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    vwapNumerator += typicalPrice * c.volume;
    vwapDenominator += c.volume;
  });
  const avgRealVolume = baseCandles.length ? (vwapDenominator / baseCandles.length) || 1 : 1;
  let runningVwap = typeof vwap === 'number' ? vwap
    : (vwapDenominator > 0 ? vwapNumerator / vwapDenominator : baseCandles[baseCandles.length - 1].close);
  // If real VWAP was passed in but real volume sum is 0/unusable (bad/zero-volume
  // candle data), fall back to seeding the running total from the passed vwap
  // itself so the roll-forward below still works off a sane starting point.
  if (vwapDenominator <= 0 && typeof vwap === 'number') {
    vwapNumerator = vwap * avgRealVolume;
    vwapDenominator = avgRealVolume;
  }

  const projected = [];
  let greenCount = 0, redCount = 0;

  for (let step = 0; step < projectedCount; step++) {
    // Volatility decays toward a calmer baseline the further out we project --
    // projecting a full session on today's opening-15-min ATR alone would
    // overstate the range; a mild decay keeps later candles' range realistic.
    // Scaled to reach the floor (0.5x / 0.3x) by the last of the 20 steps.
    // Decay rate scaled to the actual number of projected steps (was hardcoded
    // for a fixed 20 -- now projectedCount varies with how late in the session
    // Research is run), so the floor (0.5x atr / 0.3x volRatio pull) is still
    // reached by the LAST projected step regardless of how many there are.
    const decayFrac = projectedCount > 1 ? step / (projectedCount - 1) : 0;
    const decayedAtr = baseAtr != null ? baseAtr * Math.max(0.5, 1 - decayFrac * 0.5) : null;
    const decayedVolRatio = typeof volRatio === 'number' ? 1 + (volRatio - 1) * Math.max(0.3, 1 - decayFrac * 0.7) : 1;

    // OI writer/buyer bias does NOT decay like ATR/volRatio -- a strike's written
    // wall/floor stays in place for the rest of the session unless the chain is
    // re-fetched, so it's applied at full weight on every projected step.
    const next = projectNextCandle(series, {
      vwap: runningVwap, ema20: runningEma20, ema50: runningEma50,
      atr: decayedAtr, volRatio: decayedVolRatio, oiVote, macdHist, stepIndex: step,
    });
    if (!next.projected) break;

    const p = next.projected;
    const isGreen = p.close >= p.open;
    if (isGreen) greenCount++; else redCount++;
    projected.push({ step: step + 1, ...p, bias: next.bias, confidence: next.confidence });

    // Append this projected candle to the series so the NEXT iteration's EMA/streak
    // reads see it, same as a real candle would arrive in a live series. Volume
    // stored as the real session's average (not 0) so the VWAP roll-forward below
    // weights this projected candle realistically instead of as a zero-weight bar.
    series.push([`proj-${step + 1}`, p.open, p.high, p.low, p.close, avgRealVolume]);
    // Roll EMA20/EMA50 forward one step with the projected close (standard EMA
    // recurrence), so trend context drifts realistically across the session.
    const k20 = 2 / 21, k50 = 2 / 51;
    runningEma20 = p.close * k20 + runningEma20 * (1 - k20);
    runningEma50 = p.close * k50 + runningEma50 * (1 - k50);
    // Roll VWAP forward too (this was the actual bug -- it was previously frozen
    // at the real session's VWAP for every projected step, so once price drifted
    // away from it the VWAP-vote kept firing the same direction every step,
    // artificially reinforcing a monotonic red/green run).
    const projTypicalPrice = (p.high + p.low + p.close) / 3;
    vwapNumerator += projTypicalPrice * avgRealVolume;
    vwapDenominator += avgRealVolume;
    runningVwap = vwapDenominator > 0 ? vwapNumerator / vwapDenominator : runningVwap;
  }

  const verdict = greenCount > redCount ? 'BULLISH' : redCount > greenCount ? 'BEARISH' : 'NEUTRAL';
  return { candles: projected, verdict, greenCount, redCount, realCount, projectedCount, gate: projected.length === projectedCount ? 'COMPLETE' : 'PARTIAL' };
}

module.exports = { computeCandleConfluence, closeStrength, projectNextCandle, projectSessionCandles };
