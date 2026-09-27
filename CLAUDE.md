# CLAUDE.md

Context file for picking this project back up in a new session — read this first.
Human-readable too, but written so an AI assistant can reconstruct the state of the
project without re-deriving decisions that were already made and argued through.

## What this is

A local restaurant-coverage map app (Flask + Google Maps JS), being extended into an
MCP-tool-driven agent demo — a portfolio piece for FDE-style roles (applying AI/agents
to messy real-world business logic, not just pipelines). The core question the finished
version answers: "given a restaurant chain, a coverage radius, and an area, where are
the gaps, and where's the best new location in one of those gaps?"

## Current state

**Built and working:** the Flask app itself — search a restaurant chain by up to 3
ZIP codes (ZCTAs) within a US state (hover to preview, click to select, on a live
Census TIGERweb ZCTA layer), or by a freehand-drawn map area, plot locations + radius
circles, shade the uncovered area. Deployable to Vercel as-is (see README's "Deploying
to Vercel" section) — the app is structured for that (static assets in
`public/static/`, cache dir falls back to `/tmp` under `os.environ["VERCEL"]`,
`vercel.json` sets `maxDuration`).

**Designed but not built:** the MCP + agent layer itself (five tools — Coverage,
Traffic, Demographics, Sentiment, and a `rank_candidates` synthesis tool) and the LLM
anomaly-removal pipeline stage. See `MCP_TOOL_SCHEMAS.md` for the full tool contracts —
that doc is current and should be treated as the spec to implement against, not notes.

**Built but unprovisioned:** the Postgres/PostGIS data store's schema
(`migrations/schema.sql`) and connection layer (`db.py`) exist and are wired for
Vercel-serverless-appropriate use (short-lived connections, `DATABASE_URL`-only config,
degrades to "caching off" if unset), but no actual database has been created or tested
against yet — see Roadmap item 2.

**Resolved (was "in flux"):** how a search region gets selected. Original design was
"whole state or freehand polygon." That's now replaced with "state dropdown, then click
up to 3 ZIP codes on the map" for the state-based flow (freehand-draw is unchanged,
still a separate alternative) — driven by a real Places pagination limitation, see
Gotchas. `/api/search` (whole-state Text Search) is still in `app.py` but no longer
called from the browser UI; `/api/search-zips` is what the UI calls now.

## Session history (condensed, in order)

This is the closest thing to a chat backup that belongs in this file — a chronological
record of what happened and why, so nothing gets lost even though the raw conversation
isn't reproduced here. The Gotchas/Roadmap sections above organize the same information
by topic instead; read both if picking this up cold.

1. Built the initial Flask app: state-based search, coverage-gap shading via Turf.js,
   Google Places Text Search.
2. Added a "draw custom area" search mode. Hit and fixed two real bugs along the way:
   (a) `DrawingManager` init failure was silently breaking the search form's submit
   listener too, because init code ran in the wrong order — fixed by always wiring core
   listeners first and wrapping optional features in try/catch so one failing feature
   can't take down another. (b) Discovered Google's Drawing library is deprecated;
   rebuilt drawing as manual click-to-place-vertices instead of `DrawingManager`.
3. Diagnosed a Text Search pagination bug (results silently capped ~20) — root cause is
   Google's Text Search not reliably paginating for broad chain-enumeration queries, not
   a bug in the retry logic. This became the motivating reason for moving to ZIP-code
   region selection later (step 7).
4. Explored "how does MCP/AI help here beyond plain scripting" — landed on MCP as
   connective tissue for *adaptive* tool orchestration, not the intelligence itself.
5. Produced architecture diagrams: an overview (agent + MCP tools), per-tool internal
   request-flow diagrams, and a combined diagram showing the existing Flask app and the
   proposed MCP layer sharing core logic.
6. Wrote `MCP_TOOL_SCHEMAS.md` — full input/output schemas for the MCP tools, including
   the `SearchRegion` / `GeoArea` type split.
7. Redesigned region selection from "state or freehand polygon" to "state + up to 3 ZIP
   codes," directly tied to the pagination finding in step 3.
8. Set up git (`.gitignore`, `config.py.example`); discovered this sandbox can't run
   `git commit`/`push` against the mounted folder, established the
   user-runs-git-locally workflow.
9. Created this file as project memory.
10. Made the app Vercel-deployable: fixed a crash-on-import risk (cache dir on a
    read-only filesystem), moved static assets to `public/static/`, added
    `vercel.json`, split the browser Maps key from the server-side Places key.
