// alertEngine.js
// Standalone alert-only module for NS-Signals.
// Wired into server.js as a require + a new /alert-scan endpoint.
// Does NOT modify existing scanning/scoring logic.

const https = require('https');

// SECURITY: no hardcoded fallback. Both must be set in Render's dashboard
// (Environment tab) as TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID. If either is
// missing, alerts fail safe (skipped, logged) rather than silently using a
// baked-in credential.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// ── In-memory de-dupe so the same signal doesn't spam every 25s scan cycle ──
// Keyed by `${symbol}_${strike}_${side}`, value = last alert timestamp (ms)
const ALERT_COOLDOWN_MS = 15 * 60 * 1000; // 15 min — tune as needed
const lastAlertSent = new Map();

function canAlert(key) {
  const last = lastAlertSent.get(key);
  const now = Date.now();
  if (!last || (now - last) > ALERT_COOLDOWN_MS) {
    lastAlertSent.set(key, now);
    return true;
  }
  return false;
}

// ── Telegram send (plain HTTPS, no SDK) ──
function sendTelegramAlert(text) {
  return new Promise((resolve, reject) => {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      return reject(new Error('Telegram not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars'));
    }
    const payload = JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'Markdown'
    });

    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(JSON.parse(body));
        else reject(new Error(`Telegram API ${res.statusCode}: ${body}`));
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Entry-timing freshness check ──
// A Case 2/6 signal is only "fresh" if the leg is happening now, not already printed.
// Expects candle data: array of {open, high, low, close, volume} objects, most recent last.
function isEntryFresh(candles, side /* 'CE' or 'PE' */) {
  if (!candles || candles.length < 3) return { fresh: false, reason: 'insufficient candle data' };

  const recent = candles.slice(-3);
  const [prev2, prev1, current] = recent;

  const priorRange = {
    high: Math.max(prev2.high, prev1.high),
    low: Math.min(prev2.low, prev1.low)
  };

  if (side === 'CE') {
    const breaksNewHigh = current.high > priorRange.high;
    const volumeConfirms = current.volume > prev1.volume;
    if (breaksNewHigh && volumeConfirms) return { fresh: true, reason: 'new high break with volume' };
    return { fresh: false, reason: 'move already printed / no fresh break' };
  } else {
    const breaksNewLow = current.low < priorRange.low;
    const volumeConfirms = current.volume > prev1.volume;
    if (breaksNewLow && volumeConfirms) return { fresh: true, reason: 'new low break with volume' };
    return { fresh: false, reason: 'move already printed / no fresh break' };
  }
}

// ── Fuel-check gate ──
// structural filter: prefer far expiry + ITM/ATM over far-OTM
// IV-room gate: current IV should NOT be near its recent-session high
function passesFuelCheck({ daysToExpiry, moneyness /* 'ITM'|'ATM'|'OTM_near'|'OTM_far' */, currentIV, ivRecentHigh, ivRecentLow }) {
  const structuralPass = daysToExpiry >= 3 && (moneyness === 'ITM' || moneyness === 'ATM' || moneyness === 'OTM_near');

  if (!structuralPass) {
    return { pass: false, reason: 'structural filter failed (near expiry or far OTM)' };
  }

  // IV-room check is best-effort, not a hard gate — Angel One's option-greeks API is
  // documented (server.js) as sometimes returning stale/missing data. When IV history
  // isn't available yet (e.g. right after startup, before enough scan cycles have run),
  // don't silently block every alert forever — pass on structural grounds alone and say so.
  if (currentIV == null || ivRecentHigh == null || ivRecentLow == null) {
    return { pass: true, reason: 'structural OK — IV data unavailable, skipping IV-room check' };
  }

  const ivRange = ivRecentHigh - ivRecentLow;
  const ivPositionPct = ivRange > 0 ? ((currentIV - ivRecentLow) / ivRange) * 100 : 50;
  const ivHasRoom = ivPositionPct < 70; // IV not already near its recent highs

  if (ivHasRoom) {
    return { pass: true, reason: `structural OK, IV at ${ivPositionPct.toFixed(0)}% of recent range — room to expand` };
  }
  return { pass: false, reason: `IV already at ${ivPositionPct.toFixed(0)}% of recent range — limited room, skip or reduce size` };
}

