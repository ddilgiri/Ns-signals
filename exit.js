// exit.js — 7-trigger exit engine
// Runs every cycle on OPEN trades
// First trigger that fires = EXIT. No waiting. No human override.
// Based on NISM Series VIII exit logic + Varsity practical rules

// ─────────────────────────────────────────────────────────────────────────────
// EXIT TRIGGER 1 — OI Flip (M1 reversal)
// If trade is CE and OI scenario flips to Short Buildup (Case 3) → EXIT
// If trade is PE and OI scenario flips to Long Buildup (Case 1)  → EXIT
// NISM VIII 5.5
// ─────────────────────────────────────────────────────────────────────────────
function checkOIFlip(trade, m1Now) {
  if (!m1Now || m1Now.caseNum == null) return null;

  const bullishCases = [1, 4]; // Long buildup, Short covering
  const bearishCases = [2, 3]; // Long unwinding, Short buildup

  if (trade.side === 'CE' && bearishCases.includes(m1Now.caseNum)) {
    return {
      trigger: 'OI_FLIP',
      reason: `OI flipped to ${m1Now.label} — bearish for CE`,
      urgency: 'HIGH',
    };
  }
  if (trade.side === 'PE' && bullishCases.includes(m1Now.caseNum)) {
    return {
      trigger: 'OI_FLIP',
      reason: `OI flipped to ${m1Now.label} — bullish, exit PE`,
      urgency: 'HIGH',
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXIT TRIGGER 2 — PCR Cross (M2 reversal)
// CE trade: PCR drops below 0.7 = extreme call buying = contrarian bearish
// PE trade: PCR rises above 1.4 = extreme put buying = contrarian bullish
// NISM VIII 5.5.2
// ─────────────────────────────────────────────────────────────────────────────
function checkPCRCross(trade, pcrNow) {
  if (pcrNow == null) return null;

  if (trade.side === 'CE' && pcrNow < 0.7) {
    return {
      trigger: 'PCR_CROSS',
      reason: `PCR ${pcrNow.toFixed(2)} < 0.7 — extreme call buying, contrarian bearish, exit CE`,
      urgency: 'MEDIUM',
    };
  }
  if (trade.side === 'PE' && pcrNow > 1.4) {
    return {
      trigger: 'PCR_CROSS',
      reason: `PCR ${pcrNow.toFixed(2)} > 1.4 — extreme put buying, contrarian bullish, exit PE`,
      urgency: 'MEDIUM',
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXIT TRIGGER 3 — IV Spike
// IV rises >40% above avg AFTER entry = premium has inflated, take profit now
// or IV collapses >30% = premium crushed, no point holding
// NISM VIII 4.9
// ─────────────────────────────────────────────────────────────────────────────
function checkIVSpike(currentIV, avgIV20, entryIV) {
  if (currentIV == null || avgIV20 == null) return null;

  const ratioToAvg   = currentIV / avgIV20;
  const ratioToEntry = entryIV ? (currentIV / entryIV) : null;

  // IV spiked hard after entry = premium bloated = book profit
  if (ratioToEntry && ratioToEntry > 1.5) {
    return {
      trigger: 'IV_SPIKE',
      reason: `IV jumped ${((ratioToEntry-1)*100).toFixed(0)}% since entry — premium inflated, book profit`,
      urgency: 'MEDIUM',
    };
  }
  // IV crushed = vega loss eating premium
  if (ratioToAvg < 0.6) {
    return {
      trigger: 'IV_CRUSH',
      reason: `IV ${currentIV.toFixed(1)}% = ${((1-ratioToAvg)*100).toFixed(0)}% below avg — premium crushed, exit`,
      urgency: 'HIGH',
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXIT TRIGGER 4 — VWAP Cross (M5 trend break)
// CE trade: price closes a candle BELOW VWAP → trend broken → exit
// PE trade: price closes a candle ABOVE VWAP → trend broken → exit
// NISM XV 15.9 — candle close, not wick
// ─────────────────────────────────────────────────────────────────────────────
function checkVWAPCross(trade, ltp, vwap) {
  if (ltp == null || vwap == null) return null;

  if (trade.side === 'CE' && ltp < vwap) {
    return {
      trigger: 'VWAP_CROSS',
      reason: `Price ${ltp} closed below VWAP ${vwap.toFixed(2)} — uptrend broken, exit CE`,
      urgency: 'MEDIUM',
    };
  }
  if (trade.side === 'PE' && ltp > vwap) {
    return {
      trigger: 'VWAP_CROSS',
      reason: `Price ${ltp} closed above VWAP ${vwap.toFixed(2)} — downtrend broken, exit PE`,
      urgency: 'MEDIUM',
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXIT TRIGGER 5 — RSI Extreme (overbought/oversold reversal zone)
// CE trade: RSI > 80 = overbought, momentum exhaustion → exit / trail SL tight
// PE trade: RSI < 20 = oversold, momentum exhaustion → exit / trail SL tight
// NISM XV 15.9
// ─────────────────────────────────────────────────────────────────────────────
function checkRSIExtreme(trade, rsi14) {
  if (rsi14 == null) return null;

  // RSI extreme = WARNING ONLY — strong trends stay overbought/oversold
  // Do NOT exit on RSI alone — tighten SL mentally but hold
  if (trade.side === 'CE' && rsi14 > 80) {
    return {
      trigger: 'RSI_WARNING',
      reason: `RSI ${rsi14.toFixed(1)} > 80 — overbought zone. WARNING only — tighten SL, do NOT exit yet`,
      urgency: 'LOW',
    };
  }
  if (trade.side === 'PE' && rsi14 < 20) {
    return {
      trigger: 'RSI_WARNING',
      reason: `RSI ${rsi14.toFixed(1)} < 20 — oversold zone. WARNING only — tighten SL, do NOT exit yet`,
      urgency: 'LOW',
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXIT TRIGGER 6 — Theta Alarm (time decay danger zone)
// DTE ≤ 2: theta decay accelerating exponentially
// Positions held into expiry day with OTM options = near total loss risk
// NISM VIII 4.7 (Theta)
// ─────────────────────────────────────────────────────────────────────────────
function checkThetaAlarm(trade, dte, currentPremium) {
  if (dte == null) return null;

  const profitPct = trade.entryPremium
    ? ((currentPremium - trade.entryPremium) / trade.entryPremium) * 100
    : 0;

  if (dte <= 1) {
    return {
      trigger: 'THETA_ALARM',
      reason: `DTE ${dte} — Expiry day! Theta at maximum, exit immediately unless deep ITM`,
      urgency: 'CRITICAL',
    };
  }
  if (dte <= 2 && profitPct < 10) {
    return {
      trigger: 'THETA_ALARM',
      reason: `DTE ${dte} — 2 days to expiry, position not profitable enough (${profitPct.toFixed(1)}%), exit before theta kills it`,
      urgency: 'HIGH',
    };
  }
  if (dte <= 5 && profitPct < -15) {
    // Losing position with only 5 days left = no recovery time
    return {
      trigger: 'THETA_ALARM',
      reason: `DTE ${dte} — 5 days left, position down ${Math.abs(profitPct).toFixed(1)}%, theta accelerating, cut loss`,
      urgency: 'HIGH',
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXIT TRIGGER 7 — Max Pain Hit (M6)
// Price reaches max pain strike = equilibrium reached = option writer advantage
// Varsity Module 5
// ─────────────────────────────────────────────────────────────────────────────
function checkMaxPainHit(ltp, maxPainStrike) {
  if (ltp == null || maxPainStrike == null) return null;

  const pct = Math.abs((ltp - maxPainStrike) / maxPainStrike) * 100;

  if (pct <= 0.5) {
    return {
      trigger: 'MAX_PAIN_HIT',
      reason: `Price ${ltp} at Max Pain ${maxPainStrike} (within 0.5%) — option writers in equilibrium, book profits`,
      urgency: 'MEDIUM',
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// HARDCODED SL HIT CHECK
// Always runs first — non-negotiable
// ─────────────────────────────────────────────────────────────────────────────
function checkSLHit(trade, currentPremium) {
  if (!trade.slPremium || currentPremium == null) return null;
  if (currentPremium <= trade.slPremium) {
    return {
      trigger: 'SL_HIT',
      reason: `Premium ₹${currentPremium} ≤ SL ₹${trade.slPremium} — Stop loss HIT, exit immediately`,
      urgency: 'CRITICAL',
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// TARGET HIT CHECK
// ─────────────────────────────────────────────────────────────────────────────
function checkTargetHit(trade, currentPremium) {
  if (!trade.targetPremium || currentPremium == null) return null;
  if (currentPremium >= trade.targetPremium) {
    return {
      trigger: 'TARGET_HIT',
      reason: `Premium ₹${currentPremium} ≥ Target ₹${trade.targetPremium} — TARGET HIT, book full profit`,
      urgency: 'CRITICAL',
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// TRAIL SL CHECK — integrated from monitor.js logic
// Uses trade.currentTrailSL if set, else falls back to fixed SL
// ─────────────────────────────────────────────────────────────────────────────
function checkTrailSL(trade, currentPremium) {
  if (currentPremium == null) return null;

  // Use monitor's trail SL if available, else original SL
  const effectiveSL = trade.currentTrailSL || trade.slPremium;
  if (!effectiveSL) return null;

  if (currentPremium <= effectiveSL) {
    const isTrail = trade.currentTrailSL && trade.currentTrailSL > trade.slPremium;
    return {
      trigger: isTrail ? 'TRAIL_SL_HIT' : 'SL_HIT',
      reason:  isTrail
        ? `Premium ₹${currentPremium} ≤ Trail SL ₹${effectiveSL} — profit protected, exit`
        : `Premium ₹${currentPremium} ≤ SL ₹${effectiveSL} — Stop loss HIT, exit immediately`,
      urgency: isTrail ? 'MEDIUM' : 'CRITICAL',
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// MASTER EXIT CHECKER
// Runs all 7 triggers + SL + Target + Trail SL on one open trade
// Returns first critical exit, or array of all warnings
// ─────────────────────────────────────────────────────────────────────────────
function checkExit(trade, liveData) {
  const {
    m1Now,          // from scoreM1()
    pcrNow,         // number
    currentIV,      // number
    avgIV20,        // number
    entryIV,        // number (IV at entry time)
    ltp,            // current price of underlying
    vwap,           // current VWAP
    rsi14,          // current RSI
    dte,            // days to expiry
    maxPainStrike,  // current max pain
    currentPremium, // current option premium
  } = liveData;

  const results = [];

  // Trail SL runs first (overrides fixed SL if trail is higher)
  const trail  = checkTrailSL(trade, currentPremium);
  const sl     = !trail ? checkSLHit(trade, currentPremium) : null;
  const target = checkTargetHit(trade, currentPremium);
  if (trail)  results.push(trail);
  if (sl)     results.push(sl);
  if (target) results.push(target);

  // If SL or Target hit — exit immediately, skip rest
  if (results.some(r => r.urgency === 'CRITICAL')) {
    return {
      shouldExit: true,
      exitNow:    true,
      trigger:    results[0],
      allTriggers: results,
      currentPremium,
      pnl: trade.entryPremium
        ? +((currentPremium - trade.entryPremium) * trade.lotSize * (trade.lots || 1)).toFixed(2)
        : null,
    };
  }

  // Run all 7 book-based triggers
  const checks = [
    checkOIFlip(trade, m1Now),
    checkPCRCross(trade, pcrNow),
    checkIVSpike(currentIV, avgIV20, entryIV),
    checkVWAPCross(trade, ltp, vwap),
    checkRSIExtreme(trade, rsi14),
    checkThetaAlarm(trade, dte, currentPremium),
    checkMaxPainHit(ltp, maxPainStrike),
  ].filter(Boolean);

  results.push(...checks);

  // Priority: CRITICAL > HIGH > MEDIUM > LOW
  const priority = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
  results.sort((a, b) => (priority[b.urgency] || 0) - (priority[a.urgency] || 0));

  const topTrigger  = results[0] || null;
  const exitNow     = topTrigger && ['CRITICAL', 'HIGH'].includes(topTrigger.urgency);
  const shouldExit  = exitNow;

  const pnl = trade.entryPremium && currentPremium != null
    ? +((currentPremium - trade.entryPremium) * trade.lotSize * (trade.lots || 1)).toFixed(2)
    : null;

  return {
    shouldExit,
    exitNow,
    trigger:     topTrigger,
    allTriggers: results,
    warnings:    results.filter(r => r.urgency === 'LOW'),
    currentPremium,
    pnl,
    pnlLabel: pnl != null
      ? `${pnl >= 0 ? '✅' : '🔴'} P&L: ₹${pnl.toLocaleString('en-IN')}`
      : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Format exit decision for display
// ─────────────────────────────────────────────────────────────────────────────
function formatExit(symbol, exitResult) {
  if (!exitResult.shouldExit) {
    const warns = exitResult.warnings?.map(w => `  ⚠️ ${w.reason}`).join('\n') || '';
    return `✅ ${symbol} — HOLD\n${warns}`;
  }
  const t = exitResult.trigger;
  return [
    `🚨 ${symbol} — EXIT NOW`,
    `   Trigger: ${t.trigger} (${t.urgency})`,
    `   Reason: ${t.reason}`,
    exitResult.pnlLabel ? `   ${exitResult.pnlLabel}` : '',
    exitResult.allTriggers.length > 1
      ? `   Other signals: ${exitResult.allTriggers.slice(1).map(x => x.trigger).join(', ')}`
      : '',
  ].filter(Boolean).join('\n');
}

module.exports = {
  checkExit,
  checkSLHit,
  checkTargetHit,
  checkTrailSL,
  checkOIFlip,
  checkPCRCross,
  checkIVSpike,
  checkVWAPCross,
  checkRSIExtreme,
  checkThetaAlarm,
  checkMaxPainHit,
  formatExit,
};
