// monitor.js — Continuous trade monitoring engine
// Runs every 60 seconds on ALL open trades
// Engine decides: HOLD / TRAIL / EXIT — no human override
// Goal: protect profit, let winners run, cut losers fast

// ─────────────────────────────────────────────────────────────────────────────
// TRAIL SL CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const TRAIL_CONFIG = {
  BUFFER_RS:       3.00,   // Trail SL = peak premium − ₹3
  BREAKEVEN_AT:    3.00,   // Once up ₹3 → SL moves to breakeven
  INITIAL_SL_PCT:  0.90,   // Starting SL = entry × 90% (−10%)
};

// Day-level state — reset at start of each session
const DAY_STATE = {
  totalPnl:       0,       // Running ₹ P&L for the day
  dayLocked:      false,   // true once ₹5k target hit
  lockReason:     null,
  tradesExited:   0,
};

// Per-trade premium history (last 5 readings)
// Key = trade.id, Value = array of {premium, ts}
const PREMIUM_HISTORY = {};

// ─────────────────────────────────────────────────────────────────────────────
// TRAIL SL CALCULATOR
// SL moves UP as profit grows. Never moves down.
// ─────────────────────────────────────────────────────────────────────────────
function calcTrailSL(trade, currentPremium) {
  const initialSL = +(trade.entryPremium * TRAIL_CONFIG.INITIAL_SL_PCT).toFixed(2);
  const profit    = currentPremium - trade.entryPremium;

  // Not yet in profit — keep original SL
  if (profit < TRAIL_CONFIG.BREAKEVEN_AT) {
    return {
      trailSL:   initialSL,
      slType:    'INITIAL',
      slNote:    `Original SL ₹${initialSL}`,
    };
  }

  // In profit — trail up
  const trailSL = +(currentPremium - TRAIL_CONFIG.BUFFER_RS).toFixed(2);

  // Trail SL must be at least breakeven
  const finalSL = Math.max(trailSL, trade.entryPremium);

  // Never go below the last stored trail SL
  const lastSL = trade.currentTrailSL || initialSL;
  const newSL  = Math.max(finalSL, lastSL);

  return {
    trailSL: newSL,
    slType:  newSL > trade.entryPremium ? 'PROFIT_LOCKED' : 'BREAKEVEN',
    slNote:  `Trail SL ₹${newSL} (peak − ₹${TRAIL_CONFIG.BUFFER_RS})`,
    upgraded: newSL > lastSL,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MOMENTUM CHECK — last 5 premium readings
// ─────────────────────────────────────────────────────────────────────────────
function checkMomentum(tradeId, currentPremium) {
  if (!PREMIUM_HISTORY[tradeId]) PREMIUM_HISTORY[tradeId] = [];

  const history = PREMIUM_HISTORY[tradeId];
  history.push({ premium: currentPremium, ts: Date.now() });

  // Keep only last 5
  if (history.length > 5) history.shift();

  if (history.length < 3) {
    return { momentum: 'UNKNOWN', reason: 'Not enough readings yet' };
  }

  const readings = history.map(h => h.premium);
  const first    = readings[0];
  const last     = readings[readings.length - 1];
  const mid      = readings[Math.floor(readings.length / 2)];

  // Count ups vs downs
  let ups = 0, downs = 0;
  for (let i = 1; i < readings.length; i++) {
    if (readings[i] > readings[i-1]) ups++;
    else if (readings[i] < readings[i-1]) downs++;
  }

  // Classify
  if (ups >= readings.length - 1) {
    return { momentum: 'GROWING',   reason: `Premium rising: ${first}→${last}`, ups, downs };
  }
  if (downs >= readings.length - 1) {
    return { momentum: 'FALLING',   reason: `Premium falling: ${first}→${last}`, ups, downs };
  }
  if (last > mid && last > first) {
    return { momentum: 'RECOVERING', reason: `Dip then recovery: ${first}→${mid}→${last}`, ups, downs };
  }
  if (last < mid && last < first) {
    return { momentum: 'REVERSING', reason: `Peak then falling: ${first}→${mid}→${last}`, ups, downs };
  }
  return { momentum: 'PAUSING', reason: `Choppy/flat: ${readings.join('→')}`, ups, downs };
}

// ─────────────────────────────────────────────────────────────────────────────
// OI HEALTH CHECK
// Is the big money still supporting this trade?
// ─────────────────────────────────────────────────────────────────────────────
function checkOIHealth(trade, m1Now) {
  if (!m1Now || m1Now.caseNum == null) {
    return { healthy: true, reason: 'No OI data — assume healthy' };
  }

  const bullishCases = [1, 4]; // Long buildup, Short covering
  const bearishCases = [2, 3]; // Long unwinding, Short buildup

  if (trade.side === 'CE' && bullishCases.includes(m1Now.caseNum)) {
    return { healthy: true,  reason: `OI Case ${m1Now.caseNum} — ${m1Now.label} supports CE` };
  }
  if (trade.side === 'PE' && bearishCases.includes(m1Now.caseNum)) {
    return { healthy: true,  reason: `OI Case ${m1Now.caseNum} — ${m1Now.label} supports PE` };
  }
  if (trade.side === 'CE' && bearishCases.includes(m1Now.caseNum)) {
    return { healthy: false, reason: `OI flipped to Case ${m1Now.caseNum} — ${m1Now.label} — AGAINST CE` };
  }
  if (trade.side === 'PE' && bullishCases.includes(m1Now.caseNum)) {
    return { healthy: false, reason: `OI flipped to Case ${m1Now.caseNum} — ${m1Now.label} — AGAINST PE` };
  }

  return { healthy: true, reason: 'OI neutral — hold for now' };
}

// ─────────────────────────────────────────────────────────────────────────────
// TIME CHECK
// No holding past 2:30 PM — theta + spread kills in last hour
// ─────────────────────────────────────────────────────────────────────────────
function checkTime() {
  const now  = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();

  const EXIT_TIME   = 14 * 60 + 30; // 2:30 PM
  const WARN_TIME   = 14 * 60 + 0;  // 2:00 PM warning

  if (mins >= EXIT_TIME) {
    return { action: 'EXIT', reason: '2:30 PM — mandatory time exit, no holding into close' };
  }
  if (mins >= WARN_TIME) {
    return { action: 'WARN', reason: '2:00 PM — 30 min left, tighten SL to ₹1 buffer' };
  }
  return { action: 'OK', reason: 'Within trading window' };
}

// ─────────────────────────────────────────────────────────────────────────────
// DAY LOCK — ₹5,000 profit = stop all new trades
// ─────────────────────────────────────────────────────────────────────────────
const DAY_TARGET = 5000;

function updateDayPnl(pnlDelta) {
  DAY_STATE.totalPnl += pnlDelta;
  if (!DAY_STATE.dayLocked && DAY_STATE.totalPnl >= DAY_TARGET) {
    DAY_STATE.dayLocked  = true;
    DAY_STATE.lockReason = `Day target ₹${DAY_TARGET.toLocaleString('en-IN')} hit — no more entries`;
    console.log(`\n🔒 DAY LOCKED: ${DAY_STATE.lockReason}\n`);
  }
}

function isDayLocked() {
  return DAY_STATE.dayLocked;
}

function resetDay() {
  DAY_STATE.totalPnl     = 0;
  DAY_STATE.dayLocked    = false;
  DAY_STATE.lockReason   = null;
  DAY_STATE.tradesExited = 0;
  Object.keys(PREMIUM_HISTORY).forEach(k => delete PREMIUM_HISTORY[k]);
  console.log('🔄 Monitor day state reset');
}

// ─────────────────────────────────────────────────────────────────────────────
// MASTER MONITOR FUNCTION
// Called every 60s per open trade
// Returns: { action, reason, trailSL, currentPnl, pnlLabel, alert }
// ─────────────────────────────────────────────────────────────────────────────
function monitorTrade(trade, liveData) {
  const {
    m1Now,          // OI case from scoreM1()
    currentPremium, // current option premium (live)
  } = liveData;

  if (currentPremium == null) {
    return { action: 'HOLD', reason: 'No live premium data — hold and wait', alert: false };
  }

  // Current P&L in rupees
  const units      = (trade.lotSize || 1) * (trade.lots || 1);
  const pnl        = +((currentPremium - trade.entryPremium) * units).toFixed(2);
  const pnlPct     = +(((currentPremium - trade.entryPremium) / trade.entryPremium) * 100).toFixed(1);
  const pnlLabel   = `${pnl >= 0 ? '✅' : '🔴'} ₹${Math.abs(pnl).toLocaleString('en-IN')} (${pnlPct > 0 ? '+' : ''}${pnlPct}%)`;

  // ── CHECK 1: Day target hit ──────────────────────────────────────────────
  if (DAY_STATE.totalPnl + pnl >= DAY_TARGET) {
    return {
      action: 'EXIT',
      reason: `🎯 DAY TARGET ₹5,000 HIT — EXIT and lock the day`,
      urgency: 'CRITICAL',
      currentPremium, pnl, pnlLabel, alert: true,
    };
  }

  // ── CHECK 2: Time exit ───────────────────────────────────────────────────
  const timeCheck = checkTime();
  if (timeCheck.action === 'EXIT') {
    return {
      action: 'EXIT',
      reason: timeCheck.reason,
      urgency: 'HIGH',
      currentPremium, pnl, pnlLabel, alert: true,
    };
  }

  // ── CHECK 3: Trail SL ────────────────────────────────────────────────────
  const trail = calcTrailSL(trade, currentPremium);
  if (currentPremium <= trail.trailSL) {
    return {
      action: 'EXIT',
      reason: `${trail.slType === 'PROFIT_LOCKED' ? '🔒 Profit lock' : '🛑 SL'} hit — premium ₹${currentPremium} ≤ trail SL ₹${trail.trailSL}`,
      urgency: trail.slType === 'PROFIT_LOCKED' ? 'MEDIUM' : 'HIGH',
      trailSL: trail.trailSL,
      currentPremium, pnl, pnlLabel, alert: true,
    };
  }

  // ── CHECK 4: OI health ───────────────────────────────────────────────────
  const oiHealth = checkOIHealth(trade, m1Now);

  // ── CHECK 5: Momentum ────────────────────────────────────────────────────
  const mom = checkMomentum(trade.id, currentPremium);

  // BOTH OI flipped AND momentum reversing = strong exit signal
  if (!oiHealth.healthy && mom.momentum === 'REVERSING') {
    return {
      action: 'EXIT',
      reason: `OI flipped + momentum reversing — ${oiHealth.reason}`,
      urgency: 'HIGH',
      trailSL: trail.trailSL,
      currentPremium, pnl, pnlLabel, alert: true,
    };
  }

  // OI flipped but momentum still ok — warn, tighten buffer to ₹1
  if (!oiHealth.healthy && mom.momentum !== 'FALLING') {
    return {
      action:  'WARN',
      reason:  `⚠️ OI weakening — ${oiHealth.reason}. Watch next candle.`,
      urgency: 'MEDIUM',
      trailSL: trail.trailSL,
      tightenBuffer: true,
      currentPremium, pnl, pnlLabel, alert: true,
    };
  }

  // Momentum falling + in loss = cut it
  if (mom.momentum === 'FALLING' && pnl < 0) {
    return {
      action:  'EXIT',
      reason:  `Premium falling + in loss — ${mom.reason}. Cut now.`,
      urgency: 'HIGH',
      trailSL: trail.trailSL,
      currentPremium, pnl, pnlLabel, alert: true,
    };
  }

  // 2PM warning — tighten trail buffer to ₹1
  if (timeCheck.action === 'WARN') {
    return {
      action:  'HOLD',
      reason:  `${timeCheck.reason} — trail SL tightened`,
      urgency: 'LOW',
      trailSL: Math.max(trail.trailSL, currentPremium - 1),
      tightenBuffer: true,
      currentPremium, pnl, pnlLabel, alert: false,
    };
  }

  // ── All good — HOLD ──────────────────────────────────────────────────────
  const holdReason = mom.momentum === 'GROWING'
    ? `📈 Momentum GROWING — let it run. Trail SL ₹${trail.trailSL}`
    : mom.momentum === 'RECOVERING'
    ? `🔄 Recovering after dip — hold. Trail SL ₹${trail.trailSL}`
    : `⏸ ${mom.momentum} — hold. Trail SL ₹${trail.trailSL}`;

  return {
    action:    'HOLD',
    reason:    holdReason,
    urgency:   'NONE',
    trailSL:   trail.trailSL,
    slUpgraded: trail.upgraded || false,
    currentPremium,
    pnl,
    pnlLabel,
    alert: trail.upgraded, // alert only if SL just moved up (good news)
    momentum: mom.momentum,
    oiHealthy: oiHealth.healthy,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FORMAT MONITOR OUTPUT — for display / alert
// ─────────────────────────────────────────────────────────────────────────────
function formatMonitor(symbol, result) {
  const icon = result.action === 'EXIT' ? '🚨'
             : result.action === 'WARN' ? '⚠️'
             : result.trailSL && result.slUpgraded ? '🔒'
             : '✅';

  const lines = [
    `${icon} ${symbol} — ${result.action}`,
    `   ${result.reason}`,
    result.pnlLabel ? `   P&L: ${result.pnlLabel}` : '',
    result.trailSL  ? `   Trail SL: ₹${result.trailSL}` : '',
  ];

  return lines.filter(Boolean).join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// SELECTION RANKER — picks top 3 stocks for the day
// Called once at 9:45 AM after signals are scored
// ─────────────────────────────────────────────────────────────────────────────
function rankForSelection(signals) {
  // signals = array of decide() output objects with ENTER decision

  const PREMIUM_MIN = 5;
  const PREMIUM_MAX = 20;

  const scored = signals
    .filter(s => s.decision === 'ENTER' && s.entryPremium != null)
    .map(s => {
      const minMove    = +(DAY_TARGET / s.lotSize).toFixed(2);
      const premiumOk  = s.entryPremium >= PREMIUM_MIN && s.entryPremium <= PREMIUM_MAX;

      // Score for selection:
      // Lower minMove = better (large lot size)
      // Premium in sweet spot = better
      // Higher signal score = better
      const lotScore     = Math.max(0, 40 - minMove * 10);    // 0-40 pts, lower move = more
      const premiumScore = premiumOk ? 20 : 5;                // 20 if in range
      const signalScore  = (s.totalScore / 10) * 40;          // 0-40 pts

      const selectionScore = +(lotScore + premiumScore + signalScore).toFixed(1);

      return {
        ...s,
        minMoveFor5k:   minMove,
        selectionScore,
        premiumInRange: premiumOk,
      };
    })
    .sort((a, b) => b.selectionScore - a.selectionScore)
    .slice(0, 3); // TOP 3 ONLY

  return scored;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  monitorTrade,
  formatMonitor,
  rankForSelection,
  calcTrailSL,
  checkMomentum,
  checkOIHealth,
  checkTime,
  updateDayPnl,
  isDayLocked,
  resetDay,
  DAY_STATE,
  PREMIUM_HISTORY,
};
