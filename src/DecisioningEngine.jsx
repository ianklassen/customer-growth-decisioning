import { useState, useMemo, Fragment } from "react";

/* ------------------------------------------------------------------ */
/*  Deterministic randomness                                           */
/* ------------------------------------------------------------------ */

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Stable hash used for experiment assignment. Assignment must not depend on
// call order or on the cohort RNG, or re-running changes who is in holdout.
function hashUnit(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0) / 4294967296;
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pct = (v, d = 1) => (v * 100).toFixed(d) + "%";
const money = (v) => "$" + v.toFixed(2);

/* ------------------------------------------------------------------ */
/*  Cohort generation                                                  */
/* ------------------------------------------------------------------ */

function buildCohort(size, seed) {
  const rnd = mulberry32(seed);
  const out = [];
  for (let i = 0; i < size; i++) {
    const engaged = rnd();
    const recencyDays = Math.round(clamp((1 - engaged) * 150 + rnd() * 40, 0, 180));
    const freq90 = Math.round(clamp(engaged * 34 + rnd() * 6, 0, 40));
    const digitalShare = clamp(rnd() * 0.55 + engaged * 0.4, 0, 1);
    const categoryBreadth = Math.round(clamp(1 + engaged * 9 + rnd() * 3, 1, 12));
    const basketAvg = Math.round(clamp(28 + engaged * 70 + rnd() * 45, 15, 190));
    const plusMember = rnd() < clamp(0.12 + engaged * 0.55, 0, 0.9);
    const plusTenureMonths = plusMember ? Math.round(rnd() * 46) + 1 : 0;
    const benefitUtil = plusMember ? clamp(engaged * 0.7 + rnd() * 0.4, 0, 1) : 0;
    const priceSensitivity = clamp(rnd() * 0.85 + 0.1, 0, 1);
    const contactsLast30 = Math.round(rnd() * 5);
    const lastActionDaysAgo = Math.round(rnd() * 30);

    out.push({
      id: "C-" + String(100000 + Math.floor(rnd() * 899999)).slice(0, 6),
      idx: i,
      recencyDays,
      freq90,
      digitalShare,
      categoryBreadth,
      basketAvg,
      plusMember,
      plusTenureMonths,
      benefitUtil,
      priceSensitivity,
      contactsLast30,
      lastActionDaysAgo,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Propensity scoring — hand-specified, fully inspectable             */
/* ------------------------------------------------------------------ */

function scoreCustomer(c) {
  const models = {};

  const trip = [
    ["intercept", -0.3],
    ["recency", -0.02 * c.recencyDays],
    ["freq_90d", 0.075 * c.freq90],
    ["plus_member", c.plusMember ? 0.55 : 0],
    ["digital_share", 0.4 * c.digitalShare],
  ];
  models.pNextTrip = { terms: trip, z: trip.reduce((s, t) => s + t[1], 0) };

  const expand = [
    ["intercept", -0.8],
    ["breadth_headroom", 0.14 * (12 - c.categoryBreadth)],
    ["digital_share", 0.7 * c.digitalShare],
    ["basket_avg", 0.0035 * c.basketAvg],
    ["recency", -0.008 * c.recencyDays],
  ];
  models.pCategoryExpand = { terms: expand, z: expand.reduce((s, t) => s + t[1], 0) };

  const churn = [
    ["intercept", -1.1],
    ["recency", 0.022 * c.recencyDays],
    ["freq_90d", -0.07 * c.freq90],
    ["benefit_util", -1.2 * c.benefitUtil],
    ["plus_tenure", -0.01 * c.plusTenureMonths],
  ];
  models.pChurnRisk = { terms: churn, z: churn.reduce((s, t) => s + t[1], 0) };

  const convert = [
    ["intercept", -1.6],
    ["freq_90d", 0.065 * c.freq90],
    ["digital_share", 1.3 * c.digitalShare],
    ["basket_avg", 0.003 * c.basketAvg],
    ["price_sensitivity", 0.5 * c.priceSensitivity],
  ];
  models.pMembershipConvert = {
    terms: convert,
    z: convert.reduce((s, t) => s + t[1], 0),
  };

  const scores = {};
  Object.keys(models).forEach((k) => {
    scores[k] = sigmoid(models[k].z);
  });
  // Membership conversion is undefined for existing members.
  if (c.plusMember) scores.pMembershipConvert = 0;

  return { scores, models };
}

/* ------------------------------------------------------------------ */
/*  Action space                                                       */
/* ------------------------------------------------------------------ */

const ACTIONS = [
  {
    key: "push_replenishment",
    label: "Push · replenishment",
    channel: "push",
    driver: "pNextTrip",
    value: 8.5,
    responseMult: 0.35,
    contactCost: 0.9,
    outbound: true,
    baseLift: 0.028,
    eligible: () => true,
  },
  {
    key: "email_category_expand",
    label: "Email · category expansion",
    channel: "email",
    driver: "pCategoryExpand",
    value: 14.0,
    responseMult: 0.22,
    contactCost: 0.7,
    outbound: true,
    baseLift: 0.019,
    eligible: () => true,
  },
  {
    key: "homepage_module",
    label: "Homepage · personalized module",
    channel: "owned",
    driver: "pCategoryExpand",
    value: 6.0,
    responseMult: 0.3,
    contactCost: 0.05,
    outbound: false,
    baseLift: 0.014,
    eligible: () => true,
  },
  {
    key: "plus_trial_offer",
    label: "Email · Walmart+ trial",
    channel: "email",
    driver: "pMembershipConvert",
    value: 46.0,
    responseMult: 0.12,
    contactCost: 1.1,
    outbound: true,
    baseLift: 0.032,
    eligible: (c) => !c.plusMember,
  },
  {
    key: "plus_benefit_education",
    label: "Push · benefit activation",
    channel: "push",
    driver: "pChurnRisk",
    value: 22.0,
    responseMult: 0.18,
    contactCost: 0.6,
    outbound: true,
    baseLift: 0.021,
    eligible: (c) => c.plusMember && c.benefitUtil < 0.6,
  },
  {
    key: "personalized_discount",
    label: "Personalized discount depth",
    channel: "email",
    driver: "pNextTrip",
    value: 11.0,
    responseMult: 0.55,
    contactCost: 0.8,
    outbound: true,
    baseLift: 0.051,
    pricePersonalizing: true,
    eligible: () => true,
  },
];

const ACTION_META = {};
ACTIONS.forEach((a) => (ACTION_META[a.key] = a));
ACTION_META.no_action = {
  key: "no_action",
  label: "No action",
  channel: "none",
  baseLift: 0,
};

/* ------------------------------------------------------------------ */
/*  Decisioning + guardrails                                           */
/* ------------------------------------------------------------------ */

function decide(c, scored, cfg) {
  const candidates = [];
  const suppressed = [];

  ACTIONS.forEach((a) => {
    if (a.pricePersonalizing && cfg.priceLock) {
      suppressed.push({
        key: a.key,
        label: a.label,
        reason: "price-integrity lock — personalization may not vary price",
        rule: "PRICE_LOCK",
      });
      return;
    }
    if (!a.eligible(c)) {
      suppressed.push({
        key: a.key,
        label: a.label,
        reason: "not eligible for this customer state",
        rule: "ELIGIBILITY",
      });
      return;
    }
    if (a.outbound && c.contactsLast30 >= cfg.freqCap) {
      suppressed.push({
        key: a.key,
        label: a.label,
        reason: `frequency cap — ${c.contactsLast30} contacts in last 30d, cap is ${cfg.freqCap}`,
        rule: "FREQ_CAP",
      });
      return;
    }
    if (a.outbound && c.lastActionDaysAgo < cfg.cooldownDays) {
      suppressed.push({
        key: a.key,
        label: a.label,
        reason: `cooldown — last contact ${c.lastActionDaysAgo}d ago, minimum is ${cfg.cooldownDays}d`,
        rule: "COOLDOWN",
      });
      return;
    }

    const p = scored.scores[a.driver];
    const gross = p * a.value * a.responseMult;
    const net = gross - a.contactCost;
    candidates.push({ key: a.key, label: a.label, p, gross, net, driver: a.driver });
  });

  candidates.sort((x, y) => y.net - x.net);
  const top = candidates[0];

  let chosen = "no_action";
  let reason = "no eligible action survived the guardrail layer";

  if (top && top.net >= cfg.confidenceFloor) {
    chosen = top.key;
    reason = `highest net expected value (${money(top.net)}) above floor of ${money(
      cfg.confidenceFloor
    )}`;
  } else if (top) {
    reason = `best candidate ${top.label} netted ${money(
      top.net
    )}, below confidence floor of ${money(cfg.confidenceFloor)}`;
  }

  return { candidates, suppressed, chosen, reason };
}

/* ------------------------------------------------------------------ */
/*  Experiment harness                                                 */
/* ------------------------------------------------------------------ */

function runExperiment(rows, cfg) {
  const rnd = mulberry32(cfg.seed ^ 0x5a5a5a);
  const out = rows.map((r) => {
    const arm = hashUnit(r.customer.id + "|" + cfg.salt) < cfg.holdoutPct ? "holdout" : "treated";
    const base = r.scored.scores.pNextTrip;
    const act = ACTION_META[r.decision.chosen];
    const heteroLift = (act.baseLift || 0) * (0.5 + base);
    const pOutcome = arm === "treated" ? clamp(base + heteroLift, 0, 1) : base;
    const converted = rnd() < pOutcome;
    return { ...r, arm, base, pOutcome, converted, servedAction: arm === "treated" ? r.decision.chosen : "no_action" };
  });

  const treated = out.filter((r) => r.arm === "treated");
  const holdout = out.filter((r) => r.arm === "holdout");
  const n1 = treated.length;
  const n0 = holdout.length;
  const p1 = n1 ? treated.filter((r) => r.converted).length / n1 : 0;
  const p0 = n0 ? holdout.filter((r) => r.converted).length / n0 : 0;
  const diff = p1 - p0;
  const se = Math.sqrt((p1 * (1 - p1)) / Math.max(n1, 1) + (p0 * (1 - p0)) / Math.max(n0, 1));
  const ciLo = diff - 1.96 * se;
  const ciHi = diff + 1.96 * se;
  const pooled = (p1 * n1 + p0 * n0) / Math.max(n1 + n0, 1);
  const mde =
    2.8 * Math.sqrt(pooled * (1 - pooled) * (1 / Math.max(n1, 1) + 1 / Math.max(n0, 1)));

  // The trap: comparing customers who received an outbound action to customers
  // who received nothing. Targeting put high-propensity customers in the first
  // group, so this number is inflated by selection, not by the action.
  const acted = treated.filter((r) => r.servedAction !== "no_action");
  const notActed = treated.filter((r) => r.servedAction === "no_action");
  const naiveActed = acted.length ? acted.filter((r) => r.converted).length / acted.length : 0;
  const naiveNot = notActed.length
    ? notActed.filter((r) => r.converted).length / notActed.length
    : 0;

  return {
    rows: out,
    n1,
    n0,
    p1,
    p0,
    diff,
    se,
    ciLo,
    ciHi,
    mde,
    significant: ciLo > 0 || ciHi < 0,
    naiveActed,
    naiveNot,
    naiveDiff: naiveActed - naiveNot,
    actedN: acted.length,
    notActedN: notActed.length,
  };
}

/* ------------------------------------------------------------------ */
/*  UI                                                                 */
/* ------------------------------------------------------------------ */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');

.nba {
  --canvas:#EEF1F5; --panel:#FFFFFF; --ink:#0E1A2B; --ink2:#46566B; --ink3:#7C8CA1;
  --rule:#D5DCE5; --signal:#15589E; --signal-soft:#E3ECF6;
  --hold:#64748B; --guard:#A8500B; --guard-soft:#FBEEE0;
  --pos:#0B6E55; --pos-soft:#E2F1EC;
  background:var(--canvas); color:var(--ink);
  font-family:'IBM Plex Sans',system-ui,sans-serif;
  min-height:100%; padding:20px; box-sizing:border-box;
}
.nba *,.nba *::before,.nba *::after{box-sizing:border-box;}
.nba .mono{font-family:'IBM Plex Mono',ui-monospace,monospace;}

.nba .hdr{border-bottom:2px solid var(--ink); padding-bottom:14px; margin-bottom:18px;}
.nba .eyebrow{font-family:'IBM Plex Mono',monospace; font-size:10px; text-transform:uppercase;
  letter-spacing:0.12em; color:var(--ink3); margin-bottom:6px;}
.nba .framing{border-left:2px solid var(--signal); background:var(--signal-soft);
  padding:11px 14px; margin-bottom:16px;}
.nba .framing p{margin:0; font-size:12.5px; line-height:1.6; color:var(--ink2);}
.nba .framing b{color:var(--ink);}
.nba .hdr h1{font-size:19px; font-weight:700; margin:0 0 4px; letter-spacing:-0.2px;}
.nba .hdr p{margin:0; font-size:13px; color:var(--ink2); max-width:76ch; line-height:1.5;}
.nba .runmeta{margin-top:10px; display:flex; flex-wrap:wrap; gap:14px;
  font-family:'IBM Plex Mono',monospace; font-size:10.5px; color:var(--ink3);
  text-transform:uppercase; letter-spacing:0.06em;}

.nba .shell{display:flex; gap:18px; align-items:flex-start;}
@media (max-width:900px){ .nba .shell{flex-direction:column;} .nba .rail{width:100%!important;} }

.nba .rail{width:264px; flex:0 0 264px; background:var(--panel);
  border:1px solid var(--rule); padding:14px;}
.nba .rail h2{font-family:'IBM Plex Mono',monospace; font-size:10.5px; font-weight:600;
  text-transform:uppercase; letter-spacing:0.09em; color:var(--ink3);
  margin:0 0 10px; padding-bottom:6px; border-bottom:1px solid var(--rule);}
.nba .rail h2.sub{margin-top:20px;}
.nba .ctl{margin-bottom:13px;}
.nba .ctl label{display:flex; justify-content:space-between; align-items:baseline;
  font-size:12px; margin-bottom:5px; color:var(--ink2);}
.nba .ctl label b{font-family:'IBM Plex Mono',monospace; font-weight:600; color:var(--ink); font-size:12px;}
.nba .ctl input[type=range]{width:100%; accent-color:var(--signal); margin:0;}
.nba .hint{font-size:10.5px; color:var(--ink3); line-height:1.45; margin-top:3px;}

.nba .toggle{display:flex; gap:9px; align-items:flex-start; padding:8px 0;
  border-bottom:1px solid var(--rule); cursor:pointer;}
.nba .toggle:last-of-type{border-bottom:none;}
.nba .toggle input{margin-top:2px; accent-color:var(--guard); flex:0 0 auto;}
.nba .toggle span{font-size:12px; line-height:1.4;}
.nba .toggle small{display:block; color:var(--ink3); font-size:10.5px; margin-top:2px;}

.nba .main{flex:1; min-width:0;}
.nba .tabs{display:flex; gap:0; border-bottom:1px solid var(--rule); margin-bottom:0;}
.nba .tab{font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:0.05em;
  text-transform:uppercase; padding:9px 15px; background:none; border:none;
  border-bottom:2px solid transparent; color:var(--ink3); cursor:pointer; font-weight:500;}
.nba .tab[data-on="1"]{color:var(--ink); border-bottom-color:var(--signal); background:var(--panel);}

.nba .pane{background:var(--panel); border:1px solid var(--rule); border-top:none; padding:16px;}

.nba .strip{display:flex; flex-wrap:wrap; gap:1px; background:var(--rule);
  border:1px solid var(--rule); margin-bottom:16px;}
.nba .stat{flex:1 1 120px; background:var(--panel); padding:10px 12px;}
.nba .stat .k{font-family:'IBM Plex Mono',monospace; font-size:9.5px; text-transform:uppercase;
  letter-spacing:0.08em; color:var(--ink3);}
.nba .stat .v{font-family:'IBM Plex Mono',monospace; font-size:19px; font-weight:600; margin-top:3px;}

.nba .distrow{display:flex; align-items:center; gap:10px; margin-bottom:6px; font-size:12px;}
.nba .distrow .nm{flex:0 0 190px; color:var(--ink2);}
.nba .bar{flex:1; height:14px; background:var(--canvas); position:relative;}
.nba .bar i{display:block; height:100%; background:var(--signal);}
.nba .bar i[data-k="no_action"]{background:var(--hold);}
.nba .bar i[data-k="personalized_discount"]{background:var(--guard);}
.nba .bar i[data-k="homepage_module"]{background:#5B8FC7;}
.nba .distrow .n{flex:0 0 76px; text-align:right; font-family:'IBM Plex Mono',monospace; font-size:11.5px;}

.nba table{width:100%; border-collapse:collapse; font-size:12px;}
.nba thead th{font-family:'IBM Plex Mono',monospace; font-size:9.5px; text-transform:uppercase;
  letter-spacing:0.07em; color:var(--ink3); text-align:left; padding:7px 8px;
  border-bottom:1px solid var(--ink); font-weight:600;}
.nba tbody td{padding:7px 8px; border-bottom:1px solid var(--rule); vertical-align:top;}
.nba tbody tr.r{cursor:pointer;}
.nba tbody tr.r:hover{background:var(--signal-soft);}
.nba td.num{font-family:'IBM Plex Mono',monospace; text-align:right;}
.nba .pill{display:inline-block; font-family:'IBM Plex Mono',monospace; font-size:10px;
  padding:2px 6px; border:1px solid currentColor; white-space:nowrap;}
.nba .pill.act{color:var(--signal);}
.nba .pill.none{color:var(--hold);}
.nba .pill.hold{color:var(--ink3);}
.nba .pill.warn{color:var(--guard);}

.nba .trace{background:#F7F9FB; border-left:2px solid var(--signal); padding:12px 14px;}
.nba .trace h4{font-family:'IBM Plex Mono',monospace; font-size:9.5px; text-transform:uppercase;
  letter-spacing:0.08em; color:var(--ink3); margin:0 0 6px; font-weight:600;}
.nba .trace h4.sp{margin-top:14px;}
.nba .kv{display:flex; flex-wrap:wrap; gap:3px 16px; font-family:'IBM Plex Mono',monospace; font-size:11px;}
.nba .kv span{color:var(--ink2);}
.nba .kv span b{color:var(--ink); font-weight:600;}
.nba .term{font-family:'IBM Plex Mono',monospace; font-size:11px; color:var(--ink2);}
.nba .term em{font-style:normal; color:var(--ink3);}
.nba .cand{font-family:'IBM Plex Mono',monospace; font-size:11px; padding:3px 0;
  display:flex; gap:10px; border-bottom:1px dotted var(--rule);}
.nba .cand .cn{flex:1;}
.nba .cand.win{color:var(--pos); font-weight:600;}
.nba .supp{font-family:'IBM Plex Mono',monospace; font-size:11px; color:var(--guard);
  padding:3px 0; border-bottom:1px dotted var(--rule);}
.nba .supp s{color:var(--ink3);}
.nba .verdict{margin-top:12px; padding:9px 11px; background:var(--pos-soft);
  border-left:2px solid var(--pos); font-size:12px;}
.nba .verdict.q{background:var(--canvas); border-left-color:var(--hold);}

.nba .callout{border:1px solid var(--guard); background:var(--guard-soft);
  padding:13px 15px; margin:16px 0;}
.nba .callout h3{margin:0 0 6px; font-size:13px; color:var(--guard);}
.nba .callout p{margin:0; font-size:12.5px; line-height:1.55; color:var(--ink2);}

.nba .note{font-size:12.5px; line-height:1.6; color:var(--ink2); max-width:80ch;}
.nba .note b{color:var(--ink);}
.nba h3.sec{font-size:13px; margin:22px 0 8px; padding-bottom:5px; border-bottom:1px solid var(--rule);}
.nba ul.lim{margin:0; padding-left:18px; font-size:12.5px; line-height:1.65; color:var(--ink2); max-width:80ch;}
.nba ul.lim li{margin-bottom:5px;}
.nba ul.lim b{color:var(--ink);}

.nba .filters{display:flex; gap:6px; flex-wrap:wrap; margin-bottom:12px;}
.nba .fbtn{font-family:'IBM Plex Mono',monospace; font-size:10.5px; padding:4px 9px;
  border:1px solid var(--rule); background:var(--panel); color:var(--ink2); cursor:pointer;}
.nba .fbtn[data-on="1"]{border-color:var(--signal); color:var(--signal); background:var(--signal-soft);}

.nba .cmp{display:flex; flex-wrap:wrap; gap:1px; background:var(--rule); border:1px solid var(--rule);}
.nba .cmp>div{flex:1 1 240px; background:var(--panel); padding:13px 15px;}
.nba .cmp .lbl{font-family:'IBM Plex Mono',monospace; font-size:9.5px; text-transform:uppercase;
  letter-spacing:0.08em; color:var(--ink3); margin-bottom:5px;}
.nba .cmp .big{font-family:'IBM Plex Mono',monospace; font-size:26px; font-weight:600; line-height:1;}
.nba .cmp .big.bad{color:var(--guard);}
.nba .cmp .big.good{color:var(--pos);}
.nba .cmp .sub{font-size:11.5px; color:var(--ink2); margin-top:7px; line-height:1.5;}

@media (prefers-reduced-motion:reduce){ .nba *{transition:none!important; animation:none!important;} }
`;

const FILTERS = [
  ["all", "all rows"],
  ["regular", "over-contacted regulars"],
  ["drifting", "drifting shoppers"],
  ["outbound", "outbound action"],
  ["none", "no action"],
  ["suppressed", "contact limit hit"],
  ["holdout", "holdout arm"],
];

export default function DecisioningEngine() {
  const [cohortSize, setCohortSize] = useState(800);
  const [seed, setSeed] = useState(20260724);
  const [freqCap, setFreqCap] = useState(3);
  const [cooldownDays, setCooldownDays] = useState(5);
  const [confidenceFloor, setConfidenceFloor] = useState(0.15);
  const [holdoutPct, setHoldoutPct] = useState(0.2);
  const [priceLock, setPriceLock] = useState(true);
  const [tab, setTab] = useState("ledger");
  const [open, setOpen] = useState(null);
  const [filter, setFilter] = useState("all");

  const cfg = { freqCap, cooldownDays, confidenceFloor, holdoutPct, priceLock, seed, salt: "cg-v1" };

  const cohort = useMemo(() => buildCohort(cohortSize, seed), [cohortSize, seed]);

  const rows = useMemo(
    () =>
      cohort.map((c) => {
        const scored = scoreCustomer(c);
        const decision = decide(c, scored, cfg);
        return { customer: c, scored, decision };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cohort, freqCap, cooldownDays, confidenceFloor, priceLock]
  );

  const exp = useMemo(
    () => runExperiment(rows, cfg),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, holdoutPct, seed]
  );

  const dist = useMemo(() => {
    const m = {};
    rows.forEach((r) => {
      m[r.decision.chosen] = (m[r.decision.chosen] || 0) + 1;
    });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const CONTACT_RULES = ["FREQ_CAP", "COOLDOWN"];
  const suppressedCount = rows.filter((r) =>
    r.decision.suppressed.some((s) => CONTACT_RULES.includes(s.rule))
  ).length;
  const noActionCount = rows.filter((r) => r.decision.chosen === "no_action").length;
  const outboundCount = rows.filter((r) => {
    const a = ACTION_META[r.decision.chosen];
    return a && a.outbound;
  }).length;

  const view = exp.rows.filter((r) => {
    if (filter === "all") return true;
    if (filter === "regular")
      return (
        r.customer.freq90 >= 15 &&
        r.decision.suppressed.some((s) => s.rule === "FREQ_CAP" || s.rule === "COOLDOWN")
      );
    if (filter === "drifting")
      return r.customer.recencyDays >= 45 && r.customer.freq90 >= 4 && r.customer.freq90 <= 15;
    if (filter === "holdout") return r.arm === "holdout";
    if (filter === "none") return r.decision.chosen === "no_action";
    if (filter === "suppressed")
      return r.decision.suppressed.some((s) => CONTACT_RULES.includes(s.rule));
    if (filter === "outbound") {
      const a = ACTION_META[r.decision.chosen];
      return a && a.outbound;
    }
    return true;
  });

  return (
    <div className="nba">
      <style>{CSS}</style>

      <div className="hdr">
        <div className="eyebrow">Next-best-action decisioning · working prototype</div>
        <h1>When Not to Message a Good Customer</h1>
        <p>
          Our best customers are the most over-messaged, and the way this usually gets measured
          makes that look like success. This is a working sketch of a growth engine built the other
          way around: doing nothing is a real option with a real value, every message carries a cost
          on the books, and nothing counts as a win unless a holdout says the trip would not have
          happened anyway.
        </p>
        <div className="runmeta">
          <span className="mono">seed {seed}</span>
          <span className="mono">cohort n={cohortSize}</span>
          <span className="mono">assignment salt cg-v1</span>
          <span className="mono">synthetic data</span>
        </div>
      </div>

      <div className="shell">
        <aside className="rail">
          <h2>Run parameters</h2>
          <div className="ctl">
            <label>
              Cohort size <b>{cohortSize}</b>
            </label>
            <input
              type="range"
              min="200"
              max="2000"
              step="100"
              value={cohortSize}
              onChange={(e) => setCohortSize(+e.target.value)}
            />
          </div>
          <div className="ctl">
            <label>
              Seed <b>{seed}</b>
            </label>
            <input
              type="range"
              min="20260701"
              max="20260731"
              step="1"
              value={seed}
              onChange={(e) => setSeed(+e.target.value)}
            />
            <div className="hint">
              Cohort generation is seeded so a run is reproducible. Arm assignment is hashed from
              customer ID, not drawn from this RNG, so changing the seed does not reshuffle who sits
              in holdout.
            </div>
          </div>
          <div className="ctl">
            <label>
              Holdout share <b>{pct(holdoutPct, 0)}</b>
            </label>
            <input
              type="range"
              min="0.05"
              max="0.4"
              step="0.05"
              value={holdoutPct}
              onChange={(e) => setHoldoutPct(+e.target.value)}
            />
          </div>

          <h2 className="sub">Guardrails</h2>
          <div className="ctl">
            <label>
              Frequency cap / 30d <b>{freqCap}</b>
            </label>
            <input
              type="range"
              min="1"
              max="6"
              step="1"
              value={freqCap}
              onChange={(e) => setFreqCap(+e.target.value)}
            />
          </div>
          <div className="ctl">
            <label>
              Cooldown (days) <b>{cooldownDays}</b>
            </label>
            <input
              type="range"
              min="0"
              max="14"
              step="1"
              value={cooldownDays}
              onChange={(e) => setCooldownDays(+e.target.value)}
            />
          </div>
          <div className="ctl">
            <label>
              Confidence floor <b>{money(confidenceFloor)}</b>
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={confidenceFloor}
              onChange={(e) => setConfidenceFloor(+e.target.value)}
            />
            <div className="hint">
              Minimum net expected value required to contact anyone. Raise it and the engine gets
              quieter.
            </div>
          </div>

          <label className="toggle">
            <input
              type="checkbox"
              checked={priceLock}
              onChange={(e) => setPriceLock(e.target.checked)}
            />
            <span>
              Price-integrity lock
              <small>
                Personalization may vary relevance and timing, never price depth. Turn it off to see
                what the engine would do without it.
              </small>
            </span>
          </label>
        </aside>

        <main className="main">
          <div className="tabs">
            <button className="tab" data-on={tab === "ledger" ? "1" : "0"} onClick={() => setTab("ledger")}>
              Decision ledger
            </button>
            <button className="tab" data-on={tab === "exp" ? "1" : "0"} onClick={() => setTab("exp")}>
              Experiment readout
            </button>
            <button className="tab" data-on={tab === "card" ? "1" : "0"} onClick={() => setTab("card")}>
              Model card
            </button>
          </div>

          {tab === "ledger" && (
            <div className="pane">
              <div className="framing">
                <p>
                  <b>Two shoppers.</b> One comes in most weeks and scores high on every model, so
                  every team reaches her, and none of it changes anything because she was coming in
                  Thursday either way. The other used to shop weekly and now comes every third week,
                  which is exactly where a well-timed message would matter, except the contact budget
                  was already spent. Both are live filters below.
                </p>
              </div>

              <div className="strip">
                <div className="stat">
                  <div className="k">Outbound contacts</div>
                  <div className="v">{outboundCount}</div>
                </div>
                <div className="stat">
                  <div className="k">No action</div>
                  <div className="v">{noActionCount}</div>
                </div>
                <div className="stat">
                  <div className="k">Contact limit hit</div>
                  <div className="v">{suppressedCount}</div>
                </div>
                <div className="stat">
                  <div className="k">Contact rate</div>
                  <div className="v">{pct(outboundCount / cohortSize, 0)}</div>
                </div>
              </div>

              <h4
                className="mono"
                style={{
                  fontSize: 9.5,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "#7C8CA1",
                  margin: "0 0 8px",
                }}
              >
                Action distribution
              </h4>
              {dist.map(([k, n]) => (
                <div className="distrow" key={k}>
                  <div className="nm">{ACTION_META[k] ? ACTION_META[k].label : k}</div>
                  <div className="bar">
                    <i data-k={k} style={{ width: (n / cohortSize) * 100 + "%" }} />
                  </div>
                  <div className="n">
                    {n} · {pct(n / cohortSize, 0)}
                  </div>
                </div>
              ))}

              {!priceLock && (
                <div className="callout">
                  <h3>Price lock is off</h3>
                  <p>
                    Personalized discount depth is now in the candidate set, and it wins often,
                    because that arm tests better than anything else here. It always will. People
                    shop here so they do not have to work at it: no timing the purchase, no hunting
                    the coupon, no wondering whether the person behind them paid less for the same
                    thing. An engine maximizing near-term value will spend that promise steadily and
                    it will never appear on a readout. That is why it belongs in the constraint
                    layer and not in the objective function.
                  </p>
                </div>
              )}

              <h3 className="sec">Per-customer decisions</h3>
              <div className="filters">
                {FILTERS.map(([k, label]) => (
                  <button
                    key={k}
                    className="fbtn"
                    data-on={filter === k ? "1" : "0"}
                    onClick={() => {
                      setFilter(k);
                      setOpen(null);
                    }}
                  >
                    {label}
                  </button>
                ))}
                <span
                  className="mono"
                  style={{ fontSize: 10.5, color: "#7C8CA1", alignSelf: "center", marginLeft: 4 }}
                >
                  showing {Math.min(view.length, 25)} of {view.length}
                </span>
              </div>

              <table>
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Arm</th>
                    <th>Rec</th>
                    <th>Freq</th>
                    <th>W+</th>
                    <th>p(trip)</th>
                    <th>Decision</th>
                    <th style={{ textAlign: "right" }}>Net EV</th>
                  </tr>
                </thead>
                <tbody>
                  {view.slice(0, 25).map((r) => {
                    const isOpen = open === r.customer.idx;
                    const top = r.decision.candidates[0];
                    const chosenCand = r.decision.candidates.find(
                      (c) => c.key === r.decision.chosen
                    );
                    const hardSupp = r.decision.suppressed.filter((s) =>
                      CONTACT_RULES.includes(s.rule)
                    );
                    return (
                      <Fragment key={r.customer.idx}>
                        <tr
                          className="r"
                          onClick={() => setOpen(isOpen ? null : r.customer.idx)}
                        >
                          <td className="mono">{r.customer.id}</td>
                          <td>
                            <span className={"pill " + (r.arm === "holdout" ? "hold" : "act")}>
                              {r.arm}
                            </span>
                          </td>
                          <td className="num">{r.customer.recencyDays}d</td>
                          <td className="num">{r.customer.freq90}</td>
                          <td className="num">{r.customer.plusMember ? "yes" : "—"}</td>
                          <td className="num">{r.scored.scores.pNextTrip.toFixed(3)}</td>
                          <td>
                            <span
                              className={
                                "pill " +
                                (r.decision.chosen === "no_action"
                                  ? "none"
                                  : r.decision.chosen === "personalized_discount"
                                  ? "warn"
                                  : "act")
                              }
                            >
                              {ACTION_META[r.decision.chosen].label}
                            </span>
                            {hardSupp.length > 0 && (
                              <span
                                className="mono"
                                style={{ color: "#A8500B", fontSize: 10, marginLeft: 6 }}
                              >
                                {hardSupp.length} suppressed
                              </span>
                            )}
                          </td>
                          <td className="num">{chosenCand ? money(chosenCand.net) : "—"}</td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <td colSpan={8} style={{ padding: 0 }}>
                              <div className="trace">
                                <h4>1 · Signals</h4>
                                <div className="kv">
                                  <span>
                                    recency <b>{r.customer.recencyDays}d</b>
                                  </span>
                                  <span>
                                    freq_90d <b>{r.customer.freq90}</b>
                                  </span>
                                  <span>
                                    digital_share <b>{r.customer.digitalShare.toFixed(2)}</b>
                                  </span>
                                  <span>
                                    breadth <b>{r.customer.categoryBreadth}</b>
                                  </span>
                                  <span>
                                    basket_avg <b>${r.customer.basketAvg}</b>
                                  </span>
                                  <span>
                                    plus <b>{r.customer.plusMember ? "yes" : "no"}</b>
                                  </span>
                                  <span>
                                    benefit_util <b>{r.customer.benefitUtil.toFixed(2)}</b>
                                  </span>
                                  <span>
                                    contacts_30d <b>{r.customer.contactsLast30}</b>
                                  </span>
                                  <span>
                                    last_contact <b>{r.customer.lastActionDaysAgo}d</b>
                                  </span>
                                </div>

                                <h4 className="sp">2 · Scores and contributing terms</h4>
                                {Object.keys(r.scored.models).map((mk) => (
                                  <div key={mk} style={{ marginBottom: 5 }}>
                                    <div className="term">
                                      <b>{mk}</b> = {r.scored.scores[mk].toFixed(3)}{" "}
                                      <em>(z = {r.scored.models[mk].z.toFixed(2)})</em>
                                    </div>
                                    <div className="term" style={{ paddingLeft: 12 }}>
                                      {r.scored.models[mk].terms
                                        .map((t) => `${t[0]} ${t[1] >= 0 ? "+" : ""}${t[1].toFixed(2)}`)
                                        .join("  ")}
                                    </div>
                                  </div>
                                ))}

                                <h4 className="sp">3 · Candidate actions, ranked by net EV</h4>
                                {r.decision.candidates.length === 0 && (
                                  <div className="term">No candidates survived the guardrail layer.</div>
                                )}
                                {r.decision.candidates.map((c) => (
                                  <div
                                    className={"cand" + (c.key === r.decision.chosen ? " win" : "")}
                                    key={c.key}
                                  >
                                    <span className="cn">
                                      {c.key === r.decision.chosen ? "▸ " : "  "}
                                      {c.label}
                                    </span>
                                    <span>
                                      p={c.p.toFixed(3)} gross={money(c.gross)} net={money(c.net)}
                                    </span>
                                  </div>
                                ))}

                                {r.decision.suppressed.length > 0 && (
                                  <>
                                    <h4 className="sp">4 · Guardrail layer</h4>
                                    {r.decision.suppressed.map((s) => (
                                      <div className="supp" key={s.key}>
                                        <s>{s.label}</s> — [{s.rule}] {s.reason}
                                      </div>
                                    ))}
                                  </>
                                )}

                                <div
                                  className={
                                    "verdict" + (r.decision.chosen === "no_action" ? " q" : "")
                                  }
                                >
                                  <b>Decision:</b> {ACTION_META[r.decision.chosen].label} —{" "}
                                  {r.decision.reason}.{" "}
                                  {r.arm === "holdout" && (
                                    <>
                                      Customer is in the <b>holdout arm</b>, so the decision is
                                      computed and logged but not served. This is what makes the
                                      counterfactual measurable.
                                    </>
                                  )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {tab === "exp" && (
            <div className="pane">
              <div className="cmp">
                <div>
                  <div className="lbl">Naive read · acted vs not acted</div>
                  <div className="big bad">{pct(exp.naiveDiff)}</div>
                  <div className="sub">
                    {pct(exp.naiveActed)} of contacted customers converted ({exp.actedN}) versus{" "}
                    {pct(exp.naiveNot)} of customers the engine left alone ({exp.notActedN}). This
                    number is mostly targeting, not treatment: the engine deliberately contacted the
                    people already most likely to return.
                  </div>
                </div>
                <div>
                  <div className="lbl">Incremental read · treated vs holdout</div>
                  <div className="big good">{pct(exp.diff)}</div>
                  <div className="sub">
                    Treated {pct(exp.p1)} (n={exp.n1}) versus holdout {pct(exp.p0)} (n={exp.n0}).
                    Same population, randomized by hashed ID, so the difference is attributable to
                    the intervention rather than to who was chosen.
                  </div>
                </div>
              </div>

              <h3 className="sec">Confidence interval on the incremental effect</h3>
              <svg width="100%" height="86" viewBox="0 0 600 86" style={{ maxWidth: 600 }}>
                <line x1="30" y1="60" x2="570" y2="60" stroke="#D5DCE5" strokeWidth="1" />
                {(() => {
                  const lo = Math.min(exp.ciLo, -0.005);
                  const hi = Math.max(exp.ciHi, 0.005);
                  const span = hi - lo || 1;
                  const x = (v) => 30 + ((v - lo) / span) * 540;
                  return (
                    <g>
                      <line
                        x1={x(0)}
                        y1="20"
                        x2={x(0)}
                        y2="66"
                        stroke="#7C8CA1"
                        strokeWidth="1"
                        strokeDasharray="3 3"
                      />
                      <text x={x(0)} y="80" fontSize="10" fill="#7C8CA1" textAnchor="middle" fontFamily="IBM Plex Mono, monospace">
                        0
                      </text>
                      <line x1={x(exp.ciLo)} y1="38" x2={x(exp.ciHi)} y2="38" stroke="#15589E" strokeWidth="2" />
                      <line x1={x(exp.ciLo)} y1="30" x2={x(exp.ciLo)} y2="46" stroke="#15589E" strokeWidth="2" />
                      <line x1={x(exp.ciHi)} y1="30" x2={x(exp.ciHi)} y2="46" stroke="#15589E" strokeWidth="2" />
                      <circle cx={x(exp.diff)} cy="38" r="5" fill="#0B6E55" />
                      <text
                        x={x(exp.diff)}
                        y="16"
                        fontSize="11"
                        fill="#0B6E55"
                        textAnchor="middle"
                        fontFamily="IBM Plex Mono, monospace"
                        fontWeight="600"
                      >
                        {pct(exp.diff, 2)}
                      </text>
                    </g>
                  );
                })()}
              </svg>
              <div className="note" style={{ marginTop: 4 }}>
                95% CI: <b>{pct(exp.ciLo, 2)}</b> to <b>{pct(exp.ciHi, 2)}</b>. Standard error{" "}
                {pct(exp.se, 2)}.{" "}
                {exp.significant
                  ? "The interval excludes zero, so at this cohort size the effect is distinguishable from noise."
                  : "The interval spans zero. At this cohort size the result is not distinguishable from noise, and the honest answer is that we cannot yet call it."}
              </div>

              <h3 className="sec">Power</h3>
              <div className="note">
                Minimum detectable effect at 80% power, α=0.05, given the current split:{" "}
                <b>{pct(exp.mde, 2)}</b> absolute. The engine's modeled per-action lift is smaller
                than that at most cohort sizes in this range, which is the realistic condition: the
                honest constraint on lifecycle experimentation is usually holdout population, not
                idea supply. Raise cohort size or holdout share and watch the interval tighten.
              </div>

              <div className="callout" style={{ borderColor: "#15589E", background: "#E3ECF6" }}>
                <h3 style={{ color: "#15589E" }}>What the left number was hiding</h3>
                <p>
                  The gap between these two is the shopper who comes in most weeks. She converts,
                  she got contacted, and she lands in the numerator either way, so the naive read
                  counts her as a win the program earned. She was coming in Thursday. A team
                  reporting the left number keeps funding a program whose main activity is
                  re-contacting people already on their way in, and the contact budget it burns
                  doing that belongs to the customer who was drifting away quietly.
                </p>
              </div>
            </div>
          )}

          {tab === "card" && (
            <div className="pane">
              <div className="note">
                This is a reasoning artifact, not a proposal. The data is synthetic and the scoring
                functions are hand-specified rather than learned, so none of the numbers are claims
                about any real business. The question it is built to make discussable is a plain
                one: what does it take to run a growth engine that knows when to leave a good
                customer alone, and can show it left money on the table for the right reason.
              </div>

              <h3 className="sec">What this does not model</h3>
              <ul className="lim">
                <li>
                  <b>Learned coefficients.</b> Scores are hand-set logistic terms. A real system
                  would fit these, and the moment they are fit, drift monitoring and retraining
                  cadence become the actual product problem.
                </li>
                <li>
                  <b>Interference.</b> Customers are treated as independent. Households share carts,
                  and shared surfaces mean holdout customers can still see the effects of treatment.
                </li>
                <li>
                  <b>Long-run effects.</b> The outcome is a single 14-day return. Contact fatigue is
                  priced as a static cost rather than a state that accumulates and suppresses future
                  response.
                </li>
                <li>
                  <b>Multi-touch reality.</b> One decision per customer per cycle. Real orchestration
                  has to sequence across channels and resolve conflicts between teams competing for
                  the same customer's attention.
                </li>
                <li>
                  <b>Cannibalization.</b> Incremental trips are counted as incremental value. Some
                  share is pulled forward from a trip that would have happened next month anyway.
                </li>
              </ul>

              <h3 className="sec">Three tradeoffs worth arguing about</h3>
              <ul className="lim">
                <li>
                  <b>Net EV versus contact budget.</b> Ranking by net expected value is locally
                  correct and globally questionable, because the frequency cap is a shared resource
                  across every team that wants to message the same customer. Whoever computes EV
                  first wins the slot. That is an org design problem wearing a modeling costume.
                </li>
                <li>
                  <b>Owned surfaces versus outbound.</b> The homepage module wins constantly here
                  because its fatigue cost is near zero. That is probably right, and it also means
                  the highest-leverage growth work may be merchandising the surfaces people already
                  visit rather than adding sends.
                </li>
                <li>
                  <b>Where the loop actually closes.</b> Measured lift should feed back into scoring,
                  but the feedback path is the least honest part of most growth engines: response
                  data is generated by the targeting policy, so the model learns from a population it
                  selected. Without a permanent holdout the loop closes on itself.
                </li>
              </ul>

              <h3 className="sec">What a message costs</h3>
              <div className="note">
                Contact is priced here as a real cost, which is why no action wins as often as it
                does. Most growth systems carry that cost nowhere, so the engine has no reason to
                stay quiet and every reason to fill the slot. A frequency cap then becomes the only
                thing standing between a good customer and four messages in a week, and a cap is a
                blunt instrument compared to an engine that did not want to send in the first place.
                Low prices come out of low costs. A message is a cost.
              </div>

              <h3 className="sec">The price promise</h3>
              <div className="note">
                The price-integrity lock is the one guardrail that is not a performance knob. Toggle
                it off in the left rail and the discount arm takes a large share of decisions,
                because it tests better than anything else in the set, and it always will. What it
                spends is not brand equity in the abstract. It is the specific reason many of these
                customers shop here at all: that they do not have to time the purchase, hunt the
                coupon, or wonder whether someone else paid less for the same thing. Those
                conversions were largely available anyway, and the promise is worth more than they
                are. That makes it a constraint, not a weight to be tuned.
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
