const express=require("express"),cors=require("cors"),axios=require("axios"),speakeasy=require("speakeasy"),fs=require("fs"),path=require("path"),app=express(),PORT=process.env.PORT||3001;
app.use(cors({origin:"*"})),app.use(express.json({limit:"10mb"})),app.use(express.static(__dirname));

const SESSION={jwtToken:"",refreshToken:"",feedToken:"",apiKey:"",clientCode:"",expiresAt:0};
function isAuthenticated(){return SESSION.jwtToken&&Date.now()<SESSION.expiresAt}
function log(e,t="INFO"){const a=(new Date).toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit",second:"2-digit"});console.log(`[${a}] [${t}] ${e}`)}

// ─── SHARED INSTRUMENT MASTER LOADER (prevents duplicate parallel downloads) ───
// Multiple routes need SESSION._instruments; previously each had its own independent
// check-then-download, causing many redundant simultaneous downloads when several
// requests arrived at once with a cold/stale cache. This lock ensures only one
// download happens at a time — concurrent callers wait for the same in-flight request.
let _instrLoadPromise = null;
async function ensureInstruments(reason, forceRefresh) {
  if (!forceRefresh && SESSION._instruments && Date.now() - (SESSION._instrFetchTime || 0) <= 14400000) {
    return SESSION._instruments;
  }
  if (_instrLoadPromise) {
    return _instrLoadPromise; // another call is already downloading — wait for it
  }
  _instrLoadPromise = (async () => {
    try {
      log(`Downloading NFO instrument master${reason ? " for " + reason : ""}${forceRefresh ? " (forced refresh)" : ""}...`, "INFO");
      const r = await axios.get("https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json", {timeout:30000});
      SESSION._instruments = r.data;
      SESSION._instrFetchTime = Date.now();
      return SESSION._instruments;
    } finally {
      _instrLoadPromise = null;
    }
  })();
  return _instrLoadPromise;
}

// ═══════════════════════════════════════════════════════
// UPGRADE 1: MARKET HOURS GATE
// ═══════════════════════════════════════════════════════
function isMarketOpen(){
  const n=new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Kolkata"}));
  const d=n.getDay();
  if(d===0||d===6)return false;
  const mins=n.getHours()*60+n.getMinutes();
  return mins>=9*60+15&&mins<=15*60+30;
}
function isPreMarket(){
  const n=new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Kolkata"}));
  const d=n.getDay();
  if(d===0||d===6)return false;
  const mins=n.getHours()*60+n.getMinutes();
  return mins>=9*60&&mins<9*60+15;
}
function marketStatus(){
  const n=new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Kolkata"}));
  const d=n.getDay();
  const mins=n.getHours()*60+n.getMinutes();
  if(isMarketOpen())return{open:true,label:"MARKET OPEN",code:"OPEN"};
  if(isPreMarket())return{open:false,label:"PRE-MARKET",code:"PRE"};
  if(d===0||d===6)return{open:false,label:"WEEKEND",code:"WEEKEND"};
  if(mins>15*60+30)return{open:false,label:"MARKET CLOSED",code:"CLOSED"};
  return{open:false,label:"BEFORE MARKET",code:"BEFORE"};
}

// ═══════════════════════════════════════════════════════
// UPGRADE 2: EXPIRY WEEK DETECTION (replaces old isIndexExpiryDay)
// ═══════════════════════════════════════════════════════
function getExpiryWeekInfo(symbol){
  // symbol optional — used to distinguish NIFTY weekly vs monthly/stock
  const sym=(symbol||"").toUpperCase();
  const now=new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Kolkata"}));
  now.setHours(0,0,0,0);
  const year=now.getFullYear(),month=now.getMonth();
  const todayDay=now.getDay(); // 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri,6=Sat

  // ── Helper: last weekday of month ──────────────────────────
  function lastWeekdayOfMonth(targetDay){
    // targetDay: 0=Sun … 6=Sat
    const lastDay=new Date(year,month+1,0);
    const diff=lastDay.getDay()>=targetDay
      ?lastDay.getDay()-targetDay
      :lastDay.getDay()+7-targetDay;
    const d=new Date(lastDay);
    d.setDate(lastDay.getDate()-diff);
    d.setHours(0,0,0,0);
    return d;
  }

  // ── Next Tuesday (for NIFTY weekly) ───────────────────────
  function nextTuesday(){
    const d=new Date(now);
    const daysUntil=(2-todayDay+7)%7||7; // 0 means today is Tuesday
    d.setDate(now.getDate()+daysUntil);
    d.setHours(0,0,0,0);
    return d;
  }

  // ── NIFTY: weekly every Tuesday, monthly = last Tuesday ────
  // ── BANKNIFTY / FINNIFTY / MIDCPNIFTY: monthly = last Tuesday, NO weekly ──
  // ── Stocks: monthly = last Tuesday, NO weekly ─────────────
  // ── BSE SENSEX: weekly every Thursday ─────────────────────

  const isNiftyWeekly = sym==="NIFTY";
  const isBSE = sym==="SENSEX"||sym==="BANKEX";

  let expiryDate, expiryType;

  if(isBSE){
    // BSE: next Thursday
    const daysUntilThu=(4-todayDay+7)%7||7;
    expiryDate=new Date(now);
    expiryDate.setDate(now.getDate()+daysUntilThu);
    expiryDate.setHours(0,0,0,0);
    expiryType="BSE_WEEKLY";
  } else if(isNiftyWeekly){
    // NIFTY: next Tuesday (weekly)
    const lastTueOfMonth=lastWeekdayOfMonth(2);
    const daysToMonthly=Math.round((lastTueOfMonth-now)/86400000);
    if(todayDay===2&&daysToMonthly===0){
      // Today is last Tuesday = monthly expiry
      expiryDate=now;
      expiryType="NIFTY_MONTHLY";
    } else {
      // Next Tuesday = weekly expiry
      expiryDate=todayDay===2?now:nextTuesday();
      expiryType="NIFTY_WEEKLY";
    }
  } else {
    // BANKNIFTY, FINNIFTY, MIDCPNIFTY: monthly, current month till expiry day
    // Stocks: monthly, but roll to NEXT month once dte<=2 (updated 2026-08-24 per explicit user request) -- matches getExpiryType logic below. Applies identically to Manual Check -- both paths call this same function via /oi-analysis, no separate logic exists.
    const curMonthLastTue=lastWeekdayOfMonth(2);
    const dteToCurMonth=Math.round((curMonthLastTue-now)/86400000);
    const INDICES_LIST=["BANKNIFTY","FINNIFTY","MIDCPNIFTY"];
    const isIndexSym=INDICES_LIST.includes(sym);
    if(!isIndexSym && dteToCurMonth<=1){
      // Stock on or after the day before expiry — use NEXT month's last Tuesday instead
      const nextMonthDate=new Date(year,month+1,1);
      const nm=nextMonthDate.getMonth(),ny=nextMonthDate.getFullYear();
      const lastDayNext=new Date(ny,nm+1,0);
      const diffNext=lastDayNext.getDay()>=2?lastDayNext.getDay()-2:lastDayNext.getDay()+5;
      const d2=new Date(lastDayNext);
      d2.setDate(lastDayNext.getDate()-diffNext);
      d2.setHours(0,0,0,0);
      expiryDate=d2;
    } else {
      expiryDate=curMonthLastTue;
    }
    expiryType="NSE_MONTHLY";
  }

  const daysToExpiry=Math.round((expiryDate-now)/86400000);
  const isExpiryDay=daysToExpiry===0&&(todayDay===2||todayDay===4);
  const isExpiryWeek=daysToExpiry>=0&&daysToExpiry<=4;
  const isBSEExpiryDay=todayDay===4; // BSE always Thursday

  // For NIFTY weekly: DTE is days to next Tuesday
  // For others: DTE is days to last Tuesday of month
  const niftyWeeklyDTE=isNiftyWeekly?(todayDay===2?0:(2-todayDay+7)%7):null;

  return{
    isNSEExpiryDay:isExpiryDay&&!isBSE,
    isNSEExpiryWeek:isExpiryWeek&&!isBSE,
    isBSEExpiryDay,
    isNiftyWeekly,
    expiryType,
    daysToNSEExpiry:daysToExpiry,
    niftyWeeklyDTE,         // NIFTY only — days to next Tuesday
    nseExpiryDate:expiryDate.toISOString().slice(0,10),
    thresholdMultiplier:isExpiryWeek?0.7:1.0,
    gammaWarning:isExpiryDay||isBSEExpiryDay,
    // Convenience flags
    isNiftyWeeklyExpiryDay:isNiftyWeekly&&todayDay===2,
    isBankNiftyExpiryDay:!isNiftyWeekly&&sym==="BANKNIFTY"&&isExpiryDay,
    isFinniftyExpiryDay:sym==="FINNIFTY"&&isExpiryDay,
    isMidcapExpiryDay:sym==="MIDCPNIFTY"&&isExpiryDay,
  };
}


// ═══════════════════════════════════════════════════════
// GAMMA BLAST DETECTION
// Conditions: near expiry + spot hugging ATM + high OI at ATM
// Based on real trade: Nifty 23350 CE at ₹22 → ₹33.50 on expiry day
// ═══════════════════════════════════════════════════════
function detectGammaBlast(oiData, expiryInfo, vixValue, isIndex) {
  if (!oiData) return { isGammaBlast: false };
  // Gamma blast is ONLY for Index options (NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY)
  // Stock options have monthly expiry only — no weekly gamma squeeze possible
  if (!isIndex) return { isGammaBlast: false, reason: 'Stock option — gamma blast not applicable' };

  // For NIFTY weekly: use niftyWeeklyDTE (days to next Tuesday)
  // For others: use daysToNSEExpiry (days to last Tuesday of month)
  const dte = expiryInfo.niftyWeeklyDTE !== null && expiryInfo.niftyWeeklyDTE !== undefined
    ? expiryInfo.niftyWeeklyDTE
    : expiryInfo.daysToNSEExpiry;
  const spotPrice = oiData.spotPrice || 0;
  const atmStrike = oiData.atmStrike || 0;
  const atmCeOI = oiData.atmCeOI || 0;
  const atmPeOI = oiData.atmPeOI || 0;
  const totalCeOI = oiData.totalCeOI || 1;
  const totalPeOI = oiData.totalPeOI || 1;

  if (!spotPrice || !atmStrike) return { isGammaBlast: false };

  // Condition 1: DTE must be 0, 1 or 2 (expiry day or expiry week last 2 days)
  const nearExpiry = dte >= 0 && dte <= 2;
  if (!nearExpiry) return { isGammaBlast: false, reason: `DTE ${dte} > 2` };

  // Condition 2: Spot within 0.5% of ATM strike (hugging the strike)
  const spotToATM = Math.abs(spotPrice - atmStrike) / spotPrice;
  const spotHuggingATM = spotToATM <= 0.008; // ~0.8% — Nifty strikes are 50pt wide

  // Condition 3: ATM OI concentration — ATM holds significant share of total OI
  const atmCeConcentration = atmCeOI / totalCeOI;
  const atmPeConcentration = atmPeOI / totalPeOI;
  const highATMConcentration = atmCeConcentration > 0.08 || atmPeConcentration > 0.08;

  // Condition 4: VIX not extreme (avoid gamma blast in panic)
  const vixOk = !vixValue || vixValue < 28;

  // Gamma blast score 0-100
  let score = 0;
  const reasons = [];

  if (dte === 0) { score += 40; reasons.push('Expiry day — max gamma ☢️'); }
  else if (dte === 1) { score += 25; reasons.push('1 day to expiry — high gamma'); }
  else if (dte === 2) { score += 15; reasons.push('2 days to expiry — elevated gamma'); }

  if (spotHuggingATM) {
    score += 30;
    reasons.push(`Spot ₹${spotPrice} hugging ATM ${atmStrike} (${(spotToATM*100).toFixed(2)}% gap)`);
  } else if (spotToATM <= 0.01) {
    score += 15;
    reasons.push(`Spot near ATM ${atmStrike} (${(spotToATM*100).toFixed(2)}% gap)`);
  }

  if (highATMConcentration) {
    score += 20;
    reasons.push(`High ATM OI concentration — CE:${(atmCeConcentration*100).toFixed(0)}% PE:${(atmPeConcentration*100).toFixed(0)}%`);
  }

  if (!vixOk) { score -= 20; reasons.push(`VIX ${vixValue} elevated — reduce size`); }

  // Direction bias
  let direction = 'NEUTRAL';
  let directionNote = '';
  if (spotPrice > atmStrike) {
    direction = 'CE';
    directionNote = 'Spot above ATM — CE gamma play';
  } else if (spotPrice < atmStrike) {
    direction = 'PE';
    directionNote = 'Spot below ATM — PE gamma play';
  } else {
    direction = 'BOTH';
    directionNote = 'Spot AT ATM — straddle gamma territory';
  }

  const isGammaBlast = score >= 45 && spotToATM <= 0.015 && nearExpiry; // relaxed: 1.5% gap ok, score 45+

  return {
    isGammaBlast,
    gammaScore: Math.min(100, score),
    dte,
    spotToATM: parseFloat((spotToATM*100).toFixed(3)),
    atmStrike,
    atmCeConcentration: parseFloat((atmCeConcentration*100).toFixed(1)),
    atmPeConcentration: parseFloat((atmPeConcentration*100).toFixed(1)),
    direction,
    directionNote,
    reasons,
    warning: dte === 0 ? '⚠️ EXPIRY DAY — theta kills after 1 PM, exit before 2:30 PM' :
             dte === 1 ? '⚠️ Pre-expiry — gamma building, exit same day' :
             '⚠️ Expiry week — watch closely',
    badge: isGammaBlast ? (score >= 80 ? '🔥 GAMMA BLAST' : '⚡ GAMMA SETUP') : null
  };
}

// ═══════════════════════════════════════════════════════
// UPGRADE 3: OI SNAPSHOT HISTORY
// ═══════════════════════════════════════════════════════
const OI_HISTORY={};
const OI_HISTORY_MAX=8;
const OI_HISTORY_FILE=path.join(__dirname,"oi_history.json");
// Load OI history from disk on startup
function loadOIHistory(){
  try{
    if(fs.existsSync(OI_HISTORY_FILE)){
      const raw=JSON.parse(fs.readFileSync(OI_HISTORY_FILE,"utf8"));
      const cutoff=Date.now()-4*60*60*1000; // discard >4h old snaps
      Object.keys(raw).forEach(sym=>{
        const fresh=(raw[sym]||[]).filter(s=>s.ts&&s.ts>cutoff);
        if(fresh.length)OI_HISTORY[sym]=fresh.slice(-OI_HISTORY_MAX);
      });
      log(`OI history loaded — ${Object.keys(OI_HISTORY).length} symbols`,"OK");
    }
  }catch(e){log(`OI history load failed: ${e.message}`,"WARN");}
}
function saveOIHistory(){
  try{fs.writeFileSync(OI_HISTORY_FILE,JSON.stringify(OI_HISTORY),"utf8");}
  catch(e){log(`OI history save failed: ${e.message}`,"WARN");}
}
loadOIHistory();

function saveOISnapshot(symbol,oiData){
  if(!symbol||!oiData)return;
  if(!OI_HISTORY[symbol])OI_HISTORY[symbol]=[];
  OI_HISTORY[symbol].push({
    ts:Date.now(),
    time:Date.now(),
    t:new Date().toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit",timeZone:"Asia/Kolkata"}),
    atmStrike:oiData.atmStrike,
    totalCeOI:oiData.totalCeOI,
    totalPeOI:oiData.totalPeOI,
    pcr:oiData.pcr,
    maxPain:oiData.maxPain,
    oiRec:oiData.oiRecommendation,
    oiScore:oiData.oiScore,
    formula:oiData.dilipFormula
  });
  if(OI_HISTORY[symbol].length>OI_HISTORY_MAX)OI_HISTORY[symbol].shift();
  saveOIHistory();
}

function getOITrend(symbol){
  const snaps=OI_HISTORY[symbol];
  if(!snaps||snaps.length<2)return{trend:"INSUFFICIENT_DATA",snapCount:snaps?.length||0};
  const latest=snaps[snaps.length-1];
  const prev=snaps[snaps.length-2];
  const oldest=snaps[0];
  const ceChange=latest.totalCeOI-prev.totalCeOI;
  const peChange=latest.totalPeOI-prev.totalPeOI;
  const ceChangeLong=latest.totalCeOI-oldest.totalCeOI;
  const peChangeLong=latest.totalPeOI-oldest.totalPeOI;
  const ceTrend=ceChange>0?"BUILDING":ceChange<0?"UNWINDING":"STABLE";
  const peTrend=peChange>0?"BUILDING":peChange<0?"UNWINDING":"STABLE";
  const pcrTrend=latest.pcr>prev.pcr?"RISING":latest.pcr<prev.pcr?"FALLING":"FLAT";
  let trend="MIXED";
  if(ceTrend==="UNWINDING"&&peTrend==="BUILDING")trend="BULLISH_MOMENTUM";
  else if(ceTrend==="BUILDING"&&peTrend==="UNWINDING")trend="BEARISH_MOMENTUM";
  else if(ceTrend==="BUILDING"&&peTrend==="BUILDING")trend="BOTH_ADDING_TRAPPED";
  else if(ceTrend==="UNWINDING"&&peTrend==="UNWINDING")trend="BOTH_RUNNING_UNCERTAIN";
  return{
    trend,ceTrend,peTrend,
    ceChange,peChange,ceChangeLong,peChangeLong,
    pcrTrend,
    rameshTrend:ceTrend==="BUILDING"?"Ramesh adding ceiling 🧱":ceTrend==="UNWINDING"?"Ramesh running 🏃":"Ramesh stable",
    sureshTrend:peTrend==="BUILDING"?"Suresh adding floor 🧱":peTrend==="UNWINDING"?"Suresh running 🏃":"Suresh stable",
    snapCount:snaps.length,
    firstSnap:snaps[0].t,
    lastSnap:latest.t,
    history:snaps.map(s=>({t:s.t,ceOI:s.totalCeOI,peOI:s.totalPeOI,pcr:s.pcr,formula:s.formula}))
  };
}

// ═══════════════════════════════════════════════════════
// UPGRADE 4: SIGNAL LOG
// ═══════════════════════════════════════════════════════
const SIGNAL_LOG=[];
const SIGNAL_LOG_MAX=200;
const SIGNAL_LOG_FILE=path.join(__dirname,"signal_log.json");

// Load signal log from disk on startup
function loadSignalLogFromDisk(){
  try{
    if(fs.existsSync(SIGNAL_LOG_FILE)){
      const data=JSON.parse(fs.readFileSync(SIGNAL_LOG_FILE,"utf8"));
      if(Array.isArray(data)){
        data.slice(0,SIGNAL_LOG_MAX).forEach(e=>SIGNAL_LOG.push(e));
        log(`Signal log restored: ${SIGNAL_LOG.length} entries from disk`,"OK");
      }
    }
  }catch(e){log("Signal log load failed: "+e.message,"WARN");}
}

// Save signal log to disk
function saveSignalLogToDisk(){
  try{
    fs.writeFileSync(SIGNAL_LOG_FILE,JSON.stringify(SIGNAL_LOG.slice(0,SIGNAL_LOG_MAX)),"utf8");
  }catch(e){log("Signal log save failed: "+e.message,"WARN");}
}


function logSignal(sym,type,score,verdict,ltp,breakdown){
  const entry={
    id:Date.now(),
    time:new Date().toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"}),
    date:new Date().toLocaleDateString("en-IN"),
    sym,type,score,verdict,
    entryPrice:ltp||null,
    topReason:breakdown?Object.entries(breakdown)
      .filter(([,v])=>v.earned>0)
      .sort((a,b)=>b[1].earned-a[1].earned)[0]?.[1]?.note||"":"",
    outcome:null,
    exitPrice:null,
    pnl:null
  };
  SIGNAL_LOG.unshift(entry);
  if(SIGNAL_LOG.length>SIGNAL_LOG_MAX)SIGNAL_LOG.pop();
  // Persist to disk asynchronously
  setImmediate(saveSignalLogToDisk);
  return entry.id;
}

// Real store of every scanned stock's latest CE/PE score, regardless of whether it
// qualified as a signal -- powers the Activity Log "All Stocks" tab with genuine live
// data instead of hardcoded sample numbers. Kept in memory only, resets on server restart
// (matches how SESSION.signals and other live-scan state already behave).
const LATEST_SCORES={};
function recordStockScore(sym,type,score,verdict){
  if(!sym||!type)return;
  const key=sym.toUpperCase();
  if(!LATEST_SCORES[key])LATEST_SCORES[key]={};
  LATEST_SCORES[key][type]={score:Math.round(score),verdict,ts:Date.now()};
}

const ANGEL_API="https://apiconnect.angelbroking.com";

function generateTOTP(e){if(!e||e.trim().length<16)return"";try{const t=e.trim().replace(/\s+/g,"").toUpperCase();return speakeasy.totp({secret:t,encoding:"base32",digits:6,step:30,time:Math.floor(Date.now()/1e3)})}catch(e){return log(`TOTP generation failed: ${e.message}`,"WARN"),""}}
function getHeaders(e=!1){const t={"Content-Type":"application/json",Accept:"application/json","X-UserType":"USER","X-SourceID":"WEB","X-ClientLocalIP":"127.0.0.1","X-ClientPublicIP":"127.0.0.1","X-MACAddress":"00:11:22:33:44:55","X-PrivateKey":SESSION.apiKey||""};return e&&SESSION.jwtToken&&(t.Authorization=`Bearer ${SESSION.jwtToken}`),t}

let _lastRefreshAttempt=0,_refreshInProgress=!1;
async function refreshToken(){if(!SESSION.refreshToken||!SESSION.apiKey||!SESSION.clientCode)return!1;const e=Date.now();if(_refreshInProgress)return!1;if(e-_lastRefreshAttempt<3e4)return log("Token refresh skipped — cooldown active","INFO"),!1;_refreshInProgress=!0,_lastRefreshAttempt=e;try{log("Refreshing expired Angel One token...","INFO");const e=await axios.post(`${ANGEL_API}/rest/auth/angelbroking/jwt/v1/generateTokens`,{refreshToken:SESSION.refreshToken},{headers:getHeaders(!1),timeout:15e3});return e.data?.status&&e.data?.data?.jwtToken?(SESSION.jwtToken=e.data.data.jwtToken,SESSION.refreshToken=e.data.data.refreshToken||SESSION.refreshToken,SESSION.expiresAt=Date.now()+288e5,log("Token refreshed successfully","OK"),_refreshInProgress=!1,!0):(_refreshInProgress=!1,!1)}catch(e){return log(`Token refresh failed: ${e.message}`,"WARN"),_refreshInProgress=!1,!1}}

// GLOBAL ANGEL ONE REQUEST GATE — every angelRequest() call (quote, candle, OI, bias, option-chain,
// option-ltp, live-trade-prices) funnels through this single choke point, so concurrent callers
// (auto-scan + live-trade-price refresh + baseline download all running at once, as confirmed in
// production logs showing bursts of 6 simultaneous 403s at 04:52:45 and 04:53:06) get serialized
// with a shared minimum spacing instead of racing Angel One's rate limit independently. Previously
// only /candles had its own throttle (_lastCandleCall, 600ms) — /quote and OI-batch calls had none,
// which is exactly what produced the simultaneous-burst 403 pattern seen in the logs.
let _angelGateChain=Promise.resolve();
const ANGEL_MIN_GAP_MS=350;
let _angelLastCall=0;
function angelGate(){
  const runNext=_angelGateChain.then(async()=>{
    const wait=ANGEL_MIN_GAP_MS-(Date.now()-_angelLastCall);
    if(wait>0)await new Promise(r=>setTimeout(r,wait));
    _angelLastCall=Date.now();
  });
  _angelGateChain=runNext.catch(()=>{}); // never let one caller's rejection break the chain for the next
  return runNext;
}
async function angelRequest(e,t,a,s={}){await angelGate();try{const n={headers:getHeaders(!0),timeout:2e4,...s};return"GET"===e?await axios.get(t,n):await axios.post(t,a,n)}catch(n){const o=n.response?.status;if(401===o&&SESSION.refreshToken){if(await refreshToken()){await angelGate();const n={headers:getHeaders(!0),timeout:2e4,...s};return"GET"===e?await axios.get(t,n):await axios.post(t,a,n)}}throw 403===o&&await new Promise(e=>setTimeout(e,2e3)),n}}

// ═══════════════════════════════════════════════════════
// UPGRADE 5: NEW ROUTES
// ═══════════════════════════════════════════════════════

// GET /market-status
app.get("/market-status",(req,res)=>{
  const ms=marketStatus();
  const exp=getExpiryWeekInfo("NIFTY");// NIFTY is most active — use for market status
  res.json({
    ...ms,
    expiry:exp,
    serverTime:new Date().toLocaleTimeString("en-IN",{timeZone:"Asia/Kolkata"}),
    note:exp.gammaWarning?"⚠️ Expiry day — gamma risk high, reduce position size":
         exp.isNSEExpiryWeek?`⚠️ NSE expiry week (${exp.daysToNSEExpiry}d to expiry) — OI thresholds tighter`:
         "Normal trading day"
  });
});

// GET /oi-history/:symbol
app.get("/oi-history/:symbol",(req,res)=>{
  const sym=req.params.symbol.toUpperCase();
  const trend=getOITrend(sym);
  res.json({status:true,symbol:sym,...trend});
});

// GET /oi-history (all symbols)
app.get("/oi-history",(req,res)=>{
  const result={};
  Object.keys(OI_HISTORY).forEach(sym=>{result[sym]=getOITrend(sym)});
  res.json({status:true,symbols:Object.keys(OI_HISTORY),data:result});
});

// GET /signal-log
app.get("/signal-log",(req,res)=>{
  const limit=parseInt(req.query.limit)||50;
  const sym=req.query.sym?.toUpperCase();
  const filtered=sym?SIGNAL_LOG.filter(s=>s.sym===sym):SIGNAL_LOG;
  const stats={
    total:filtered.length,
    wins:filtered.filter(s=>s.outcome==="WIN").length,
    losses:filtered.filter(s=>s.outcome==="LOSS").length,
    pending:filtered.filter(s=>s.outcome===null).length,
    winRate:filtered.filter(s=>s.outcome!==null).length>0?
      Math.round(filtered.filter(s=>s.outcome==="WIN").length/
      filtered.filter(s=>s.outcome!==null).length*100)+"%":"N/A"
  };
  res.json({status:true,stats,signals:filtered.slice(0,limit)});
});

// POST /signal-outcome — mark win/loss
app.post("/signal-outcome",(req,res)=>{
  const{id,outcome,exitPrice}=req.body;
  if(!id||!outcome)return res.status(400).json({status:false,message:"id and outcome required"});
  const entry=SIGNAL_LOG.find(s=>s.id===id);
  if(!entry)return res.status(404).json({status:false,message:"Signal not found"});
  entry.outcome=outcome.toUpperCase();
  entry.exitPrice=exitPrice||null;
  if(entry.entryPrice&&exitPrice){
    entry.pnl=outcome.toUpperCase()==="WIN"?
      Math.abs(exitPrice-entry.entryPrice):
      -Math.abs(exitPrice-entry.entryPrice);
  }
  saveSignalLogToDisk();
  log(`Signal outcome: ${entry.sym} ${entry.type} → ${entry.outcome}`,"INFO");
  res.json({status:true,entry});
});

// ─── EXISTING ROUTES (unchanged) ───────────────────────────

app.get("/health",(e,t)=>{const a=Object.keys(BIAS_CACHE).length,s=Object.values(BIAS_CACHE).filter(e=>Date.now()-e.fetchTime<BIAS_TTL).length;const ms=marketStatus();t.json({status:"ok",authenticated:isAuthenticated(),client:SESSION.clientCode||null,tokenExpiry:SESSION.expiresAt?new Date(SESSION.expiresAt).toLocaleTimeString("en-IN"):null,market:ms,biasCache:{total:a,fresh:s},oiHistorySymbols:Object.keys(OI_HISTORY).length,signalLogCount:SIGNAL_LOG.length})})
app.post("/clear-cache",(e,t)=>{const a=Object.keys(BIAS_CACHE).length;Object.keys(BIAS_CACHE).forEach(e=>delete BIAS_CACHE[e]),log(`Bias cache cleared (${a} entries removed)`,"INFO"),t.json({status:!0,message:`Cleared ${a} cache entries`})})
app.post("/login",async(e,t)=>{try{const{clientCode:a,password:s,apiKey:n,totpSecret:o}=e.body;if(!a||!s||!n)return log("Login: Missing required fields","WARN"),t.status(400).json({status:!1,message:"clientCode, password, and apiKey are required"});SESSION.clientCode=a,SESSION.apiKey=n;let r="";o&&o.trim()&&(r=generateTOTP(o),r?log(`TOTP generated: ${r}`):log("TOTP secret invalid — proceeding without 2FA","WARN")),log(`Authenticating ${a}...`);const i=(await axios.post(`${ANGEL_API}/rest/auth/angelbroking/user/v1/loginByPassword`,{clientcode:a,password:s,totp:r},{headers:getHeaders(!1),timeout:25e3})).data;if(!0===i.status&&i.data)return SESSION.jwtToken=i.data.jwtToken,SESSION.refreshToken=i.data.refreshToken,SESSION.feedToken=i.data.feedToken,SESSION.expiresAt=Date.now()+288e5,log(`✅ Login successful — ${a}`,"OK"),t.json({status:!0,message:"Login successful",client:a,tokenExpiry:new Date(SESSION.expiresAt).toLocaleTimeString("en-IN")});const l=i.message||i.errorcode||"Unknown error";return log(`❌ Login failed: ${l}`,"ERR"),t.status(401).json({status:!1,message:l})}catch(e){const a=e.response?.data?.message||e.response?.data?.errorcode||e.message;log(`❌ Login error: ${a}`,"ERR"),t.status(500).json({status:!1,message:a||"Connection error — check if Angel One API is reachable"})}})
app.post("/quote",async(e,t)=>{if(!isAuthenticated())return t.status(401).json({status:!1,message:"Not authenticated — login first"});try{const a=await angelRequest("POST",`${ANGEL_API}/rest/secure/angelbroking/market/v1/quote/`,e.body);t.json(a.data)}catch(e){const a=e.response?.data?.message||e.message;log(`Quote error: ${a}`,"WARN"),t.status(e.response?.status||500).json({status:!1,message:a})}})
app.post("/candles",async(e,t)=>{if(!isAuthenticated())return t.status(401).json({status:!1,message:"Not authenticated"});try{const a=await angelRequest("POST",`${ANGEL_API}/rest/secure/angelbroking/historical/v1/getCandleData`,e.body);t.json(a.data)}catch(e){const a=e.response?.data?.message||e.message;t.status(e.response?.status||500).json({status:!1,message:a})}})

const BIAS_CACHE={},BIAS_TTL=3e5;
const OI_CACHE={},OI_CACHE_TTL=15e3;
// Minimum absolute OI (contracts) for a strike to be trusted as a real wall/floor signal.
// A strike can look "STRONG" purely relative to a thin trading day's average OI (W) while
// still being genuinely low-liquidity in absolute terms -- easy to move, easy to fake a
// wall/floor read on. Below this floor, downgrade to THIN regardless of relative strength,
// and exclude from WALL_CRACKING (a strike too thin to be a real wall can't meaningfully
// "crack" either).
// Relative liquidity gate: previously a flat 300000 for every stock, which is too LOW for heavy
// names (RELIANCE, bank stocks routinely carry several times that at real walls -- thin strikes
// could slip through unflagged) and too HIGH for lighter F&O names (which may never reach 3 lakh
// at any strike even on an active day -- their genuinely strongest levels could get mislabeled
// THIN). Fixed by scaling the threshold to each stock's own average per-strike OI (W, already
// computed per-scan from that stock's own chain) instead of one number for all 209 stocks.
// MIN_OI_ABS_FLOOR is a small absolute backstop so extremely illiquid stocks don't get a
// near-zero threshold that lets through genuinely untradeable OI.
const MIN_OI_REL_FRACTION=0.3,MIN_OI_ABS_FLOOR=50000;
function minOiThreshold(avgOi){return Math.max(MIN_OI_ABS_FLOOR,MIN_OI_REL_FRACTION*(avgOi||0));}
let _lastAngelCall=0;
async function angelRateLimit(){const e=Date.now()-_lastAngelCall;e<700&&await new Promise(t=>setTimeout(t,700-e)),_lastAngelCall=Date.now()}
let _lastCandleCall=0;
async function throttledCandleRequest(e,t){const a=Date.now()-_lastCandleCall;return a<900&&await new Promise(e=>setTimeout(e,900-a)),_lastCandleCall=Date.now(),angelRequest("POST",`${ANGEL_API}/rest/secure/angelbroking/historical/v1/getCandleData`,e)}

function calcEMA(e,t){if(e.length<t)return null;const a=2/(t+1);let s=e.slice(0,t).reduce((e,t)=>e+t,0)/t;for(let n=t;n<e.length;n++)s=e[n]*a+s*(1-a);return parseFloat(s.toFixed(2))}
function calcRSI14(e){if(e.length<15)return 50;let t=0,a=0;for(let s=1;s<=14;s++){const n=e[s]-e[s-1];n>0?t+=n:a-=n}let s=t/14,n=a/14;for(let t=15;t<e.length;t++){const a=e[t]-e[t-1];s=(13*s+Math.max(a,0))/14,n=(13*n+Math.max(-a,0))/14}return 0===n?100:parseFloat((100-100/(1+s/n)).toFixed(2))}
function calcMACD(e,t=12,a=26,s=9){if(e.length<a+s)return null;const n=[],o=[],r=2/(t+1),i=2/(a+1);let l=e.slice(0,t).reduce((e,t)=>e+t,0)/t;n.push(l);for(let a=t;a<e.length;a++)l=e[a]*r+l*(1-r),n.push(l);let c=e.slice(0,a).reduce((e,t)=>e+t,0)/a;o.push(c);for(let t=a;t<e.length;t++)c=e[t]*i+c*(1-i),o.push(c);const u=a-t,p=o.map((e,t)=>parseFloat((n[t+u]-e).toFixed(4)));if(p.length<s)return null;const d=2/(s+1);let g=p.slice(0,s).reduce((e,t)=>e+t,0)/s;const m=[g];for(let e=s;e<p.length;e++)g=p[e]*d+g*(1-d),m.push(g);const h=p[p.length-1],S=m[m.length-1],E=p[p.length-2],f=m[m.length-2],I=parseFloat((h-S).toFixed(4));let N="NONE";return void 0!==E&&void 0!==f&&(E<=f&&h>S?N="BULLISH":E>=f&&h<S&&(N="BEARISH")),{macdLine:parseFloat(h.toFixed(4)),signalLine:parseFloat(S.toFixed(4)),histogram:I,crossover:N,aboveSignal:h>S}}
function calcATR(e,t=14){if(e.length<t+1)return null;const a=[];for(let t=1;t<e.length;t++){const s=parseFloat(e[t][2]),n=parseFloat(e[t][3]),o=parseFloat(e[t-1][4]);a.push(Math.max(s-n,Math.abs(s-o),Math.abs(n-o)))}let s=a.slice(0,t).reduce((e,t)=>e+t,0)/t;for(let e=t;e<a.length;e++)s=(s*(t-1)+a[e])/t;return parseFloat(s.toFixed(2))}

// USER-PROVIDED, adapted to this app's candle format (Angel One rows: [ts,open,high,low,close,volume],
// indices 2/3/4 = high/low/close) and to 15-min bars (this app's existing candle fetch interval --
// deliberately reused rather than adding a separate 5-min fetch, to avoid more Angel One calls on
// top of the rate-limiting work already done this session). Both operate on the full raw candle
// array 'g' already fetched for EMA/RSI/MACD/Supertrend -- no new API calls needed.
// Detects a move that already happened and has since gone flat -- the big OI+LTP move is behind us,
// not ahead of us, so a Case2/6 read right now is describing exhaustion, not a fresh entry.
function isMoveAlreadyStale(candles,lookback=6){
  if(!candles||candles.length<2*lookback)return false;
  const recent=candles.slice(-lookback),prior=candles.slice(-2*lookback,-lookback);
  const recentRange=Math.max(...recent.map(c=>parseFloat(c[2])))-Math.min(...recent.map(c=>parseFloat(c[3])));
  const priorRange=Math.max(...prior.map(c=>parseFloat(c[2])))-Math.min(...prior.map(c=>parseFloat(c[3])));
  return priorRange>recentRange*2;
}
// Detects a range-bound/chopping stock (low net-move efficiency vs total range) vs a genuinely
// trending one -- a valid Case score on a chopping stock has much lower edge than the same Case
// on a trending stock, and this wasn't previously distinguished.
function isChoppy(candles,lookback=20){
  if(!candles||candles.length<lookback)return false;
  const slice=candles.slice(-lookback);
  const totalRange=Math.max(...slice.map(c=>parseFloat(c[2])))-Math.min(...slice.map(c=>parseFloat(c[3])));
  if(totalRange<=0)return false;
  const netMove=Math.abs(parseFloat(slice[slice.length-1][4])-parseFloat(slice[0][4]));
  const efficiency=netMove/totalRange;
  return efficiency<0.35;
}
function calcSupertrend(e,t=10,a=3){if(e.length<t+2)return null;const s=e.map(e=>parseFloat(e[2])),n=e.map(e=>parseFloat(e[3])),o=e.map(e=>parseFloat(e[4])),r=[0];for(let t=1;t<e.length;t++)r.push(Math.max(s[t]-n[t],Math.abs(s[t]-o[t-1]),Math.abs(n[t]-o[t-1])));let i=r.slice(1,t+1).reduce((e,t)=>e+t,0)/t;const l=new Array(t+1).fill(0);l.push(i);for(let a=t+1;a<e.length;a++)i=(i*(t-1)+r[a])/t,l.push(i);const c=[],u=[];for(let t=0;t<e.length;t++){const e=(s[t]+n[t])/2;c.push(e+a*(l[t]||0)),u.push(e-a*(l[t]||0))}const p=[...c],d=[...u],g=new Array(e.length).fill(0),m=new Array(e.length).fill(1);for(let a=t+1;a<e.length;a++)p[a]=c[a]<p[a-1]||o[a-1]>p[a-1]?c[a]:p[a-1],d[a]=u[a]>d[a-1]||o[a-1]<d[a-1]?u[a]:d[a-1],g[a-1]===p[a-1]?g[a]=o[a]>p[a]?d[a]:p[a]:g[a]=o[a]<d[a]?p[a]:d[a],m[a]=o[a]>g[a]?1:-1;const h=e.length-1,S=m[h-1],E=m[h];let f="HOLD";return-1===S&&1===E&&(f="BUY"),1===S&&-1===E&&(f="SELL"),{supertrend:parseFloat(g[h].toFixed(2)),trend:1===E?"UP":"DOWN",signal:f}}
function calcMaxPain(e){if(!e||0===e.length)return null;const t=e.map(e=>e.strike);let a=1/0,s=null;for(const n of t){let t=0;for(const a of e){t+=(a.CE_oi?Math.max(0,n-a.strike)*(a.CE_oi||0):0)+(a.PE_oi?Math.max(0,a.strike-n)*(a.PE_oi||0):0)}t<a&&(a=t,s=n)}return s}

app.post("/market-bias",async(e,t)=>{
  if(!isAuthenticated())return t.status(401).json({status:!1,message:"Not authenticated"});
  // MARKET HOURS GATE for bias
  const ms=marketStatus();
  if(!ms.open&&ms.code!=="PRE"){
    const cached=BIAS_CACHE[e.body?.symbolToken];
    if(cached)return t.json({...cached.data,fromCache:true,marketClosed:true,marketStatus:ms.label});
  }
  const{symbolToken:a,exchange:s="NSE"}=e.body;
  if(!a)return t.status(400).json({status:!1,message:"symbolToken required"});
  const n=BIAS_CACHE[a];
  if(n&&Date.now()-n.fetchTime<BIAS_TTL)return t.json(n.data);
  try{const e=new Date,n=new Date(e.toLocaleString("en-US",{timeZone:"Asia/Kolkata"})),o=n.toISOString().slice(0,10),r=new Date(n);let i=1;1===r.getDay()?i=3:0===r.getDay()&&(i=2),r.setDate(r.getDate()-i);const l=r.toISOString().slice(0,10),c=new Date(n);c.setDate(c.getDate()-10);const u=c.toISOString().slice(0,10)+" 09:15",p=o+" 15:30";let d;try{d=await throttledCandleRequest({exchange:s,symboltoken:a,interval:"FIFTEEN_MINUTE",fromdate:u,todate:p},s)}catch(e){const t=e.response?.status;if(403!==t&&429!==t)throw e;log(`Candle 403/429 for ${a} — waiting 4s then retrying (attempt 1)`,"WARN"),await new Promise(e=>setTimeout(e,4e3)),_lastCandleCall=Date.now();try{d=await angelRequest("POST",`${ANGEL_API}/rest/secure/angelbroking/historical/v1/getCandleData`,{exchange:s,symboltoken:a,interval:"FIFTEEN_MINUTE",fromdate:u,todate:p})}catch(e2){const t2=e2.response?.status;if(403!==t2&&429!==t2)throw e2;log(`Candle 403/429 for ${a} — waiting 4s then retrying (attempt 2, final)`,"WARN"),await new Promise(e=>setTimeout(e,4e3)),_lastCandleCall=Date.now(),d=await angelRequest("POST",`${ANGEL_API}/rest/secure/angelbroking/historical/v1/getCandleData`,{exchange:s,symboltoken:a,interval:"FIFTEEN_MINUTE",fromdate:u,todate:p})}}const g=d.data?.data||[];if(g.length<10){const e={status:!0,bias:"NEUTRAL",ltp:null,ema20:null,ema50:null,rsi:50,vwap:null,aboveVwap:null,pdh:null,pdl:null,orb_high:null,orb_low:null,volRatio:1,macd:null,atr:null,supertrend:null,isExpiryDay:!1,atrStopLong:null,atrStopShort:null,candleCount:g.length,fromCache:!1};return BIAS_CACHE[a]={data:e,fetchTime:Date.now()},t.json(e)}const m=g.map(e=>parseFloat(e[4]));(g.map(e=>parseFloat(e[5])));const h=calcEMA(m,20),S=calcEMA(m,50),E=m[m.length-1];let f="NEUTRAL";h&&S?E>h&&h>S?f="BULLISH":E<h&&h<S&&(f="BEARISH"):h&&(f=E>h?"BULLISH":"BEARISH");const I=g.filter(e=>e[0].slice(0,10)===l),N=I.length?Math.max(...I.map(e=>parseFloat(e[2]))):null,A=I.length?Math.min(...I.map(e=>parseFloat(e[3]))):null,k=g.filter(e=>e[0].slice(0,10)===o),C=k.slice(0,2),O=C.length?Math.max(...C.map(e=>parseFloat(e[2]))):null,T=C.length?Math.min(...C.map(e=>parseFloat(e[3]))):null,y=k.reduce((e,t)=>e+parseFloat(t[5]),0),w=g.filter(e=>e[0].slice(0,10)!==o),b={};w.forEach(e=>{const t=e[0].slice(0,10);b[t]=(b[t]||0)+parseFloat(e[5])});const _=Object.values(b),F=_.length?_.reduce((e,t)=>e+t,0)/_.length:0,R=26,x=Math.min(k.length/R,1),P=F*Math.max(x,.15),L=P>0?parseFloat((y/P).toFixed(2)):1,D=calcRSI14(m),$=calcMACD(m),M=calcATR(g),U=calcSupertrend(g);
  const expiryInfo=getExpiryWeekInfo("");
  let B=0,j=0;k.forEach(e=>{const t=(parseFloat(e[2])+parseFloat(e[3])+parseFloat(e[4]))/3,a=parseFloat(e[5]);B+=t*a,j+=a});const H=j>0?parseFloat((B/j).toFixed(2)):null;
// Volume+Price direction match
const recentCandles=k.slice(-3);const volUp=recentCandles.reduce((s,c)=>s+parseFloat(c[5]),0)/Math.max(recentCandles.length,1);const priceUp=recentCandles.length>=2&&parseFloat(recentCandles[recentCandles.length-1][4])>parseFloat(recentCandles[0][4]);const priceDown=recentCandles.length>=2&&parseFloat(recentCandles[recentCandles.length-1][4])<parseFloat(recentCandles[0][4]);const volMatch=L>=1.2&&((f==="BULLISH"&&priceUp)||(f==="BEARISH"&&priceDown));const volFake=L>=1.2&&((f==="BULLISH"&&priceDown)||(f==="BEARISH"&&priceUp));
// Volume dry up: last 3 candles all below 0.5x avg
const last3Vols=k.slice(-3).map(c=>parseFloat(c[5]));const avgVolPerCandle=P>0?P/Math.max(R,1):1;const volDryUp=last3Vols.length===3&&last3Vols.every(v=>v<0.5*avgVolPerCandle);
const V={status:!0,bias:f,ltp:E,ema20:h,ema50:S,rsi:D,vwap:H,aboveVwap:H?E>H:null,pdh:N,pdl:A,orb_high:O,orb_low:T,volRatio:L,volPriceDir:volMatch?"MATCH":volFake?"FAKE":"NEUTRAL",volDryUp,macd:$||null,atr:M||null,supertrend:U||null,isExpiryDay:expiryInfo.isNSEExpiryDay,isExpiryWeek:expiryInfo.isNSEExpiryWeek,gammaWarning:expiryInfo.gammaWarning,daysToExpiry:expiryInfo.daysToNSEExpiry,atrStopLong:M&&E?parseFloat((E-1.5*M).toFixed(2)):null,atrStopShort:M&&E?parseFloat((E+1.5*M).toFixed(2)):null,candleCount:g.length,fromCache:!1,staleMove:isMoveAlreadyStale(g),chopRange:isChoppy(g)};BIAS_CACHE[a]={data:{...V,fromCache:!0},fetchTime:Date.now()},log(`Bias ${a}: ${f} RSI=${D} EMA20=${h} bars=${g.length} expWk=${expiryInfo.isNSEExpiryWeek}`,"INFO"),t.json(V)}catch(e){const s=e.response?.status,o=e.response?.data?.message||e.message;if(log(`market-bias error [${s||"?"}] token=${a}: ${o}`,"WARN"),n)return log(`Serving stale bias cache for ${a}`,"INFO"),t.json({...n.data,fromCache:!0,stale:!0});t.json({status:!0,bias:"NEUTRAL",ltp:null,ema20:null,ema50:null,rsi:50,vwap:null,aboveVwap:null,pdh:null,pdl:null,orb_high:null,orb_low:null,volRatio:1,candleCount:0,fromCache:!1,error:o})}})

const FII_DII_CACHE={data:null,fetchTime:0};
let NSE_COOKIE="";
async function getNSECookie(){if(NSE_COOKIE)return NSE_COOKIE;try{const e=(await axios.get("https://www.nseindia.com/",{headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",Accept:"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8","Accept-Language":"en-US,en;q=0.9","Accept-Encoding":"gzip, deflate, br",Connection:"keep-alive"},timeout:12e3})).headers["set-cookie"];return e&&(NSE_COOKIE=e.map(e=>e.split(";")[0]).join("; "),log("NSE session established","INFO")),NSE_COOKIE}catch(e){return log(`NSE session failed: ${e.message}`,"WARN"),""}}
async function fetchNSEFiiDii(){const e=await getNSECookie(),t={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",Accept:"application/json, text/plain, */*","Accept-Language":"en-US,en;q=0.9","Accept-Encoding":"gzip, deflate, br",Referer:"https://www.nseindia.com/",Origin:"https://www.nseindia.com",Connection:"keep-alive","sec-ch-ua":'"Not_A Brand";v="8", "Chromium";v="120"',"sec-ch-ua-mobile":"?0","sec-ch-ua-platform":'"Windows"',"Sec-Fetch-Dest":"empty","Sec-Fetch-Mode":"cors","Sec-Fetch-Site":"same-origin"};e&&(t.Cookie=e);return(await axios.get("https://www.nseindia.com/api/fiidiiTradeReact",{headers:t,timeout:12e3})).data||[]}

app.get("/fii-dii",async(e,t)=>{if(!isAuthenticated())return t.status(401).json({status:!1,message:"Not authenticated"});if(FII_DII_CACHE.data&&Date.now()-FII_DII_CACHE.fetchTime<18e5)return t.json(FII_DII_CACHE.data);try{let e;try{e=await fetchNSEFiiDii()}catch(t){log(`FII/DII first attempt failed (${t.response?.status||t.message}), resetting cookie and retrying...`,"WARN"),NSE_COOKIE="",e=await fetchNSEFiiDii()}const a=e.find(e=>"FII/FPI *"===e.category)||e[0],s=e.find(e=>"DII"===e.category)||e[1],n={status:!0,date:a?.date||(new Date).toLocaleDateString("en-IN"),fiiBuy:parseFloat(a?.buyValue||0),fiiSell:parseFloat(a?.sellValue||0),fiiNet:parseFloat(a?.netValue||0),diiBuy:parseFloat(s?.buyValue||0),diiSell:parseFloat(s?.sellValue||0),diiNet:parseFloat(s?.netValue||0)};n.instBias=n.fiiNet>500?"BULLISH":n.fiiNet<-500?"BEARISH":n.diiNet>500?"BULLISH":n.diiNet<-500?"BEARISH":"NEUTRAL",FII_DII_CACHE.data=n,FII_DII_CACHE.fetchTime=Date.now(),log(`FII: ₹${n.fiiNet}Cr · DII: ₹${n.diiNet}Cr · ${n.instBias}`,"INFO"),t.json(n)}catch(e){const a=e.response?.status;if(log(`FII/DII fetch failed: ${a||e.message}`,"WARN"),FII_DII_CACHE.data)return log("Serving stale FII/DII cache","INFO"),t.json({...FII_DII_CACHE.data,stale:!0});t.json({status:!0,fiiNet:0,diiNet:0,fiiBuy:0,fiiSell:0,diiBuy:0,diiSell:0,instBias:"NEUTRAL",message:"FII/DII unavailable"})}})

const VIX_CACHE={data:null,fetchTime:0};
function buildVixResult(e,t,a,s){let n="NORMAL";null!==e&&(n=e<12?"VERY_LOW":e<16?"LOW":e<20?"NORMAL":e<25?"ELEVATED":e<30?"HIGH":"EXTREME");return{status:!0,vix:e,regime:n,premiumBuyable:null===e||e<20,change:null!==t?parseFloat((t||0).toFixed(2)):null,changePct:null!==a?parseFloat((a||0).toFixed(2)):null,prevClose:s||null,guidance:"VERY_LOW"===n?"Low IV — good time to buy options":"LOW"===n?"Normal conditions — options fairly priced":"NORMAL"===n?"Watch carefully — IV rising":"ELEVATED"===n?"Options expensive — prefer selling or spreads":"HIGH"===n?"High volatility — avoid naked option buying":"EXTREME"===n?"Extreme fear — directional trades risky":"VIX data unavailable"}}

function getExpiryType(e){
  const t=(e||"").toUpperCase();
  // ALL instruments expire on LAST TUESDAY of month (NSE standard)
  const now=new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Kolkata"}));
  const todayJS=now.getDay(); // 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri,6=Sat

  // Helper: last Tuesday of a given month
  function lastTueOf(yr,mn){
    const last=new Date(yr,mn,0); // last day of month
    const diff=(last.getDay()>=2?last.getDay()-2:last.getDay()+5);
    last.setDate(last.getDate()-diff);
    last.setHours(0,0,0,0);
    return last;
  }

  const todayMid=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const curLastTue=lastTueOf(now.getFullYear(),now.getMonth()+1);
  const dteMs=curLastTue-todayMid;
  const dte=Math.round(dteMs/86400000); // days to last Tuesday this month

  // NIFTY — weekly expiry every Tuesday
  // On expiry Tuesday: scan NEXT Tuesday's contract (not next month)
  // Only jump to next month if we're past monthly expiry
  if(t==="NIFTY"){
    if(todayJS===2){
      // Today is Tuesday — use NEXT weekly (7 days ahead)
      log(`NIFTY: today is Tuesday (weekly expiry) — scanning next week contract`,"INFO");
      return"NIFTY_NEXT_WEEKLY";
    }
    if(dte<=0){
      // Past monthly expiry
      log(`NIFTY: monthly expiry passed — scanning next month`,"INFO");
      return"NEXT_MONTH";
    }
    return"NIFTY_WEEKLY"; // current week's contract
  }

  // BANKNIFTY, FINNIFTY, MIDCPNIFTY — indices: always current month (next month only after expiry passed)
  const INDICES=["BANKNIFTY","FINNIFTY","MIDCPNIFTY"];
  if(INDICES.includes(t)){
    if(dte<0){
      log(`${t}: expiry passed — scanning next month`,"INFO");
      return"NEXT_MONTH";
    }
    return"MONTHLY";
  }
  // STOCKS only — switch to next month once dte<=2 (updated 2026-08-24 per explicit user request). Same function used for Manual Check, no separate path.
  if(dte<=2){
    log(`${t}: ${dte}d to expiry — stock switching to next month`,"INFO");
    return"NEXT_MONTH";
  }
  return"MONTHLY";
}

app.get("/india-vix",async(e,t)=>{if(VIX_CACHE.data&&Date.now()-VIX_CACHE.fetchTime<3e5)return t.json(VIX_CACHE.data);try{const e=await getNSECookie(),a={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",Accept:"application/json, text/plain, */*",Referer:"https://www.nseindia.com/",Origin:"https://www.nseindia.com","sec-ch-ua-platform":'"Windows"',"Sec-Fetch-Dest":"empty","Sec-Fetch-Mode":"cors","Sec-Fetch-Site":"same-origin"};e&&(a.Cookie=e);const s=await axios.get("https://www.nseindia.com/api/allIndices",{headers:a,timeout:12e3}),n=(s.data?.data||[]).find(e=>"INDIA VIX"===e.index);if(!n){const e=await axios.get("https://www.nseindia.com/api/quote-derivative?symbol=INDIAVIX",{headers:a,timeout:12e3}),s=e.data?.underlyingValue||null;if(s){const e=buildVixResult(parseFloat(s),null,null,null);return VIX_CACHE.data=e,VIX_CACHE.fetchTime=Date.now(),t.json(e)}return t.json({status:!1,message:"India VIX not found in NSE indices"})}const o=buildVixResult(parseFloat(n.last||0),parseFloat(n.change||0),parseFloat(n.percentChange||0),parseFloat(n.previousClose||0));VIX_CACHE.data=o,VIX_CACHE.fetchTime=Date.now(),log(`India VIX: ${o.vix} (${o.regime}) chg=${o.changePct}%`,"INFO"),t.json(o)}catch(e){if(log(`India VIX fetch failed: ${e.message}`,"WARN"),VIX_CACHE.data)return t.json({...VIX_CACHE.data,stale:!0});t.json({status:!0,vix:null,regime:"UNKNOWN",premiumBuyable:!0,message:"VIX unavailable"})}})

// ===== Case-transition flag engine (additive, does not touch existing OI_HISTORY/getOITrend) =====
const STRIKE_HISTORY={};
const STRIKE_HISTORY_MAX=6;
const STRIKE_HISTORY_FILE=path.join(__dirname,"strike_history.json");
const STRIKE_FLAG_LOG=[];
const STRIKE_FLAG_LOG_FILE=path.join(__dirname,"strike_flag_log.json");
const STRIKE_FLAG_LOG_MAX=500;
function loadStrikeHistory(){
  try{
    if(fs.existsSync(STRIKE_HISTORY_FILE)){
      const raw=JSON.parse(fs.readFileSync(STRIKE_HISTORY_FILE,"utf8"));
      const cutoff=Date.now()-4*60*60*1000;
      Object.keys(raw).forEach(sym=>{
        const fresh=(raw[sym]||[]).filter(s=>s.ts&&s.ts>cutoff);
        if(fresh.length)STRIKE_HISTORY[sym]=fresh.slice(-STRIKE_HISTORY_MAX);
      });
      log(`Strike history loaded — ${Object.keys(STRIKE_HISTORY).length} symbols`,"OK");
    }
    if(fs.existsSync(STRIKE_FLAG_LOG_FILE)){
      const rawLog=JSON.parse(fs.readFileSync(STRIKE_FLAG_LOG_FILE,"utf8"));
      if(Array.isArray(rawLog))STRIKE_FLAG_LOG.push(...rawLog.slice(-STRIKE_FLAG_LOG_MAX));
    }
  }catch(e){log(`Strike history load failed: ${e.message}`,"WARN");}
}
function saveStrikeHistory(){
  try{fs.writeFileSync(STRIKE_HISTORY_FILE,JSON.stringify(STRIKE_HISTORY),"utf8");}
  catch(e){log(`Strike history save failed: ${e.message}`,"WARN");}
}
function saveStrikeFlagLog(){
  try{fs.writeFileSync(STRIKE_FLAG_LOG_FILE,JSON.stringify(STRIKE_FLAG_LOG.slice(-STRIKE_FLAG_LOG_MAX)),"utf8");}
  catch(e){log(`Strike flag log save failed: ${e.message}`,"WARN");}
}
loadStrikeHistory();

// Classify one side (CE or PE) at one strike into Case 1-8, mirrors Ramesh/Suresh manual logic
// Thresholds tuned for ~45s scan-to-scan comparison (much smaller moves than manual multi-minute checks)
function classifyCase(oiChangePct,ltpChangePct){
  if(oiChangePct==null||ltpChangePct==null)return null;
  const oiUp=oiChangePct>0.5, oiDown=oiChangePct<-0.5;
  const ltpUp=ltpChangePct>0.5, ltpDownSharp=ltpChangePct<-3, ltpDownMild=ltpChangePct<=-0.5&&ltpChangePct>=-3, ltpFlat=Math.abs(ltpChangePct)<=0.5;
  if(oiUp&&ltpDownSharp)return 1;
  if(oiUp&&ltpUp)return 6;
  if(oiUp&&ltpDownMild)return 3;
  if(oiUp&&ltpFlat)return 4;
  if(oiDown&&ltpDownMild)return 5;
  if(oiDown&&ltpFlat)return 7;
  if(oiDown&&ltpUp)return 8;
  return null;
}

function urgencyScore(oiChangePct,ltpChangePct){
  if(oiChangePct==null||ltpChangePct==null)return 0;
  const magnitude=Math.min(100,Math.abs(oiChangePct)*0.6+Math.abs(ltpChangePct)*0.8);
  return Math.round(magnitude);
}

function pctChange(curr,prev){
  if(prev==null||prev===0||curr==null)return null;
  return ((curr-prev)/Math.abs(prev))*100;
}

// Compares current chain snapshot against the last stored one for this symbol, returns flags per strike
function computeStrikeFlags(symbol,chain,confluence,atmStrike){
  confluence=confluence||{};
  const hasRsi=typeof confluence.rsi==="number";
  const hasVwap=confluence.aboveVwap===true||confluence.aboveVwap===false;
  // Strike-proximity weighting: count actual array position distance from ATM in the sorted chain
  // (this respects each stock's own real strike gap — e.g. PAYTM's ₹20 gaps vs a ₹5-gap stock — since
  // it's counting chain positions, not a fixed rupee distance)
  const sortedStrikes=chain.map(r=>r.strike).slice().sort((a,b)=>a-b);
  const atmIdx=atmStrike?sortedStrikes.reduce((best,s,idx)=>Math.abs(s-atmStrike)<Math.abs(sortedStrikes[best]-atmStrike)?idx:best,0):null;
  function strikesAway(strike){
    if(atmIdx==null)return null;
    const idx=sortedStrikes.indexOf(strike);
    return idx<0?null:Math.abs(idx-atmIdx);
  }
  function proximityWeight(strike){
    const away=strikesAway(strike);
    if(away==null)return"UNKNOWN";
    if(away<=3)return"HIGH";      // 0-3 strikes from ATM — directly tradeable range, full relevance
    if(away<=6)return"MEDIUM";    // 4-6 strikes — worth noting, secondary relevance
    return"LOW";                 // far OTM — informational only, not actionable near-term
  }
  const now=Date.now();
  const history=STRIKE_HISTORY[symbol]||[];
  const prevSnap=history.length?history[history.length-1]:null;
  const flags=[];
  const currentByStrike={};

  // Per-stock average OI (this chain's own scale), used to make the thin-strike gate relative
  // to each stock instead of one flat number for all 209 -- see minOiThreshold() above.
  const chainAvgOi=chain.length?(chain.reduce((s,r)=>s+(r.CE_oi||0)+(r.PE_oi||0),0))/(2*chain.length):0;
  const chainMinOi=minOiThreshold(chainAvgOi);

  chain.forEach(row=>{
    const prevRow=prevSnap?(prevSnap.rows||[]).find(r=>r.strike===row.strike):null;
    // Day-baseline fallback: on the true first scan for a strike (no prior in-app snapshot yet), derive
    // oiPct/ltpPct from Angel One's own oiChange field (today's OI delta vs yesterday, already fetched
    // live every scan) and prevClose, instead of returning null and showing zero flags until scan #2.
    const ceOiBaseline=row.CE_oi&&row.CE_oiChange!=null&&(row.CE_oi-row.CE_oiChange)!==0?(row.CE_oiChange/(row.CE_oi-row.CE_oiChange))*100:null;
    const peOiBaseline=row.PE_oi&&row.PE_oiChange!=null&&(row.PE_oi-row.PE_oiChange)!==0?(row.PE_oiChange/(row.PE_oi-row.PE_oiChange))*100:null;
    const ceLtpBaseline=row.CE_ltp!=null&&row.CE_prevClose?pctChange(row.CE_ltp,row.CE_prevClose):null;
    const peLtpBaseline=row.PE_ltp!=null&&row.PE_prevClose?pctChange(row.PE_ltp,row.PE_prevClose):null;
    const usingBaseline=!prevRow;

    const ceOiPct=prevRow?pctChange(row.CE_oi,prevRow.CE_oi):ceOiBaseline;
    const ceLtpPct=prevRow&&prevRow.CE_ltp?pctChange(row.CE_ltp,prevRow.CE_ltp):ceLtpBaseline;
    const peOiPct=prevRow?pctChange(row.PE_oi,prevRow.PE_oi):peOiBaseline;
    const peLtpPct=prevRow&&prevRow.PE_ltp?pctChange(row.PE_ltp,prevRow.PE_ltp):peLtpBaseline;
    const ceCase=classifyCase(ceOiPct,ceLtpPct);
    const peCase=classifyCase(peOiPct,peLtpPct);
    const ceUrgency=urgencyScore(ceOiPct,ceLtpPct);
    const peUrgency=urgencyScore(peOiPct,peLtpPct);

    currentByStrike[row.strike]={ceCase,peCase,ceUrgency,peUrgency};

    const prevCe=prevRow?prevRow.ceCase:null;
    const prevPe=prevRow?prevRow.peCase:null;
    const prevCeUrgency=prevRow?prevRow.ceUrgency:null;
    const prevPeUrgency=prevRow?prevRow.peUrgency:null;

    const recentPeCases=history.slice(-2).map(h=>{const r=(h.rows||[]).find(rr=>rr.strike===row.strike);return r?r.peCase:null;}).concat([peCase]);
    const recentCeCases=history.slice(-2).map(h=>{const r=(h.rows||[]).find(rr=>rr.strike===row.strike);return r?r.ceCase:null;}).concat([ceCase]);
    const peFlipping=new Set(recentPeCases.filter(c=>c!=null)).size>=2 && recentPeCases.filter(c=>c!=null).length>=2 && recentPeCases.some((c,idx)=>idx>0&&c!==recentPeCases[idx-1]&&recentPeCases[idx-1]!=null);
    const ceFlipping=new Set(recentCeCases.filter(c=>c!=null)).size>=2 && recentCeCases.filter(c=>c!=null).length>=2 && recentCeCases.some((c,idx)=>idx>0&&c!==recentCeCases[idx-1]&&recentCeCases[idx-1]!=null);

    // UNWIND_RISK: OI rate-of-change negative (writers/holders actively covering) while LTP still trends the same
    // direction as before — the move is continuing on momentum alone, not fresh position-building. Checked only
    // when this side WAS the confirmed dominant/buying side last scan (a trade you'd already be trusting),
    // and is now showing OI unwinding while price hasn't reversed yet — the early warning before Case flips to 8.
    const peWasBuyingPrior=prevPe===6||prevPe===2;
    const ceWasBuyingPrior=prevCe===6||prevCe===2;
    const peUnwindRisk=peWasBuyingPrior&&peOiPct!=null&&peOiPct<0&&peLtpPct!=null&&peLtpPct>0;
    const ceUnwindRisk=ceWasBuyingPrior&&ceOiPct!=null&&ceOiPct<0&&ceLtpPct!=null&&ceLtpPct>0;

    const strikeFlags=[];
    // Confluence note (PE=bearish direction check: RSI high/overbought + below VWAP agrees with fresh PE buying)
    function confluenceNote(side){
      if(!hasRsi&&!hasVwap)return"";
      const bits=[];
      if(hasRsi){
        const rsiAgrees=side==="PE"?confluence.rsi>=55:confluence.rsi<=45;
        bits.push(rsiAgrees?"RSI agrees":"RSI conflicts");
      }
      if(hasVwap){
        const vwapAgrees=side==="PE"?confluence.aboveVwap===false:confluence.aboveVwap===true;
        bits.push(vwapAgrees?"VWAP agrees":"VWAP conflicts");
      }
      return bits.length?" ("+bits.join(", ")+")":"";
    }
    if(peCase!=null){
      const peBuying=peCase===6||peCase===2;
      const peWasBuying=prevPe===6||prevPe===2;
      const peSellingOrFading=peCase===8||peCase===5||peCase===7;
      if(!peWasBuying&&peBuying)strikeFlags.push({side:"PE",type:"FRESH_SIGNAL",label:"🔥 Fresh Signal",detail:`PE Case ${peCase} newly appearing${confluenceNote("PE")}`});
      if(peWasBuying&&peSellingOrFading)strikeFlags.push({side:"PE",type:"WEAKENING",label:"⚠️ Weakening",detail:`PE Case ${prevPe}→${peCase} — buying conviction fading`});
      if(peFlipping)strikeFlags.push({side:"PE",type:"CHOP_WARNING",label:"🌀 Chop Warning",detail:"PE case flipping across recent scans"});
      if(peBuying&&peUrgency>=8){
        if(peFlipping){
          // Squeeze-vs-buildup distinction: urgency is a pure magnitude score (|OI%|*0.6 + |LTP%|*0.8)
          // with no sense of WHY the move is large. A genuine squeeze (writers panic-covering) produces
          // the exact same sharp OI/LTP spike as real fresh conviction -- the only tell is that the case
          // itself has been flipping/unstable across recent scans rather than building steadily. Flag
          // these separately so a spike on a choppy case reads as "likely to fade fast" rather than the
          // same confidence as urgency built on a stable, already-confirmed case.
          strikeFlags.push({side:"PE",type:"SQUEEZE_URGENCY",label:"🌪️ Squeeze Urgency — case unstable",detail:`PE urgency ${peUrgency} but case has been flipping — likely a short-covering spike, not steady conviction; treat as fast in/out only`});
        }else{
          strikeFlags.push({side:"PE",type:"HIGH_URGENCY",label:"⚡ High Urgency",detail:`PE urgency ${peUrgency}`});
        }
      }
      if(peWasBuying&&peBuying&&prevPeUrgency!=null&&peUrgency<prevPeUrgency-3)strikeFlags.push({side:"PE",type:"FADING_URGENCY",label:"🐌 Fading Urgency",detail:`PE urgency dropped ${prevPeUrgency}→${peUrgency}, case not yet flipped`});
      if(peUnwindRisk)strikeFlags.push({side:"PE",type:"UNWIND_RISK",label:"🚨 Unwind Risk",detail:`PE OI falling (${peOiPct.toFixed(1)}%) while LTP still rising (${peLtpPct.toFixed(1)}%) — dominant side covering, reversal risk rising`});
      // PSYCHOLOGY/DISCIPLINE LAYER: Exhaustion flag -- extreme one-sided OI crowding on an
      // already-buying Case often precedes reversal rather than confirming more room to run.
      // Additive only, does not change Case classification or any existing flag.
      // FIXED (2026-08-08, real PGEL transcript): the actual PGEL loss showed a 22700%+ OI%
      // reading on 660 PE that was mathematically meaningless -- it came from a near-zero prior
      // base OI, not genuine crowding. A percentage alone cannot distinguish "real exhaustion"
      // from "tiny base inflated the ratio." Now requires the PRIOR scan's base OI to already
      // be above this stock's own relative liquidity floor (chainMinOi, same threshold used for
      // THIN_SIGNAL) before the percentage is trusted at all -- genuine exhaustion needs real
      // OI behind it, not just an extreme ratio.
      {
        const peBaseOi=prevRow?prevRow.PE_oi:null;
        const peBaseIsReal=peBaseOi!=null&&peBaseOi>=chainMinOi;
        if(peOiPct!=null&&peOiPct>300&&peBaseIsReal)strikeFlags.push({side:"PE",type:"EXHAUSTION",label:"⚠️ Extreme — possible exhaustion",detail:`PE OI change ${peOiPct.toFixed(0)}% off a real base of ${peBaseOi.toLocaleString("en-IN")} — genuine crowding, watch for reversal risk`});
        else if(peOiPct!=null&&peOiPct>300&&!peBaseIsReal)strikeFlags.push({side:"PE",type:"THIN_SIGNAL",label:"🪶 Thin — low conviction",detail:`PE OI change ${peOiPct.toFixed(0)}% looks extreme but prior base was only ${(peBaseOi||0).toLocaleString("en-IN")} contracts — percentage is distorted by a near-zero starting point, not real exhaustion`});
      }
      // OI VELOCITY CHECK (2026-08-08, user-described mechanism): distinguishes a sudden vertical
      // OI spike in the most recent scan (retail/"dummy" momentum crowd piling in fast, likely to
      // exit just as fast, leaving late entrants trapped) from steady multi-scan accumulation
      // (real structural buying building gradually). Uses the last 3 stored scans (STRIKE_HISTORY
      // already retains up to 6, only Case comparison used them before -- raw OI/LTP across scans
      // sat unused). Additive only, separate flag from EXHAUSTION/SQUEEZE_URGENCY, does not modify
      // either -- purely a new, independently-checkable warning.
      if(history.length>=2){
        const peHist=history.slice(-2).map(h=>(h.rows||[]).find(r=>r.strike===row.strike)?.PE_oi).filter(v=>v!=null);
        peHist.push(row.PE_oi);
        if(peHist.length===3&&peHist[0]>0){
          const earlyMove=Math.abs((peHist[1]-peHist[0])/peHist[0]*100);
          const lateMove=peHist[1]>0?Math.abs((peHist[2]-peHist[1])/peHist[1]*100):0;
          if(lateMove>100&&earlyMove<lateMove*0.3){
            strikeFlags.push({side:"PE",type:"OI_SPIKE",label:"📈 Sudden OI Spike",detail:`PE OI jumped ${lateMove.toFixed(0)}% just this scan after being flat — looks like fast momentum money piling in, not steady buildup; likely to exit just as fast`});
          }
        }
      }
    }
    if((prevPe===1||prevPe===3)&&(peCase===4||peCase===3)&&row.PE_oi>=chainMinOi)strikeFlags.push({side:"PE",type:"WALL_CRACKING",label:"🧱 Wall Cracking",detail:`PE-side wall Case ${prevPe}→${peCase} — seller wall losing strength`});
    else if((prevPe===1||prevPe===3)&&(peCase===4||peCase===3)&&row.PE_oi<chainMinOi)strikeFlags.push({side:"PE",type:"THIN_SIGNAL",label:"🪶 Thin — low conviction",detail:`PE OI only ${row.PE_oi.toLocaleString("en-IN")} contracts (this stock's threshold: ${Math.round(chainMinOi).toLocaleString("en-IN")}) — too thin to trust as a real wall, excluded from Wall Cracking`});
    if(ceCase!=null){
      const ceBuying=ceCase===6||ceCase===2;
      const ceWasBuying=prevCe===6||prevCe===2;
      const ceSellingOrFading=ceCase===8||ceCase===5||ceCase===7;
      if(!ceWasBuying&&ceBuying)strikeFlags.push({side:"CE",type:"FRESH_SIGNAL",label:"🔥 Fresh Signal",detail:`CE Case ${ceCase} newly appearing${confluenceNote("CE")}`});
      if(ceWasBuying&&ceSellingOrFading)strikeFlags.push({side:"CE",type:"WEAKENING",label:"⚠️ Weakening",detail:`CE Case ${prevCe}→${ceCase} — buying conviction fading`});
      if(ceFlipping)strikeFlags.push({side:"CE",type:"CHOP_WARNING",label:"🌀 Chop Warning",detail:"CE case flipping across recent scans"});
      if(ceBuying&&ceUrgency>=8){
        if(ceFlipping){
          strikeFlags.push({side:"CE",type:"SQUEEZE_URGENCY",label:"🌪️ Squeeze Urgency — case unstable",detail:`CE urgency ${ceUrgency} but case has been flipping — likely a short-covering spike, not steady conviction; treat as fast in/out only`});
        }else{
          strikeFlags.push({side:"CE",type:"HIGH_URGENCY",label:"⚡ High Urgency",detail:`CE urgency ${ceUrgency}`});
        }
      }
      if(ceWasBuying&&ceBuying&&prevCeUrgency!=null&&ceUrgency<prevCeUrgency-3)strikeFlags.push({side:"CE",type:"FADING_URGENCY",label:"🐌 Fading Urgency",detail:`CE urgency dropped ${prevCeUrgency}→${ceUrgency}, case not yet flipped`});
      if(ceUnwindRisk)strikeFlags.push({side:"CE",type:"UNWIND_RISK",label:"🚨 Unwind Risk",detail:`CE OI falling (${ceOiPct.toFixed(1)}%) while LTP still rising (${ceLtpPct.toFixed(1)}%) — dominant side covering, reversal risk rising`});
      {
        const ceBaseOi=prevRow?prevRow.CE_oi:null;
        const ceBaseIsReal=ceBaseOi!=null&&ceBaseOi>=chainMinOi;
        if(ceOiPct!=null&&ceOiPct>300&&ceBaseIsReal)strikeFlags.push({side:"CE",type:"EXHAUSTION",label:"⚠️ Extreme — possible exhaustion",detail:`CE OI change ${ceOiPct.toFixed(0)}% off a real base of ${ceBaseOi.toLocaleString("en-IN")} — genuine crowding, watch for reversal risk`});
        else if(ceOiPct!=null&&ceOiPct>300&&!ceBaseIsReal)strikeFlags.push({side:"CE",type:"THIN_SIGNAL",label:"🪶 Thin — low conviction",detail:`CE OI change ${ceOiPct.toFixed(0)}% looks extreme but prior base was only ${(ceBaseOi||0).toLocaleString("en-IN")} contracts — percentage is distorted by a near-zero starting point, not real exhaustion`});
      }
      if(history.length>=2){
        const ceHist=history.slice(-2).map(h=>(h.rows||[]).find(r=>r.strike===row.strike)?.CE_oi).filter(v=>v!=null);
        ceHist.push(row.CE_oi);
        if(ceHist.length===3&&ceHist[0]>0){
          const earlyMove=Math.abs((ceHist[1]-ceHist[0])/ceHist[0]*100);
          const lateMove=ceHist[1]>0?Math.abs((ceHist[2]-ceHist[1])/ceHist[1]*100):0;
          if(lateMove>100&&earlyMove<lateMove*0.3){
            strikeFlags.push({side:"CE",type:"OI_SPIKE",label:"📈 Sudden OI Spike",detail:`CE OI jumped ${lateMove.toFixed(0)}% just this scan after being flat — looks like fast momentum money piling in, not steady buildup; likely to exit just as fast`});
          }
        }
      }
    }
    if(prevCe===1&&(ceCase===3||ceCase===4)&&row.CE_oi>=chainMinOi)strikeFlags.push({side:"CE",type:"WALL_CRACKING",label:"🧱 Wall Cracking",detail:`CE Case 1→${ceCase} — seller wall losing strength`});
    else if(prevCe===1&&(ceCase===3||ceCase===4)&&row.CE_oi<chainMinOi)strikeFlags.push({side:"CE",type:"THIN_SIGNAL",label:"🪶 Thin — low conviction",detail:`CE OI only ${row.CE_oi.toLocaleString("en-IN")} contracts (this stock's threshold: ${Math.round(chainMinOi).toLocaleString("en-IN")}) — too thin to trust as a real wall, excluded from Wall Cracking`});

    // Confidence tier: CLEAR / MIXED / STALE — answers "how much should I trust this right now", not just "what case is it"
    function computeTier(side,caseNow,urgencyNow,wasBuying,flipping,confirmedByMahesh){
      const buyingNow=caseNow===6||caseNow===2;
      if(!buyingNow)return null;
      // STALE: this side has been in a buying case for 3+ consecutive snapshots with urgency trending down each time — the early move is over
      const recentAll=history.map(h=>{
        const r=(h.rows||[]).find(rr=>rr.strike===row.strike);
        return r?{c:side==="PE"?r.peCase:r.ceCase,u:side==="PE"?r.peUrgency:r.ceUrgency}:null;
      }).filter(x=>x&&x.c!=null);
      const recent=recentAll.slice(-3);
      const allBuying=recent.length>=3&&recent.every(x=>x.c===6||x.c===2);
      // Strict monotonic deceleration: each successive urgency reading smaller than the one before it,
      // not just first-vs-last — catches a fade-recover-fade pattern the old first-vs-last check missed
      const urgencyDeclining=recent.length>=3&&recent.every((x,idx)=>idx===0||(x.u!=null&&recent[idx-1].u!=null&&x.u<recent[idx-1].u));
      if(allBuying&&urgencyDeclining)return"STALE";
      // MIXED: buying but internally contradicting itself — chop, or buying with negligible urgency (no real conviction behind it)
      if(flipping)return"MIXED";
      if(buyingNow&&urgencyNow<5)return"MIXED";
      // CLEAR: buying, real urgency, no chop — best case, extra credibility if Mahesh also agrees
      if(buyingNow&&urgencyNow>=8)return confirmedByMahesh?"CLEAR+":"CLEAR";
      return"MIXED";
    }

    // Mahesh cross-check: does a PE-side bearish-supporting flag line up with a CE-side flag confirming the same direction, same strike, same scan?
    const peBearishFlags=strikeFlags.filter(f=>f.side==="PE"&&(f.type==="FRESH_SIGNAL"||f.type==="HIGH_URGENCY"));
    const ceWeakFlags=strikeFlags.filter(f=>f.side==="CE"&&(f.type==="WEAKENING"||f.type==="WALL_CRACKING"));
    const ceBullishFlags=strikeFlags.filter(f=>f.side==="CE"&&(f.type==="FRESH_SIGNAL"||f.type==="HIGH_URGENCY"));
    const peWeakFlags=strikeFlags.filter(f=>f.side==="PE"&&(f.type==="WEAKENING"||f.type==="WALL_CRACKING"));
    const peMaheshOk=peBearishFlags.length&&ceWeakFlags.length;
    const ceMaheshOk=ceBullishFlags.length&&peWeakFlags.length;
    if(peMaheshOk){
      strikeFlags.push({side:"BOTH",type:"MAHESH_CONFIRMED",label:"🤝 Mahesh Confirmed",detail:`PE strength + CE weakness agree at ${row.strike} — bearish cross-check confirmed`});
    }else if(ceMaheshOk){
      strikeFlags.push({side:"BOTH",type:"MAHESH_CONFIRMED",label:"🤝 Mahesh Confirmed",detail:`CE strength + PE weakness agree at ${row.strike} — bullish cross-check confirmed`});
    }

    const peTier=computeTier("PE",peCase,peUrgency,prevPe===6||prevPe===2,peFlipping,!!peMaheshOk);
    const ceTier=computeTier("CE",ceCase,ceUrgency,prevCe===6||prevCe===2,ceFlipping,!!ceMaheshOk);
    const tierMeta={CLEAR:{label:"🟢 CLEAR",note:"fresh, confirmed, act on it"},"CLEAR+":{label:"🟢🤝 CLEAR+",note:"fresh, confirmed, Mahesh agrees — highest conviction"},MIXED:{label:"🟡 MIXED",note:"signal fighting itself — size down, tighter stop"},STALE:{label:"🔴 STALE",note:"move likely already happened — late entry risk"}};
    if(peTier)strikeFlags.push({side:"PE",type:"TIER_"+peTier.replace("+",""),label:tierMeta[peTier].label,detail:`PE confidence: ${tierMeta[peTier].note}`});
    if(ceTier)strikeFlags.push({side:"CE",type:"TIER_"+ceTier.replace("+",""),label:tierMeta[ceTier].label,detail:`CE confidence: ${tierMeta[ceTier].note}`});
    // KEI 6000 CE pattern: a strong standalone CLEAR/CLEAR+ tier at a LOW-proximity (far-OTM) strike is
    // genuine framework support — real fresh conviction, not a blind gamble — but it needs distinct
    // distance-risk treatment given how far price still has to travel. Doesn't require same-strike Mahesh
    // agreement, since the confirmed zone is often a different, closer strike (as it was for KEI: 5400).
    const _weight=proximityWeight(row.strike);
    const _awayNow=strikesAway(row.strike);
    if(_weight==="LOW"){
      if(peTier==="CLEAR"||peTier==="CLEAR+")strikeFlags.push({side:"PE",type:"FAR_OTM_SUPPORTED",label:"🎯 Far OTM — Supported",detail:`PE Case ${peCase} genuinely fresh at ${row.strike}, ${_awayNow} strikes from spot — real setup, not a gamble, but needs tighter partial-profit discipline given the distance`});
      if(ceTier==="CLEAR"||ceTier==="CLEAR+")strikeFlags.push({side:"CE",type:"FAR_OTM_SUPPORTED",label:"🎯 Far OTM — Supported",detail:`CE Case ${ceCase} genuinely fresh at ${row.strike}, ${_awayNow} strikes from spot — real setup, not a gamble, but needs tighter partial-profit discipline given the distance`});
    }

    // RANGE_LOCK (2026-08-08): Call Case1 (seller wall holding) + Put Case5 (seller wall holding)
    // at the SAME strike simultaneously means sellers are winning on BOTH sides -- price is pinned
    // in range, not breaking either way. Distinct from the existing Mahesh conflict/wait rule
    // (which checks Case2 vs Case6 disagreement, i.e. both sides showing BUYING conviction that
    // contradicts each other) -- this is the opposite scenario, both sides showing SELLING/wall
    // conviction that reinforces a stuck range. Same tier as Squeeze/Exhaustion/Thin -- suppresses
    // signal generation, wired into scoreSignal()'s hard-block check alongside those three.
    if(ceCase===1&&peCase===5){
      strikeFlags.push({side:"CE",type:"RANGE_LOCK",label:"🔒 Range Lock",detail:`Call wall (Case 1) and Put wall (Case 5) both holding at ${row.strike} — sellers winning both sides, market pinned in range`});
      strikeFlags.push({side:"PE",type:"RANGE_LOCK",label:"🔒 Range Lock",detail:`Call wall (Case 1) and Put wall (Case 5) both holding at ${row.strike} — sellers winning both sides, market pinned in range`});
    }
    if(strikeFlags.length){
      const weight=proximityWeight(row.strike);
      const away=strikesAway(row.strike);
      strikeFlags.forEach(f=>{f.proximity=weight;f.strikesAway=away;f.usingBaseline=usingBaseline;if(usingBaseline)f.detail+=" [day-baseline, first scan]";});
      flags.push({strike:row.strike,proximity:weight,strikesAway:away,usingBaseline,flags:strikeFlags});
      strikeFlags.forEach(f=>{
        STRIKE_FLAG_LOG.push({ts:now,symbol,strike:row.strike,side:f.side,type:f.type,label:f.label,detail:f.detail,proximity:weight,strikesAway:away,usingBaseline,outcome:null});
      });
    }
  });

  // PSYCHOLOGY/DISCIPLINE LAYER: Strike-rank check -- when multiple strikes in the same chain
  // show a buying Case (2 or 6) on the same side, rank them by LTP% momentum so the strongest
  // is clearly distinguished from weaker/laggard strikes on the same side, instead of every
  // Case-2/6 strike looking equally actionable. Additive only -- does not change any Case
  // classification or existing flag; UI can dim/de-emphasize rank > 2 per the original spec.
  ["PE","CE"].forEach(side=>{
    const candidates=[];
    flags.forEach(entry=>{
      const sideFlags=(entry.flags||[]).filter(f=>f.side===side);
      const hasBuyingCase=currentByStrike[entry.strike]&&(side==="PE"?currentByStrike[entry.strike].peCase:currentByStrike[entry.strike].ceCase);
      const caseVal=side==="PE"?currentByStrike[entry.strike]?.peCase:currentByStrike[entry.strike]?.ceCase;
      if(caseVal===2||caseVal===6){
        const row=chain.find(r=>r.strike===entry.strike);
        const ltpPct=row?(side==="PE"?pctChange(row.PE_ltp,(STRIKE_HISTORY[symbol]||[]).slice(-1)[0]?.rows?.find(rr=>rr.strike===entry.strike)?.PE_ltp||row.PE_ltp):pctChange(row.CE_ltp,(STRIKE_HISTORY[symbol]||[]).slice(-1)[0]?.rows?.find(rr=>rr.strike===entry.strike)?.CE_ltp||row.CE_ltp)):0;
        candidates.push({entry,ltpPct:ltpPct||0});
      }
    });
    candidates.sort((a,b)=>b.ltpPct-a.ltpPct);
    candidates.forEach((c,i)=>{
      c.entry.flags.forEach(f=>{if(f.side===side)f.strikeRank=i+1;});
    });
  });

  if(!STRIKE_HISTORY[symbol])STRIKE_HISTORY[symbol]=[];
  STRIKE_HISTORY[symbol].push({
    ts:now,
    rows:chain.map(row=>({strike:row.strike,CE_oi:row.CE_oi,CE_ltp:row.CE_ltp,PE_oi:row.PE_oi,PE_ltp:row.PE_ltp,ceCase:currentByStrike[row.strike]?.ceCase??null,peCase:currentByStrike[row.strike]?.peCase??null,ceUrgency:currentByStrike[row.strike]?.ceUrgency??null,peUrgency:currentByStrike[row.strike]?.peUrgency??null}))
  });
  if(STRIKE_HISTORY[symbol].length>STRIKE_HISTORY_MAX)STRIKE_HISTORY[symbol].shift();
  saveStrikeHistory();
  if(flags.length)saveStrikeFlagLog();

  return flags;
}

app.post("/flag-outcome",(req,res)=>{
  const{symbol:sym,strike:strk,type:typ,ts:tsVal,outcome:out}=req.body;
  if(!sym||!strk||!typ||!tsVal||!out)return res.status(400).json({status:false,message:"symbol, strike, type, ts, outcome required"});
  const entry=STRIKE_FLAG_LOG.find(f=>f.symbol===sym&&f.strike===strk&&f.type===typ&&f.ts===tsVal);
  if(!entry)return res.status(404).json({status:false,message:"Flag entry not found"});
  entry.outcome=out;
  saveStrikeFlagLog();
  log(`Flag outcome tagged: ${sym} ${strk} ${typ} = ${out}`,"INFO");
  res.json({status:true,message:"Outcome saved"});
});

app.get("/flag-log",(req,res)=>{
  const{symbol:sym,limit:lim}=req.query;
  let entries=STRIKE_FLAG_LOG;
  if(sym)entries=entries.filter(f=>f.symbol===String(sym).toUpperCase());
  const n=lim?parseInt(lim):100;
  res.json({status:true,count:entries.length,entries:entries.slice(-n).reverse()});
});
// ===== End Case-transition flag engine =====

app.post("/oi-analysis",async(e,t)=>{
  if(!isAuthenticated())return t.status(401).json({status:!1,message:"Not authenticated"});
  // MARKET HOURS GATE for OI
  const ms=marketStatus();
  if(!ms.open){
    log(`OI analysis blocked — market ${ms.code}`,"WARN");
    return t.status(400).json({status:!1,message:`Market is ${ms.label} — OI data will be stale. Scan only between 9:15 AM and 3:30 PM IST.`,marketStatus:ms});
  }
  const{symbol:a,spotPrice:s,expiry:n,rsi:rsiVal,aboveVwap:aboveVwapVal,clientPriorChain}=e.body;
  if(!a||!s)return t.status(400).json({status:!1,message:"symbol and spotPrice required"});
  const o=n||getExpiryType(a);
  // Real fix: OI chain data is identical regardless of which side (CE/PE) is being scored,
  // but scanSymbol() calls /signal-analysis once per side, each independently re-fetching
  // this same data -- confirmed real, measurable duplication. Short-lived cache (15s, well
  // under the 25s scan-cycle interval and the CE-then-PE gap within one stock's scan) lets
  // the second call reuse the first's real result instead of hitting Angel One again.
  const _oiCacheKey=a.toUpperCase()+"|"+o;
  const _oiCached=OI_CACHE[_oiCacheKey];
  if(_oiCached && Date.now()-_oiCached.fetchTime<OI_CACHE_TTL){
    return t.json(_oiCached.data);
  }
  try{await ensureInstruments("OI analysis");const i=a.toUpperCase(),l=parseFloat(s),c=new Date,u={JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};function r(e){if(!e)return null;const t=String(e).trim().toUpperCase(),a=t.match(/^(\d{1,2})([A-Z]{3})(\d{4})$/);if(a){const e=u[a[2]];if(void 0!==e)return new Date(+a[3],e,+a[1])}const s=t.match(/^(\d{4})(\d{2})(\d{2})$/);if(s)return new Date(+s[1],+s[2]-1,+s[3]);const n=t.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(n)return new Date(+n[1],+n[2]-1,+n[3]);const o=new Date(e);return isNaN(o)?null:o}// Use 3:30 PM IST as expiry cutoff (not midnight) so today's contracts included until close
const _expiryEnd=new Date(c);_expiryEnd.setHours(15,30,0,0);
const p=SESSION._instruments.filter(e=>{if("NFO"!==e.exch_seg)return!1;if(!e.instrumenttype||!e.instrumenttype.includes("OPT"))return!1;const t=r(e.expiry);if(!t)return!1;const _tEnd=new Date(t);_tEnd.setHours(15,30,0,0);if(_tEnd<c)return!1;if(e.name&&e.name.toUpperCase()===i)return!0;if(e.symbol){const t=e.symbol.toUpperCase();if(t.startsWith(i)&&t.length>i.length&&/\d/.test(t[i.length]))return!0}return!1});if(!p.length)return t.json({status:!1,message:`No NFO options for ${i}`});const d=[...new Set(p.map(e=>e.expiry))].map(e=>({raw:e,date:r(e)})).filter(e=>e.date&&e.date>=c).sort((e,t)=>e.date-t.date);let g;if("MONTHLY"===o){
  const ge=c.getMonth(),me=c.getFullYear(),he=d.filter(e=>e.date.getMonth()===ge&&e.date.getFullYear()===me);
  g=(he[he.length-1]||d[0])?.raw;
}else if("NEXT_MONTH"===o){
  const Se=(c.getMonth()+1)%12,Ee=11===c.getMonth()?c.getFullYear()+1:c.getFullYear(),fe=d.filter(e=>e.date.getMonth()===Se&&e.date.getFullYear()===Ee);
  // Real fix (2026-08-24): previously silently fell back to d[1]/d[0] -- the NEAREST
  // (often current-month) expiry -- if next month's contracts weren't listed yet by
  // Angel One. That meant a genuine data gap could serve the WRONG (old) month with
  // zero error surfaced, exactly the bug the user hit on rollover day for INFY. Now:
  // if next month truly has no listed contracts, fail loudly instead of guessing.
  if(!fe.length){
    log(`NEXT_MONTH requested for ${i} but no ${Se+1}/${Ee} contracts found in instrument master -- refusing to silently fall back to current month`,"ERROR");
    return t.json({status:!1,message:`Next month's option chain for ${i} is not yet available from the exchange. Try again shortly.`});
  }
  g=fe[fe.length-1].raw;
  log(`NEXT_MONTH expiry selected: ${g}`,"INFO");
}else if("NIFTY_NEXT_WEEKLY"===o){
  // Next Tuesday's contract — skip today's expiry, take next available Tuesday
  const nowDay=c.getDay(); // 2=Tuesday
  const daysToNext=nowDay===2?7:(2-nowDay+7)%7||7;
  const nextTue=new Date(c);nextTue.setDate(c.getDate()+daysToNext);nextTue.setHours(0,0,0,0);
  const nextTuePlusTol=new Date(nextTue);nextTuePlusTol.setDate(nextTue.getDate()+1);
  // Find contract with expiry closest to next Tuesday
  const weeklyMatch=d.filter(e=>e.date>=nextTue&&e.date<nextTuePlusTol);
  g=(weeklyMatch[0]||d.find(e=>e.date>c)||d[0])?.raw;
  log(`NIFTY_NEXT_WEEKLY expiry selected: ${g}`,"INFO");
}else if("NIFTY_WEEKLY"===o){
  // Current week's NIFTY contract
  g=d[0]?.raw;
  log(`NIFTY_WEEKLY expiry selected: ${g}`,"INFO");
}else{
  g="NEXT"===o?(d[1]||d[0])?.raw:d[0]?.raw;
}if(!g)return t.json({status:!1,message:"No valid expiry"});const m=p.filter(e=>e.expiry===g),h=[...new Set(m.map(e=>Math.round(parseFloat(e.strike)/100)))].filter(e=>e>0).sort((e,t)=>e-t),S=h.reduce((e,t)=>Math.abs(t-l)<Math.abs(e-l)?t:e,h[0]),E=h.indexOf(S),f=10,I=h.slice(Math.max(0,E-f),E+f+1),N=[],A={};for(const Ie of I){const Ne=100*Ie,Ae=m.filter(e=>Math.round(parseFloat(e.strike))===Ne&&e.symbol?.toUpperCase().endsWith("CE")),ke=m.filter(e=>Math.round(parseFloat(e.strike))===Ne&&e.symbol?.toUpperCase().endsWith("PE"));Ae[0]?.token&&(N.push(String(Ae[0].token)),A[String(Ae[0].token)]={strike:Ie,type:"CE"}),ke[0]?.token&&(N.push(String(ke[0].token)),A[String(ke[0].token)]={strike:Ie,type:"PE"})}const k={},C=50;for(let Ce=0;Ce<N.length;Ce+=C){const Oe=N.slice(Ce,Ce+C);try{const Te=await angelRequest("POST",`${ANGEL_API}/rest/secure/angelbroking/market/v1/quote/`,{mode:"FULL",exchangeTokens:{NFO:Oe}});Te.data.status&&Te.data.data?.fetched&&Te.data.data.fetched.forEach(e=>{const t=A[String(e.symbolToken)];t&&(k[t.strike]||(k[t.strike]={}),k[t.strike][t.type]={ltp:parseFloat(e.ltp||e.close||0),oi:parseInt(e.opnInterest||e.openInterest||e.oi||0),oiChange:parseInt(e.netChangeOI||e.netChange||e.oiChange||0),volume:parseInt(e.tradeVolume||e.volume||0),prevClose:parseFloat(e.close||e.previousClose||0)})})}catch(ye){log(`OI batch fetch error: ${ye.message}`,"WARN")}}
  const exInfo=getExpiryWeekInfo(i);
  const thMul=exInfo.thresholdMultiplier;
  const O=I.map(e=>({strike:e,isATM:e===S,CE_ltp:k[e]?.CE?.ltp??null,CE_oi:k[e]?.CE?.oi??0,CE_oiChange:k[e]?.CE?.oiChange??0,CE_vol:k[e]?.CE?.volume??0,CE_prevClose:k[e]?.CE?.prevClose??null,PE_ltp:k[e]?.PE?.ltp??null,PE_oi:k[e]?.PE?.oi??0,PE_oiChange:k[e]?.PE?.oiChange??0,PE_vol:k[e]?.PE?.volume??0,PE_prevClose:k[e]?.PE?.prevClose??null,ceCase:classifyCase(k[e]?.CE?.oiChange??null,k[e]?.CE?.ltp&&k[e]?.CE?.prevClose?((k[e].CE.ltp-k[e].CE.prevClose)/k[e].CE.prevClose*100):null),peCase:classifyCase(k[e]?.PE?.oiChange??null,k[e]?.PE?.ltp&&k[e]?.PE?.prevClose?((k[e].PE.ltp-k[e].PE.prevClose)/k[e].PE.prevClose*100):null)})),T=O.reduce((e,t)=>e+(t.CE_oi||0),0),y=O.reduce((e,t)=>e+(t.PE_oi||0),0),w=T>0?parseFloat((y/T).toFixed(3)):null,b=null===w?"NEUTRAL":w>1.3?"BULLISH":w<.7?"BEARISH":"NEUTRAL",_=calcMaxPain(O),F=O.length>1?Math.abs(O[1].strike-O[0].strike):5,R=O.filter(e=>e.strike>S),x=O.filter(e=>e.strike<S),P=O.find(e=>e.strike===S)||{},L=R.map(e=>({strike:e.strike,oi:e.CE_oi,change:e.CE_oiChange})).sort((e,t)=>t.oi-e.oi),D=L[0]||null,$=R.reduce((e,t)=>e+(t.CE_oi||0),0),M=x.map(e=>({strike:e.strike,oi:e.PE_oi,change:e.PE_oiChange})).sort((e,t)=>t.oi-e.oi),U=M[0]||null,v=x.reduce((e,t)=>e+(t.PE_oi||0),0),B=x.map(e=>({strike:e.strike,oi:e.CE_oi,change:e.CE_oiChange})).sort((e,t)=>t.oi-e.oi).reduce((e,t)=>e+(t.oi||0),0),j=B>.3*$,H=R.map(e=>({strike:e.strike,oi:e.PE_oi,change:e.PE_oiChange})).sort((e,t)=>t.oi-e.oi).reduce((e,t)=>e+(t.oi||0),0),V=H>.3*v,W=(T+y)/(2*O.length||1),G=D&&D.oi>1.5*W*thMul,X=U&&U.oi>1.5*W*thMul,K=!D||D.oi<.7*W*thMul,Y=!U||U.oi<.7*W*thMul;let q="NEUTRAL",J="";G&&Y?(q="PE",J=`High CE ceiling (${D?.oi?.toLocaleString("en-IN")}) + weak PE floor = price free to fall`):X&&K?(q="CE",J=`High PE floor (${U?.oi?.toLocaleString("en-IN")}) + weak CE ceiling = price free to rise`):G&&X?(q="AVOID",J="Both sides strong = price trapped = avoid"):(q="NEUTRAL",J="No clear OI dominance");const Z=O.filter(e=>e.strike>=S-2*F&&e.strike<=S+2*F).reduce((e,t)=>e+(t.PE_oiChange||0),0)/4,z=O.filter(e=>e.strike>=S-2*F&&e.strike<=S+2*F).reduce((e,t)=>e+(t.CE_oiChange||0),0)/4,Q=Z>50&&"BEARISH"!==b,ee=z>50&&"BULLISH"!==b,te=(()=>{const e=z>5,t="BULLISH"===b;return e&&!t?{signal:"SHORT_BUILDUP",action:"BUY_PE",note:"Ramesh adding ceiling — bearish"}:e&&t?{signal:"LONG_BUILDUP",action:"CAUTION",note:"Both adding — uncertain"}:e||t?!e&&t?{signal:"SHORT_COVERING",action:"BUY_CE",note:"Ramesh RUNNING — buy CE fast!"}:{signal:"NEUTRAL",action:"WAIT",note:"No clear signal"}:{signal:"LONG_UNWINDING",action:"HOLD_CE",note:"Ramesh booking profit"}})(),ae=(()=>{const e=Z>5,t="BEARISH"===b;return e&&t?{signal:"LONG_BUILDUP",action:"BUY_CE",note:"Suresh adding floor — bullish"}:e&&!t?{signal:"PUT_TRAP",action:"AVOID_PE",note:"⚠️ PUT TRAP! Suresh collecting premium!"}:!e&&t?{signal:"LONG_UNWINDING",action:"HOLD_CE",note:"Suresh booking profit"}:e||t?{signal:"NEUTRAL",action:"WAIT",note:"No clear signal"}:{signal:"PUT_COVERING",action:"BUY_PE",note:"Suresh RUNNING — buy PE fast!"}})();let se="NEUTRAL",ne=0,oe=[];"CE"===q?(ne+=40,se="CE",oe.push(`Formula: ${J}`)):"PE"===q?(ne+=40,se="PE",oe.push(`Formula: ${J}`)):"AVOID"===q&&oe.push("Formula: Both trapped — avoid"),("BUY_CE"===te.action&&"PE"!==se||"BUY_PE"===te.action&&"CE"!==se)&&(ne+=20,oe.push(`CE: ${te.note}`)),("BUY_CE"===ae.action&&"CE"===se||"BUY_PE"===ae.action&&"PE"===se)&&(ne+=20,oe.push(`PE: ${ae.note}`)),"PE"===se&&Q&&(ne-=30,oe.push("⚠️ PUT TRAP risk detected!")),"CE"===se&&ee&&(ne-=30,oe.push("⚠️ CALL TRAP risk detected!")),"CE"===se&&j&&(ne+=20,oe.push("Ramesh trapped below = short covering likely")),"PE"===se&&V&&(ne+=20,oe.push("Suresh trapped above = put covering likely"));
// MARICO-pattern Mahesh bonus: checks near-spot strikes (within 2 gaps) for genuine two-sided price
// conviction -- Call OI up + Call LTP falling (writers winning) on one side, Put OI up + Put LTP rising
// (buyers winning) on the other, at the SAME zone. This can fire even when the OI-magnitude Formula
// above lands NEUTRAL/AVOID, since that check only measures dominance size, not whether both sides are
// showing real opposing price conviction near spot -- which is the stronger, more actionable pattern.
const nearStrikes=O.filter(e=>Math.abs(e.strike-S)<=2*F);
const ceWeakening=nearStrikes.filter(e=>(e.CE_oiChange||0)>20&&e.CE_prevClose&&e.CE_ltp&&e.CE_ltp<e.CE_prevClose*0.9).length;
const peStrengthening=nearStrikes.filter(e=>(e.PE_oiChange||0)>20&&e.PE_prevClose&&e.PE_ltp&&e.PE_ltp>e.PE_prevClose*1.05).length;
const peWeakening=nearStrikes.filter(e=>(e.PE_oiChange||0)>20&&e.PE_prevClose&&e.PE_ltp&&e.PE_ltp<e.PE_prevClose*0.9).length;
const ceStrengthening=nearStrikes.filter(e=>(e.CE_oiChange||0)>20&&e.CE_prevClose&&e.CE_ltp&&e.CE_ltp>e.CE_prevClose*1.05).length;
if("PE"===se&&ceWeakening>=2&&peStrengthening>=1){ne+=15;oe.push(`Mahesh: Call wall weakening (${ceWeakening} strikes) + Put floor building (${peStrengthening} strikes) near spot — cross-confirmed`);}
else if("CE"===se&&peWeakening>=2&&ceStrengthening>=1){ne+=15;oe.push(`Mahesh: Put floor weakening (${peWeakening} strikes) + Call wall building (${ceStrengthening} strikes) near spot — cross-confirmed`);}
ne=Math.max(0,Math.min(100,ne));if(exInfo.isNSEExpiryWeek){oe.push(`⚠️ Expiry week (${exInfo.daysToNSEExpiry}d left) — OI thresholds tighter, gamma elevated`);}
  const re=ne>=70?"STRONG":ne>=50?"MODERATE":ne>=30?"WEAK":"AVOID",ie=R.filter(e=>e.CE_oi>0).sort((e,t)=>e.strike-t.strike)[0]?.strike||null,le=x.filter(e=>e.PE_oi>0).sort((e,t)=>t.strike-e.strike)[0]?.strike||null,ceMinOi=minOiThreshold(W),ce=L.slice(0,3).map(e=>({strike:e.strike,oi:e.oi,oiChange:e.change,strength:e.oi<ceMinOi?"THIN":e.oi>2*W?"STRONG":e.oi>W?"MEDIUM":"WEAK"})),ue=M.slice(0,3).map(e=>({strike:e.strike,oi:e.oi,oiChange:e.change,strength:e.oi<ceMinOi?"THIN":e.oi>2*W?"STRONG":e.oi>W?"MEDIUM":"WEAK"})),pe=O.map(e=>({strike:e.strike,pcr:e.CE_oi>0?parseFloat((e.PE_oi/e.CE_oi).toFixed(2)):null,CE_oi:e.CE_oi,PE_oi:e.PE_oi,CE_change:e.CE_oiChange,PE_change:e.PE_oiChange,position:e.strike>S?"ABOVE":e.strike<S?"BELOW":"ATM",rameshStrength:e.CE_oi<ceMinOi?"THIN":e.CE_oi>1.5*W?"STRONG":e.CE_oi>.7*W?"MEDIUM":"WEAK",sureshStrength:e.PE_oi<ceMinOi?"THIN":e.PE_oi>1.5*W?"STRONG":e.PE_oi>.7*W?"MEDIUM":"WEAK"}));
  // Detect gamma blast
  const exInfoForGamma=getExpiryWeekInfo(i);
  // Pass real VIX from cache if available
  const _vixForGamma=VIX_CACHE.data&&VIX_CACHE.data.vix?VIX_CACHE.data.vix:null;
  const _isIndexSym=["NIFTY","BANKNIFTY","FINNIFTY","MIDCPNIFTY","SENSEX","BANKEX"].includes(i);
const gbResult=detectGammaBlast({spotPrice:l,atmStrike:S,atmCeOI:P.CE_oi||0,atmPeOI:P.PE_oi||0,totalCeOI:T,totalPeOI:y},exInfoForGamma,_vixForGamma,_isIndexSym);
  const oiResult={status:!0,symbol:i,expiry:g,atmStrike:S,spotPrice:l,pcr:w,pcrBias:b,maxPain:_,totalCeOI:T,totalPeOI:y,chain:O,nearMaxPain:!!_&&Math.abs(l-_)/l<.01,nearSupport:!!le&&Math.abs(l-le)/l<.005,nearResistance:!!ie&&Math.abs(l-ie)/l<.005,supportStrike:le,resistStrike:ie,ceWalls:ce,peFloors:ue,rameshTrapped:j,sureshTrapped:V,rameshTrappedOI:B,sureshTrappedOI:H,dilipFormula:q,dilipFormulaNote:J,ceSignal:te,peSignal:ae,putTrapRisk:Q,callTrapRisk:ee,oiRecommendation:se,oiScore:ne,oiVerdict:re,oiNotes:oe,strikePCR:pe,atmCeOI:P.CE_oi||0,atmPeOI:P.PE_oi||0,atmPCR:P.CE_oi>0?parseFloat((P.PE_oi/P.CE_oi).toFixed(2)):null,oiBattleBias:"CE"===se?"BULLISH":"PE"===se?"BEARISH":"NEUTRAL",oiBattleSummary:oe,expiryWeek:exInfo.isNSEExpiryWeek,daysToExpiry:exInfo.daysToNSEExpiry,gammaWarning:exInfo.gammaWarning,gammaBlast:gbResult};
  OI_CACHE[_oiCacheKey]={data:oiResult,fetchTime:Date.now()};
  // Save OI snapshot for trend tracking
  // Mahesh confirmation: OI direction + LTP direction at Ramesh wall / Suresh floor
  try{
    const wallStrikeData = D ? O.find(e=>e.strike===D.strike) : null;
    const floorStrikeData = U ? O.find(e=>e.strike===U.strike) : null;
    const wallLtpUp = wallStrikeData && wallStrikeData.CE_ltp!=null && wallStrikeData.CE_prevClose!=null ? wallStrikeData.CE_ltp > wallStrikeData.CE_prevClose : null;
    const floorLtpUp = floorStrikeData && floorStrikeData.PE_ltp!=null && floorStrikeData.PE_prevClose!=null ? floorStrikeData.PE_ltp > floorStrikeData.PE_prevClose : null;
    const wallOiRising = D ? D.change > 0 : null;
    const floorOiRising = U ? U.change > 0 : null;
    let maheshWall = "UNKNOWN", maheshFloor = "UNKNOWN";
    if(wallOiRising===true && wallLtpUp===false) maheshWall = "CONFIRMED_WALL";
    else if(wallOiRising===true && wallLtpUp===true) maheshWall = "WALL_UNDER_PRESSURE";
    else if(wallOiRising===false) maheshWall = "WALL_BREAKING";
    if(floorOiRising===true && floorLtpUp===true) maheshFloor = "CONFIRMED_FLOOR";
    else if(floorOiRising===true && floorLtpUp===false) maheshFloor = "FLOOR_NOT_TRUSTED";
    else if(floorOiRising===false) maheshFloor = "FLOOR_BREAKING";
    oiResult.maheshWall = maheshWall;
    oiResult.maheshFloor = maheshFloor;
  }catch(maheshErr){ log(`Mahesh check skipped: ${maheshErr.message}`,"WARN"); }

  saveOISnapshot(i, oiResult);

  // Case-transition flags (additive) — isolated so any failure here never breaks the main scan
  try{
    // If the server has no memory of this symbol (fresh restart/redeploy wiped STRIKE_HISTORY) but the
    // client sent its own last-known scan (browser-cached, survives server restarts), seed history from
    // that instead of falling back to day-baseline — bridges exactly the Render free-tier disk-wipe gap.
    if((!STRIKE_HISTORY[i]||!STRIKE_HISTORY[i].length)&&clientPriorChain&&Array.isArray(clientPriorChain)&&clientPriorChain.length){
      const seedRows=clientPriorChain.filter(r=>r&&typeof r.strike==="number").map(r=>({strike:r.strike,CE_oi:r.CE_oi??0,CE_ltp:r.CE_ltp??null,PE_oi:r.PE_oi??0,PE_ltp:r.PE_ltp??null,ceCase:null,peCase:null,ceUrgency:null,peUrgency:null}));
      if(seedRows.length){
        STRIKE_HISTORY[i]=[{ts:Date.now()-6e4,rows:seedRows}];
        log(`Seeded ${i} history from client cache — ${seedRows.length} strikes (server memory was empty)`,"INFO");
      }
    }
    oiResult.strikeFlags=computeStrikeFlags(i,O,{rsi:rsiVal,aboveVwap:aboveVwapVal},S);
  }catch(flagErr){
    log(`Strike flag computation skipped: ${flagErr.message}`,"WARN");
    oiResult.strikeFlags=[];
  }

  log(`OI ${i}: PCR=${w} OIRec=${se} Score=${ne} Formula=${q} ExpiryWk=${exInfo.isNSEExpiryWeek}`,"INFO");
  t.json(oiResult)}catch(we){const be=we.response?.data?.message||we.message;log(`OI analysis error: ${be}`,"WARN"),t.status(500).json({status:!1,message:be})}})

// gammaBlast removed from stock scoring per user request (2026-08-08) -- it's an index/expiry-week
// specific setup, not meaningful for general individual-stock signal scoring. Weight set to 0
// rather than deleting the block, so gammaBlast data can still be computed/displayed elsewhere
// without contributing to the score or shifting MAX_SCORE's meaning for any other component.
const SIGNAL_WEIGHTS={marketBias:15,supertrend:8,rsi:8,macd:4,aboveVwap:8,orbBreakout:6,volumeConfirm:10,newsSentiment:0,geoRisk:0,oiMomentum:18,gammaBlast:0,dilipOIFormula:23},MAX_SCORE=Object.values(SIGNAL_WEIGHTS).reduce((e,t)=>e+t,0);
function scoreSignal(e,t){const a="CE"===t,s={};let n=!1,o="";null!==e.vixValue&&e.vixValue>=30&&(n=!0,o=`India VIX at ${e.vixValue} — extreme panic, avoid directional trades`);
  // REMOVED PER EXPLICIT USER DECISION (2026-08-13): the squeeze/exhaustion/thin 2-of-3 hard
  // block and the RANGE_LOCK standalone block (both originally added 2026-08-08 after the PGEL
  // loss) were found by the user to be contributing to a broader "no signals appearing" problem.
  // After discussion of alternatives (require 3-of-3, or convert to a score penalty instead of a
  // full block), user explicitly chose full removal of this gate. SQUEEZE_URGENCY, EXHAUSTION,
  // THIN_SIGNAL, and RANGE_LOCK flags themselves are UNCHANGED and still compute/display normally
  // on cards (still visible in strikeFlags) -- only their consequence of blocking scoreSignal()
  // outright has been removed. STALE_MOVE and CHOP_RANGE (added same day as this gate, but not
  // targeted by this request) are untouched below.
  // STALE_MOVE (2026-08-08, hard-block REMOVED 2026-08-20 per user decision): originally blocked
  // scoreSignal() outright when staleMove was true and the Case read as fresh buying, on the theory
  // that a Case2/6 read after the big move already happened was exhaustion, not fresh entry. User
  // flagged the real problem with this: a stock that looks "stale" by this narrow 2-window candle-
  // range check can still turn into a genuinely good signal shortly after -- the hard block was
  // silently preventing the scan from ever surfacing it at all, same failure mode as the earlier
  // Squeeze/Exhaustion/Thin/RANGE_LOCK removal above. staleMove is still computed on every scan and
  // still shown on cards (via strikeFlags / the STALE tier badge in the UI) so the information isn't
  // lost -- it just no longer prevents the signal from being generated and scored.
  // (Block intentionally removed -- do not re-add without a fresh explicit decision.)
  // CHOP_RANGE (2026-08-08): a chopping/range-bound stock (low net-move efficiency vs total range
  // over the last ~20 candles) has much lower edge than the same Case score on a genuinely
  // trending stock. Per user spec: "reduce confidence / suggest skip even if Case is valid" --
  // implemented as a moderate score penalty rather than a full hard block, since a valid Case can
  // still occasionally break out of a chop zone; a full block would be too aggressive here.
  let chopPenalty=0,chopNote="";
  if(!n&&e.chopRange){chopPenalty=0.15;chopNote=" Stock has been choppy/range-bound over recent candles (low trend efficiency) -- confidence reduced, consider skipping even though the Case itself qualifies.";}{const t=SIGNAL_WEIGHTS.marketBias;let n=0,o="";a?"BULLISH"===e.bias?(n=t,o="EMA bullish trend ✓"):"NEUTRAL"===e.bias?(n=.5*t,o="EMA neutral — partial"):(n=0,o="EMA bearish — against CE"):"BEARISH"===e.bias?(n=t,o="EMA bearish trend ✓"):"NEUTRAL"===e.bias?(n=.5*t,o="EMA neutral — partial"):(n=0,o="EMA bullish — against PE"),s.marketBias={earned:n,max:t,pass:n>=.5*t,note:o}}{const t=SIGNAL_WEIGHTS.supertrend;if(e.supertrend){const n="UP"===e.supertrend.trend,o=e.supertrend.signal===(a?"BUY":"SELL");let r=0,i="";a?n&&o?(r=t,i="Supertrend UP + fresh BUY signal ✓✓"):n?(r=.7*t,i="Supertrend UP ✓"):(r=0,i="Supertrend DOWN — against CE"):!n&&o?(r=t,i="Supertrend DOWN + fresh SELL signal ✓✓"):n?(r=0,i="Supertrend UP — against PE"):(r=.7*t,i="Supertrend DOWN ✓"),s.supertrend={earned:r,max:t,pass:r>0,note:i}}else s.supertrend={earned:.5*t,max:t,pass:null,note:"No data — neutral"}}{const t=SIGNAL_WEIGHTS.rsi,n=e.rsi||50;let o=0,r="";a?n<35?(o=t,r=`RSI ${n} — oversold, strong CE`):n<45?(o=.8*t,r=`RSI ${n} — below midline`):n<60?(o=.6*t,r=`RSI ${n} — neutral`):n<70?(o=.3*t,r=`RSI ${n} — elevated, caution`):(o=0,r=`RSI ${n} — overbought`):n>65?(o=t,r=`RSI ${n} — overbought, strong PE`):n>55?(o=.8*t,r=`RSI ${n} — above midline`):n>40?(o=.6*t,r=`RSI ${n} — neutral`):n>30?(o=.3*t,r=`RSI ${n} — low, caution`):(o=0,r=`RSI ${n} — oversold`),s.rsi={earned:o,max:t,pass:o>=.4*t,note:r}}{const t=SIGNAL_WEIGHTS.macd;if(e.macd){let n=0,o="";const r=e.macd.aboveSignal,i=e.macd.crossover;a?"BULLISH"===i?(n=t,o="MACD fresh bullish crossover ✓✓"):r?(n=.6*t,o="MACD above signal ✓"):"BEARISH"===i?(n=0,o="MACD fresh bearish cross — bad"):(n=.2*t,o="MACD below signal, weak"):"BEARISH"===i?(n=t,o="MACD fresh bearish crossover ✓✓"):r?"BULLISH"===i?(n=0,o="MACD fresh bullish cross — bad"):(n=.2*t,o="MACD above signal, weak"):(n=.6*t,o="MACD below signal ✓"),s.macd={earned:n,max:t,pass:n>=.5*t,note:o}}else s.macd={earned:.5*t,max:t,pass:null,note:"No data — neutral"}}{const n=SIGNAL_WEIGHTS.aboveVwap;if(null===e.aboveVwap)s.aboveVwap={earned:.5*n,max:n,pass:null,note:"VWAP data unavailable"};else{const o=a?e.aboveVwap:!e.aboveVwap;s.aboveVwap={earned:o?n:0,max:n,pass:o,note:o?`Price ${a?"above":"below"} VWAP ✓`:`Price ${a?"below":"above"} VWAP — against ${t}`}}}{const t=SIGNAL_WEIGHTS.orbBreakout,n=a?e.orb_high:e.orb_low;const _orbNow=new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Kolkata"}));
const orbHour=_orbNow.getHours(),orbMin=_orbNow.getMinutes();
const preORB=(orbHour<9)||(orbHour===9&&orbMin<30); // before 9:30 AM
const orbNextMonth=typeof e.daysToExpiry==="number"&&e.daysToExpiry>5;
if(null===n){
  if(preORB){s.orbBreakout={earned:0,max:t,pass:null,note:"Pre 9:30 AM — ORB not set yet (0 pts)"};}
  else{s.orbBreakout={earned:orbNextMonth?Math.round(.5*t):Math.round(.3*t),max:t,pass:null,note:orbNextMonth?"ORB neutral — next month contract":"ORB not confirmed"};}
}else{const o=a?e.ltp>n:e.ltp<n,r=a?e.ltp>.997*n&&e.ltp<=n:e.ltp<1.003*n&&e.ltp>=n;let i=o?t:r?.4*t:0;s.orbBreakout={earned:i,max:t,pass:o,note:o?`ORB ${a?"breakout":"breakdown"} confirmed ✓`:r?"Approaching ORB level — watch":"No ORB "+(a?"breakout":"breakdown")}}}{const t=SIGNAL_WEIGHTS.volumeConfirm,a=e.volRatio||1;let n=0,o="";
// On expiry day scanning next-month contracts, volume is naturally thin — give neutral
const isNextMonth=typeof e.daysToExpiry==="number"&&e.daysToExpiry>5;
if(isNextMonth&&a<0.8){n=Math.round(.5*t);o=`Volume ${a}x — low but next-month contract (expiry day) — neutral`;s.volumeConfirm={earned:n,max:t,pass:null,note:o};}
else{
  // Base score from volRatio
  let base=0,baseNote="";
  a>=2?(base=t*0.5,baseNote=`Vol ${a}x surge ✓✓`):a>=1.5?(base=t*0.4,baseNote=`Vol ${a}x strong ✓`):a>=1.2?(base=t*0.3,baseNote=`Vol ${a}x above avg`):a>=0.8?(base=t*0.15,baseNote=`Vol ${a}x average`):(base=0,baseNote=`Vol ${a}x low`);
  // Bonus: Vol + Price direction MATCH
  const vpDir=e.volPriceDir||"NEUTRAL";
  let dirBonus=0,dirNote="";
  if(vpDir==="MATCH"){dirBonus=t*0.35;dirNote=" + price direction match ✓✓";}
  else if(vpDir==="FAKE"){dirBonus=-(t*0.2);dirNote=" ⚠️ vol/price mismatch — fake move";}
  else{dirBonus=0;dirNote="";}
  // Penalty: Volume dry up
  const dryUp=e.volDryUp||false;
  let dryPenalty=0,dryNote="";
  if(dryUp){dryPenalty=-(t*0.3);dryNote=" ⚠️ Vol dry up — reversal risk";}
  // Bonus: OI buildup + volume surge (real OI)
  let oiVolBonus=0,oiVolNote="";
  if(a>=1.5&&e.oiVerdict&&e.oiVerdict!=="WEAK"){oiVolBonus=t*0.15;oiVolNote=" + OI+Vol confirmed ✓";}
  n=Math.min(Math.max(Math.round(base+dirBonus+dryPenalty+oiVolBonus),0),t);
  o=baseNote+dirNote+dryNote+oiVolNote;
  s.volumeConfirm={earned:n,max:t,pass:n>=t*0.4,note:o};
}}{const t=SIGNAL_WEIGHTS.newsSentiment,n=e.newsSentimentScore||50;let o=0,r="";a?n>=60?(o=t,r=`News bullish (${n}%) ✓`):n>=40?(o=.5*t,r=`News neutral (${n}%)`):(o=0,r=`News bearish (${n}%)`):n<=40?(o=t,r=`News bearish (${n}%) ✓`):n<=60?(o=.5*t,r=`News neutral (${n}%)`):(o=0,r=`News bullish (${n}%)`),s.newsSentiment={earned:o,max:t,pass:o>=.5*t,note:r}}{const t=SIGNAL_WEIGHTS.geoRisk,a=e.newsGeoRisk||0;let n=0,o="";0===a?(n=t,o="No geopolitical risk ✓"):a<=3?(n=.7*t,o=`Low geo risk (${a})`):a<=6?(n=.3*t,o=`Moderate geo risk (${a})`):(n=0,o=`High geo risk (${a}) — caution`),s.geoRisk={earned:n,max:t,pass:a<=6,note:o}}
// ── ATM DISTANCE scoring (bonus factor, not in weights — adjusts score quality)
// Adds up to 5 bonus points if spot is close to strike (ATM signal = higher probability)
{const spotPrice=e.ltp||0;const strikePrice=e.atmStrike||e.strike||0;
if(spotPrice>0&&strikePrice>0){
  const dist=Math.abs(spotPrice-strikePrice)/spotPrice*100;
  let atmBonus=0,atmNote="";
  if(dist<=0.5){atmBonus=5;atmNote=`ATM signal (${dist.toFixed(1)}% from strike) ✓✓`;}
  else if(dist<=1.5){atmBonus=3;atmNote=`Near ATM (${dist.toFixed(1)}% from strike) ✓`;}
  else if(dist<=3){atmBonus=1;atmNote=`Slightly OTM/ITM (${dist.toFixed(1)}% from strike)`;}
  else{atmBonus=0;atmNote=`Far from ATM (${dist.toFixed(1)}% from strike) — lower probability`;}
  s.atmDistance={earned:atmBonus,max:5,pass:dist<=2,note:atmNote};
}}
{
// OI MOMENTUM scoring — Ramesh/Suresh trend from OI history
const t=SIGNAL_WEIGHTS.oiMomentum;
const isCE=a;
const oiH=e.oiTrendData||null;
let omEarned=t*0.5,omNote="OI trend: no history yet — neutral";
if(oiH&&oiH.trend!=="INSUFFICIENT_DATA"){
  const tr=oiH.trend;
  if(isCE){
    if(tr==="BULLISH_MOMENTUM"){omEarned=t;omNote=`OI momentum BULLISH — ${oiH.sureshTrend} ✓✓`;}
    else if(tr==="BOTH_RUNNING_UNCERTAIN"){omEarned=Math.round(t*0.6);omNote="Both sides unwinding — uncertain but CE possible";}
    else if(tr==="BEARISH_MOMENTUM"){omEarned=0;omNote=`OI momentum BEARISH — ${oiH.rameshTrend} blocks CE`;}
    else if(tr==="BOTH_ADDING_TRAPPED"){omEarned=0;omNote="Both adding OI — price trapped, avoid CE";}
    else{omEarned=Math.round(t*0.4);omNote="OI trend mixed — partial CE";}
  }else{
    if(tr==="BEARISH_MOMENTUM"){omEarned=t;omNote=`OI momentum BEARISH — ${oiH.rameshTrend} ✓✓`;}
    else if(tr==="BOTH_RUNNING_UNCERTAIN"){omEarned=Math.round(t*0.6);omNote="Both sides unwinding — uncertain but PE possible";}
    else if(tr==="BULLISH_MOMENTUM"){omEarned=0;omNote=`OI momentum BULLISH — ${oiH.sureshTrend} blocks PE`;}
    else if(tr==="BOTH_ADDING_TRAPPED"){omEarned=0;omNote="Both adding OI — price trapped, avoid PE";}
    else{omEarned=Math.round(t*0.4);omNote="OI trend mixed — partial PE";}
  }
  // OI velocity: compare last 2 snaps vs first 2 snaps
let velNote="";
let velBonus=0;
try{if(oiH.history&&oiH.history.length>=3){
  const last=oiH.history[oiH.history.length-1];
  const prev=oiH.history[oiH.history.length-2];
  if(last&&prev){
    const ceVel=prev.ceOI>0?Math.round((last.ceOI-prev.ceOI)/prev.ceOI*100):0;
    const peVel=prev.peOI>0?Math.round((last.peOI-prev.peOI)/prev.peOI*100):0;
    if(Math.abs(ceVel)>5||Math.abs(peVel)>5){
      velNote=` | CE:${ceVel>0?"+":""}${ceVel}% PE:${peVel>0?"+":""}${peVel}% (velocity)`;
      // Velocity bonus: fast unwinding in the right direction = +3 to score
      if(isCE&&ceVel<=-10){velBonus=3;velNote+=` ⚡fast CE unwind +${velBonus}pts`;}
      else if(!isCE&&peVel<=-10){velBonus=3;velNote+=` ⚡fast PE unwind +${velBonus}pts`;}
      // Velocity penalty: fast buildup against direction
      else if(isCE&&ceVel>=15){velBonus=-2;velNote+=` ⚠️ fast CE buildup ${velBonus}pts`;}
      else if(!isCE&&peVel>=15){velBonus=-2;velNote+=` ⚠️ fast PE buildup ${velBonus}pts`;}
    }
  }
}}catch(velErr){}
omEarned=Math.min(t,Math.max(0,omEarned+velBonus));
omNote+=` (${oiH.snapCount} snaps, ${oiH.firstSnap}→${oiH.lastSnap}${velNote})`;
}
s.oiMomentum={earned:omEarned,max:t,pass:omEarned>=t*0.5,note:omNote};
}{
}{
// GAMMA BLAST scoring
const t=SIGNAL_WEIGHTS.gammaBlast||0;
const gb=e.gammaBlast||null;
if(!gb||!gb.isGammaBlast){
  // Not a gamma blast setup — neutral score
  s.gammaBlast={earned:0,max:t,pass:false,note:"No gamma blast conditions"};
}else{
  const isCE=a;
  const dirMatch=(isCE&&(gb.direction==="CE"||gb.direction==="BOTH"))||
                 (!isCE&&(gb.direction==="PE"||gb.direction==="BOTH"));
  const earned=dirMatch?t:Math.round(t*0.3);
  s.gammaBlast={
    earned,max:t,pass:dirMatch,
    note:gb.badge+(dirMatch?" — direction match ✓":" — direction mismatch")+
         " | DTE="+gb.dte+" | "+gb.warning
  };
}}
{const t=SIGNAL_WEIGHTS.dilipOIFormula||25;let n=0,o="",r=!1;const i=e.dilipFormula||"NEUTRAL",l=e.putTrapRisk||!1,c=e.callTrapRisk||!1;
// Compute true OI signal from OI history + price — never trust Angel label alone
let u="",p="";
try{
  const oiH=e.oiTrendData;
  const hist=oiH?.history;
  if(hist&&hist.length>=2){
    const latest=hist[hist.length-1];
    const prev=hist[hist.length-2];
    const ceOIDelta=latest.ceOI-prev.ceOI;
    const peOIDelta=latest.peOI-prev.peOI;
    // Price direction from OI history PCR shift as proxy (ltp may not be in history)
    // Use live ltp vs OI snapshot price context
    const ltp=e.ltp||0;
    const prevPCR=prev.pcr||0;
    const latestPCR=latest.pcr||0;
    // CE signal: OI falling + price rising = SHORT COVERING (confirmed)
    //            OI falling + price falling = LONG UNWINDING (bearish, not CE opportunity)
    //            OI rising  + price rising = LONG BUILDUP
    //            OI rising  + price falling = SHORT BUILDUP (bearish)
    const priceUp=latestPCR<prevPCR; // PCR falling = CE pressure = price likely rising
    if(ceOIDelta<0&&priceUp)u="SHORT_COVERING";
    else if(ceOIDelta<0&&!priceUp)u="LONG_UNWINDING";
    else if(ceOIDelta>0&&priceUp)u="LONG_BUILDUP";
    else if(ceOIDelta>0&&!priceUp)u="SHORT_BUILDUP";
    // PE signal: OI falling + price falling = PUT COVERING (confirmed)
    //            OI falling + price rising = LONG UNWINDING (bullish, not PE opportunity)
    //            OI rising  + price falling = SHORT BUILDUP
    //            OI rising  + price rising = LONG BUILDUP (bullish)
    const priceDown=latestPCR>prevPCR; // PCR rising = PE pressure = price likely falling
    if(peOIDelta<0&&priceDown)p="PUT_COVERING";
    else if(peOIDelta<0&&!priceDown)p="LONG_UNWINDING";
    else if(peOIDelta>0&&priceDown)p="SHORT_BUILDUP";
    else if(peOIDelta>0&&!priceDown)p="LONG_BUILDUP";
  }else{
    // Fallback to Angel label only when no OI history available
    u=e.ceSignal?.signal||"";
    p=e.peSignal?.signal||"";
  }
}catch(sigErr){u=e.ceSignal?.signal||"";p=e.peSignal?.signal||"";}
a&&l?(n=0,o="⚠️ PUT TRAP risk — blocks CE",r=!1):!a&&c?(n=0,o="⚠️ CALL TRAP risk — blocks PE",r=!1):a&&"CE"===i?(n=t,o=`Dilip formula: ${e.dilipFormulaNote}`,r=!0):a||"PE"!==i?"AVOID"===i?(n=0,o="Both sides strong = price trapped",r=!1):a&&"SHORT_COVERING"===u?(n=.8*t,o="Ramesh running — CE opportunity",r=!0):a||"PUT_COVERING"!==p?a&&"LONG_BUILDUP"===u?(n=.4*t,o="Long buildup — CE with caution",r=null):a||"LONG_BUILDUP"!==p?(n=0,o=`OI formula ${i} does not match ${a?"CE":"PE"} direction`,r=!1):(n=.4*t,o="Long buildup — PE with caution",r=null):(n=.8*t,o="Suresh running — PE opportunity",r=!0):(n=t,o=`Dilip formula: ${e.dilipFormulaNote}`,r=!0),a&&e.rameshTrapped&&r&&(n=Math.min(t,n+5),o+=" + Ramesh trapped bonus"),!a&&e.sureshTrapped&&r&&(n=Math.min(t,n+5),o+=" + Suresh trapped bonus"),s.dilipOIFormula={earned:Math.round(n),max:t,pass:r,note:o}}// ATM distance is a bonus — include in earned but NOT possible (can only help)
const atmBonus=s.atmDistance?.earned||0;
const baseEarned=Object.values(s).reduce((e,t)=>e+(t===s.atmDistance?0:t.earned),0);
const r=baseEarned+atmBonus;
const gbFired=s.gammaBlast&&s.gammaBlast.earned>0;
const i=Object.values(s).reduce((e,t,idx,arr)=>{
  if(arr[idx]===s.gammaBlast&&!gbFired)return e;
  if(arr[idx]===s.atmDistance)return e; // exclude from possible
  return e+t.max;
},0);
// ── OI GATE: Dilip OI Formula is the anchor ──────────────────
const oiEarned=s.dilipOIFormula?.earned||0;
const oiMax=s.dilipOIFormula?.max||25;
const oiFormula=e.dilipFormula||"NEUTRAL";
const oiPass=s.dilipOIFormula?.pass;

// Compute raw score FIRST so hard-block logic below can reference it
let finalScore=Math.round(r/i*100);

// HARD BLOCK rules:
// PUT TRAP / CALL TRAP → block ONLY if score < 65 (strong technicals can override trap on non-expiry days)
// AVOID (both sides strong) → block ONLY if stock is in its OWN expiry week
// NEUTRAL → never block
if(!n&&oiPass===false){
  const isPutCallTrap=e.putTrapRisk||e.callTrapRisk;
  const isAvoid=oiFormula==="AVOID";
  const stockInOwnExpiry=e.isExpiryDay||e.isExpiryWeek;
  // Only hardBlock if there is meaningful OI data (oiEarned>0)
  // On first day of new series, OI is thin → oiEarned=0 → skip trap block
  const hasOIData=oiEarned>0||(e.atmCeOI>0||e.atmPeOI>0);
  if(hasOIData){
    if(isPutCallTrap){
      if(stockInOwnExpiry||finalScore<65){
        n=true;o=s.dilipOIFormula?.note||"OI trap detected — signal blocked";
      }
    } else if(isAvoid&&stockInOwnExpiry){
      n=true;o=s.dilipOIFormula?.note||"Both sides trapped — stock expiry week";
    }
  }
  // No OI data (new series day) → skip hard block, let score decide
}

// SCORE CAP: only when OI explicitly says WRONG DIRECTION (not NEUTRAL)
// NEUTRAL = insufficient data → allow signal through, no cap
// Wrong direction = OI says PE but scanning CE (or vice versa) → cap at 59
// Only cap score if there IS meaningful OI data pointing wrong direction
// If oiEarned=0 AND no ATM OI data → new series / thin data → don't cap
const hasOIData2=(e.atmCeOI>0||e.atmPeOI>0);
const oiWrongDir=oiEarned===0&&oiPass===false&&!n&&hasOIData2;
if(oiWrongDir){
  finalScore=Math.min(finalScore,59);
  const capReason=oiFormula==="AVOID"?" ⚠️ [Both trapped — capped, not blocked]":" ⚠️ [OI direction mismatch — capped]";
  if(s.dilipOIFormula)s.dilipOIFormula.note+=capReason;
}
if(chopPenalty>0&&!n){
  finalScore=Math.round(finalScore*(1-chopPenalty));
  o=o?o+chopNote:chopNote.trim();
}
return{score:finalScore,totalEarned:parseFloat(r.toFixed(1)),totalPossible:i,breakdown:s,hardBlock:n,hardBlockReason:o,chopPenaltyApplied:chopPenalty>0}}

app.post("/signal-analysis",async(e,t)=>{
  if(!isAuthenticated())return t.status(401).json({status:!1,message:"Not authenticated"});
  // MARKET HOURS GATE
  const ms=marketStatus();
  if(!ms.open){
    return t.status(400).json({status:!1,message:`Market is ${ms.label}. Signal analysis runs only 9:15 AM–3:30 PM IST.`,marketStatus:ms,code:"MARKET_CLOSED"});
  }
  const{symbolToken:a,sym:s,exchange:n="NSE",isIndex:o=!1,spotPrice:r,type:i}=e.body;
  try{const[e,o,l,c,u]=await Promise.allSettled([axios.post(`http://localhost:${PORT}/market-bias`,{symbolToken:a,exchange:n},{headers:{"Content-Type":"application/json"}}),Promise.resolve({data:FII_DII_CACHE.data||{instBias:"NEUTRAL",fiiNet:0,diiNet:0,fiiBuy:0,fiiSell:0,diiBuy:0,diiSell:0}}),
    Promise.resolve({data:VIX_CACHE.data||{vix:null,regime:"UNKNOWN",premiumBuyable:true,guidance:""}}),
    Promise.resolve({data:NEWS_CACHE.data||{sentiment:"NEUTRAL",sentimentScore:50,geoRisk:0}}),r?axios.post(`http://localhost:${PORT}/oi-analysis`,{symbol:s,spotPrice:r,expiry:getExpiryType(s)},{headers:{"Content-Type":"application/json"}}):Promise.resolve({data:null})]),p="fulfilled"===e.status?e.value.data:{},d="fulfilled"===o.status?o.value.data:{},g="fulfilled"===l.status?l.value.data:{},m="fulfilled"===c.status?c.value.data:{},h="fulfilled"===u.status&&u.value.data?.status?u.value.data:null,S={sym:s,type:i,bias:p.bias||"NEUTRAL",staleMove:p.staleMove||!1,chopRange:p.chopRange||!1,ema20:p.ema20||null,ema50:p.ema50||null,rsi:p.rsi??50,vwap:p.vwap||null,aboveVwap:p.aboveVwap??null,pdh:p.pdh||null,pdl:p.pdl||null,orb_high:p.orb_high||null,orb_low:p.orb_low||null,volRatio:p.volRatio??1,volPriceDir:p.volPriceDir||"NEUTRAL",volDryUp:p.volDryUp||false,ltp:p.ltp||r||null,macd:p.macd||null,atr:p.atr||null,supertrend:p.supertrend||null,atrStopLong:p.atrStopLong||null,atrStopShort:p.atrStopShort||null,isExpiryDay:p.isExpiryDay||getExpiryWeekInfo(s).isNSEExpiryDay||false,instBias:d.instBias||"NEUTRAL",fiiNet:d.fiiNet??0,diiNet:d.diiNet??0,vixValue:g.vix||null,vixRegime:g.regime||"UNKNOWN",premiumBuyable:!1!==g.premiumBuyable,vixGuidance:g.guidance||"",newsSentiment:m.sentiment||"NEUTRAL",newsSentimentScore:m.sentimentScore??50,newsGeoRisk:m.geoRisk??0,pcr:h?.pcr||null,pcrBias:h?.pcrBias||"NEUTRAL",maxPain:h?.maxPain||null,oiSupportStrike:h?.supportStrike||null,oiResistStrike:h?.resistStrike||null,nearMaxPain:h?.nearMaxPain||!1,nearSupport:h?.nearSupport||!1,nearResistance:h?.nearResistance||!1,dilipFormula:h?.dilipFormula||"NEUTRAL",dilipFormulaNote:h?.dilipFormulaNote||"",ceSignal:h?.ceSignal||null,peSignal:h?.peSignal||null,putTrapRisk:h?.putTrapRisk||!1,callTrapRisk:h?.callTrapRisk||!1,oiRecommendation:h?.oiRecommendation||"NEUTRAL",oiScore:h?.oiScore||0,oiVerdict:h?.oiVerdict||"WEAK",oiNotes:h?.oiNotes||[],ceWalls:h?.ceWalls||[],peFloors:h?.peFloors||[],rameshTrapped:h?.rameshTrapped||!1,sureshTrapped:h?.sureshTrapped||!1,oiBattleBias:h?.oiBattleBias||"NEUTRAL",oiBattleSummary:h?.oiBattleSummary||[],gammaBlast:h?.gammaBlast||null,atmCeOI:h?.atmCeOI||0,atmPeOI:h?.atmPeOI||0,atmPCR:h?.atmPCR||null,strikePCR:h?.strikePCR||[],strikeFlags:h?.strikeFlags||[],expiry:h?.expiry||null};
  // Attach OI trend history
  const oiTrend=getOITrend(s?.toUpperCase()||"");
  S.oiTrendData=oiTrend;
  const{score:E,totalEarned:f,totalPossible:I,breakdown:N,hardBlock:A,hardBlockReason:k}=scoreSignal(S,i);
  let C,O;A?(C="BLOCKED",O=k):E>=75?(C="STRONG",O="High conviction — trade with normal size"):E>=60?(C="MODERATE",O="Good setup — consider half position size"):E>=42?(C="WEAK",O="Marginal setup — watch, wait for more confirmation"):(C="AVOID",O="Poor alignment — skip this signal");
  // Naresh urgency check: if this side's tier is STALE (sustained buying case but urgency has been fading across real scans), don't let a raw score alone call it STRONG — that's exactly the late-entry trap
  let naresStaleDowngrade=!1;
  if("STRONG"===C&&S.strikeFlags&&S.strikeFlags.length){
    const relevantTiers=S.strikeFlags.flatMap(sf=>sf.flags).filter(fl=>fl.side===i&&fl.type&&fl.type.indexOf("TIER_")===0&&fl.proximity==="HIGH");
    if(relevantTiers.some(fl=>fl.type==="TIER_STALE")){
      C="MODERATE";
      O="High score, but Naresh urgency has faded (STALE) — likely late entry, sized down to MODERATE";
      naresStaleDowngrade=!0;
      log(`Naresh: ${s} ${i} downgraded STRONG→MODERATE — urgency faded (STALE)`,"WARN");
    }
  }let T=null,y=null,w=null;if(S.atr&&S.ltp){T="CE"===i?parseFloat((S.ltp-1.5*S.atr).toFixed(2)):parseFloat((S.ltp+1.5*S.atr).toFixed(2)),y="CE"===i?parseFloat((S.ltp+2.5*S.atr).toFixed(2)):parseFloat((S.ltp-2.5*S.atr).toFixed(2));const e=Math.abs(S.ltp-T),t=Math.abs(S.ltp-y);w=e>0?parseFloat((t/e).toFixed(2)):null}const b=Object.entries(N).filter(([,e])=>!1!==e.pass&&e.earned>0).sort((e,t)=>t[1].earned-e[1].earned).slice(0,1).map(([,e])=>e.note.replace(/✓✓|✓|★/g,"").trim()),_=Object.entries(N).filter(([,e])=>!1===e.pass).map(([,e])=>e.note);
  // LOG THE SIGNAL
  const signalId=logSignal(s,i,E,C,S.ltp,N);
  recordStockScore(s,i,E,C);
  log(`Signal ${s} ${i}: score=${E} verdict=${C} VIX=${S.vixValue} RSI=${S.rsi} bias=${S.bias}`,"INFO");
  (()=>{let safeS={};try{const j=JSON.stringify(S);safeS=JSON.parse(j);}catch(e){Object.keys(S).forEach(k=>{try{JSON.stringify(S[k]);safeS[k]=S[k];}catch(e){}});}t.json({status:!0,sym:s,type:i,score:E,totalEarned:f,totalPossible:I,verdict:C,actionNote:O,hardBlock:A,hardBlockReason:A?k:null,naresStaleDowngrade,breakdown:N,reasons:b,warnings:_,...safeS,suggestedStop:T,suggestedTarget:y,riskReward:w,signalId,oiTrend,marketStatus:ms});})()}catch(e){log(`signal-analysis error: ${e.message} | ${e.stack?.split('\n')[1]||''}`,"ERR");try{t.status(500).json({status:!1,message:e.message});}catch(re){}}})

app.get("/gainers",async(e,t)=>{if(!isAuthenticated())return t.status(401).json({status:!1,message:"Not authenticated"});try{const a=await axios.get(`${ANGEL_API}/rest/secure/angelbroking/marketData/v1/gainersAndLosers`,{params:e.query,headers:getHeaders(!0),timeout:15e3});t.json(a.data)}catch(e){const a=e.response?.data?.message||e.message;t.status(500).json({status:!1,message:a})}})

const MCX_SYMBOLS=["GOLD","SILVER","CRUDEOIL","NATURALGAS","COPPER","ALUMINIUM","ZINC","LEAD","NICKEL"];
async function getMCXTokens(){try{await ensureInstruments("MCX tokens");}catch(e){return log("Instrument master download failed: "+e.message,"WARN"),{}}const e=new Date,t={JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};function a(e){if(!e)return null;const a=String(e).trim().toUpperCase(),s=a.match(/^(\d{1,2})([A-Z]{3})(\d{4})$/);if(s){const e=t[s[2]];if(void 0!==e)return new Date(+s[3],e,+s[1])}const n=a.match(/^(\d{4})(\d{2})(\d{2})$/);if(n)return new Date(+n[1],+n[2]-1,+n[3]);const o=a.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(o)return new Date(+o[1],+o[2]-1,+o[3]);const r=new Date(e);return isNaN(r)?null:r}const s={};for(const t of MCX_SYMBOLS){const n=SESSION._instruments.filter(s=>{if("MCX"!==s.exch_seg)return!1;if(!s.name||s.name.toUpperCase()!==t)return!1;if("FUTCOM"!==s.instrumenttype)return!1;const n=a(s.expiry);return n&&n>=e}).sort((e,t)=>a(e.expiry)-a(t.expiry));n.length>0&&(s[t]=n[0].token,log(`MCX ${t}: token ${n[0].token} exp ${n[0].expiry}`,"INFO"))}return s}

app.get("/mcx",async(e,t)=>{if(!isAuthenticated())return t.status(401).json({status:!1,message:"Not authenticated"});try{const e=await getMCXTokens(),a=Object.values(e);if(!a.length)return t.json({status:!1,message:"Could not resolve MCX tokens from instrument master"});const s=(await angelRequest("POST",`${ANGEL_API}/rest/secure/angelbroking/market/v1/quote/`,{mode:"FULL",exchangeTokens:{MCX:a}})).data;if(s.status&&s.data?.fetched){const a={};return s.data.fetched.forEach(t=>{const s=Object.keys(e).find(a=>String(e[a])===String(t.symbolToken));if(s){const e=parseFloat(t.ltp||0),n=parseFloat(t.close||0);a[s]={ltp:e,open:parseFloat(t.open||0),high:parseFloat(t.high||0),low:parseFloat(t.low||0),close:n,change:e-n,changePct:n>0?((e-n)/n*100).toFixed(2):"0.00",tradingSymbol:t.tradingSymbol||s}}}),t.json({status:!0,data:a})}t.json({status:!1,message:s.message||"No MCX data returned"})}catch(e){const a=e.response?.data?.message||e.message;t.status(500).json({status:!1,message:a})}})

app.get("/pcr",async(e,t)=>{if(!isAuthenticated())return t.status(401).json({status:!1,message:"Not authenticated"});try{const e=await axios.get(`${ANGEL_API}/rest/secure/angelbroking/market/v1/putCallRatio`,{headers:getHeaders(!0),timeout:15e3});t.json(e.data)}catch(e){const a=e.response?.data?.message||e.message;t.status(500).json({status:!1,message:a})}})

app.post("/option-ltp",async(e,t)=>{if(!isAuthenticated())return t.status(401).json({status:!1,message:"Not authenticated"});const{symbol:a,strike:s,type:n,expiry:o}=e.body;if(!a||!s||!n)return t.status(400).json({status:!1,message:"symbol, strike, type required"});try{await ensureInstruments("option-ltp");const i={JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};function r(e){if(!e)return null;const t=String(e).trim().toUpperCase(),a=t.match(/^(\d{1,2})([A-Z]{3})(\d{4})$/);if(a){const e=i[a[2]];if(void 0!==e)return new Date(+a[3],e,+a[1])}const s=t.match(/^(\d{4})(\d{2})(\d{2})$/);if(s)return new Date(+s[1],+s[2]-1,+s[3]);const n=t.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(n)return new Date(+n[1],+n[2]-1,+n[3]);const o=t.match(/^(\d{2})-(\d{2})-(\d{4})$/);if(o)return new Date(+o[3],+o[2]-1,+o[1]);const r=new Date(e);return isNaN(r)?null:r}const l=a.toUpperCase(),c=n.toUpperCase(),u=parseFloat(s),p=new Date,d=SESSION._instruments.filter(e=>{if("NFO"!==e.exch_seg)return!1;if(!e.instrumenttype?.includes("OPT"))return!1;const t=r(e.expiry);if(!t)return!1;const _tLtp=new Date(t);_tLtp.setHours(15,30,0,0);if(_tLtp<p)return!1;const a=Math.round(parseFloat(e.strike));if(!(a===Math.round(100*u)||a===Math.round(u)))return!1;if(!e.symbol?.toUpperCase().endsWith(c))return!1;if(e.name?.toUpperCase()===l)return!0;const s=e.symbol.toUpperCase();return!!(s.startsWith(l)&&s.length>l.length&&/\d/.test(s[l.length]))});if(!d.length)return t.json({status:!1,message:`No NFO instrument for ${l} ${s} ${c}`});const g=d.map(e=>({...e,_exp:r(e.expiry)})).filter(e=>e._exp).sort((e,t)=>e._exp-t._exp);let m;if("MONTHLY"===o){const E=p.getMonth(),f=p.getFullYear(),I=g.filter(e=>e._exp.getMonth()===E&&e._exp.getFullYear()===f);m=I[I.length-1]||g[g.length-1]}else if("NEXT_MONTH"===o){const nm=(p.getMonth()+1)%12,ny=p.getMonth()===11?p.getFullYear()+1:p.getFullYear(),nf=g.filter(e=>e._exp.getMonth()===nm&&e._exp.getFullYear()===ny);m=nf[nf.length-1]||g[1]||g[0]}else m="NEXT"===o&&g[1]||g[0];if(!m)return t.json({status:!1,message:`No valid expiry for ${l} ${s} ${c}`});log(`Option-LTP token: ${m.symbol} (${m.token})`,"INFO"),await angelRateLimit();
let h;
try{
  h=(await angelRequest("POST",`${ANGEL_API}/rest/secure/angelbroking/market/v1/quote/`,{mode:"LTP",exchangeTokens:{NFO:[String(m.token)]}})).data;
}catch(firstErr){
  if(firstErr.response?.status===403){
    log(`Option-LTP 403 for ${m.symbol} — waiting 2s then retrying once`,"WARN");
    await new Promise(res=>setTimeout(res,2000));
    await angelRateLimit();
    h=(await angelRequest("POST",`${ANGEL_API}/rest/secure/angelbroking/market/v1/quote/`,{mode:"LTP",exchangeTokens:{NFO:[String(m.token)]}})).data;
  }else{throw firstErr;}
}
if(h.status&&h.data?.fetched?.length){const N=h.data.fetched[0],A=parseFloat(N.ltp||0)>0?parseFloat(N.ltp):parseFloat(N.close||0);return log(`✅ Option LTP: ${m.symbol} = ₹${A}`,"OK"),t.json({status:!0,ltp:A,symbolToken:m.token,tradingSymbol:m.symbol,expiry:m.expiry})}return t.json({status:!1,message:"LTP fetch returned no data"})}catch(k){const C=k.response?.data?.message||k.message;log(`Option LTP error: ${C}`,"WARN"),t.status(500).json({status:!1,message:C})}})

// ═══════════════════════════════════════════════════════
// LIVE TRADE PRICES — batch LTP for all open paper trades
// POST /live-trade-prices
// Body: { trades: [{symbol, strike, type, expiry}] }  -- expiry is the raw string (e.g. "28AUG2025")
// the trade was actually created with. When present, matching is STRICT: only that exact
// expiry's contract is ever priced. If that contract is no longer live, the key is returned
// in `expired` instead of silently substituting a different month's price at the same strike.
// Returns: { status:true, prices: {"NBCC_109_CE_28AUG2025": 4.25, ...}, expired: {"...": true} }
// ═══════════════════════════════════════════════════════
app.post("/live-trade-prices",async(req,res)=>{
  if(!isAuthenticated())return res.status(401).json({status:false,message:"Not authenticated"});
  const{trades}=req.body;
  if(!trades||!trades.length)return res.json({status:true,prices:{}});
  const debugMisses=[]; // real diagnostic: exact reason each trade's price lookup failed
  try{
    await ensureInstruments("live trade prices");
    const MONTHS={JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
    function parseExp(e){if(!e)return null;const s=String(e).trim().toUpperCase();const m=s.match(/^(\d{1,2})([A-Z]{3})(\d{4})$/);if(m&&MONTHS[m[2]]!==undefined)return new Date(+m[3],MONTHS[m[2]],+m[1]);const d=new Date(e);return isNaN(d)?null:d;}
    const tokenMap={};const tokenToKey={};const now=new Date();const expired={};
    for(const trade of trades){
      const sym=(trade.symbol||"").toUpperCase();
      const strike=parseFloat(trade.strike);
      const type=(trade.type||"CE").toUpperCase();
      const wantExpiry=trade.expiry?String(trade.expiry).trim().toUpperCase():null;
      const key=`${sym}_${strike}_${type}_${wantExpiry||""}`;
      const matches=SESSION._instruments.filter(inst=>{
        if(inst.exch_seg!=="NFO")return false;
        if(!inst.instrumenttype?.includes("OPT"))return false;
        const exp=parseExp(inst.expiry);if(!exp)return false;
        const is=Math.round(parseFloat(inst.strike));
        if(!(is===Math.round(100*strike)||is===Math.round(strike)))return false;
        if(!inst.symbol?.toUpperCase().endsWith(type))return false;
        if(!(inst.name?.toUpperCase()===sym||(()=>{const s2=inst.symbol.toUpperCase();return s2.startsWith(sym)&&s2.length>sym.length&&/\d/.test(s2[sym.length]);})()))return false;
        return true;
      });
      if(!matches.length){
        log(`live-trade-prices: no instrument for ${key}`,"WARN");
        const symCandidates=SESSION._instruments.filter(inst=>inst.exch_seg==="NFO"&&inst.instrumenttype?.includes("OPT")&&(inst.name?.toUpperCase()===sym||inst.symbol?.toUpperCase().startsWith(sym))).length;
        debugMisses.push({key,reason:"no matching instrument",symCandidatesFound:symCandidates,searchedStrike:strike,searchedType:type});
        continue;
      }
      let best;
      if(wantExpiry){
        // STRICT: only ever match the exact expiry the trade was created with.
        // Never silently fall back to a different month's contract at the same strike —
        // that produces a real-looking but wrong price with no indication the month changed.
        best=matches.find(inst=>String(inst.expiry).trim().toUpperCase()===wantExpiry);
        if(!best){
          expired[key]=true;
          debugMisses.push({key,reason:"exact expiry not found (likely expired)",symCandidatesFound:matches.length,searchedStrike:strike,searchedType:type,wantExpiry});
          continue;
        }
        const expDate=parseExp(best.expiry);
        if(expDate){const expEnd=new Date(expDate);expEnd.setHours(15,30,0,0);if(expEnd<now){expired[key]=true;continue;}}
      } else {
        // Legacy fallback path (no expiry supplied by caller) — nearest live contract.
        const sorted=matches.map(i=>({...i,_exp:parseExp(i.expiry)})).filter(i=>i._exp&&(()=>{const e=new Date(i._exp);e.setHours(15,30,0,0);return e>=now;})()).sort((a,b)=>a._exp-b._exp);
        if(!sorted.length){expired[key]=true;continue;}
        best=sorted[0];
      }
      tokenMap[key]=String(best.token);
      tokenToKey[String(best.token)]=key;
    }
    const tokens=Object.values(tokenMap);
    if(!tokens.length)return res.json({status:true,prices:{},expired,debugMisses});
    const prices={};const BATCH=50;
    for(let i=0;i<tokens.length;i+=BATCH){
      const batch=tokens.slice(i,i+BATCH);
      try{
        await angelRateLimit();
        const r=await angelRequest("POST",`${ANGEL_API}/rest/secure/angelbroking/market/v1/quote/`,{mode:"LTP",exchangeTokens:{NFO:batch}});
        if(r.data.status&&r.data.data?.fetched){
          r.data.data.fetched.forEach(f=>{
            const key=tokenToKey[String(f.symbolToken)];
            if(key){const ltp=parseFloat(f.ltp||0)>0?parseFloat(f.ltp):parseFloat(f.close||0);prices[key]=ltp;}
          });
        }
      }catch(bErr){log(`live-trade-prices batch error: ${bErr.message}`,"WARN");}
    }
    log(`live-trade-prices: fetched ${Object.keys(prices).length}/${trades.length}, expired=${Object.keys(expired).length}`,"OK");
    res.json({status:true,prices,expired,debugMisses});
  }catch(err){log(`live-trade-prices error: ${err.message}`,"ERR");res.status(500).json({status:false,message:err.message});}
});

app.post("/option-chain",async(e,t)=>{if(!isAuthenticated())return t.status(401).json({status:!1,message:"Not authenticated"});const{symbol:a,spotPrice:s,expiry:n,depth:o=5}=e.body;if(!a||!s)return t.status(400).json({status:!1,message:"symbol and spotPrice required"});try{await ensureInstruments("option-chain");const i=a.toUpperCase(),l=parseFloat(s),c=new Date,u={JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};function r(e){if(!e)return null;const t=String(e).trim().toUpperCase(),a=t.match(/^(\d{1,2})([A-Z]{3})(\d{4})$/);if(a){const e=u[a[2]];if(void 0!==e)return new Date(+a[3],e,+a[1])}const s=t.match(/^(\d{4})(\d{2})(\d{2})$/);if(s)return new Date(+s[1],+s[2]-1,+s[3]);const n=t.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(n)return new Date(+n[1],+n[2]-1,+n[3]);const o=t.match(/^(\d{2})-(\d{2})-(\d{4})$/);if(o)return new Date(+o[3],+o[2]-1,+o[1]);const r=new Date(e);return isNaN(r)?null:r}const p=SESSION._instruments.filter(e=>{if("NFO"!==e.exch_seg)return!1;if(!e.instrumenttype||!e.instrumenttype.includes("OPT"))return!1;const t=r(e.expiry);if(!t||t<c)return!1;if(e.name&&e.name.toUpperCase()===i)return!0;if(e.symbol){const t=e.symbol.toUpperCase();if(t.startsWith(i)&&t.length>i.length&&/\d/.test(t[i.length]))return!0}return!1});if(0===p.length)return log(`No NFO options found for ${i} (checked ${SESSION._instruments?.length} instruments)`,"WARN"),t.json({status:!1,message:`No NFO options found for ${i}`});log(`Option chain ${i}: ${p.length} options matched`,"INFO");const d=[...new Set(p.map(e=>e.expiry))].map(e=>({raw:e,date:r(e)})).filter(e=>e.date&&e.date>=c).sort((e,t)=>e.date-t.date);if(!d.length)return t.json({status:!1,message:`No valid future expiries for ${i}`});let g;if("MONTHLY"===n){const b=c.getMonth(),_=c.getFullYear(),F=d.filter(e=>e.date.getMonth()===b&&e.date.getFullYear()===_);g=F.length?F[F.length-1]:d[0]}else if("NEXT_MONTH"===n){const R=(c.getMonth()+1)%12,x=11===c.getMonth()?c.getFullYear()+1:c.getFullYear(),P=d.filter(e=>e.date.getMonth()===R&&e.date.getFullYear()===x);g=P.length?P[P.length-1]:d[1]||d[0]}else g="NEXT"===n&&d[1]||d[0];const m=g.raw,h=p.filter(e=>e.expiry===m),S=[...new Set(h.map(e=>Math.round(parseFloat(e.strike)/100)))].filter(e=>e>0).sort((e,t)=>e-t);if(0===S.length)return t.json({status:!1,message:`No strikes found for ${i} expiry ${m}`});const E=S.reduce((e,t)=>Math.abs(t-l)<Math.abs(e-l)?t:e,S[0]),f=S.indexOf(E),I=Math.max(0,f-o),N=Math.min(S.length-1,f+o),A=S.slice(I,N+1),k=[],C={};for(const L of A){const D=Math.round(100*L),$=h.filter(e=>Math.round(parseFloat(e.strike))===D&&e.symbol?.toUpperCase().endsWith("CE")),M=h.filter(e=>Math.round(parseFloat(e.strike))===D&&e.symbol?.toUpperCase().endsWith("PE")),U=$[0],v=M[0];C[L]={CE_token:U?.token??null,PE_token:v?.token??null,CE_sym:U?.symbol??null,PE_sym:v?.symbol??null},U?.token&&k.push(String(U.token)),v?.token&&k.push(String(v.token))}if(log(`Option chain ${i}: expiry=${m}, ATM=${E}, strikes=${A.length}, tokens=${k.length}`,"INFO"),0===k.length)return t.json({status:!1,message:`No tokens found for ${i} — check instrument name matching`});const O={},T=50;for(let B=0;B<k.length;B+=T){const j=k.slice(B,B+T);try{const H=await angelRequest("POST",`${ANGEL_API}/rest/secure/angelbroking/market/v1/quote/`,{mode:"LTP",exchangeTokens:{NFO:j}});H.data.status&&H.data.data?.fetched&&H.data.data.fetched.forEach(e=>{const t=parseFloat(e.ltp||0);parseFloat(e.close||0);if(t>0)O[String(e.symbolToken)]=t;else{const t=parseFloat(e.close||0);t>0&&(O[String(e.symbolToken)]=t)}})}catch(V){log(`LTP batch failed: ${V.message}`,"WARN")}}const y=A.map(e=>{const t=C[e];return{strike:e,isATM:e===E,CE_ltp:t.CE_token?O[String(t.CE_token)]??null:null,PE_ltp:t.PE_token?O[String(t.PE_token)]??null:null,CE_token:t.CE_token,PE_token:t.PE_token,CE_sym:t.CE_sym,PE_sym:t.PE_sym}});return log(`✅ ${i}: ATM=${E}, ltps=${Object.keys(O).length}/${k.length} fetched`,"OK"),t.json({status:!0,symbol:i,spotPrice:l,atmStrike:E,expiry:m,strikes:y})}catch(W){const G=W.response?.data?.message||W.message;log(`Option chain error ${a}: ${G}`,"WARN"),t.status(500).json({status:!1,message:G})}})

app.post("/refresh",async(e,t)=>{if(!SESSION.refreshToken)return t.json({status:!1,message:"No refresh token available"});try{const e=await axios.post(`${ANGEL_API}/rest/secure/angelbroking/jwt/v1/generateTokens`,{refreshToken:SESSION.refreshToken},{headers:getHeaders(!0),timeout:15e3});if(!0===e.data.status&&e.data.data)return SESSION.jwtToken=e.data.data.jwtToken,SESSION.refreshToken=e.data.data.refreshToken,SESSION.expiresAt=Date.now()+288e5,log("Token refreshed","OK"),t.json({status:!0,message:"Token refreshed"});t.json({status:!1,message:"Token refresh failed"})}catch(e){const a=e.response?.data?.message||e.message;t.status(500).json({status:!1,message:a})}})

// Auto-reset NSE cookie every 90 minutes so FII/DII + VIX never go stale
setInterval(()=>{
  NSE_COOKIE="";
  log("NSE session cookie reset — will refresh on next FII/DII or VIX fetch","INFO");
},54e5); // 90 minutes

setInterval(async()=>{if(!SESSION.refreshToken||!SESSION.jwtToken)return;const e=(SESSION.expiresAt-Date.now())/36e5;if(e>0&&e<1){log("Auto-refreshing JWT token...","INFO");try{const e=await axios.post(`${ANGEL_API}/rest/secure/angelbroking/jwt/v1/generateTokens`,{refreshToken:SESSION.refreshToken},{headers:getHeaders(!0),timeout:15e3});!0===e.data.status&&e.data.data&&(SESSION.jwtToken=e.data.data.jwtToken,SESSION.refreshToken=e.data.data.refreshToken,SESSION.expiresAt=Date.now()+288e5,log("Token auto-refreshed ✅","OK"))}catch(e){log(`Auto-refresh failed: ${e.message}`,"ERR")}}},18e5)

let NEWS_CACHE={data:null,fetchTime:0};
app.get("/news-sentiment",async(e,t)=>{if(NEWS_CACHE.data&&Date.now()-NEWS_CACHE.fetchTime<3e5)return t.json(NEWS_CACHE.data);try{const e=["https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms","https://www.moneycontrol.com/rss/marketsindia.xml","https://feeds.feedburner.com/ndtvprofit-latest"],a=await Promise.allSettled(e.map(e=>axios.get(e,{timeout:5e3,responseType:"text"}))),s=[];a.forEach(e=>{if("fulfilled"===e.status){(e.value.data.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/g)||[]).slice(1,15).forEach(e=>{const t=e.replace(/<[^>]+>/g,"").replace(/<!\[CDATA\[|\]\]>/g,"").trim();t.length>10&&s.push(t)})}});const n=["surge","rally","gain","rise","record","high","strong","growth","profit","beat","positive","boost","upgrade","buy","bull","recovery","jump","soar","outperform","breakout","upside","optimism","inflow","fii buying","dii buying","rate cut","gdp growth","export rise","earnings beat","dividend","buyback","expansion","order win"],o=["fall","drop","crash","decline","loss","weak","sell","bear","down","cut","risk","war","tension","crisis","inflation","recession","sanction","tariff","geopolit","slump","outflow","fii selling","rate hike","default","bankruptcy","miss","downgrade","concern","slowdown","contraction","profit warning","layoff","strike","ban"],r=["war","conflict","sanction","tariff","geopolit","tension","attack","israel","iran","ukraine","russia","china","taiwan","missile","oil price","crude","middle east","pakistan","border","ceasefire","nato","nuclear","terror","airstrike","trade war","us tariff","trump tariff","embargo","blockade","escalation"];let i=0,l=0,c=0;s.forEach(e=>{const t=e.toLowerCase();n.forEach(e=>{t.includes(e)&&i++}),o.forEach(e=>{t.includes(e)&&l++}),r.forEach(e=>{t.includes(e)&&c++})});const u=i+l||1,p=i>l?"BULLISH":l>i?"BEARISH":"NEUTRAL",d=Math.round(i/u*100),g={status:!0,sentiment:p,sentimentScore:d,geoRisk:c,bullScore:i,bearScore:l,headlineCount:s.length,topHeadlines:s.slice(0,5),fetchTime:(new Date).toLocaleTimeString("en-IN")};NEWS_CACHE={data:g,fetchTime:Date.now()},log(`News: ${p} (${d}%) · GeoRisk: ${c}`,"INFO"),t.json(g)}catch(e){t.json({status:!1,message:e.message,sentiment:"NEUTRAL",sentimentScore:50,geoRisk:0})}})

app.post("/resolve-tokens",async(e,t)=>{try{await ensureInstruments("resolve-tokens");const a=(e.body.symbols||[]).map(e=>e.toUpperCase()),s={};for(const e of a){const t=SESSION._instruments.find(t=>"NSE"===t.exch_seg&&(t.symbol===e+"-EQ"||t.symbol===e||t.name===e)&&t.token);t&&(s[e]=String(t.token))}log("Token resolution: "+Object.keys(s).length+" resolved","INFO"),t.json({status:!0,tokens:s})}catch(e){t.status(500).json({status:!1,message:e.message})}})

app.get("/fno-stock-list",async(req,res)=>{
  try{
    const forceRefresh = req.query.refresh === "1";
    await ensureInstruments("F&O list", forceRefresh);
    const now=new Date();
    const INDICES=["NIFTY","BANKNIFTY","FINNIFTY","MIDCPNIFTY","SENSEX","BANKEX"];
    // Get unique stock names with future NFO options
    const fnoSet=new Set();
    SESSION._instruments.forEach(inst=>{
      if(inst.exch_seg!=="NFO")return;
      if(!inst.instrumenttype||!inst.instrumenttype.includes("OPT"))return;
      const name=(inst.name||"").toUpperCase();
      if(!name||INDICES.includes(name))return;
      const exp=inst.expiry?new Date(inst.expiry):null;
      if(exp&&exp>now)fnoSet.add(name);
    });
    // Build NSE token map for EQ segment
    const nseTokenMap={};
    SESSION._instruments.forEach(inst=>{
      if(inst.exch_seg!=="NSE")return;
      const sym=(inst.symbol||"").replace(/-EQ$/i,"").toUpperCase();
      if(sym&&inst.token&&!nseTokenMap[sym])nseTokenMap[sym]=String(inst.token);
    });
    // Build lot size map from NSE FUT segment
    const lotMap={};
    SESSION._instruments.forEach(inst=>{
      if(inst.exch_seg!=="NFO")return;
      if(!inst.instrumenttype||!inst.instrumenttype.includes("FUT"))return;
      const name=(inst.name||"").toUpperCase();
      if(name&&inst.lotsize&&!lotMap[name])lotMap[name]=parseInt(inst.lotsize)||1;
    });
    const stocks=Array.from(fnoSet).sort().map(sym=>({
      sym,
      token:nseTokenMap[sym]||null,
      lot:lotMap[sym]||1
    }));
    log("F&O stock list derived: "+stocks.length+" stocks with tokens","OK");
    res.json({status:true,stocks,count:stocks.length,cached:false});
  }catch(e){
    log("fno-stock-list error: "+e.message,"WARN");
    res.status(500).json({status:false,message:e.message});
  }
});

app.get("/token-list",async(e,t)=>{try{await ensureInstruments("token list");const e={};SESSION._instruments.forEach(t=>{if("NSE"!==t.exch_seg)return;const a=(t.symbol||"").replace("-EQ","").toUpperCase();e[a]||(e[a]=String(t.token))}),log("Token list served: "+Object.keys(e).length+" NSE symbols","INFO"),t.json({status:!0,tokens:e,count:Object.keys(e).length})}catch(e){log("token-list error: "+e.message,"WARN"),t.status(500).json({status:!1,message:e.message})}})
app.get("/all-stock-scores",(req,res)=>{
  try{
    const rows=Object.entries(LATEST_SCORES).map(([sym,sides])=>({
      sym,
      ce:sides.CE?sides.CE.score:null,
      ceVerdict:sides.CE?sides.CE.verdict:null,
      pe:sides.PE?sides.PE.score:null,
      peVerdict:sides.PE?sides.PE.verdict:null
    })).filter(r=>r.ce!=null||r.pe!=null).sort((a,b)=>a.sym.localeCompare(b.sym));
    res.json({status:true,stocks:rows,count:rows.length});
  }catch(e){
    res.status(500).json({status:false,message:e.message});
  }
});


// ─── AUTO SERVER-SIDE SCAN (additive, does not touch existing scan/login code) ───
const AUTOSCAN_STOCKS_FALLBACK = [{sym:"360ONE",token:"13061",lot:500},{sym:"ABB",token:"13",lot:125},{sym:"ABCAPITAL",token:"21614",lot:3100},{sym:"ADANIENSOL",token:"10217",lot:675},{sym:"ADANIENT",token:"25",lot:309},{sym:"ADANIGREEN",token:"3563",lot:600},{sym:"ADANIPORTS",token:"15083",lot:475},{sym:"ADANIPOWER",token:"17388",lot:3550},{sym:"ALKEM",token:"11703",lot:125},{sym:"AMBER",token:"1185",lot:100},{sym:"AMBUJACEM",token:"1270",lot:1050},{sym:"ANGELONE",token:"324",lot:2500},{sym:"APLAPOLLO",token:"25780",lot:350},{sym:"APOLLOHOSP",token:"157",lot:125},{sym:"ASHOKLEY",token:"212",lot:5000},{sym:"ASIANPAINT",token:"236",lot:250},{sym:"ASTRAL",token:"14418",lot:425},{sym:"AUBANK",token:"21238",lot:1000},{sym:"AUROPHARMA",token:"275",lot:550},{sym:"AXISBANK",token:"5900",lot:625},{sym:"BAJAJ-AUTO",token:"16669",lot:75},{sym:"BAJAJFINSV",token:"16675",lot:250},{sym:"BAJAJHLDNG",token:"305",lot:50},{sym:"BAJFINANCE",token:"317",lot:750},{sym:"BANDHANBNK",token:"2263",lot:3600},{sym:"BANKBARODA",token:"4668",lot:2925},{sym:"BANKINDIA",token:"4745",lot:5200},{sym:"BDL",token:"2144",lot:350},{sym:"BEL",token:"383",lot:1425},{sym:"BHARATFORG",token:"422",lot:500},{sym:"BHARTIARTL",token:"10604",lot:475},{sym:"BHEL",token:"438",lot:2625},{sym:"BIOCON",token:"11373",lot:2500},{sym:"BLUESTARCO",token:"8311",lot:325},{sym:"BOSCHLTD",token:"2181",lot:25},{sym:"BPCL",token:"526",lot:1975},{sym:"BRITANNIA",token:"547",lot:125},{sym:"BSE",token:"19585",lot:375},{sym:"CAMS",token:"342",lot:750},{sym:"CANBK",token:"10794",lot:6750},{sym:"CDSL",token:"21174",lot:475},{sym:"CGPOWER",token:"760",lot:850},{sym:"CHOLAFIN",token:"19257",lot:625},{sym:"CIPLA",token:"694",lot:375},{sym:"COALINDIA",token:"20374",lot:1350},{sym:"COCHINSHIP",token:"21508",lot:400},{sym:"COFORGE",token:"11543",lot:375},{sym:"COLPAL",token:"15141",lot:225},{sym:"CONCOR",token:"4749",lot:1250},{sym:"CROMPTON",token:"17094",lot:1800},{sym:"CUMMINSIND",token:"1901",lot:200},{sym:"DABUR",token:"772",lot:1250},{sym:"DALBHARAT",token:"8075",lot:325},{sym:"DELHIVERY",token:"9599",lot:2075},{sym:"DIVISLAB",token:"10940",lot:100},{sym:"DIXON",token:"21690",lot:50},{sym:"DLF",token:"14732",lot:825},{sym:"DMART",token:"19913",lot:150},{sym:"DRREDDY",token:"881",lot:625},{sym:"EICHERMOT",token:"910",lot:100},{sym:"ETERNAL",token:"5097",lot:2425},{sym:"EXIDEIND",token:"676",lot:1800},{sym:"FEDERALBNK",token:"1023",lot:2500},{sym:"FORCEMOT",token:"11573",lot:25},{sym:"FORTIS",token:"14592",lot:775},{sym:"GAIL",token:"4717",lot:3150},{sym:"GLENMARK",token:"7406",lot:375},{sym:"GMRAIRPORT",token:"13528",lot:6975},{sym:"GODFRYPHLP",token:"1181",lot:275},{sym:"GODREJCP",token:"10099",lot:500},{sym:"GODREJPROP",token:"17875",lot:275},{sym:"GRASIM",token:"1232",lot:250},{sym:"HAL",token:"2303",lot:150},{sym:"HAVELLS",token:"9819",lot:500},{sym:"HCLTECH",token:"7229",lot:350},{sym:"HDFCAMC",token:"4244",lot:300},{sym:"HDFCBANK",token:"1333",lot:550},{sym:"HDFCLIFE",token:"467",lot:1100},{sym:"HEROMOTOCO",token:"1348",lot:150},{sym:"HINDALCO",token:"1363",lot:700},{sym:"HINDPETRO",token:"1406",lot:2025},{sym:"HINDUNILVR",token:"1394",lot:300},{sym:"HINDZINC",token:"1424",lot:1225},{sym:"HYUNDAI",token:"25844",lot:275},{sym:"ICICIBANK",token:"4963",lot:700},{sym:"ICICIGI",token:"21770",lot:325},{sym:"ICICIPRULI",token:"18652",lot:925},{sym:"IDEA",token:"14366",lot:71475},{sym:"IDFCFIRSTB",token:"11184",lot:9275},{sym:"IEX",token:"220",lot:3750},{sym:"INDHOTEL",token:"1512",lot:1000},{sym:"INDIANB",token:"14309",lot:1000},{sym:"INDIGO",token:"11195",lot:150},{sym:"INDUSINDBK",token:"5258",lot:700},{sym:"INDUSTOWER",token:"29135",lot:1700},{sym:"INFY",token:"1594",lot:400},{sym:"INOXWIND",token:"7852",lot:3575},{sym:"IOC",token:"1624",lot:4875},{sym:"IREDA",token:"20261",lot:3450},{sym:"IRFC",token:"2029",lot:4250},{sym:"ITC",token:"1660",lot:1600},{sym:"JINDALSTEL",token:"6733",lot:625},{sym:"JIOFIN",token:"18143",lot:2350},{sym:"JSWENERGY",token:"17869",lot:1000},{sym:"JSWSTEEL",token:"11723",lot:675},{sym:"JUBLFOOD",token:"18096",lot:1250},{sym:"KALYANKJIL",token:"2955",lot:1175},{sym:"KAYNES",token:"12092",lot:100},{sym:"KEI",token:"13310",lot:175},{sym:"KFINTECH",token:"13359",lot:500},{sym:"KOTAKBANK",token:"1922",lot:2000},{sym:"KPITTECH",token:"9683",lot:425},{sym:"LAURUSLABS",token:"19234",lot:850},{sym:"LICHSGFIN",token:"1997",lot:1000},{sym:"LICI",token:"9480",lot:1400},{sym:"LODHA",token:"3220",lot:450},{sym:"LT",token:"11483",lot:175},{sym:"LTF",token:"24948",lot:2250},{sym:"LTM",token:"17818",lot:150},{sym:"LUPIN",token:"10440",lot:425},{sym:"M&M",token:"2031",lot:200},{sym:"MANAPPURAM",token:"19061",lot:3000},{sym:"MANKIND",token:"15380",lot:225},{sym:"MARICO",token:"4067",lot:1200},{sym:"MARUTI",token:"10999",lot:50},{sym:"MAXHEALTH",token:"22377",lot:525},{sym:"MAZDOCK",token:"509",lot:200},{sym:"MCX",token:"31181",lot:625},{sym:"MFSL",token:"2142",lot:400},{sym:"MOTHERSON",token:"25510",lot:6150},{sym:"MOTILALOFS",token:"14947",lot:775},{sym:"MPHASIS",token:"4503",lot:275},{sym:"MUTHOOTFIN",token:"23650",lot:275},{sym:"NAM-INDIA",token:"357",lot:625},{sym:"NATIONALUM",token:"6364",lot:1875},{sym:"NAUKRI",token:"13751",lot:375},{sym:"NBCC",token:"31415",lot:6500},{sym:"NESTLEIND",token:"17963",lot:500},{sym:"NHPC",token:"17400",lot:6400},{sym:"NMDC",token:"15332",lot:6750},{sym:"NTPC",token:"11630",lot:1500},{sym:"NYKAA",token:"6545",lot:3125},{sym:"OBEROIRLTY",token:"20242",lot:350},{sym:"OFSS",token:"10738",lot:75},{sym:"OIL",token:"17438",lot:1400},{sym:"ONGC",token:"2475",lot:2250},{sym:"PAGEIND",token:"14413",lot:15},{sym:"PATANJALI",token:"17029",lot:900},{sym:"PAYTM",token:"6705",lot:725},{sym:"PFC",token:"14299",lot:1300},{sym:"PERSISTENT",token:"18365",lot:100},{sym:"PETRONET",token:"11351",lot:1900},{sym:"PGEL",token:"25358",lot:950},{sym:"PHOENIXLTD",token:"14552",lot:350},{sym:"PIDILITIND",token:"2664",lot:500},{sym:"PIIND",token:"24184",lot:175},{sym:"PNB",token:"10666",lot:8000},{sym:"PNBHOUSING",token:"18908",lot:650},{sym:"POLICYBZR",token:"6656",lot:350},{sym:"POLYCAB",token:"9590",lot:125},{sym:"POWERGRID",token:"14977",lot:1900},{sym:"PREMIERENE",token:"25049",lot:575},{sym:"PRESTIGE",token:"20302",lot:450},{sym:"RADICO",token:"10990",lot:150},{sym:"RBLBANK",token:"18391",lot:3175},{sym:"RECLTD",token:"15355",lot:1400},{sym:"RELIANCE",token:"2885",lot:500},{sym:"RVNL",token:"9552",lot:1525},{sym:"SAIL",token:"2963",lot:4700},{sym:"SBICARD",token:"17971",lot:800},{sym:"SBILIFE",token:"21808",lot:375},{sym:"SBIN",token:"3045",lot:750},{sym:"SHREECEM",token:"3103",lot:25},{sym:"SHRIRAMFIN",token:"4306",lot:825},{sym:"SIEMENS",token:"3150",lot:175},{sym:"SOLARINDS",token:"13332",lot:50},{sym:"SONACOMS",token:"4684",lot:1225},{sym:"SRF",token:"3273",lot:200},{sym:"SUNPHARMA",token:"3351",lot:350},{sym:"SUPREMEIND",token:"3363",lot:175},{sym:"SUZLON",token:"12018",lot:9025},{sym:"SWIGGY",token:"27066",lot:1300},{sym:"TATACONSUM",token:"3432",lot:550},{sym:"TATAELXSI",token:"3411",lot:100},{sym:"TATAPOWER",token:"3426",lot:1450},{sym:"TATASTEEL",token:"3499",lot:2750},{sym:"TCS",token:"11536",lot:175},{sym:"TECHM",token:"13538",lot:600},{sym:"TIINDIA",token:"312",lot:200},{sym:"TITAN",token:"3506",lot:175},{sym:"TORNTPHARM",token:"3518",lot:125},{sym:"TRENT",token:"1964",lot:150},{sym:"TVSMOTOR",token:"8479",lot:175},{sym:"ULTRACEMCO",token:"11532",lot:50},{sym:"UNIONBANK",token:"10753",lot:4425},{sym:"UNITDSPR",token:"10447",lot:400},{sym:"UNOMINDA",token:"14154",lot:550},{sym:"UPL",token:"11287",lot:1355},{sym:"VBL",token:"18921",lot:1125},{sym:"VEDL",token:"3063",lot:1150},{sym:"VOLTAS",token:"3718",lot:375},{sym:"WIPRO",token:"3787",lot:3000},{sym:"YESBANK",token:"11915",lot:31100},{sym:"ZYDUSLIFE",token:"7929",lot:900}];
const AUTOSCAN_IDX = [{sym:"NIFTY",token:"99926000",lot:65,isIndex:!0},{sym:"BANKNIFTY",token:"99926009",lot:30,isIndex:!0},{sym:"FINNIFTY",token:"99926037",lot:60,isIndex:!0},{sym:"MIDCPNIFTY",token:"99926074",lot:120,isIndex:!0}];
let SERVER_SIGNALS = [];
let serverScanRunning = false;
let serverScanCount = 0;
let SERVER_MAX_CAPITAL = 30000; // capital cap per lot (rough pre-filter, adjustable)

// Dynamic stock list cache — refreshed from /fno-stock-list (Angel One scrip master),
// falls back to the static list above if the derive fails or hasn't run yet.
let AUTOSCAN_STOCKS_DYNAMIC = null;
let autoscanListFetchTime = 0;
const AUTOSCAN_LIST_TTL = 14400000; // 4 hours, matches instrument master cache elsewhere

async function getAutoscanStockList() {
  if (AUTOSCAN_STOCKS_DYNAMIC && (Date.now() - autoscanListFetchTime) < AUTOSCAN_LIST_TTL) {
    return AUTOSCAN_STOCKS_DYNAMIC;
  }
  try {
    const r = await axios.get(`http://localhost:${PORT}/fno-stock-list`, {timeout:30000});
    if (r.data && r.data.status && r.data.stocks && r.data.stocks.length) {
      const valid = r.data.stocks.filter(s => s.token && s.lot);
      if (valid.length) {
        AUTOSCAN_STOCKS_DYNAMIC = valid;
        autoscanListFetchTime = Date.now();
        log(`[AUTOSCAN] Stock list refreshed from scrip master: ${valid.length} stocks`, "OK");
        return AUTOSCAN_STOCKS_DYNAMIC;
      }
    }
  } catch(e) {
    log(`[AUTOSCAN] Stock list auto-derive failed, using fallback: ${e.message}`, "WARN");
  }
  return AUTOSCAN_STOCKS_FALLBACK;
}

// Rough pre-filter using lot size alone (premium isn't known until after the API call).
// Assumes a conservative minimum realistic premium of ₹5 to estimate worst-case cost;
// symbols whose lot size alone would blow the cap even at ₹5 premium are skipped upfront.
function isLotTooExpensive(stk) {
  if (!stk.lot) return false;
  const roughMinCost = 5 * stk.lot * 1.2;
  return roughMinCost > SERVER_MAX_CAPITAL;
}

async function runServerScan() {
  if (!isAuthenticated()) return;
  if (serverScanRunning) return;
  const ms = marketStatus();
  if (!ms.open) return;
  serverScanRunning = true;
  try {
    const stockList = await getAutoscanStockList();
    const allSyms = [...AUTOSCAN_IDX, ...stockList].filter(s => s.isIndex || !isLotTooExpensive(s));
    const batch = allSyms.slice(serverScanCount % allSyms.length, (serverScanCount % allSyms.length) + 15);
    serverScanCount += 15;
    const results = [];
    for (const stk of batch) {
      try {
        const q = await axios.post(`http://localhost:${PORT}/quote`, {mode:"FULL",exchangeTokens:{NSE:[String(stk.token)]}}, {headers:{"Content-Type":"application/json"}});
        const spot = parseFloat(q.data?.data?.fetched?.[0]?.ltp || 0);
        if (!spot) continue;
        for (const typ of ["CE","PE"]) {
          const sig = await axios.post(`http://localhost:${PORT}/signal-analysis`, {symbolToken:String(stk.token),sym:stk.sym,exchange:"NSE",isIndex:!!stk.isIndex,spotPrice:spot,type:typ}, {headers:{"Content-Type":"application/json"}});
          const g = sig.data;
          if (g && g.status && g.score >= 60 && g.verdict !== "AVOID" && g.verdict !== "TRAP") {
            results.push({sym:stk.sym,type:typ,score:g.score,verdict:g.verdict,spotPrice:spot,ts:Date.now()});
          }
        }
      } catch(e) { /* skip symbol on error, continue loop */ }
    }
    if (results.length) {
      SERVER_SIGNALS = [...results, ...SERVER_SIGNALS].slice(0, 100);
      log(`[AUTOSCAN] ${results.length} signals found (server-side, background-safe)`, "OK");
    }
  } catch(e) {
    log(`[AUTOSCAN] error: ${e.message}`, "WARN");
  } finally {
    serverScanRunning = false;
  }
}

setInterval(runServerScan, 25000);

app.get("/auto-scan-status", (req, res) => {
  res.json({status:true, authenticated:isAuthenticated(), signals:SERVER_SIGNALS, count:SERVER_SIGNALS.length});
});

loadSignalLogFromDisk();
app.listen(PORT,()=>{
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║   NSE F&O Signal Engine — DILIP FXO v5.1                     ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║   Server  : http://localhost:${PORT}                                  ║`);
  console.log("║   v3.1: /market-status /oi-history /signal-log               ║");
  console.log("║   v3.3: OI momentum in scoring · 100-total weights            ║");
  console.log("║   v3.4: VIX→GammaBlast, NSE cookie refresh, log persist      ║");
  console.log("║   v5.0: Volume scoring · notifications · zero-premium skip   ║");
  console.log("║   v5.1: PCR delta scoring · OI velocity bonus · banner sync  ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  log("Listening for connections...","OK");
});















