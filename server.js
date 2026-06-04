/**
 * NSE F&O Signal Engine — Angel One SmartAPI Proxy v2.0
 * ======================================================
 * Production-ready proxy with complete error handling
 * All Angel One API endpoints integrated
 * 
 * Start: node server.js
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const speakeasy = require('speakeasy');

const app = express();
const PORT = process.env.PORT || 3001;

// ─────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// ─────────────────────────────────────────────────────────────────────
// SESSION STORAGE
// ─────────────────────────────────────────────────────────────────────
const SESSION = {
  jwtToken: '',
  refreshToken: '',
  feedToken: '',
  apiKey: '',
  clientCode: '',
  expiresAt: 0,
};

function isAuthenticated() {
  return SESSION.jwtToken && Date.now() < SESSION.expiresAt;
}

function log(msg, level = 'INFO') {
  const t = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  console.log(`[${t}] [${level}] ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────
// ANGEL ONE API BASE URL
// ─────────────────────────────────────────────────────────────────────
const ANGEL_API = 'https://apiconnect.angelbroking.com';

// ─────────────────────────────────────────────────────────────────────
// HELPER: GENERATE TOTP
// ─────────────────────────────────────────────────────────────────────
function generateTOTP(secret) {
  if (!secret || secret.trim().length < 16) {
    return ''; // Empty string means no TOTP
  }

  try {
    const cleanSecret = secret.trim().replace(/\s+/g, '').toUpperCase();
    const token = speakeasy.totp({
      secret: cleanSecret,
      encoding: 'base32',
      digits: 6,
      step: 30,
      time: Math.floor(Date.now() / 1000),
    });
    return token;
  } catch (err) {
    log(`TOTP generation failed: ${err.message}`, 'WARN');
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────
// HELPER: COMMON HEADERS
// ─────────────────────────────────────────────────────────────────────
function getHeaders(needsAuth = false) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '00:11:22:33:44:55',
    'X-PrivateKey': SESSION.apiKey || '',
  };

  if (needsAuth && SESSION.jwtToken) {
    headers['Authorization'] = `Bearer ${SESSION.jwtToken}`;
  }

  return headers;
}

// ─────────────────────────────────────────────────────────────────────
// HELPER: AUTO-REFRESH TOKEN on 401/403 using stored refresh token
// ─────────────────────────────────────────────────────────────────────
async function refreshToken() {
  if (!SESSION.refreshToken || !SESSION.apiKey || !SESSION.clientCode) return false;
  try {
    log('Refreshing expired Angel One token...', 'INFO');
    const r = await axios.post(
      `${ANGEL_API}/rest/auth/angelbroking/jwt/v1/generateTokens`,
      { refreshToken: SESSION.refreshToken },
      { headers: getHeaders(false), timeout: 15000 }
    );
    if (r.data?.status && r.data?.data?.jwtToken) {
      SESSION.jwtToken = r.data.data.jwtToken;
      SESSION.refreshToken = r.data.data.refreshToken || SESSION.refreshToken;
      SESSION.expiresAt = Date.now() + (8 * 60 * 60 * 1000);
      log('Token refreshed successfully', 'OK');
      return true;
    }
    return false;
  } catch (err) {
    log(`Token refresh failed: ${err.message}`, 'WARN');
    return false;
  }
}

// Wrapper: auto-retry once after token refresh on 401/403
async function angelRequest(method, url, data, options = {}) {
  try {
    const cfg = { headers: getHeaders(true), timeout: 20000, ...options };
    return method === 'GET'
      ? await axios.get(url, cfg)
      : await axios.post(url, data, cfg);
  } catch (err) {
    const status = err.response?.status;
    if ((status === 401 || status === 403) && SESSION.refreshToken) {
      const refreshed = await refreshToken();
      if (refreshed) {
        const cfg = { headers: getHeaders(true), timeout: 20000, ...options };
        return method === 'GET'
          ? await axios.get(url, cfg)
          : await axios.post(url, data, cfg);
      }
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────
// ROUTE: HEALTH CHECK
// ─────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const cacheEntries = Object.keys(BIAS_CACHE).length;
  const freshEntries = Object.values(BIAS_CACHE).filter(e => (Date.now() - e.fetchTime) < BIAS_TTL).length;
  res.json({
    status: 'ok',
    authenticated: isAuthenticated(),
    client: SESSION.clientCode || null,
    tokenExpiry: SESSION.expiresAt ? new Date(SESSION.expiresAt).toLocaleTimeString('en-IN') : null,
    biasCache: { total: cacheEntries, fresh: freshEntries },
  });
});

// Clear bias cache (useful after token refresh or when debugging)
app.post('/clear-cache', (req, res) => {
  const n = Object.keys(BIAS_CACHE).length;
  Object.keys(BIAS_CACHE).forEach(k => delete BIAS_CACHE[k]);
  log(`Bias cache cleared (${n} entries removed)`, 'INFO');
  res.json({ status: true, message: `Cleared ${n} cache entries` });
});

// ─────────────────────────────────────────────────────────────────────
// ROUTE: LOGIN
// ─────────────────────────────────────────────────────────────────────
app.post('/login', async (req, res) => {
  try {
    const { clientCode, password, apiKey, totpSecret } = req.body;

    // Validate inputs
    if (!clientCode || !password || !apiKey) {
      log('Login: Missing required fields', 'WARN');
      return res.status(400).json({
        status: false,
        message: 'clientCode, password, and apiKey are required',
      });
    }

    SESSION.clientCode = clientCode;
    SESSION.apiKey = apiKey;

    // Generate TOTP if secret provided
    let otp = '';
    if (totpSecret && totpSecret.trim()) {
      otp = generateTOTP(totpSecret);
      if (otp) {
        log(`TOTP generated: ${otp}`);
      } else {
        log('TOTP secret invalid — proceeding without 2FA', 'WARN');
      }
    }

    // Make login request to Angel One
    log(`Authenticating ${clientCode}...`);
    const loginResponse = await axios.post(
      `${ANGEL_API}/rest/auth/angelbroking/user/v1/loginByPassword`,
      {
        clientcode: clientCode,
        password: password,
        totp: otp,
      },
      {
        headers: getHeaders(false),
        timeout: 25000,
      }
    );

    const data = loginResponse.data;

    // Check if login was successful
    if (data.status === true && data.data) {
      SESSION.jwtToken = data.data.jwtToken;
      SESSION.refreshToken = data.data.refreshToken;
      SESSION.feedToken = data.data.feedToken;
      SESSION.expiresAt = Date.now() + (8 * 60 * 60 * 1000); // 8 hours

      log(`✅ Login successful — ${clientCode}`, 'OK');
      log(`   JWT: ${SESSION.jwtToken.substring(0, 30)}...`);
      log(`   Feed Token: ${SESSION.feedToken ? SESSION.feedToken.substring(0, 30) + '...' : 'N/A'}`);

      return res.json({
        status: true,
        message: 'Login successful',
        client: clientCode,
        tokenExpiry: new Date(SESSION.expiresAt).toLocaleTimeString('en-IN'),
      });
    }

    // Login failed
    const errorMsg = data.message || data.errorcode || 'Unknown error';
    log(`❌ Login failed: ${errorMsg}`, 'ERR');
    return res.status(401).json({
      status: false,
      message: errorMsg,
    });

  } catch (error) {
    const msg = error.response?.data?.message || error.response?.data?.errorcode || error.message;
    log(`❌ Login error: ${msg}`, 'ERR');
    res.status(500).json({
      status: false,
      message: msg || 'Connection error — check if Angel One API is reachable',
    });
  }
});

// ─────────────────────────────────────────────────────────────────────
// ROUTE: LIVE QUOTE (LTP, OHLC, etc)
// ─────────────────────────────────────────────────────────────────────
app.post('/quote', async (req, res) => {
  if (!isAuthenticated()) {
    return res.status(401).json({ status: false, message: 'Not authenticated — login first' });
  }

  try {
    const response = await angelRequest('POST',
      `${ANGEL_API}/rest/secure/angelbroking/market/v1/quote/`,
      req.body
    );
    res.json(response.data);
  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    log(`Quote error: ${msg}`, 'WARN');
    res.status(error.response?.status || 500).json({ status: false, message: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────
// ROUTE: CANDLE DATA (OHLC history for RSI calculation)
// ─────────────────────────────────────────────────────────────────────
app.post('/candles', async (req, res) => {
  if (!isAuthenticated()) {
    return res.status(401).json({ status: false, message: 'Not authenticated' });
  }

  try {
    const response = await angelRequest('POST',
      `${ANGEL_API}/rest/secure/angelbroking/historical/v1/getCandleData`,
      req.body
    );
    res.json(response.data);
  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    res.status(error.response?.status || 500).json({ status: false, message: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────
// MARKET BIAS — in-memory cache (5 min TTL per symbol)
// Prevents repeated candle API calls that trigger Angel One 403 throttling
// ─────────────────────────────────────────────────────────────────────
const BIAS_CACHE = {};      // { [symbolToken]: { data, fetchTime } }
const BIAS_TTL   = 5 * 60 * 1000; // 5 minutes

// Simple rate-limit queue: max 1 candle request per 600ms to stay within Angel One limits
let _lastCandleCall = 0;
async function throttledCandleRequest(payload, exchange) {
  const now = Date.now();
  const gap = now - _lastCandleCall;
  if (gap < 600) await new Promise(r => setTimeout(r, 600 - gap));
  _lastCandleCall = Date.now();

  // Use angelRequest wrapper so 401/403 auto-triggers token refresh + retry
  return angelRequest('POST',
    `${ANGEL_API}/rest/secure/angelbroking/historical/v1/getCandleData`,
    payload
  );
}

// ─────────────────────────────────────────────────────────────────────
// HELPERS: EMA, RSI (defined once, reused)
// ─────────────────────────────────────────────────────────────────────
function calcEMA(data, period) {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let e = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) e = data[i] * k + e * (1 - k);
  return parseFloat(e.toFixed(2));
}

function calcRSI14(closes) {
  if (closes.length < 15) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= 14; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let ag = gains / 14, al = losses / 14;
  for (let i = 15; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * 13 + Math.max(d, 0)) / 14;
    al = (al * 13 + Math.max(-d, 0)) / 14;
  }
  return al === 0 ? 100 : parseFloat((100 - 100 / (1 + ag / al)).toFixed(2));
}

// ─────────────────────────────────────────────────────────────────────
// HELPERS: MACD, Supertrend, ATR (new indicators)
// ─────────────────────────────────────────────────────────────────────

// MACD: returns { macdLine, signalLine, histogram, crossover }
// crossover: 'BULLISH' (macd crossed above signal), 'BEARISH', or 'NONE'
function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const emaFast   = [];
  const emaSlow   = [];
  const kf = 2 / (fast + 1);
  const ks = 2 / (slow + 1);

  // Seed fast EMA
  let ef = closes.slice(0, fast).reduce((a, b) => a + b, 0) / fast;
  emaFast.push(ef);
  for (let i = fast; i < closes.length; i++) {
    ef = closes[i] * kf + ef * (1 - kf);
    emaFast.push(ef);
  }

  // Seed slow EMA (same index base as fast, so align: slow starts at index slow-1)
  let es = closes.slice(0, slow).reduce((a, b) => a + b, 0) / slow;
  emaSlow.push(es);
  for (let i = slow; i < closes.length; i++) {
    es = closes[i] * ks + es * (1 - ks);
    emaSlow.push(es);
  }

  // MACD line = fast EMA - slow EMA (aligned from index slow-1 in closes)
  const offset    = slow - fast; // emaFast has more values
  const macdLine  = emaSlow.map((s, i) => parseFloat((emaFast[i + offset] - s).toFixed(4)));

  // Signal line = 9-EMA of macdLine
  if (macdLine.length < signal) return null;
  const ksig = 2 / (signal + 1);
  let sig = macdLine.slice(0, signal).reduce((a, b) => a + b, 0) / signal;
  const sigLine = [sig];
  for (let i = signal; i < macdLine.length; i++) {
    sig = macdLine[i] * ksig + sig * (1 - ksig);
    sigLine.push(sig);
  }

  const lastMacd   = macdLine[macdLine.length - 1];
  const lastSig    = sigLine[sigLine.length - 1];
  const prevMacd   = macdLine[macdLine.length - 2];
  const prevSig    = sigLine[sigLine.length - 2];
  const histogram  = parseFloat((lastMacd - lastSig).toFixed(4));

  let crossover = 'NONE';
  if (prevMacd !== undefined && prevSig !== undefined) {
    if (prevMacd <= prevSig && lastMacd > lastSig) crossover = 'BULLISH';
    else if (prevMacd >= prevSig && lastMacd < lastSig) crossover = 'BEARISH';
  }

  return {
    macdLine:  parseFloat(lastMacd.toFixed(4)),
    signalLine: parseFloat(lastSig.toFixed(4)),
    histogram,
    crossover,
    aboveSignal: lastMacd > lastSig,
  };
}

// ATR-14: Average True Range — measures volatility
function calcATR(raw, period = 14) {
  if (raw.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < raw.length; i++) {
    const high  = parseFloat(raw[i][2]);
    const low   = parseFloat(raw[i][3]);
    const close = parseFloat(raw[i - 1][4]); // previous close
    trs.push(Math.max(high - low, Math.abs(high - close), Math.abs(low - close)));
  }
  // Wilder smoothing
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return parseFloat(atr.toFixed(2));
}

// Supertrend: period=10, multiplier=3
// Returns { supertrend, trend: 'UP'|'DOWN', signal: 'BUY'|'SELL'|'HOLD' }
function calcSupertrend(raw, period = 10, multiplier = 3) {
  if (raw.length < period + 2) return null;

  const highs  = raw.map(c => parseFloat(c[2]));
  const lows   = raw.map(c => parseFloat(c[3]));
  const closes = raw.map(c => parseFloat(c[4]));

  // ATR for each bar (rolling Wilder)
  const trs = [0]; // index 0 placeholder
  for (let i = 1; i < raw.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }

  // Seed ATR
  let atr = trs.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  const atrs = new Array(period + 1).fill(0);
  atrs.push(atr);
  for (let i = period + 1; i < raw.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    atrs.push(atr);
  }

  // Basic upper/lower bands
  const upperBasic = [], lowerBasic = [];
  for (let i = 0; i < raw.length; i++) {
    const hl2 = (highs[i] + lows[i]) / 2;
    upperBasic.push(hl2 + multiplier * (atrs[i] || 0));
    lowerBasic.push(hl2 - multiplier * (atrs[i] || 0));
  }

  // Final bands with Supertrend adjustment
  const upperFinal = [...upperBasic];
  const lowerFinal = [...lowerBasic];
  const st = new Array(raw.length).fill(0);
  const trend = new Array(raw.length).fill(1); // 1=UP, -1=DOWN

  for (let i = period + 1; i < raw.length; i++) {
    upperFinal[i] = (upperBasic[i] < upperFinal[i - 1] || closes[i - 1] > upperFinal[i - 1])
      ? upperBasic[i] : upperFinal[i - 1];
    lowerFinal[i] = (lowerBasic[i] > lowerFinal[i - 1] || closes[i - 1] < lowerFinal[i - 1])
      ? lowerBasic[i] : lowerFinal[i - 1];

    if (st[i - 1] === upperFinal[i - 1]) {
      st[i] = closes[i] > upperFinal[i] ? lowerFinal[i] : upperFinal[i];
    } else {
      st[i] = closes[i] < lowerFinal[i] ? upperFinal[i] : lowerFinal[i];
    }
    trend[i] = closes[i] > st[i] ? 1 : -1;
  }

  const lastIdx   = raw.length - 1;
  const prevTrend = trend[lastIdx - 1];
  const currTrend = trend[lastIdx];
  let signal = 'HOLD';
  if (prevTrend === -1 && currTrend === 1)  signal = 'BUY';
  if (prevTrend === 1  && currTrend === -1) signal = 'SELL';

  return {
    supertrend: parseFloat(st[lastIdx].toFixed(2)),
    trend: currTrend === 1 ? 'UP' : 'DOWN',
    signal,
  };
}

// Max Pain: strike where total option premium loss is maximised (market maker level)
// Expects array of { strike, CE_ltp, PE_ltp, CE_oi, PE_oi }
function calcMaxPain(chain) {
  if (!chain || chain.length === 0) return null;
  const strikes = chain.map(s => s.strike);
  let minPain = Infinity, maxPainStrike = null;

  for (const expiry of strikes) {
    let totalPain = 0;
    for (const s of chain) {
      const ceLoss = s.CE_oi ? Math.max(0, expiry - s.strike) * (s.CE_oi || 0) : 0;
      const peLoss = s.PE_oi ? Math.max(0, s.strike - expiry) * (s.PE_oi || 0) : 0;
      totalPain += ceLoss + peLoss;
    }
    if (totalPain < minPain) { minPain = totalPain; maxPainStrike = expiry; }
  }
  return maxPainStrike;
}

// ─────────────────────────────────────────────────────────────────────
// ROUTE: MARKET BIAS — EMA20/50 + RSI + PDH/PDL + VWAP + ORB
// Cached per-symbol for 5 minutes. Uses angelRequest wrapper for
// automatic token refresh on 401/403. Rate-limited to avoid throttling.
// ─────────────────────────────────────────────────────────────────────
app.post('/market-bias', async (req, res) => {
  if (!isAuthenticated()) return res.status(401).json({ status: false, message: 'Not authenticated' });

  const { symbolToken, exchange = 'NSE' } = req.body;
  if (!symbolToken) return res.status(400).json({ status: false, message: 'symbolToken required' });

  // ── Serve from cache if fresh ──
  const cached = BIAS_CACHE[symbolToken];
  if (cached && (Date.now() - cached.fetchTime) < BIAS_TTL) {
    return res.json(cached.data);
  }

  try {
    const now  = new Date();
    const ist  = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const today = ist.toISOString().slice(0, 10);

    // Previous trading day (skip weekends)
    const prev = new Date(ist);
    let daysBack = 1;
    if (prev.getDay() === 1) daysBack = 3; // Monday → Friday
    else if (prev.getDay() === 0) daysBack = 2; // Sunday → Friday
    prev.setDate(prev.getDate() - daysBack);
    const prevDay = prev.toISOString().slice(0, 10);

    // Fetch 10 days of 15m candles (enough for EMA50 = ~50 × 26 bars/day)
    // Reduced from 14 days → faster, fewer bytes, less throttle risk
    const fromDate = new Date(ist);
    fromDate.setDate(fromDate.getDate() - 10);
    const from = fromDate.toISOString().slice(0, 10) + ' 09:15';
    const to   = today + ' 15:30';

    let candleResp;
    try {
      candleResp = await throttledCandleRequest(
        { exchange, symboltoken: symbolToken, interval: 'FIFTEEN_MINUTE', fromdate: from, todate: to },
        exchange
      );
    } catch (firstErr) {
      const status = firstErr.response?.status;
      if (status === 403 || status === 429) {
        // Rate limited — wait 2s and retry once
        log(`Candle 403/429 for ${symbolToken} — waiting 2s then retrying`, 'WARN');
        await new Promise(r => setTimeout(r, 2000));
        _lastCandleCall = Date.now();
        candleResp = await angelRequest('POST',
          `${ANGEL_API}/rest/secure/angelbroking/historical/v1/getCandleData`,
          { exchange, symboltoken: symbolToken, interval: 'FIFTEEN_MINUTE', fromdate: from, todate: to }
        );
      } else {
        throw firstErr;
      }
    }

    const raw = candleResp.data?.data || [];
    if (raw.length < 10) {
      // Return neutral result (don't error — scanner will use NEUTRAL bias)
      const neutral = { status: true, bias: 'NEUTRAL', ltp: null, ema20: null, ema50: null,
        rsi: 50, vwap: null, aboveVwap: null, pdh: null, pdl: null,
        orb_high: null, orb_low: null, volRatio: 1,
        macd: null, atr: null, supertrend: null, isExpiryDay: false,
        atrStopLong: null, atrStopShort: null,
        candleCount: raw.length, fromCache: false };
      BIAS_CACHE[symbolToken] = { data: neutral, fetchTime: Date.now() };
      return res.json(neutral);
    }

    // raw format: [datetime, open, high, low, close, volume]
    const closes = raw.map(c => parseFloat(c[4]));
    const vols   = raw.map(c => parseFloat(c[5]));

    // EMAs
    const ema20 = calcEMA(closes, 20);
    const ema50 = calcEMA(closes, 50);
    const ltp   = closes[closes.length - 1];

    // Market bias from EMA structure
    let bias = 'NEUTRAL';
    if (ema20 && ema50) {
      if (ltp > ema20 && ema20 > ema50)      bias = 'BULLISH';
      else if (ltp < ema20 && ema20 < ema50) bias = 'BEARISH';
    } else if (ema20) {
      bias = ltp > ema20 ? 'BULLISH' : 'BEARISH';
    }

    // PDH/PDL
    const prevCandles  = raw.filter(c => c[0].slice(0, 10) === prevDay);
    const pdh = prevCandles.length ? Math.max(...prevCandles.map(c => parseFloat(c[2]))) : null;
    const pdl = prevCandles.length ? Math.min(...prevCandles.map(c => parseFloat(c[3]))) : null;

    // ORB — first 30 min of today (2 × 15m bars)
    const todayCandles = raw.filter(c => c[0].slice(0, 10) === today);
    const orbCandles   = todayCandles.slice(0, 2);
    const orb_high = orbCandles.length ? Math.max(...orbCandles.map(c => parseFloat(c[2]))) : null;
    const orb_low  = orbCandles.length ? Math.min(...orbCandles.map(c => parseFloat(c[3]))) : null;

    // Volume ratio: compare today's total vol vs avg daily vol from prior days only
    const todayVol    = todayCandles.reduce((s, c) => s + parseFloat(c[5]), 0);
    const priorCandles = raw.filter(c => c[0].slice(0, 10) !== today);
    // Group prior candles by date to get per-day volumes, then average those
    const priorByDay  = {};
    priorCandles.forEach(c => {
      const d = c[0].slice(0, 10);
      priorByDay[d] = (priorByDay[d] || 0) + parseFloat(c[5]);
    });
    const priorDayVols = Object.values(priorByDay);
    const avgPriorDayVol = priorDayVols.length
      ? priorDayVols.reduce((a, b) => a + b, 0) / priorDayVols.length
      : 0;
    // Scale avgPriorDayVol by fraction of day completed so early-session never looks low
    const barsInFullDay  = 26; // 9:15–15:30 = 26 × 15min bars
    const dayFraction    = Math.min(todayCandles.length / barsInFullDay, 1);
    const scaledAvgVol   = avgPriorDayVol * Math.max(dayFraction, 0.15); // floor at 15% so pre-ORB not penalised
    const volRatio       = scaledAvgVol > 0 ? parseFloat((todayVol / scaledAvgVol).toFixed(2)) : 1;

    // RSI-14
    const rsi = calcRSI14(closes);

    // MACD (12,26,9)
    const macd = calcMACD(closes);

    // ATR-14 — volatility / stop-loss sizing
    const atr = calcATR(raw);

    // Supertrend (10, 3)
    const supertrend = calcSupertrend(raw);

    // Expiry proximity flag — NSE moved ALL F&O expiry to Tuesday (2) in 2024
    // Stocks: last Tuesday of month (monthly only)
    // Indices: every Tuesday (weekly)
    // Source: dhan.co/fno-expiry-calendar
    const dayOfWeek = ist.getDay();
    const isExpiryDay = dayOfWeek === 2; // Tuesday

    // VWAP (today only)
    let vwapNum = 0, vwapDen = 0;
    todayCandles.forEach(c => {
      const tp  = (parseFloat(c[2]) + parseFloat(c[3]) + parseFloat(c[4])) / 3;
      const vol = parseFloat(c[5]);
      vwapNum += tp * vol;
      vwapDen += vol;
    });
    const vwap      = vwapDen > 0 ? parseFloat((vwapNum / vwapDen).toFixed(2)) : null;
    const aboveVwap = vwap ? ltp > vwap : null;

    const result = {
      status: true, bias, ltp, ema20, ema50, rsi, vwap, aboveVwap,
      pdh, pdl, orb_high, orb_low, volRatio,
      // New indicators
      macd:        macd  || null,
      atr:         atr   || null,
      supertrend:  supertrend || null,
      isExpiryDay,
      // ATR-based stop loss levels
      atrStopLong:  atr && ltp ? parseFloat((ltp - 1.5 * atr).toFixed(2)) : null,
      atrStopShort: atr && ltp ? parseFloat((ltp + 1.5 * atr).toFixed(2)) : null,
      candleCount: raw.length, fromCache: false
    };

    // Store in cache
    BIAS_CACHE[symbolToken] = { data: { ...result, fromCache: true }, fetchTime: Date.now() };

    log(`Bias ${symbolToken}: ${bias} RSI=${rsi} EMA20=${ema20} bars=${raw.length}`, 'INFO');
    res.json(result);

  } catch (err) {
    const status = err.response?.status;
    const msg    = err.response?.data?.message || err.message;
    log(`market-bias error [${status || '?'}] token=${symbolToken}: ${msg}`, 'WARN');

    // If we have a stale cache entry, serve it rather than error
    if (cached) {
      log(`Serving stale bias cache for ${symbolToken}`, 'INFO');
      return res.json({ ...cached.data, fromCache: true, stale: true });
    }

    // Return neutral so scanner continues rather than blocking all signals
    res.json({
      status: true, bias: 'NEUTRAL', ltp: null, ema20: null, ema50: null,
      rsi: 50, vwap: null, aboveVwap: null, pdh: null, pdl: null,
      orb_high: null, orb_low: null, volRatio: 1, candleCount: 0,
      fromCache: false, error: msg
    });
  }
});

// ─────────────────────────────────────────────────────────────────────
// ROUTE: FII/DII DATA — institutional flow from NSE (public API)
// Returns: { fiiBuy, fiiSell, fiiNet, diiBuy, diiSell, diiNet, date }
// ─────────────────────────────────────────────────────────────────────
const FII_DII_CACHE = { data: null, fetchTime: 0 };
let NSE_COOKIE = '';

// Establish NSE session cookie first (prevents 403 on Railway/cloud)
async function getNSECookie() {
  if (NSE_COOKIE) return NSE_COOKIE;
  try {
    const r = await axios.get('https://www.nseindia.com/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
      },
      timeout: 12000,
    });
    const cookies = r.headers['set-cookie'];
    if (cookies) {
      NSE_COOKIE = cookies.map(c => c.split(';')[0]).join('; ');
      log(`NSE session established`, 'INFO');
    }
    return NSE_COOKIE;
  } catch (err) {
    log(`NSE session failed: ${err.message}`, 'WARN');
    return '';
  }
}

async function fetchNSEFiiDii() {
  const cookie = await getNSECookie();
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://www.nseindia.com/',
    'Origin': 'https://www.nseindia.com',
    'Connection': 'keep-alive',
    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  };
  if (cookie) headers['Cookie'] = cookie;

  const r = await axios.get('https://www.nseindia.com/api/fiidiiTradeReact', {
    headers,
    timeout: 12000,
  });
  return r.data || [];
}

app.get('/fii-dii', async (req, res) => {
  if (!isAuthenticated()) return res.status(401).json({ status: false, message: 'Not authenticated' });

  // Cache 30 minutes
  if (FII_DII_CACHE.data && (Date.now() - FII_DII_CACHE.fetchTime) < 30 * 60 * 1000) {
    return res.json(FII_DII_CACHE.data);
  }

  try {
    let raw;
    try {
      raw = await fetchNSEFiiDii();
    } catch (firstErr) {
      log(`FII/DII first attempt failed (${firstErr.response?.status||firstErr.message}), resetting cookie and retrying...`, 'WARN');
      NSE_COOKIE = ''; // Force fresh cookie
      raw = await fetchNSEFiiDii();
    }

    const today = raw.find(d => d.category === 'FII/FPI *') || raw[0];
    const dii   = raw.find(d => d.category === 'DII') || raw[1];

    const result = {
      status: true,
      date: today?.date || new Date().toLocaleDateString('en-IN'),
      fiiBuy:  parseFloat(today?.buyValue  || 0),
      fiiSell: parseFloat(today?.sellValue || 0),
      fiiNet:  parseFloat(today?.netValue  || 0),
      diiBuy:  parseFloat(dii?.buyValue    || 0),
      diiSell: parseFloat(dii?.sellValue   || 0),
      diiNet:  parseFloat(dii?.netValue    || 0),
    };

    // Determine institutional bias
    result.instBias = result.fiiNet > 500 ? 'BULLISH'
      : result.fiiNet < -500 ? 'BEARISH'
      : result.diiNet > 500  ? 'BULLISH'
      : result.diiNet < -500 ? 'BEARISH'
      : 'NEUTRAL';

    FII_DII_CACHE.data = result;
    FII_DII_CACHE.fetchTime = Date.now();
    log(`FII: ₹${result.fiiNet}Cr · DII: ₹${result.diiNet}Cr · ${result.instBias}`, 'INFO');
    res.json(result);
  } catch (err) {
    const status = err.response?.status;
    log(`FII/DII fetch failed: ${status || err.message}`, 'WARN');
    // Return stale cache if available, else neutral fallback
    if (FII_DII_CACHE.data) {
      log('Serving stale FII/DII cache', 'INFO');
      return res.json({ ...FII_DII_CACHE.data, stale: true });
    }
    res.json({ status: true, fiiNet: 0, diiNet: 0, fiiBuy: 0, fiiSell: 0, diiBuy: 0, diiSell: 0, instBias: 'NEUTRAL', message: 'FII/DII unavailable' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// ROUTE: INDIA VIX — fear gauge, critical macro filter for F&O
// VIX > 20 = high volatility, options expensive, avoid buying premium
// VIX < 13 = low volatility, safe to buy premium, trends more reliable
// Source: NSE public API (no auth required)
// ─────────────────────────────────────────────────────────────────────
const VIX_CACHE = { data: null, fetchTime: 0 };

app.get('/india-vix', async (req, res) => {
  // Cache 5 minutes
  if (VIX_CACHE.data && (Date.now() - VIX_CACHE.fetchTime) < 5 * 60 * 1000) {
    return res.json(VIX_CACHE.data);
  }

  try {
    const cookie = await getNSECookie();
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://www.nseindia.com/',
      'Origin': 'https://www.nseindia.com',
      'sec-ch-ua-platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    };
    if (cookie) headers['Cookie'] = cookie;

    const r = await axios.get('https://www.nseindia.com/api/allIndices', { headers, timeout: 12000 });
    const indices = r.data?.data || [];
    const vixEntry = indices.find(i => i.index === 'INDIA VIX');

    if (!vixEntry) {
      // Fallback: try NSE quote endpoint directly
      const r2 = await axios.get('https://www.nseindia.com/api/quote-derivative?symbol=INDIAVIX', { headers, timeout: 12000 });
      const vix2 = r2.data?.underlyingValue || null;
      if (vix2) {
        const fallback = buildVixResult(parseFloat(vix2), null, null, null);
        VIX_CACHE.data = fallback; VIX_CACHE.fetchTime = Date.now();
        return res.json(fallback);
      }
      return res.json({ status: false, message: 'India VIX not found in NSE indices' });
    }

    const result = buildVixResult(
      parseFloat(vixEntry.last || 0),
      parseFloat(vixEntry.change || 0),
      parseFloat(vixEntry.percentChange || 0),
      parseFloat(vixEntry.previousClose || 0)
    );
    VIX_CACHE.data = result;
    VIX_CACHE.fetchTime = Date.now();
    log(`India VIX: ${result.vix} (${result.regime}) chg=${result.changePct}%`, 'INFO');
    res.json(result);

  } catch (err) {
    log(`India VIX fetch failed: ${err.message}`, 'WARN');
    if (VIX_CACHE.data) return res.json({ ...VIX_CACHE.data, stale: true });
    // Return neutral so scanner doesn't block
    res.json({ status: true, vix: null, regime: 'UNKNOWN', premiumBuyable: true, message: 'VIX unavailable' });
  }
});

function buildVixResult(vix, change, changePct, prevClose) {
  // Regime classification
  let regime = 'NORMAL';
  if (vix !== null) {
    if (vix < 12)       regime = 'VERY_LOW';    // options cheap, trend stable
    else if (vix < 16)  regime = 'LOW';
    else if (vix < 20)  regime = 'NORMAL';
    else if (vix < 25)  regime = 'ELEVATED';    // options expensive, use caution
    else if (vix < 30)  regime = 'HIGH';         // avoid buying premium
    else                regime = 'EXTREME';      // panic mode — avoid directional trades
  }

  const premiumBuyable = vix === null || vix < 20; // safe to buy options when VIX < 20

  return {
    status: true, vix, regime, premiumBuyable,
    change: change !== null ? parseFloat((change || 0).toFixed(2)) : null,
    changePct: changePct !== null ? parseFloat((changePct || 0).toFixed(2)) : null,
    prevClose: prevClose || null,
    // Guidance text
    guidance: regime === 'VERY_LOW'  ? 'Low IV — good time to buy options'
            : regime === 'LOW'       ? 'Normal conditions — options fairly priced'
            : regime === 'NORMAL'    ? 'Watch carefully — IV rising'
            : regime === 'ELEVATED'  ? 'Options expensive — prefer selling or spreads'
            : regime === 'HIGH'      ? 'High volatility — avoid naked option buying'
            : regime === 'EXTREME'   ? 'Extreme fear — directional trades risky'
            : 'VIX data unavailable',
  };
}

// ─────────────────────────────────────────────────────────────────────
// ROUTE: OI ANALYSIS — Open Interest per strike from option chain
// Body: { symbol, spotPrice, expiry }
// Returns: { pcr, maxPain, oiBuildup, oiUnwinding, supportStrike, resistStrike }
// ─────────────────────────────────────────────────────────────────────
app.post('/oi-analysis', async (req, res) => {
  if (!isAuthenticated()) return res.status(401).json({ status: false, message: 'Not authenticated' });

  const { symbol, spotPrice, expiry } = req.body;
  if (!symbol || !spotPrice) return res.status(400).json({ status: false, message: 'symbol and spotPrice required' });

  // Stocks have NO weekly options — always use MONTHLY
  // Indices have weekly options — use WEEKLY unless caller overrides
  const effectiveExpiry = expiry || getExpiryType(symbol);

  try {
    // Ensure instruments loaded
    if (!SESSION._instruments || (Date.now() - (SESSION._instrFetchTime || 0)) > 4 * 3600 * 1000) {
      log('Downloading NFO instrument master for OI analysis...', 'INFO');
      const instrResp = await axios.get(
        'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json',
        { timeout: 30000 }
      );
      SESSION._instruments = instrResp.data;
      SESSION._instrFetchTime = Date.now();
    }

    const sym  = symbol.toUpperCase();
    const spot = parseFloat(spotPrice);
    const now  = new Date();

    // Shared parseExpiry helper — handles Angel's DDMONYYYY format
    const MON_OI = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
    function parseExpiryOI(raw) {
      if (!raw) return null;
      const s = String(raw).trim().toUpperCase();
      const m1 = s.match(/^(\d{1,2})([A-Z]{3})(\d{4})$/);
      if (m1) { const mon = MON_OI[m1[2]]; if (mon !== undefined) return new Date(+m1[3], mon, +m1[1]); }
      const m2 = s.match(/^(\d{4})(\d{2})(\d{2})$/); if (m2) return new Date(+m2[1], +m2[2]-1, +m2[3]);
      const m3 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (m3) return new Date(+m3[1], +m3[2]-1, +m3[3]);
      const d = new Date(raw); return isNaN(d) ? null : d;
    }

    // Filter NFO options for this underlying
    const allOptions = SESSION._instruments.filter(i => {
      if (i.exch_seg !== 'NFO') return false;
      if (!i.instrumenttype || !i.instrumenttype.includes('OPT')) return false;
      const expDate = parseExpiryOI(i.expiry);
      if (!expDate || expDate < now) return false;
      if (i.name && i.name.toUpperCase() === sym) return true;
      if (i.symbol) {
        const s = i.symbol.toUpperCase();
        if (s.startsWith(sym) && s.length > sym.length && /\d/.test(s[sym.length])) return true;
      }
      return false;
    });

    if (!allOptions.length) return res.json({ status: false, message: `No NFO options for ${sym}` });

    // Pick expiry using parsed dates, keyed by raw string for exact match
    const uniqueExp = [...new Set(allOptions.map(i => i.expiry))]
      .map(raw => ({ raw, date: parseExpiryOI(raw) }))
      .filter(e => e.date && e.date >= now)
      .sort((a, b) => a.date - b.date);

    let chosenExpRaw;
    if (effectiveExpiry === 'MONTHLY') {
      const m = now.getMonth(), y = now.getFullYear();
      const thisMonth = uniqueExp.filter(e => e.date.getMonth() === m && e.date.getFullYear() === y);
      chosenExpRaw = (thisMonth[thisMonth.length - 1] || uniqueExp[0])?.raw;
    } else if (effectiveExpiry === 'NEXT_MONTH') {
      // Stock within 5 days of expiry — pick NEXT calendar month's last Tuesday
      const nextM = (now.getMonth() + 1) % 12;
      const nextY  = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
      const nextMonth = uniqueExp.filter(e => e.date.getMonth() === nextM && e.date.getFullYear() === nextY);
      chosenExpRaw = (nextMonth[nextMonth.length - 1] || uniqueExp[1] || uniqueExp[0])?.raw;
      log(`NEXT_MONTH expiry selected: ${chosenExpRaw}`, 'INFO');
    } else if (effectiveExpiry === 'NEXT') {
      chosenExpRaw = (uniqueExp[1] || uniqueExp[0])?.raw;
    } else {
      chosenExpRaw = uniqueExp[0]?.raw; // WEEKLY = nearest Tuesday
    }
    if (!chosenExpRaw) return res.json({ status: false, message: 'No valid expiry' });

    const expiryOpts = allOptions.filter(i => i.expiry === chosenExpRaw);

    // Collect all strikes ± 10 from ATM
    const allStrikes = [...new Set(expiryOpts.map(i => Math.round(parseFloat(i.strike) / 100)))]
      .filter(s => s > 0).sort((a, b) => a - b);
    const realAtm = allStrikes.reduce((b, s) => Math.abs(s - spot) < Math.abs(b - spot) ? s : b, allStrikes[0]);
    const atmIdx = allStrikes.indexOf(realAtm);
    const depth = 10;
    const strikeList = allStrikes.slice(Math.max(0, atmIdx - depth), atmIdx + depth + 1);

    // Gather tokens for FULL quote (includes OI)
    const tokens = [];
    const tokenMeta = {};
    for (const strike of strikeList) {
      const strikeVal = strike * 100;
      const ces = expiryOpts.filter(i => Math.round(parseFloat(i.strike)) === strikeVal && i.symbol?.toUpperCase().endsWith('CE'));
      const pes = expiryOpts.filter(i => Math.round(parseFloat(i.strike)) === strikeVal && i.symbol?.toUpperCase().endsWith('PE'));
      if (ces[0]?.token) { tokens.push(String(ces[0].token)); tokenMeta[String(ces[0].token)] = { strike, type: 'CE' }; }
      if (pes[0]?.token) { tokens.push(String(pes[0].token)); tokenMeta[String(pes[0].token)] = { strike, type: 'PE' }; }
    }

    // Fetch FULL mode (has openInterest)
    const strikeData = {};
    const batchSize = 50;
    for (let i = 0; i < tokens.length; i += batchSize) {
      const batch = tokens.slice(i, i + batchSize);
      try {
        const qr = await axios.post(
          `${ANGEL_API}/rest/secure/angelbroking/market/v1/quote/`,
          { mode: 'FULL', exchangeTokens: { NFO: batch } },
          { headers: getHeaders(true), timeout: 20000 }
        );
        if (qr.data.status && qr.data.data?.fetched) {
          qr.data.data.fetched.forEach(q => {
            const meta = tokenMeta[String(q.symbolToken)];
            if (!meta) return;
            if (!strikeData[meta.strike]) strikeData[meta.strike] = {};
            strikeData[meta.strike][meta.type] = {
              ltp: parseFloat(q.ltp || q.close || 0),
              oi:  parseInt(q.openInterest || q.oi || 0),
              oiChange: parseInt(q.netChange || 0),
              volume: parseInt(q.tradeVolume || q.volume || 0),
            };
          });
        }
      } catch (e) { log(`OI batch fetch error: ${e.message}`, 'WARN'); }
    }

    // Build chain array
    const chain = strikeList.map(strike => ({
      strike,
      isATM: strike === realAtm,
      CE_ltp:      strikeData[strike]?.CE?.ltp    ?? null,
      CE_oi:       strikeData[strike]?.CE?.oi     ?? 0,
      CE_oiChange: strikeData[strike]?.CE?.oiChange ?? 0,
      CE_vol:      strikeData[strike]?.CE?.volume  ?? 0,
      PE_ltp:      strikeData[strike]?.PE?.ltp    ?? null,
      PE_oi:       strikeData[strike]?.PE?.oi     ?? 0,
      PE_oiChange: strikeData[strike]?.PE?.oiChange ?? 0,
      PE_vol:      strikeData[strike]?.PE?.volume  ?? 0,
    }));

    // PCR — Put-Call Ratio by OI
    const totalCeOI = chain.reduce((s, c) => s + (c.CE_oi || 0), 0);
    const totalPeOI = chain.reduce((s, c) => s + (c.PE_oi || 0), 0);
    const pcr = totalCeOI > 0 ? parseFloat((totalPeOI / totalCeOI).toFixed(3)) : null;
    const pcrBias = pcr === null ? 'NEUTRAL' : pcr > 1.3 ? 'BULLISH' : pcr < 0.7 ? 'BEARISH' : 'NEUTRAL';

    // Max Pain
    const maxPain = calcMaxPain(chain);

    // Resistance = CE strike with highest OI (call writers — Ramesh — defend it)
    const resistStrikeObj = chain.reduce((b, c) => (c.CE_oi > (b?.CE_oi || 0) ? c : b), null);
    const resistStrike = resistStrikeObj?.strike || null;
    // Support = PE strike with highest OI (put writers — Suresh — defend it)
    const supportStrikeObj = chain.reduce((b, c) => (c.PE_oi > (b?.PE_oi || 0) ? c : b), null);
    const supportStrike = supportStrikeObj?.strike || null;

    // OI buildup / unwinding signals
    const ceBuildup = chain.filter(c => c.CE_oiChange > 0 && c.strike > realAtm).slice(0, 3);
    const peBuildup = chain.filter(c => c.PE_oiChange > 0 && c.strike < realAtm).slice(-3);

    // ── RAMESH / SURESH ANALYSIS ─────────────────────────────────────
    // Ramesh = call writer; wants price DOWN. Trapped when spot > his strike.
    // Suresh = put writer; wants price UP.  Trapped when spot < his strike.

    // ATM CE and PE OI — battle at current price
    const atmRow = chain.find(c => c.strike === realAtm) || {};
    const atmCeOI = atmRow.CE_oi || 0;
    const atmPeOI = atmRow.PE_oi || 0;
    const atmPCR  = atmCeOI > 0 ? parseFloat((atmPeOI / atmCeOI).toFixed(3)) : null;

    // Is Ramesh (call writer) trapped? — spot crossed above his highest CE OI strike
    const rameshTrapped = resistStrike !== null && spot > resistStrike;
    // Is Suresh (put writer) trapped? — spot fell below his highest PE OI strike
    const sureshTrapped = supportStrike !== null && spot < supportStrike;

    // Short squeeze potential: large CE OI just below spot (Ramesh must buy back)
    const ceOIBelowSpot = chain
      .filter(c => c.strike <= spot && c.strike >= spot * 0.98)
      .reduce((s, c) => s + (c.CE_oi || 0), 0);
    const shortSqueezePotential = ceOIBelowSpot > (totalCeOI * 0.15); // >15% CE OI just below spot

    // Put squeeze potential: large PE OI just above spot (Suresh must buy back)
    const peOIAboveSpot = chain
      .filter(c => c.strike >= spot && c.strike <= spot * 1.02)
      .reduce((s, c) => s + (c.PE_oi || 0), 0);
    const putSqueezePotential = peOIAboveSpot > (totalPeOI * 0.15);

    // OI battle bias: who has more firepower near ATM (±2 strikes)
    const nearChain = chain.filter(c => Math.abs(c.strike - realAtm) <= 2 * (chain[1]?.strike - chain[0]?.strike || 10));
    const nearCeOI  = nearChain.reduce((s, c) => s + (c.CE_oi || 0), 0);
    const nearPeOI  = nearChain.reduce((s, c) => s + (c.PE_oi || 0), 0);
    const oiBattleBias = nearCeOI === 0 && nearPeOI === 0 ? 'NEUTRAL'
      : nearPeOI / (nearCeOI || 1) > 1.5 ? 'BULLISH'   // Suresh dominant near ATM
      : nearCeOI / (nearPeOI || 1) > 1.5 ? 'BEARISH'   // Ramesh dominant near ATM
      : 'NEUTRAL';

    // Conflict detector: technical direction vs OI battle bias
    // (filled in by signal-analysis route which has both)
    const oiBattleSummary = (() => {
      const parts = [];
      if (rameshTrapped)        parts.push(`Ramesh trapped (spot ${spot} > resist ${resistStrike}) — short squeeze risk`);
      if (sureshTrapped)        parts.push(`Suresh trapped (spot ${spot} < support ${supportStrike}) — put squeeze risk`);
      if (shortSqueezePotential) parts.push(`Short squeeze potential — large CE OI just below spot`);
      if (putSqueezePotential)  parts.push(`Put squeeze potential — large PE OI just above spot`);
      if (parts.length === 0)   parts.push('No squeeze detected — OI battle balanced');
      return parts;
    })();

    // Per-strike PCR for top strikes near ATM (for Ramesh/Suresh visual)
    const strikeAnalysis = chain
      .filter(c => Math.abs(c.strike - realAtm) <= 5 * (chain[1]?.strike - chain[0]?.strike || 10))
      .map(c => ({
        strike: c.strike,
        CE_oi:  c.CE_oi,
        PE_oi:  c.PE_oi,
        strikePCR: c.CE_oi > 0 ? parseFloat((c.PE_oi / c.CE_oi).toFixed(2)) : null,
        rameshStrength: c.CE_oi,   // call writer power
        sureshStrength: c.PE_oi,   // put writer power
        winner: !c.CE_oi && !c.PE_oi ? 'NEUTRAL'
              : (c.PE_oi / (c.CE_oi || 1)) > 1.5 ? 'SURESH'
              : (c.CE_oi / (c.PE_oi || 1)) > 1.5 ? 'RAMESH'
              : 'NEUTRAL',
      }));

    log(`OI ${sym}: PCR=${pcr} MaxPain=${maxPain} Support=${supportStrike} Resist=${resistStrike} OIBias=${oiBattleBias} RameshTrapped=${rameshTrapped}`, 'INFO');

    res.json({
      status: true, symbol: sym, expiry: chosenExpiryStr,
      atmStrike: realAtm, spotPrice: spot,
      pcr, pcrBias, maxPain,
      supportStrike, resistStrike,
      totalCeOI, totalPeOI,
      chain,
      // Proximity flags
      nearMaxPain:    maxPain ? Math.abs(spot - maxPain) / spot < 0.01 : false,
      nearSupport:    supportStrike ? Math.abs(spot - supportStrike) / spot < 0.005 : false,
      nearResistance: resistStrike  ? Math.abs(spot - resistStrike)  / spot < 0.005 : false,
      // ── Ramesh / Suresh Intelligence ──
      atmCeOI, atmPeOI, atmPCR,
      rameshTrapped, sureshTrapped,
      shortSqueezePotential, putSqueezePotential,
      oiBattleBias,
      oiBattleSummary,
      strikeAnalysis,
    });

  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    log(`OI analysis error: ${msg}`, 'WARN');
    res.status(500).json({ status: false, message: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────
// HELPER: Per-instrument expiry day detection
// Source: Dhan F&O Expiry Calendar (dhan.co/fno-expiry-calendar)
//
// NSE INDICES (Weekly):
//   NIFTY       → Tuesday  (day 2)
//   BANKNIFTY   → Tuesday  (day 2) — monthly only, no weekly as of 2024
//   FINNIFTY    → Tuesday  (day 2)
//   MIDCPNIFTY  → Tuesday  (day 2) — monthly
//   NIFTYNEXT50 → Tuesday  (day 2) — monthly
//
// NSE STOCKS:
//   All stocks  → MONTHLY only → Last Tuesday of expiry month
//   (No weekly stock options on NSE)
//
// BSE (not used in this app):
//   SENSEX/BANKEX → Thursday (day 4)
//
// NOTE: NSE moved all weeklies/monthlies from Thursday → Tuesday in 2024
// ─────────────────────────────────────────────────────────────────────
function isIndexExpiryDay(sym) {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  // All NSE F&O (indices + stocks) expire on Tuesday (day 2)
  return day === 2;
}

// ─────────────────────────────────────────────────────────────────────
// EXPIRY RULES (per Dhan F&O Calendar):
//   NIFTY only      -> WEEKLY  (every Tuesday)
//   BANKNIFTY       -> MONTHLY (last Tuesday of month)
//   FINNIFTY        -> MONTHLY (last Tuesday of month)
//   MIDCPNIFTY      -> MONTHLY (last Tuesday of month)
//   All Stocks      -> MONTHLY normally
//                      BUT if within 5 calendar days of last Tuesday
//                      -> use NEXT_MONTH to avoid physical delivery zone
// ─────────────────────────────────────────────────────────────────────
function getLastTuesdayOfMonth(year, month) {
  const lastDay = new Date(year, month + 1, 0);
  const dow = lastDay.getDay();
  const back = (dow >= 2) ? (dow - 2) : (dow + 5);
  const d = new Date(lastDay);
  d.setDate(lastDay.getDate() - back);
  d.setHours(0, 0, 0, 0);
  return d;
}

function getExpiryType(sym) {
  const s = (sym || '').toUpperCase();

  // NIFTY only has weekly
  if (s === 'NIFTY') return 'WEEKLY';

  // Index monthlies — always use current month's last Tuesday
  if (s === 'BANKNIFTY' || s === 'FINNIFTY' || s === 'MIDCPNIFTY' || s === 'MIDCAP') {
    return 'MONTHLY';
  }

  // STOCKS — monthly, but switch to next month 5 days before expiry
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  ist.setHours(0, 0, 0, 0);
  const lastTue = getLastTuesdayOfMonth(ist.getFullYear(), ist.getMonth());
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysToExpiry = Math.round((lastTue - ist) / msPerDay);

  if (daysToExpiry >= 0 && daysToExpiry <= 5) {
    log(`Stock ${s}: ${daysToExpiry}d to expiry — using NEXT month contract`, 'INFO');
    return 'NEXT_MONTH';
  }
  return 'MONTHLY';
}

// WEIGHTED SIGNAL SCORING ENGINE
// ─────────────────────────────────────────────────────────────────────
//
// Philosophy: weighted points instead of binary AND.
// A signal can pass even if minor filters fail (VIX slightly high,
// news mixed, expiry day) as long as the core chart setup is strong.
//
// Score tiers:
//   75–100 → STRONG   (trade with full size)
//   60–74  → MODERATE (trade with half size)
//   45–59  → WEAK     (watch, wait for confirmation)
//   < 45   → AVOID
//
// Hard blocks (rare): VIX > 30 (extreme panic) OR core trend fully
// against direction. These override the score.
// ─────────────────────────────────────────────────────────────────────

// WEIGHT TABLE — total available = 100 points
const SIGNAL_WEIGHTS = {
  // ── Core technical (55 pts) ──────────────────────────────────────
  marketBias:     20,   // EMA 20/50 trend direction — highest weight
  supertrend:     15,   // Supertrend UP/DOWN confirmation
  rsi:            10,   // RSI momentum (oversold/overbought)
  macd:           10,   // MACD crossover / above signal line

  // ── Intraday structure (20 pts) ──────────────────────────────────
  aboveVwap:      10,   // Price vs VWAP
  orbBreakout:    10,   // ORB breakout/breakdown trigger

  // ── Confirmation layer (15 pts) ──────────────────────────────────
  volumeConfirm:   7,   // Volume ratio >= 1.2x
  instFlow:        5,   // FII/DII institutional direction
  pcrBias:         3,   // Put-Call Ratio sentiment

  // ── Soft filters — warnings, not blockers (10 pts) ───────────────
  vixRegime:       5,   // VIX regime penalty/bonus
  newsSentiment:   2,   // News keyword scoring (noisy — low weight)
  geoRisk:         2,   // Geopolitical risk headlines
  expiryDay:       1,   // Expiry day caution

  // ── Ramesh/Suresh OI Battle (8 pts) ──────────────────────────────
  oiBattle:        8,   // OI writer trap + squeeze + battle bias
};

// Max possible score = sum of all weights = 100
const MAX_SCORE = Object.values(SIGNAL_WEIGHTS).reduce((a, b) => a + b, 0);

/**
 * scoreSignal(d, type) → { score, maxPossible, breakdown, hardBlock, hardBlockReason }
 *
 * d = assembled data object (bias + fii + vix + news + oi)
 * type = 'CE' | 'PE'
 *
 * Each check returns { earned, max, label, pass, note }
 * 'earned' is fractional: full weight, half weight, or 0.
 * null data = skip the check (don't penalise missing data).
 */
