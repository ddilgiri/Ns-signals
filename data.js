// data.js — Angel One SmartAPI fuel layer
// New F&O Engine (Book-Based: NISM Series VIII + XV + Varsity)
// 4 API calls per stock per cycle: getQuote, getOptionChain, getMarketData, getCandleData

const axios = require('axios');
const { totp } = require('otplib');

// ── Credentials ──────────────────────────────────────────────────────────────
const CONFIG = {
  clientCode: 'V50416714',
  password:   '2529',
  apiKey:     '4dQaSs42',
  totpSecret: '30FVJQXXBXQWQHBEGX2LQFFSB4',
};

const BASE = 'https://apiconnect.angelone.in';

// ── Session token (refreshed on login) ───────────────────────────────────────
let SESSION = { jwtToken: null, refreshToken: null, feedToken: null };

// ── Login ─────────────────────────────────────────────────────────────────────
async function login() {
  const pin = totp.generate(CONFIG.totpSecret);
  const res = await axios.post(`${BASE}/rest/auth/angelbroking/user/v1/loginByPassword`, {
    clientcode: CONFIG.clientCode,
    password:   CONFIG.password,
    totp:       pin,
  }, {
    headers: {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      'X-UserType':   'USER',
      'X-SourceID':   'WEB',
      'X-ClientLocalIP': '127.0.0.1',
      'X-ClientPublicIP': '127.0.0.1',
      'X-MACAddress': '00:00:00:00:00:00',
      'X-PrivateKey': CONFIG.apiKey,
    }
  });
  const d = res.data && res.data.data;
  if (!d || !d.jwtToken) {
    throw new Error(`Login API returned no token — message: ${res.data && res.data.message || 'unknown'}`);
  }
  SESSION.jwtToken    = d.jwtToken;
  SESSION.refreshToken = d.refreshToken;
  SESSION.feedToken   = d.feedToken;
  console.log('✅ Angel One login successful');
  return SESSION;
}

// ── Common headers ────────────────────────────────────────────────────────────
function headers() {
  return {
    'Authorization': `Bearer ${SESSION.jwtToken}`,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
    'X-UserType':    'USER',
    'X-SourceID':    'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress':  '00:00:00:00:00:00',
    'X-PrivateKey':  CONFIG.apiKey,
  };
}

// ── M0: Corporate Actions (Event Filter) ─────────────────────────────────────
// Called at 8 AM — flags stocks with results/dividends/splits today
async function getCorporateActions(fromDate, toDate) {
  // fromDate/toDate: 'YYYY-MM-DD'
  const res = await axios.get(`${BASE}/rest/secure/angelbroking/marketData/v1/corporateactions`, {
    params: { from_date: fromDate, to_date: toDate, exchange: 'NSE', purpose: 'all' },
    headers: headers()
  });
  // Returns array of { symbol, exDate, purpose, ... }
  return res.data.data || [];
}

// ── M1: Futures OI (OI Direction) ────────────────────────────────────────────
// OI today vs yesterday → 4 scenarios per NISM VIII 5.5
async function getFuturesOI(symbolToken) {
  const res = await axios.post(`${BASE}/rest/secure/angelbroking/market/v1/quote/`, {
    mode: 'FULL',
    exchangeTokens: { NFO: [symbolToken] }
  }, { headers: headers() });
  const d = res.data.data?.fetched?.[0];
  if (!d) return null;
  return {
    ltp:           d.ltp,
    prevClose:     d.close,
    oi:            d.opnInterest,
    oiChange:      d.opnInterest - (d.lowerCircuit || 0), // placeholder; real OI delta from cache
    volume:        d.tradeVolume,
  };
}

