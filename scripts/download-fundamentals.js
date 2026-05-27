// scripts/download-fundamentals.js
// Downloads fundamentals from official NSE XBRL filings
// Sources (all official, all free, all legal):
//   1. data/fund/shareholding_map.json  → Promoter%, Public%
//   2. data/fund/filing_index.json      → XBRL links
//   3. nsearchives.nseindia.com XBRL    → Revenue, Profit, EPS
//   4. data/prices/{SYM}.json           → 52W High/Low

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Accept': '*/*', 'Referer': 'https://www.nseindia.com/',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function pf(v) { return parseFloat(v) || 0; }
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

async function fetchXml(url) {
  const r = await fetch(url, { headers: NSE_HEADERS, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

function parseXbrl(xml) {
  const extract = (tags) => {
    for (const tag of tags) {
      const patterns = [
        new RegExp(`<[\\w]*:?${tag}[^>]*>([\\d.()-]+)<`, 'i'),
        new RegExp(`<[\\w]*:?${tag}\\s[^>]*>([\\d.()-]+)<`, 'i'),
      ];
      for (const pat of patterns) {
        const m = xml.match(pat);
        if (m?.[1]) {
          const val = parseFloat(m[1].replace('(', '-').replace(')', ''));
          if (!isNaN(val) && val !== 0) return val;
        }
      }
    }
    return 0;
  };

  const revenue = extract(['RevenueFromOperations','NetSales','TotalRevenuefromOperations','GrossRevenue','TotalRevenue']);
  const ebitda  = extract(['EarningsBeforeInterestTaxDepreciationAndAmortization','EBITDA','OperatingProfit','ProfitBeforeDepreciationInterestAndTax']);
  const profit  = extract(['ProfitForThePeriod','ProfitAfterTax','NetProfit','ProfitLossForThePeriod','ProfitLoss']);
  const eps     = extract(['EarningsPerEquityShareBasic','BasicEarningsPerShareFromContinuingOperations','BasicEPS']);
  const equity  = extract(['Equity','TotalEquity','ShareholdersEquity']);
  const debt    = extract(['LongTermBorrowings','Borrowings','TotalBorrowings']);

  // Convert to ₹ Crore
  const toCr = (v) => {
    if (!v) return 0;
    if (Math.abs(v) > 100000000) return Math.round(v / 10000000 * 100) / 100;
    if (Math.abs(v) > 1000000)   return Math.round(v / 100 * 100) / 100;
    return Math.round(v * 100) / 100;
  };

  return { revenue: toCr(revenue), ebitda: toCr(ebitda), profit: toCr(profit), eps: Math.round(eps*100)/100, equity: toCr(equity), debt: toCr(debt) };
}

function get52W(sym, pricesDir) {
  try {
    const file = path.join(pricesDir, `${sym}.json`);
    if (!fs.existsSync(file)) return { w52High: 0, w52Low: 0 };
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - 1);
    const cutStr = cutoff.toISOString().split('T')[0];
    const recent = (data.candles || []).filter(c => c.date >= cutStr);
    if (!recent.length) return { w52High: 0, w52Low: 0 };
    return {
      w52High: Math.max(...recent.map(c => c.high || c.close)),
      w52Low:  Math.min(...recent.map(c => c.low  || c.close)),
    };
  } catch { return { w52High: 0, w52Low: 0 }; }
}

function matchShareholding(companyName, shMap) {
  if (!companyName || !shMap) return null;
  const name = companyName.toUpperCase().trim();
  if (shMap[name]) return shMap[name];
  const words = name.split(' ').slice(0, 3).join(' ');
  const match = Object.keys(shMap).find(k => k.startsWith(words) || k.includes(words));
  return match ? shMap[match] : null;
}

async function main() {
  console.log('🚀 AskArtha Fundamentals — NSE Official XBRL + Shareholding CSV');
  console.log('100% legal — official NSE public data');
  console.log('Started:', new Date().toISOString(), '\n');

  const BASE_DIR   = process.cwd();
  const FUND_DIR   = path.join(BASE_DIR, 'data', 'fund');
  const PRICES_DIR = path.join(BASE_DIR, 'data', 'prices');
  ensureDir(FUND_DIR);

  const filingIndex = JSON.parse(fs.readFileSync(path.join(FUND_DIR, 'filing_index.json'), 'utf8'));
  const shMap       = JSON.parse(fs.readFileSync(path.join(FUND_DIR, 'shareholding_map.json'), 'utf8'));
  const nameMap     = JSON.parse(fs.readFileSync(path.join(FUND_DIR, 'name_map.json'), 'utf8'));

  console.log(`Filing index: ${Object.keys(filingIndex).length} companies`);
  console.log(`Shareholding: ${Object.keys(shMap).length} companies\n`);

  const symbols = Object.keys(filingIndex);
  let done = 0, withIncome = 0, withSh = 0;

  console.log(`📊 Processing ${symbols.length} companies...\n`);

  for (const sym of symbols) {
    const companyName = nameMap[sym] || sym;
    const filings = filingIndex[sym] || [];
    const file = path.join(FUND_DIR, `${sym}.json`);
    let existing = {};
    if (fs.existsSync(file)) { try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {} }

    const sh = matchShareholding(companyName, shMap);
    if (sh) withSh++;

    // Process consolidated filings, latest first
    const income = [];
    const toProcess = filings
      .filter(f => f.type?.toLowerCase().includes('consolidated') || !filings.some(x => x.type?.toLowerCase().includes('consolidated')))
      .sort((a, b) => b.q.localeCompare(a.q))
      .slice(0, 4);

    for (const filing of toProcess.slice(0, 3)) {
      try {
        const xml = await fetchXml(filing.url);
        const d = parseXbrl(xml);
        if (d.revenue > 0 || d.profit !== 0) {
          income.push({ date: filing.q, revenue: d.revenue, ebitda: d.ebitda, profit: d.profit, eps: d.eps, equity: d.equity, debt: d.debt });
        }
        await sleep(150);
      } catch {}
    }

    if (income.length > 0) withIncome++;
    const { w52High, w52Low } = get52W(sym, PRICES_DIR);
    const latest = income[0] || {};
    const prev   = income[1] || {};

    const fund = {
      symbol: sym, name: companyName,
      pe: existing.pe || 0, pb: existing.pb || 0,
      eps: income[0]?.eps || existing.eps || 0,
      roe:           latest.equity  > 0 ? Math.round(latest.profit  / latest.equity  * 10000) / 100 : (existing.roe || 0),
      debtToEquity:  latest.equity  > 0 ? Math.round(latest.debt    / latest.equity  * 100)   / 100 : (existing.debtToEquity || 0),
      profitMargin:  latest.revenue > 0 ? Math.round(latest.profit  / latest.revenue * 10000) / 100 : (existing.profitMargin || 0),
      revenueGrowth: prev.revenue   > 0 ? Math.round((latest.revenue - prev.revenue) / prev.revenue * 10000) / 100 : 0,
      marketCap: existing.marketCap || 0,
      bookValue: latest.equity || existing.bookValue || 0,
      w52High, w52Low,
      income,
      shareholding: sh ? { promoter: sh.promoter, fii: 0, dii: 0, public: sh.public, pledged: 0, quarter: sh.quarter } : (existing.shareholding || null),
      actions: existing.actions || [],
      industry: existing.industry || '',
      longName: companyName,
      updatedAt: new Date().toISOString(),
      sources: {
        income: income.length > 0 ? `NSE XBRL (${income.length} quarters)` : 'unavailable',
        shareholding: sh ? 'NSE Official' : 'unavailable',
      },
    };

    fs.writeFileSync(file, JSON.stringify(fund));
    done++;
    process.stdout.write(income.length > 0 ? '✓' : (sh ? '·' : '○'));
    if (done % 100 === 0) process.stdout.write(` ${done}/${symbols.length} (income:${withIncome} sh:${withSh})\n`);
    await sleep(100);
  }

  fs.writeFileSync(path.join(FUND_DIR, '_meta.json'), JSON.stringify({ totalCompanies: symbols.length, withIncome, withShareholding: withSh, updatedAt: new Date().toISOString(), source: 'NSE Official XBRL + NSE Shareholding CSV' }, null, 2));

  console.log(`\n\n═══════════════════════════════════════════════════`);
  console.log(`✅ FUNDAMENTALS COMPLETE`);
  console.log(`   Companies:         ${symbols.length}`);
  console.log(`   With income data:  ${withIncome}`);
  console.log(`   With shareholding: ${withSh}`);
  console.log(`   Finished: ${new Date().toISOString()}`);
  console.log(`═══════════════════════════════════════════════════`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
