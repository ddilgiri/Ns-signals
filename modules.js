// modules.js — Scoring engine M1 through M6
// New F&O Engine (Book-Based: NISM Series VIII + XV + Varsity)
// Total score range: -13 to +13
// ENTER ≥ +6 | WAIT +3 to +5 | AVOID < +3

// ─────────────────────────────────────────────────────────────────────────────
// M1 — Dilip OI Cases 1-8 (Varsity Module 5 Ch 11 + NISM VIII 5.5.1)
// Cases 1-4: Futures OI vs Price (Varsity)
// Cases 5-8: Option chain CE/PE OI vs LTP (NISM VIII 5.5.1)
// Score: -3 to +3
// ─────────────────────────────────────────────────────────────────────────────
function scoreM1(futures, prevFuturesOI, chainData) {
  if (!futures || prevFuturesOI == null) return { score: 0, label: 'M1: No data', caseNum: null };

  const priceUp  = futures.ltp > futures.prevClose;
  const oiUp     = futures.oi  > prevFuturesOI;
  const oiChange = Math.abs(futures.oi - prevFuturesOI);
  const strong   = oiChange > (prevFuturesOI * 0.02); // >2% OI change = strong signal

  let score, label, caseNum, wall, floor, urgencySide;

  // ── Cases 1-4: Futures (Varsity Module 5 Ch 11) ───────────────────────────
  if (priceUp && oiUp) {
    caseNum = 1; label = 'Case 1 — Long Buildup (Price↑ OI↑)';
    score = strong ? 3 : 2;
  } else if (!priceUp && !oiUp) {
    caseNum = 2; label = 'Case 2 — Long Unwinding (Price↓ OI↓)';
    score = strong ? -3 : -2;
  } else if (!priceUp && oiUp) {
    caseNum = 3; label = 'Case 3 — Short Buildup (Price↓ OI↑)';
    score = strong ? -3 : -2;
  } else {
    caseNum = 4; label = 'Case 4 — Short Covering (Price↑ OI↓)';
    score = 1; // weakest bullish — shorts just exiting, not fresh longs
  }

  // ── Cases 5-8: Option chain level (NISM VIII 5.5.1) ──────────────────────
  // Uses ATM CE OI vs ATM PE OI direction
  if (chainData) {
    const { atmCE, atmPE, prevAtmCE, prevAtmPE } = chainData;
    if (atmCE && atmPE && prevAtmCE != null && prevAtmPE != null) {
      const ceOIUp = atmCE.oi > prevAtmCE;
      const peOIUp = atmPE.oi > prevAtmPE;
      const ceLTPUp = atmCE.ltp > (atmCE.prevLtp || atmCE.ltp);
      const peLTPUp = atmPE.ltp > (atmPE.prevLtp || atmPE.ltp);

      if (ceOIUp && ceLTPUp) {
        caseNum = 5; label += ' + Case 5 CE Long Buildup';
        score = Math.min(score + 1, 3);
        urgencySide = 'CALL';
      } else if (!ceOIUp && ceLTPUp) {
        caseNum = 6; label += ' + Case 6 CE Short Covering';
        urgencySide = 'CALL';
      } else if (peOIUp && peLTPUp) {
        caseNum = 7; label += ' + Case 7 PE Long Buildup';
        score = Math.max(score - 1, -3);
        urgencySide = 'PUT';
      } else if (!peOIUp && peLTPUp) {
        caseNum = 8; label += ' + Case 8 PE Short Covering';
        urgencySide = 'PUT';
      }

      // Wall = strike with highest Call OI (resistance)
      // Floor = strike with highest Put OI (support)
      // Varsity: "OI concentration = support/resistance"
      if (chainData.maxCallOIStrike) wall  = chainData.maxCallOIStrike;
      if (chainData.maxPutOIStrike)  floor = chainData.maxPutOIStrike;
    }
  }

  return {
    score: Math.max(-3, Math.min(3, score)),
    label, caseNum,
    ltp:      futures.ltp,
    oi:       futures.oi,
    prevOI:   prevFuturesOI,
    strong,
    wall,     // Mahesh — resistance strike
    floor,    // Mahesh — support strike
    urgencySide, // Naresh — CALL or PUT side has urgency
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// M2 — Flow Score (AI-trader V8 weights — replaces PCR-only M2)
// 5-component weighted composite:
//   volume_ratio  0.40  — current vol vs avg vol (momentum confirmation)
//   MFI           0.25  — Money Flow Index (buying/selling pressure)
//   OBV slope     0.15  — On-Balance Volume direction (smart money)
//   PCR bonus     0.12  — Put-Call Ratio (contrarian + hard gate)
//   OI change     0.08  — OI delta (buildup vs unwinding)
// Score: -2 to +2
//
// PCR hard gates (from vinay-v-7 logic):
//   PCR > 1.5 → block PE buys (put-dominant = market supported)
//   PCR < 0.6 → block CE buys (call-dominant = resistance overhead)
// ─────────────────────────────────────────────────────────────────────────────
function scoreM2(flowData) {
  // Legacy: if called with bare pcr number (backward compat)
  if (typeof flowData === 'number' || flowData == null) {
    const pcr = flowData;
    if (pcr == null) return { score: 0, label: 'M2: No flow data', flowScore: 0, hardBlock: null };
    // Simple PCR fallback — map to -2..+2
    let s = pcr > 1.5 ? 2 : pcr > 1.2 ? 1 : pcr >= 0.8 ? 0 : pcr < 0.5 ? -2 : -1;
    return { score: s, label: `M2(PCR fallback): ${pcr.toFixed(2)}`, flowScore: s / 2, pcr, hardBlock: null };
  }

  const {
    volumeRatio,   // current candle vol / 20-period avg vol  (e.g. 1.8)
    mfi,           // MFI 14 value  0-100
    obvSlope,      // OBV slope: +1 rising, 0 flat, -1 falling
    pcr,           // Put-Call Ratio (can be null)
    oiChangePct,   // OI change % vs prev (e.g. +2.5 means +2.5%)
    side = 'CE',   // trade side — for PCR hard gate
  } = flowData;

  // ── Component 1: Volume Ratio (weight 0.40) ───────────────────────────────
  // >1.5x avg = strong flow; <0.7x = weak/drying up
  let volScore = 0;
  if (volumeRatio != null) {
    if      (volumeRatio >= 2.0)  volScore =  1.0;
    else if (volumeRatio >= 1.5)  volScore =  0.7;
    else if (volumeRatio >= 1.2)  volScore =  0.4;
    else if (volumeRatio >= 0.8)  volScore =  0.0;
    else if (volumeRatio >= 0.5)  volScore = -0.4;
    else                           volScore = -0.7;
  }
  const volContrib = volScore * 0.40;

  // ── Component 2: MFI (weight 0.25) ───────────────────────────────────────
  // >80 = overbought (bearish for CE), <20 = oversold (bullish for CE)
  // 40-60 neutral, 60-80 bullish momentum
  let mfiScore = 0;
  if (mfi != null) {
    if      (mfi >= 80)  mfiScore = -0.8;  // overbought = reversal risk
    else if (mfi >= 60)  mfiScore =  0.8;  // strong bullish momentum
    else if (mfi >= 40)  mfiScore =  0.2;  // mild bullish
    else if (mfi >= 20)  mfiScore = -0.5;  // bearish momentum
    else                  mfiScore =  0.5;  // oversold = reversal bounce
  }
  // Flip for PE side
  if (side === 'PE') mfiScore = -mfiScore;
  const mfiContrib = mfiScore * 0.25;

  // ── Component 3: OBV Slope (weight 0.15) ─────────────────────────────────
  // Smart money direction: +1 rising (accumulation), -1 falling (distribution)
  let obvScore = 0;
  if (obvSlope != null) {
    obvScore = Math.max(-1, Math.min(1, obvSlope)); // clamp to -1..+1
  }
  if (side === 'PE') obvScore = -obvScore;
  const obvContrib = obvScore * 0.15;

  // ── Component 4: PCR bonus (weight 0.12) ─────────────────────────────────
  // Contrarian: high PCR = fear = bullish; low PCR = greed = bearish
  let pcrScore = 0;
  let hardBlock = null;
  if (pcr != null) {
    if      (pcr > 1.5)                  pcrScore =  1.0;
    else if (pcr > 1.2)                  pcrScore =  0.6;
    else if (pcr >= 0.8 && pcr <= 1.2)   pcrScore =  0.0;
    else if (pcr < 0.6)                   pcrScore = -1.0;
    else                                  pcrScore = -0.5;

    // Hard gate (vinay-v-7 logic) — PCR extreme blocks trade direction
    if (pcr > 1.5 && side === 'PE') {
      hardBlock = `PCR ${pcr.toFixed(2)} > 1.5 — Heavy put writing, market supported. PE buy BLOCKED.`;
    } else if (pcr < 0.6 && side === 'CE') {
      hardBlock = `PCR ${pcr.toFixed(2)} < 0.6 — Heavy call writing, resistance overhead. CE buy BLOCKED.`;
    }
  }
  const pcrContrib = pcrScore * 0.12;

  // ── Component 5: OI Change % (weight 0.08) ────────────────────────────────
  // >2% buildup = strong signal; <-2% = unwinding
  let oiScore = 0;
  if (oiChangePct != null) {
    if      (oiChangePct > 3)   oiScore =  1.0;
    else if (oiChangePct > 1)   oiScore =  0.5;
    else if (oiChangePct > -1)  oiScore =  0.0;
    else if (oiChangePct > -3)  oiScore = -0.5;
    else                         oiScore = -1.0;
  }
  const oiContrib = oiScore * 0.08;

  // ── Composite flow score (-1 to +1) → scale to -2..+2 ────────────────────
  const rawFlow = volContrib + mfiContrib + obvContrib + pcrContrib + oiContrib;
  const score   = Math.round(rawFlow * 2 * 2) / 2; // scale -1..+1 → -2..+2, step 0.5
  const clampedScore = Math.max(-2, Math.min(2, score));

  const label = [
    `M2 FlowScore ${clampedScore > 0 ? '+' : ''}${clampedScore}`,
    volumeRatio != null ? `Vol×${volumeRatio.toFixed(1)}` : '',
    mfi != null         ? `MFI ${mfi.toFixed(0)}` : '',
    obvSlope != null    ? `OBV ${obvSlope > 0 ? '↑' : obvSlope < 0 ? '↓' : '→'}` : '',
    pcr != null         ? `PCR ${pcr.toFixed(2)}` : '',
    oiChangePct != null ? `OI${oiChangePct > 0 ? '+' : ''}${oiChangePct.toFixed(1)}%` : '',
  ].filter(Boolean).join(' | ');

  return {
    score:     clampedScore,
    label,
    hardBlock,  // non-null = PCR hard gate triggered — decision.js should BLOCK
    flowScore:  +rawFlow.toFixed(3),
    breakdown: {
      volContrib:  +volContrib.toFixed(3),
      mfiContrib:  +mfiContrib.toFixed(3),
      obvContrib:  +obvContrib.toFixed(3),
      pcrContrib:  +pcrContrib.toFixed(3),
      oiContrib:   +oiContrib.toFixed(3),
    },
    inputs: { volumeRatio, mfi, obvSlope, pcr, oiChangePct, side },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// M3 — IV Regime (NISM Series VIII 4.9)
// WARNING LABEL ONLY — not scored (20-cycle avg ≠ real 20-day avg)
// Only hard block: IV spike >50% = AVOID buying expensive options
// penaltyScore always 0 except AVOID gate in decision.js
// ─────────────────────────────────────────────────────────────────────────────
function scoreM3(currentIV, avgIV20) {
  if (currentIV == null || avgIV20 == null) {
    return { flag: 'UNKNOWN', label: 'M3: IV data unavailable', penaltyScore: 0 };
  }

  const ivRatio = currentIV / avgIV20;
  let flag, label;

  if (ivRatio > 1.5) {
    flag  = 'AVOID';
    label = `⚠️ IV ${currentIV.toFixed(1)}% — Spike +${((ivRatio-1)*100).toFixed(0)}% above avg. Options expensive. Hard block.`;
  } else if (ivRatio > 1.2) {
    flag  = 'CAUTION';
    label = `⚠️ IV ${currentIV.toFixed(1)}% — Elevated. Buy smaller qty.`;
  } else if (ivRatio < 0.8) {
    flag  = 'CHEAP';
    label = `✅ IV ${currentIV.toFixed(1)}% — Options cheap. Good entry condition.`;
  } else {
    flag  = 'NORMAL';
    label = `IV ${currentIV.toFixed(1)}% — Normal range.`;
  }

  // penaltyScore = 0 always — M3 is a warning, not a score
  // Only AVOID flag triggers hard block in decision.js
  return { flag, label, penaltyScore: 0, currentIV, avgIV20, ivRatio };
}

// ─────────────────────────────────────────────────────────────────────────────
// M4 — Greeks + Strike Selection (NISM Series VIII 4.7-4.8)
// Selects best strike: ATM = Delta 0.4-0.6
// DTE risk check
// Not a score — outputs WHICH strike to buy
// ─────────────────────────────────────────────────────────────────────────────
function selectStrike(chain, ltp, dte, side = 'CE') {
  if (!chain || chain.length === 0) return null;

  // Find ATM = strike closest to LTP
  let bestStrike = null, bestDelta = null, minDiff = Infinity;

  chain.forEach(row => {
    const option = row[side];
    if (!option) return;
    const diff = Math.abs(row.strikePrice - ltp);
    if (diff < minDiff) {
      minDiff = diff;
      bestStrike = row.strikePrice;
      bestDelta  = option.delta || null;
    }
  });

  // DTE risk levels (NISM VIII 4.8)
  let dteRisk;
  if (dte <= 2)       dteRisk = 'EXTREME — Gamma risk very high, avoid unless scalp';
  else if (dte <= 5)  dteRisk = 'HIGH — Theta decaying fast';
  else if (dte <= 10) dteRisk = 'MODERATE — Balanced theta/gamma';
  else                dteRisk = 'LOW — Theta manageable';

  // Delta check: ATM should be 0.4-0.6
  let deltaFlag = 'UNKNOWN';
  if (bestDelta != null) {
    const absDelta = Math.abs(bestDelta);
    if (absDelta >= 0.4 && absDelta <= 0.6)       deltaFlag = 'ATM — Ideal';
    else if (absDelta > 0.6)                        deltaFlag = 'ITM — Higher delta, more expensive';
    else                                            deltaFlag = 'OTM — Lower delta, cheaper but risky';
  }

  return {
    recommendedStrike: bestStrike,
    side,
    delta: bestDelta,
    deltaFlag,
    dte,
    dteRisk,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// M5 — Price + Trend (NISM Series XV 15.9)
// VWAP, RSI(14), MACD, Volume
// Score: -4 to +4
// ─────────────────────────────────────────────────────────────────────────────
function scoreM5(candleData) {
  if (!candleData || !candleData.candles || candleData.candles.length < 2) {
    return { score: 0, label: 'M5: Insufficient candle data', breakdown: {} };
  }

  const { candles, vwap, rsi14, macd, avgVol } = candleData;
  const last = candles[candles.length - 1];
  const ltp  = last.close;

  let score = 0;
  const breakdown = {};

  // ── VWAP (+1/-1) ──────────────────────────────────────────────────────────
  if (vwap != null) {
    if (ltp > vwap) {
      score += 1; breakdown.vwap = `Price ${ltp} > VWAP ${vwap.toFixed(2)} ✅ +1`;
    } else {
      score -= 1; breakdown.vwap = `Price ${ltp} < VWAP ${vwap.toFixed(2)} ❌ -1`;
    }
  }

  // ── RSI(14) (+1/-1) ───────────────────────────────────────────────────────
  if (rsi14 != null) {
    if (rsi14 > 60) {
      score += 1; breakdown.rsi = `RSI ${rsi14.toFixed(1)} > 60 — Bullish momentum +1`;
    } else if (rsi14 < 40) {
      score -= 1; breakdown.rsi = `RSI ${rsi14.toFixed(1)} < 40 — Bearish momentum -1`;
    } else {
      breakdown.rsi = `RSI ${rsi14.toFixed(1)} — Neutral zone 0`;
    }
  }

  // ── MACD (+1/-1) ──────────────────────────────────────────────────────────
  if (macd != null) {
    if (macd.macdLine > 0) {
      score += 1; breakdown.macd = `MACD ${macd.macdLine.toFixed(2)} > 0 — Bullish +1`;
    } else {
      score -= 1; breakdown.macd = `MACD ${macd.macdLine.toFixed(2)} < 0 — Bearish -1`;
    }
  }

  // ── Volume Confirmation (+1/-1) ───────────────────────────────────────────
  const lastVol = last.vol;
  if (avgVol > 0 && lastVol > avgVol * 1.5) {
    // High volume + price direction = confirmation
    if (ltp >= last.open) {
      score += 1; breakdown.volume = `Vol ${lastVol} = ${(lastVol/avgVol).toFixed(1)}x avg — Bullish surge +1`;
    } else {
      score -= 1; breakdown.volume = `Vol ${lastVol} = ${(lastVol/avgVol).toFixed(1)}x avg — Bearish surge -1`;
    }
  } else {
    breakdown.volume = `Vol ${lastVol} — Normal, no extra signal 0`;
  }

  // ── Close structure: HOD/LOD close bonus (+1/-1) ──────────────────────────
  const dayHigh = Math.max(...candles.map(c => c.high));
  const dayLow  = Math.min(...candles.map(c => c.low));
  const range   = dayHigh - dayLow;
  if (range > 0) {
    const closePosition = (ltp - dayLow) / range; // 0=LOD close, 1=HOD close
    if (closePosition >= 0.8) {
      score = Math.min(score + 1, 4);
      breakdown.closeStructure = `Close near HOD (${(closePosition*100).toFixed(0)}% of range) — Bullish +1`;
    } else if (closePosition <= 0.2) {
      score = Math.max(score - 1, -4);
      breakdown.closeStructure = `Close near LOD (${(closePosition*100).toFixed(0)}% of range) — Bearish -1`;
    } else {
      breakdown.closeStructure = `Close mid-range (${(closePosition*100).toFixed(0)}%) — Neutral 0`;
    }
  }

  return {
    score: Math.max(-4, Math.min(4, score)),
    label: `M5: Price+Trend score ${score}`,
    breakdown,
    ltp,
    vwap,
    rsi14,
    macd: macd?.macdLine,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// M6 — Max Pain (Zerodha Varsity Module 5)
// Score: -1 to +1
// ─────────────────────────────────────────────────────────────────────────────
function scoreM6(ltp, maxPainStrike) {
  if (maxPainStrike == null || ltp == null) {
    return { score: 0, label: 'M6: No max pain data' };
  }

  const diff = ltp - maxPainStrike;
  const pct  = (diff / maxPainStrike) * 100;
  let score, label;

  if (pct > 1) {
    // Price above max pain = call writers in pain = bearish pull toward max pain
    score = -1;
    label = `Price ${ltp} above Max Pain ${maxPainStrike} by ${pct.toFixed(1)}% — Bearish pull -1`;
  } else if (pct < -1) {
    // Price below max pain = put writers in pain = bullish pull toward max pain
    score = 1;
    label = `Price ${ltp} below Max Pain ${maxPainStrike} by ${Math.abs(pct).toFixed(1)}% — Bullish pull +1`;
  } else {
    // Price at max pain = equilibrium
    score = 0;
    label = `Price ${ltp} near Max Pain ${maxPainStrike} — Neutral 0`;
  }

  return { score, label, ltp, maxPainStrike, diff, pct };
}

// ─────────────────────────────────────────────────────────────────────────────
// M0 — Event Filter bonus/penalty
// Not a scored module — adjusts total score
// ─────────────────────────────────────────────────────────────────────────────
function applyM0(symbol, eventFlags) {
  // eventFlags: Set of symbols with events today
  if (!eventFlags || !eventFlags.has(symbol.toUpperCase())) {
    return { flag: 'CLEAN', adjustment: 0, label: 'M0: No event today — clean signal' };
  }
  // Has event today — results, dividend, split etc.
  return {
    flag: 'EVENT',
    adjustment: 0, // Neutral — wait for M1-M6 to confirm direction post-event
    label: 'M0: ⚠️ Event flagged today — wait till 9:30, then score M1-M6',
    waitTill: '09:30',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MASTER SCORER — combines all modules
// ─────────────────────────────────────────────────────────────────────────────
function scoreAll({ symbol, futures, prevFuturesOI, pcr, currentIV, avgIV20,
                    candleData, maxPainStrike, chain, eventFlags, dte, side = 'CE' }) {

  const m0 = applyM0(symbol, eventFlags);
  const m1 = scoreM1(futures, prevFuturesOI);
  const m2 = scoreM2(pcr);
  const m3 = scoreM3(currentIV, avgIV20);
  const m4 = selectStrike(chain, futures?.ltp, dte, side);
  const m5 = scoreM5(candleData);
  const m6 = scoreM6(futures?.ltp, maxPainStrike);

  // Total: M1(-2/+2) + M2(-2/+2) + M3(-2/+1) + M5(-4/+4) + M6(-1/+1) = -11 to +10
  const total = m1.score + m2.score + m3.penaltyScore + m5.score + m6.score;

  let verdict, action;
  if (total >= 6) {
    verdict = 'ENTER';
    action  = `BUY ${side} — Score ${total}/10, all systems GO`;
  } else if (total >= 3) {
    verdict = 'WAIT';
    action  = `WAIT — Score ${total}/10, check OI again tonight`;
  } else {
    verdict = 'AVOID';
    action  = `AVOID — Score ${total}/10, conditions not met`;
  }

  return {
    symbol,
    verdict,
    action,
    totalScore: total,
    maxScore: 10,
    scorePercent: Math.round((total / 10) * 100),
    m0, m1, m2, m3, m4, m5, m6,
    side,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  scoreM1,
  scoreM2,
  scoreM3,
  scoreM5,
  scoreM6,
  selectStrike,
  applyM0,
  scoreAll,
};
