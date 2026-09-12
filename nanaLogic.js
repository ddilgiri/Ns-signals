// ============================================================
// NANA CAPITAL RULES — Core Trading Logic
// Weekly S/R retest + spot-based SL + OI confirmation + sector check
// Named-rule structure (2026-09-12) — math is byte-identical to the
// original inline version, refactored into testable named functions
// per Dilip's own reference paste.
// ============================================================

/**
 * RULE 1: Weekly Support/Resistance Zone Detection
 * A zone is valid only if price touched it 2+ times historically (real S/R, not noise)
 */
function findWeeklySRZones(candles, clusterPct = 0.01) {
  const swingPoints = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i];
    const isSwingHigh = c.high > candles[i-1].high && c.high > candles[i-2].high &&
                         c.high > candles[i+1].high && c.high > candles[i+2].high;
    const isSwingLow = c.low < candles[i-1].low && c.low < candles[i-2].low &&
                        c.low < candles[i+1].low && c.low < candles[i+2].low;
    if (isSwingHigh) swingPoints.push({ level: c.high, type: 'resistance' });
    if (isSwingLow) swingPoints.push({ level: c.low, type: 'support' });
  }

  const zones = [];
  swingPoints.sort((a, b) => a.level - b.level).forEach(p => {
    const existing = zones.find(z => Math.abs(z.level - p.level) / p.level < clusterPct && z.type === p.type);
    if (existing) {
      existing.level = (existing.level * existing.touches + p.level) / (existing.touches + 1);
      existing.touches += 1;
    } else {
      zones.push({ level: p.level, type: p.type, touches: 1 });
    }
  });

  return zones.filter(z => z.touches >= 2);
}

function findDailySRZones(candles) {
  return findWeeklySRZones(candles, 0.005);
}

/**
 * RULE 2: Daily Trigger Candle
 */
function checkDailyTrigger(nearestZone, dailyCandles) {
  const last3 = dailyCandles.slice(-3);
  if (last3.length < 2) return null;
  const trigger = last3[last3.length - 1];
  const prev = last3[last3.length - 2];

  const isBullish = nearestZone.type === 'support' &&
    trigger.close > trigger.open &&
    trigger.close > prev.close &&
    trigger.low <= nearestZone.level * 1.005;

  const isBearish = nearestZone.type === 'resistance' &&
    trigger.close < trigger.open &&
    trigger.close < prev.close &&
    trigger.high >= nearestZone.level * 0.995;

  if (isBullish) return 'CE';
  if (isBearish) return 'PE';
  return null;
}

/**
 * RULE 3: OI Confirmation Gate
 */
function oiConfirms(direction, oiCase) {
  return (direction === 'CE' && oiCase === 2) || (direction === 'PE' && oiCase === 6);
}

/**
 * RULE 4: Spot-based Stop Loss
 */
function calcSpotSL(direction, nearestZone, triggerCandle, spot) {
  const buffer = spot * 0.003;
  return direction === 'CE'
    ? Number((Math.min(nearestZone.level, triggerCandle.low) - buffer).toFixed(2))
    : Number((Math.max(nearestZone.level, triggerCandle.high) + buffer).toFixed(2));
}

/**
 * RULE 5: Layered Targets
 */
function calcTargets(direction, spot, dailyCandles, weeklyZones) {
  const dailyZones = findDailySRZones(dailyCandles.slice(-15));
  const scalpTargets = direction === 'CE'
    ? dailyZones.filter(z => z.level > spot).sort((a, b) => a.level - b.level).slice(0, 3)
    : dailyZones.filter(z => z.level < spot).sort((a, b) => b.level - a.level).slice(0, 3);

  const positional = weeklyZones
    .filter(z => direction === 'CE' ? z.level > spot : z.level < spot)
    .sort((a, b) => direction === 'CE' ? a.level - b.level : b.level - a.level)[0];

  return {
    scalpTargets: scalpTargets.map(t => Number(t.level.toFixed(2))),
    positionalTarget: positional ? Number(positional.level.toFixed(2)) : null
  };
}

/**
 * RULE 6: Strike Selection
 */
function strikeRule() {
  return 'ATM or 1 strike ITM — match spot zone, higher delta, avoid far OTM';
}

/**
 * RULE 7: Sector Confirmation
 */
