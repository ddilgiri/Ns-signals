// optionsFilter.js — NSE Stocks F&O Only

function checkOptionsEntryValid(side, data) {
  const issues = [];
  let valid = true;

  // RULE 1: Premium must confirm direction within 2 candles
  if (side === 'CE' && data.priceDirection === 'up' && data.premiumNow <= data.premiumEntry) {
    issues.push('CE not rising with price — writers absorbing, skip');
    valid = false;
  }
  if (side === 'PE' && data.priceDirection === 'down' && data.premiumNow <= data.premiumEntry) {
    issues.push('PE not rising with price fall — writers absorbing, skip');
    valid = false;
  }

  // RULE 2: No late entry — move already 3+ candles old
  if (data.candlesSinceMove >= 3) {
    issues.push('Late entry — IV already deflating post-move, skip');
    valid = false;
  }

  // RULE 3: OI wall growing hard against your side
  if (data.oiWallChangePerc > 50) {
    issues.push(`Wall OI +${data.oiWallChangePerc}% — fresh writers, don't fight`);
    valid = false;
  }

  // RULE 4: PCR sanity check (warning only)
  if (side === 'CE' && data.pcr > 1.5) {
    issues.push(`PCR ${data.pcr} — Put-heavy, CE needs strong breakout volume`);
  }
  if (side === 'PE' && data.pcr < 0.5) {
    issues.push(`PCR ${data.pcr} — Call-heavy, PE needs strong breakdown volume`);
  }

  // RULE 5: IV too high — buying expensive premium
  if (data.ivPerc > 80) {
    issues.push(`IV at ${data.ivPerc}th percentile — overpriced, IV crush will kill entry`);
    valid = false;
  }

  // RULE 6: Expiry day — OTM theta danger
  if (data.timeToExpiry <= 1) {
    issues.push('Expiry day — OTM options losing ₹ every minute, avoid');
    valid = false;
  }

  // RULE 7: Bounce trade — valid exception to Rule 2
  if (data.premiumDropPerc >= 30 && data.oiIntact === true) {
    // override late entry block — bounce setup
    valid = true;
    issues.push('Bounce trade valid — premium -30%+ with OI intact, Rule 2 override');
  }

  // RULE 8: Sideways = no trade
  if (data.priceDirection === 'sideways') {
    issues.push('Sideways market — both CE and PE bleed, no entry');
    valid = false;
  }

  return { valid, issues };
}

// Time SL — call every scan cycle after entry
function checkTimeSL(entryTimeMs, maxMinutes = 20) {
  const elapsed = (Date.now() - entryTimeMs) / 60000;
  if (elapsed >= maxMinutes) {
    return { exit: true, reason: `Time SL hit — ${Math.round(elapsed)} min, no directional move` };
  }
  return { exit: false };
}

// Sideways kill — check range compression
function checkSidewaysKill(high, low, entryPrice, threshold = 0.005) {
  const range = (high - low) / entryPrice;
  if (range < threshold) {
    return { exit: true, reason: `Range only ${(range * 100).toFixed(2)}% — sideways graveyard, exit` };
  }
  return { exit: false };
}

module.exports = { checkOptionsEntryValid, checkTimeSL, checkSidewaysKill };
