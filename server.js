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
// Restrict CORS to known origins (not wildcard in production)
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,
  'http://localhost:3001',
  'http://localhost:3000',
].filter(Boolean);
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.length === 0),
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// Rate-limit login endpoint — max 10 attempts per 15 minutes
const loginLimiter = {
  _store: new Map(),
  check(ip) {
    const now = Date.now();
    const entry = this._store.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
    if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 15 * 60 * 1000; }
    entry.count++;
    this._store.set(ip, entry);
    return entry.count <= 10;
  },
};

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

// Parse real expiry from JWT payload instead of hardcoding 8h
function getJWTExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    return payload.exp ? payload.exp * 1000 : Date.now() + 8 * 3600000;
  } catch { return Date.now() + 8 * 3600000; }
}

// Instrument master with error recovery — shared across all routes
async function ensureInstruments() {
  if (SESSION._instruments && (Date.now() - (SESSION._instrFetchTime || 0)) < 4 * 3600 * 1000) {
    return SESSION._instruments;
  }
  if (SESSION._instrFetchFailed && Date.now() - (SESSION._instrFailTime || 0) < 5 * 60 * 1000) {
    throw new Error('Instrument master unavailable — retry in 5 minutes');
  }
  try {
    log('Downloading instrument master...', 'INFO');
    const resp = await axios.get(
      'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json',
      { timeout: 30000 }
    );
    SESSION._instruments = resp.data;
    SESSION._instrFetchTime = Date.now();
    SESSION._instrFetchFailed = false;
    log(`Instrument master loaded — ${SESSION._instruments.length} instruments`, 'OK');
    return SESSION._instruments;
  } catch (err) {
    SESSION._instrFetchFailed = true;
    SESSION._instrFailTime = Date.now();
    log(`Instrument master fetch failed: ${err.message}`, 'ERR');
    throw err;
  }
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
// ROUTE: HEALTH CHECK
// ─────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    authenticated: isAuthenticated(),
    client: SESSION.clientCode || null,
    tokenExpiry: SESSION.expiresAt ? new Date(SESSION.expiresAt).toLocaleTimeString('en-IN') : null,
  });
});

