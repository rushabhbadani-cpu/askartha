// api/market.js — AskArtha Market API
// Data: NSE + BSE only. No Yahoo Finance.
// Price history: GitHub CDN files (data/prices/{SYM}.json)
// Fundamentals:  GitHub CDN files (data/fund/{SYM}.json)
// Index charts:  GitHub CDN files (data/indices/{INDEX}.json)
// Live quotes:   NSE API (with Redis cache)

import url from 'url';

// ── CONFIG ────────────────────────────────────────────────────────────
const GITHUB_CDN = 'https://raw.githubusercontent.com/rushabhbadani-cpu/askartha/main';
const REDIS_URL   = process.env.UPSTASH_REDIS_KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.nseindia.com/', 'Connection': 'keep-alive',
};
const BSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Referer': 'https://www.bseindia.com/', 'Origin': 'https://www.bseindia.com',
};

const RANGE_DAYS = {'5d':7,'1wk':8,'1mo':35,'3mo':95,'6mo':190,'1y':365,'2y':730,'5y':1825,'10y':3650,'all':99999};

// ── REDIS ─────────────────────────────────────────────────────────────
async function redisCmd(...args) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const u = `${REDIS_URL}/${args.map(a => encodeURIComponent(String(a))).join('/')}`;
    const r = await fetch(u, { headers:{Authorization:`Bearer ${REDIS_TOKEN}`}, signal:AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const j = await r.json();
    return j.result;
  } catch { return null; }
}
const redis = {
  get: async (k) => { const v = await redisCmd('GET', k); return v == null ? null : (typeof v==='string' ? JSON.parse(v) : v); },
  set: (k, v, ttl) => ttl ? redisCmd('SET', k, JSON.stringify(v), 'EX', ttl) : redisCmd('SET', k, JSON.stringify(v)),
};

// ── NSE COOKIE ────────────────────────────────────────────────────────
let _nseCookie = '', _nseCookieTs = 0;
async function getNseCookie() {
  if (_nseCookie && Date.now() - _nseCookieTs < 5*60*1000) return _nseCookie;
  try {
    const r = await fetch('https://www.nseindia.com', { headers:NSE_HEADERS, signal:AbortSignal.timeout(8000) });
    const raw = r.headers.get('set-cookie') || '';
    _nseCookie = raw.split(',').map(c=>c.trim().split(';')[0])
      .filter(c=>c.startsWith('nsit=')||c.startsWith('nseappid=')).join('; ');
    _nseCookieTs = Date.now();
  } catch {}
  return _nseCookie;
}

