# When Not to Message a Good Customer

A working prototype of a next-best-action decisioning engine for retail customer growth.

**[Live demo →](https://ianklassen.github.io/customer-growth-decisioning/)**

---

## The problem it was built around

In most lifecycle systems, the best customers end up the most over-messaged. A shopper who comes in most weeks scores high on every model a growth team builds, so every team that wants to reach a customer reaches her. She converts, she was going to convert anyway, and the reporting counts it as a win.

Meanwhile the shopper who used to come weekly and now comes every third week is the one where a well-timed message would actually change something. Contact budget is finite. It was already spent.

The engine here is built the other way around:

1. **Doing nothing is a first-class option** with a real value, not a fallback
2. **Contact is priced as a cost**, so the engine has a reason to stay quiet
3. **Nothing counts as a win** unless a holdout says the trip would not have happened anyway

## What it does

Five layers, each one deliberately inspectable:

| Layer | What happens |
|---|---|
| Signals | Synthetic cohort with recency, frequency, channel mix, category breadth, membership state, contact history |
| Scoring | Four transparent logistic propensities: return, category expansion, churn risk, membership conversion |
| Decisioning | Candidate actions ranked by net expected value, where net = expected value minus contact cost |
| Guardrails | Frequency cap, cooldown, eligibility, confidence floor, and a price-integrity constraint |
| Experiment | Hash-assigned holdout, incremental lift with a 95% interval, and minimum detectable effect |

Open any row in the decision ledger and you get the full trace: raw signals, each score broken into its contributing terms, every candidate ranked, every action a guardrail removed and which rule removed it, then the decision.

## Two things worth clicking

**The price-integrity lock**, in the left rail. Turn it off and personalized discount depth enters the candidate set and starts winning, because it tests better than anything else in the action space. It always will. That is the argument for keeping price in the constraint layer rather than the objective function.

**The experiment tab.** Two numbers side by side. The naive read compares customers who were contacted to customers who were not, and is inflated almost entirely by targeting. The incremental read compares treated to holdout. The gap between them is the measurement error that keeps unproductive lifecycle programs funded.

## Honest limitations

The data is synthetic and the scoring coefficients are hand-specified rather than learned, so none of the numbers are claims about any real business. It does not model interference between customers, long-run contact fatigue as an accumulating state, multi-touch sequencing, or pull-forward cannibalization of trips. The Model Card tab in the app covers this in more detail, along with three tradeoffs the design does not resolve.

At default settings the incremental effect usually falls inside the noise band, and the minimum detectable effect is larger than the modeled lift. That is not a bug. It is the ordinary condition of lifecycle experimentation, where the binding constraint is holdout population rather than idea supply.

## Running it locally

```bash
npm install
npm run dev
```

Requires Node 18+. Build with `npm run build`.

## Stack

React 18, Vite, no component library. All styling is hand-written CSS. The only runtime dependencies are React and ReactDOM.

---

Built by [Ian Klassen](https://github.com/ianklassen) as a thinking artifact for reasoning about growth decisioning systems.
