const express=require("express"),cors=require("cors"),axios=require("axios"),speakeasy=require("speakeasy"),fs=require("fs"),path=require("path"),webpush=require("web-push"),app=express(),PORT=process.env.PORT||3001;

// ── PUSH NOTIFICATIONS (Web Push / VAPID) ──────────────────
const VAPID_PUBLIC_KEY="BJQoaQv0vQqD2Z8luZjUiK35MmJFquAZRsVlwa61qPk42_UoUU20UtDGdjgvLrThYVlvGs6FJ8pFsO_QPATLP9s";
const VAPID_PRIVATE_KEY="LEr9ayJQtXgauVlB8p16Sex5hbctaN5-IIlQ2S1JvLw";
webpush.setVapidDetails("mailto:dilip@fxo.local",VAPID_PUBLIC_KEY,VAPID_PRIVATE_KEY);
const PUSH_SUB_FILE=path.join(__dirname,"push-subscriptions.json");
let PUSH_SUBS=[];
try{if(fs.existsSync(PUSH_SUB_FILE))PUSH_SUBS=JSON.parse(fs.readFileSync(PUSH_SUB_FILE,"utf8"));}catch(e){}
function savePushSubs(){try{fs.writeFileSync(PUSH_SUB_FILE,JSON.stringify(PUSH_SUBS));}catch(e){}}
async function sendPushToAll(title,body,tag){
  const payload=JSON.stringify({title,body,tag:tag||"fno-signal"});
  const dead=[];
  for(const sub of PUSH_SUBS){
    try{await webpush.sendNotification(sub,payload);}
    catch(e){if(e.statusCode===410||e.statusCode===404)dead.push(sub);}
  }
  if(dead.length){PUSH_SUBS=PUSH_SUBS.filter(s=>!dead.includes(s));savePushSubs();}
}
app.use(cors({origin:"*"})),app.use(express.json({limit:"10mb"})),app.use(express.static(__dirname));