function scoreSignal(d, type) {
  const isCE = type === 'CE';
  const breakdown = {};
  let hardBlock = false;
  let hardBlockReason = '';

  // ── HARD BLOCK: extreme VIX (panic mode) ──────────────────────────
  if (d.vixValue !== null && d.vixValue >= 30) {
    hardBlock = true;
    hardBlockReason = `India VIX at ${d.vixValue} — extreme panic, avoid directional trades`;
  }

  // ── 1. Market Bias (EMA 20/50 trend) — 20 pts ─────────────────────
  {
    const w = SIGNAL_WEIGHTS.marketBias;
    let earned = 0, note = '';
    if (isCE) {
      if (d.bias === 'BULLISH')       { earned = w;       note = 'EMA bullish trend ✓'; }
      else if (d.bias === 'NEUTRAL')  { earned = w * 0.5; note = 'EMA neutral — partial'; }
      else                            { earned = 0;       note = 'EMA bearish — against CE'; }
    } else {
      if (d.bias === 'BEARISH')       { earned = w;       note = 'EMA bearish trend ✓'; }
      else if (d.bias === 'NEUTRAL')  { earned = w * 0.5; note = 'EMA neutral — partial'; }
      else                            { earned = 0;       note = 'EMA bullish — against PE'; }
    }
    breakdown.marketBias = { earned, max: w, pass: earned >= w * 0.5, note };
  }

  // ── 2. Supertrend — 15 pts ─────────────────────────────────────────
  {
    const w = SIGNAL_WEIGHTS.supertrend;
    if (!d.supertrend) {
      breakdown.supertrend = { earned: w * 0.5, max: w, pass: null, note: 'No data — neutral' };
    } else {
      const up = d.supertrend.trend === 'UP';
      const freshSignal = d.supertrend.signal === (isCE ? 'BUY' : 'SELL');
      let earned = 0, note = '';
      if (isCE) {
        if (up && freshSignal)    { earned = w;       note = 'Supertrend UP + fresh BUY signal ✓✓'; }
        else if (up)              { earned = w * 0.7; note = 'Supertrend UP ✓'; }
        else                      { earned = 0;       note = 'Supertrend DOWN — against CE'; }
      } else {
        if (!up && freshSignal)   { earned = w;       note = 'Supertrend DOWN + fresh SELL signal ✓✓'; }
        else if (!up)             { earned = w * 0.7; note = 'Supertrend DOWN ✓'; }
        else                      { earned = 0;       note = 'Supertrend UP — against PE'; }
      }
      breakdown.supertrend = { earned, max: w, pass: earned > 0, note };
    }
  }

  // ── 3. RSI — 10 pts ───────────────────────────────────────────────
  {
    const w = SIGNAL_WEIGHTS.rsi;
    const rsi = d.rsi || 50;
    let earned = 0, note = '';
    if (isCE) {
      if (rsi < 35)       { earned = w;       note = `RSI ${rsi} — oversold, strong CE`; }
      else if (rsi < 45)  { earned = w * 0.8; note = `RSI ${rsi} — below midline`; }
      else if (rsi < 60)  { earned = w * 0.6; note = `RSI ${rsi} — neutral`; }
      else if (rsi < 70)  { earned = w * 0.3; note = `RSI ${rsi} — elevated, caution`; }
      else                { earned = 0;       note = `RSI ${rsi} — overbought`; }
    } else {
      if (rsi > 65)       { earned = w;       note = `RSI ${rsi} — overbought, strong PE`; }
      else if (rsi > 55)  { earned = w * 0.8; note = `RSI ${rsi} — above midline`; }
      else if (rsi > 40)  { earned = w * 0.6; note = `RSI ${rsi} — neutral`; }
      else if (rsi > 30)  { earned = w * 0.3; note = `RSI ${rsi} — low, caution`; }
      else                { earned = 0;       note = `RSI ${rsi} — oversold`; }
    }
    breakdown.rsi = { earned, max: w, pass: earned >= w * 0.4, note };
  }

  // ── 4. MACD — 10 pts ──────────────────────────────────────────────
  {
    const w = SIGNAL_WEIGHTS.macd;
    if (!d.macd) {
      breakdown.macd = { earned: w * 0.5, max: w, pass: null, note: 'No data — neutral' };
    } else {
      let earned = 0, note = '';
      const bullish = d.macd.aboveSignal;
      const crossover = d.macd.crossover;
      if (isCE) {
        if (crossover === 'BULLISH')      { earned = w;       note = 'MACD fresh bullish crossover ✓✓'; }
        else if (bullish)                 { earned = w * 0.6; note = 'MACD above signal ✓'; }
        else if (crossover === 'BEARISH') { earned = 0;       note = 'MACD fresh bearish cross — bad'; }
        else                              { earned = w * 0.2; note = 'MACD below signal, weak'; }
      } else {
        if (crossover === 'BEARISH')      { earned = w;       note = 'MACD fresh bearish crossover ✓✓'; }
        else if (!bullish)                { earned = w * 0.6; note = 'MACD below signal ✓'; }
        else if (crossover === 'BULLISH') { earned = 0;       note = 'MACD fresh bullish cross — bad'; }
        else                              { earned = w * 0.2; note = 'MACD above signal, weak'; }
      }
      breakdown.macd = { earned, max: w, pass: earned >= w * 0.5, note };
    }
  }

  // ── 5. VWAP — 10 pts ──────────────────────────────────────────────
  {
    const w = SIGNAL_WEIGHTS.aboveVwap;
    if (d.aboveVwap === null) {
      breakdown.aboveVwap = { earned: w * 0.5, max: w, pass: null, note: 'VWAP data unavailable' };
    } else {
      const ok = isCE ? d.aboveVwap : !d.aboveVwap;
      breakdown.aboveVwap = {
        earned: ok ? w : 0, max: w, pass: ok,
        note: ok
          ? `Price ${isCE ? 'above' : 'below'} VWAP ✓`
          : `Price ${isCE ? 'below' : 'above'} VWAP — against ${type}`,
      };
    }
  }

  // ── 6. ORB Breakout — 10 pts ──────────────────────────────────────
  {
    const w = SIGNAL_WEIGHTS.orbBreakout;
    const ref = isCE ? d.orb_high : d.orb_low;
    if (ref === null) {
      breakdown.orbBreakout = { earned: w * 0.5, max: w, pass: null, note: 'ORB not set yet' };
    } else {
      const ok = isCE ? d.ltp > ref : d.ltp < ref;
      // Partial credit: if price is within 0.3% of ORB (approaching breakout)
      const approaching = isCE
        ? (d.ltp > ref * 0.997 && d.ltp <= ref)
        : (d.ltp < ref * 1.003 && d.ltp >= ref);
      let earned = ok ? w : (approaching ? w * 0.4 : 0);
      breakdown.orbBreakout = {
        earned, max: w, pass: ok,
        note: ok ? `ORB ${isCE ? 'breakout' : 'breakdown'} confirmed ✓`
               : approaching ? `Approaching ORB level — watch`
               : `No ORB ${isCE ? 'breakout' : 'breakdown'}`,
      };
    }
  }

  // ── 7. Volume Confirmation — 7 pts ───────────────────────────────
  {
    const w = SIGNAL_WEIGHTS.volumeConfirm;
    const vr = d.volRatio || 1;
    let earned = 0, note = '';
    if (vr >= 1.5)      { earned = w;       note = `Volume ${vr}x — very strong ✓✓`; }
    else if (vr >= 1.2) { earned = w * 0.8; note = `Volume ${vr}x — above average ✓`; }
    else if (vr >= 0.8) { earned = w * 0.4; note = `Volume ${vr}x — average`; }
    else                { earned = 0;       note = `Volume ${vr}x — low, weak signal`; }
    breakdown.volumeConfirm = { earned, max: w, pass: vr >= 1.2, note };
  }

  // ── 8. Institutional Flow (FII/DII) — 5 pts ──────────────────────
  {
    const w = SIGNAL_WEIGHTS.instFlow;
    let earned = 0, note = '';
    if (isCE) {
      if (d.instBias === 'BULLISH')    { earned = w;       note = `FII/DII bullish ₹${d.fiiNet}Cr ✓`; }
      else if (d.instBias === 'NEUTRAL'){ earned = w * 0.5; note = `FII/DII neutral`; }
      else                             { earned = 0;       note = `FII/DII bearish ₹${d.fiiNet}Cr`; }
    } else {
      if (d.instBias === 'BEARISH')    { earned = w;       note = `FII/DII bearish ₹${d.fiiNet}Cr ✓`; }
      else if (d.instBias === 'NEUTRAL'){ earned = w * 0.5; note = `FII/DII neutral`; }
      else                             { earned = 0;       note = `FII/DII bullish ₹${d.fiiNet}Cr`; }
    }
    breakdown.instFlow = { earned, max: w, pass: earned >= w * 0.5, note };
  }

  // ── 9. PCR Bias — 3 pts ───────────────────────────────────────────
  {
    const w = SIGNAL_WEIGHTS.pcrBias;
    if (!d.pcr) {
      breakdown.pcrBias = { earned: w * 0.5, max: w, pass: null, note: 'PCR unavailable' };
    } else {
      let earned = 0, note = '';
      if (isCE) {
        if (d.pcrBias === 'BULLISH')    { earned = w;       note = `PCR ${d.pcr} — bullish ✓`; }
        else if (d.pcrBias === 'NEUTRAL'){ earned = w * 0.5; note = `PCR ${d.pcr} — neutral`; }
        else                            { earned = 0;       note = `PCR ${d.pcr} — bearish`; }
      } else {
        if (d.pcrBias === 'BEARISH')    { earned = w;       note = `PCR ${d.pcr} — bearish ✓`; }
        else if (d.pcrBias === 'NEUTRAL'){ earned = w * 0.5; note = `PCR ${d.pcr} — neutral`; }
        else                            { earned = 0;       note = `PCR ${d.pcr} — bullish`; }
      }
      breakdown.pcrBias = { earned, max: w, pass: earned >= w * 0.5, note };
    }
  }

  // ── 10. VIX Regime — 5 pts (soft filter, graduated penalty) ──────
  {
    const w = SIGNAL_WEIGHTS.vixRegime;
    const regime = d.vixRegime || 'UNKNOWN';
    const vix = d.vixValue;
    let earned = 0, note = '';
    if (regime === 'VERY_LOW')  { earned = w;       note = `VIX ${vix} — very low, cheap options ✓✓`; }
    else if (regime === 'LOW')  { earned = w;       note = `VIX ${vix} — low, good conditions ✓`; }
    else if (regime === 'NORMAL'){ earned = w * 0.7; note = `VIX ${vix} — normal`; }
    else if (regime === 'ELEVATED'){ earned = w * 0.4; note = `VIX ${vix} — elevated, options pricey`; }
    else if (regime === 'HIGH') { earned = w * 0.1; note = `VIX ${vix} — high, reduce size`; }
    else if (regime === 'EXTREME'){ earned = 0;      note = `VIX ${vix} — extreme, hard block`; }
    else                        { earned = w * 0.5; note = 'VIX unknown — neutral'; }
    breakdown.vixRegime = { earned, max: w, pass: earned >= w * 0.4, note };
  }

  // ── 11. News Sentiment — 2 pts ────────────────────────────────────
  {
    const w = SIGNAL_WEIGHTS.newsSentiment;
    const score = d.newsSentimentScore || 50;
    let earned = 0, note = '';
    if (isCE) {
      if (score >= 60)      { earned = w;       note = `News bullish (${score}%) ✓`; }
      else if (score >= 40) { earned = w * 0.5; note = `News neutral (${score}%)`; }
      else                  { earned = 0;       note = `News bearish (${score}%)`; }
    } else {
      if (score <= 40)      { earned = w;       note = `News bearish (${score}%) ✓`; }
      else if (score <= 60) { earned = w * 0.5; note = `News neutral (${score}%)`; }
      else                  { earned = 0;       note = `News bullish (${score}%)`; }
    }
    breakdown.newsSentiment = { earned, max: w, pass: earned >= w * 0.5, note };
  }

  // ── 12. Geo Risk — 2 pts ──────────────────────────────────────────
  {
    const w = SIGNAL_WEIGHTS.geoRisk;
    const geo = d.newsGeoRisk || 0;
    let earned = 0, note = '';
    if (geo === 0)      { earned = w;       note = 'No geopolitical risk ✓'; }
    else if (geo <= 3)  { earned = w * 0.7; note = `Low geo risk (${geo})`; }
    else if (geo <= 6)  { earned = w * 0.3; note = `Moderate geo risk (${geo})`; }
    else                { earned = 0;       note = `High geo risk (${geo}) — caution`; }
    breakdown.geoRisk = { earned, max: w, pass: geo <= 6, note };
  }

  // ── 13. Expiry Day — 1 pt ─────────────────────────────────────────
  {
    const w = SIGNAL_WEIGHTS.expiryDay;
    if (d.isExpiryDay) {
      breakdown.expiryDay = { earned: 0, max: w, pass: false,
        note: 'Expiry day — gamma risk, reduce size' };
    } else {
      breakdown.expiryDay = { earned: w, max: w, pass: true,
        note: 'Not expiry day ✓' };
    }
  }

  // ── 14. Ramesh/Suresh OI Battle — bonus scoring ───────────────────
  // This check adds insight from OI positioning:
  // • Ramesh trapped (spot above his CE OI wall) = bullish squeeze = CE bonus
  // • Suresh trapped (spot below his PE OI wall) = bearish squeeze = PE bonus
  // • OI battle bias near ATM aligns with trade direction = extra confidence
  {
    let oiBattleEarned = 0, oiBattleNote = '', oiBattlePass = null;
    const hasBattleData = d.oiBattleBias && d.oiBattleBias !== 'NEUTRAL';

    if (isCE) {
      if (d.rameshTrapped) {
        oiBattleEarned += 8;
        oiBattleNote = `Ramesh trapped — short squeeze active, CE bullish ✓✓`;
        oiBattlePass = true;
      } else if (d.shortSqueezePotential) {
        oiBattleEarned += 5;
        oiBattleNote = `Short squeeze potential — large CE OI just below spot ✓`;
        oiBattlePass = true;
      } else if (d.oiBattleBias === 'BULLISH') {
        oiBattleEarned += 4;
        oiBattleNote = `Suresh dominant near ATM — OI battle bullish ✓`;
        oiBattlePass = true;
      } else if (d.oiBattleBias === 'BEARISH') {
        oiBattleEarned += 0;
        oiBattleNote = `Ramesh dominant near ATM — OI battle bearish, caution for CE`;
        oiBattlePass = false;
      } else if (d.sureshTrapped) {
        oiBattleEarned += 0;
        oiBattleNote = `Suresh trapped below spot — bearish OI, avoid CE`;
        oiBattlePass = false;
      } else {
        oiBattleEarned += 2;
        oiBattleNote = hasBattleData ? `OI battle neutral` : `OI battle data unavailable`;
        oiBattlePass = null;
      }
      // OI vs Technical conflict detection
      if (oiBattlePass === false && d.bias === 'BULLISH') {
        oiBattleNote += ' ⚠️ CONFLICT: technicals bullish but OI bearish — reduce size!';
      }
    } else {
      // PE trade
      if (d.sureshTrapped) {
        oiBattleEarned += 8;
        oiBattleNote = `Suresh trapped — put squeeze active, PE bearish ✓✓`;
        oiBattlePass = true;
      } else if (d.putSqueezePotential) {
        oiBattleEarned += 5;
        oiBattleNote = `Put squeeze potential — large PE OI just above spot ✓`;
        oiBattlePass = true;
      } else if (d.oiBattleBias === 'BEARISH') {
        oiBattleEarned += 4;
        oiBattleNote = `Ramesh dominant near ATM — OI battle bearish ✓`;
        oiBattlePass = true;
      } else if (d.oiBattleBias === 'BULLISH') {
        oiBattleEarned += 0;
        oiBattleNote = `Suresh dominant near ATM — OI battle bullish, caution for PE`;
        oiBattlePass = false;
      } else if (d.rameshTrapped) {
        oiBattleEarned += 0;
        oiBattleNote = `Ramesh trapped above spot — bullish OI, avoid PE`;
        oiBattlePass = false;
      } else {
        oiBattleEarned += 2;
        oiBattleNote = hasBattleData ? `OI battle neutral` : `OI battle data unavailable`;
        oiBattlePass = null;
      }
      // OI vs Technical conflict detection
      if (oiBattlePass === false && d.bias === 'BEARISH') {
        oiBattleNote += ' ⚠️ CONFLICT: technicals bearish but OI bullish — reduce size!';
      }
    }
    breakdown.oiBattle = { earned: oiBattleEarned, max: 8, pass: oiBattlePass, note: oiBattleNote };
  }

  // ── Total score ───────────────────────────────────────────────────
  const totalEarned  = Object.values(breakdown).reduce((s, b) => s + b.earned, 0);
  const totalPossible = Object.values(breakdown).reduce((s, b) => s + b.max, 0);
  // Normalise to 100 in case some checks were skipped (null data)
  const score = Math.round((totalEarned / totalPossible) * 100);

  return { score, totalEarned: parseFloat(totalEarned.toFixed(1)), totalPossible, breakdown, hardBlock, hardBlockReason };
}

