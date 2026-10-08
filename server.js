// server.js — Main engine loop
// Wires data.js → modules.js → decision.js → exit.js → killswitch.js
// Express API + scan loop every 60 seconds

'use strict';
const express    = require('express');
const cors       = require('cors');
const { login, fetchTodayEvents, fetchStockData, SESSION } = require('./data');
const { scoreAll }          = require('./modules');
const { decide, formatDecision, calcMinMoveFor5k } = require('./decision');
const { checkExit, formatExit }  = require('./exit');
const ks = require('./killswitch');
const {
  monitorTrade, formatMonitor, rankForSelection,
  updateDayPnl, isDayLocked, resetDay, DAY_STATE,
} = require('./monitor');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// F&O stock universe — symbol, NSE equity token, NFO futures token
// Add more from Angel One symbol master as needed
// Format: { symbol, eqToken, futToken, lotSize, strikeStep }
// ─────────────────────────────────────────────────────────────────────────────
const WATCHLIST = [
  { symbol: 'RELIANCE',   eqToken: '2885',  futToken: '10604', strikeStep: 50  },
  { symbol: 'NIFTY',      eqToken: '26000', futToken: '26009', strikeStep: 50  },
  { symbol: 'BANKNIFTY',  eqToken: '26009', futToken: '26011', strikeStep: 100 },
  { symbol: 'HDFCBANK',   eqToken: '1333',  futToken: '10599', strikeStep: 50  },
  { symbol: 'ICICIBANK',  eqToken: '4963',  futToken: '10605', strikeStep: 50  },
  { symbol: 'AXISBANK',   eqToken: '5900',  futToken: '10615', strikeStep: 50  },
  { symbol: 'SBIN',       eqToken: '3045',  futToken: '10626', strikeStep: 10  },
  { symbol: 'BAJFINANCE', eqToken: '317',   futToken: '10622', strikeStep: 100 },
  { symbol: 'TECHM',      eqToken: '13538', futToken: '10651', strikeStep: 50  },
  { symbol: 'INFY',       eqToken: '1594',  futToken: '10606', strikeStep: 50  },
  { symbol: 'TCS',        eqToken: '11536', futToken: '10647', strikeStep: 100 },
  { symbol: 'WIPRO',      eqToken: '3787',  futToken: '10659', strikeStep: 10  },
  { symbol: 'JUBLFOOD',   eqToken: '18096', futToken: '45872', strikeStep: 50  },
  { symbol: 'ASTRAL',     eqToken: '14418', futToken: '57072', strikeStep: 50  },
  { symbol: 'KALYANKJIL', eqToken: '21741', futToken: '67832', strikeStep: 10  },
  { symbol: 'LICHSGFIN',  eqToken: '1752',  futToken: '42673', strikeStep: 10  },
  { symbol: 'MARICO',     eqToken: '4067',  futToken: '42685', strikeStep: 10  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Expiry helper — nearest weekly/monthly expiry
// Returns 'DDMMMYYYY' format for Angel One option chain
// ─────────────────────────────────────────────────────────────────────────────
function getNearestExpiry() {
  const now   = new Date();
  const day   = now.getDay(); // 0=Sun, 4=Thu
  const daysToThursday = (4 - day + 7) % 7 || 7;
  const expiry = new Date(now);
  expiry.setDate(now.getDate() + daysToThursday);
  const dd  = String(expiry.getDate()).padStart(2, '0');
  const mmm = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][expiry.getMonth()];
  const yyyy = expiry.getFullYear();
  return `${dd}${mmm}${yyyy}`;
}

function getDTE() {
  const now   = new Date();
  const day   = now.getDay();
  const daysToThursday = (4 - day + 7) % 7 || 7;
  return daysToThursday;
}

function getATMStrike(ltp, strikeStep) {
  return Math.round(ltp / strikeStep) * strikeStep;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory store
// ─────────────────────────────────────────────────────────────────────────────
let SIGNALS       = [];   // latest scored signals
let OPEN_TRADES   = [];   // active trades
let CLOSED_TRADES = [];   // exited trades
let EVENT_FLAGS   = new Set(); // M0 — stocks with events today
let PREV_OI_MAP   = {};   // symbol → previous cycle futures OI
let IV_AVG_MAP    = {};   // symbol → rolling 20-cycle IV average
let SCAN_RUNNING  = false;
let LAST_SCAN     = null;

// ─────────────────────────────────────────────────────────────────────────────
// Scan one stock
// ─────────────────────────────────────────────────────────────────────────────
async function scanSymbol(stock) {
  const { symbol, eqToken, futToken, strikeStep } = stock;
  const expiry = getNearestExpiry();
  const dte    = getDTE();

  let raw;
  try {
    raw = await ks.guarded(
      () => fetchStockData(symbol, eqToken, futToken, expiry, null),
      `fetchStockData(${symbol})`
    );
  } catch (e) {
    console.warn(`⚠️ ${symbol} fetch failed: ${e.message}`);
    return null;
  }

  if (!raw || !raw.futures) return null;

  // ATM strike from live LTP
  const ltp       = raw.futures.ltp;
  const atmStrike = getATMStrike(ltp, strikeStep);

  // IV rolling average (20 cycles ≈ 20 min on 1-min scan)
  const currentIV = raw.currentIV;
  if (currentIV) {
    if (!IV_AVG_MAP[symbol]) IV_AVG_MAP[symbol] = [];
    IV_AVG_MAP[symbol].push(currentIV);
    if (IV_AVG_MAP[symbol].length > 20) IV_AVG_MAP[symbol].shift();
  }
  const avgIV20 = IV_AVG_MAP[symbol]?.length
    ? IV_AVG_MAP[symbol].reduce((a, b) => a + b, 0) / IV_AVG_MAP[symbol].length
    : null;

  // Previous OI for M1
  const prevOI = PREV_OI_MAP[symbol] ?? null;
  PREV_OI_MAP[symbol] = raw.futures.oi;

  // Score all modules
  const scoreResult = scoreAll({
    symbol,
    futures:       raw.futures,
    prevFuturesOI: prevOI,
    pcr:           raw.pcr,
    currentIV,
    avgIV20,
    candleData:    { candles: raw.candles, vwap: raw.vwap, rsi14: raw.rsi14, macd: raw.macd, avgVol: raw.avgVol },
    maxPainStrike: raw.maxPainStrike,
    chain:         raw.chain,
    eventFlags:    EVENT_FLAGS,
    dte,
    side: 'CE', // default; PE scoring is symmetric, flip signs
  });

  // Final decision
  const currentPremium = raw.chain?.find(r => r.strikePrice === atmStrike)?.CE?.lastPrice || 0;
  const decision       = decide(scoreResult, currentPremium);

  // VIX check (use ATM IV as proxy if VIX not available)
  if (currentIV) ks.checkVIX(currentIV);

  return { ...decision, atmStrike, expiry, dte, ltp, currentPremium };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exit check on all open trades
// ─────────────────────────────────────────────────────────────────────────────
async function checkOpenTrades() {
  if (!OPEN_TRADES.length) return;

  for (const trade of OPEN_TRADES) {
    const stock = WATCHLIST.find(s => s.symbol === trade.symbol);
    if (!stock) continue;

    let raw;
    try {
      raw = await ks.guarded(
        () => fetchStockData(trade.symbol, stock.eqToken, stock.futToken, trade.expiry, null),
        `exitCheck(${trade.symbol})`
      );
    } catch (e) { continue; }

    if (!raw) continue;

    const atmStrike     = getATMStrike(raw.futures?.ltp, stock.strikeStep);
    const currentPremium = raw.chain?.find(r => r.strikePrice === atmStrike)?.[trade.side]?.lastPrice || 0;
    const currentIV     = raw.currentIV;
    const avgIV20       = IV_AVG_MAP[trade.symbol]?.length
      ? IV_AVG_MAP[trade.symbol].reduce((a,b)=>a+b,0)/IV_AVG_MAP[trade.symbol].length
      : null;

    const exitResult = checkExit(trade, {
      m1Now:          null, // would need prev OI — simplified for now
      pcrNow:         raw.pcr,
      currentIV,
      avgIV20,
      entryIV:        trade.entryIV,
      ltp:            raw.futures?.ltp,
      vwap:           raw.vwap,
      rsi14:          raw.rsi14,
      dte:            getDTE(),
      maxPainStrike:  raw.maxPainStrike,
      currentPremium,
    });

    console.log(formatExit(trade.symbol, exitResult));

    // Run monitor (trail SL + momentum + day lock + time exit)
    const scoreResult = { side: trade.side }; // minimal for OI check
    const m1Now = null; // simplified — full OI tracking needs prev cycle
    const monResult = monitorTrade(trade, { m1Now, currentPremium });

    // Update trail SL on trade object
    if (monResult.trailSL && monResult.trailSL !== trade.currentTrailSL) {
      trade.currentTrailSL = monResult.trailSL;
      if (monResult.slUpgraded) {
        console.log(`🔒 ${trade.symbol} trail SL → ₹${monResult.trailSL} | P&L: ${monResult.pnlLabel}`);
      }
    }

    // Monitor says exit OR exit engine says exit
    const shouldExitNow = monResult.action === 'EXIT' || exitResult.shouldExit;
    const exitSource    = monResult.action === 'EXIT' ? monResult : exitResult;

    if (shouldExitNow) {
      const pnl = monResult.pnl || exitResult.pnl || 0;
      if (pnl < 0) ks.recordLoss(Math.abs(pnl));
      else          ks.recordProfit(pnl);

      // Update day P&L
      updateDayPnl(pnl);

      CLOSED_TRADES.push({
        ...trade,
        exitPremium:  currentPremium,
        exitTime:     new Date().toISOString(),
        exitTrigger:  exitSource.trigger?.trigger || monResult.reason,
        exitReason:   exitSource.trigger?.reason  || monResult.reason,
        pnl,
      });
      OPEN_TRADES = OPEN_TRADES.filter(t => t !== trade);
      console.log(`🚨 ${trade.symbol} EXITED: ${monResult.reason || exitResult.trigger?.reason} | P&L ₹${pnl}`);
    } else {
      console.log(formatMonitor(trade.symbol, monResult));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main scan loop
// ─────────────────────────────────────────────────────────────────────────────
async function runScan() {
  if (SCAN_RUNNING) return;
  if (!ks.isAlive()) return;

  SCAN_RUNNING = true;
  console.log(`\n🔍 Scan started: ${new Date().toLocaleTimeString('en-IN')}`);

  try {
    // Check open trades first
    await checkOpenTrades();

    // Scan watchlist
    const results = [];
    for (const stock of WATCHLIST) {
      if (!ks.isAlive()) break;
      const result = await scanSymbol(stock);
      if (result) results.push(result);
      await new Promise(r => setTimeout(r, 300)); // 300ms spacing between stocks
    }

    SIGNALS   = results.sort((a, b) => b.totalScore - a.totalScore);
    LAST_SCAN = new Date().toISOString();

    // Log top signals
    const enters = SIGNALS.filter(s => s.decision === 'ENTER');
    const top3   = rankForSelection(enters); // ranked by minMoveFor5k + score

    console.log(`✅ Scan complete: ${SIGNALS.length} stocks | ${enters.length} ENTER signals`);
    if (isDayLocked()) {
      console.log(`🔒 DAY LOCKED — ₹5k target hit. No new entries. Total P&L: ₹${DAY_STATE.totalPnl}`);
    } else {
      console.log(`Top 3 picks:`);
      top3.forEach(s => {
        console.log(`  ${s.symbol} ${s.side} — min move ₹${s.minMoveFor5k} for ₹5k | score ${s.totalScore}/10`);
      });
    }
    console.log(`Kill switch: ${ks.status().statusLine}`);

  } catch (err) {
    console.error('Scan error:', err.message);
    ks.recordAPIError(`runScan: ${err.message}`);
  } finally {
    SCAN_RUNNING = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup sequence
// ─────────────────────────────────────────────────────────────────────────────
async function startup() {
  console.log('🚀 F&O Engine starting...');

  // Daily reset
  ks.dailyReset();

  // Login — retry every 2 min if failed, don't crash server
  let loggedIn = false;
  try {
    await login();
    loggedIn = true;
  } catch (e) {
    console.error('❌ Login failed:', e.message, '— will retry in 2 min');
  }

  // M0 — fetch today's events at startup
  if (loggedIn) {
    EVENT_FLAGS = await fetchTodayEvents();
  }

  // Start scan loop — every 60 seconds
  await runScan();
  setInterval(runScan, 60 * 1000);

  // Retry login every 2 min until success
  if (!loggedIn) {
    const retryLogin = setInterval(async () => {
      try {
        await login();
        EVENT_FLAGS = await fetchTodayEvents();
        console.log('✅ Login retry successful');
        clearInterval(retryLogin);
      } catch (e) {
        console.error('❌ Login retry failed:', e.message);
      }
    }, 2 * 60 * 1000);
  }

  // Daily reset at 9:00 AM
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 9 && now.getMinutes() === 0) {
      ks.dailyReset();
      resetDay(); // reset monitor day state too
      fetchTodayEvents().then(f => { EVENT_FLAGS = f; });
    }
  }, 60 * 1000);

  console.log(`✅ Engine live on port ${PORT}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// REST API endpoints
// ─────────────────────────────────────────────────────────────────────────────

// All signals (sorted by score)
app.get('/signals', (req, res) => {
  res.json({ signals: SIGNALS, lastScan: LAST_SCAN, count: SIGNALS.length });
});

// Only ENTER signals
app.get('/signals/enter', (req, res) => {
  res.json({ signals: SIGNALS.filter(s => s.decision === 'ENTER') });
});

// Kill switch status
app.get('/killswitch', (req, res) => {
  res.json(ks.status());
});

// Manual kill switch halt
app.post('/killswitch/halt', (req, res) => {
  ks.halt('MANUAL', req.body.reason || 'Manual halt by user');
  res.json({ halted: true });
});

// Manual kill switch resume
app.post('/killswitch/resume', (req, res) => {
  const ok = ks.resume(req.body.adminCode);
  res.json({ resumed: ok });
});

// Open trades
app.get('/trades/open', (req, res) => {
  res.json({ trades: OPEN_TRADES });
});

// Closed trades
app.get('/trades/closed', (req, res) => {
  res.json({ trades: CLOSED_TRADES });
});

// Manual add trade (paper mode)
app.post('/trades/add', (req, res) => {
  if (!ks.isAlive()) return res.status(503).json({ error: 'ENGINE_HALTED' });
  const { symbol, side, strike, entryPremium, lotSize, lots, expiry, entryIV } = req.body;
  const slPremium     = +(entryPremium * 0.90).toFixed(2);
  const targetPremium = +(entryPremium * 1.40).toFixed(2);
  const trade = {
    id: Date.now(),
    symbol, side, strike, entryPremium, slPremium, targetPremium,
    lotSize: lotSize || 500, lots: lots || 1,
    expiry, entryIV,
    entryTime: new Date().toISOString(),
  };
  OPEN_TRADES.push(trade);
  ks.recordTrade();
  res.json({ trade });
});

// Manual exit trade
app.post('/trades/exit/:id', (req, res) => {
  const id    = parseInt(req.params.id);
  const trade = OPEN_TRADES.find(t => t.id === id);
  if (!trade) return res.status(404).json({ error: 'Trade not found' });
  const { exitPremium } = req.body;
  const pnl = (exitPremium - trade.entryPremium) * trade.lotSize * trade.lots;
  if (pnl < 0) ks.recordLoss(Math.abs(pnl));
  else          ks.recordProfit(pnl);
  CLOSED_TRADES.push({ ...trade, exitPremium, exitTime: new Date().toISOString(), exitTrigger: 'MANUAL', pnl });
  OPEN_TRADES = OPEN_TRADES.filter(t => t.id !== id);
  res.json({ exited: true, pnl });
});

// Top 3 picks ranked by minMoveFor5k
app.get('/signals/top3', (req, res) => {
  const enters = SIGNALS.filter(s => s.decision === 'ENTER');
  const top3   = rankForSelection(enters);
  res.json({
    top3,
    dayLocked:  isDayLocked(),
    dayPnl:     DAY_STATE.totalPnl,
    dayTarget:  5000,
    lastScan:   LAST_SCAN,
  });
});

// Day status
app.get('/day', (req, res) => {
  res.json({
    locked:     isDayLocked(),
    totalPnl:   DAY_STATE.totalPnl,
    target:     5000,
    lockReason: DAY_STATE.lockReason,
    tradesExited: DAY_STATE.tradesExited,
  });
});

// Force scan now
app.post('/scan', async (req, res) => {
  await runScan();
  res.json({ done: true, signals: SIGNALS.length });
});

// Health
app.get('/health', (req, res) => {
  res.json({
    status:     ks.isAlive() ? 'LIVE' : 'HALTED',
    lastScan:   LAST_SCAN,
    openTrades: OPEN_TRADES.length,
    ks:         ks.status(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => startup());
