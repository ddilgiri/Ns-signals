// ============================================================
// V5 CASE 1-8 + CONFIDENCE SCORING
// Built on top of existing `chain` array (O) from /oi-analysis
// Each chain entry already has: strike, CE_oi, CE_oiChange, CE_ltp,
// CE_prevClose, PE_oi, PE_oiChange, PE_ltp, PE_prevClose
// ============================================================

// In-memory store of the previous chain read per symbol, for freshness check
// (per Dilip: on-demand only, no continuous background scan)
// CAPPED to avoid unbounded RAM growth on Render's free tier — old symbol entries
// (not touched in 2+ hours) are pruned, and total symbol count is hard-capped.
const PREV_CHAIN_SNAPSHOT = {};
const SNAPSHOT_MAX_SYMBOLS = 120;
const SNAPSHOT_STALE_MS = 2 * 60 * 60 * 1000; // 2 hours
function pruneSnapshotStore() {
  const now = Date.now();
  const symbols = Object.keys(PREV_CHAIN_SNAPSHOT);
  // Drop symbols with no reading touched in the last 2 hours
  for (const sym of symbols) {
    const strikes = PREV_CHAIN_SNAPSHOT[sym];
    let newestTs = 0;
    for (const strike in strikes) {
      for (const side in strikes[strike]) {
        const ts = strikes[strike][side].ts || 0;
        if (ts > newestTs) newestTs = ts;
      }
    }
    if (now - newestTs > SNAPSHOT_STALE_MS) delete PREV_CHAIN_SNAPSHOT[sym];
  }
  // Hard cap: if still too many symbols, drop the oldest ones
  const remaining = Object.keys(PREV_CHAIN_SNAPSHOT);
  if (remaining.length > SNAPSHOT_MAX_SYMBOLS) {
    const withAge = remaining.map(sym => {
      let newestTs = 0;
      const strikes = PREV_CHAIN_SNAPSHOT[sym];
      for (const strike in strikes) for (const side in strikes[strike]) {
        const ts = strikes[strike][side].ts || 0;
        if (ts > newestTs) newestTs = ts;
      }
      return { sym, newestTs };
    }).sort((a, b) => a.newestTs - b.newestTs);
    const toDrop = withAge.slice(0, remaining.length - SNAPSHOT_MAX_SYMBOLS);
    toDrop.forEach(x => delete PREV_CHAIN_SNAPSHOT[x.sym]);
  }
}
// Prune periodically, not on every call (cheap, runs every 10 min)
setInterval(pruneSnapshotStore, 10 * 60 * 1000);

function pctChange(current, prev) {
  if (!prev || prev === 0) return 0;
  return ((current - prev) / prev) * 100;
}

// Classify one side (CE or PE) into Case 1-4 (CE) or 5-8 (PE)
// oiChangePct: % change in OI, ltpChangePct: % change in LTP
function classifyCase(oiChangePct, ltpChangePct, side) {
  const oiUp = oiChangePct > 0;
  const ltpUp = ltpChangePct > 0;

  if (side === 'CE') {
    if (oiUp && !ltpUp) return 1;   // seller winning, wall holds
    if (oiUp && ltpUp) return 2;    // buyer winning, wall breaks — REAL SIGNAL
    if (!oiUp && !ltpUp) return 3;  // no fight
    if (!oiUp && ltpUp) return 4;   // squeeze
  } else { // PE
    if (oiUp && !ltpUp) return 5;   // seller winning, floor holds
    if (oiUp && ltpUp) return 6;    // buyer winning, floor breaks — REAL SIGNAL
    if (!oiUp && !ltpUp) return 7;  // no fight
    if (!oiUp && ltpUp) return 8;   // squeeze
  }
}

// Is this case one Dilip would ever buy? (Case 2/6 = real, 4/8 = squeeze, 1/3/5/7 = no entry)
function isEntryCase(caseNum) {
  return [2, 4, 6, 8].includes(caseNum);
}
function isSqueezeCase(caseNum) {
  return [4, 8].includes(caseNum);
}