// ─────────────────────────────────────────────────────────────────────
// ROUTE: LOGIN
// ─────────────────────────────────────────────────────────────────────
app.post('/login', async (req, res) => {
  // Rate limit by IP
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  if (!loginLimiter.check(ip)) {
    return res.status(429).json({ status: false, message: 'Too many login attempts — wait 15 minutes' });
  }

  // Return existing session if still valid
  if (isAuthenticated()) {
    return res.json({ status: true, message: 'Already authenticated', client: SESSION.clientCode,
      tokenExpiry: new Date(SESSION.expiresAt).toLocaleTimeString('en-IN') });
  }

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
      SESSION.expiresAt = getJWTExpiry(data.data.jwtToken); // real JWT expiry

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
    const response = await axios.post(
      `${ANGEL_API}/rest/secure/angelbroking/market/v1/quote/`,
      req.body,
      { headers: getHeaders(true), timeout: 15000 }
    );
    res.json(response.data);
  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    log(`Quote error: ${msg}`, 'WARN');
    res.status(500).json({ status: false, message: msg });
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
    const response = await axios.post(
      `${ANGEL_API}/rest/secure/angelbroking/historical/v1/getCandleData`,
      req.body,
      { headers: getHeaders(true), timeout: 20000 }
    );
    res.json(response.data);
  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    res.status(500).json({ status: false, message: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────
// ROUTE: MARKET BIAS — EMA20/50 + PDH/PDL via candle data
// Returns: { bias:'BULLISH'|'BEARISH'|'NEUTRAL', ema20, ema50, pdh, pdl, orb_high, orb_low }
// ─────────────────────────────────────────────────────────────────────
app.post('/market-bias', async (req, res) => {
  if (!isAuthenticated()) return res.status(401).json({ status: false, message: 'Not authenticated' });

  const { symbolToken, exchange = 'NSE' } = req.body;
  if (!symbolToken) return res.status(400).json({ status: false, message: 'symbolToken required' });

  try {
    const now   = new Date();
    const ist   = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const today = ist.toISOString().slice(0, 10);

    // Get previous trading day
    const prev = new Date(ist);
    prev.setDate(prev.getDate() - (prev.getDay() === 1 ? 3 : prev.getDay() === 0 ? 2 : 1));
    const prevDay = prev.toISOString().slice(0, 10);

    // Fetch 15m candles for last 5 days (sufficient for EMA50 with 26 candles/day)
    const fromDate = new Date(ist);
    fromDate.setDate(fromDate.getDate() - 5);
    const from = fromDate.toISOString().slice(0, 10) + ' 09:15';
    const to   = today + ' 15:30';

    const candleResp = await axios.post(
      `${ANGEL_API}/rest/secure/angelbroking/historical/v1/getCandleData`,
      { exchange, symboltoken: symbolToken, interval: 'FIFTEEN_MINUTE', fromdate: from, todate: to },
      { headers: getHeaders(true), timeout: 20000 }
    );

    const raw = candleResp.data?.data || [];
    if (raw.length < 10) return res.json({ status: false, message: 'Insufficient candle data' });

    // raw format: [datetime, open, high, low, close, volume]
    const closes = raw.map(c => parseFloat(c[4]));
    const highs  = raw.map(c => parseFloat(c[2]));
    const lows   = raw.map(c => parseFloat(c[3]));
    const vols   = raw.map(c => parseFloat(c[5]));
    const dates  = raw.map(c => c[0].slice(0, 10));

    // EMA calculation
    function ema(data, period) {
      const k = 2 / (period + 1);
      let e = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
      for (let i = period; i < data.length; i++) e = data[i] * k + e * (1 - k);
      return parseFloat(e.toFixed(2));
    }

    const ema20 = closes.length >= 20 ? ema(closes, 20) : null;
    const ema50 = closes.length >= 50 ? ema(closes, 50) : null;
    const ltp   = closes[closes.length - 1];

    // Market bias from EMA structure
    let bias = 'NEUTRAL';
    if (ema20 && ema50) {
      if (ltp > ema20 && ema20 > ema50) bias = 'BULLISH';
      else if (ltp < ema20 && ema20 < ema50) bias = 'BEARISH';
    } else if (ema20) {
      bias = ltp > ema20 ? 'BULLISH' : 'BEARISH';
    }

    // PDH/PDL (Previous Day High/Low)
    const prevCandles = raw.filter(c => c[0].slice(0,10) === prevDay);
    const pdh = prevCandles.length ? Math.max(...prevCandles.map(c => parseFloat(c[2]))) : null;
    const pdl = prevCandles.length ? Math.min(...prevCandles.map(c => parseFloat(c[3]))) : null;

    // ORB (Opening Range Breakout) — first 30 min of today, sorted by time
    const todayCandles = raw
      .filter(c => c[0].slice(0,10) === today)
      .sort((a, b) => a[0].localeCompare(b[0])); // ensure chronological order
    const orbCandles = todayCandles.slice(0, 2); // first 2 x 15m = 30 min
    const orb_high = orbCandles.length ? Math.max(...orbCandles.map(c => parseFloat(c[2]))) : null;
    const orb_low  = orbCandles.length ? Math.min(...orbCandles.map(c => parseFloat(c[3]))) : null;

    // Avg volume (last 5 days vs today)
    const todayVol = todayCandles.reduce((s, c) => s + parseFloat(c[5]), 0);
    const avgDayVol = vols.reduce((a, b) => a + b, 0) / Math.max(vols.length, 1) * (todayCandles.length || 1);
    const volRatio  = avgDayVol > 0 ? parseFloat((todayVol / avgDayVol).toFixed(2)) : 1;

    // RSI (14 period on closes)
    function rsi14(closes) {
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

    const rsi = rsi14(closes.slice(-50)); // anchor RSI to recent 50 candles

    // VWAP (today)
    let vwapNum = 0, vwapDen = 0;
    todayCandles.forEach(c => {
      const tp  = (parseFloat(c[2]) + parseFloat(c[3]) + parseFloat(c[4])) / 3;
      const vol = parseFloat(c[5]);
      vwapNum += tp * vol;
      vwapDen += vol;
    });
    const vwap = vwapDen > 0 ? parseFloat((vwapNum / vwapDen).toFixed(2)) : null;
    const aboveVwap = vwap ? ltp > vwap : null;

    res.json({
      status: true, bias, ltp, ema20, ema50, rsi, vwap, aboveVwap,
      pdh, pdl, orb_high, orb_low, volRatio,
      candleCount: raw.length
    });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    log(`market-bias error: ${msg}`, 'WARN');
    res.status(500).json({ status: false, message: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────
// ROUTE: FII/DII DATA — institutional flow from NSE (public API)
// Returns: { fiiBuy, fiiSell, fiiNet, diiBuy, diiSell, diiNet, date }
// ─────────────────────────────────────────────────────────────────────
const FII_DII_CACHE = { data: null, fetchTime: 0 };

app.get('/fii-dii', async (req, res) => {
  if (!isAuthenticated()) return res.status(401).json({ status: false, message: 'Not authenticated' });

  // Cache 30 minutes
  if (FII_DII_CACHE.data && (Date.now() - FII_DII_CACHE.fetchTime) < 30 * 60 * 1000) {
    return res.json(FII_DII_CACHE.data);
  }

  try {
    // NSE FII/DII activity — public endpoint
    const r = await axios.get(
      'https://www.nseindia.com/api/fiidiiTradeReact',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.nseindia.com/',
        },
        timeout: 10000
      }
    );

    const raw  = r.data || [];
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
    // FII/DII is non-critical — return neutral if unavailable
    const fallback = { status: true, fiiNet: 0, diiNet: 0, instBias: 'NEUTRAL', message: 'FII/DII unavailable — using NEUTRAL' };
    res.json(fallback);
  }
});

// ─────────────────────────────────────────────────────────────────────
// SHARED LOGIC — called by both route handlers and /signal-analysis
// Avoids localhost self-calls that fail in containerised deployments
// ─────────────────────────────────────────────────────────────────────
async function fetchMarketBiasData(symbolToken, exchange = 'NSE') {
  const now   = new Date();
  const ist   = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const today = ist.toISOString().slice(0, 10);
  const prev  = new Date(ist);
  prev.setDate(prev.getDate() - (prev.getDay() === 1 ? 3 : prev.getDay() === 0 ? 2 : 1));
  const prevDay = prev.toISOString().slice(0, 10);
  const fromDate = new Date(ist);
  fromDate.setDate(fromDate.getDate() - 5);
  const from = fromDate.toISOString().slice(0, 10) + ' 09:15';
  const to   = today + ' 15:30';
  const candleResp = await axios.post(
    `${ANGEL_API}/rest/secure/angelbroking/historical/v1/getCandleData`,
    { exchange, symboltoken: symbolToken, interval: 'FIFTEEN_MINUTE', fromdate: from, todate: to },
    { headers: getHeaders(true), timeout: 20000 }
  );
  const raw = candleResp.data?.data || [];
  if (raw.length < 10) return { status: false, message: 'Insufficient candle data' };
  const closes = raw.map(c => parseFloat(c[4]));
  const ltp    = closes[closes.length - 1];
  function ema(data, period) {
    const k = 2 / (period + 1);
    let e = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < data.length; i++) e = data[i] * k + e * (1 - k);
    return parseFloat(e.toFixed(2));
  }
  const ema20 = closes.length >= 20 ? ema(closes, 20) : null;
  const ema50 = closes.length >= 50 ? ema(closes, 50) : null;
  let bias = 'NEUTRAL';
  if (ema20 && ema50) {
    if (ltp > ema20 && ema20 > ema50) bias = 'BULLISH';
    else if (ltp < ema20 && ema20 < ema50) bias = 'BEARISH';
  } else if (ema20) {
    bias = ltp > ema20 ? 'BULLISH' : 'BEARISH';
  }
  const prevCandles = raw.filter(c => c[0].slice(0,10) === prevDay);
  const todayCandles = raw.filter(c => c[0].slice(0,10) === today).sort((a,b) => a[0].localeCompare(b[0]));
  const pdh = prevCandles.length ? Math.max(...prevCandles.map(c => parseFloat(c[2]))) : null;
  const pdl = prevCandles.length ? Math.min(...prevCandles.map(c => parseFloat(c[3]))) : null;
  const orbCandles = todayCandles.slice(0, 2);
  const orb_high = orbCandles.length ? Math.max(...orbCandles.map(c => parseFloat(c[2]))) : null;
  const orb_low  = orbCandles.length ? Math.min(...orbCandles.map(c => parseFloat(c[3]))) : null;
  const vols = raw.map(c => parseFloat(c[5]));
  const todayVol = todayCandles.reduce((s,c) => s + parseFloat(c[5]), 0);
  const avgDayVol = vols.reduce((a,b) => a+b, 0) / Math.max(vols.length,1) * (todayCandles.length || 1);
  const volRatio = avgDayVol > 0 ? parseFloat((todayVol / avgDayVol).toFixed(2)) : 1;
  const rsiCloses = closes.slice(-50);
  let gains = 0, losses = 0;
  for (let i = 1; i <= 14; i++) { const d = rsiCloses[i]-rsiCloses[i-1]; if(d>0) gains+=d; else losses-=d; }
  let ag=gains/14, al=losses/14;
  for (let i=15; i<rsiCloses.length; i++) { const d=rsiCloses[i]-rsiCloses[i-1]; ag=(ag*13+Math.max(d,0))/14; al=(al*13+Math.max(-d,0))/14; }
  const rsi = al===0 ? 100 : parseFloat((100-100/(1+ag/al)).toFixed(2));
  let vwapNum=0, vwapDen=0;
  todayCandles.forEach(c => { const tp=(parseFloat(c[2])+parseFloat(c[3])+parseFloat(c[4]))/3; const vol=parseFloat(c[5]); vwapNum+=tp*vol; vwapDen+=vol; });
  const vwap = vwapDen > 0 ? parseFloat((vwapNum/vwapDen).toFixed(2)) : null;
  return { status: true, bias, ltp, ema20, ema50, rsi, vwap, aboveVwap: vwap ? ltp>vwap : null, pdh, pdl, orb_high, orb_low, volRatio, candleCount: raw.length };
}

async function fetchFiiDiiData() {
  if (FII_DII_CACHE.data && (Date.now() - FII_DII_CACHE.fetchTime) < 30 * 60 * 1000) {
    return FII_DII_CACHE.data;
  }
  try {
    const r = await axios.get('https://www.nseindia.com/api/fiidiiTradeReact', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json', 'Referer': 'https://www.nseindia.com/' },
      timeout: 10000
    });
    const raw = r.data || [];
    const today = raw.find(d => d.category === 'FII/FPI *') || raw[0];
    const dii   = raw.find(d => d.category === 'DII') || raw[1];
    const result = {
      status: true,
      fiiNet: parseFloat(today?.netValue || 0),
      diiNet: parseFloat(dii?.netValue   || 0),
      fiiBuy: parseFloat(today?.buyValue || 0), fiiSell: parseFloat(today?.sellValue || 0),
      diiBuy: parseFloat(dii?.buyValue   || 0), diiSell: parseFloat(dii?.sellValue   || 0),
    };
    result.instBias = result.fiiNet > 500 ? 'BULLISH' : result.fiiNet < -500 ? 'BEARISH' : result.diiNet > 500 ? 'BULLISH' : result.diiNet < -500 ? 'BEARISH' : 'NEUTRAL';
    FII_DII_CACHE.data = result;
    FII_DII_CACHE.fetchTime = Date.now();
    return result;
  } catch { return { status: true, fiiNet: 0, diiNet: 0, instBias: 'NEUTRAL' }; }
}

// ─────────────────────────────────────────────────────────────────────
// ROUTE: FULL SIGNAL ANALYSIS — comprehensive RA-style check
// Body: { symbolToken, sym, exchange, isIndex, spotPrice, type }
// Returns all signal conditions + final verdict
// ─────────────────────────────────────────────────────────────────────
app.post('/signal-analysis', async (req, res) => {
  if (!isAuthenticated()) return res.status(401).json({ status: false, message: 'Not authenticated' });

  const { symbolToken, sym, exchange = 'NSE', isIndex = false, spotPrice, type } = req.body;

  try {
    // Call shared logic functions directly — avoids localhost self-calls that fail in containers
    const [biasResult, fiiResult] = await Promise.allSettled([
      fetchMarketBiasData(symbolToken, exchange),
      fetchFiiDiiData(),
    ]);

    const bias = biasResult.status === 'fulfilled' ? biasResult.value : { status: false };
    const fii  = fiiResult.status  === 'fulfilled' ? fiiResult.value  : { instBias: 'NEUTRAL' };

    const result = {
      status: true,
      sym, type,
      // Market bias
      bias:        bias.bias        || 'NEUTRAL',
      ema20:       bias.ema20       || null,
      ema50:       bias.ema50       || null,
      rsi:         bias.rsi         || 50,
      vwap:        bias.vwap        || null,
      aboveVwap:   bias.aboveVwap   ?? null,
      pdh:         bias.pdh         || null,
      pdl:         bias.pdl         || null,
      orb_high:    bias.orb_high    || null,
      orb_low:     bias.orb_low     || null,
      volRatio:    bias.volRatio    || 1,
      ltp:         bias.ltp         || spotPrice,
      // Institutional flow
      instBias:    fii.instBias     || 'NEUTRAL',
      fiiNet:      fii.fiiNet       || 0,
      diiNet:      fii.diiNet       || 0,
    };

    // Signal alignment checks
    const checks = {};
    if (type === 'CE') {
      checks.marketBias   = result.bias === 'BULLISH' || result.bias === 'NEUTRAL';
      checks.rsiOversold  = result.rsi < 45;
      checks.aboveVwap    = result.aboveVwap !== false;
      checks.instFlow     = result.instBias !== 'BEARISH';
      checks.notAtResist  = result.pdh ? result.ltp < result.pdh * 1.005 : true;
      checks.orbBreakout  = result.orb_high ? result.ltp > result.orb_high : null;
    } else {
      checks.marketBias   = result.bias === 'BEARISH' || result.bias === 'NEUTRAL';
      checks.rsiOverbought= result.rsi > 55;
      checks.belowVwap    = result.aboveVwap !== true;
      checks.instFlow     = result.instBias !== 'BULLISH';
      checks.notAtSupport = result.pdl ? result.ltp > result.pdl * 0.995 : true;
      checks.orbBreakdown = result.orb_low ? result.ltp < result.orb_low : null;
    }
    checks.volumeConfirm = result.volRatio >= 1.2;

    result.checks = checks;
    result.passCount = Object.values(checks).filter(v => v === true).length;
    result.totalChecks = Object.values(checks).filter(v => v !== null).length;
    result.alignmentScore = result.totalChecks > 0
      ? Math.round(result.passCount / result.totalChecks * 100) : 50;

    res.json(result);
  } catch (err) {
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
    // ── Step 1: Download Angel One NFO instrument master (cached in memory) ──
    const instruments = await ensureInstruments();

    // ── Step 2: Find matching NFO option token ──
    // Angel One trading symbol format: NIFTY24JUL24300CE or RELIANCE24JUL1280CE
    // We search by name + strike + optiontype + expiry match

    const sym = symbol.toUpperCase();
    const optType = type.toUpperCase(); // CE or PE
    const strikeNum = parseFloat(strike);

    // Build expiry pattern based on requested expiry type
    // expiry param: 'WEEKLY' | 'NEXT' | 'MONTHLY'
    const now = new Date();
    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

    // Find all matching NFO options for this symbol + strike + type
    const matches = instruments.filter(i => {
      if (i.exch_seg !== 'NFO') return false;
      if (!i.name || i.name.toUpperCase() !== sym) return false;
      if (!i.instrumenttype || !i.instrumenttype.includes('OPT')) return false;
      if (parseFloat(i.strike) !== strikeNum * 100) return false; // Angel stores strike*100
      if (!i.symbol || !i.symbol.toUpperCase().endsWith(optType)) return false;
      return true;
    });

    if (matches.length === 0) {
      return res.json({ status: false, message: `No NFO instrument found for ${sym} ${strike} ${optType}` });
    }

    // Pick the expiry closest to config
    const sortedMatches = matches.sort((a, b) => {
      const da = new Date(a.expiry);
      const db = new Date(b.expiry);
      return da - db;
    });

    let chosen;
    if (expiry === 'MONTHLY') {
      // Pick last expiry of the month
      const thisMonth = now.getMonth();
      const monthlyMatches = sortedMatches.filter(i => {
        const d = new Date(i.expiry);
        return d.getMonth() === thisMonth && d >= now;
      });
      chosen = monthlyMatches[monthlyMatches.length - 1] || sortedMatches[0];
    } else if (expiry === 'NEXT') {
      // Skip first expiry, pick second
      const futureMatches = sortedMatches.filter(i => new Date(i.expiry) >= now);
      chosen = futureMatches[1] || futureMatches[0] || sortedMatches[0];
    } else {
      // WEEKLY — pick nearest future expiry
      const futureMatches = sortedMatches.filter(i => new Date(i.expiry) >= now);
      chosen = futureMatches[0] || sortedMatches[0];
    }

    if (!chosen) {
      return res.json({ status: false, message: `No valid expiry found for ${sym} ${strike} ${optType}` });
    }

    log(`Option token: ${chosen.symbol} (token ${chosen.token})`, 'INFO');

    // ── Step 3: Fetch live LTP for this option token via NFO quote ──
    const quoteResp = await axios.post(
      `${ANGEL_API}/rest/secure/angelbroking/market/v1/quote/`,
      { mode: 'LTP', exchangeTokens: { NFO: [chosen.token] } },
      { headers: getHeaders(true), timeout: 15000 }
    );

    const qData = quoteResp.data;
    if (qData.status && qData.data && qData.data.fetched && qData.data.fetched.length > 0) {
      const q = qData.data.fetched[0];
      const ltp = parseFloat(q.ltp || q.close || 0);
      log(`✅ Option LTP: ${chosen.symbol} = ₹${ltp}`, 'OK');
      return res.json({
        status: true,
        ltp,
        symbolToken: chosen.token,
        tradingSymbol: chosen.symbol,
        expiry: chosen.expiry,
      });
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
    // Ensure instrument master is loaded (with error recovery)
    const instruments = await ensureInstruments();
    const sym = symbol.toUpperCase();
    const spot = parseFloat(spotPrice);
    const now = new Date();

    // Compute ATM strike
    const step = spot > 10000 ? 500 : spot > 5000 ? 200 : spot > 2000 ? 100 : spot > 500 ? 50 : 10;
    const atmStrike = Math.round(spot / step) * step;

    // Build list of strikes to query (ATM ± depth)
    const strikeList = [];
    for (let i = -depth; i <= depth; i++) {
      strikeList.push(atmStrike + i * step);
    }

    // Find all NFO options for this symbol
    const allOptions = instruments.filter(i => {
      if (i.exch_seg !== 'NFO') return false;
      if (!i.name || i.name.toUpperCase() !== sym) return false;
      if (!i.instrumenttype || !i.instrumenttype.includes('OPT')) return false;
      return true;
    });

    // Pick best expiry
    const pickExpiry = (optList) => {
      const sorted = optList
        .map(i => ({ ...i, _exp: new Date(i.expiry) }))
        .filter(i => i._exp >= now)
        .sort((a,b) => a._exp - b._exp);
      if (expiry === 'MONTHLY') return sorted.filter(i => i._exp.getMonth() === now.getMonth()).pop();
      if (expiry === 'NEXT') return sorted[1];
      return sorted[0]; // WEEKLY = nearest
    };

    // Collect tokens for all strikes CE+PE
    const tokens = [];
    const strikeMap = {};

    for (const strike of strikeList) {
      const strikeVal = strike * 100; // Angel stores strike*100

      const ceInstr = pickExpiry(allOptions.filter(i =>
        parseFloat(i.strike) === strikeVal && i.symbol && i.symbol.toUpperCase().endsWith('CE')
      ));
      const peInstr = pickExpiry(allOptions.filter(i =>
        parseFloat(i.strike) === strikeVal && i.symbol && i.symbol.toUpperCase().endsWith('PE')
      ));

      strikeMap[strike] = { strike, CE_token: ceInstr?.token, PE_token: peInstr?.token, CE_sym: ceInstr?.symbol, PE_sym: peInstr?.symbol };
      if (ceInstr?.token) tokens.push(ceInstr.token);
      if (peInstr?.token) tokens.push(peInstr.token);
    }

    if (tokens.length === 0) {
      return res.json({ status: false, message: `No NFO instruments found for ${sym}` });
    }

    // Batch quote fetch (Angel allows up to 50 tokens)
    const batchSize = 50;
    const allFetched = [];
    for (let i = 0; i < tokens.length; i += batchSize) {
      const batch = tokens.slice(i, i + batchSize);
      const qResp = await axios.post(
        `${ANGEL_API}/rest/secure/angelbroking/market/v1/quote/`,
        { mode: 'LTP', exchangeTokens: { NFO: batch } },
        { headers: getHeaders(true), timeout: 20000 }
      );
      if (qResp.data.status && qResp.data.data?.fetched) {
        allFetched.push(...qResp.data.data.fetched);
      }
    }

    // Build result
    const ltpMap = {};
    allFetched.forEach(q => { ltpMap[String(q.symbolToken)] = parseFloat(q.ltp || q.close || 0); });

    const result = strikeList.map(strike => {
      const m = strikeMap[strike];
      return {
        strike,
        isATM: strike === atmStrike,
        CE_ltp: m.CE_token ? (ltpMap[m.CE_token] || 0) : null,
        PE_ltp: m.PE_token ? (ltpMap[m.PE_token] || 0) : null,
        CE_token: m.CE_token || null,
        PE_token: m.PE_token || null,
        CE_sym: m.CE_sym || null,
        PE_sym: m.PE_sym || null,
      };
    });

    log(`✅ Option chain for ${sym}: ${result.length} strikes fetched`, 'OK');
    return res.json({ status: true, symbol: sym, spotPrice: spot, atmStrike, strikes: result });

  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    log(`Option chain error: ${msg}`, 'WARN');
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
  try {
    const instruments = await ensureInstruments();
    const now = new Date();
    const tokens = {};
    for (const sym of MCX_SYMBOLS) {
      const matches = instruments.filter(i =>
        i.exch_seg === 'MCX' &&
        i.name && i.name.toUpperCase() === sym &&
        i.instrumenttype === 'FUTCOM' &&
        i.expiry && new Date(i.expiry) >= now
      ).sort((a, b) => new Date(a.expiry) - new Date(b.expiry));
      if (matches.length > 0) {
        tokens[sym] = matches[0].token;
        log(`MCX ${sym}: token ${matches[0].token} exp ${matches[0].expiry}`, 'INFO');
      }
    }
    return tokens;
  } catch(e) {
    log('getMCXTokens failed: ' + e.message, 'WARN');
    return {};
  }
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
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  NSE F&O Signal Engine — Angel One SmartAPI Proxy v2.0 ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log(`║  Server:    http://localhost:${PORT}                            ║`);
  console.log(`║  Dashboard: http://localhost:${PORT}/nse-fno-signal-engine.html ║`);
  console.log('║  Status:    Ready for login requests                   ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
  log('Listening for connections...', 'OK');
});
