#!/usr/bin/env node
/* ============================================================================
   update-data.mjs  —  runs on a SERVER, on a schedule. Not in your browser.

   CORS is a browser rule. It stops a web page reading a response from another
   site; it does not apply to a program fetching a URL. So this collects freely,
   writes one small file, and the app reads that file from its own origin where
   no cross-site request happens at all.

   WHAT THIS DOES AND DOES NOT FETCH — read this before trusting the output.

     Equity   real   NAV history of an index FUND, used as a proxy for the index
     Debt     real   NAV history of a short-duration debt fund
     Gold     real   NAV history of a gold ETF / fund-of-fund
     Liquid   real   NAV history of a liquid fund
     Inflation real  World Bank CPI for India, five-year average

     Nifty itself        NOT fetched. Index values are licensed data. An index
                         fund's NAV tracks the index minus its expense ratio and
                         tracking error, which for planning purposes is the
                         better number anyway — it is what an investor would
                         actually have received.
     International       NOT fetched. Add a scheme code below if you hold one.
     Bond yields         NOT fetched. Derived from CPI. Replace if you find a
                         source that permits it.

   ALIGNMENT MATTERS MORE THAN COVERAGE. The four series are matched by calendar
   month and truncated to the overlap. Pairing them any other way — by array
   position, say — produces returns that are individually real and jointly
   meaningless, which quietly destroys every correlation and every claim about
   diversification that rests on them.
   ========================================================================== */

const FUNDS = {
  equity: process.env.EQUITY_CODE || '120716',   // a Nifty index fund
  debt  : process.env.DEBT_CODE   || '119533',   // short-duration debt
  gold  : process.env.GOLD_CODE   || '119212',   // gold fund
  liquid: process.env.LIQUID_CODE || '119069'    // liquid fund
};
const OUT = 'data.json';

const get = async (url) => {
  const r = await fetch(url, {headers:{'User-Agent':'money-plan/1.0'}});
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

/* month key -> NAV, last observation of each month */
async function navByMonth(code){
  const j = await get(`https://api.mfapi.in/mf/${code}`);
  const m = new Map();
  for(const d of (j.data||[])){
    const [dd,mm,yy] = d.date.split('-').map(Number);
    const nav = parseFloat(d.nav);
    if(!isFinite(nav) || nav <= 0) continue;
    const k = yy*12 + (mm-1);
    const prev = m.get(k);
    if(!prev || dd > prev[0]) m.set(k, [dd, nav]);
  }
  const out = new Map();
  for(const [k,[,nav]] of m) out.set(k, nav);
  return {name: j.meta?.scheme_name || String(code), navs: out};
}

/* Four aligned monthly return series, truncated to their common overlap. */
async function alignedSeries(){
  const loaded = {}, errs = [];
  for(const [asset, code] of Object.entries(FUNDS)){
    try { loaded[asset] = await navByMonth(code); }
    catch(e){ errs.push(`${asset} (${code}): ${e.message}`); }
  }
  const have = Object.keys(loaded);
  if(have.length === 0) return {series:null, errs, names:{}, months:0, assets:[]};

  // months present in EVERY fetched series, consecutive only
  let common = null;
  for(const a of have){
    const ks = new Set(loaded[a].navs.keys());
    common = common ? new Set([...common].filter(k=>ks.has(k))) : ks;
  }
  const keys = [...common].sort((x,y)=>x-y);

  const rows = [];
  for(let i=1;i<keys.length;i++){
    if(keys[i]-keys[i-1] !== 1) continue;          // a gap: skip, never interpolate
    const row = [0,0,0,0];
    const order = ['equity','debt','gold','liquid'];
    let complete = true;
    order.forEach((a,ix)=>{
      if(!loaded[a]) { complete = false; return; }
      row[ix] = +(loaded[a].navs.get(keys[i]) / loaded[a].navs.get(keys[i-1]) - 1).toFixed(6);
    });
    if(complete) rows.push(row);
  }
  const names = {}; have.forEach(a=>names[a]=loaded[a].name);
  return {series: rows.length>=24 ? rows : null, errs, names,
          months: rows.length, assets: have,
          complete: have.length === 4};
}

async function inflation(){
  const j = await get('https://api.worldbank.org/v2/country/IN/indicator/FP.CPI.TOTL.ZG?format=json&per_page=8');
  const v = (j[1]||[]).filter(d=>d.value!=null).slice(0,5).map(d=>d.value);
  if(!v.length) return null;
  return +(v.reduce((a,b)=>a+b,0)/v.length).toFixed(2);
}

/* Assumptions are BUILT UP, never read off recent performance. Only the
   observable components move on their own; the judgement components are the
   constants below and change when a human edits them, deliberately. */
function assumptions(infl){
  const inflation  = infl ?? 5.0;
  const realGrowth = 5.5;   // long-run real earnings growth — review yearly
  const divYield   = 1.2;   // observable; wire to a live source if you have one
  const repricing  = -0.7;  // valuation drag — judgement
  return {
    equity: +(divYield + realGrowth + repricing + inflation).toFixed(2),
    debt  : +(inflation + 1.8).toFixed(2),
    gold  : +(inflation + 1.5).toFixed(2),
    liquid: +(inflation + 0.8).toFixed(2),
    inflation,
    eduInfl   : +(inflation + 3.0).toFixed(2),
    healthInfl: +(inflation + 4.0).toFixed(2)
  };
}

(async () => {
  const errors = [];
  let infl = null;
  try { infl = await inflation(); } catch(e){ errors.push('inflation: '+e.message); }
  const S = await alignedSeries();
  errors.push(...S.errs);

  const payload = {
    reviewed: new Date().toISOString().slice(0,10),
    source: 'auto — update-data.mjs',
    ...assumptions(infl),
    inflationSource: infl!=null ? 'World Bank CPI India, 5-year average' : 'fallback default',
    // four aligned columns: equity, debt, gold, liquid
    series: S.series,
    seriesMonths: S.series ? S.series.length : 0,
    seriesAssets: S.assets,
    seriesComplete: !!S.complete,
    seriesNames: S.names,
    errors
  };

  const fs = await import('node:fs');
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 1));
  console.log(`wrote ${OUT}`);
  console.log(`  inflation ${payload.inflation}%  ·  equity ${payload.equity}%`);
  console.log(`  aligned series: ${payload.seriesMonths} months across ${S.assets.length}/4 assets` +
              (payload.seriesComplete ? ' (complete)' : ' — INCOMPLETE, correlations will be partial'));
  Object.entries(S.names).forEach(([a,n])=>console.log(`    ${a.padEnd(7)} ${n}`));
  if(errors.length) console.log('  warnings:\n    '+errors.join('\n    '));
})();
