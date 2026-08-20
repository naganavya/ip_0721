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
  equity: process.env.EQUITY_CODE || '120716',   // UTI Nifty 50 Index, Direct, Growth
  debt  : process.env.DEBT_CODE   || '119533',   // ABSL Corporate Bond, Direct, Growth
  gold  : process.env.GOLD_CODE   || '119788',   // SBI Gold Fund, Direct, Growth
  liquid: process.env.LIQUID_CODE || '119091'    // HDFC Liquid Fund, Direct, Growth
};
/* Stamped into data.json and printed in the workflow log.

   Why this exists: uploading a file from a phone is a surprisingly unreliable
   step. The browser may save a second download as "update-data (1).mjs", and
   uploading THAT adds a new file to the repo while the workflow keeps running
   the old one — no error anywhere, output that looks fine, and a fix that
   silently never took effect. So the script says which version it is, and
   data.json records it. If this number is not what you just uploaded, the
   upload did not land, whatever the repo file list appears to show. */
const SCRIPT_VERSION = '2026-08-20d  step/spike detection';

const OUT = 'data.json';

/* A dead feed is the quietest failure of all. A fund that merged or was renamed
   years ago still answers with HTTP 200 and a full, genuine NAV history that
   simply stops. Its name passes a name check and its volatility passes a
   volatility check, because both were true — in 2013. Only the dates give it
   away, so the dates are checked. */
const MAX_STALE_DAYS   = 45;
/* The Monte Carlo resamples blocks of consecutive months. Below this, a
   bootstrap replays the same short window and returns a narrow, confident
   band that is an artefact of the sample size rather than a measurement. */
const MIN_USABLE_MONTHS = 60;

const get = async (url) => {
  const r = await fetch(url, {headers:{'User-Agent':'money-plan/1.0'}});
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

/* A scheme code is just a number, and a wrong one fails SILENTLY: you get real
   NAV data under the wrong label, so "gold" might actually be a small-cap
   equity fund. That is worse than a missing feed, because everything still
   looks like it worked while the correlations — gold's entire reason for being
   in the portfolio — become nonsense.

   So every fetched fund is checked against its label two ways: by name, and
   then by behaviour. Both must agree. */
const NAME_RULES = {
  equity: {want: /index|nifty|sensex|equity|flexi|large.?cap/i,
           deny: /gold|silver|liquid|overnight|debt|bond|gilt|money market/i},
  debt  : {want: /debt|bond|gilt|duration|corporate|banking.*psu|money market/i,
           deny: /gold|silver|equity|small.?cap|mid.?cap|index|nifty|liquid|overnight/i},
  gold  : {want: /gold/i,
           deny: /silver|equity|cap|index|nifty|debt|bond|liquid/i},
  liquid: {want: /liquid|overnight|money market|ultra.?short/i,
           deny: /gold|silver|equity|cap|index|nifty|income|gilt|long|medium/i}
};

/* Rough annualised volatility, used as a second opinion on the label. */
function annVol(returns){
  if(returns.length < 24) return null;
  const m = returns.reduce((a,b)=>a+b,0)/returns.length;
  const v = returns.reduce((a,b)=>a+(b-m)*(b-m),0)/(returns.length-1);
  return Math.sqrt(v)*Math.sqrt(12);
}
const VOL_RULES = {          // annualised, generous bounds — catching blunders, not tuning
  equity: [0.08, 0.45],
  debt  : [0.001, 0.09],
  gold   : [0.06, 0.30],
  liquid: [0.0, 0.03]
};

/* A SINGLE bad NAV print is not the same thing as the wrong fund, and the two
   need different answers.

   One stray value — a mis-keyed decimal, a NAV from a different plan, a day
   the AMC filed the wrong number — poisons the whole series if it is left in.
   It shows up as an implausible one-month move and then again, reversed, the
   month after. Standard deviation is not robust to that: one outlier of 60
   in a 62-month series of 0.005s produces an annualised volatility in the
   thousands of percent, and a check that only looks at the total will
   conclude the fund is the wrong kind of animal when it is the right fund
   with one bad row.

   So the two are separated. Months whose move is arithmetically impossible for
   the asset class are DROPPED — never interpolated, and reported with the
   NAVs and dates that produced them. Only if such months are common does the
   label itself come into question. */
const MOVE_RULES = {         // plausible bounds on ONE month's return
  equity: [-0.35, 0.35],
  debt  : [-0.10, 0.12],
  gold  : [-0.25, 0.30],
  liquid:[-0.01, 0.02]
};
const MAX_BAD_FRACTION = 0.05;   // above this, it is the fund, not the data

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
  const out = new Map(), when = new Map();
  for(const [k,[dd,nav]] of m){
    out.set(k, nav);
    when.set(k, `${String(dd).padStart(2,'0')}-${String((k%12)+1).padStart(2,'0')}-${Math.floor(k/12)}`);
  }
  // newest observation, for the staleness check
  let last = null;
  for(const d of (j.data||[])){
    const [dd,mm,yy] = d.date.split('-').map(Number);
    const t = Date.UTC(yy, mm-1, dd);
    if(last===null || t>last) last = t;
  }
  return {name: j.meta?.scheme_name || String(code), navs: out, when, last,
          category: j.meta?.scheme_category || '', points: (j.data||[]).length};
}