// ─────────────────────────────────────────────────────────────────────
// ROUTE: FULL SIGNAL ANALYSIS — weighted scoring engine v3
// Body: { symbolToken, sym, exchange, isIndex, spotPrice, type }
// Returns: scored result + verdict + stop/target + breakdown
// ─────────────────────────────────────────────────────────────────────
app.post('/signal-analysis', async (req, res) => {
  if (!isAuthenticated()) return res.status(401).json({ status: false, message: 'Not authenticated' });

  const { symbolToken, sym, exchange = 'NSE', isIndex = false, spotPrice, type } = req.body;

  try {
    // ── Fetch all 5 sources in parallel ───────────────────────────
    const [biasResp, fiiResp, vixResp, newsResp, oiResp] = await Promise.allSettled([
      axios.post(`http://localhost:${PORT}/market-bias`,
        { symbolToken, exchange },
        { headers: { 'Content-Type': 'application/json' } }),
      axios.get(`http://localhost:${PORT}/fii-dii`),
      axios.get(`http://localhost:${PORT}/india-vix`),
      axios.get(`http://localhost:${PORT}/news-sentiment`),
      spotPrice
        ? axios.post(`http://localhost:${PORT}/oi-analysis`,
            { symbol: sym, spotPrice, expiry: getExpiryType(sym) },
            { headers: { 'Content-Type': 'application/json' } })
        : Promise.resolve({ data: null }),
    ]);

    const bias = biasResp.status === 'fulfilled' ? biasResp.value.data : {};
    const fii  = fiiResp.status  === 'fulfilled' ? fiiResp.value.data  : {};
    const vix  = vixResp.status  === 'fulfilled' ? vixResp.value.data  : {};
    const news = newsResp.status === 'fulfilled' ? newsResp.value.data  : {};
    const oi   = oiResp.status   === 'fulfilled' && oiResp.value.data?.status
                   ? oiResp.value.data : null;

    // ── Assemble data object for scorer ───────────────────────────
    const d = {
      sym, type,
      // Technical
      bias:         bias.bias        || 'NEUTRAL',
      ema20:        bias.ema20       || null,
      ema50:        bias.ema50       || null,
      rsi:          bias.rsi         ?? 50,
      vwap:         bias.vwap        || null,
      aboveVwap:    bias.aboveVwap   ?? null,
      pdh:          bias.pdh         || null,
      pdl:          bias.pdl         || null,
      orb_high:     bias.orb_high    || null,
      orb_low:      bias.orb_low     || null,
      volRatio:     bias.volRatio    ?? 1,
      ltp:          bias.ltp         || spotPrice || null,
      macd:         bias.macd        || null,
      atr:          bias.atr         || null,
      supertrend:   bias.supertrend  || null,
      atrStopLong:  bias.atrStopLong || null,
      atrStopShort: bias.atrStopShort|| null,
      isExpiryDay:  isIndexExpiryDay(sym),  // per-index: FINNIFTY=Tue, MIDCAP=Mon, NIFTY=Thu, BANKNIFTY=Wed
      // Institutional
      instBias:     fii.instBias     || 'NEUTRAL',
      fiiNet:       fii.fiiNet       ?? 0,
      diiNet:       fii.diiNet       ?? 0,
      // VIX
      vixValue:     vix.vix          || null,
      vixRegime:    vix.regime       || 'UNKNOWN',
      premiumBuyable: vix.premiumBuyable !== false,
      vixGuidance:  vix.guidance     || '',
      // News
      newsSentiment:      news.sentiment      || 'NEUTRAL',
      newsSentimentScore: news.sentimentScore ?? 50,
      newsGeoRisk:        news.geoRisk        ?? 0,
      // OI
      pcr:             oi?.pcr             || null,
      pcrBias:         oi?.pcrBias         || 'NEUTRAL',
      maxPain:         oi?.maxPain         || null,
      oiSupportStrike: oi?.supportStrike   || null,
      oiResistStrike:  oi?.resistStrike    || null,
      nearMaxPain:     oi?.nearMaxPain     || false,
      nearSupport:     oi?.nearSupport     || false,
      nearResistance:  oi?.nearResistance  || false,
      // Ramesh / Suresh OI Intelligence
      rameshTrapped:         oi?.rameshTrapped         || false,
      sureshTrapped:         oi?.sureshTrapped         || false,
      shortSqueezePotential: oi?.shortSqueezePotential || false,
      putSqueezePotential:   oi?.putSqueezePotential   || false,
      oiBattleBias:          oi?.oiBattleBias          || 'NEUTRAL',
      oiBattleSummary:       oi?.oiBattleSummary       || [],
      strikeAnalysis:        oi?.strikeAnalysis        || [],
      atmCeOI:               oi?.atmCeOI               || 0,
      atmPeOI:               oi?.atmPeOI               || 0,
      atmPCR:                oi?.atmPCR                || null,
    };

    // ── Run weighted scorer ────────────────────────────────────────
    const { score, totalEarned, totalPossible, breakdown, hardBlock, hardBlockReason } = scoreSignal(d, type);

    // ── Verdict tiers ─────────────────────────────────────────────
    let verdict, actionNote;
    if (hardBlock) {
      verdict    = 'BLOCKED';
      actionNote = hardBlockReason;
    } else if (score >= 75) {
      verdict    = 'STRONG';
      actionNote = 'High conviction — trade with normal size';
    } else if (score >= 60) {
      verdict    = 'MODERATE';
      actionNote = 'Good setup — consider half position size';
    } else if (score >= 42) {
      verdict    = 'WEAK';
      actionNote = 'Marginal setup — watch, wait for more confirmation';
    } else {
      verdict    = 'AVOID';
      actionNote = 'Poor alignment — skip this signal';
    }

    // ── ATR-based risk levels ─────────────────────────────────────
    let suggestedStop = null, suggestedTarget = null, riskReward = null;
    if (d.atr && d.ltp) {
      suggestedStop   = type === 'CE'
        ? parseFloat((d.ltp - 1.5 * d.atr).toFixed(2))
        : parseFloat((d.ltp + 1.5 * d.atr).toFixed(2));
      suggestedTarget = type === 'CE'
        ? parseFloat((d.ltp + 2.5 * d.atr).toFixed(2))
        : parseFloat((d.ltp - 2.5 * d.atr).toFixed(2));
      const risk   = Math.abs(d.ltp - suggestedStop);
      const reward = Math.abs(d.ltp - suggestedTarget);
      riskReward   = risk > 0 ? parseFloat((reward / risk).toFixed(2)) : null;
    }

    // ── Main reason: single strongest contributing factor ─────────
    const reasons = Object.entries(breakdown)
      .filter(([, v]) => v.pass !== false && v.earned > 0)
      .sort((a, b) => b[1].earned - a[1].earned)
      .slice(0, 1)
      .map(([, v]) => v.note.replace(/✓✓|✓|★/g, '').trim());

    // ── Warnings (checks that dragged score down) ─────────────────
    const warnings = Object.entries(breakdown)
      .filter(([, v]) => v.pass === false)
      .map(([, v]) => v.note);

    log(`Signal ${sym} ${type}: score=${score} verdict=${verdict} VIX=${d.vixValue} RSI=${d.rsi} bias=${d.bias}`, 'INFO');

    res.json({
      status: true,
      sym, type,
      // ── Score ──
      score,               // 0–100
      totalEarned,
      totalPossible,
      verdict,             // STRONG | MODERATE | WEAK | AVOID | BLOCKED
      actionNote,
      hardBlock,
      hardBlockReason: hardBlock ? hardBlockReason : null,
      // ── Breakdown ──
      breakdown,           // per-check { earned, max, pass, note }
      reasons,             // top 3 positive reasons
      warnings,            // failed checks
      // ── Raw data ──
      ...d,
      // ── Risk management ──
      suggestedStop,
      suggestedTarget,
      riskReward,
    });

  } catch (err) {
    log(`signal-analysis error: ${err.message}`, 'ERR');
    res.status(500).json({ status: false, message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────────────
// ROUTE: OI GAINERS (top F&O by OI change)
// ─────────────────────────────────────────────────────────────────────
app.get('/gainers', async (req, res) => {
  if (!isAuthenticated()) {
    return res.status(401).json({ status: false, message: 'Not authenticated' });
  }

  try {
    const response = await axios.get(
      `${ANGEL_API}/rest/secure/angelbroking/marketData/v1/gainersAndLosers`,
      { params: req.query, headers: getHeaders(true), timeout: 15000 }
    );
    res.json(response.data);
  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    res.status(500).json({ status: false, message: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────
// ROUTE: MCX COMMODITY LIVE PRICES
// Returns live LTP for Gold, Silver, CrudeOil, NaturalGas, Copper, Zinc
// ─────────────────────────────────────────────────────────────────────
app.get('/mcx', async (req, res) => {
  if (!isAuthenticated()) {
    return res.status(401).json({ status: false, message: 'Not authenticated' });
  }

  try {
    // Ensure instrument master is loaded
    if (!SESSION._instruments || (Date.now() - (SESSION._instrFetchTime||0)) > 4*3600*1000) {
      log('Downloading instrument master for MCX...', 'INFO');
      const instrResp = await axios.get(
        'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json',
        { timeout: 30000 }
      );
      SESSION._instruments = instrResp.data;
      SESSION._instrFetchTime = Date.now();
    }

    const instruments = SESSION._instruments;
    const now = new Date();

    // Key MCX commodities to track
    const MCX_COMMODITIES = [
      { name: 'GOLD',       sym: 'GOLD',       unit: '10g'  },
      { name: 'SILVER',     sym: 'SILVER',     unit: 'kg'   },
      { name: 'CRUDEOIL',   sym: 'CRUDEOIL',   unit: 'bbl'  },
      { name: 'NATURALGAS', sym: 'NATURALGAS', unit: 'mmBtu'},
      { name: 'COPPER',     sym: 'COPPER',     unit: 'kg'   },
      { name: 'ZINC',       sym: 'ZINC',       unit: 'kg'   },
      { name: 'ALUMINIUM',  sym: 'ALUMINIUM',  unit: 'kg'   },
      { name: 'LEAD',       sym: 'LEAD',       unit: 'kg'   },
      { name: 'NICKEL',     sym: 'NICKEL',     unit: 'kg'   },
      { name: 'GOLDM',      sym: 'GOLDM',      unit: '100g' },
      { name: 'SILVERM',    sym: 'SILVERM',    unit: 'kg'   },
    ];

    // Find nearest expiry MCX futures for each commodity
    const tokens = [];
    const tokenMap = {};

    for (const comm of MCX_COMMODITIES) {
      const matches = instruments.filter(i => {
        if (i.exch_seg !== 'MCX') return false;
        if (i.name !== comm.sym) return false;
        if (i.instrumenttype !== 'FUTCOM') return false;
        // Parse expiry — Angel uses DDMONYYYY for MCX too
        const MON2 = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
        const s = String(i.expiry||'').trim().toUpperCase();
        const m1 = s.match(/^(\d{1,2})([A-Z]{3})(\d{4})$/);
        let expDate = m1 ? new Date(+m1[3], MON2[m1[2]]??0, +m1[1]) : new Date(i.expiry);
        return expDate >= now;
      }).sort((a, b) => {
        const MON2 = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
        const parse = r => { const s=String(r).trim().toUpperCase(); const m=s.match(/^(\d{1,2})([A-Z]{3})(\d{4})$/); return m?new Date(+m[3],MON2[m[2]]??0,+m[1]):new Date(r); };
        return parse(a.expiry) - parse(b.expiry);
      });

      if (matches.length > 0) {
        const nearest = matches[0];
        tokens.push(nearest.token);
        tokenMap[nearest.token] = { ...comm, expiry: nearest.expiry, tradingSymbol: nearest.symbol };
      }
    }

    if (!tokens.length) {
      return res.json({ status: false, message: 'No MCX instruments found' });
    }

    // Fetch live LTPs
    const quoteResp = await axios.post(
      `${ANGEL_API}/rest/secure/angelbroking/market/v1/quote/`,
      { mode: 'FULL', exchangeTokens: { MCX: tokens } },
      { headers: getHeaders(true), timeout: 15000 }
    );

    const qData = quoteResp.data;
    if (!qData.status || !qData.data?.fetched?.length) {
      return res.json({ status: false, message: 'MCX quote returned no data' });
    }

    const result = qData.data.fetched.map(q => {
      const info = tokenMap[String(q.symbolToken)] || {};
      const ltp  = parseFloat(q.ltp || 0);
      const open = parseFloat(q.open || ltp);
      const chg  = open > 0 ? ((ltp - open) / open * 100) : 0;
      return {
        name:          info.name || q.tradingSymbol,
        sym:           info.sym  || q.tradingSymbol,
        unit:          info.unit || '',
        tradingSymbol: info.tradingSymbol || q.tradingSymbol,
        expiry:        info.expiry || '',
        ltp,
        open:          parseFloat(q.open  || 0),
        high:          parseFloat(q.high  || 0),
        low:           parseFloat(q.low   || 0),
        close:         parseFloat(q.close || 0),
        chgPct:        parseFloat(chg.toFixed(2)),
        volume:        parseInt(q.tradeVolume || q.volume || 0),
        token:         String(q.symbolToken),
      };
    });

    log(`✅ MCX: ${result.length} commodities fetched`, 'OK');
    res.json({ status: true, data: result });

  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    log(`MCX error: ${msg}`, 'WARN');
    res.status(500).json({ status: false, message: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────
// ROUTE: PUT-CALL RATIO
// ─────────────────────────────────────────────────────────────────────
app.get('/pcr', async (req, res) => {
  if (!isAuthenticated()) {
    return res.status(401).json({ status: false, message: 'Not authenticated' });
  }

  try {
    const response = await axios.get(
      `${ANGEL_API}/rest/secure/angelbroking/market/v1/putCallRatio`,
      { headers: getHeaders(true), timeout: 15000 }
    );
    res.json(response.data);
  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    res.status(500).json({ status: false, message: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────
// ROUTE: OPTION LTP — fetch live premium for a specific option contract
// Body: { symbol, strike, type, expiry }
// Returns: { status, ltp, symbolToken, tradingSymbol }
// ─────────────────────────────────────────────────────────────────────
app.post('/option-ltp', async (req, res) => {
  if (!isAuthenticated()) {
    return res.status(401).json({ status: false, message: 'Not authenticated' });
  }

  const { symbol, strike, type, expiry } = req.body;
  if (!symbol || !strike || !type) {
    return res.status(400).json({ status: false, message: 'symbol, strike, type required' });
  }

  try {
    if (!SESSION._instruments || (Date.now() - (SESSION._instrFetchTime||0)) > 4*3600*1000) {
      log('Downloading NFO instrument master...', 'INFO');
      const instrResp = await axios.get(
        'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json',
        { timeout: 30000 }
      );
      SESSION._instruments = instrResp.data;
      SESSION._instrFetchTime = Date.now();
      log(`Instrument master loaded — ${SESSION._instruments.length} instruments`, 'OK');
    }

    const MON = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
    function parseExpiry(raw) {
      if (!raw) return null;
      const s = String(raw).trim().toUpperCase();
      const m1 = s.match(/^(\d{1,2})([A-Z]{3})(\d{4})$/);
      if (m1) { const mon = MON[m1[2]]; if (mon !== undefined) return new Date(+m1[3], mon, +m1[1]); }
      const m2 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
      if (m2) return new Date(+m2[1], +m2[2]-1, +m2[3]);
      const m3 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m3) return new Date(+m3[1], +m3[2]-1, +m3[3]);
      const m4 = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
      if (m4) return new Date(+m4[3], +m4[2]-1, +m4[1]);
      const d = new Date(raw); return isNaN(d) ? null : d;
    }

    const sym       = symbol.toUpperCase();
    const optType   = type.toUpperCase();
    const strikeNum = parseFloat(strike);
    const now       = new Date();

    // Find matching NFO options: name OR symbol-prefix, correct strike, correct type
    const matches = SESSION._instruments.filter(i => {
      if (i.exch_seg !== 'NFO') return false;
      if (!i.instrumenttype?.includes('OPT')) return false;
      const expDate = parseExpiry(i.expiry);
      if (!expDate || expDate < now) return false;
      if (Math.round(parseFloat(i.strike)) !== Math.round(strikeNum * 100)) return false;
      if (!i.symbol?.toUpperCase().endsWith(optType)) return false;
      if (i.name?.toUpperCase() === sym) return true;
      const s = i.symbol.toUpperCase();
      if (s.startsWith(sym) && s.length > sym.length && /\d/.test(s[sym.length])) return true;
      return false;
    });

    if (!matches.length) {
      return res.json({ status: false, message: `No NFO instrument for ${sym} ${strike} ${optType}` });
    }

    // Sort by expiry, pick by config
    const sorted = matches
      .map(i => ({ ...i, _exp: parseExpiry(i.expiry) }))
      .filter(i => i._exp)
      .sort((a, b) => a._exp - b._exp);

    let chosen;
    if (expiry === 'MONTHLY') {
      const curMonth = now.getMonth(), curYear = now.getFullYear();
      const thisMonth = sorted.filter(i => i._exp.getMonth() === curMonth && i._exp.getFullYear() === curYear);
      chosen = thisMonth[thisMonth.length - 1] || sorted[sorted.length - 1];
    } else if (expiry === 'NEXT') {
      chosen = sorted[1] || sorted[0];
    } else {
      chosen = sorted[0];
    }

    if (!chosen) return res.json({ status: false, message: `No valid expiry for ${sym} ${strike} ${optType}` });

    log(`Option-LTP token: ${chosen.symbol} (${chosen.token})`, 'INFO');

    const qResp = await axios.post(
      `${ANGEL_API}/rest/secure/angelbroking/market/v1/quote/`,
      { mode: 'LTP', exchangeTokens: { NFO: [String(chosen.token)] } },
      { headers: getHeaders(true), timeout: 15000 }
    );

    const qData = qResp.data;
    if (qData.status && qData.data?.fetched?.length) {
      const q   = qData.data.fetched[0];
      const ltp = parseFloat(q.ltp || 0) > 0 ? parseFloat(q.ltp) : parseFloat(q.close || 0);
      log(`✅ Option LTP: ${chosen.symbol} = ₹${ltp}`, 'OK');
      return res.json({ status: true, ltp, symbolToken: chosen.token, tradingSymbol: chosen.symbol, expiry: chosen.expiry });
    }

    return res.json({ status: false, message: 'LTP fetch returned no data' });

  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    log(`Option LTP error: ${msg}`, 'WARN');
    res.status(500).json({ status: false, message: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────
// ROUTE: OPTION CHAIN — fetch ATM ± N strikes for a symbol
// Body: { symbol, spotPrice, expiry, depth (default 5) }
// Returns: { status, strikes: [{strike, CE_ltp, PE_ltp, CE_token, PE_token}] }
// ─────────────────────────────────────────────────────────────────────
app.post('/option-chain', async (req, res) => {
  if (!isAuthenticated()) {
    return res.status(401).json({ status: false, message: 'Not authenticated' });
  }

  const { symbol, spotPrice, expiry, depth = 5 } = req.body;
  if (!symbol || !spotPrice) {
    return res.status(400).json({ status: false, message: 'symbol and spotPrice required' });
  }

  try {
    // Ensure instrument master is loaded (cache 4 hours)
    if (!SESSION._instruments || (Date.now() - (SESSION._instrFetchTime||0)) > 4*3600*1000) {
      log('Downloading NFO instrument master...', 'INFO');
      const instrResp = await axios.get(
        'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json',
        { timeout: 30000 }
      );
      SESSION._instruments = instrResp.data;
      SESSION._instrFetchTime = Date.now();
      log(`Instrument master loaded — ${SESSION._instruments.length} instruments`, 'OK');
    }

    const sym = symbol.toUpperCase();
    const spot = parseFloat(spotPrice);
    const now = new Date();

    // ── Parse Angel One expiry — supports multiple date formats ──────
    // Angel master uses: '29MAY2025' | '2025-05-29' | '29-05-2025' | '20250529'
    const MON = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
    function parseExpiry(raw) {
      if (!raw) return null;
      const s = String(raw).trim().toUpperCase();
      // DDMONYYYY e.g. 29MAY2025
      const m1 = s.match(/^(\d{1,2})([A-Z]{3})(\d{4})$/);
      if (m1) {
        const mon = MON[m1[2]];
        if (mon !== undefined) return new Date(+m1[3], mon, +m1[1]);
      }
      // YYYYMMDD e.g. 20250529
      const m2 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
      if (m2) return new Date(+m2[1], +m2[2]-1, +m2[3]);
      // YYYY-MM-DD or DD-MM-YYYY
      const m3 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m3) return new Date(+m3[1], +m3[2]-1, +m3[3]);
      const m4 = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
      if (m4) return new Date(+m4[3], +m4[2]-1, +m4[1]);
      // Last resort: native parse
      const d = new Date(raw);
      return isNaN(d) ? null : d;
    }

    // ── Step 1: Find all NFO options for this underlying ──
    const allOptions = SESSION._instruments.filter(i => {
      if (i.exch_seg !== 'NFO') return false;
      if (!i.instrumenttype || !i.instrumenttype.includes('OPT')) return false;
      // Parse expiry and skip expired
      const expDate = parseExpiry(i.expiry);
      if (!expDate || expDate < now) return false;
      // Match by underlying name OR trading symbol prefix
      if (i.name && i.name.toUpperCase() === sym) return true;
      if (i.symbol) {
        const s = i.symbol.toUpperCase();
        if (s.startsWith(sym) && s.length > sym.length && /\d/.test(s[sym.length])) return true;
      }
      return false;
    });

    if (allOptions.length === 0) {
      log(`No NFO options found for ${sym} (checked ${SESSION._instruments?.length} instruments)`, 'WARN');
      return res.json({ status: false, message: `No NFO options found for ${sym}` });
    }

    log(`Option chain ${sym}: ${allOptions.length} options matched`, 'INFO');

    // ── Step 2: Pick best expiry ──────────────────────────────────────
    // Get unique expiry dates (parsed), sorted ascending
    const uniqueExpiries = [...new Set(allOptions.map(i => i.expiry))]
      .map(raw => ({ raw, date: parseExpiry(raw) }))
      .filter(e => e.date && e.date >= now)
      .sort((a, b) => a.date - b.date);

    if (!uniqueExpiries.length) {
      return res.json({ status: false, message: `No valid future expiries for ${sym}` });
    }

    let chosenExpiry;
    if (expiry === 'MONTHLY') {
      const curMonth = now.getMonth(), curYear = now.getFullYear();
      const thisMonth = uniqueExpiries.filter(e => e.date.getMonth() === curMonth && e.date.getFullYear() === curYear);
      chosenExpiry = thisMonth.length
        ? thisMonth[thisMonth.length - 1]
        : uniqueExpiries[0];
    } else if (expiry === 'NEXT_MONTH') {
      // Stock near expiry — use next calendar month's last expiry
      const nextM = (now.getMonth() + 1) % 12;
      const nextY  = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
      const nextMonth = uniqueExpiries.filter(e => e.date.getMonth() === nextM && e.date.getFullYear() === nextY);
      chosenExpiry = nextMonth.length ? nextMonth[nextMonth.length - 1] : (uniqueExpiries[1] || uniqueExpiries[0]);
    } else if (expiry === 'NEXT') {
      chosenExpiry = uniqueExpiries[1] || uniqueExpiries[0];
    } else {
      chosenExpiry = uniqueExpiries[0]; // WEEKLY = nearest Tuesday
    }

    const chosenExpiryRaw = chosenExpiry.raw; // use raw string for exact match

    // ── Step 3: Filter to chosen expiry ──────────────────────────────
    const expiryOptions = allOptions.filter(i => i.expiry === chosenExpiryRaw);

    // ── Step 4: Get all available strikes (Angel stores strike × 100) ─
    const allStrikes = [...new Set(
      expiryOptions.map(i => Math.round(parseFloat(i.strike) / 100))
    )].filter(s => s > 0).sort((a, b) => a - b);

    if (allStrikes.length === 0) {
      return res.json({ status: false, message: `No strikes found for ${sym} expiry ${chosenExpiryRaw}` });
    }

    // ── Step 5: Real ATM = closest available strike to spot ───────────
    const realAtm = allStrikes.reduce((best, s) =>
      Math.abs(s - spot) < Math.abs(best - spot) ? s : best
    , allStrikes[0]);

    // ── Step 6: ATM ± depth strikes ───────────────────────────────────
    const atmIdx   = allStrikes.indexOf(realAtm);
    const startIdx = Math.max(0, atmIdx - depth);
    const endIdx   = Math.min(allStrikes.length - 1, atmIdx + depth);
    const strikeList = allStrikes.slice(startIdx, endIdx + 1);

    // ── Step 7: Collect CE + PE tokens for each strike ─────────────
    const tokens   = [];
    const strikeMap = {};

    for (const strike of strikeList) {
      const strikeVal = Math.round(strike * 100); // Angel format

      const ces = expiryOptions.filter(i =>
        Math.round(parseFloat(i.strike)) === strikeVal &&
        i.symbol?.toUpperCase().endsWith('CE')
      );
      const pes = expiryOptions.filter(i =>
        Math.round(parseFloat(i.strike)) === strikeVal &&
        i.symbol?.toUpperCase().endsWith('PE')
      );

      const ce = ces[0], pe = pes[0];
      strikeMap[strike] = {
        CE_token: ce?.token ?? null,
        PE_token: pe?.token ?? null,
        CE_sym:   ce?.symbol ?? null,
        PE_sym:   pe?.symbol ?? null,
      };
      if (ce?.token) tokens.push(String(ce.token));
      if (pe?.token) tokens.push(String(pe.token));
    }

    log(`Option chain ${sym}: expiry=${chosenExpiryRaw}, ATM=${realAtm}, strikes=${strikeList.length}, tokens=${tokens.length}`, 'INFO');

    if (tokens.length === 0) {
      return res.json({ status: false, message: `No tokens found for ${sym} — check instrument name matching` });
    }

    // ── Step 8: Batch LTP fetch (NFO exchange) ────────────────────────
    const ltpMap = {};
    const BATCH = 50;
    for (let i = 0; i < tokens.length; i += BATCH) {
      const batch = tokens.slice(i, i + BATCH);
      try {
        const qResp = await axios.post(
          `${ANGEL_API}/rest/secure/angelbroking/market/v1/quote/`,
          { mode: 'LTP', exchangeTokens: { NFO: batch } },
          { headers: getHeaders(true), timeout: 20000 }
        );
        if (qResp.data.status && qResp.data.data?.fetched) {
          qResp.data.data.fetched.forEach(q => {
            const ltp   = parseFloat(q.ltp  || 0);
            const close = parseFloat(q.close || 0);
            if (ltp > 0) { ltpMap[String(q.symbolToken)] = ltp; } else { const close = parseFloat(q.close || 0); if (close > 0) ltpMap[String(q.symbolToken)] = close; }
          });
        }
      } catch(e) {
        log(`LTP batch failed: ${e.message}`, 'WARN');
      }
    }

    // ── Step 9: Build result ──────────────────────────────────────────
    const result = strikeList.map(strike => {
      const m = strikeMap[strike];
      return {
        strike,
        isATM:    strike === realAtm,
        CE_ltp:   m.CE_token ? (ltpMap[String(m.CE_token)] ?? null) : null,
        PE_ltp:   m.PE_token ? (ltpMap[String(m.PE_token)] ?? null) : null,
        CE_token: m.CE_token,
        PE_token: m.PE_token,
        CE_sym:   m.CE_sym,
        PE_sym:   m.PE_sym,
      };
    });

    log(`✅ ${sym}: ATM=${realAtm}, ltps=${Object.keys(ltpMap).length}/${tokens.length} fetched`, 'OK');
    return res.json({
      status: true, symbol: sym, spotPrice: spot,
      atmStrike: realAtm, expiry: chosenExpiryRaw, strikes: result,
    });

  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    log(`Option chain error ${symbol}: ${msg}`, 'WARN');
    res.status(500).json({ status: false, message: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────
// ROUTE: REFRESH TOKEN
// ─────────────────────────────────────────────────────────────────────
app.post('/refresh', async (req, res) => {
  if (!SESSION.refreshToken) {
    return res.json({ status: false, message: 'No refresh token available' });
  }

  try {
    const response = await axios.post(
      `${ANGEL_API}/rest/secure/angelbroking/jwt/v1/generateTokens`,
      { refreshToken: SESSION.refreshToken },
      { headers: getHeaders(true), timeout: 15000 }
    );

    if (response.data.status === true && response.data.data) {
      SESSION.jwtToken = response.data.data.jwtToken;
      SESSION.refreshToken = response.data.data.refreshToken;
      SESSION.expiresAt = Date.now() + (8 * 60 * 60 * 1000);
      log('Token refreshed', 'OK');
      return res.json({ status: true, message: 'Token refreshed' });
    }

    res.json({ status: false, message: 'Token refresh failed' });
  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    res.status(500).json({ status: false, message: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────
// AUTO TOKEN REFRESH (every 7 hours)
// ─────────────────────────────────────────────────────────────────────
setInterval(async () => {
  if (!SESSION.refreshToken || !SESSION.jwtToken) return;

  const hoursLeft = (SESSION.expiresAt - Date.now()) / 3600000;

  if (hoursLeft > 0 && hoursLeft < 1) {
    log('Auto-refreshing JWT token...', 'INFO');
    try {
      const response = await axios.post(
        `${ANGEL_API}/rest/secure/angelbroking/jwt/v1/generateTokens`,
        { refreshToken: SESSION.refreshToken },
        { headers: getHeaders(true), timeout: 15000 }
      );

      if (response.data.status === true && response.data.data) {
        SESSION.jwtToken = response.data.data.jwtToken;
        SESSION.refreshToken = response.data.data.refreshToken;
        SESSION.expiresAt = Date.now() + (8 * 60 * 60 * 1000);
        log('Token auto-refreshed ✅', 'OK');
      }
    } catch (err) {
      log(`Auto-refresh failed: ${err.message}`, 'ERR');
    }
  }
}, 30 * 60 * 1000); // Check every 30 minutes

// ─────────────────────────────────────────────────────────────────────
// ROUTE: NEWS SENTIMENT — for internal scanner scoring (not displayed)
// Fetches headlines from free RSS feeds and scores market sentiment
// ─────────────────────────────────────────────────────────────────────
let NEWS_CACHE = { data: null, fetchTime: 0 };

app.get('/news-sentiment', async (req, res) => {
  // Cache for 5 minutes
  if (NEWS_CACHE.data && (Date.now() - NEWS_CACHE.fetchTime) < 5 * 60 * 1000) {
    return res.json(NEWS_CACHE.data);
  }

  try {
    // Fetch from multiple free RSS sources
    const feeds = [
      'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',
      'https://www.moneycontrol.com/rss/marketsindia.xml',
      'https://feeds.feedburner.com/ndtvprofit-latest',
    ];

    const results = await Promise.allSettled(
      feeds.map(url => axios.get(url, { timeout: 5000, responseType: 'text' }))
    );

    // Extract headlines from XML
    const headlines = [];
    results.forEach(r => {
      if (r.status === 'fulfilled') {
        const matches = r.value.data.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/g) || [];
        matches.slice(1, 15).forEach(m => {
          const text = m.replace(/<[^>]+>/g, '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
          if (text.length > 10) headlines.push(text);
        });
      }
    });

    // Keyword-based sentiment scoring
    const BULLISH_WORDS = [
      'surge', 'rally', 'gain', 'rise', 'record', 'high', 'strong', 'growth',
      'profit', 'beat', 'positive', 'boost', 'upgrade', 'buy', 'bull', 'recovery',
      'jump', 'soar', 'outperform', 'breakout', 'upside', 'optimism', 'inflow',
      'fii buying', 'dii buying', 'rate cut', 'gdp growth', 'export rise',
      'earnings beat', 'dividend', 'buyback', 'expansion', 'order win',
    ];
    const BEARISH_WORDS = [
      'fall', 'drop', 'crash', 'decline', 'loss', 'weak', 'sell', 'bear',
      'down', 'cut', 'risk', 'war', 'tension', 'crisis', 'inflation', 'recession',
      'sanction', 'tariff', 'geopolit', 'slump', 'outflow', 'fii selling',
      'rate hike', 'default', 'bankruptcy', 'miss', 'downgrade', 'concern',
      'slowdown', 'contraction', 'profit warning', 'layoff', 'strike', 'ban',
    ];
    const GEO_WORDS = [
      'war', 'conflict', 'sanction', 'tariff', 'geopolit', 'tension', 'attack',
      'israel', 'iran', 'ukraine', 'russia', 'china', 'taiwan', 'missile',
      'oil price', 'crude', 'middle east', 'pakistan', 'border', 'ceasefire',
      'nato', 'nuclear', 'terror', 'airstrike', 'trade war', 'us tariff',
      'trump tariff', 'embargo', 'blockade', 'escalation',
    ];

    let bullScore = 0, bearScore = 0, geoRisk = 0;
    headlines.forEach(h => {
      const lower = h.toLowerCase();
      BULLISH_WORDS.forEach(w => { if (lower.includes(w)) bullScore++; });
      BEARISH_WORDS.forEach(w => { if (lower.includes(w)) bearScore++; });
      GEO_WORDS.forEach(w => { if (lower.includes(w)) geoRisk++; });
    });

    const total = bullScore + bearScore || 1;
    const sentiment = bullScore > bearScore ? 'BULLISH' : bearScore > bullScore ? 'BEARISH' : 'NEUTRAL';
    const sentimentScore = Math.round((bullScore / total) * 100); // 0–100, >50 = bullish

    const result = {
      status: true,
      sentiment,
      sentimentScore,    // >60 = bullish, <40 = bearish
      geoRisk,           // higher = more geopolitical risk
      bullScore,
      bearScore,
      headlineCount: headlines.length,
      topHeadlines: headlines.slice(0, 5),
      fetchTime: new Date().toLocaleTimeString('en-IN'),
    };

    NEWS_CACHE = { data: result, fetchTime: Date.now() };
    log(`News: ${sentiment} (${sentimentScore}%) · GeoRisk: ${geoRisk}`, 'INFO');
    res.json(result);
  } catch (e) {
    res.json({ status: false, message: e.message, sentiment: 'NEUTRAL', sentimentScore: 50, geoRisk: 0 });
  }
});

// ─────────────────────────────────────────────────────────────────────
// ROUTE: MCX COMMODITIES — Live prices via Angel One
// MCX tokens: GOLD=MCX, SILVER=MCX, CRUDEOIL=MCX etc
// ─────────────────────────────────────────────────────────────────────
// Known MCX commodity names to search in instrument master
const MCX_SYMBOLS = ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'COPPER', 'ALUMINIUM', 'ZINC', 'LEAD', 'NICKEL'];

async function getMCXTokens() {
  // Load instrument master if not already loaded
  if (!SESSION._instruments || (Date.now() - (SESSION._instrFetchTime||0)) > 4*3600*1000) {
    try {
      log('Downloading instrument master for MCX tokens...', 'INFO');
      const r = await axios.get('https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json', { timeout: 30000 });
      SESSION._instruments = r.data;
      SESSION._instrFetchTime = Date.now();
    } catch(e) {
      log('Instrument master download failed: ' + e.message, 'WARN');
      return {};
    }
  }
  const now = new Date();
  const MON_MCX = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
  function parseMcxExp(raw) {
    if (!raw) return null;
    const s = String(raw).trim().toUpperCase();
    const m1 = s.match(/^(\d{1,2})([A-Z]{3})(\d{4})$/);
    if (m1) { const mon = MON_MCX[m1[2]]; if (mon !== undefined) return new Date(+m1[3], mon, +m1[1]); }
    const m2 = s.match(/^(\d{4})(\d{2})(\d{2})$/); if (m2) return new Date(+m2[1], +m2[2]-1, +m2[3]);
    const m3 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (m3) return new Date(+m3[1], +m3[2]-1, +m3[3]);
    const d = new Date(raw); return isNaN(d) ? null : d;
  }
  const tokens = {};
  for (const sym of MCX_SYMBOLS) {
    const matches = SESSION._instruments.filter(i => {
      if (i.exch_seg !== 'MCX') return false;
      if (!i.name || i.name.toUpperCase() !== sym) return false;
      if (i.instrumenttype !== 'FUTCOM') return false;
      const d = parseMcxExp(i.expiry);
      return d && d >= now;
    }).sort((a, b) => parseMcxExp(a.expiry) - parseMcxExp(b.expiry));
    if (matches.length > 0) {
      tokens[sym] = matches[0].token;
      log(`MCX ${sym}: token ${matches[0].token} exp ${matches[0].expiry}`, 'INFO');
    }
  }
  return tokens;
}

app.get('/mcx', async (req, res) => {
  if (!isAuthenticated()) {
    return res.status(401).json({ status: false, message: 'Not authenticated' });
  }
  try {
    const MCX_TOKENS = await getMCXTokens();
    const tokens = Object.values(MCX_TOKENS);
    if (!tokens.length) {
      return res.json({ status: false, message: 'Could not resolve MCX tokens from instrument master' });
    }
    const response = await axios.post(
      `${ANGEL_API}/rest/secure/angelbroking/market/v1/quote/`,
      { mode: 'FULL', exchangeTokens: { MCX: tokens } },
      { headers: getHeaders(true), timeout: 15000 }
    );
    const d = response.data;
    if (d.status && d.data?.fetched) {
      const result = {};
      d.data.fetched.forEach(q => {
        const sym = Object.keys(MCX_TOKENS).find(k => String(MCX_TOKENS[k]) === String(q.symbolToken));
        if (sym) {
          const ltp   = parseFloat(q.ltp   || 0);
          const close = parseFloat(q.close || 0);
          result[sym] = {
            ltp,
            open:       parseFloat(q.open || 0),
            high:       parseFloat(q.high || 0),
            low:        parseFloat(q.low  || 0),
            close,
            change:     ltp - close,
            changePct:  close > 0 ? (((ltp - close) / close) * 100).toFixed(2) : '0.00',
            tradingSymbol: q.tradingSymbol || sym,
          };
        }
      });
      return res.json({ status: true, data: result });
    }
    res.json({ status: false, message: d.message || 'No MCX data returned' });
  } catch (e) {
    const msg = e.response?.data?.message || e.message;
    res.status(500).json({ status: false, message: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║   NSE F&O Signal Engine — Angel One SmartAPI Proxy v3.0      ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║   Server  : http://localhost:${PORT}                                  ║`);
  console.log('║   New     : /india-vix  /oi-analysis  (v3 additions)         ║');
  console.log('║   Updated : /market-bias  /signal-analysis  (MACD+ST+ATR)   ║');
  console.log('║   Status  : Ready for login requests                         ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  log('Listening for connections...', 'OK');
});
