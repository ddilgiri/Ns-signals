// decision.js — Final verdict engine
// Takes scoreAll() output → produces trade decision with entry, SL, target
// No human override. Score ≥ +6 = auto ENTER. Period.

const { checkOptionsEntryValid, checkTimeSL, checkSidewaysKill } = require('./optionsFilter');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const ENTER_THRESHOLD = 6;   // Score ≥ 6 → ENTER
const WAIT_THRESHOLD  = 3;   // Score 3-5 → WAIT
const MAX_CAPITAL     = 50000;
const SL_PCT          = 0.90; // Stop loss = avg premium × 0.90 (10% loss)
const TARGET_PCT      = 1.40; // Target    = avg premium × 1.40 (40% gain) — 4:1 RR roughly
const MAX_LOTS        = 1;    // Paper trade: 1 lot only

// ─────────────────────────────────────────────────────────────────────────────
// Lot size map (NSE F&O standard lot sizes)
// Add more as needed
// ─────────────────────────────────────────────────────────────────────────────
const LOT_SIZES = {
  NIFTY:      50,
  BANKNIFTY:  15,
  FINNIFTY:   40,
  MIDCPNIFTY: 75,
  // Stocks — common ones
  RELIANCE:   250,
  TCS:        150,
  INFY:       300,
  HDFCBANK:   550,
  ICICIBANK:  700,
  AXISBANK:   1200,
  KOTAKBANK:  400,
  SBIN:       1500,
  BAJFINANCE: 125,
  BAJAJFINSV: 200,
  TECHM:      600,
  WIPRO:      1500,
  HCLTECH:    700,
  LTIM:       150,
  TATASTEEL:  5500,
  TATAMOTORS: 1400,
  MARUTI:     100,
  TITAN:      375,
  ASIANPAINT: 200,
  ULTRACEMCO: 100,
  NESTLEIND:  40,
  HINDUNILVR: 300,
  SUNPHARMA:  350,
  DRREDDY:    125,
  CIPLA:      650,
  DIVISLAB:   100,
  APOLLOHOSP: 125,
  ONGC:       3850,
  POWERGRID:  4700,
  NTPC:       5750,
  COALINDIA:  4200,
  BPCL:       3800,
  IOC:        7500,
  GAIL:       3850,
  ADANIPORTS: 1250,
  ADANIENT:   250,
  JUBLFOOD:   1250,
  ASTRAL:     500,
  KALYANKJIL: 3000,
  LICHSGFIN:  2000,
  MARICO:     1200,
};

function getLotSize(symbol) {
  return LOT_SIZES[symbol.toUpperCase()] || 500; // default 500 if unknown
}

// ─────────────────────────────────────────────────────────────────────────────
// Min move needed to hit ₹5,000 day target
// Lower = better (large lot size stocks need tiny move)
// ─────────────────────────────────────────────────────────────────────────────
const DAY_TARGET_RS = 5000;

