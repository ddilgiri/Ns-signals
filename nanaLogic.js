// ============================================================
// NANA LOGIC MODULE — Weekly S/R + OI Case + Sector Confirmation
// For NS-Signals (ddilgiri/Ns-signals)
// Zero new API calls beyond candle fetch — reuses existing OI/sector data
// ============================================================

// ---------- STEP 1+2: Weekly S/R zone + daily trigger candle ----------
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

  return zones.filter(z => z.touches >= 2); // require 2+ touches to count as real S/R
}

function findDailySRZones(candles) {
  return findWeeklySRZones(candles, 0.005); // tighter clustering for daily targets
}

// ---------- STEP 1-6: Core setup detector (single stock) ----------
/**
 * @param {Array} weeklyCandles - [{open,high,low,close,volume}, ...] last ~52 weeks
 * @param {Array} dailyCandles  - [{open,high,low,close,volume}, ...] last ~30 days
 * @param {number} spot - current LTP of underlying
 * @param {number|null} oiCase - 1-8 from callOiCase/putOiCase for the relevant side, or null
 * @param {number|null} atr14 - existing ATR if available, else null
 */
function nanaLogicSetup(weeklyCandles, dailyCandles, spot, oiCase, atr14 = null) {
  // STEP 1: nearest weekly S/R zone within 2% of spot
  const zones = findWeeklySRZones(weeklyCandles.slice(-52));
  const nearestZone = zones
    .map(z => ({ ...z, dist: Math.abs(spot - z.level) / spot }))
    .filter(z => z.dist < 0.02)
    .sort((a, b) => a.dist - b.dist)[0];

  if (!nearestZone) {
    return { valid: false, reason: 'Spot not near any weekly S/R zone' };
  }

  // STEP 2: daily trigger candle at that zone
  const last3Daily = dailyCandles.slice(-3);
  if (last3Daily.length < 2) {
    return { valid: false, reason: 'Not enough daily candles for trigger check' };
  }
  const triggerCandle = last3Daily[last3Daily.length - 1];
  const prevCandle = last3Daily[last3Daily.length - 2];

  const isBullishTrigger =
    nearestZone.type === 'support' &&
    triggerCandle.close > triggerCandle.open &&
    triggerCandle.close > prevCandle.close &&
    triggerCandle.low <= nearestZone.level * 1.005;

  const isBearishTrigger =
    nearestZone.type === 'resistance' &&
    triggerCandle.close < triggerCandle.open &&
    triggerCandle.close < prevCandle.close &&
    triggerCandle.high >= nearestZone.level * 0.995;

  if (!isBullishTrigger && !isBearishTrigger) {
    return { valid: false, reason: 'At zone but no daily trigger candle yet — wait' };
  }

  const direction = isBullishTrigger ? 'CE' : 'PE';

  // STEP 3: OI confirmation — Mahesh gate (mandatory)
  // CE needs oiCase===2 (Call buyers winning), PE needs oiCase===6 (Put buyers winning)
  const oiConfirms = (direction === 'CE' && oiCase === 2) ||
                      (direction === 'PE' && oiCase === 6);

  if (!oiConfirms) {
    return {
      valid: false,
      direction,
      reason: `Price trigger says ${direction} but OI Case is ${oiCase} — no Mahesh confirmation, skip`
    };
  }

  // STEP 4: spot-based SL
  const buffer = spot * 0.003; // 0.3% buffer
  const spotSL = direction === 'CE'
    ? Math.min(nearestZone.level, triggerCandle.low) - buffer
    : Math.max(nearestZone.level, triggerCandle.high) + buffer;

  // STEP 5: layered targets
  const dailyZones = findDailySRZones(dailyCandles.slice(-15));
  const scalpTargets = direction === 'CE'
    ? dailyZones.filter(z => z.level > spot).sort((a, b) => a.level - b.level).slice(0, 3)
    : dailyZones.filter(z => z.level < spot).sort((a, b) => b.level - a.level).slice(0, 3);

  const nextWeeklyZone = zones
    .filter(z => direction === 'CE' ? z.level > spot : z.level < spot)
    .sort((a, b) => direction === 'CE' ? a.level - b.level : b.level - a.level)[0];

  // STEP 6: fuel-check note
  const fuelCheckNote = atr14
    ? (atr14 / spot > 0.015 ? 'ATR healthy — room to run' : 'ATR tight — reduce size')
    : 'ATR not passed — run existing fuel-check/IV-room gate before entry';

  return {
    valid: true,
    direction,
    zone: nearestZone,
    spotSL: Number(spotSL.toFixed(2)),
    scalpTargets: scalpTargets.map(t => Number(t.level.toFixed(2))),
    positionalTarget: nextWeeklyZone ? Number(nextWeeklyZone.level.toFixed(2)) : null,
    oiCase,
    fuelCheckNote,
    strikePref: 'ATM or 1 strike ITM — match spot zone, avoid far OTM'
  };
}

// ---------- STEP 7: Sector confirmation gate ----------
function sectorConfirmationGate(symbol, sector, allSignals, direction) {
  const signalArray = Array.isArray(allSignals) ? allSignals : Object.values(allSignals);
  const sectorPeers = signalArray.filter(s => s.sector === sector && s.symbol !== symbol);

  if (sectorPeers.length < 2) {
    return { confirmed: false, agreeingCount: 0, totalPeers: sectorPeers.length,
             reason: 'Not enough sector peers tracked to confirm' };
  }

  const agreeing = sectorPeers.filter(p => p.nanaSetup && p.nanaSetup.valid && p.nanaSetup.direction === direction);
  const confirmed = agreeing.length >= 2;

  return {
    confirmed,
    agreeingCount: agreeing.length,
    totalPeers: sectorPeers.length,
    agreeingSymbols: agreeing.map(p => p.symbol),
    reason: confirmed
      ? `Sector confirmed: ${agreeing.length}/${sectorPeers.length} peers show same ${direction} structure`
      : `Sector NOT confirmed: only ${agreeing.length}/${sectorPeers.length} peers agree — isolated, lower conviction`
  };
}

// ---------- STEP 8: Combined conviction badge ----------
function getConvictionBadge(nanaResult, sectorResult) {
  if (!nanaResult.valid) return { badge: null };

  let score = 0;
  if (nanaResult.oiCase === 2 || nanaResult.oiCase === 6) score += 1;
  if (sectorResult && sectorResult.confirmed) score += 1;
  if (sectorResult && sectorResult.agreeingCount >= 3) score += 1;

  const badge = score >= 3 ? 'HIGH' : score === 2 ? 'MEDIUM' : 'LOW';

  return {
    badge,
    score,
    detail: `OI confirmed | Sector: ${sectorResult ? sectorResult.reason : 'not checked'}`
  };
}

// ---------- Helper: convert Angel One ONE_DAY candles into weekly bars ----------
// Angel candle format: [timestamp, open, high, low, close, volume]
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
  sectorConfirmationGate,
  getConvictionBadge,
  findWeeklySRZones,
  findDailySRZones,
  dailyCandlesToWeekly,
  rawDailyToObjects
};