// ── M2 + M3 + M6: Option Chain ───────────────────────────────────────────────
// ONE call feeds: PCR (M2), IV (M3), Max Pain (M6)
async function getOptionChain(symbol, expiry, atmStrike) {
  // expiry: 'DDMMMYYYY' e.g. '30OCT2025'
  // atmStrike: nearest 50/100 to LTP
  const res = await axios.post(`${BASE}/rest/secure/angelbroking/marketData/v1/optionChain`, {
    name:       symbol,
    expirydate: expiry,
  }, { headers: headers() });

  const chain = res.data.data || [];

  // ── PCR (M2) ─────────────────────────────────────────────────────────────
  let totalPutOI = 0, totalCallOI = 0;
  chain.forEach(row => {
    totalPutOI  += (row.PE?.openInterest || 0);
    totalCallOI += (row.CE?.openInterest || 0);
  });
  const pcr = totalCallOI > 0 ? (totalPutOI / totalCallOI) : null;
  // PCR interpretation (contrarian, NISM VIII 5.5.2):
  // PCR > 1.2 = extreme put buying = contrarian BULLISH
  // PCR < 0.8 = extreme call buying = contrarian BEARISH
  // PCR 0.8-1.2 = neutral

  // ── IV (M3) ──────────────────────────────────────────────────────────────
  // ATM strike IV vs 20-day average (NISM VIII 4.9)
  const atmRow = chain.find(r => r.strikePrice === atmStrike);
  const currentIV = atmRow?.CE?.impliedVolatility || atmRow?.PE?.impliedVolatility || null;

  // ── Max Pain (M6) ────────────────────────────────────────────────────────
  // Strike where total option writer loss is minimum
  let maxPainStrike = null;
  let minTotalLoss = Infinity;
  const strikes = chain.map(r => r.strikePrice);
  strikes.forEach(testStrike => {
    let totalLoss = 0;
    chain.forEach(row => {
      // Call writer loss if price > strike
      if (testStrike > row.strikePrice) {
        totalLoss += (testStrike - row.strikePrice) * (row.CE?.openInterest || 0);
      }
      // Put writer loss if price < strike
      if (testStrike < row.strikePrice) {
        totalLoss += (row.strikePrice - testStrike) * (row.PE?.openInterest || 0);
      }
    });
    if (totalLoss < minTotalLoss) {
      minTotalLoss  = totalLoss;
      maxPainStrike = testStrike;
    }
  });

  return {
    chain,
    // M2
    pcr,
    totalPutOI,
    totalCallOI,
    // M3
    currentIV,
    atmStrike,
    // M6
    maxPainStrike,
    minTotalLoss,
  };
}

// ── M5: Price + Trend (Candle Data) ──────────────────────────────────────────
// VWAP, RSI(14), MACD, Volume — Series XV 15.9
async function getCandleData(symbolToken, exchange = 'NSE', interval = 'FIVE_MINUTE') {
  // interval options: ONE_MINUTE, FIVE_MINUTE, FIFTEEN_MINUTE, ONE_DAY
  const now   = new Date();
  const from  = new Date(now); from.setHours(9, 15, 0, 0);
  const fmt   = d => d.toISOString().slice(0, 19).replace('T', ' ');

  const res = await axios.post(`${BASE}/rest/secure/angelbroking/historical/v1/getCandleData`, {
    exchange,
    symboltoken: symbolToken,
    interval,
    fromdate: fmt(from),
    todate:   fmt(now),
  }, { headers: headers() });

  const raw = res.data.data || [];
  // Each row: [timestamp, open, high, low, close, volume]
  const candles = raw.map(r => ({
    ts: r[0], open: r[1], high: r[2], low: r[3], close: r[4], vol: r[5]
  }));

  return {
    candles,
    vwap:   calcVWAP(candles),
    rsi14:  calcRSI(candles, 14),
    macd:   calcMACD(candles),
    avgVol: candles.reduce((s, c) => s + c.vol, 0) / (candles.length || 1),
  };
}

// ── Indicators ────────────────────────────────────────────────────────────────

function calcVWAP(candles) {
  let cumTPV = 0, cumVol = 0;
  candles.forEach(c => {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.vol;
    cumVol += c.vol;
  });
  return cumVol > 0 ? cumTPV / cumVol : null;
}

function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const closes = candles.map(c => c.close);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains  += diff;
    else           losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcMACD(candles) {
  if (candles.length < 26) return null;
  const closes = candles.map(c => c.close);
  const ema12  = calcEMA(closes, 12);
  const ema26  = calcEMA(closes, 26);
  return { macdLine: ema12 - ema26, ema12, ema26 };
}

// ── NSE Corporate Actions fetch (for M0 morning scan) ────────────────────────
async function fetchTodayEvents() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const events = await getCorporateActions(today, today);
    // Return set of symbols with events today
    const flagged = new Set(events.map(e => e.symbol?.toUpperCase()));
    console.log(`M0 Event Filter: ${flagged.size} stocks flagged today`, [...flagged].slice(0, 5));
    return flagged;
  } catch (e) {
    console.warn('M0 corporate actions fetch failed:', e.message);
    return new Set();
  }
}

// ── Master fetch for one stock ────────────────────────────────────────────────
// Returns all raw data needed by M1-M6
async function fetchStockData(symbol, symbolToken, futuresToken, expiry, atmStrike) {
  const [optionChainData, candleData] = await Promise.all([
    getOptionChain(symbol, expiry, atmStrike),
    getCandleData(symbolToken),
  ]);
  const futuresOI = await getFuturesOI(futuresToken);

  return {
    symbol,
    timestamp: new Date().toISOString(),
    // M1
    futures: futuresOI,
    // M2 + M3 + M6
    ...optionChainData,
    // M5
    ...candleData,
  };
}

module.exports = {
  login,
  fetchTodayEvents,
  fetchStockData,
  getOptionChain,
  getCandleData,
  getFuturesOI,
  getCorporateActions,
  calcVWAP,
  calcRSI,
  calcMACD,
  SESSION,
};