function calcMinMoveFor5k(symbol, lots = 1) {
  const lotSize = getLotSize(symbol);
  const units   = lotSize * lots;
  return +(DAY_TARGET_RS / units).toFixed(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Capital check — can we afford 1 lot?
// ─────────────────────────────────────────────────────────────────────────────
function checkCapital(premium, symbol) {
  const lotSize   = getLotSize(symbol);
  const cost1Lot  = premium * lotSize;
  const canAfford = cost1Lot <= MAX_CAPITAL;
  return {
    lotSize,
    cost1Lot,
    canAfford,
    lots: canAfford ? MAX_LOTS : 0,
    capitalNote: canAfford
      ? `✅ 1 lot = ₹${cost1Lot.toLocaleString('en-IN')}`
      : `❌ 1 lot = ₹${cost1Lot.toLocaleString('en-IN')} exceeds ₹${MAX_CAPITAL.toLocaleString('en-IN')} capital`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry time gate
// Never enter in first 15 min (9:15–9:30) unless M0 is clean
// ─────────────────────────────────────────────────────────────────────────────
function checkEntryTime(m0Flag) {
  const now  = new Date();
  const hour = now.getHours();
  const min  = now.getMinutes();
  const mins = hour * 60 + min; // minutes since midnight

  const marketOpen  = 9  * 60 + 15;  // 9:15 AM
  const safeEntry   = 9  * 60 + 45;  // 9:45 AM — institution manipulation zone 9:15-9:45
  const noNewTrades = 15 * 60 + 0;   // 3:00 PM — no new entries in last 15 min
  const marketClose = 15 * 60 + 30;  // 3:30 PM

  if (mins < marketOpen) return { allowed: false, reason: 'Market not open yet' };
  if (mins >= marketClose) return { allowed: false, reason: 'Market closed' };
  if (mins >= noNewTrades) return { allowed: false, reason: 'Too close to close — no new entries after 3 PM' };

  // First 15 minutes — only allow if no event flag
  if (mins < safeEntry && m0Flag === 'EVENT') {
    return { allowed: false, reason: 'M0 event flagged — wait till 9:30 AM' };
  }

  return { allowed: true, reason: 'Entry window open' };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN DECISION FUNCTION
// Input: scoreAll() output + current option premium
// Output: full trade decision object
// ─────────────────────────────────────────────────────────────────────────────
function decide(scoreResult, currentPremium, filterData = null) {
  const { symbol, verdict, totalScore, m0, m1, m2, m3, m4, m5, m6, side } = scoreResult;

  // ── Options entry filter (runs BEFORE scoring matters) ────────────────────
  let filterCheck = { valid: true, issues: [] };
  if (filterData) {
    filterCheck = checkOptionsEntryValid(side, filterData);
  }

  // ── Time gate ──────────────────────────────────────────────────────────────
  const timeCheck = checkEntryTime(m0.flag);

  // ── Capital check ──────────────────────────────────────────────────────────
  const capitalCheck = checkCapital(currentPremium, symbol);

  // ── Hard blocks ────────────────────────────────────────────────────────────
  const blocked =
    !timeCheck.allowed ||
    !capitalCheck.canAfford ||
    m3.flag === 'AVOID' ||     // IV spike = never buy expensive options
    !filterCheck.valid;        // optionsFilter hard block

  // ── Final decision ─────────────────────────────────────────────────────────
  let decision, entryPremium, slPremium, targetPremium, tradeNote;

  if (blocked) {
    decision = 'BLOCKED';
    tradeNote = !timeCheck.allowed      ? `⏰ ${timeCheck.reason}`
              : !capitalCheck.canAfford ? `💰 ${capitalCheck.capitalNote}`
              : !filterCheck.valid      ? `🚫 Filter: ${filterCheck.issues[0]}`
              : `🔴 IV Spike — ${m3.label}`;
    entryPremium = slPremium = targetPremium = null;

  } else if (totalScore >= ENTER_THRESHOLD) {
    decision      = 'ENTER';
    entryPremium  = currentPremium;
    slPremium     = +(currentPremium * SL_PCT).toFixed(2);      // -10%
    targetPremium = +(currentPremium * TARGET_PCT).toFixed(2);  // +40%
    const minMove = calcMinMoveFor5k(symbol);
    tradeNote     = `🟢 ENTER ${side} | Entry ₹${entryPremium} | SL ₹${slPremium} | Target ₹${targetPremium} | ₹5k needs ₹${minMove} move`;

  } else if (totalScore >= WAIT_THRESHOLD) {
    decision  = 'WAIT';
    tradeNote = `🟡 WAIT — Score ${totalScore}/10. Recheck OI in 30 min.`;
    entryPremium = slPremium = targetPremium = null;

  } else {
    decision  = 'AVOID';
    tradeNote = `🔴 AVOID — Score ${totalScore}/10. Conditions not met.`;
    entryPremium = slPremium = targetPremium = null;
  }

  // ── Why summary — top 3 factors ───────────────────────────────────────────
  const factors = [
    { name: 'M1 OI',    score: m1.score,          label: m1.label },
    { name: 'M2 PCR',   score: m2.score,          label: m2.label },
    { name: 'M3 IV',    score: m3.penaltyScore,   label: m3.label },
    { name: 'M5 Trend', score: m5.score,          label: m5.label },
    { name: 'M6 MaxPain', score: m6.score,        label: m6.label },
  ].sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 3);

  return {
    // Core decision
    symbol,
    side,
    decision,
    tradeNote,
    totalScore,
    maxScore: 10,

    // Strike details (from M4)
    strike:    m4?.recommendedStrike,
    delta:     m4?.delta,
    deltaFlag: m4?.deltaFlag,
    dte:       m4?.dte,
    dteRisk:   m4?.dteRisk,

    // Money details
    entryPremium,
    slPremium,
    targetPremium,
    riskReward: entryPremium
      ? `${((targetPremium - entryPremium) / (entryPremium - slPremium)).toFixed(1)}:1`
      : null,
    lotSize:   capitalCheck.lotSize,
    cost1Lot:  capitalCheck.cost1Lot,
    capitalNote: capitalCheck.capitalNote,

    // Context
    timeCheck,
    topFactors: factors,
    m0Event:   m0.flag === 'EVENT' ? m0.label : null,
    ivFlag:    m3.flag,
    filterCheck,                    // optionsFilter result

    // Full module output (for audit/display)
    modules: { m0, m1, m2, m3, m4, m5, m6 },

    minMoveFor5k: decision === 'ENTER' ? calcMinMoveFor5k(symbol) : null,
    premiumInRange: currentPremium >= 5 && currentPremium <= 20,
    timestamp: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Format for display (compact one-liner per stock)
// ─────────────────────────────────────────────────────────────────────────────
function formatDecision(d) {
  const icon = d.decision === 'ENTER' ? '🟢'
             : d.decision === 'WAIT'  ? '🟡'
             : d.decision === 'BLOCKED' ? '⛔'
             : '🔴';

  const lines = [
    `${icon} ${d.symbol} ${d.side} ${d.strike || ''} — ${d.decision} (${d.totalScore}/10)`,
    d.tradeNote,
  ];

  if (d.decision === 'ENTER') {
    lines.push(`   Entry: ₹${d.entryPremium} | SL: ₹${d.slPremium} | Target: ₹${d.targetPremium} | RR: ${d.riskReward}`);
    lines.push(`   Lot: ${d.lotSize} | Cost: ${d.capitalNote}`);
    lines.push(`   DTE: ${d.dte} — ${d.dteRisk}`);
  }

  if (d.topFactors?.length) {
    lines.push(`   Top signals: ${d.topFactors.map(f => `${f.name}(${f.score > 0 ? '+' : ''}${f.score})`).join(', ')}`);
  }

  return lines.join('\n');
}

module.exports = { decide, formatDecision, getLotSize, checkCapital, checkEntryTime, calcMinMoveFor5k, checkTimeSL, checkSidewaysKill };