async function nseGet(path, cacheTtl=0) {
  const cookie = await getNseCookie();
  const headers = { ...NSE_HEADERS, ...(cookie?{Cookie:cookie}:{}) };
  const r = await fetch('https://www.nseindia.com' + path, { headers, signal:AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('NSE '+r.status);
  return r.json();
}

async function bseGet(path) {
  const r = await fetch('https://api.bseindia.com' + path, { headers:BSE_HEADERS, signal:AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('BSE '+r.status);
  return r.json();
}

// ── HELPERS ───────────────────────────────────────────────────────────
const toNse = s => s ? String(s).trim().toUpperCase().replace(/^BSE:/i,'') : '';

function isMarketOpen() {
  const ist = new Date(Date.now() + 5.5*60*60*1000);
  const day = ist.getUTCDay();
  if (day===0||day===6) return false;
  const hhmm = ist.getUTCHours()*100 + ist.getUTCMinutes();
  return hhmm>=915 && hhmm<=1530;
}

// ── GITHUB CDN FETCH ──────────────────────────────────────────────────
async function cdnGet(path) {
  const r = await fetch(`${GITHUB_CDN}${path}`, { signal:AbortSignal.timeout(10000) });
  if (!r.ok) return null;
  return r.json();
}

// ── LIVE QUOTE — NSE ──────────────────────────────────────────────────
async function nseQuote(symbol) {
  const sym = toNse(symbol);
  const data = await nseGet(`/api/quote-equity?symbol=${encodeURIComponent(sym)}`);
  if (!data?.priceInfo) return null;
  const pi=data.priceInfo, meta=data.metadata||{}, fi=data.fundamentals||{}, td=data.tradeInfo||{};
  return {
    symbol:sym, longName:meta.companyName||sym, price:pi.lastPrice||0,
    open:pi.open||0, high:pi.intraDayHighLow?.max||pi.high||0,
    low:pi.intraDayHighLow?.min||pi.low||0, prevClose:pi.previousClose||0,
    change:pi.change||0, changePct:pi.pChange||0,
    volume:td.totalTradedVolume||0, vwap:pi.vwap||0,
    w52High:pi.weekHighLow?.max||0, w52Low:pi.weekHighLow?.min||0,
    pe:parseFloat(fi.pe||0), eps:parseFloat(fi.eps||0),
    pb:parseFloat(fi.pb||0), marketCap:parseFloat(fi.marketCapFull||0),
    isin:meta.isin||'', industry:meta.industry||'',
    source:'NSE Live',
  };
}

// ── SMART QUOTE — Redis closing price → NSE live ───────────────────────
async function smartQuote(symbol) {
  const sym = toNse(symbol);

  // Market open → NSE live
  if (isMarketOpen()) {
    const live = await nseQuote(sym).catch(()=>null);
    if (live?.price>0) { await redis.set(`quote:${sym}`,live,900); return live; }
  }

  // Redis cache (15 min TTL for live, 24h for closing)
  const cached = await redis.get(`quote:${sym}`).catch(()=>null);
  if (cached?.price>0) return {...cached, fromCache:true};

  // GitHub CDN closing price
  try {
    const data = await cdnGet(`/data/prices/${encodeURIComponent(sym)}.json`);
    if (data?.candles?.length) {
      const latest = data.candles[data.candles.length-1];
      const prev   = data.candles.length>1 ? data.candles[data.candles.length-2] : latest;
      const last365 = data.candles.slice(-365);
      const result = {
        symbol:sym, longName:sym, price:latest.close,
        open:latest.open||latest.close, high:latest.high||latest.close,
        low:latest.low||latest.close, prevClose:prev.close,
        change:latest.close-prev.close,
        changePct:prev.close>0?((latest.close-prev.close)/prev.close*100):0,
        volume:latest.volume||0,
        w52High:Math.max(...last365.map(d=>d.high||d.close)),
        w52Low: Math.min(...last365.map(d=>d.low ||d.close)),
        date:latest.date, source:'NSE Bhavcopy', isClosingPrice:true,
      };
      await redis.set(`quote:${sym}`,result,86400);
      return result;
    }
  } catch {}

  // Last resort: NSE live regardless of market hours
  const live = await nseQuote(sym).catch(()=>null);
  if (live?.price>0) { await redis.set(`quote:${sym}`,live,3600); return live; }

  return null;
}

// ── HISTORY ───────────────────────────────────────────────────────────
const NSE_INDEX_MAP = {
  'NIFTY 50':'NIFTY50','NIFTY50':'NIFTY50','NIFTYBANK':'NIFTYBANK',
  'NIFTY BANK':'NIFTYBANK','NIFTY IT':'NIFTYIT','SENSEX':'SENSEX',
  'INDIA VIX':'INDIAVIX','NIFTY MIDCAP 100':'NIFTYMIDCAP100',
  'NIFTY NEXT 50':'NIFTYNEXT50','NIFTY 500':'NIFTY500',
};

async function getHistory(symbol, range) {
  const sym   = toNse(symbol);
  const days  = RANGE_DAYS[range] || 365;
  const cutoff= new Date(); cutoff.setDate(cutoff.getDate()-days);
  const cutStr= range==='all'?'1994-01-01':cutoff.toISOString().split('T')[0];
  const fmt   = d=>`${String(d.getDate()).padStart(2,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${d.getFullYear()}`;

  // ── INDEX HISTORY — from GitHub CDN files ────────────────────────
  const idxKey = NSE_INDEX_MAP[sym] || NSE_INDEX_MAP[symbol.replace(/%20/g,' ').toUpperCase()];
  if (idxKey) {
    // Try GitHub CDN first (NIFTY50.json, NIFTYBANK.json etc.)
    try {
      const data = await cdnGet(`/data/indices/${idxKey}.json`);
      if (data?.candles?.length > 2) {
        const filtered = data.candles.filter(d=>d.date>=cutStr);
        if (filtered.length>2) return { prices:filtered, source:'NSE Index Data', totalCandles:filtered.length };
      }
    } catch {}

    // Fallback: NSE historical index API
    try {
      const today=new Date(), from=new Date();
      from.setDate(from.getDate()-Math.min(days,1825));
      const indexName = sym.includes('BANK')?'NIFTY BANK':sym.includes('IT')?'NIFTY IT':sym.replace(/\d+/g,'').trim()||'NIFTY 50';
      const data = await nseGet(`/api/historical/indicesHistory?indexType=${encodeURIComponent(indexName)}&from=${encodeURIComponent(fmt(from))}&to=${encodeURIComponent(fmt(today))}`);
      const rows = data?.data?.indexCloseOnlineRecords || data?.data || [];
      if (Array.isArray(rows)&&rows.length>2) {
        const prices = rows.map(d=>({
          date:(d.EOD_TIMESTAMP||d.HistoricalDate||'').split('T')[0].split(' ')[0],
          open:parseFloat(d.EOD_OPEN_INDEX_VAL||d.OPEN||0),
          high:parseFloat(d.EOD_HIGH_INDEX_VAL||d.HIGH||0),
          low: parseFloat(d.EOD_LOW_INDEX_VAL ||d.LOW ||0),
          close:parseFloat(d.EOD_CLOSE_INDEX_VAL||d.CLOSE||0),
          volume:0,
        })).filter(d=>d.date&&d.close>0).sort((a,b)=>a.date.localeCompare(b.date));
        if (prices.length>2) return {prices, source:'NSE Index History', totalCandles:prices.length};
      }
    } catch {}
    return null;
  }

  // ── STOCK HISTORY — GitHub CDN → Redis → NSE API ─────────────────
  try {
    const data = await cdnGet(`/data/prices/${encodeURIComponent(sym)}.json`);
    if (data?.candles?.length>2) {
      const filtered = data.candles.filter(d=>d.date>=cutStr);
      if (filtered.length>2) {
        let final = filtered;
        if (filtered.length>1000) { const step=Math.ceil(filtered.length/800); final=filtered.filter((_,i)=>i%step===0||i===filtered.length-1); }
        return {prices:final, source:'NSE Bhavcopy', totalCandles:filtered.length, from:filtered[0]?.date, to:filtered[filtered.length-1]?.date};
      }
    }
  } catch {}

  // Redis fallback
  try {
    const stored = await redis.get(`price:${sym}`);
    if (Array.isArray(stored)&&stored.length>2) {
      const filtered = stored.filter(d=>d.date>=cutStr);
      if (filtered.length>2) return {prices:filtered, source:'NSE Bhavcopy (Redis)', totalCandles:filtered.length};
    }
  } catch {}

  // NSE API fallback
  try {
    const today=new Date(), from=new Date();
    from.setDate(from.getDate()-Math.min(days,3650));
    const d = await nseGet(`/api/historical/cm/equity?symbol=${encodeURIComponent(sym)}&series=["EQ"]&from=${encodeURIComponent(fmt(from))}&to=${encodeURIComponent(fmt(today))}&csv=false`);
    if (d?.data?.length>0) {
      const prices = d.data.map(r=>({
        date:(r.CH_TIMESTAMP||'').split('T')[0],
        open:parseFloat(r.CH_OPENING_PRICE||0), high:parseFloat(r.CH_TRADE_HIGH_PRICE||0),
        low:parseFloat(r.CH_TRADE_LOW_PRICE||0), close:parseFloat(r.CH_CLOSING_PRICE||0),
        volume:parseInt(r.CH_TOT_TRADED_QTY||0),
      })).filter(d=>d.date&&d.close>0).sort((a,b)=>a.date.localeCompare(b.date));
      if (prices.length>2) return {prices, source:'NSE API', totalCandles:prices.length};
    }
  } catch {}

  return null;
}

// ── FUNDAMENTALS — GitHub CDN files → NSE live fallback ───────────────
async function getFundamentals(symbol) {
  const sym = toNse(symbol);

  // 1. GitHub CDN (populated by fundamentals workflow)
  try {
    const data = await cdnGet(`/data/fund/${encodeURIComponent(sym)}.json`);
    if (data && (data.income?.length>0 || data.shareholding || data.pe>0)) {
      return {...data, fromCache:true, source:'NSE Official XBRL'};
    }
  } catch {}

  // 2. NSE live API (always works during market hours, limited on weekends)
  try {
    const [quoteR, shR, actR] = await Promise.allSettled([
      nseGet(`/api/quote-equity?symbol=${encodeURIComponent(sym)}`),
      nseGet(`/api/corporate-shareHolding-ultimate?symbol=${encodeURIComponent(sym)}&shareHolderType=1`),
      nseGet(`/api/corporates-corporateActions?index=equities&symbol=${encodeURIComponent(sym)}`),
    ]);

    const q   = quoteR.status==='fulfilled' ? quoteR.value : null;
    const shD = shR.status  ==='fulfilled' ? shR.value   : null;
    const actD= actR.status ==='fulfilled' ? actR.value  : null;

    const fi = q?.fundamentals||{}, pi=q?.priceInfo||{}, meta=q?.metadata||{};

    let shareholding = null;
    if (shD) {
      const latest = Array.isArray(shD)?shD[0]:shD;
      if (latest?.promoterAndPromoterGroupShareHolding) {
        shareholding = {
          promoter: parseFloat(latest.promoterAndPromoterGroupShareHolding||0),
          fii:      parseFloat(latest.foreignInstitutionalInvestors||0),
          dii:      parseFloat(latest.domesticInstitutionalInvestors||0),
          public:   parseFloat(latest.publicShareholding||0),
          pledged:  parseFloat(latest.pledgedShares||0),
          quarter:  latest.quarter||'',
        };
      }
    }

    const actions = Array.isArray(actD) ? actD.slice(0,10).map(a=>({
      type:a.purpose||'', exDate:a.exDate||'', value:a.dividendPerShare||a.faceValueNew||'',
    })).filter(a=>a.exDate&&a.type) : [];

    // Try BSE for extra ratios
    let bseCode=null, bseF=null;
    const isin = meta.isin||'';
    if (isin) {
      try {
        const isinMap = await redis.get('bse:isinmap').catch(()=>null);
        if (isinMap?.[isin]) bseCode = isinMap[isin];
      } catch {}
    }
    if (bseCode) {
      try { bseF = await bseGet(`/BseIndiaAPI/api/Fundamentals/w?scripcd=${bseCode}`); } catch {}
    }

    return {
      symbol:sym, fromCache:false,
      pe:    parseFloat(bseF?.PE  ||fi.pe  ||0),
      pb:    parseFloat(bseF?.PBV ||fi.pb  ||0),
      eps:   parseFloat(bseF?.EPS ||fi.eps ||0),
      roe:   parseFloat(bseF?.ROE ||0),
      profitMargin:  parseFloat(bseF?.NetProfitMargin ||0),
      debtToEquity:  parseFloat(bseF?.DebtEquityRatio ||0),
      currentRatio:  parseFloat(bseF?.CurrentRatio    ||0),
      dividendYield: parseFloat(bseF?.Div_yield       ||0),
      marketCap:     parseFloat(bseF?.Mktcap||fi.marketCapFull||0),
      w52High:parseFloat(pi.weekHighLow?.max||0),
      w52Low: parseFloat(pi.weekHighLow?.min||0),
      industry: meta.industry||'', longName:meta.companyName||sym, isin,
      income:[], shareholding, actions,
      source: bseF?'BSE+NSE Official':'NSE Official',
    };
  } catch {}

  return { symbol:sym, pe:0, pb:0, eps:0, income:[], shareholding:null, actions:[] };
}

// ── SEARCH ────────────────────────────────────────────────────────────
async function searchSymbols(query) {
  const q = query.toUpperCase().trim();
  let master = await redis.get('nse:symbolmaster').catch(()=>null);
  if (!Array.isArray(master)||master.length<100) {
    try {
      const r = await fetch('https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv',{headers:NSE_HEADERS,signal:AbortSignal.timeout(15000)});
      const text = await r.text();
      master = text.trim().split('\n').slice(1).map(line=>{
        const c=line.split(',');
        return{symbol:(c[0]||'').trim().replace(/"/g,''),name:(c[1]||'').trim().replace(/"/g,''),series:(c[2]||'').trim().replace(/"/g,''),isin:(c[8]||'').trim().replace(/"/g,'')};
      }).filter(s=>s.symbol&&s.series==='EQ');
      await redis.set('nse:symbolmaster',master,86400);
    } catch { master=[]; }
  }
  return master.filter(s=>s.symbol.startsWith(q)||s.name.toUpperCase().includes(q))
    .slice(0,15).map(s=>({symbol:s.symbol,name:s.name,exchange:'NSE',isin:s.isin}));
}

// ── PEERS ─────────────────────────────────────────────────────────────
async function getPeers(symbol, industry) {
  const sym = toNse(symbol);
  let ind = decodeURIComponent(industry||'');
  if (!ind) { const q=await nseQuote(sym).catch(()=>null); ind=q?.industry||''; }
  if (!ind) return [];
  try {
    const data = await nseGet(`/api/live-analysis-by-industry?industry=${encodeURIComponent(ind)}&limitedData=true`,300000);
    if (data?.data?.length) return data.data.filter(d=>d.symbol&&d.symbol!==sym).slice(0,5).map(d=>d.symbol);
  } catch {}
  return [];
}

// ── MARKET SCAN ───────────────────────────────────────────────────────
async function getMarketScan() {
  try {
    const [n50,nb] = await Promise.allSettled([
      nseGet('/api/equity-stockIndices?index=NIFTY%2050'),
      nseGet('/api/equity-stockIndices?index=NIFTY%20BANK'),
    ]);
    const quotes = {};
    const process = (data) => {
      if (!data?.data) return;
      data.data.forEach(d=>{
        if(!d.symbol) return;
        quotes[d.symbol]={
          price:d.lastPrice||0, changePct:d.pChange||0, change:d.change||0,
          volume:d.totalTradedVolume||0, pe:d.pe||0,
          w52High:d.yearHigh||0, w52Low:d.yearLow||0,
          longName:d.meta?.companyName||d.symbol, source:'NSE',
        };
      });
    };
    if (n50.status==='fulfilled') process(n50.value);
    if (nb.status==='fulfilled') process(nb.value);
    return {quotes, source:'NSE', timestamp:new Date().toISOString()};
  } catch(e) { return {quotes:{},error:e.message}; }
}

// ── FII/DII ───────────────────────────────────────────────────────────
async function getFiiDii() {
  try {
    const data = await nseGet('/api/fiidiiTradeReact');
    if (Array.isArray(data)) {
      return data.slice(0,10).map(d=>({
        date:d.date||'', category:d.category||'',
        buyValue:parseFloat(d.buyValue||0), sellValue:parseFloat(d.sellValue||0),
        netValue:parseFloat(d.netValue||0),
      }));
    }
  } catch {}
  return [];
}

// ── BSE CODE LOOKUP ───────────────────────────────────────────────────
async function getBseCode(symbol) {
  const sym = toNse(symbol);
  try {
    const data = await bseGet(`/BseIndiaAPI/api/InstSearch/w?strSearch=${encodeURIComponent(sym)}`);
    if (Array.isArray(data)&&data.length) {
      const match = data.find(d=>d.short_name?.toUpperCase()===sym)||data[0];
      return parseInt(match?.scrip_cd||0)||null;
    }
  } catch {}
  return null;
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');

  const { query } = url.parse(req.url, true);
  const { action, symbol='', range='1y', industry='' } = query;

  try {
    if (action==='quote') {
      if (!symbol) return res.status(400).json({error:'symbol required'});
      const q = await smartQuote(symbol);
      if (!q) return res.status(404).json({error:'Symbol not found on NSE or BSE', symbol});
      return res.json(q);
    }

    if (action==='history') {
      if (!symbol) return res.status(400).json({error:'symbol required'});
      const h = await getHistory(symbol, range);
      if (!h) return res.status(404).json({error:'No history found', symbol, range});
      return res.json(h);
    }

    if (action==='fundamentals') {
      if (!symbol) return res.status(400).json({error:'symbol required'});
      return res.json(await getFundamentals(symbol));
    }

    if (action==='search') {
      if (!query.query) return res.status(400).json({error:'query required'});
      return res.json({results: await searchSymbols(query.query)});
    }

    if (action==='peers') {
      if (!symbol) return res.status(400).json({error:'symbol required'});
      const peers = await getPeers(symbol, industry);
      return res.json({peers, symbol});
    }

    if (action==='marketscan') {
      return res.json(await getMarketScan());
    }

    if (action==='fiidii') {
      return res.json({data: await getFiiDii(), source:'NSE'});
    }

    if (action==='indices') {
      try {
        const d = await nseGet('/api/allIndices');
        const want = new Set(['NIFTY 50','NIFTY BANK','NIFTY IT','INDIA VIX','NIFTY NEXT 50','NIFTY MIDCAP 100','NIFTY SMALLCAP 100','NIFTY 500']);
        const filtered = (d?.data||[]).filter(i=>want.has(i.indexSymbol));
        return res.json({indices:filtered, source:'NSE'});
      } catch(e) { return res.json({indices:[], error:e.message}); }
    }

    if (action==='mf-search') {
      const q2 = (query.query||'').toUpperCase().trim();
      try {
        const r = await fetch('https://api.mfapi.in/mf', {signal:AbortSignal.timeout(10000)});
        if (r.ok) {
          const all = await r.json();
          const funds = all.filter(f=>f.schemeName?.toUpperCase().includes(q2)).slice(0,20).map(f=>({code:f.schemeCode,name:f.schemeName}));
          return res.json({funds, source:'AMFI India'});
        }
      } catch {}
      return res.json({funds:[]});
    }

    if (action==='status') {
      const [bLast, fLast, pData, fData] = await Promise.allSettled([
        redis.get('bhavcopy:last'),
        redis.get('fund:last'),
        redis.get('price:TCS'),
        redis.get('fund:TCS'),
      ]);
      const priceData = bLast.status==='fulfilled'&&pData.status==='fulfilled'&&Array.isArray(pData.value)
        ? `TCS: ${pData.value.length} candles (from ${pData.value[0]?.date})` : 'No data';
      return res.json({
        bhavcopyLastDate: bLast.value||'never',
        fundamentalsLastRun: fLast.value||'never',
        priceData,
        fundamentalsData: fData.value ? 'TCS fundamentals ✅' : 'No fund data',
        redisConnected: true,
        dataPolicy: 'NSE + BSE only. No Yahoo Finance.',
        githubCDN: GITHUB_CDN,
      });
    }

    if (action==='warmup') {
      await getNseCookie();
      return res.json({ok:true, source:'NSE (no Yahoo)'});
    }

    return res.status(400).json({error:'Unknown action', action});

  } catch(e) {
    console.error('Handler error:', e.message);
    return res.status(500).json({error:e.message});
  }
}