// Main confidence calculator for ONE strike's ONE side (CE or PE)
// chain: full chain array for this symbol (needed for breadth/distance)
// strikeIdx: index of this strike in chain
// side: 'CE' or 'PE'
// symbol: for looking up previous snapshot
function computeConfidence(chain, strikeIdx, side, symbol, spotPrice) {
  const entry = chain[strikeIdx];
  const oiChangeRaw = side === 'CE' ? entry.CE_oiChange : entry.PE_oiChange;
  const oi = side === 'CE' ? entry.CE_oi : entry.PE_oi;
  const ltp = side === 'CE' ? entry.CE_ltp : entry.PE_ltp;
  const prevClose = side === 'CE' ? entry.CE_prevClose : entry.PE_prevClose;

  // oiChangeRaw is an absolute count from Angel; convert to % of current OI
  // (oi - oiChangeRaw) approximates previous OI, guard divide-by-zero
  const prevOI = oi - oiChangeRaw;
  const oiChangePct = pctChange(oi, prevOI);
  const ltpChangePct = pctChange(ltp, prevClose);

  const caseNum = classifyCase(oiChangePct, ltpChangePct, side);

  // Case 1/3/5/7 -> no entry, no confidence score needed
  if (!isEntryCase(caseNum)) {
    return { caseNum, confidence: null, side, breakdown: null };
  }

  // ---- Check 1: Magnitude (20%) ----
  // Scale: 0-20% oi change -> 0-10 pts, 20-100%+ -> 10-20 pts (capped)
  const magOI = Math.min(Math.abs(oiChangePct), 150);
  const magLTP = Math.min(Math.abs(ltpChangePct), 150);
  const magnitudeScore = Math.min(20, ((magOI + magLTP) / 2) / 150 * 20);

  // ---- Check 2: Breadth (30%) ----
  // Check 1 strike above and below for same case
  let breadthMatches = 0;
  if (strikeIdx > 0) {
    const prevEntry = chain[strikeIdx - 1];
    const prevOiC = (side === 'CE' ? prevEntry.CE_oiChange : prevEntry.PE_oiChange);
    const prevOiVal = (side === 'CE' ? prevEntry.CE_oi : prevEntry.PE_oi);
    const prevLtpV = (side === 'CE' ? prevEntry.CE_ltp : prevEntry.PE_ltp);
    const prevPrevClose = (side === 'CE' ? prevEntry.CE_prevClose : prevEntry.PE_prevClose);
    const pOiPct = pctChange(prevOiVal, prevOiVal - prevOiC);
    const pLtpPct = pctChange(prevLtpV, prevPrevClose);
    if (classifyCase(pOiPct, pLtpPct, side) === caseNum) breadthMatches++;
  }
  if (strikeIdx < chain.length - 1) {
    const nextEntry = chain[strikeIdx + 1];
    const nOiC = (side === 'CE' ? nextEntry.CE_oiChange : nextEntry.PE_oiChange);
    const nOiVal = (side === 'CE' ? nextEntry.CE_oi : nextEntry.PE_oi);
    const nLtpV = (side === 'CE' ? nextEntry.CE_ltp : nextEntry.PE_ltp);
    const nPrevClose = (side === 'CE' ? nextEntry.CE_prevClose : nextEntry.PE_prevClose);
    const nOiPct = pctChange(nOiVal, nOiVal - nOiC);
    const nLtpPct = pctChange(nLtpV, nPrevClose);
    if (classifyCase(nOiPct, nLtpPct, side) === caseNum) breadthMatches++;
  }
  const breadthScore = (breadthMatches / 2) * 30;

  // ---- Check 3: Distance from spot (15%) ----
  const strikeDiff = Math.abs(entry.strike - spotPrice);
  const distancePct = spotPrice > 0 ? (strikeDiff / spotPrice) * 100 : 100;
  // closer = higher score; 0% diff = full 15, 5%+ diff = 0
  const distanceScore = Math.max(0, 15 - (distancePct / 5) * 15);

  // ---- Check 4: Cross-side confirmation (10%) ----
  const otherSide = side === 'CE' ? 'PE' : 'CE';
  const otherOiChangeRaw = side === 'CE' ? entry.PE_oiChange : entry.CE_oiChange;
  const otherOi = side === 'CE' ? entry.PE_oi : entry.CE_oi;
  const otherLtp = side === 'CE' ? entry.PE_ltp : entry.CE_ltp;
  const otherPrevClose = side === 'CE' ? entry.PE_prevClose : entry.CE_prevClose;
  const otherPrevOI = otherOi - otherOiChangeRaw;
  const otherOiPct = pctChange(otherOi, otherPrevOI);
  const otherLtpPct = pctChange(otherLtp, otherPrevClose);
  const otherCase = classifyCase(otherOiPct, otherLtpPct, otherSide);
  // Same directional bias: CE Case 1 (bearish) agrees with PE Case 6 (bearish), etc.
  const caseBias = { 1: 'bear', 2: 'bull', 3: 'neutral', 4: 'bull', 5: 'bull', 6: 'bear', 7: 'neutral', 8: 'bear' };
  const crossSideScore = (caseBias[caseNum] === caseBias[otherCase]) ? 10 : 0;

  // ---- Check 5: Freshness (25%) ----
  // Compare to previous snapshot for this symbol+strike+side, if one exists
  let freshnessScore = 0;
  let freshnessNote = 'first read — no prior snapshot to compare';
  const prevSnap = PREV_CHAIN_SNAPSHOT[symbol]?.[entry.strike]?.[side];
  if (prevSnap) {
    const oiGrowing = Math.abs(oiChangePct) >= Math.abs(prevSnap.oiChangePct);
    const ltpGrowing = isSqueezeCase(caseNum)
      ? Math.abs(ltpChangePct) >= Math.abs(prevSnap.ltpChangePct) // squeeze: still growing is good, shrinking is the warning
      : Math.abs(ltpChangePct) >= Math.abs(prevSnap.ltpChangePct);
    if (oiGrowing && ltpGrowing) {
      freshnessScore = 25;
      freshnessNote = 'still building vs last check';
    } else if (!oiGrowing && !ltpGrowing) {
      freshnessScore = 0;
      freshnessNote = 'fading vs last check';
    } else {
      freshnessScore = 12.5;
      freshnessNote = 'mixed vs last check';
    }
  }

  // Squeeze cases (4/8) are capped at MEDIUM (max 55) regardless of raw total —
  // cross-side always scored 0 for squeezes by definition (OI falling = no fresh conviction)
  let totalScore = magnitudeScore + breadthScore + distanceScore + crossSideScore + freshnessScore;
  if (isSqueezeCase(caseNum)) {
    totalScore = Math.min(totalScore, 55); // hard cap, never reaches HIGH band
  }

  // Save this reading as the new snapshot for next time
  if (!PREV_CHAIN_SNAPSHOT[symbol]) PREV_CHAIN_SNAPSHOT[symbol] = {};
  if (!PREV_CHAIN_SNAPSHOT[symbol][entry.strike]) PREV_CHAIN_SNAPSHOT[symbol][entry.strike] = {};
  PREV_CHAIN_SNAPSHOT[symbol][entry.strike][side] = { oiChangePct, ltpChangePct, ts: Date.now() };

  return {
    caseNum,
    confidence: Math.round(totalScore),
    side,
    isSqueeze: isSqueezeCase(caseNum),
    breakdown: {
      magnitude: Math.round(magnitudeScore),
      breadth: Math.round(breadthScore),
      distance: Math.round(distanceScore),
      crossSide: crossSideScore,
      freshness: Math.round(freshnessScore),
      freshnessNote
    }
  };
}

// Compute Case+confidence for EVERY strike in a chain (both CE and PE sides)
// Call this once per /oi-analysis response, using the same `O` chain array
function computeChainCases(chain, symbol, spotPrice) {
  return chain.map((entry, idx) => ({
    strike: entry.strike,
    CE: computeConfidence(chain, idx, 'CE', symbol, spotPrice),
    PE: computeConfidence(chain, idx, 'PE', symbol, spotPrice)
  }));
}

module.exports = { computeChainCases, classifyCase, isEntryCase, isSqueezeCase };
