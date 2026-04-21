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

    const instruments = SESSION._instruments;

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
    // Ensure instrument master is loaded
    if (!SESSION._instruments || (Date.now() - (SESSION._instrFetchTime||0)) > 4*3600*1000) {
      log('Downloading NFO instrument master...', 'INFO');
      const instrResp = await axios.get(
        'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json',
        { timeout: 30000 }
      );
      SESSION._instruments = instrResp.data;
      SESSION._instrFetchTime = Date.now();
    }

    const instruments = SESSION._instruments;
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