function sectorConfirms(symbol, sector, allSignals, direction) {
  const signalArray = Array.isArray(allSignals) ? allSignals : Object.values(allSignals);
  const peers = signalArray.filter(s => s.sector === sector && s.symbol !== symbol);
  if (peers.length < 2) {
    return { confirmed: false, agreeingCount: 0, totalPeers: peers.length, reason: 'Not enough sector peers to confirm' };
  }

  const agreeing = peers.filter(p => p.setup && p.setup.valid && p.setup.direction === direction);
  const confirmed = agreeing.length >= 2;
  return {
    confirmed,
    agreeingCount: agreeing.length,
    totalPeers: peers.length,
    agreeingSymbols: agreeing.map(p => p.symbol),
    reason: confirmed
      ? `Sector confirmed: ${agreeing.length}/${peers.length} peers show same ${direction} structure`
      : `Sector NOT confirmed: only ${agreeing.length}/${peers.length} peers agree — isolated, lower conviction`
  };
}

/**
 * RULE 8: Combined conviction badge
 */
function getConvictionBadge(setupResult, sectorResult) {
  if (!setupResult.valid) return { badge: null };

  let score = 0;
  if (setupResult.oiCase === 2 || setupResult.oiCase === 6) score += 1;
  if (sectorResult && sectorResult.confirmed) score += 1;
  if (sectorResult && sectorResult.agreeingCount >= 3) score += 1;

  const badge = score >= 3 ? 'HIGH' : score === 2 ? 'MEDIUM' : 'LOW';
  return {
    badge,
    score,
    detail: `OI confirmed | Sector: ${sectorResult ? sectorResult.reason : 'not checked'}`
  };
}

/**
 * MASTER FUNCTION — runs all rules in sequence for one stock.
 */
function nanaLogicSetup(weeklyCandles, dailyCandles, spot, oiCase, atr14 = null) {
  const zones = findWeeklySRZones(weeklyCandles.slice(-52));
  const nearestZone = zones
    .map(z => ({ ...z, dist: Math.abs(spot - z.level) / spot }))
    .filter(z => z.dist < 0.02)
    .sort((a, b) => a.dist - b.dist)[0];

  if (!nearestZone) return { valid: false, reason: 'Spot not near any weekly S/R zone' };

  const direction = checkDailyTrigger(nearestZone, dailyCandles);
  if (!direction) return { valid: false, reason: 'At zone but no daily trigger candle yet — wait' };

  if (!oiConfirms(direction, oiCase)) {
    return {
      valid: false,
      direction,
      reason: `Price trigger says ${direction} but OI Case is ${oiCase} — no Mahesh confirmation, skip`
    };
  }

  const last3 = dailyCandles.slice(-3);
  const triggerCandle = last3[last3.length - 1];
  const spotSL = calcSpotSL(direction, nearestZone, triggerCandle, spot);
  const targets = calcTargets(direction, spot, dailyCandles, zones);

  const fuelCheckNote = atr14
    ? (atr14 / spot > 0.015 ? 'ATR healthy — room to run' : 'ATR tight — reduce size')
    : 'ATR not passed — run existing fuel-check/IV-room gate before entry';

  return {
    valid: true,
    direction,
    zone: nearestZone,
    spotSL,
    ...targets,
    oiCase,
    fuelCheckNote,
    strikePref: strikeRule()
  };
}

const nanaCapitalSetup = nanaLogicSetup;
const sectorConfirmationGate = sectorConfirms;

function dailyCandlesToWeekly(dailyRaw) {
  const daily = dailyRaw.map(c => ({
    date: c[0].slice(0, 10),
    open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]),
    close: parseFloat(c[4]), volume: parseFloat(c[5])
  }));
  const weeks = {};
  daily.forEach(d => {
    const dt = new Date(d.date);
    const day = dt.getDay();
    const diffToMon = day === 0 ? -6 : 1 - day;
    const monday = new Date(dt);
    monday.setDate(dt.getDate() + diffToMon);
    const wk = monday.toISOString().slice(0, 10);
    if (!weeks[wk]) weeks[wk] = { open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume, date: wk };
    else {
      weeks[wk].high = Math.max(weeks[wk].high, d.high);
      weeks[wk].low = Math.min(weeks[wk].low, d.low);
      weeks[wk].close = d.close;
      weeks[wk].volume += d.volume;
    }
  });
  return Object.values(weeks).sort((a, b) => a.date.localeCompare(b.date));
}

function rawDailyToObjects(dailyRaw) {
  return dailyRaw.map(c => ({
    date: c[0].slice(0, 10),
    open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]),
    close: parseFloat(c[4]), volume: parseFloat(c[5])
  }));
}

module.exports = {
  nanaLogicSetup,
  nanaCapitalSetup,
  findWeeklySRZones,
  findDailySRZones,
  checkDailyTrigger,
  oiConfirms,
  calcSpotSL,
  calcTargets,
  strikeRule,
  sectorConfirms,
  sectorConfirmationGate,
  getConvictionBadge,
  dailyCandlesToWeekly,
  rawDailyToObjects
};