11. Discussed a project name — "Whitespace" was the recommendation, not yet finalized.
12. Expanded scope substantially: added a Postgres/PostGIS data store, an LLM
    anomaly-removal stage, a Sentiment MCP tool, and a `rank_candidates` synthesis tool
    — after researching and ruling out Yelp (160-character review cap on any plan) and
    Reddit (self-serve API registration closed) as sentiment sources.
13. Produced a full-system diagram categorizing every component by agent / external-API
    / LLM usage, drafted resume-style summary bullets, and formalized the 9-item
    roadmap as tracked tasks (task-tracker state is session-local, not durable — this
    file's Roadmap section is the durable copy of that list).

## Architecture

**One entry point: the browser UI**, deployed as a single app on Vercel. There is no
separate chat product/surface — an earlier version of this doc described "two entry
points" (browser UI + a standalone chat interface), which was corrected: the agent
lives *inside* the same browser app, as an embedded assistant panel, not a second
destination.

- **Search form** (existing, working) → Flask routes → `app.py` / `geo_utils.py`.
- **Embedded assistant panel** (designed, not built) → a backend route on the same
  Vercel deployment (e.g. `/api/agent`) → a Claude agent running server-side → the same
  5 MCP tools. Reached via an in-page chat-style panel, not a separate application.
  - **Coverage MCP** wraps the *same* `app.py` / `geo_utils.py` logic as the Flask
    routes — not a reimplementation. This is the intentional "two front doors, one
    brain" design point — both doors are in the same browser tab now, not two products.
  - **Traffic MCP** — new code, state DOT AADT data. No shared logic with the Flask app.
  - **Demographics MCP** — new code, Census ACS data. No shared logic with the Flask app.
  - **Sentiment MCP** — new code, Google Places reviews (not Yelp/Reddit — see Gotchas).
  - **`rank_candidates`** — not a data-source tool, a synthesis tool: takes the other
    three tools' per-candidate outputs and computes a confidence score deterministically
    (LLM only writes the rationale, doesn't invent the number — see Gotchas).

All MCP tools return JSON-RPC results synchronously to the agent, which decides whether
to call another tool or answer — that conditional tool selection (not a fixed pipeline)
is the actual thing worth demoing, per the original framing of this project.

Underneath all of it: a **Postgres + PostGIS data store** (Vercel-integrated Neon or
Supabase — file-based storage doesn't work here, Vercel serverless has no persistent
disk) plus an **LLM anomaly-removal pass** sitting between raw API responses and
anything stored or handed to the agent (closed businesses still listed, duplicate
listings, stale traffic readings — see `MCP_TOOL_SCHEMAS.md`'s "Data store and the
anomaly-removal step" section for the full reasoning). The data store's schema
(`migrations/schema.sql`) and connection layer (`db.py`) are built but not yet
provisioned/tested against a live database — see Roadmap item 2. The anomaly-removal
pass itself is not built yet.

## Gotchas / decisions future sessions shouldn't re-litigate

- **No `shapely` dependency.** All polygon math (point-in-polygon, tiling a drawn area
  into search circles) is hand-rolled in `geo_utils.py` on purpose, to keep
  `pip install -r requirements.txt` simple for a non-engineer-friendly local app. Don't
  reach for shapely without a reason stronger than convenience.
- **Google Places Text Search silently caps around 20 results** for broad
  "restaurant in state" queries — it's not a pagination bug, Google's Text Search just
  doesn't reliably paginate deep for chain-enumeration-style queries, even when a
  `next_page_token` retry-with-backoff is implemented correctly (it is, in
  `google_places_paginated`). This is *why* region selection is moving to ZIP-code
  granularity: a single ZIP rarely has enough locations of one chain to hit the page-1
  ceiling, so the truncation can't recur. Don't try to "fix" this with more retries.
- **Google Maps' Drawing library is deprecated** (announced Aug 2025, unavailable as of
  May 2026). The freehand-draw feature in `app.js` (`startDrawing` / `finishDrawing`) is
  a hand-rolled click-to-place-vertices implementation for this reason — there is no
  `google.maps.drawing` to fall back to. Any new draw-on-map feature (e.g. the ZCTA
  hover/click selector) needs the same manual-click-listener pattern, not
  `DrawingManager`.
- **Coverage gap math is currently browser-only** (Turf.js in `app.js`). It does not
  exist server-side. Building Coverage MCP requires porting the circle-union +
  polygon-difference logic to Python — this is real work, not a thin wrapper, despite
  Coverage MCP otherwise being "just" a wrapper around existing search logic.
- **This sandbox cannot run `git commit`/`git push`** against this project folder — the
  mount blocks file deletion/overwrite, which breaks git's lock-file handling. Git setup
  (`.gitignore`, `.env.example`) is done; `git init/add/commit/push` need to be run
  by the user locally, not by Claude in this environment. Don't retry this from a
  sandboxed bash tool in a future session without checking whether that restriction
  still applies.
- **All secrets come from environment variables; `.env` holds the real local keys and
  is gitignored on purpose.** `app.py` calls `load_dotenv()` at import (no-op on Vercel,
  never overrides real env vars). `.env.example` is the tracked placeholder template.
  Never remove `.env` from `.gitignore`, never commit it. On Vercel, keys are set in
  Project Settings -> Environment Variables. The old `config.py` file was retired
  (2026-09-26) - don't reintroduce a config-file fallback for secrets.
- **Two Google API keys, not one, once deployed publicly.** `get_api_key()` is the
  browser-embedded Maps JS key (needs an HTTP referrer restriction to the live domain);
  `get_places_api_key()` is the server-side key used for actual Places searches (falls
  back to the same value as `get_api_key()` if `GOOGLE_PLACES_API_KEY` isn't set).
  Google Cloud only allows one restriction type per key, so a single shared key can't be
  both referrer-restricted and reliably used server-side — see README's Vercel section.
  Locally on `127.0.0.1` this distinction barely matters; it matters a lot once public.
- **Static assets live only in `public/static/`** (`app.py`'s `static_folder`). The old
  top-level `static/` duplicate was deleted 2026-09-26 - don't recreate it.
- **Yelp and Reddit were considered and rejected as review/sentiment sources.** Yelp's
  Reviews API caps at 3 excerpts of 160 characters each, on paid plans only — no bulk
  full-text access exists at any tier, and scraping around it violates their ToS.
  Reddit closed self-serve API registration in late 2025 (manual approval queue now,
  real chance of silent rejection) and would additionally require deleting stored post
  content within 48 hours of user/mod deletion. Explicit decision: skip both, use
  Google Places reviews instead (already have API access, up to 5 full-text reviews per
  business via Place Details). Don't re-propose Yelp/Reddit without new information that
  changes these constraints.
- **There is only one entry point: the browser UI, hosted on Vercel.** Earlier drafts of
  this doc and its diagrams described a separate "chat interface" as a second product
  alongside the browser app — the user explicitly corrected this. The agent/MCP layer
  must be reachable from *within* the same Vercel-hosted browser app (an embedded
  assistant panel calling a backend route), not a standalone chat surface. Don't
  reintroduce "two entry points" framing in docs or diagrams.
- **`confidence_score` (in `rank_candidates`) must be computed, not LLM-generated.**
  Self-reported LLM confidence is uncalibrated. The score is a deterministic function of
  data completeness + source agreement + recency; the LLM only writes the prose
  rationale from those already-computed numbers. See `MCP_TOOL_SCHEMAS.md` tool 5 for
  the exact breakdown. Don't simplify this to "ask the model for a number" later.

## Roadmap (in the order it's been discussed)

1. ~~**Zip-code region selector**~~ — **built.** State dropdown, then hover-to-preview /
   click-to-select up to 3 ZCTAs on the map (max 3, tied directly to the Places
   pagination cap — see Gotchas and `MCP_TOOL_SCHEMAS.md`'s `SearchRegion` type).
   Backend: `fetch_state_zctas()` queries TIGERweb layer 4
   (`PUMA_TAD_TAZ_UGA_ZCTA/MapServer/4`) — this layer has no state field, so it's a
   spatial "intersects" POST query against the state's own boundary polygon (already
   fetched by `fetch_state_boundary()`), not a WHERE clause like the state layer uses.
   Cached to disk the same way as state boundaries (`ZCTA_CACHE_DIR`,
   `ZCTA_CACHE_ENABLED`). `/api/search-zips` searches each selected ZIP independently by
   reusing the drawn-area search's tiling/point-in-polygon logic (`generate_tile_centers`
   + `point_in_polygon`) against that ZIP's own polygon instead of a hand-drawn one —
   almost always a single tile per ZIP, since ZCTAs are small. Frontend: `onStateChange()`
   loads and renders the ZCTA layer as a `google.maps.Data` overlay with hover/click
   handlers; `searchZips()` unions the selected ZCTAs' geometry client-side (Turf) as the
   region to shade coverage against, per `MCP_TOOL_SCHEMAS.md`'s note that the searched
   area is the union of selected ZCTAs, not the whole state. Verified offline (this
   sandbox can't reach TIGERweb or Google APIs) via a fake-`flask`-module shim exercising
   the route handlers directly — real network behavior still needs confirming by running
   it locally.
2. ~~**Postgres + PostGIS data store**~~ — **schema + connection layer built, not yet
   provisioned or tested against a live database.** `migrations/schema.sql` defines 5
   tables: `restaurant_locations` (Coverage MCP cache, with `is_closed` /
   `duplicate_of_place_id` columns the anomaly-removal pass writes to),
   `traffic_stations` (Traffic MCP), `census_tracts` (Demographics MCP),
   `sentiment_samples` (Sentiment MCP), and `anomaly_log` (the reasoning trail behind
   every anomaly-removal flag - see MCP_TOOL_SCHEMAS.md's "Data store and the
   anomaly-removal step"). `db.py` is the connection layer: `DATABASE_URL` env var only
   (optional infra like the other env-var settings - "unset" means
   caching is off, not a broken app), `DB_ENABLED` flag follows the same
   degrade-gracefully pattern as `CACHE_ENABLED`, short-lived connections per call rather
   than a pooled connection (matches how Vercel serverless actually invokes functions -
   use the provider's own pooled connection string if volume ever needs it, don't add
   pooling logic here). Table-specific read/write helpers (upsert, cached-lookup, etc.)
   deliberately aren't written yet - they belong with each MCP tool below, once that
   tool's real query patterns are known. **What's NOT done:** an actual Neon/Supabase
   database has not been provisioned (that's an account-creation step Claude can't do on
   your behalf) and the schema has never been run against a live Postgres - do that via
   README's "Data store" section, then sanity-check `migrations/schema.sql` actually
   applies cleanly before building against it.
3. **LLM anomaly-removal pass** — a cleaning stage between raw API responses and
   anything stored (closed-but-listed businesses, duplicate listings, stale traffic
   readings). Sits in front of whichever tool below is built first.
4. **Coverage MCP** — lowest risk, wraps existing logic, but needs the server-side gap
   math port mentioned above.
5. **Traffic MCP** — higher risk: ~50 different state DOT endpoints, inconsistent
   schemas, needs a per-state adapter registry, not one hardcoded URL.
6. **Demographics MCP** — lowest risk of the three data-source tools: one stable federal
   API (Census ACS), same point-in-polygon join technique already in `geo_utils.py`,
   just against Census tract boundaries instead of a user-drawn shape.
7. **Sentiment MCP** — Google Places reviews only (see Gotchas on why not Yelp/Reddit).
8. **`rank_candidates`** — the deterministic scoring + top-3 synthesis tool. Needs all
   four tools above to exist first, since it consumes their combined output.
9. **Agent orchestration loop** on top of everything above — built as an embedded
   assistant panel *inside* the same Vercel-hosted browser app (a backend route calling
   the Claude API + the MCP tools), not a separate chat product. See Gotchas.

## Related docs in this repo

- `README.md` — end-user setup/run instructions for the Flask app as it exists today,
  including the "Data store" section for provisioning Postgres+PostGIS.
- `MCP_TOOL_SCHEMAS.md` — full input/output JSON Schema for all five planned MCP tools,
  the `SearchRegion` / `GeoArea` type split, and the data store / anomaly-removal design.
  Treat as current spec.
- `migrations/schema.sql` — the data store's DDL (5 tables, see Roadmap item 2). Written
  by hand, never run against a live database yet — sanity-check it applies cleanly before
  building the MCP tools against it.
- `db.py` — the data store's connection layer (`DATABASE_URL`, `DB_ENABLED`,
  `get_connection()`/`fetch_all()`/`execute()`). Not imported by `app.py` — only the
  future MCP tools depend on it.

## Git workflow

Run these locally (not through Claude in this sandbox — see Gotchas):

```
git init
git add -A
git status              # confirm .env is NOT listed
git commit -m "..."
git remote add origin https://github.com/<you>/<repo-name>.git
git branch -M main
git push -u origin main
```

Push auth uses whatever's already configured on your machine (GitHub Desktop,
`gh auth login`, SSH key, credential manager) — never hand an API key or OAuth token to
Claude directly for this.