const SESSION={jwtToken:"",refreshToken:"",feedToken:"",apiKey:"",clientCode:"",expiresAt:0};
function isAuthenticated(){return SESSION.jwtToken&&Date.now()<SESSION.expiresAt}
function log(e,t="INFO"){const a=(new Date).toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit",second:"2-digit"});console.log(`[${a}] [${t}] ${e}`)}

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
    // Stocks: monthly, but roll to NEXT month 5 days before expiry (matches getExpiryType logic)
    const curMonthLastTue=lastWeekdayOfMonth(2);
    const dteToCurMonth=Math.round((curMonthLastTue-now)/86400000);
    const INDICES_LIST=["BANKNIFTY","FINNIFTY","MIDCPNIFTY"];
    const isIndexSym=INDICES_LIST.includes(sym);
    if(!isIndexSym && dteToCurMonth<=5){
      // Stock within 5 days of expiry — use NEXT month's last Tuesday instead
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

const ANGEL_API="https://apiconnect.angelbroking.com";

function generateTOTP(e){if(!e||e.trim().length<16)return"";try{const t=e.trim().replace(/\s+/g,"").toUpperCase();return speakeasy.totp({secret:t,encoding:"base32",digits:6,step:30,time:Math.floor(Date.now()/1e3)})}catch(e){return log(`TOTP generation failed: ${e.message}`,"WARN"),""}}
function getHeaders(e=!1){const t={"Content-Type":"application/json",Accept:"application/json","X-UserType":"USER","X-SourceID":"WEB","X-ClientLocalIP":"127.0.0.1","X-ClientPublicIP":"127.0.0.1","X-MACAddress":"00:11:22:33:44:55","X-PrivateKey":SESSION.apiKey||""};return e&&SESSION.jwtToken&&(t.Authorization=`Bearer ${SESSION.jwtToken}`),t}

let _lastRefreshAttempt=0,_refreshInProgress=!1;
async function refreshToken(){if(!SESSION.refreshToken||!SESSION.apiKey||!SESSION.clientCode)return!1;const e=Date.now();if(_refreshInProgress)return!1;if(e-_lastRefreshAttempt<3e4)return log("Token refresh skipped — cooldown active","INFO"),!1;_refreshInProgress=!0,_lastRefreshAttempt=e;try{log("Refreshing expired Angel One token...","INFO");const e=await axios.post(`${ANGEL_API}/rest/auth/angelbroking/jwt/v1/generateTokens`,{refreshToken:SESSION.refreshToken},{headers:getHeaders(!1),timeout:15e3});return e.data?.status&&e.data?.data?.jwtToken?(SESSION.jwtToken=e.data.data.jwtToken,SESSION.refreshToken=e.data.data.refreshToken||SESSION.refreshToken,SESSION.expiresAt=Date.now()+288e5,log("Token refreshed successfully","OK"),_refreshInProgress=!1,!0):(_refreshInProgress=!1,!1)}catch(e){return log(`Token refresh failed: ${e.message}`,"WARN"),_refreshInProgress=!1,!1}}

async function angelRequest(e,t,a,s={}){try{const n={headers:getHeaders(!0),timeout:2e4,...s};return"GET"===e?await axios.get(t,n):await axios.post(t,a,n)}catch(n){const o=n.response?.status;if(401===o&&SESSION.refreshToken){if(await refreshToken()){const n={headers:getHeaders(!0),timeout:2e4,...s};return"GET"===e?await axios.get(t,n):await axios.post(t,a,n)}}throw 403===o&&await new Promise(e=>setTimeout(e,2e3)),n}}

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

const FNO_LIST_CACHE={data:null,fetchTime:0};
const FNO_LIST_TTL=24*60*60*1000; // refresh once a day
const IDX_UNDERLYINGS=["NIFTY","BANKNIFTY","FINNIFTY","MIDCPNIFTY"];
async function buildFnoStockList(){
  const resp=await axios.get("https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json",{timeout:45000});
  const master=resp.data;
  // Step 1: find every distinct underlying "name" that has NFO stock options (OPTSTK) — this IS the F&O universe
  const fnoNames=new Set();
  const fnoLotByName={};
  for(const row of master){
    if(row.exch_seg==="NFO" && (row.instrumenttype==="OPTSTK"||row.instrumenttype==="FUTSTK")){
      fnoNames.add(row.name);
      fnoLotByName[row.name]=parseInt(row.lotsize)||1;
    }
  }
  // Step 2: find NSE equity token for each F&O-eligible underlying (for spot price/candles)
  const eqTokenByName={};
  for(const row of master){
    if(row.exch_seg==="NSE" && row.symbol && row.symbol.endsWith("-EQ")){
      const baseSym=row.symbol.replace(/-EQ$/,"");
      if(fnoNames.has(baseSym)) eqTokenByName[baseSym]=row.token;
    }
  }
  // Step 3: assemble final stock list — only include names where we found BOTH an eq token AND an fno lot
  const stocks=[];
  for(const name of fnoNames){
    if(eqTokenByName[name]){
      stocks.push({sym:name,token:eqTokenByName[name],lot:fnoLotByName[name]});
    }
  }
  stocks.sort((a,b)=>a.sym.localeCompare(b.sym));
  // Step 4: derive current index option lot sizes (OPTIDX) for NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY
  const idxLotByName={};
  for(const row of master){
    if(row.exch_seg==="NFO" && row.instrumenttype==="OPTIDX" && IDX_UNDERLYINGS.includes(row.name)){
      idxLotByName[row.name]=parseInt(row.lotsize)||idxLotByName[row.name];
    }
  }
  return{stocks,idxLots:idxLotByName};
}
app.get("/fno-stock-list",async(e,t)=>{
  if(!isAuthenticated())return t.status(401).json({status:!1,message:"Not authenticated — login first"});
  try{
    const forceRefresh=e.query.refresh==="1";
    if(!forceRefresh && FNO_LIST_CACHE.data && Date.now()-FNO_LIST_CACHE.fetchTime<FNO_LIST_TTL){
      return t.json({status:!0,cached:!0,count:FNO_LIST_CACHE.data.stocks.length,stocks:FNO_LIST_CACHE.data.stocks,idxLots:FNO_LIST_CACHE.data.idxLots,fetchedAt:new Date(FNO_LIST_CACHE.fetchTime).toISOString()});
    }
    log("Auto-deriving F&O stock list from Angel One scrip master...","INFO");
    const result=await buildFnoStockList();
    FNO_LIST_CACHE.data=result;
    FNO_LIST_CACHE.fetchTime=Date.now();
    log(`F&O stock list derived: ${result.stocks.length} stocks with valid token+lot`,"OK");
    t.json({status:!0,cached:!1,count:result.stocks.length,stocks:result.stocks,idxLots:result.idxLots,fetchedAt:new Date(FNO_LIST_CACHE.fetchTime).toISOString()});
  }catch(e){
    const msg=e.response?.data?.message||e.message;
    log(`F&O list derive error: ${msg}`,"ERR");
    t.status(500).json({status:!1,message:msg});
  }
});
app.post("/verify-tokens",async(e,t)=>{
  if(!isAuthenticated())return t.status(401).json({status:!1,message:"Not authenticated — login first"});
  try{
    const stocks=e.body.stocks; // [{sym, token, lot}]
    if(!Array.isArray(stocks))return t.status(400).json({status:!1,message:"stocks array required"});
    log("Verifying "+stocks.length+" tokens against fresh Angel One scrip master...","INFO");
    const resp=await axios.get("https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json",{timeout:45000});
    const master=resp.data;
    // Build lookup: NSE equity symbol -> {token, lotsize}
    const eqLookup={};
    for(const row of master){
      if(row.exch_seg==="NSE" && row.symbol && row.symbol.endsWith("-EQ")){
        const baseSym=row.symbol.replace(/-EQ$/,"");
        eqLookup[baseSym]={token:row.token,lot:row.lotsize};
      }
    }
    const results=[];
    let mismatches=0,missing=0,ok=0;
    for(const s of stocks){
      const fresh=eqLookup[s.sym];
      if(!fresh){
        results.push({sym:s.sym,status:"NOT_FOUND",yourToken:s.token,freshToken:null,yourLot:s.lot,freshLot:null});
        missing++;
        continue;
      }
      const tokenMatch=String(fresh.token)===String(s.token);
      const lotMatch=String(fresh.lot)===String(s.lot);
      if(tokenMatch&&lotMatch){
        ok++;
        results.push({sym:s.sym,status:"OK",yourToken:s.token,freshToken:fresh.token,yourLot:s.lot,freshLot:fresh.lot});
      }else{
        mismatches++;
        results.push({sym:s.sym,status:"MISMATCH",yourToken:s.token,freshToken:fresh.token,yourLot:s.lot,freshLot:fresh.lot,tokenMatch,lotMatch});
      }
    }
    log(`Token verify done: ${ok} OK, ${mismatches} MISMATCH, ${missing} NOT_FOUND`,mismatches||missing?"WARN":"OK");
    t.json({status:!0,summary:{ok,mismatches,missing,total:stocks.length},results:results.filter(r=>r.status!=="OK")});
  }catch(e){
    const msg=e.response?.data?.message||e.message;
    log(`Token verify error: ${msg}`,"ERR");
    t.status(500).json({status:!1,message:msg});
  }
});
app.get("/health",(e,t)=>{const a=Object.keys(BIAS_CACHE).length,s=Object.values(BIAS_CACHE).filter(e=>Date.now()-e.fetchTime<BIAS_TTL).length;const ms=marketStatus();t.json({status:"ok",authenticated:isAuthenticated(),client:SESSION.clientCode||null,tokenExpiry:SESSION.expiresAt?new Date(SESSION.expiresAt).toLocaleTimeString("en-IN"):null,market:ms,biasCache:{total:a,fresh:s},oiHistorySymbols:Object.keys(OI_HISTORY).length,signalLogCount:SIGNAL_LOG.length})})
app.post("/clear-cache",(e,t)=>{const a=Object.keys(BIAS_CACHE).length;Object.keys(BIAS_CACHE).forEach(e=>delete BIAS_CACHE[e]),log(`Bias cache cleared (${a} entries removed)`,"INFO"),t.json({status:!0,message:`Cleared ${a} cache entries`})})
app.get("/push-public-key",(e,t)=>{t.json({status:!0,publicKey:VAPID_PUBLIC_KEY})});
app.post("/push-subscribe",(e,t)=>{
  try{
    const sub=e.body;
    if(!sub||!sub.endpoint)return t.status(400).json({status:!1,message:"Invalid subscription"});
    const exists=PUSH_SUBS.some(s=>s.endpoint===sub.endpoint);
    if(!exists){PUSH_SUBS.push(sub);savePushSubs();log("Push subscription added — total: "+PUSH_SUBS.length,"OK");}
    t.json({status:!0,message:"Subscribed"});
  }catch(e){t.status(500).json({status:!1,message:e.message});}
});
app.post("/push-unsubscribe",(e,t)=>{
  try{
    const{endpoint:a}=e.body;
    PUSH_SUBS=PUSH_SUBS.filter(s=>s.endpoint!==a);
    savePushSubs();
    t.json({status:!0,message:"Unsubscribed"});
  }catch(e){t.status(500).json({status:!1,message:e.message});}
});
app.post("/push-test",async(e,t)=>{
  try{await sendPushToAll("🔔 Test Notification","DILIP FXO push is working!","test");t.json({status:!0,sent:PUSH_SUBS.length});}
  catch(e){t.status(500).json({status:!1,message:e.message});}
});
app.post("/push-signal",async(e,t)=>{
  try{
    const{sym:a,strike:s,type:n,verdict:o,score:r,spotPrice:i}=e.body;
    if(!a)return t.status(400).json({status:!1,message:"sym required"});
    const title="📡 "+a+" "+s+" "+n;
    const body=(o||"")+" · Score "+(r||0)+"% · Spot ₹"+(i?Math.round(i).toLocaleString("en-IN"):"--");
    await sendPushToAll(title,body,"signal-"+a+"-"+n);
    t.json({status:!0,sent:PUSH_SUBS.length});
  }catch(e){t.status(500).json({status:!1,message:e.message});}
});
app.post("/login",async(e,t)=>{try{const{clientCode:a,password:s,apiKey:n,totpSecret:o}=e.body;if(!a||!s||!n)return log("Login: Missing required fields","WARN"),t.status(400).json({status:!1,message:"clientCode, password, and apiKey are required"});SESSION.clientCode=a,SESSION.apiKey=n;let r="";o&&o.trim()&&(r=generateTOTP(o),r?log(`TOTP generated: ${r}`):log("TOTP secret invalid — proceeding without 2FA","WARN")),log(`Authenticating ${a}...`);const i=(await axios.post(`${ANGEL_API}/rest/auth/angelbroking/user/v1/loginByPassword`,{clientcode:a,password:s,totp:r},{headers:getHeaders(!1),timeout:25e3})).data;if(!0===i.status&&i.data)return SESSION.jwtToken=i.data.jwtToken,SESSION.refreshToken=i.data.refreshToken,SESSION.feedToken=i.data.feedToken,SESSION.expiresAt=Date.now()+288e5,log(`✅ Login successful — ${a}`,"OK"),t.json({status:!0,message:"Login successful",client:a,tokenExpiry:new Date(SESSION.expiresAt).toLocaleTimeString("en-IN")});const l=i.message||i.errorcode||"Unknown error";return log(`❌ Login failed: ${l}`,"ERR"),t.status(401).json({status:!1,message:l})}catch(e){const a=e.response?.data?.message||e.response?.data?.errorcode||e.message;log(`❌ Login error: ${a}`,"ERR"),t.status(500).json({status:!1,message:a||"Connection error — check if Angel One API is reachable"})}})
app.post("/quote",async(e,t)=>{if(!isAuthenticated())return t.status(401).json({status:!1,message:"Not authenticated — login first"});try{const a=await angelRequest("POST",`${ANGEL_API}/rest/secure/angelbroking/market/v1/quote/`,e.body);t.json(a.data)}catch(e){const a=e.response?.data?.message||e.message;log(`Quote error: ${a}`,"WARN"),t.status(e.response?.status||500).json({status:!1,message:a})}})
app.post("/candles",async(e,t)=>{if(!isAuthenticated())return t.status(401).json({status:!1,message:"Not authenticated"});try{const a=await angelRequest("POST",`${ANGEL_API}/rest/secure/angelbroking/historical/v1/getCandleData`,e.body);t.json(a.data)}catch(e){const a=e.response?.data?.message||e.message;t.status(e.response?.status||500).json({status:!1,message:a})}})

const BIAS_CACHE={},BIAS_TTL=3e5;
let _lastAngelCall=0;
async function angelRateLimit(){const e=Date.now()-_lastAngelCall;e<300&&await new Promise(t=>setTimeout(t,300-e)),_lastAngelCall=Date.now()}
let _lastCandleCall=0;
async function throttledCandleRequest(e,t){const a=Date.now()-_lastCandleCall;return a<600&&await new Promise(e=>setTimeout(e,600-a)),_lastCandleCall=Date.now(),angelRequest("POST",`${ANGEL_API}/rest/secure/angelbroking/historical/v1/getCandleData`,e)}

function calcEMA(e,t){if(e.length<t)return null;const a=2/(t+1);let s=e.slice(0,t).reduce((e,t)=>e+t,0)/t;for(let n=t;n<e.length;n++)s=e[n]*a+s*(1-a);return parseFloat(s.toFixed(2))}
function calcRSI14(e){if(e.length<15)return 50;let t=0,a=0;for(let s=1;s<=14;s++){const n=e[s]-e[s-1];n>0?t+=n:a-=n}let s=t/14,n=a/14;for(let t=15;t<e.length;t++){const a=e[t]-e[t-1];s=(13*s+Math.max(a,0))/14,n=(13*n+Math.max(-a,0))/14}return 0===n?100:parseFloat((100-100/(1+s/n)).toFixed(2))}
function calcMACD(e,t=12,a=26,s=9){if(e.length<a+s)return null;const n=[],o=[],r=2/(t+1),i=2/(a+1);let l=e.slice(0,t).reduce((e,t)=>e+t,0)/t;n.push(l);for(let a=t;a<e.length;a++)l=e[a]*r+l*(1-r),n.push(l);let c=e.slice(0,a).reduce((e,t)=>e+t,0)/a;o.push(c);for(let t=a;t<e.length;t++)c=e[t]*i+c*(1-i),o.push(c);const u=a-t,p=o.map((e,t)=>parseFloat((n[t+u]-e).toFixed(4)));if(p.length<s)return null;const d=2/(s+1);let g=p.slice(0,s).reduce((e,t)=>e+t,0)/s;const m=[g];for(let e=s;e<p.length;e++)g=p[e]*d+g*(1-d),m.push(g);const h=p[p.length-1],S=m[m.length-1],E=p[p.length-2],f=m[m.length-2],I=parseFloat((h-S).toFixed(4));let N="NONE";return void 0!==E&&void 0!==f&&(E<=f&&h>S?N="BULLISH":E>=f&&h<S&&(N="BEARISH")),{macdLine:parseFloat(h.toFixed(4)),signalLine:parseFloat(S.toFixed(4)),histogram:I,crossover:N,aboveSignal:h>S}}
function calcATR(e,t=14){if(e.length<t+1)return null;const a=[];for(let t=1;t<e.length;t++){const s=parseFloat(e[t][2]),n=parseFloat(e[t][3]),o=parseFloat(e[t-1][4]);a.push(Math.max(s-n,Math.abs(s-o),Math.abs(n-o)))}let s=a.slice(0,t).reduce((e,t)=>e+t,0)/t;for(let e=t;e<a.length;e++)s=(s*(t-1)+a[e])/t;return parseFloat(s.toFixed(2))}
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
  try{const e=new Date,n=new Date(e.toLocaleString("en-US",{timeZone:"Asia/Kolkata"})),o=n.toISOString().slice(0,10),r=new Date(n);let i=1;1===r.getDay()?i=3:0===r.getDay()&&(i=2),r.setDate(r.getDate()-i);const l=r.toISOString().slice(0,10),c=new Date(n);c.setDate(c.getDate()-10);const u=c.toISOString().slice(0,10)+" 09:15",p=o+" 15:30";let d;try{d=await throttledCandleRequest({exchange:s,symboltoken:a,interval:"FIFTEEN_MINUTE",fromdate:u,todate:p},s)}catch(e){const t=e.response?.status;if(403!==t&&429!==t)throw e;log(`Candle 403/429 for ${a} — waiting 2s then retrying`,"WARN"),await new Promise(e=>setTimeout(e,2e3)),_lastCandleCall=Date.now(),d=await angelRequest("POST",`${ANGEL_API}/rest/secure/angelbroking/historical/v1/getCandleData`,{exchange:s,symboltoken:a,interval:"FIFTEEN_MINUTE",fromdate:u,todate:p})}const g=d.data?.data||[];if(g.length<10){const e={status:!0,bias:"NEUTRAL",ltp:null,ema20:null,ema50:null,rsi:50,vwap:null,aboveVwap:null,pdh:null,pdl:null,orb_high:null,orb_low:null,volRatio:1,macd:null,atr:null,supertrend:null,isExpiryDay:!1,atrStopLong:null,atrStopShort:null,candleCount:g.length,fromCache:!1};return BIAS_CACHE[a]={data:e,fetchTime:Date.now()},t.json(e)}const m=g.map(e=>parseFloat(e[4]));(g.map(e=>parseFloat(e[5])));const h=calcEMA(m,20),S=calcEMA(m,50),E=m[m.length-1];let f="NEUTRAL";h&&S?E>h&&h>S?f="BULLISH":E<h&&h<S&&(f="BEARISH"):h&&(f=E>h?"BULLISH":"BEARISH");const I=g.filter(e=>e[0].slice(0,10)===l),N=I.length?Math.max(...I.map(e=>parseFloat(e[2]))):null,A=I.length?Math.min(...I.map(e=>parseFloat(e[3]))):null,k=g.filter(e=>e[0].slice(0,10)===o),C=k.slice(0,2),O=C.length?Math.max(...C.map(e=>parseFloat(e[2]))):null,T=C.length?Math.min(...C.map(e=>parseFloat(e[3]))):null,y=k.reduce((e,t)=>e+parseFloat(t[5]),0),w=g.filter(e=>e[0].slice(0,10)!==o),b={};w.forEach(e=>{const t=e[0].slice(0,10);b[t]=(b[t]||0)+parseFloat(e[5])});const _=Object.values(b),F=_.length?_.reduce((e,t)=>e+t,0)/_.length:0,R=26,x=Math.min(k.length/R,1),P=F*Math.max(x,.15),L=P>0?parseFloat((y/P).toFixed(2)):1,D=calcRSI14(m),$=calcMACD(m),M=calcATR(g),U=calcSupertrend(g);
  const expiryInfo=getExpiryWeekInfo("");
  let B=0,j=0;k.forEach(e=>{const t=(parseFloat(e[2])+parseFloat(e[3])+parseFloat(e[4]))/3,a=parseFloat(e[5]);B+=t*a,j+=a});const H=j>0?parseFloat((B/j).toFixed(2)):null;
// Volume+Price direction match
const recentCandles=k.slice(-3);const volUp=recentCandles.reduce((s,c)=>s+parseFloat(c[5]),0)/Math.max(recentCandles.length,1);const priceUp=recentCandles.length>=2&&parseFloat(recentCandles[recentCandles.length-1][4])>parseFloat(recentCandles[0][4]);const priceDown=recentCandles.length>=2&&parseFloat(recentCandles[recentCandles.length-1][4])<parseFloat(recentCandles[0][4]);const volMatch=L>=1.2&&((f==="BULLISH"&&priceUp)||(f==="BEARISH"&&priceDown));const volFake=L>=1.2&&((f==="BULLISH"&&priceDown)||(f==="BEARISH"&&priceUp));
// Volume dry up: last 3 candles all below 0.5x avg
const last3Vols=k.slice(-3).map(c=>parseFloat(c[5]));const avgVolPerCandle=P>0?P/Math.max(R,1):1;const volDryUp=last3Vols.length===3&&last3Vols.every(v=>v<0.5*avgVolPerCandle);
const V={status:!0,bias:f,ltp:E,ema20:h,ema50:S,rsi:D,vwap:H,aboveVwap:H?E>H:null,pdh:N,pdl:A,orb_high:O,orb_low:T,volRatio:L,volPriceDir:volMatch?"MATCH":volFake?"FAKE":"NEUTRAL",volDryUp,macd:$||null,atr:M||null,supertrend:U||null,isExpiryDay:expiryInfo.isNSEExpiryDay,isExpiryWeek:expiryInfo.isNSEExpiryWeek,gammaWarning:expiryInfo.gammaWarning,daysToExpiry:expiryInfo.daysToNSEExpiry,atrStopLong:M&&E?parseFloat((E-1.5*M).toFixed(2)):null,atrStopShort:M&&E?parseFloat((E+1.5*M).toFixed(2)):null,candleCount:g.length,fromCache:!1};BIAS_CACHE[a]={data:{...V,fromCache:!0},fetchTime:Date.now()},log(`Bias ${a}: ${f} RSI=${D} EMA20=${h} bars=${g.length} expWk=${expiryInfo.isNSEExpiryWeek}`,"INFO"),t.json(V)}catch(e){const s=e.response?.status,o=e.response?.data?.message||e.message;if(log(`market-bias error [${s||"?"}] token=${a}: ${o}`,"WARN"),n)return log(`Serving stale bias cache for ${a}`,"INFO"),t.json({...n.data,fromCache:!0,stale:!0});t.json({status:!0,bias:"NEUTRAL",ltp:null,ema20:null,ema50:null,rsi:50,vwap:null,aboveVwap:null,pdh:null,pdl:null,orb_high:null,orb_low:null,volRatio:1,candleCount:0,fromCache:!1,error:o})}})

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
  // STOCKS only — switch to next month 5 days before expiry
  if(dte<=5){
    log(`${t}: ${dte}d to expiry — stock switching to next month`,"INFO");
    return"NEXT_MONTH";
  }
  return"MONTHLY";
}