// ── Build the alert message text ──
function buildAlertText({ symbol, strike, side, caseNum, oiPct, ltpPct, spot, fuelReason, freshReason }) {
  const caseLabel = caseNum === 2 ? 'Case 2 (Buyers winning — Call wall breaking)' : 'Case 6 (Buyers winning — Put floor breaking)';
  const sideLabel = side === 'CE' ? 'CALL (CE)' : 'PUT (PE)';

  return `🚨 *NS Alert: ${symbol}*

*Strike:* ${strike} ${sideLabel}
*Signal:* ${caseLabel}
*OI Δ:* ${oiPct > 0 ? '+' : ''}${oiPct.toFixed(1)}%  *LTP Δ:* ${ltpPct > 0 ? '+' : ''}${ltpPct.toFixed(1)}%
*Spot:* ${spot}

✅ Fuel check: ${fuelReason}
✅ Entry timing: ${freshReason}

_Alert only — no order placed. Confirm with Mahesh cross-check before entry._`;
}

// ── Build the alert text for the "every UI signal" path — mirrors the app's own
// signal card: direction, verdict, OI formula read, wall/floor, stop/target. No case/
// fuel/freshness gating — this uses whatever signal-analysis + oi-analysis already
// computed, all fields the UI card itself shows, nothing invented for Telegram alone. ──
function buildAnyAlertText({ symbol, strike, side, score, verdict, premium, spot, suggestedTarget, exitLevel, holdZone, whyBuy }) {
  const sideLabel = side === 'CE' ? 'CE' : 'PE';
  const verdictWord = verdict === 'STRONG' ? 'Strong' : verdict === 'MODERATE' ? 'Moderate' : 'Weak';
  const buyLine = premium != null ? `Buy ₹${premium}` : '';

  const lines = [
    `🚨 ${symbol} ${strike} ${sideLabel} — ${score}% ${verdictWord}${buyLine ? ` — ${buyLine}` : ''}`,
    ``,
    `Stock price now: ₹${spot}`,
  ];

  if (suggestedTarget != null) lines.push(`Target: ₹${suggestedTarget} (book profit here)`);
  if (holdZone) lines.push(`Hold: while price stays ${holdZone}`);
  if (exitLevel != null) lines.push(`Exit: ₹${exitLevel} (get out if this breaks)`);
  if (whyBuy) lines.push(``, `Why buy: ${whyBuy}`);

  return lines.join('\n');
}

// ── Main evaluation function — call this per strike per scan cycle ──
// Returns null if no alert fires, otherwise sends via Telegram and returns the alert object.
async function evaluateAndAlert({
  symbol, strike, side, caseNum, oiPct, ltpPct, spot,
  candles, daysToExpiry, moneyness, currentIV, ivRecentHigh, ivRecentLow
}) {
  // Only Case 2 (CE) or Case 6 (PE) — per Dilip's framework, these are the only
  // cases with fresh, sustained buyer conviction worth alerting on.
  if (!((side === 'CE' && caseNum === 2) || (side === 'PE' && caseNum === 6))) {
    return null;
  }

  const alertKey = `${symbol}_${strike}_${side}`;
  if (!canAlert(alertKey)) return null; // cooldown active, skip

  const fuelCheck = passesFuelCheck({ daysToExpiry, moneyness, currentIV, ivRecentHigh, ivRecentLow });
  if (!fuelCheck.pass) return null;

  const freshCheck = isEntryFresh(candles, side);
  if (!freshCheck.fresh) return null;

  const text = buildAlertText({
    symbol, strike, side, caseNum, oiPct, ltpPct, spot,
    fuelReason: fuelCheck.reason,
    freshReason: freshCheck.reason
  });

  try {
    await sendTelegramAlert(text);
    return { symbol, strike, side, caseNum, sentAt: new Date().toISOString() };
  } catch (err) {
    console.error('[alertEngine] Telegram send failed:', err.message);
    return null;
  }
}

// ── "Every UI signal" evaluation — no case/fuel/freshness gating. Sends any signal
// that already cleared the app's own score/verdict filter (whatever the caller passes
// in), so Telegram tracks the UI 1:1. Only gate kept: the same cooldown as above, so
// the same strike+side doesn't re-ping every 25s while its score stays high. ──
async function evaluateAndAlertAny({ symbol, strike, side, score, verdict, premium, spot, suggestedTarget, exitLevel, holdZone, whyBuy }) {
  const alertKey = `${symbol}_${strike}_${side}`;
  if (!canAlert(alertKey)) return null; // cooldown active, skip

  const text = buildAnyAlertText({ symbol, strike, side, score, verdict, premium, spot, suggestedTarget, exitLevel, holdZone, whyBuy });

  try {
    await sendTelegramAlert(text);
    return { symbol, strike, side, score, verdict, sentAt: new Date().toISOString() };
  } catch (err) {
    console.error('[alertEngine] Telegram send failed:', err.message);
    return null;
  }
}

module.exports = {
  evaluateAndAlert,
  evaluateAndAlertAny,
  sendTelegramAlert, // exported for a one-off test ping
  isEntryFresh,
  passesFuelCheck,
  isConfigured: () => !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID)
};
