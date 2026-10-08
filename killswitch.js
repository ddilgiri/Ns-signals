// killswitch.js — SEBI mandatory auto-halt system
// NISM Series VIII Chapter 6.6 — Algo Trading Kill Switch requirement
// Any condition fires → engine HALTS, no new orders, open trades flagged for manual exit

// ─────────────────────────────────────────────────────────────────────────────
// Kill Switch State (in-memory, resets on restart)
// ─────────────────────────────────────────────────────────────────────────────
const STATE = {
  halted:         false,
  haltReason:     null,
  haltTime:       null,
  haltCode:       null,

  // Counters — reset at start of each trading day
  dailyLoss:      0,       // ₹ realised loss today
  apiErrors:      0,       // consecutive API failures
  noDataSince:    null,    // timestamp of last successful data fetch
  tradesToday:    0,       // total trades placed today

  // Thresholds (SEBI / risk management)
  MAX_DAILY_LOSS: 5000,    // ₹5,000
  MAX_API_ERRORS: 3,       // 3 consecutive errors
  MAX_VIX:        25,      // VIX > 25 = extreme volatility
  MAX_NO_DATA_MS: 2 * 60 * 1000,  // 2 minutes without data
  MAX_TRADES_DAY: 20,      // circuit breaker — max 20 trades per day
};

