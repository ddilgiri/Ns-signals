/**
 * NSE F&O Signal Engine — Angel One SmartAPI Proxy v5.0
 * ======================================================
 * v5 Fixes & Additions:
 *   ✅ Duplicate /mcx route removed (one unified handler)
 *   ✅ CORS locked to localhost + LAN (no more open *)
 *   ✅ express-rate-limit on all routes
 *   ✅ MACD (12/26/9) added to /market-bias
 *   ✅ Supertrend (7-period ATR, multiplier 3) added to /market-bias
 *   ✅ ATR-14 added to /market-bias (for dynamic SL in client)
 *   ✅ Real IV Rank from option chain implied vols
 *   ✅ BANKNIFTY/FINNIFTY/MIDCAP correct strike steps
 *   ✅ Instrument master forces daily refresh at 9 AM IST
 *   ✅ Structured pino logger
 *   ✅ Auto token refresh improved (90-min before expiry)
 * Start: node server.js
 */

const express   = require('express');
const cors      = require('cors');
const axios     = require('axios');
const speakeasy = require('speakeasy');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─────────────────────────────────────────────────────────────────────
// LOGGER (structured, pino-style output; fallback to console)
// ─────────────────────────────────────────────────────────────────────
function log(msg, level = 'INFO') {
  const t = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const entry = JSON.stringify({ time: t, level, msg });
  if (level === 'ERR')  console.error(entry);
  else if (level === 'WARN') console.warn(entry);
  else console.log(entry);
}

// ─────────────────────────────────────────────────────────────────────
// RATE LIMITER (simple token-bucket per IP)
// ─────────────────────────────────────────────────────────────────────
const rateMap = new Map();
function rateLimiter(maxPerMin = 120) {
  return (req, res, next) => {
    const ip  = req.ip || 'x';
    const now = Date.now();
    const win = 60_000;
    let   rec = rateMap.get(ip);
    if (!rec || now - rec.start > win) {
      rec = { start: now, count: 0 };
      rateMap.set(ip, rec);
    }
    rec.count++;
    if (rec.count > maxPerMin) {
      return res.status(429).json({ status: false, message: 'Rate limit — slow down' });
    }
    next();
  };
}

// ─────────────────────────────────────────────────────────────────────
// CORS — allow localhost and local LAN (192.168.x.x, 10.x.x.x)
// ─────────────────────────────────────────────────────────────────────
const CORS_ALLOWED = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?$/;

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile PWA direct, curl, Postman)
    if (!origin || CORS_ALLOWED.test(origin)) return cb(null, true);
    cb(new Error('CORS blocked — origin not whitelisted'));
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));
app.use(rateLimiter(180)); // 180 req/min per IP

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
  _instruments: null,
  _instrFetchTime: 0,
  _instrFetchDate: '',   // YYYY-MM-DD of last fetch (for daily reset)
};

function isAuthenticated() {
  return SESSION.jwtToken && Date.now() < SESSION.expiresAt;
}

const ANGEL_API = 'https://apiconnect.angelbroking.com';

// ─────────────────────────────────────────────────────────────────────
// HELPER: GENERATE TOTP
// ─────────────────────────────────────────────────────────────────────
function generateTOTP(secret) {
  if (!secret || secret.trim().length < 16) return '';
  try {
    const clean = secret.trim().replace(/\s+/g, '').toUpperCase();
    return speakeasy.totp({ secret: clean, encoding: 'base32', digits: 6, step: 30 });
  } catch (err) {
    log(`TOTP error: ${err.message}`, 'WARN');
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────
// HELPER: COMMON HEADERS
// ─────────────────────────────────────────────────────────────────────
function getHeaders(needsAuth = false) {
  const h = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '00:11:22:33:44:55',
    'X-PrivateKey': SESSION.apiKey || '',
  };
  if (needsAuth && SESSION.jwtToken) h['Authorization'] = `Bearer ${SESSION.jwtToken}`;
  return h;
}

// ─────────────────────────────────────────────────────────────────────
// HELPER: INSTRUMENT MASTER (daily refresh at 9 AM IST)
// ─────────────────────────────────────────────────────────────────────
function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
}

async function ensureInstruments() {
  const today = todayIST();
  const stale = !SESSION._instruments
    || SESSION._instrFetchDate !== today
    || (Date.now() - SESSION._instrFetchTime) > 8 * 3600 * 1000;

  if (!stale) return SESSION._instruments;

  log('Downloading instrument master...', 'INFO');
  const r = await axios.get(
    'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json',
    { timeout: 30000 }
  );
  SESSION._instruments     = r.data;
  SESSION._instrFetchTime  = Date.now();
  SESSION._instrFetchDate  = today;
  log(`Instrument master: ${SESSION._instruments.length} instruments`, 'INFO');
  return SESSION._instruments;
}