app.get("/india-vix",async(e,t)=>{if(VIX_CACHE.data&&Date.now()-VIX_CACHE.fetchTime<3e5)return t.json(VIX_CACHE.data);try{const e=await getNSECookie(),a={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",Accept:"application/json, text/plain, */*",Referer:"https://www.nseindia.com/",Origin:"https://www.nseindia.com","sec-ch-ua-platform":'"Windows"',"Sec-Fetch-Dest":"empty","Sec-Fetch-Mode":"cors","Sec-Fetch-Site":"same-origin"};e&&(a.Cookie=e);const s=await axios.get("https://www.nseindia.com/api/allIndices",{headers:a,timeout:12e3}),n=(s.data?.data||[]).find(e=>"INDIA VIX"===e.index);if(!n){const e=await axios.get("https://www.nseindia.com/api/quote-derivative?symbol=INDIAVIX",{headers:a,timeout:12e3}),s=e.data?.underlyingValue||null;if(s){const e=buildVixResult(parseFloat(s),null,null,null);return VIX_CACHE.data=e,VIX_CACHE.fetchTime=Date.now(),t.json(e)}return t.json({status:!1,message:"India VIX not found in NSE indices"})}const o=buildVixResult(parseFloat(n.last||0),parseFloat(n.change||0),parseFloat(n.percentChange||0),parseFloat(n.previousClose||0));VIX_CACHE.data=o,VIX_CACHE.fetchTime=Date.now(),log(`India VIX: ${o.vix} (${o.regime}) chg=${o.changePct}%`,"INFO"),t.json(o)}catch(e){if(log(`India VIX fetch failed: ${e.message}`,"WARN"),VIX_CACHE.data)return t.json({...VIX_CACHE.data,stale:!0});t.json({status:!0,vix:null,regime:"UNKNOWN",premiumBuyable:!0,message:"VIX unavailable"})}})

app.post("/oi-analysis",async(e,t)=>{
  if(!isAuthenticated())return t.status(401).json({status:!1,message:"Not authenticated"});
  // MARKET HOURS GATE for OI
  const ms=marketStatus();
  if(!ms.open){
    log(`OI analysis blocked — market ${ms.code}`,"WARN");
    return t.status(400).json({status:!1,message:`Market is ${ms.label} — OI data will be stale. Scan only between 9:15 AM and 3:30 PM IST.`,marketStatus:ms});
  }
  const{symbol:a,spotPrice:s,expiry:n}=e.body;
  if(!a||!s)return t.status(400).json({status:!1,message:"symbol and spotPrice required"});
  const o=n||getExpiryType(a);
  try{if(!SESSION._instruments||Date.now()-(SESSION._instrFetchTime||0)>144e5){log("Downloading NFO instrument master for OI analysis...","INFO");const de=await axios.get("https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json",{timeout:3e4});SESSION._instruments=de.data,SESSION._instrFetchTime=Date.now()}const i=a.toUpperCase(),l=parseFloat(s),c=new Date,u={JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};function r(e){if(!e)return null;const t=String(e).trim().toUpperCase(),a=t.match(/^(\d{1,2})([A-Z]{3})(\d{4})$/);if(a){const e=u[a[2]];if(void 0!==e)return new Date(+a[3],e,+a[1])}const s=t.match(/^(\d{4})(\d{2})(\d{2})$/);if(s)return new Date(+s[1],+s[2]-1,+s[3]);const n=t.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(n)return new Date(+n[1],+n[2]-1,+n[3]);const o=new Date(e);return isNaN(o)?null:o}// Use 3:30 PM IST as expiry cutoff (not midnight) so today's contracts included until close
const _expiryEnd=new Date(c);_expiryEnd.setHours(15,30,0,0);
const p=SESSION._instruments.filter(e=>{if("NFO"!==e.exch_seg)return!1;if(!e.instrumenttype||!e.instrumenttype.includes("OPT"))return!1;const t=r(e.expiry);if(!t)return!1;const _tEnd=new Date(t);_tEnd.setHours(15,30,0,0);if(_tEnd<c)return!1;if(e.name&&e.name.toUpperCase()===i)return!0;if(e.symbol){const t=e.symbol.toUpperCase();if(t.startsWith(i)&&t.length>i.length&&/\d/.test(t[i.length]))return!0}return!1});if(!p.length)return t.json({status:!1,message:`No NFO options for ${i}`});const d=[...new Set(p.map(e=>e.expiry))].map(e=>({raw:e,date:r(e)})).filter(e=>e.date&&e.date>=c).sort((e,t)=>e.date-t.date);let g;if("MONTHLY"===o){
  const ge=c.getMonth(),me=c.getFullYear(),he=d.filter(e=>e.date.getMonth()===ge&&e.date.getFullYear()===me);
  g=(he[he.length-1]||d[0])?.raw;
}else if("NEXT_MONTH"===o){
  const Se=(c.getMonth()+1)%12,Ee=11===c.getMonth()?c.getFullYear()+1:c.getFullYear(),fe=d.filter(e=>e.date.getMonth()===Se&&e.date.getFullYear()===Ee);
  g=(fe[fe.length-1]||d[1]||d[0])?.raw;
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
}if(!g)return t.json({status:!1,message:"No valid expiry"});const m=p.filter(e=>e.expiry===g),h=[...new Set(m.map(e=>Math.round(parseFloat(e.strike)/100)))].filter(e=>e>0).sort((e,t)=>e-t),S=h.reduce((e,t)=>Math.abs(t-l)<Math.abs(e-l)?t:e,h[0]),E=h.indexOf(S),f=10,I=h.slice(Math.max(0,E-f),E+f+1),N=[],A={};for(const Ie of I){const Ne=100*Ie,Ae=m.filter(e=>Math.round(parseFloat(e.strike))===Ne&&e.symbol?.toUpperCase().endsWith("CE")),ke=m.filter(e=>Math.round(parseFloat(e.strike))===Ne&&e.symbol?.toUpperCase().endsWith("PE"));Ae[0]?.token&&(N.push(String(Ae[0].token)),A[String(Ae[0].token)]={strike:Ie,type:"CE"}),ke[0]?.token&&(N.push(String(ke[0].token)),A[String(ke[0].token)]={strike:Ie,type:"PE"})}const k={},C=50;for(let Ce=0;Ce<N.length;Ce+=C){const Oe=N.slice(Ce,Ce+C);try{const Te=await axios.post(`${ANGEL_API}/rest/secure/angelbroking/market/v1/quote/`,{mode:"FULL",exchangeTokens:{NFO:Oe}},{headers:getHeaders(!0),timeout:2e4});Te.data.status&&Te.data.data?.fetched&&Te.data.data.fetched.forEach(e=>{const t=A[String(e.symbolToken)];t&&(k[t.strike]||(k[t.strike]={}),k[t.strike][t.type]={ltp:parseFloat(e.ltp||e.close||0),oi:parseInt(e.opnInterest||e.openInterest||e.oi||0),oiChange:parseInt(e.netChangeOI||e.netChange||e.oiChange||0),volume:parseInt(e.tradeVolume||e.volume||0),prevClose:parseFloat(e.close||e.previousClose||0)})})}catch(ye){log(`OI batch fetch error: ${ye.message}`,"WARN")}}
  const exInfo=getExpiryWeekInfo(i);
  const thMul=exInfo.thresholdMultiplier;
  const O=I.map(e=>({strike:e,isATM:e===S,CE_ltp:k[e]?.CE?.ltp??null,CE_oi:k[e]?.CE?.oi??0,CE_oiChange:k[e]?.CE?.oiChange??0,CE_vol:k[e]?.CE?.volume??0,CE_prevClose:k[e]?.CE?.prevClose??null,PE_ltp:k[e]?.PE?.ltp??null,PE_oi:k[e]?.PE?.oi??0,PE_oiChange:k[e]?.PE?.oiChange??0,PE_vol:k[e]?.PE?.volume??0,PE_prevClose:k[e]?.PE?.prevClose??null})),T=O.reduce((e,t)=>e+(t.CE_oi||0),0),y=O.reduce((e,t)=>e+(t.PE_oi||0),0),w=T>0?parseFloat((y/T).toFixed(3)):null,b=null===w?"NEUTRAL":w>1.3?"BULLISH":w<.7?"BEARISH":"NEUTRAL",_=calcMaxPain(O),F=O.length>1?Math.abs(O[1].strike-O[0].strike):5,R=O.filter(e=>e.strike>S),x=O.filter(e=>e.strike<S),P=O.find(e=>e.strike===S)||{},L=R.map(e=>({strike:e.strike,oi:e.CE_oi,change:e.CE_oiChange})).sort((e,t)=>t.oi-e.oi),D=L[0]||null,$=R.reduce((e,t)=>e+(t.CE_oi||0),0),M=x.map(e=>({strike:e.strike,oi:e.PE_oi,change:e.PE_oiChange})).sort((e,t)=>t.oi-e.oi),U=M[0]||null,v=x.reduce((e,t)=>e+(t.PE_oi||0),0),B=x.map(e=>({strike:e.strike,oi:e.CE_oi,change:e.CE_oiChange})).sort((e,t)=>t.oi-e.oi).reduce((e,t)=>e+(t.oi||0),0),j=B>.3*$,H=R.map(e=>({strike:e.strike,oi:e.PE_oi,change:e.PE_oiChange})).sort((e,t)=>t.oi-e.oi).reduce((e,t)=>e+(t.oi||0),0),V=H>.3*v,W=(T+y)/(2*O.length||1),G=D&&D.oi>1.5*W*thMul,X=U&&U.oi>1.5*W*thMul,K=!D||D.oi<.7*W*thMul,Y=!U||U.oi<.7*W*thMul;let q="NEUTRAL",J="";G&&Y?(q="PE",J=`High CE ceiling (${D?.oi?.toLocaleString("en-IN")}) + weak PE floor = price free to fall`):X&&K?(q="CE",J=`High PE floor (${U?.oi?.toLocaleString("en-IN")}) + weak CE ceiling = price free to rise`):G&&X?(q="AVOID",J="Both sides strong = price trapped = avoid"):(q="NEUTRAL",J="No clear OI dominance");const Z=O.filter(e=>e.strike>=S-2*F&&e.strike<=S+2*F).reduce((e,t)=>e+(t.PE_oiChange||0),0)/4,z=O.filter(e=>e.strike>=S-2*F&&e.strike<=S+2*F).reduce((e,t)=>e+(t.CE_oiChange||0),0)/4,Q=Z>50&&"BEARISH"!==b,ee=z>50&&"BULLISH"!==b,te=(()=>{const e=z>5,t="BULLISH"===b;return e&&!t?{signal:"SHORT_BUILDUP",action:"BUY_PE",note:"Ramesh adding ceiling — bearish"}:e&&t?{signal:"LONG_BUILDUP",action:"CAUTION",note:"Both adding — uncertain"}:e||t?!e&&t?{signal:"SHORT_COVERING",action:"BUY_CE",note:"Ramesh RUNNING — buy CE fast!"}:{signal:"NEUTRAL",action:"WAIT",note:"No clear signal"}:{signal:"LONG_UNWINDING",action:"HOLD_CE",note:"Ramesh booking profit"}})(),ae=(()=>{const e=Z>5,t="BEARISH"===b;return e&&t?{signal:"LONG_BUILDUP",action:"BUY_CE",note:"Suresh adding floor — bullish"}:e&&!t?{signal:"PUT_TRAP",action:"AVOID_PE",note:"⚠️ PUT TRAP! Suresh collecting premium!"}:!e&&t?{signal:"LONG_UNWINDING",action:"HOLD_CE",note:"Suresh booking profit"}:e||t?{signal:"NEUTRAL",action:"WAIT",note:"No clear signal"}:{signal:"PUT_COVERING",action:"BUY_PE",note:"Suresh RUNNING — buy PE fast!"}})();let se="NEUTRAL",ne=0,oe=[];"CE"===q?(ne+=40,se="CE",oe.push(`Formula: ${J}`)):"PE"===q?(ne+=40,se="PE",oe.push(`Formula: ${J}`)):"AVOID"===q&&oe.push("Formula: Both trapped — avoid"),("BUY_CE"===te.action&&"PE"!==se||"BUY_PE"===te.action&&"CE"!==se)&&(ne+=20,oe.push(`CE: ${te.note}`)),("BUY_CE"===ae.action&&"CE"===se||"BUY_PE"===ae.action&&"PE"===se)&&(ne+=20,oe.push(`PE: ${ae.note}`)),"PE"===se&&Q&&(ne-=30,oe.push("⚠️ PUT TRAP risk detected!")),"CE"===se&&ee&&(ne-=30,oe.push("⚠️ CALL TRAP risk detected!")),"CE"===se&&j&&(ne+=20,oe.push("Ramesh trapped below = short covering likely")),"PE"===se&&V&&(ne+=20,oe.push("Suresh trapped above = put covering likely")),ne=Math.max(0,Math.min(100,ne));if(exInfo.isNSEExpiryWeek){oe.push(`⚠️ Expiry week (${exInfo.daysToNSEExpiry}d left) — OI thresholds tighter, gamma elevated`);}
  const re=ne>=70?"STRONG":ne>=50?"MODERATE":ne>=30?"WEAK":"AVOID",ie=R.filter(e=>e.CE_oi>0).sort((e,t)=>e.strike-t.strike)[0]?.strike||null,le=x.filter(e=>e.PE_oi>0).sort((e,t)=>t.strike-e.strike)[0]?.strike||null,ce=L.slice(0,3).map(e=>({strike:e.strike,oi:e.oi,oiChange:e.change,strength:e.oi>2*W?"STRONG":e.oi>W?"MEDIUM":"WEAK"})),ue=M.slice(0,3).map(e=>({strike:e.strike,oi:e.oi,oiChange:e.change,strength:e.oi>2*W?"STRONG":e.oi>W?"MEDIUM":"WEAK"})),pe=O.map(e=>({strike:e.strike,pcr:e.CE_oi>0?parseFloat((e.PE_oi/e.CE_oi).toFixed(2)):null,CE_oi:e.CE_oi,PE_oi:e.PE_oi,CE_change:e.CE_oiChange,PE_change:e.PE_oiChange,position:e.strike>S?"ABOVE":e.strike<S?"BELOW":"ATM",rameshStrength:e.CE_oi>1.5*W?"STRONG":e.CE_oi>.7*W?"MEDIUM":"WEAK",sureshStrength:e.PE_oi>1.5*W?"STRONG":e.PE_oi>.7*W?"MEDIUM":"WEAK"}));
  // Detect gamma blast
  const exInfoForGamma=getExpiryWeekInfo(i);
  // Pass real VIX from cache if available
  const _vixForGamma=VIX_CACHE.data&&VIX_CACHE.data.vix?VIX_CACHE.data.vix:null;
  const _isIndexSym=["NIFTY","BANKNIFTY","FINNIFTY","MIDCPNIFTY","SENSEX","BANKEX"].includes(i);
const gbResult=detectGammaBlast({spotPrice:l,atmStrike:S,atmCeOI:P.CE_oi||0,atmPeOI:P.PE_oi||0,totalCeOI:T,totalPeOI:y},exInfoForGamma,_vixForGamma,_isIndexSym);
  const oiResult={status:!0,symbol:i,expiry:g,atmStrike:S,spotPrice:l,pcr:w,pcrBias:b,maxPain:_,totalCeOI:T,totalPeOI:y,chain:O,nearMaxPain:!!_&&Math.abs(l-_)/l<.01,nearSupport:!!le&&Math.abs(l-le)/l<.005,nearResistance:!!ie&&Math.abs(l-ie)/l<.005,supportStrike:le,resistStrike:ie,ceWalls:ce,peFloors:ue,rameshTrapped:j,sureshTrapped:V,rameshTrappedOI:B,sureshTrappedOI:H,dilipFormula:q,dilipFormulaNote:J,ceSignal:te,peSignal:ae,putTrapRisk:Q,callTrapRisk:ee,oiRecommendation:se,oiScore:ne,oiVerdict:re,oiNotes:oe,strikePCR:pe,atmCeOI:P.CE_oi||0,atmPeOI:P.PE_oi||0,atmPCR:P.CE_oi>0?parseFloat((P.PE_oi/P.CE_oi).toFixed(2)):null,oiBattleBias:"CE"===se?"BULLISH":"PE"===se?"BEARISH":"NEUTRAL",oiBattleSummary:oe,expiryWeek:exInfo.isNSEExpiryWeek,daysToExpiry:exInfo.daysToNSEExpiry,gammaWarning:exInfo.gammaWarning,gammaBlast:gbResult};
  // Save OI snapshot for trend tracking
  saveOISnapshot(i, oiResult);
  log(`OI ${i}: PCR=${w} OIRec=${se} Score=${ne} Formula=${q} ExpiryWk=${exInfo.isNSEExpiryWeek}`,"INFO");
  t.json(oiResult)}catch(we){const be=we.response?.data?.message||we.message;log(`OI analysis error: ${be}`,"WARN"),t.status(500).json({status:!1,message:be})}})

const SIGNAL_WEIGHTS={marketBias:18,supertrend:10,rsi:10,macd:5,aboveVwap:10,orbBreakout:7,volumeConfirm:12,instFlow:3,pcrBias:5,pcrDelta:8,vixRegime:3,newsSentiment:0,geoRisk:0,expiryRisk:6,oiMomentum:22,gammaBlast:15,dilipOIFormula:25},MAX_SCORE=Object.values(SIGNAL_WEIGHTS).reduce((e,t)=>e+t,0);
function scoreSignal(e,t){const a="CE"===t,s={};let n=!1,o="";null!==e.vixValue&&e.vixValue>=30&&(n=!0,o=`India VIX at ${e.vixValue} — extreme panic, avoid directional trades`);{const t=SIGNAL_WEIGHTS.marketBias;let n=0,o="";a?"BULLISH"===e.bias?(n=t,o="EMA bullish trend ✓"):"NEUTRAL"===e.bias?(n=.5*t,o="EMA neutral — partial"):(n=0,o="EMA bearish — against CE"):"BEARISH"===e.bias?(n=t,o="EMA bearish trend ✓"):"NEUTRAL"===e.bias?(n=.5*t,o="EMA neutral — partial"):(n=0,o="EMA bullish — against PE"),s.marketBias={earned:n,max:t,pass:n>=.5*t,note:o}}{const t=SIGNAL_WEIGHTS.supertrend;if(e.supertrend){const n="UP"===e.supertrend.trend,o=e.supertrend.signal===(a?"BUY":"SELL");let r=0,i="";a?n&&o?(r=t,i="Supertrend UP + fresh BUY signal ✓✓"):n?(r=.7*t,i="Supertrend UP ✓"):(r=0,i="Supertrend DOWN — against CE"):!n&&o?(r=t,i="Supertrend DOWN + fresh SELL signal ✓✓"):n?(r=0,i="Supertrend UP — against PE"):(r=.7*t,i="Supertrend DOWN ✓"),s.supertrend={earned:r,max:t,pass:r>0,note:i}}else s.supertrend={earned:.5*t,max:t,pass:null,note:"No data — neutral"}}{const t=SIGNAL_WEIGHTS.rsi,n=e.rsi||50;
  const oiConfirmsBullish=e.dilipFormula==="CE";
  const oiConfirmsBearish=e.dilipFormula==="PE";
  let o=0,r="";
  if(a){
    // CE: with OI confirmation, momentum RSI (60-85) is a GOOD sign, not overbought penalty
    if(oiConfirmsBullish && n>=60 && n<85){o=t;r=`RSI ${n} — strong momentum, OI-confirmed ✓✓`;}
    else if(n>85){o=.15*t;r=`RSI ${n} — extreme/blow-off risk, caution`;}
    else if(n<35){o=t;r=`RSI ${n} — oversold, strong CE`;}
    else if(n<45){o=.8*t;r=`RSI ${n} — below midline`;}
    else if(n<60){o=.6*t;r=`RSI ${n} — neutral`;}
    else if(n<70){o=.5*t;r=`RSI ${n} — elevated, no OI confirm yet`;}
    else{o=.3*t;r=`RSI ${n} — overbought, no OI confirm`;}
  }else{
    // PE: with OI confirmation, momentum RSI (15-40) is a GOOD sign, not oversold penalty
    if(oiConfirmsBearish && n<=40 && n>15){o=t;r=`RSI ${n} — strong down-momentum, OI-confirmed ✓✓`;}
    else if(n<15){o=.15*t;r=`RSI ${n} — extreme/capitulation risk, caution`;}
    else if(n>65){o=t;r=`RSI ${n} — overbought, strong PE`;}
    else if(n>55){o=.8*t;r=`RSI ${n} — above midline`;}
    else if(n>40){o=.6*t;r=`RSI ${n} — neutral`;}
    else if(n>30){o=.5*t;r=`RSI ${n} — low, no OI confirm yet`;}
    else{o=.3*t;r=`RSI ${n} — oversold, no OI confirm`;}
  }
  s.rsi={earned:o,max:t,pass:o>=.4*t,note:r}
}{const t=SIGNAL_WEIGHTS.macd;if(e.macd){let n=0,o="";const r=e.macd.aboveSignal,i=e.macd.crossover;a?"BULLISH"===i?(n=t,o="MACD fresh bullish crossover ✓✓"):r?(n=.6*t,o="MACD above signal ✓"):"BEARISH"===i?(n=0,o="MACD fresh bearish cross — bad"):(n=.2*t,o="MACD below signal, weak"):"BEARISH"===i?(n=t,o="MACD fresh bearish crossover ✓✓"):r?"BULLISH"===i?(n=0,o="MACD fresh bullish cross — bad"):(n=.2*t,o="MACD above signal, weak"):(n=.6*t,o="MACD below signal ✓"),s.macd={earned:n,max:t,pass:n>=.5*t,note:o}}else s.macd={earned:.5*t,max:t,pass:null,note:"No data — neutral"}}{const n=SIGNAL_WEIGHTS.aboveVwap;if(null===e.aboveVwap)s.aboveVwap={earned:.5*n,max:n,pass:null,note:"VWAP data unavailable"};else{const o=a?e.aboveVwap:!e.aboveVwap;s.aboveVwap={earned:o?n:0,max:n,pass:o,note:o?`Price ${a?"above":"below"} VWAP ✓`:`Price ${a?"below":"above"} VWAP — against ${t}`}}}{const t=SIGNAL_WEIGHTS.orbBreakout,n=a?e.orb_high:e.orb_low;const _orbNow=new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Kolkata"}));
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
}}{const t=SIGNAL_WEIGHTS.instFlow;let n=0,o="";a?"BULLISH"===e.instBias?(n=t,o=`FII/DII bullish ₹${e.fiiNet}Cr ✓`):"NEUTRAL"===e.instBias?(n=.5*t,o="FII/DII neutral"):(n=0,o=`FII/DII bearish ₹${e.fiiNet}Cr`):"BEARISH"===e.instBias?(n=t,o=`FII/DII bearish ₹${e.fiiNet}Cr ✓`):"NEUTRAL"===e.instBias?(n=.5*t,o="FII/DII neutral"):(n=0,o=`FII/DII bullish ₹${e.fiiNet}Cr`),s.instFlow={earned:n,max:t,pass:n>=.5*t,note:o}}{const t=SIGNAL_WEIGHTS.pcrBias;if(e.pcr){let n=0,o="";a?"BULLISH"===e.pcrBias?(n=t,o=`PCR ${e.pcr} — bullish ✓`):"NEUTRAL"===e.pcrBias?(n=.5*t,o=`PCR ${e.pcr} — neutral`):(n=0,o=`PCR ${e.pcr} — bearish`):"BEARISH"===e.pcrBias?(n=t,o=`PCR ${e.pcr} — bearish ✓`):"NEUTRAL"===e.pcrBias?(n=.5*t,o=`PCR ${e.pcr} — neutral`):(n=0,o=`PCR ${e.pcr} — bullish`),s.pcrBias={earned:n,max:t,pass:n>=.5*t,note:o}}else s.pcrBias={earned:.5*t,max:t,pass:null,note:"PCR unavailable"}}{const t=SIGNAL_WEIGHTS.vixRegime,a=e.vixRegime||"UNKNOWN",n=e.vixValue;let o=0,r="";"VERY_LOW"===a?(o=t,r=`VIX ${n} — very low, cheap options ✓✓`):"LOW"===a?(o=t,r=`VIX ${n} — low, good conditions ✓`):"NORMAL"===a?(o=.7*t,r=`VIX ${n} — normal`):"ELEVATED"===a?(o=.4*t,r=`VIX ${n} — elevated, options pricey`):"HIGH"===a?(o=.1*t,r=`VIX ${n} — high, reduce size`):"EXTREME"===a?(o=0,r=`VIX ${n} — extreme, hard block`):(o=.5*t,r="VIX unknown — neutral"),s.vixRegime={earned:o,max:t,pass:o>=.4*t,note:r}}{const t=SIGNAL_WEIGHTS.newsSentiment,n=e.newsSentimentScore||50;let o=0,r="";a?n>=60?(o=t,r=`News bullish (${n}%) ✓`):n>=40?(o=.5*t,r=`News neutral (${n}%)`):(o=0,r=`News bearish (${n}%)`):n<=40?(o=t,r=`News bearish (${n}%) ✓`):n<=60?(o=.5*t,r=`News neutral (${n}%)`):(o=0,r=`News bullish (${n}%)`),s.newsSentiment={earned:o,max:t,pass:o>=.5*t,note:r}}{const t=SIGNAL_WEIGHTS.geoRisk,a=e.newsGeoRisk||0;let n=0,o="";0===a?(n=t,o="No geopolitical risk ✓"):a<=3?(n=.7*t,o=`Low geo risk (${a})`):a<=6?(n=.3*t,o=`Moderate geo risk (${a})`):(n=0,o=`High geo risk (${a}) — caution`),s.geoRisk={earned:n,max:t,pass:a<=6,note:o}}{
// EXPIRY RISK scoring (replaces old expiryDay)
const t=SIGNAL_WEIGHTS.expiryRisk;
let exEarned=t,exNote="";
const dte=e.daysToExpiry;
// Use OI-analysis daysToExpiry (which reflects actual contract being scanned — next month on expiry day)
// NOT isExpiryDay which always refers to current month expiry
// dte = days to expiry of the CONTRACT being scanned
// >5 = safe (normal trading), 1-5 = expiry week (caution), <=0 = expiry day (avoid)
const tradingCurrentExpiry = typeof dte==="number" && dte <= 0;
const inExpiryWeek = typeof dte==="number" && dte > 0 && dte <= 5;
const safeContract = typeof dte!=="number" || dte > 5;
if(tradingCurrentExpiry){
  exEarned=0;exNote="⚠️ Expiry day contract — avoid, switch to next";
} else if(inExpiryWeek){
  exEarned=Math.round(t*0.3);exNote=`⚠️ Expiry week (${dte}d left) — gamma elevated, reduce size`;
} else {
  exEarned=t;exNote=`Safe contract (${typeof dte==="number"?dte+"d":"?"} to expiry) ✓`;
}
s.expiryRisk={earned:exEarned,max:t,pass:exEarned>=t*0.5,note:exNote};}
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
// PCR DELTA SCORING — sudden PCR shift between scans
// Uses oiTrendData.history PCR values (already available)
const PCR_DELTA_MAX=SIGNAL_WEIGHTS.pcrDelta||8;
let pcrDeltaEarned=0,pcrDeltaNote="No PCR history — neutral";
try{
  const hist=e.oiTrendData?.history;
  if(hist&&hist.length>=2){
    const latestPCR=hist[hist.length-1]?.pcr||0;
    const prevPCR=hist[hist.length-2]?.pcr||0;
    if(prevPCR>0){
      const pcrShift=((latestPCR-prevPCR)/prevPCR)*100; // % change
      if(a){// CE signal — rising PCR = Suresh arriving = bullish
        if(pcrShift>=20){pcrDeltaEarned=PCR_DELTA_MAX;pcrDeltaNote=`PCR spike +${pcrShift.toFixed(1)}% — Suresh army arriving ✓✓`;}
        else if(pcrShift>=10){pcrDeltaEarned=Math.round(PCR_DELTA_MAX*0.6);pcrDeltaNote=`PCR rising +${pcrShift.toFixed(1)}% — bullish shift ✓`;}
        else if(pcrShift<=-15){pcrDeltaEarned=0;pcrDeltaNote=`PCR dropping ${pcrShift.toFixed(1)}% — bearish shift, CE caution`;}
        else{pcrDeltaEarned=Math.round(PCR_DELTA_MAX*0.3);pcrDeltaNote=`PCR stable (${pcrShift.toFixed(1)}%) — neutral`;}
      }else{// PE signal — falling PCR = Ramesh arriving = bearish
        if(pcrShift<=-20){pcrDeltaEarned=PCR_DELTA_MAX;pcrDeltaNote=`PCR drop ${pcrShift.toFixed(1)}% — Ramesh army arriving ✓✓`;}
        else if(pcrShift<=-10){pcrDeltaEarned=Math.round(PCR_DELTA_MAX*0.6);pcrDeltaNote=`PCR falling ${pcrShift.toFixed(1)}% — bearish shift ✓`;}
        else if(pcrShift>=15){pcrDeltaEarned=0;pcrDeltaNote=`PCR rising +${pcrShift.toFixed(1)}% — bullish shift, PE caution`;}
        else{pcrDeltaEarned=Math.round(PCR_DELTA_MAX*0.3);pcrDeltaNote=`PCR stable (${pcrShift.toFixed(1)}%) — neutral`;}
      }
    }
  }
}catch(pcrErr){}
s.pcrDelta={earned:pcrDeltaEarned,max:PCR_DELTA_MAX,pass:pcrDeltaEarned>=PCR_DELTA_MAX*0.4,note:pcrDeltaNote};
}{
// GAMMA BLAST scoring
const t=SIGNAL_WEIGHTS.gammaBlast||15;
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
  if(isPutCallTrap){
    // Block trap only when score is also weak — strong technicals (>=65) override trap on non-expiry days
    if(stockInOwnExpiry||finalScore<65){
      n=true;o=s.dilipOIFormula?.note||"OI trap detected — signal blocked";
    }
  } else if(isAvoid&&stockInOwnExpiry){
    n=true;o=s.dilipOIFormula?.note||"Both sides trapped — stock expiry week";
  }
  // AVOID on non-expiry + NEUTRAL → no hard block, score cap handles it
}

// SCORE CAP: only when OI explicitly says WRONG DIRECTION (not NEUTRAL)
// NEUTRAL = insufficient data → allow signal through, no cap
// Wrong direction = OI says PE but scanning CE (or vice versa) → cap at 59
const oiWrongDir=oiEarned===0&&oiPass===false&&!n;
if(oiWrongDir){
  finalScore=Math.min(finalScore,59);
  const capReason=oiFormula==="AVOID"?" ⚠️ [Both trapped — capped, not blocked]":" ⚠️ [OI direction mismatch — capped]";
  if(s.dilipOIFormula)s.dilipOIFormula.note+=capReason;
}
return{score:finalScore,totalEarned:parseFloat(r.toFixed(1)),totalPossible:i,breakdown:s,hardBlock:n,hardBlockReason:o}}

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
    Promise.resolve({data:NEWS_CACHE.data||{sentiment:"NEUTRAL",sentimentScore:50,geoRisk:0}}),r?axios.post(`http://localhost:${PORT}/oi-analysis`,{symbol:s,spotPrice:r,expiry:getExpiryType(s)},{headers:{"Content-Type":"application/json"}}):Promise.resolve({data:null})]),p="fulfilled"===e.status?e.value.data:{},d="fulfilled"===o.status?o.value.data:{},g="fulfilled"===l.status?l.value.data:{},m="fulfilled"===c.status?c.value.data:{},h="fulfilled"===u.status&&u.value.data?.status?u.value.data:null,S={sym:s,type:i,bias:p.bias||"NEUTRAL",ema20:p.ema20||null,ema50:p.ema50||null,rsi:p.rsi??50,vwap:p.vwap||null,aboveVwap:p.aboveVwap??null,pdh:p.pdh||null,pdl:p.pdl||null,orb_high:p.orb_high||null,orb_low:p.orb_low||null,volRatio:p.volRatio??1,volPriceDir:p.volPriceDir||"NEUTRAL",volDryUp:p.volDryUp||false,ltp:p.ltp||r||null,macd:p.macd||null,atr:p.atr||null,supertrend:p.supertrend||null,atrStopLong:p.atrStopLong||null,atrStopShort:p.atrStopShort||null,isExpiryDay:p.isExpiryDay||getExpiryWeekInfo(s).isNSEExpiryDay||false,instBias:d.instBias||"NEUTRAL",fiiNet:d.fiiNet??0,diiNet:d.diiNet??0,vixValue:g.vix||null,vixRegime:g.regime||"UNKNOWN",premiumBuyable:!1!==g.premiumBuyable,vixGuidance:g.guidance||"",newsSentiment:m.sentiment||"NEUTRAL",newsSentimentScore:m.sentimentScore??50,newsGeoRisk:m.geoRisk??0,pcr:h?.pcr||null,pcrBias:h?.pcrBias||"NEUTRAL",maxPain:h?.maxPain||null,oiSupportStrike:h?.supportStrike||null,oiResistStrike:h?.resistStrike||null,nearMaxPain:h?.nearMaxPain||!1,nearSupport:h?.nearSupport||!1,nearResistance:h?.nearResistance||!1,dilipFormula:h?.dilipFormula||"NEUTRAL",dilipFormulaNote:h?.dilipFormulaNote||"",ceSignal:h?.ceSignal||null,peSignal:h?.peSignal||null,putTrapRisk:h?.putTrapRisk||!1,callTrapRisk:h?.callTrapRisk||!1,oiRecommendation:h?.oiRecommendation||"NEUTRAL",oiScore:h?.oiScore||0,oiVerdict:h?.oiVerdict||"WEAK",oiNotes:h?.oiNotes||[],ceWalls:h?.ceWalls||[],peFloors:h?.peFloors||[],rameshTrapped:h?.rameshTrapped||!1,sureshTrapped:h?.sureshTrapped||!1,oiBattleBias:h?.oiBattleBias||"NEUTRAL",oiBattleSummary:h?.oiBattleSummary||[],gammaBlast:h?.gammaBlast||null,atmCeOI:h?.atmCeOI||0,atmPeOI:h?.atmPeOI||0,atmPCR:h?.atmPCR||null,strikePCR:h?.strikePCR||[]};
  // Attach OI trend history
  const oiTrend=getOITrend(s?.toUpperCase()||"");
  S.oiTrendData=oiTrend;
  const{score:E,totalEarned:f,totalPossible:I,breakdown:N,hardBlock:A,hardBlockReason:k}=scoreSignal(S,i);
  let C,O;A?(C="TRAP",O=k):E>=75?(C="STRONG",O="High conviction — trade with normal size"):E>=60?(C="MODERATE",O="Good setup — consider half position size"):E>=42?(C="WEAK",O="Marginal setup — watch, wait for more confirmation"):(C="AVOID",O="Poor alignment — skip this signal");let T=null,y=null,w=null;if(S.atr&&S.ltp){T="CE"===i?parseFloat((S.ltp-1.5*S.atr).toFixed(2)):parseFloat((S.ltp+1.5*S.atr).toFixed(2)),y="CE"===i?parseFloat((S.ltp+2.5*S.atr).toFixed(2)):parseFloat((S.ltp-2.5*S.atr).toFixed(2));const e=Math.abs(S.ltp-T),t=Math.abs(S.ltp-y);w=e>0?parseFloat((t/e).toFixed(2)):null}const b=Object.entries(N).filter(([,e])=>!1!==e.pass&&e.earned>0).sort((e,t)=>t[1].earned-e[1].earned).slice(0,1).map(([,e])=>e.note.replace(/✓✓|✓|★/g,"").trim()),_=Object.entries(N).filter(([,e])=>!1===e.pass).map(([,e])=>e.note);
  // LOG THE SIGNAL
  const signalId=logSignal(s,i,E,C,S.ltp,N);
  log(`Signal ${s} ${i}: score=${E} verdict=${C} VIX=${S.vixValue} RSI=${S.rsi} bias=${S.bias}`,"INFO");
  (()=>{let safeS={};try{const j=JSON.stringify(S);safeS=JSON.parse(j);}catch(e){Object.keys(S).forEach(k=>{try{JSON.stringify(S[k]);safeS[k]=S[k];}catch(e){}});}t.json({status:!0,sym:s,type:i,score:E,totalEarned:f,totalPossible:I,verdict:C,actionNote:O,hardBlock:A,hardBlockReason:A?k:null,breakdown:N,reasons:b,warnings:_,...safeS,suggestedStop:T,suggestedTarget:y,riskReward:w,signalId,oiTrend,marketStatus:ms});})()}catch(e){log(`signal-analysis error: ${e.message} | ${e.stack?.split('\n')[1]||''}`,"ERR");try{t.status(500).json({status:!1,message:e.message});}catch(re){}}})

app.get("/gainers",async(e,t)=>{if(!isAuthenticated())return t.status(401).json({status:!1,message:"Not authenticated"});try{const a=await axios.get(`${ANGEL_API}/rest/secure/angelbroking/marketData/v1/gainersAndLosers`,{params:e.query,headers:getHeaders(!0),timeout:15e3});t.json(a.data)}catch(e){const a=e.response?.data?.message||e.message;t.status(500).json({status:!1,message:a})}})

const MCX_SYMBOLS=["GOLD","SILVER","CRUDEOIL","NATURALGAS","COPPER","ALUMINIUM","ZINC","LEAD","NICKEL"];
async function getMCXTokens(){if(!SESSION._instruments||Date.now()-(SESSION._instrFetchTime||0)>144e5)try{log("Downloading instrument master for MCX tokens...","INFO");const e=await axios.get("https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json",{timeout:3e4});SESSION._instruments=e.data,SESSION._instrFetchTime=Date.now()}catch(e){return log("Instrument master download failed: "+e.message,"WARN"),{}}const e=new Date,t={JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};function a(e){if(!e)return null;const a=String(e).trim().toUpperCase(),s=a.match(/^(\d{1,2})([A-Z]{3})(\d{4})$/);if(s){const e=t[s[2]];if(void 0!==e)return new Date(+s[3],e,+s[1])}const n=a.match(/^(\d{4})(\d{2})(\d{2})$/);if(n)return new Date(+n[1],+n[2]-1,+n[3]);const o=a.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(o)return new Date(+o[1],+o[2]-1,+o[3]);const r=new Date(e);return isNaN(r)?null:r}const s={};for(const t of MCX_SYMBOLS){const n=SESSION._instruments.filter(s=>{if("MCX"!==s.exch_seg)return!1;if(!s.name||s.name.toUpperCase()!==t)return!1;if("FUTCOM"!==s.instrumenttype)return!1;const n=a(s.expiry);return n&&n>=e}).sort((e,t)=>a(e.expiry)-a(t.expiry));n.length>0&&(s[t]=n[0].token,log(`MCX ${t}: token ${n[0].token} exp ${n[0].expiry}`,"INFO"))}return s}

app.get("/mcx",async(e,t)=>{if(!isAuthenticated())return t.status(401).json({status:!1,message:"Not authenticated"});try{const e=await getMCXTokens(),a=Object.values(e);if(!a.length)return t.json({status:!1,message:"Could not resolve MCX tokens from instrument master"});const s=(await axios.post(`${ANGEL_API}/rest/secure/angelbroking/market/v1/quote/`,{mode:"FULL",exchangeTokens:{MCX:a}},{headers:getHeaders(!0),timeout:15e3})).data;if(s.status&&s.data?.fetched){const a={};return s.data.fetched.forEach(t=>{const s=Object.keys(e).find(a=>String(e[a])===String(t.symbolToken));if(s){const e=parseFloat(t.ltp||0),n=parseFloat(t.close||0);a[s]={ltp:e,open:parseFloat(t.open||0),high:parseFloat(t.high||0),low:parseFloat(t.low||0),close:n,change:e-n,changePct:n>0?((e-n)/n*100).toFixed(2):"0.00",tradingSymbol:t.tradingSymbol||s}}}),t.json({status:!0,data:a})}t.json({status:!1,message:s.message||"No MCX data returned"})}catch(e){const a=e.response?.data?.message||e.message;t.status(500).json({status:!1,message:a})}})

app.get("/pcr",async(e,t)=>{if(!isAuthenticated())return t.status(401).json({status:!1,message:"Not authenticated"});try{const e=await axios.get(`${ANGEL_API}/rest/secure/angelbroking/market/v1/putCallRatio`,{headers:getHeaders(!0),timeout:15e3});t.json(e.data)}catch(e){const a=e.response?.data?.message||e.message;t.status(500).json({status:!1,message:a})}})

app.post("/option-ltp",async(e,t)=>{if(!isAuthenticated())return t.status(401).json({status:!1,message:"Not authenticated"});const{symbol:a,strike:s,type:n,expiry:o}=e.body;if(!a||!s||!n)return t.status(400).json({status:!1,message:"symbol, strike, type required"});try{if(!SESSION._instruments||Date.now()-(SESSION._instrFetchTime||0)>144e5){log("Downloading NFO instrument master...","INFO");const S=await axios.get("https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json",{timeout:3e4});SESSION._instruments=S.data,SESSION._instrFetchTime=Date.now(),log(`Instrument master loaded — ${SESSION._instruments.length} instruments`,"OK")}const i={JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};function r(e){if(!e)return null;const t=String(e).trim().toUpperCase(),a=t.match(/^(\d{1,2})([A-Z]{3})(\d{4})$/);if(a){const e=i[a[2]];if(void 0!==e)return new Date(+a[3],e,+a[1])}const s=t.match(/^(\d{4})(\d{2})(\d{2})$/);if(s)return new Date(+s[1],+s[2]-1,+s[3]);const n=t.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(n)return new Date(+n[1],+n[2]-1,+n[3]);const o=t.match(/^(\d{2})-(\d{2})-(\d{4})$/);if(o)return new Date(+o[3],+o[2]-1,+o[1]);const r=new Date(e);return isNaN(r)?null:r}const l=a.toUpperCase(),c=n.toUpperCase(),u=parseFloat(s),p=new Date,d=SESSION._instruments.filter(e=>{if("NFO"!==e.exch_seg)return!1;if(!e.instrumenttype?.includes("OPT"))return!1;const t=r(e.expiry);if(!t)return!1;const _tLtp=new Date(t);_tLtp.setHours(15,30,0,0);if(_tLtp<p)return!1;const a=Math.round(parseFloat(e.strike));if(!(a===Math.round(100*u)||a===Math.round(u)))return!1;if(!e.symbol?.toUpperCase().endsWith(c))return!1;if(e.name?.toUpperCase()===l)return!0;const s=e.symbol.toUpperCase();return!!(s.startsWith(l)&&s.length>l.length&&/\d/.test(s[l.length]))});if(!d.length)return t.json({status:!1,message:`No NFO instrument for ${l} ${s} ${c}`});const g=d.map(e=>({...e,_exp:r(e.expiry)})).filter(e=>e._exp).sort((e,t)=>e._exp-t._exp);let m;if("MONTHLY"===o){const E=p.getMonth(),f=p.getFullYear(),I=g.filter(e=>e._exp.getMonth()===E&&e._exp.getFullYear()===f);m=I[I.length-1]||g[g.length-1]}else if("NEXT_MONTH"===o){const nm=(p.getMonth()+1)%12,ny=p.getMonth()===11?p.getFullYear()+1:p.getFullYear(),nf=g.filter(e=>e._exp.getMonth()===nm&&e._exp.getFullYear()===ny);m=nf[nf.length-1]||g[1]||g[0]}else m="NEXT"===o&&g[1]||g[0];if(!m)return t.json({status:!1,message:`No valid expiry for ${l} ${s} ${c}`});log(`Option-LTP token: ${m.symbol} (${m.token})`,"INFO"),await angelRateLimit();const h=(await axios.post(`${ANGEL_API}/rest/secure/angelbroking/market/v1/quote/`,{mode:"LTP",exchangeTokens:{NFO:[String(m.token)]}},{headers:getHeaders(!0),timeout:15e3})).data;if(h.status&&h.data?.fetched?.length){const N=h.data.fetched[0],A=parseFloat(N.ltp||0)>0?parseFloat(N.ltp):parseFloat(N.close||0);return log(`✅ Option LTP: ${m.symbol} = ₹${A}`,"OK"),t.json({status:!0,ltp:A,symbolToken:m.token,tradingSymbol:m.symbol,expiry:m.expiry})}return t.json({status:!1,message:"LTP fetch returned no data"})}catch(k){const C=k.response?.data?.message||k.message;log(`Option LTP error: ${C}`,"WARN"),t.status(500).json({status:!1,message:C})}})

// ═══════════════════════════════════════════════════════
// LIVE TRADE PRICES — batch LTP for all open paper trades
// POST /live-trade-prices
// Body: { trades: [{symbol, strike, type}] }
// Returns: { status:true, prices: {"NBCC_109_CE": 4.25, ...} }
// ═══════════════════════════════════════════════════════
app.post("/live-trade-prices",async(req,res)=>{
  if(!isAuthenticated())return res.status(401).json({status:false,message:"Not authenticated"});
  const{trades}=req.body;
  if(!trades||!trades.length)return res.json({status:true,prices:{}});
  try{
    if(!SESSION._instruments||Date.now()-(SESSION._instrFetchTime||0)>14400000){
      log("Downloading NFO instrument master for live trade prices...","INFO");
      const R=await axios.get("https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json",{timeout:30000});
      SESSION._instruments=R.data;SESSION._instrFetchTime=Date.now();
    }
    const MONTHS={JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
    function parseExp(e){if(!e)return null;const s=String(e).trim().toUpperCase();const m=s.match(/^(\d{1,2})([A-Z]{3})(\d{4})$/);if(m&&MONTHS[m[2]]!==undefined)return new Date(+m[3],MONTHS[m[2]],+m[1]);const d=new Date(e);return isNaN(d)?null:d;}
    const tokenMap={};const tokenToKey={};const now=new Date();
    for(const trade of trades){
      const sym=(trade.symbol||"").toUpperCase();
      const strike=parseFloat(trade.strike);
      const type=(trade.type||"CE").toUpperCase();
      const key=`${sym}_${strike}_${type}`;
      const matches=SESSION._instruments.filter(inst=>{
        if(inst.exch_seg!=="NFO")return false;
        if(!inst.instrumenttype?.includes("OPT"))return false;
        const exp=parseExp(inst.expiry);if(!exp)return false;const _expEnd=new Date(exp);_expEnd.setHours(15,30,0,0);if(_expEnd<now)return false;
        const is=Math.round(parseFloat(inst.strike));
        if(!(is===Math.round(100*strike)||is===Math.round(strike)))return false;
        if(!inst.symbol?.toUpperCase().endsWith(type))return false;
        if(inst.name?.toUpperCase()===sym)return true;
        const s2=inst.symbol.toUpperCase();
        return s2.startsWith(sym)&&s2.length>sym.length&&/\d/.test(s2[sym.length]);
      });
      if(!matches.length){log(`live-trade-prices: no instrument for ${key}`,"WARN");continue;}
      const sorted=matches.map(i=>({...i,_exp:parseExp(i.expiry)})).filter(i=>i._exp).sort((a,b)=>a._exp-b._exp);
      // Match same expiry logic as getExpiryType: if dte<0 use next month, else current month
      const nowIST=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Kolkata'}));
      function lastTueOf2(yr,mn){const last=new Date(yr,mn,0);const diff=last.getDay()>=2?last.getDay()-2:last.getDay()+5;last.setDate(last.getDate()-diff);last.setHours(0,0,0,0);return last;}
      const todayMid2=new Date(nowIST.getFullYear(),nowIST.getMonth(),nowIST.getDate());
      const curLastTue2=lastTueOf2(nowIST.getFullYear(),nowIST.getMonth()+1);
      const dte2=Math.round((curLastTue2-todayMid2)/86400000);
      let best;
      // Indices use current month till expiry day; stocks switch 5 days before
      // NIFTY: always nearest contract (weekly) — sorted[0]
      // BANKNIFTY/FINNIFTY/MIDCPNIFTY: current month till expiry passed (dte<0)
      // STOCKS: next month 5 days before expiry (dte<=5)
      const _NIFTY_IDXLIST=["BANKNIFTY","FINNIFTY","MIDCPNIFTY"];
      if(sym==="NIFTY"){
        best=sorted[0]; // always nearest weekly contract
      } else if(_NIFTY_IDXLIST.includes(sym)){
        if(dte2<0){
          const nm=(nowIST.getMonth()+1)%12;const ny=nowIST.getMonth()===11?nowIST.getFullYear()+1:nowIST.getFullYear();
          const nextMonthOpts=sorted.filter(i=>i._exp.getMonth()===nm&&i._exp.getFullYear()===ny);
          best=nextMonthOpts[nextMonthOpts.length-1]||sorted[0];
        } else {
          const cm=nowIST.getMonth();const cy=nowIST.getFullYear();
          const curMonthOpts=sorted.filter(i=>i._exp.getMonth()===cm&&i._exp.getFullYear()===cy);
          best=curMonthOpts[curMonthOpts.length-1]||sorted[0];
        }
      } else {
        // STOCKS — next month 5 days before
        if(dte2<=5){
          const nm=(nowIST.getMonth()+1)%12;const ny=nowIST.getMonth()===11?nowIST.getFullYear()+1:nowIST.getFullYear();
          const nextMonthOpts=sorted.filter(i=>i._exp.getMonth()===nm&&i._exp.getFullYear()===ny);
          best=nextMonthOpts[nextMonthOpts.length-1]||sorted[sorted.length-1]||sorted[0];
        } else {
          const cm=nowIST.getMonth();const cy=nowIST.getFullYear();
          const curMonthOpts=sorted.filter(i=>i._exp.getMonth()===cm&&i._exp.getFullYear()===cy);
          best=curMonthOpts[curMonthOpts.length-1]||sorted[0];
        }
      }
      tokenMap[key]=String(best.token);
      tokenToKey[String(best.token)]=key;
    }
    const tokens=Object.values(tokenMap);
    if(!tokens.length)return res.json({status:true,prices:{}});
    const prices={};const BATCH=50;
    for(let i=0;i<tokens.length;i+=BATCH){
      const batch=tokens.slice(i,i+BATCH);
      try{
        await angelRateLimit();
        const r=await axios.post(`${ANGEL_API}/rest/secure/angelbroking/market/v1/quote/`,{mode:"LTP",exchangeTokens:{NFO:batch}},{headers:getHeaders(true),timeout:15000});
        if(r.data.status&&r.data.data?.fetched){
          r.data.data.fetched.forEach(f=>{
            const key=tokenToKey[String(f.symbolToken)];
            if(key){const ltp=parseFloat(f.ltp||0)>0?parseFloat(f.ltp):parseFloat(f.close||0);prices[key]=ltp;}
          });
        }
      }catch(bErr){log(`live-trade-prices batch error: ${bErr.message}`,"WARN");}
    }
    log(`live-trade-prices: fetched ${Object.keys(prices).length}/${trades.length}`,"OK");
    res.json({status:true,prices});
  }catch(err){log(`live-trade-prices error: ${err.message}`,"ERR");res.status(500).json({status:false,message:err.message});}
});

app.post("/option-chain",async(e,t)=>{if(!isAuthenticated())return t.status(401).json({status:!1,message:"Not authenticated"});const{symbol:a,spotPrice:s,expiry:n,depth:o=5}=e.body;if(!a||!s)return t.status(400).json({status:!1,message:"symbol and spotPrice required"});try{if(!SESSION._instruments||Date.now()-(SESSION._instrFetchTime||0)>144e5){log("Downloading NFO instrument master...","INFO");const w=await axios.get("https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json",{timeout:3e4});SESSION._instruments=w.data,SESSION._instrFetchTime=Date.now(),log(`Instrument master loaded — ${SESSION._instruments.length} instruments`,"OK")}const i=a.toUpperCase(),l=parseFloat(s),c=new Date,u={JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};function r(e){if(!e)return null;const t=String(e).trim().toUpperCase(),a=t.match(/^(\d{1,2})([A-Z]{3})(\d{4})$/);if(a){const e=u[a[2]];if(void 0!==e)return new Date(+a[3],e,+a[1])}const s=t.match(/^(\d{4})(\d{2})(\d{2})$/);if(s)return new Date(+s[1],+s[2]-1,+s[3]);const n=t.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(n)return new Date(+n[1],+n[2]-1,+n[3]);const o=t.match(/^(\d{2})-(\d{2})-(\d{4})$/);if(o)return new Date(+o[3],+o[2]-1,+o[1]);const r=new Date(e);return isNaN(r)?null:r}const p=SESSION._instruments.filter(e=>{if("NFO"!==e.exch_seg)return!1;if(!e.instrumenttype||!e.instrumenttype.includes("OPT"))return!1;const t=r(e.expiry);if(!t||t<c)return!1;if(e.name&&e.name.toUpperCase()===i)return!0;if(e.symbol){const t=e.symbol.toUpperCase();if(t.startsWith(i)&&t.length>i.length&&/\d/.test(t[i.length]))return!0}return!1});if(0===p.length)return log(`No NFO options found for ${i} (checked ${SESSION._instruments?.length} instruments)`,"WARN"),t.json({status:!1,message:`No NFO options found for ${i}`});log(`Option chain ${i}: ${p.length} options matched`,"INFO");const d=[...new Set(p.map(e=>e.expiry))].map(e=>({raw:e,date:r(e)})).filter(e=>e.date&&e.date>=c).sort((e,t)=>e.date-t.date);if(!d.length)return t.json({status:!1,message:`No valid future expiries for ${i}`});let g;if("MONTHLY"===n){const b=c.getMonth(),_=c.getFullYear(),F=d.filter(e=>e.date.getMonth()===b&&e.date.getFullYear()===_);g=F.length?F[F.length-1]:d[0]}else if("NEXT_MONTH"===n){const R=(c.getMonth()+1)%12,x=11===c.getMonth()?c.getFullYear()+1:c.getFullYear(),P=d.filter(e=>e.date.getMonth()===R&&e.date.getFullYear()===x);g=P.length?P[P.length-1]:d[1]||d[0]}else g="NEXT"===n&&d[1]||d[0];const m=g.raw,h=p.filter(e=>e.expiry===m),S=[...new Set(h.map(e=>Math.round(parseFloat(e.strike)/100)))].filter(e=>e>0).sort((e,t)=>e-t);if(0===S.length)return t.json({status:!1,message:`No strikes found for ${i} expiry ${m}`});const E=S.reduce((e,t)=>Math.abs(t-l)<Math.abs(e-l)?t:e,S[0]),f=S.indexOf(E),I=Math.max(0,f-o),N=Math.min(S.length-1,f+o),A=S.slice(I,N+1),k=[],C={};for(const L of A){const D=Math.round(100*L),$=h.filter(e=>Math.round(parseFloat(e.strike))===D&&e.symbol?.toUpperCase().endsWith("CE")),M=h.filter(e=>Math.round(parseFloat(e.strike))===D&&e.symbol?.toUpperCase().endsWith("PE")),U=$[0],v=M[0];C[L]={CE_token:U?.token??null,PE_token:v?.token??null,CE_sym:U?.symbol??null,PE_sym:v?.symbol??null},U?.token&&k.push(String(U.token)),v?.token&&k.push(String(v.token))}if(log(`Option chain ${i}: expiry=${m}, ATM=${E}, strikes=${A.length}, tokens=${k.length}`,"INFO"),0===k.length)return t.json({status:!1,message:`No tokens found for ${i} — check instrument name matching`});const O={},T=50;for(let B=0;B<k.length;B+=T){const j=k.slice(B,B+T);try{const H=await axios.post(`${ANGEL_API}/rest/secure/angelbroking/market/v1/quote/`,{mode:"LTP",exchangeTokens:{NFO:j}},{headers:getHeaders(!0),timeout:2e4});H.data.status&&H.data.data?.fetched&&H.data.data.fetched.forEach(e=>{const t=parseFloat(e.ltp||0);parseFloat(e.close||0);if(t>0)O[String(e.symbolToken)]=t;else{const t=parseFloat(e.close||0);t>0&&(O[String(e.symbolToken)]=t)}})}catch(V){log(`LTP batch failed: ${V.message}`,"WARN")}}const y=A.map(e=>{const t=C[e];return{strike:e,isATM:e===E,CE_ltp:t.CE_token?O[String(t.CE_token)]??null:null,PE_ltp:t.PE_token?O[String(t.PE_token)]??null:null,CE_token:t.CE_token,PE_token:t.PE_token,CE_sym:t.CE_sym,PE_sym:t.PE_sym}});return log(`✅ ${i}: ATM=${E}, ltps=${Object.keys(O).length}/${k.length} fetched`,"OK"),t.json({status:!0,symbol:i,spotPrice:l,atmStrike:E,expiry:m,strikes:y})}catch(W){const G=W.response?.data?.message||W.message;log(`Option chain error ${a}: ${G}`,"WARN"),t.status(500).json({status:!1,message:G})}})

app.post("/refresh",async(e,t)=>{if(!SESSION.refreshToken)return t.json({status:!1,message:"No refresh token available"});try{const e=await axios.post(`${ANGEL_API}/rest/secure/angelbroking/jwt/v1/generateTokens`,{refreshToken:SESSION.refreshToken},{headers:getHeaders(!0),timeout:15e3});if(!0===e.data.status&&e.data.data)return SESSION.jwtToken=e.data.data.jwtToken,SESSION.refreshToken=e.data.data.refreshToken,SESSION.expiresAt=Date.now()+288e5,log("Token refreshed","OK"),t.json({status:!0,message:"Token refreshed"});t.json({status:!1,message:"Token refresh failed"})}catch(e){const a=e.response?.data?.message||e.message;t.status(500).json({status:!1,message:a})}})

// Auto-reset NSE cookie every 90 minutes so FII/DII + VIX never go stale
setInterval(()=>{
  NSE_COOKIE="";
  log("NSE session cookie reset — will refresh on next FII/DII or VIX fetch","INFO");
},54e5); // 90 minutes

setInterval(async()=>{if(!SESSION.refreshToken||!SESSION.jwtToken)return;const e=(SESSION.expiresAt-Date.now())/36e5;if(e>0&&e<1){log("Auto-refreshing JWT token...","INFO");try{const e=await axios.post(`${ANGEL_API}/rest/secure/angelbroking/jwt/v1/generateTokens`,{refreshToken:SESSION.refreshToken},{headers:getHeaders(!0),timeout:15e3});!0===e.data.status&&e.data.data&&(SESSION.jwtToken=e.data.data.jwtToken,SESSION.refreshToken=e.data.data.refreshToken,SESSION.expiresAt=Date.now()+288e5,log("Token auto-refreshed ✅","OK"))}catch(e){log(`Auto-refresh failed: ${e.message}`,"ERR")}}},18e5)

let NEWS_CACHE={data:null,fetchTime:0};
app.get("/news-sentiment",async(e,t)=>{if(NEWS_CACHE.data&&Date.now()-NEWS_CACHE.fetchTime<3e5)return t.json(NEWS_CACHE.data);try{const e=["https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms","https://www.moneycontrol.com/rss/marketsindia.xml","https://feeds.feedburner.com/ndtvprofit-latest"],a=await Promise.allSettled(e.map(e=>axios.get(e,{timeout:5e3,responseType:"text"}))),s=[];a.forEach(e=>{if("fulfilled"===e.status){(e.value.data.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/g)||[]).slice(1,15).forEach(e=>{const t=e.replace(/<[^>]+>/g,"").replace(/<!\[CDATA\[|\]\]>/g,"").trim();t.length>10&&s.push(t)})}});const n=["surge","rally","gain","rise","record","high","strong","growth","profit","beat","positive","boost","upgrade","buy","bull","recovery","jump","soar","outperform","breakout","upside","optimism","inflow","fii buying","dii buying","rate cut","gdp growth","export rise","earnings beat","dividend","buyback","expansion","order win"],o=["fall","drop","crash","decline","loss","weak","sell","bear","down","cut","risk","war","tension","crisis","inflation","recession","sanction","tariff","geopolit","slump","outflow","fii selling","rate hike","default","bankruptcy","miss","downgrade","concern","slowdown","contraction","profit warning","layoff","strike","ban"],r=["war","conflict","sanction","tariff","geopolit","tension","attack","israel","iran","ukraine","russia","china","taiwan","missile","oil price","crude","middle east","pakistan","border","ceasefire","nato","nuclear","terror","airstrike","trade war","us tariff","trump tariff","embargo","blockade","escalation"];let i=0,l=0,c=0;s.forEach(e=>{const t=e.toLowerCase();n.forEach(e=>{t.includes(e)&&i++}),o.forEach(e=>{t.includes(e)&&l++}),r.forEach(e=>{t.includes(e)&&c++})});const u=i+l||1,p=i>l?"BULLISH":l>i?"BEARISH":"NEUTRAL",d=Math.round(i/u*100),g={status:!0,sentiment:p,sentimentScore:d,geoRisk:c,bullScore:i,bearScore:l,headlineCount:s.length,topHeadlines:s.slice(0,5),fetchTime:(new Date).toLocaleTimeString("en-IN")};NEWS_CACHE={data:g,fetchTime:Date.now()},log(`News: ${p} (${d}%) · GeoRisk: ${c}`,"INFO"),t.json(g)}catch(e){t.json({status:!1,message:e.message,sentiment:"NEUTRAL",sentimentScore:50,geoRisk:0})}})

app.post("/resolve-tokens",async(e,t)=>{try{if(!SESSION._instruments||Date.now()-(SESSION._instrFetchTime||0)>144e5){const e=await axios.get("https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json",{timeout:3e4});SESSION._instruments=e.data,SESSION._instrFetchTime=Date.now()}const a=(e.body.symbols||[]).map(e=>e.toUpperCase()),s={};for(const e of a){const t=SESSION._instruments.find(t=>"NSE"===t.exch_seg&&(t.symbol===e+"-EQ"||t.symbol===e||t.name===e)&&t.token);t&&(s[e]=String(t.token))}log("Token resolution: "+Object.keys(s).length+" resolved","INFO"),t.json({status:!0,tokens:s})}catch(e){t.status(500).json({status:!1,message:e.message})}})

app.get("/token-list",async(e,t)=>{try{if(!SESSION._instruments||Date.now()-(SESSION._instrFetchTime||0)>144e5){log("Downloading scrip master for token list...","INFO");const e=await axios.get("https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json",{timeout:3e4});SESSION._instruments=e.data,SESSION._instrFetchTime=Date.now()}const e={};SESSION._instruments.forEach(t=>{if("NSE"!==t.exch_seg)return;const a=(t.symbol||"").replace("-EQ","").toUpperCase();e[a]||(e[a]=String(t.token))}),log("Token list served: "+Object.keys(e).length+" NSE symbols","INFO"),t.json({status:!0,tokens:e,count:Object.keys(e).length})}catch(e){log("token-list error: "+e.message,"WARN"),t.status(500).json({status:!1,message:e.message})}})

loadSignalLogFromDisk();
app.listen(PORT,()=>{
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║   NSE F&O Signal Engine — DILIP FXO v5.1                     ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║   Server  : http://localhost:${PORT}                                  ║`);
  console.log("║   v3.1: /market-status /oi-history /signal-log               ║");
  console.log("║   v3.2: OI momentum in scoring · expiryRisk weight           ║");
  console.log("║   v3.4: VIX→GammaBlast, NSE cookie refresh, log persist      ║");
  console.log("║   v5.0: Volume scoring · notifications · zero-premium skip   ║");
  console.log("║   v5.1: PCR delta scoring · OI velocity bonus · banner sync  ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  log("Listening for connections...","OK");
});