// ─────────────────────────────────────────────────────────────────────────────
// HALT — triggers the kill switch
// ─────────────────────────────────────────────────────────────────────────────
function halt(code, reason) {
  if (STATE.halted) return; // already halted
  STATE.halted     = true;
  STATE.haltReason = reason;
  STATE.haltTime   = new Date().toISOString();
  STATE.haltCode   = code;

  console.error(`\n🚨🚨🚨 KILL SWITCH ACTIVATED 🚨🚨🚨`);
  console.error(`Code:   ${code}`);
  console.error(`Reason: ${reason}`);
  console.error(`Time:   ${STATE.haltTime}`);
  console.error(`Action: NO NEW ORDERS. Close open trades manually.\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// RESUME — manual reset only (never auto-resume)
// ─────────────────────────────────────────────────────────────────────────────
function resume(adminCode) {
  // Simple admin gate — change this to a real secret in production
  if (adminCode !== 'DILIP_RESUME_2025') {
    console.error('❌ Invalid admin code. Kill switch remains active.');
    return false;
  }
  STATE.halted     = false;
  STATE.haltReason = null;
  STATE.haltTime   = null;
  STATE.haltCode   = null;
  STATE.apiErrors  = 0;
  console.log('✅ Kill switch reset by admin. Engine resuming.');
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONDITION 1 — Daily Loss Limit
// Max ₹5,000 realised loss per day
// ─────────────────────────────────────────────────────────────────────────────
function recordLoss(amount) {
  // amount: positive number = loss in ₹
  if (amount <= 0) return;
  STATE.dailyLoss += amount;

  if (STATE.dailyLoss >= STATE.MAX_DAILY_LOSS) {
    halt(
      'DAILY_LOSS_LIMIT',
      `Daily loss ₹${STATE.dailyLoss.toLocaleString('en-IN')} ≥ limit ₹${STATE.MAX_DAILY_LOSS.toLocaleString('en-IN')}`
    );
  }
}

function recordProfit(amount) {
  // Profit reduces daily loss counter
  if (amount > 0) STATE.dailyLoss = Math.max(0, STATE.dailyLoss - amount);
}

// ─────────────────────────────────────────────────────────────────────────────
// CONDITION 2 — API Error Circuit
// 3 consecutive Angel One API failures → halt (not random errors, consecutive)
// ─────────────────────────────────────────────────────────────────────────────
function recordAPIError(errorMsg) {
  STATE.apiErrors += 1;
  console.warn(`⚠️ API Error #${STATE.apiErrors}: ${errorMsg}`);

  if (STATE.apiErrors >= STATE.MAX_API_ERRORS) {
    halt(
      'API_ERRORS',
      `${STATE.apiErrors} consecutive Angel One API failures: ${errorMsg}`
    );
  }
}

function recordAPISuccess() {
  // Reset error counter on any successful call
  if (STATE.apiErrors > 0) {
    console.log(`✅ API recovered after ${STATE.apiErrors} errors`);
    STATE.apiErrors = 0;
  }
  STATE.noDataSince = null; // reset no-data timer
}

// ─────────────────────────────────────────────────────────────────────────────
// CONDITION 3 — VIX Spike
// VIX > 25 = extreme market volatility = algo should not trade
// NISM VIII 6.6 — systemic risk condition
// ─────────────────────────────────────────────────────────────────────────────
function checkVIX(vix) {
  if (vix == null) return;
  if (vix > STATE.MAX_VIX) {
    halt(
      'VIX_SPIKE',
      `VIX ${vix.toFixed(2)} > ${STATE.MAX_VIX} — Extreme volatility, algo halted for safety`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONDITION 4 — No Data Timeout
// If no successful data fetch for 2 minutes → halt
// Prevents trading on stale data
// ─────────────────────────────────────────────────────────────────────────────
function startNoDataTimer() {
  if (!STATE.noDataSince) {
    STATE.noDataSince = Date.now();
  }
}

function checkNoDataTimeout() {
  if (!STATE.noDataSince) return;
  const elapsed = Date.now() - STATE.noDataSince;
  if (elapsed >= STATE.MAX_NO_DATA_MS) {
    halt(
      'NO_DATA_TIMEOUT',
      `No market data for ${Math.round(elapsed / 1000)}s — possible feed outage or API issue`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONDITION 5 — Trade Count Circuit Breaker
// Max 10 trades per day (paper trade safety)
// Prevents runaway loop from placing unlimited orders
// ─────────────────────────────────────────────────────────────────────────────
function recordTrade() {
  STATE.tradesToday += 1;
  if (STATE.tradesToday >= STATE.MAX_TRADES_DAY) {
    halt(
      'TRADE_LIMIT',
      `${STATE.tradesToday} trades placed today ≥ daily limit ${STATE.MAX_TRADES_DAY} — circuit breaker`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GATE CHECK — called before every order
// Returns true = proceed, false = blocked
// ─────────────────────────────────────────────────────────────────────────────
function isAlive() {
  if (STATE.halted) {
    console.error(`🚨 ENGINE HALTED: ${STATE.haltCode} — ${STATE.haltReason}`);
    return false;
  }
  // Also check no-data timeout inline
  checkNoDataTimeout();
  if (STATE.halted) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// DAILY RESET — call at start of each trading day (9:00 AM)
// ─────────────────────────────────────────────────────────────────────────────
function dailyReset() {
  // Only reset counters — do NOT auto-clear a halt
  // Halt must be manually cleared via resume()
  STATE.dailyLoss   = 0;
  STATE.apiErrors   = 0;
  STATE.noDataSince = null;
  STATE.tradesToday = 0;
  console.log('🔄 Kill switch counters reset for new trading day');
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS — full state dump for monitoring
// ─────────────────────────────────────────────────────────────────────────────
function status() {
  return {
    halted:       STATE.halted,
    haltCode:     STATE.haltCode,
    haltReason:   STATE.haltReason,
    haltTime:     STATE.haltTime,

    dailyLoss:    STATE.dailyLoss,
    lossLimit:    STATE.MAX_DAILY_LOSS,
    lossUsedPct:  Math.round((STATE.dailyLoss / STATE.MAX_DAILY_LOSS) * 100),

    apiErrors:    STATE.apiErrors,
    apiErrorLimit: STATE.MAX_API_ERRORS,

    tradesToday:  STATE.tradesToday,
    tradeLimit:   STATE.MAX_TRADES_DAY,

    noDataSince:  STATE.noDataSince
      ? `${Math.round((Date.now() - STATE.noDataSince) / 1000)}s ago`
      : 'OK',

    statusLine: STATE.halted
      ? `🚨 HALTED — ${STATE.haltCode}`
      : `✅ LIVE — Loss ₹${STATE.dailyLoss}/${STATE.MAX_DAILY_LOSS} | API errors ${STATE.apiErrors}/${STATE.MAX_API_ERRORS} | Trades ${STATE.tradesToday}/${STATE.MAX_TRADES_DAY}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WRAP any Angel One API call with kill switch awareness
// Usage: const data = await guarded(() => getOptionChain(...))
// ─────────────────────────────────────────────────────────────────────────────
async function guarded(fn, label = 'API call') {
  if (!isAlive()) throw new Error('ENGINE_HALTED');
  try {
    const result = await fn();
    recordAPISuccess();
    return result;
  } catch (err) {
    recordAPIError(`${label}: ${err.message}`);
    throw err;
  }
}

module.exports = {
  isAlive,
  guarded,
  halt,
  resume,
  dailyReset,
  status,
  recordLoss,
  recordProfit,
  recordTrade,
  recordAPIError,
  recordAPISuccess,
  checkVIX,
  startNoDataTimer,
  checkNoDataTimeout,
  STATE, // export for testing
};