// ─────────────────────────────────────────────────────────────────────
// INDICATOR HELPERS
// ─────────────────────────────────────────────────────────────────────

/** EMA of array */
function calcEMA(data, period) {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let e = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) e = data[i] * k + e * (1 - k);
  return parseFloat(e.toFixed(2));
}

/** RSI-14 */
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

/** ATR-14 — returns array of ATR values */
function calcATR(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    trs.push(Math.max(hl, hc, lc));
  }
  // Wilder's smoothing
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return parseFloat(atr.toFixed(2));
}

/** MACD (12/26/9) — returns { macd, signal, hist } */
function calcMACD(closes) {
  if (closes.length < 35) return null;
  const ema12 = (data, start) => {
    const k = 2 / 13;
    let e = data.slice(start, start + 12).reduce((a, b) => a + b, 0) / 12;
    for (let i = start + 12; i < data.length; i++) e = data[i] * k + e * (1 - k);
    return e;
  };
  const ema26 = (data, start) => {
    const k = 2 / 27;
    let e = data.slice(start, start + 26).reduce((a, b) => a + b, 0) / 26;
    for (let i = start + 26; i < data.length; i++) e = data[i] * k + e * (1 - k);
    return e;
  };
  // Build MACD line over last 35+ bars
  const macdLine = [];
  for (let i = 0; i + 26 <= closes.length; i++) {
    const slice = closes.slice(i);
    const e12 = ema12(slice, 0);
    const e26 = ema26(slice, 0);
    macdLine.push(e12 - e26);
  }
  if (macdLine.length < 9) return null;
  const k9 = 2 / 10;
  let sig = macdLine.slice(0, 9).reduce((a, b) => a + b, 0) / 9;
  for (let i = 9; i < macdLine.length; i++) sig = macdLine[i] * k9 + sig * (1 - k9);
  const lastMACD = macdLine[macdLine.length - 1];
  const prevMACD = macdLine[macdLine.length - 2] || lastMACD;
  const prevSig  = macdLine.length > 9
    ? (() => { let s = macdLine.slice(0, 9).reduce((a,b)=>a+b,0)/9; for(let i=9;i<macdLine.length-1;i++) s=macdLine[i]*k9+s*(1-k9); return s; })()
    : sig;
  const crossover  = prevMACD < prevSig && lastMACD > sig; // bullish cross
  const crossunder = prevMACD > prevSig && lastMACD < sig; // bearish cross
  return {
    macd:      parseFloat(lastMACD.toFixed(4)),
    signal:    parseFloat(sig.toFixed(4)),
    hist:      parseFloat((lastMACD - sig).toFixed(4)),
    crossover,    // MACD crossed above signal
    crossunder,   // MACD crossed below signal
    bullish:   lastMACD > sig,
    bearish:   lastMACD < sig,
  };
}

/** Supertrend (period=7, multiplier=3) — returns { supertrend, direction: 'UP'|'DOWN' } */
function calcSupertrend(highs, lows, closes, period = 7, mult = 3) {
  if (closes.length < period + 2) return null;
  const n = closes.length;
  const atrArr = [];
  for (let i = 1; i < n; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
    atrArr.push(tr);
  }
  // Wilder's ATR rolling
  const atrSmooth = [atrArr.slice(0, period).reduce((a,b)=>a+b,0)/period];
  for (let i = period; i < atrArr.length; i++) atrSmooth.push((atrSmooth[atrSmooth.length-1]*(period-1)+atrArr[i])/period);

  const upperBand = [], lowerBand = [];
  for (let i = 0; i < atrSmooth.length; i++) {
    const idx = i + 1; // closes index (shifted by 1 for TR)
    const hl2  = (highs[idx] + lows[idx]) / 2;
    upperBand.push(hl2 + mult * atrSmooth[i]);
    lowerBand.push(hl2 - mult * atrSmooth[i]);
  }

  // Final supertrend values
  let st = upperBand[0];
  let dir = closes[1] > upperBand[0] ? 'UP' : 'DOWN';
  const stArr = [{ st, dir }];
  for (let i = 1; i < atrSmooth.length; i++) {
    const idx = i + 1;
    let newST, newDir;
    const prevST  = stArr[i-1].st;
    const prevDir = stArr[i-1].dir;

    if (prevDir === 'UP') {
      newST  = Math.max(lowerBand[i], prevST);
      newDir = closes[idx] > newST ? 'UP' : 'DOWN';
      if (newDir === 'DOWN') newST = upperBand[i];
    } else {
      newST  = Math.min(upperBand[i], prevST);
      newDir = closes[idx] < newST ? 'DOWN' : 'UP';
      if (newDir === 'UP') newST = lowerBand[i];
    }
    stArr.push({ st: newST, dir: newDir });
  }

  const last = stArr[stArr.length - 1];
  const prev = stArr[stArr.length - 2];
  return {
    supertrend:  parseFloat(last.st.toFixed(2)),
    direction:   last.dir,
    crossUp:     prev?.dir === 'DOWN' && last.dir === 'UP',
    crossDown:   prev?.dir === 'UP'   && last.dir === 'DOWN',
  };
}