/* Four aligned monthly return series, truncated to their common overlap. */
async function alignedSeries(){
  const loaded = {}, errs = [];
  for(const [asset, code] of Object.entries(FUNDS)){
    try {
      const f = await navByMonth(code);
      const r = NAME_RULES[asset];
      if(r && (!r.want.test(f.name) || r.deny.test(f.name))){
        errs.push(`${asset} (${code}): REJECTED — "${f.name}" does not look like a ${asset} fund. `+
                  `Find the right code at api.mfapi.in/mf/search?q=<fund name>`);
        continue;
      }
      const ageDays = f.last==null ? Infinity : Math.floor((Date.now()-f.last)/86400000);
      if(ageDays > MAX_STALE_DAYS){
        errs.push(`${asset} (${code}): REJECTED — "${f.name}" last published a NAV `+
                  `${f.last==null?'never':new Date(f.last).toISOString().slice(0,10)}, `+
                  `${isFinite(ageDays)?ageDays+' days ago':'ever'}. This fund is dead — merged, renamed or wound up. `+
                  `The history it returns is real and finished, which is why nothing else catches it.`);
        continue;
      }
      f.ageDays = ageDays;
      loaded[asset] = f;
    }
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

  const order = ['equity','debt','gold','liquid'];

  /* Pass one: every candidate month, with each asset's raw return, and a note
     of which ones are arithmetically impossible for their asset class. */
  const cand = [];
  for(let i=1;i<keys.length;i++){
    if(keys[i]-keys[i-1] !== 1) continue;          // a gap: skip, never interpolate
    if(order.some(a=>!loaded[a])) continue;        // partial data is refused outright
    const row = [0,0,0,0]; const bad = [];
    const monthIx = cand.length;      // position in cand, NOT the asset index
    order.forEach((a,ix)=>{
      const n1 = loaded[a].navs.get(keys[i-1]), n2 = loaded[a].navs.get(keys[i]);
      const r = n2/n1 - 1;
      row[ix] = +r.toFixed(6);
      const [lo,hi] = MOVE_RULES[a];
      if(r < lo || r > hi)
        bad.push({asset:a, ix:monthIx, r, n1, n2,
                  from: loaded[a].when.get(keys[i-1]), to: loaded[a].when.get(keys[i])});
    });
    cand.push({row, bad});
  }

  /* Pass two: an impossible move is one of two completely different things,
     and treating them the same is how a wrong series survives.

       SPIKE  a NAV goes wrong for one month and comes straight back. A typo, a
              stray value from another plan. The month either side is fine, so
              drop the bad month and keep everything else.

       STEP   a NAV changes level and STAYS there. That is not a bad print —
              it is a different fund. Scheme mergers and face-value changes do
              this: a liquid fund carrying a Rs 10 predecessor's history will
              jump by a factor of about 100 on the day the series switches over.
              Everything BEFORE the step belongs to that other fund and has no
              business in this series, however real those returns were.

     Dropping the single month at a step is the dangerous outcome: the return
     series repairs itself arithmetically and years of a different fund's
     history stay in, looking perfectly ordinary. So a step truncates. */
  /* A NAV that goes wrong and comes back produces TWO impossible moves — the
     departure and the return — and either one, looked at alone, is
     indistinguishable from a permanent level change. So a move counts as part
     of a spike if compounding it with EITHER neighbour lands back in normal
     territory. Checking only the following month classifies the recovery leg
     as a step and truncates the series at exactly the wrong place. */
  const retOf = (a,i) => cand[i] ? cand[i].row[order.indexOf(a)] : null;
  const backToNormal = (a,g) => {
    const [lo,hi] = MOVE_RULES[a];
    return g!=null && g >= lo*2 && g <= hi*2;
  };
  const isSpike = (b) => {
    const nxt = retOf(b.asset, b.ix+1), prv = retOf(b.asset, b.ix-1);
    return backToNormal(b.asset, nxt==null?null:(1+b.r)*(1+nxt)-1)
        || backToNormal(b.asset, prv==null?null:(1+b.r)*(1+prv)-1);
  };

  /* Order matters. Count first, judge the FUND first, and only then ask what
     kind of defect the surviving funds have. A fund that lurches every month is
     the wrong fund; describing its first lurch as a "face-value change" is
     noise on top of a verdict that has already been reached. */
  const moveOffenders = {};
  cand.forEach(c=>c.bad.forEach(b=>{moveOffenders[b.asset]=(moveOffenders[b.asset]||0)+1}));
  const rejected = new Set();
  Object.entries(moveOffenders).forEach(([a,n])=>{
    if(cand.length && n/cand.length > MAX_BAD_FRACTION){
      rejected.add(a);
      errs.push(`${a}: ${n} of ${cand.length} months move by amounts impossible for ${a}. `+
                `That is far too many to be bad prints. "${loaded[a].name}" is REJECTED as the wrong kind of fund.`);
    }
  });

  const steps = [], spikes = [];
  cand.forEach(c=>c.bad.forEach(b=>{
    if(rejected.has(b.asset)) return;
    (isSpike(b) ? spikes : steps).push(b);
  }));

  // truncate at the LAST step: everything before it is another fund's history
  const cut = steps.length ? Math.max(...steps.map(b=>b.ix)) + 1 : 0;
  if(cut){
    const b = steps.reduce((x,y)=>y.ix>x.ix?y:x);
    errs.push(`${b.asset}: the NAV series steps from ${b.n1} to ${b.n2} between ${b.from} and ${b.to} `+
              `(x${(b.n2/b.n1).toFixed(2)}) and stays at the new level. That is a scheme merger or a `+
              `face-value change, not a bad print — the history before it belongs to a different fund. `+
              `Everything up to ${b.to} has been DISCARDED; ${cand.length-cut} months kept. `+
              `Dropping just that one month would have repaired the arithmetic and quietly left the `+
              `other fund's years in the series.`);
  }

  const kept = cand.slice(cut);
  const rows = kept.filter(c=>!c.bad.length).map(c=>c.row);
  const droppedAfterCut = kept.length - rows.length;

  const totalMonths = cand.length;
  if(droppedAfterCut && !rejected.size){
    const shown = spikes.filter(b=>b.ix>=cut).slice(0,4).map(x=>
      `${x.asset} ${x.from} ${x.n1} -> ${x.to} ${x.n2} (${(x.r*100).toFixed(1)}%)`);
    errs.push(`${droppedAfterCut} month(s) dropped as one-off bad NAV prints — the value went wrong and `+
              `came straight back, so only that month is unusable. ${shown.length?'Worst: '+shown.join(' | '):''}`);
  }
  const dropped = {steps: steps.length, spikes: spikes.filter(b=>b.ix>=cut).length, cut};
  /* Honest cost of dropping a spike month: the surviving months are no longer
     strictly contiguous, so a resampled block can splice across the gap. For a
     handful of drops in a multi-year series that is a far smaller distortion
     than leaving an impossible return in, but it is a distortion. */


  // Second opinion: does each series BEHAVE like the thing it claims to be?
  // Measured AFTER dropping impossible months, so one stray NAV cannot make a
  // perfectly good liquid fund look like it has 2700% volatility.
  const vols = {};
  order.forEach((a,ix)=>{
    if(!loaded[a] || !rows.length) return;
    const v = annVol(rows.map(r=>r[ix]));
    vols[a] = v;
    const [lo,hi] = VOL_RULES[a];
    if(v!=null && (v < lo || v > hi))
      errs.push(`${a}: volatility ${(v*100).toFixed(1)}%/yr is outside the ${(lo*100)}-${(hi*100)}% `+
                `range expected for ${a}, measured over ${rows.length} clean months. `+
                `"${loaded[a].name}" is the wrong kind of fund.`);
  });
  // gold that moves with equities is not doing the job gold is there to do
  if(rows.length>24 && loaded.equity && loaded.gold){
    const e=rows.map(r=>r[0]), g=rows.map(r=>r[2]);
    const me=e.reduce((a,b)=>a+b,0)/e.length, mg=g.reduce((a,b)=>a+b,0)/g.length;
    let c=0,ve=0,vg=0;
    for(let i=0;i<e.length;i++){c+=(e[i]-me)*(g[i]-mg);ve+=(e[i]-me)**2;vg+=(g[i]-mg)**2}
    const corr=c/Math.sqrt(ve*vg);
    if(corr > 0.5) errs.push(`gold: correlation with equity is ${corr.toFixed(2)}. Real gold sits near `+
                             `zero or below. "${loaded.gold.name}" is almost certainly an equity fund.`);
  }
  if(rows.length && rows.length < MIN_USABLE_MONTHS)
    errs.push(`only ${rows.length} months overlap across all four funds (need ${MIN_USABLE_MONTHS}). `+
              `The overlap is set by the SHORTEST history, so one recently-launched fund caps everything. `+
              `Swap it for an older scheme of the same kind if you want a longer window.`);
  const bad = errs.some(e=>/REJECTED|wrong kind|almost certainly/.test(e));
  const names = {}; have.forEach(a=>names[a]=loaded[a].name);
  const ages  = {}; have.forEach(a=>ages[a]=loaded[a].ageDays);
  const diag  = {};
  have.forEach(a=>{
    const ks=[...loaded[a].navs.keys()].sort((x,y)=>x-y);
    diag[a]={points:loaded[a].points, months:ks.length,
             first:loaded[a].when.get(ks[0]), last:loaded[a].when.get(ks[ks.length-1]),
             firstNav:loaded[a].navs.get(ks[0]), lastNav:loaded[a].navs.get(ks[ks.length-1]),
             droppedMonths: moveOffenders[a]||0};
  });
  return {series: (rows.length>=MIN_USABLE_MONTHS && !bad) ? rows : null, errs, names, vols, ages,
          diag, dropped, truncatedAt: cut,
          months: rows.length, assets: have,
          complete: have.length === 4 && rows.length>=MIN_USABLE_MONTHS && !bad};
}

/* FP.CPI.TOTL.ZG is "Inflation, consumer prices (annual %)". World Bank data
   for India lags by roughly a year, so this is NOT the current rate — it is the
   average of the last five years it has published, and the years are recorded
   in the output so nobody has to guess which ones. */
async function inflation(){
  const j = await get('https://api.worldbank.org/v2/country/IN/indicator/FP.CPI.TOTL.ZG?format=json&per_page=10');
  const rows = (j[1]||[]).filter(d=>d.value!=null).slice(0,5);
  if(!rows.length) return null;
  const v = rows.map(d=>d.value);
  const avg = v.reduce((a,b)=>a+b,0)/v.length;
  const years = rows.map(d=>d.date).sort();
  /* A single crisis year, a revision, or a units change upstream would move
     this without anything downstream noticing. Every assumption in the model is
     built on top of it, so it is bounded and any clamp is reported. */
  const LO = 2.0, HI = 10.0;
  const clampedTo = avg < LO ? LO : avg > HI ? HI : null;
  return {value: +(clampedTo ?? avg).toFixed(2),
          raw: +avg.toFixed(2),
          years: `${years[0]}-${years[years.length-1]}`,
          clamped: clampedTo != null};
}

/* Assumptions are BUILT UP, never read off recent performance. Only the
   observable components move on their own; the judgement components are the
   constants below and change when a human edits them, deliberately. */
function assumptions(infl){
  const inflation  = infl ?? 5.0;
  const realGrowth = 5.5;   // long-run real earnings growth — review yearly
  const divYield   = 1.2;   // observable; wire to a live source if you have one
  const repricing  = -0.7;  // valuation drag — judgement
  /* debt is a SPREAD OVER CPI, not a reading of the yield curve. Nothing here
     fetches bond yields — index and bond data are licensed. The spread is
     roughly right today and will drift; if you want the highest-confidence
     number in the model to actually be high-confidence, look up the 10-year
     government bond yield once a year and type it into the Data tab. */
  return {
    equity: +(divYield + realGrowth + repricing + inflation).toFixed(2),
    debt  : +(inflation + 1.8).toFixed(2),
    debtSource: 'CPI + 1.8% spread — NOT the live yield curve; override on the Data tab if you want the real one',
    gold  : +(inflation + 1.5).toFixed(2),
    liquid: +(inflation + 0.8).toFixed(2),
    inflation,
    eduInfl   : +(inflation + 3.0).toFixed(2),
    healthInfl: +(inflation + 4.0).toFixed(2)
  };
}

(async () => {
  const errors = [];
  let infl = null, inflMeta = null;
  try {
    inflMeta = await inflation();
    if(inflMeta){
      infl = inflMeta.value;
      if(inflMeta.clamped) errors.push(
        `inflation: World Bank five-year average came back as ${inflMeta.raw}%, outside the plausible `+
        `2-10% band — held at ${infl}%. Check the source before trusting anything downstream of it.`);
    }
  } catch(e){ errors.push('inflation: '+e.message); }
  const S = await alignedSeries();
  errors.push(...S.errs);

  const payload = {
    reviewed: new Date().toISOString().slice(0,10),
    scriptVersion: SCRIPT_VERSION,
    source: 'auto — update-data.mjs',
    ...assumptions(infl),
    inflationSource: infl!=null
      ? `World Bank CPI India (FP.CPI.TOTL.ZG), average of ${inflMeta.years} — published data lags about a year, so this is not the current print`
      : 'fallback default',
    inflationYears: inflMeta ? inflMeta.years : null,
    // four aligned columns: equity, debt, gold, liquid
    series: S.series,
    seriesMonths: S.series ? S.series.length : 0,
    seriesAssets: S.assets,
    seriesComplete: !!S.complete,
    seriesNames: S.names,
    seriesVols: S.vols || {},
    seriesAgeDays: S.ages || {},
    seriesDiagnostics: S.diag || {},
    seriesDropped: S.dropped || {},
    minUsableMonths: MIN_USABLE_MONTHS,
    errors
  };

  const fs = await import('node:fs');
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 1));
  console.log(`update-data.mjs version ${SCRIPT_VERSION}`);
  console.log(`wrote ${OUT}`);
  console.log(`  inflation ${payload.inflation}%  ·  equity ${payload.equity}%`);
  console.log(`  aligned series: ${payload.seriesMonths} months across ${S.assets.length}/4 assets` +
              (payload.seriesComplete ? ' (complete)' : ' — INCOMPLETE, correlations will be partial'));
  Object.entries(S.names).forEach(([a,n])=>{
    const v=(S.vols||{})[a];
    console.log(`    ${a.padEnd(7)} ${n}${v!=null?`  [vol ${(v*100).toFixed(1)}%/yr]`:''}`);
  });
  if(errors.length) console.log('  warnings:\n    '+errors.join('\n    '));
})();
