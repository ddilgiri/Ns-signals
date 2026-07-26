// ============================================================
// V5 CASE 1-8 + CONFIDENCE SCORING (server-side, stateless)
// Built on top of existing `chain` array (O) from /oi-analysis
// Each chain entry already has: strike, CE_oi, CE_oiChange, CE_ltp,
// CE_prevClose, PE_oi, PE_oiChange, PE_ltp, PE_prevClose
//
// NOTE: this module holds NO in-memory state across calls (no RAM growth
// risk on Render). Freshness (25% of the total score) is NOT computed
// here — it's computed client-side in index.html using the browser's own
// localStorage history, then added on top of the 75-point score returned
// by computeChainCases() below. See v5 frontend for the freshness logic.
// ============================================================

function pctChange(current, prev) {
  if (!prev || prev === 0) return 0;
  return ((current - prev) / prev) * 100;
}

function classifyCase(oiChangePct, ltpChangePct, side) {
  const oiUp = oiChangePct > 0;
  const ltpUp = ltpChangePct > 0;

  if (side === 'CE') {
    if (oiUp && !ltpUp) return 1;
    if (oiUp && ltpUp) return 2;
    if (!oiUp && !ltpUp) return 3;
    if (!oiUp && ltpUp) return 4;
  } else {
    if (oiUp && !ltpUp) return 5;
    if (oiUp && ltpUp) return 6;
    if (!oiUp && !ltpUp) return 7;
    if (!oiUp && ltpUp) return 8;
  }
}

function isEntryCase(caseNum) {
  return [2, 4, 6, 8].includes(caseNum);
}
function isSqueezeCase(caseNum) {
  return [4, 8].includes(caseNum);
}

function computeConfidence(chain, strikeIdx, side, spotPrice) {
  const entry = chain[strikeIdx];
  const oiChangeRaw = side === 'CE' ? entry.CE_oiChange : entry.PE_oiChange;
  const oi = side === 'CE' ? entry.CE_oi : entry.PE_oi;
  const ltp = side === 'CE' ? entry.CE_ltp : entry.PE_ltp;
  const prevClose = side === 'CE' ? entry.CE_prevClose : entry.PE_prevClose;

  const prevOI = oi - oiChangeRaw;
  const oiChangePct = pctChange(oi, prevOI);
  const ltpChangePct = pctChange(ltp, prevClose);

  const caseNum = classifyCase(oiChangePct, ltpChangePct, side);

  if (!isEntryCase(caseNum)) {
    return { caseNum, confidence: null, side, breakdown: null, oiChangePct, ltpChangePct };
  }

  const magOI = Math.min(Math.abs(oiChangePct), 150);
  const magLTP = Math.min(Math.abs(ltpChangePct), 150);
  const magnitudeScore = Math.min(20, ((magOI + magLTP) / 2) / 150 * 20);

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

  const strikeDiff = Math.abs(entry.strike - spotPrice);
  const distancePct = spotPrice > 0 ? (strikeDiff / spotPrice) * 100 : 100;
  const distanceScore = Math.max(0, 15 - (distancePct / 5) * 15);

  const otherSide = side === 'CE' ? 'PE' : 'CE';
  const otherOiChangeRaw = side === 'CE' ? entry.PE_oiChange : entry.CE_oiChange;
  const otherOi = side === 'CE' ? entry.PE_oi : entry.CE_oi;
  const otherLtp = side === 'CE' ? entry.PE_ltp : entry.CE_ltp;
  const otherPrevClose = side === 'CE' ? entry.PE_prevClose : entry.CE_prevClose;
  const otherPrevOI = otherOi - otherOiChangeRaw;
  const otherOiPct = pctChange(otherOi, otherPrevOI);
  const otherLtpPct = pctChange(otherLtp, otherPrevClose);
  const otherCase = classifyCase(otherOiPct, otherLtpPct, otherSide);
  const caseBias = { 1: 'bear', 2: 'bull', 3: 'neutral', 4: 'bull', 5: 'bull', 6: 'bear', 7: 'neutral', 8: 'bear' };
  const crossSideScore = (caseBias[caseNum] === caseBias[otherCase]) ? 10 : 0;

  let subtotal = magnitudeScore + breadthScore + distanceScore + crossSideScore;
  const squeeze = isSqueezeCase(caseNum);
  if (squeeze) {
    subtotal = Math.min(subtotal, 55);
  }

  return {
    caseNum,
    side,
    isSqueeze: squeeze,
    serverScore: Math.round(subtotal),
    oiChangePct: Math.round(oiChangePct * 100) / 100,
    ltpChangePct: Math.round(ltpChangePct * 100) / 100,
    breakdown: {
      magnitude: Math.round(magnitudeScore),
      breadth: Math.round(breadthScore),
      distance: Math.round(distanceScore),
      crossSide: crossSideScore
    }
  };
}

function computeChainCases(chain, symbol, spotPrice) {
  return chain.map((entry, idx) => ({
    strike: entry.strike,
    CE: computeConfidence(chain, idx, 'CE', spotPrice),
    PE: computeConfidence(chain, idx, 'PE', spotPrice)
  }));
}

module.exports = { computeChainCases, classifyCase, isEntryCase, isSqueezeCase };