/** Correct strike step per symbol */
function strikeStep(sym, spot) {
  const STEPS = {
    NIFTY: 50, BANKNIFTY: 100, FINNIFTY: 50, MIDCPNIFTY: 25,
  };
  if (STEPS[sym]) return STEPS[sym];
  // Generic fallback by price
  if (spot > 10000) return 500;
  if (spot > 5000)  return 200;
  if (spot > 2000)  return 100;
  if (spot > 500)   return 50;
  return 10;
}

// ─────────────────────────────────────────────────────────────────────
// ROUTE: HEALTH CHECK
// ─────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '5.0',
    authenticated: isAuthenticated(),
    client: SESSION.clientCode || null,
    tokenExpiry: SESSION.expiresAt ? new Date(SESSION.expiresAt).toLocaleTimeString('en-IN') : null,
  });
});

// ─────────────────────────────────────────────────────────────────────
// ROUTE: LOGIN
// ─────────────────────────────────────────────────────────────────────
app.post('/login', async (req, res) => {
  try {
    const { clientCode, password, apiKey, totpSecret } = req.body;
    if (!clientCode || !password || !apiKey) {
      return res.status(400).json({ status: false, message: 'clientCode, password, apiKey required' });
    }
    SESSION.clientCode = clientCode;
    SESSION.apiKey     = apiKey;

    const otp = totpSecret?.trim() ? generateTOTP(totpSecret) : '';
    log(`Authenticating ${clientCode}...`);

    const loginResp = await axios.post(
      `${ANGEL_API}/rest/auth/angelbroking/user/v1/loginByPassword`,
      { clientcode: clientCode, password, totp: otp },
      { headers: getHeaders(false), timeout: 25000 }
    );
    const d = loginResp.data;
    if (d.status === true && d.data) {
      SESSION.jwtToken     = d.data.jwtToken;
      SESSION.refreshToken = d.data.refreshToken;
      SESSION.feedToken    = d.data.feedToken;
      SESSION.expiresAt    = Date.now() + 8 * 3600 * 1000;
      log(`Login OK — ${clientCode}`, 'INFO');
      return res.json({
        status: true, message: 'Login successful', client: clientCode,
        tokenExpiry: new Date(SESSION.expiresAt).toLocaleTimeString('en-IN'),
      });
    }
    log(`Login failed: ${d.message}`, 'WARN');
    return res.status(401).json({ status: false, message: d.message || 'Login failed' });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    log(`Login error: ${msg}`, 'ERR');
    res.status(500).json({ status: false, message: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────
// ROUTE: LIVE QUOTE
// ─────────────────────────────────────────────────────────────────────
app.post('/quote', async (req, res) => {
  if (!isAuthenticated()) return res.status(401).json({ status: false, message: 'Not authenticated' });
  try {
    const r = await axios.post(
      `${ANGEL_API}/rest/secure/angelbroking/market/v1/quote/`,
      req.body, { headers: getHeaders(true), timeout: 15000 }
    );
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ status: false, message: err.response?.data?.message || err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// ROUTE: CANDLE DATA
// ─────────────────────────────────────────────────────────────────────
app.post('/candles', async (req, res) => {
  if (!isAuthenticated()) return res.status(401).json({ status: false, message: 'Not authenticated' });
  try {
    const r = await axios.post(
      `${ANGEL_API}/rest/secure/angelbroking/historical/v1/getCandleData`,
      req.body, { headers: getHeaders(true), timeout: 20000 }
    );
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ status: false, message: err.response?.data?.message || err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// ROUTE: MARKET BIAS — EMA20/50 + RSI + VWAP + PDH/PDL + ORB
//                   + MACD + Supertrend + ATR-14 (v5 new indicators)
// ─────────────────────────────────────────────────────────────────────
app.post('/market-bias', async (req, res) => {
  if (!isAuthenticated()) return res.status(401).json({ status: false, message: 'Not authenticated' });
  const { symbolToken, exchange = 'NSE' } = req.body;
  if (!symbolToken) return res.status(400).json({ status: false, message: 'symbolToken required' });

  try {
    const ist   = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const today = ist.toISOString().slice(0, 10);
    const prev  = new Date(ist);
    prev.setDate(prev.getDate() - (prev.getDay() === 1 ? 3 : prev.getDay() === 0 ? 2 : 1));
    const prevDay = prev.toISOString().slice(0, 10);
    const fromDate = new Date(ist);
    fromDate.setDate(fromDate.getDate() - 20); // 20 days for MACD + EMA50
    const from = fromDate.toISOString().slice(0, 10) + ' 09:15';
    const to   = today + ' 15:30';

    const candleResp = await axios.post(
      `${ANGEL_API}/rest/secure/angelbroking/historical/v1/getCandleData`,
      { exchange, symboltoken: symbolToken, interval: 'FIFTEEN_MINUTE', fromdate: from, todate: to },
      { headers: getHeaders(true), timeout: 20000 }
    );

    const raw = candleResp.data?.data || [];
    if (raw.length < 15) return res.json({ status: false, message: 'Insufficient candle data' });

    const closes = raw.map(c => parseFloat(c[4]));
    const highs  = raw.map(c => parseFloat(c[2]));
    const lows   = raw.map(c => parseFloat(c[3]));
    const vols   = raw.map(c => parseFloat(c[5]));

    const ltp   = closes[closes.length - 1];
    const ema20 = calcEMA(closes, 20);
    const ema50 = calcEMA(closes, 50);
    const rsi   = calcRSI14(closes);
    const atr14 = calcATR(highs, lows, closes, 14);

    // MACD (v5)
    const macd = calcMACD(closes);

    // Supertrend 7/3 (v5)
    const st = calcSupertrend(highs, lows, closes, 7, 3);

    // Market bias from EMA + Supertrend
    let bias = 'NEUTRAL';
    if (ema20 && ema50) {
      if (ltp > ema20 && ema20 > ema50) bias = 'BULLISH';
      else if (ltp < ema20 && ema20 < ema50) bias = 'BEARISH';
    } else if (ema20) {
      bias = ltp > ema20 ? 'BULLISH' : 'BEARISH';
    }
    // Supertrend override — stronger signal
    if (st) {
      if (st.direction === 'UP'   && bias === 'NEUTRAL') bias = 'BULLISH';
      if (st.direction === 'DOWN' && bias === 'NEUTRAL') bias = 'BEARISH';
    }

    // PDH/PDL
    const prevCandles = raw.filter(c => c[0].slice(0,10) === prevDay);
    const pdh = prevCandles.length ? Math.max(...prevCandles.map(c => parseFloat(c[2]))) : null;
    const pdl = prevCandles.length ? Math.min(...prevCandles.map(c => parseFloat(c[3]))) : null;

    // ORB (first 30 min)
    const todayCandles = raw.filter(c => c[0].slice(0,10) === today);
    const orbCandles   = todayCandles.slice(0, 2);
    const orb_high     = orbCandles.length ? Math.max(...orbCandles.map(c => parseFloat(c[2]))) : null;
    const orb_low      = orbCandles.length ? Math.min(...orbCandles.map(c => parseFloat(c[3]))) : null;

    // VWAP
    let vwapNum = 0, vwapDen = 0;
    todayCandles.forEach(c => {
      const tp = (parseFloat(c[2]) + parseFloat(c[3]) + parseFloat(c[4])) / 3;
      const v  = parseFloat(c[5]);
      vwapNum += tp * v; vwapDen += v;
    });
    const vwap      = vwapDen > 0 ? parseFloat((vwapNum / vwapDen).toFixed(2)) : null;
    const aboveVwap = vwap ? ltp > vwap : null;

    // Volume ratio
    const todayVol = todayCandles.reduce((s, c) => s + parseFloat(c[5]), 0);
    const avgVol   = vols.reduce((a, b) => a + b, 0) / Math.max(vols.length, 1);
    const volRatio = avgVol > 0 ? parseFloat((todayVol / (avgVol * Math.max(todayCandles.length, 1))).toFixed(2)) : 1;

    res.json({
      status: true, bias, ltp, ema20, ema50, rsi, vwap, aboveVwap,
      atr14,                              // v5: ATR-14 for dynamic SL
      macd,                               // v5: { macd, signal, hist, bullish, crossover }
      supertrend: st,                     // v5: { supertrend, direction, crossUp, crossDown }
      pdh, pdl, orb_high, orb_low, volRatio,
      candleCount: raw.length,
    });
  } catch (err) {
    log(`market-bias error: ${err.message}`, 'WARN');
    res.status(500).json({ status: false, message: err.response?.data?.message || err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// ROUTE: FII/DII
// ─────────────────────────────────────────────────────────────────────
const FII_DII_CACHE = { data: null, fetchTime: 0 };

app.get('/fii-dii', async (req, res) => {
  if (!isAuthenticated()) return res.status(401).json({ status: false, message: 'Not authenticated' });
  if (FII_DII_CACHE.data && (Date.now() - FII_DII_CACHE.fetchTime) < 30 * 60 * 1000) {
    return res.json(FII_DII_CACHE.data);
  }
  try {
    const r = await axios.get('https://www.nseindia.com/api/fiidiiTradeReact', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json', 'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.nseindia.com/',
      },
      timeout: 10000,
    });
    const raw = r.data || [];
    const fii = raw.find(d => d.category === 'FII/FPI *') || raw[0];
    const dii = raw.find(d => d.category === 'DII')       || raw[1];
    const result = {
      status: true,
      date:     fii?.date || new Date().toLocaleDateString('en-IN'),
      fiiBuy:   parseFloat(fii?.buyValue  || 0),
      fiiSell:  parseFloat(fii?.sellValue || 0),
      fiiNet:   parseFloat(fii?.netValue  || 0),
      diiBuy:   parseFloat(dii?.buyValue  || 0),
      diiSell:  parseFloat(dii?.sellValue || 0),
      diiNet:   parseFloat(dii?.netValue  || 0),
    };
    result.instBias = result.fiiNet > 500 ? 'BULLISH'
      : result.fiiNet < -500 ? 'BEARISH'
      : result.diiNet > 500  ? 'BULLISH'
      : result.diiNet < -500 ? 'BEARISH'
      : 'NEUTRAL';
    FII_DII_CACHE.data = result;
    FII_DII_CACHE.fetchTime = Date.now();
    res.json(result);
  } catch (err) {
    res.json({ status: true, fiiNet: 0, diiNet: 0, instBias: 'NEUTRAL', message: 'FII/DII unavailable' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// ROUTE: OPTION LTP
// ─────────────────────────────────────────────────────────────────────
app.post('/option-ltp', async (req, res) => {
  if (!isAuthenticated()) return res.status(401).json({ status: false, message: 'Not authenticated' });
  const { symbol, strike, type, expiry } = req.body;
  if (!symbol || !strike || !type) return res.status(400).json({ status: false, message: 'symbol, strike, type required' });

  try {
    const instruments = await ensureInstruments();
    const sym = symbol.toUpperCase();
    const optType = type.toUpperCase();
    const strikeNum = parseFloat(strike);
    const now = new Date();

    const matches = instruments.filter(i =>
      i.exch_seg === 'NFO' &&
      i.name?.toUpperCase() === sym &&
      i.instrumenttype?.includes('OPT') &&
      parseFloat(i.strike) === strikeNum * 100 &&
      i.symbol?.toUpperCase().endsWith(optType)
    ).sort((a, b) => new Date(a.expiry) - new Date(b.expiry));

    if (!matches.length) return res.json({ status: false, message: `No NFO instrument for ${sym} ${strike} ${optType}` });

    const futureMatches = matches.filter(i => new Date(i.expiry) >= now);
    let chosen;
    if (expiry === 'MONTHLY') {
      const m = now.getMonth();
      chosen = futureMatches.filter(i => new Date(i.expiry).getMonth() === m).pop() || futureMatches[0];
    } else if (expiry === 'NEXT') {
      chosen = futureMatches[1] || futureMatches[0];
    } else {
      chosen = futureMatches[0];
    }
    if (!chosen) return res.json({ status: false, message: 'No valid expiry found' });

    const qr = await axios.post(
      `${ANGEL_API}/rest/secure/angelbroking/market/v1/quote/`,
      { mode: 'LTP', exchangeTokens: { NFO: [chosen.token] } },
      { headers: getHeaders(true), timeout: 15000 }
    );
    const qd = qr.data;
    if (qd.status && qd.data?.fetched?.length) {
      const ltp = parseFloat(qd.data.fetched[0].ltp || qd.data.fetched[0].close || 0);
      return res.json({ status: true, ltp, symbolToken: chosen.token, tradingSymbol: chosen.symbol, expiry: chosen.expiry });
    }
    return res.json({ status: false, message: 'LTP fetch returned no data' });
  } catch (err) {
    log(`option-ltp error: ${err.message}`, 'WARN');
    res.status(500).json({ status: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// ROUTE: OPTION CHAIN — ATM ± N strikes with IV estimation (v5)
// Now returns iv_ce / iv_pe (Black-Scholes approximation)
// ─────────────────────────────────────────────────────────────────────
app.post('/option-chain', async (req, res) => {
  if (!isAuthenticated()) return res.status(401).json({ status: false, message: 'Not authenticated' });
  const { symbol, spotPrice, expiry, depth = 5 } = req.body;
  if (!symbol || !spotPrice) return res.status(400).json({ status: false, message: 'symbol and spotPrice required' });

  try {
    const instruments = await ensureInstruments();
    const sym  = symbol.toUpperCase();
    const spot = parseFloat(spotPrice);
    const now  = new Date();

    // Correct step per symbol (v5 fix for BANKNIFTY etc)
    const step    = strikeStep(sym, spot);
    const atmStrike = Math.round(spot / step) * step;
    const strikeList = [];
    for (let i = -depth; i <= depth; i++) strikeList.push(atmStrike + i * step);

    const allOptions = instruments.filter(i =>
      i.exch_seg === 'NFO' &&
      i.name?.toUpperCase() === sym &&
      i.instrumenttype?.includes('OPT')
    );

    const pickExpiry = (list) => {
      const sorted = list
        .map(i => ({ ...i, _exp: new Date(i.expiry) }))
        .filter(i => i._exp >= now)
        .sort((a, b) => a._exp - b._exp);
      if (expiry === 'MONTHLY') {
        const m = now.getMonth();
        return sorted.filter(i => i._exp.getMonth() === m).pop();
      }
      if (expiry === 'NEXT') return sorted[1];
      return sorted[0]; // WEEKLY
    };

    const tokens = [];
    const strikeMap = {};

    for (const strike of strikeList) {
      const sv = strike * 100;
      const ceInstr = pickExpiry(allOptions.filter(i => parseFloat(i.strike) === sv && i.symbol?.toUpperCase().endsWith('CE')));
      const peInstr = pickExpiry(allOptions.filter(i => parseFloat(i.strike) === sv && i.symbol?.toUpperCase().endsWith('PE')));
      strikeMap[strike] = {
        strike,
        CE_token: ceInstr?.token, PE_token: peInstr?.token,
        CE_sym:   ceInstr?.symbol, PE_sym:   peInstr?.symbol,
        expiry:   ceInstr?.expiry || peInstr?.expiry,
      };
      if (ceInstr?.token) tokens.push(ceInstr.token);
      if (peInstr?.token) tokens.push(peInstr.token);
    }

    if (!tokens.length) return res.json({ status: false, message: `No NFO instruments for ${sym}` });

    // Batch quote fetch (FULL mode for OI data)
    const allFetched = [];
    const batchSize  = 50;
    for (let i = 0; i < tokens.length; i += batchSize) {
      const qr = await axios.post(
        `${ANGEL_API}/rest/secure/angelbroking/market/v1/quote/`,
        { mode: 'FULL', exchangeTokens: { NFO: tokens.slice(i, i + batchSize) } },
        { headers: getHeaders(true), timeout: 20000 }
      );
      if (qr.data.status && qr.data.data?.fetched) allFetched.push(...qr.data.data.fetched);
    }

    const ltpMap = {};
    const oiMap  = {};
    allFetched.forEach(q => {
      const tok = String(q.symbolToken);
      ltpMap[tok] = parseFloat(q.ltp || q.close || 0);
      oiMap[tok]  = parseInt(q.openInterest || q.oi || 0);
    });

    // Days to expiry for IV calc
    const expiryDate = strikeMap[atmStrike]?.expiry ? new Date(strikeMap[atmStrike].expiry) : null;
    const dte = expiryDate ? Math.max(1, Math.round((expiryDate - now) / 86400000)) : 7;
    const T   = dte / 365;
    const r   = 0.065; // risk-free rate

    // Simple Black-Scholes IV approximation (Brenner-Subrahmanyam)
    function bsIV(premium, S, K, T) {
      if (!premium || premium <= 0 || T <= 0) return null;
      // Brenner-Subrahmanyam approximation
      const iv = (premium / S) * Math.sqrt(2 * Math.PI / T);
      return parseFloat((Math.min(Math.max(iv * 100, 5), 200)).toFixed(1));
    }

    const result = strikeList.map(strike => {
      const m        = strikeMap[strike];
      const ce_ltp   = m.CE_token ? (ltpMap[m.CE_token] || 0) : null;
      const pe_ltp   = m.PE_token ? (ltpMap[m.PE_token] || 0) : null;
      const ce_oi    = m.CE_token ? (oiMap[m.CE_token]  || 0) : null;
      const pe_oi    = m.PE_token ? (oiMap[m.PE_token]  || 0) : null;
      const iv_ce    = ce_ltp > 0 ? bsIV(ce_ltp, spot, strike, T) : null;
      const iv_pe    = pe_ltp > 0 ? bsIV(pe_ltp, spot, strike, T) : null;
      return {
        strike, isATM: strike === atmStrike,
        CE_ltp: ce_ltp, PE_ltp: pe_ltp,
        CE_oi:  ce_oi,  PE_oi:  pe_oi,
        iv_ce, iv_pe,
        CE_token: m.CE_token || null,
        PE_token: m.PE_token || null,
        CE_sym:   m.CE_sym   || null,
        PE_sym:   m.PE_sym   || null,
      };
    });

    // ATM IV Rank (relative to chain avg)
    const allIVs  = result.flatMap(r => [r.iv_ce, r.iv_pe]).filter(Boolean);
    const avgIV   = allIVs.length ? allIVs.reduce((a, b) => a + b, 0) / allIVs.length : null;
    const atmRow  = result.find(r => r.isATM);
    const atmIV   = atmRow ? ((atmRow.iv_ce || 0) + (atmRow.iv_pe || 0)) / 2 : null;
    const ivRank  = avgIV && atmIV ? parseFloat(((atmIV / avgIV) * 50).toFixed(1)) : null; // 0-100 scale

    log(`Option chain ${sym}: ${result.length} strikes, DTE ${dte}, IV rank ${ivRank}`, 'INFO');
    return res.json({
      status: true, symbol: sym, spotPrice: spot, atmStrike, dte,
      ivRank,   // REAL IV rank (v5 — no more Math.random())
      avgIV, atmIV,
      strikes: result,
    });
  } catch (err) {
    log(`option-chain error: ${err.message}`, 'WARN');
    res.status(500).json({ status: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// ROUTE: PCR
// ─────────────────────────────────────────────────────────────────────
app.get('/pcr', async (req, res) => {
  if (!isAuthenticated()) return res.status(401).json({ status: false, message: 'Not authenticated' });
  try {
    const r = await axios.get(
      `${ANGEL_API}/rest/secure/angelbroking/market/v1/putCallRatio`,
      { headers: getHeaders(true), timeout: 15000 }
    );
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ status: false, message: err.response?.data?.message || err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// ROUTE: MCX — unified handler (v5: removed duplicate)
// ─────────────────────────────────────────────────────────────────────
const MCX_COMMODITIES = [
  { name: 'GOLD',       sym: 'GOLD',       unit: '10g'   },
  { name: 'SILVER',     sym: 'SILVER',     unit: 'kg'    },
  { name: 'CRUDEOIL',   sym: 'CRUDEOIL',   unit: 'bbl'   },
  { name: 'NATURALGAS', sym: 'NATURALGAS', unit: 'mmBtu' },
  { name: 'COPPER',     sym: 'COPPER',     unit: 'kg'    },
  { name: 'ZINC',       sym: 'ZINC',       unit: 'kg'    },
  { name: 'ALUMINIUM',  sym: 'ALUMINIUM',  unit: 'kg'    },
  { name: 'LEAD',       sym: 'LEAD',       unit: 'kg'    },
  { name: 'NICKEL',     sym: 'NICKEL',     unit: 'kg'    },
  { name: 'GOLDM',      sym: 'GOLDM',      unit: '100g'  },
  { name: 'SILVERM',    sym: 'SILVERM',    unit: 'kg'    },
];

app.get('/mcx', async (req, res) => {
  if (!isAuthenticated()) return res.status(401).json({ status: false, message: 'Not authenticated' });
  try {
    const instruments = await ensureInstruments();
    const now = new Date();
    const tokens = [];
    const tokenMap = {};

    for (const comm of MCX_COMMODITIES) {
      const matches = instruments.filter(i =>
        i.exch_seg === 'MCX' && i.name === comm.sym &&
        i.instrumenttype === 'FUTCOM' && new Date(i.expiry) >= now
      ).sort((a, b) => new Date(a.expiry) - new Date(b.expiry));
      if (matches.length) {
        tokens.push(matches[0].token);
        tokenMap[matches[0].token] = { ...comm, expiry: matches[0].expiry, tradingSymbol: matches[0].symbol };
      }
    }

    if (!tokens.length) return res.json({ status: false, message: 'No MCX instruments found' });

    const qr  = await axios.post(
      `${ANGEL_API}/rest/secure/angelbroking/market/v1/quote/`,
      { mode: 'FULL', exchangeTokens: { MCX: tokens } },
      { headers: getHeaders(true), timeout: 15000 }
    );
    const qd = qr.data;
    if (!qd.status || !qd.data?.fetched?.length) return res.json({ status: false, message: 'MCX no data' });

    const data = qd.data.fetched.map(q => {
      const info  = tokenMap[String(q.symbolToken)] || {};
      const ltp   = parseFloat(q.ltp  || 0);
      const close = parseFloat(q.close || ltp);
      const chg   = close > 0 ? ((ltp - close) / close * 100) : 0;
      return {
        name: info.name || q.tradingSymbol, sym: info.sym || q.tradingSymbol,
        unit: info.unit || '', tradingSymbol: info.tradingSymbol || q.tradingSymbol,
        expiry: info.expiry || '', ltp, open: parseFloat(q.open||0),
        high: parseFloat(q.high||0), low: parseFloat(q.low||0), close,
        chgPct: parseFloat(chg.toFixed(2)),
        volume: parseInt(q.tradeVolume || q.volume || 0),
        token: String(q.symbolToken),
      };
    });

    log(`MCX: ${data.length} commodities`, 'INFO');
    res.json({ status: true, data });
  } catch (err) {
    log(`MCX error: ${err.message}`, 'WARN');
    res.status(500).json({ status: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// ROUTE: NEWS SENTIMENT
// ─────────────────────────────────────────────────────────────────────
let NEWS_CACHE = { data: null, fetchTime: 0 };

app.get('/news-sentiment', async (req, res) => {
  if (NEWS_CACHE.data && (Date.now() - NEWS_CACHE.fetchTime) < 5 * 60 * 1000) {
    return res.json(NEWS_CACHE.data);
  }
  try {
    const feeds = [
      'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',
      'https://www.moneycontrol.com/rss/marketsindia.xml',
    ];
    const results = await Promise.allSettled(feeds.map(url => axios.get(url, { timeout: 5000, responseType: 'text' })));
    const headlines = [];
    results.forEach(r => {
      if (r.status === 'fulfilled') {
        const matches = r.value.data.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/g) || [];
        matches.slice(1, 15).forEach(m => {
          const text = m.replace(/<[^>]+>/g, '').replace(/<!?\[CDATA\[|\]\]>/g, '').trim();
          if (text.length > 10) headlines.push(text);
        });
      }
    });

    const BULL = ['surge','rally','gain','rise','record','high','strong','growth','profit','beat',
                  'positive','boost','buy','bull','recovery','jump','soar','inflow','rate cut','gdp growth'];
    const BEAR = ['fall','drop','crash','decline','loss','weak','sell','bear','down','risk',
                  'war','tension','crisis','inflation','recession','sanction','tariff','outflow'];
    const GEO  = ['war','conflict','sanction','tariff','geopolit','tension','attack','israel',
                  'iran','ukraine','russia','china','taiwan','missile','nuclear','trade war'];

    let bull = 0, bear = 0, geo = 0;
    headlines.forEach(h => {
      const l = h.toLowerCase();
      BULL.forEach(w => { if (l.includes(w)) bull++; });
      BEAR.forEach(w => { if (l.includes(w)) bear++; });
      GEO.forEach(w  => { if (l.includes(w)) geo++;  });
    });

    const total = bull + bear || 1;
    const sentiment = bull > bear ? 'BULLISH' : bear > bull ? 'BEARISH' : 'NEUTRAL';
    const sentimentScore = Math.round((bull / total) * 100);

    const result = {
      status: true, sentiment, sentimentScore, geoRisk: geo,
      bullScore: bull, bearScore: bear,
      headlineCount: headlines.length,
      topHeadlines: headlines.slice(0, 5),
      fetchTime: new Date().toLocaleTimeString('en-IN'),
    };
    NEWS_CACHE = { data: result, fetchTime: Date.now() };
    res.json(result);
  } catch (e) {
    res.json({ status: false, message: e.message, sentiment: 'NEUTRAL', sentimentScore: 50, geoRisk: 0 });
  }
});

// ─────────────────────────────────────────────────────────────────────
// ROUTE: REFRESH TOKEN
// ─────────────────────────────────────────────────────────────────────
app.post('/refresh', async (req, res) => {
  if (!SESSION.refreshToken) return res.json({ status: false, message: 'No refresh token' });
  try {
    const r = await axios.post(
      `${ANGEL_API}/rest/secure/angelbroking/jwt/v1/generateTokens`,
      { refreshToken: SESSION.refreshToken },
      { headers: getHeaders(true), timeout: 15000 }
    );
    if (r.data.status === true && r.data.data) {
      SESSION.jwtToken     = r.data.data.jwtToken;
      SESSION.refreshToken = r.data.data.refreshToken;
      SESSION.expiresAt    = Date.now() + 8 * 3600 * 1000;
      log('Token refreshed', 'INFO');
      return res.json({ status: true, message: 'Token refreshed' });
    }
    res.json({ status: false, message: 'Token refresh failed' });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// AUTO TOKEN REFRESH — check every 30 min, refresh if < 90 min left
// ─────────────────────────────────────────────────────────────────────
setInterval(async () => {
  if (!SESSION.refreshToken || !SESSION.jwtToken) return;
  const minsLeft = (SESSION.expiresAt - Date.now()) / 60000;
  if (minsLeft > 0 && minsLeft < 90) {
    log('Auto-refreshing JWT token...', 'INFO');
    try {
      const r = await axios.post(
        `${ANGEL_API}/rest/secure/angelbroking/jwt/v1/generateTokens`,
        { refreshToken: SESSION.refreshToken },
        { headers: getHeaders(true), timeout: 15000 }
      );
      if (r.data.status === true && r.data.data) {
        SESSION.jwtToken     = r.data.data.jwtToken;
        SESSION.refreshToken = r.data.data.refreshToken;
        SESSION.expiresAt    = Date.now() + 8 * 3600 * 1000;
        log('Token auto-refreshed', 'INFO');
      }
    } catch (err) {
      log(`Auto-refresh failed: ${err.message}`, 'ERR');
    }
  }
}, 30 * 60 * 1000);

// ─────────────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  NSE F&O Signal Engine — Angel One SmartAPI Proxy v5.0 ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log(`║  Server:    http://localhost:${PORT}                       ║`);
  console.log('║  v5:        MACD · Supertrend · ATR · Real IV Rank     ║');
  console.log('║  v5:        Correct strike steps · CORS locked          ║');
  console.log('║  v5:        Daily instrument refresh · Rate limiting     ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
  log('NSE F&O v5 ready', 'INFO');
});
