# The Label

A garment analysis tool that reads product pages and tells you how much of the price is the brand name vs. the actual garment.

## Architecture

- **Frontend:** Single `index.html` — vanilla JS, no build step. Falls back to canned demo data when server is unavailable.
- **Backend:** Express server (`server.js`) + pipeline modules in `src/`.
- **Database:** SQLite via `better-sqlite3` at `data/thelabel.db`. Stores verdict cache (24h TTL), price observations, and fetch logs.
- **Cost model:** Deterministic arithmetic in `src/cost-model.js`, driven by lookup tables in `data/cost-model.json`. **The LLM never writes to this file.**

## Pipeline

```
URL → normalize → fetch (tier1/tier2) → extract (LLM) → cost model (arithmetic) → verdict → scorecard
```

## Critical Rules

1. **`null` means NOT LISTED.** The extraction model must never infer, estimate, or "reasonably assume" fiber content. If the page doesn't say it, `fibers` is `null`.
2. **Cost model is never an LLM.** `src/cost-model.js` is pure arithmetic on lookup tables.
3. **The amber segment is non-negotiable.** The cost bar always shows three segments: garment (green), fair margin/rent/returns (amber), name (red). Removing the amber segment to simplify is forbidden.
4. **Every scorecard row with a number must cite its source.** A number with no provenance turns the scorecard into an opinion.
5. **Confidence text is never cut.** It's the intellectual honesty and legal position.

## Commands

```sh
npm install
npm run dev    # start with --watch
npm test       # run test suite
```

## Environment

- `ANTHROPIC_API_KEY` — required for extraction calls
- `PORT` — server port (default 3000)
