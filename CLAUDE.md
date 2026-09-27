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

**Built and working:** the Flask app itself — search a restaurant chain by up to 10
ZIP codes (ZCTAs) within a US state (hover to preview, click to select; ZIP outlines
load for the visible map area from the `zctas` table), or by a freehand-drawn map area, plot locations + radius
circles, shade the uncovered area. Deployable to Vercel as-is (see README's "Deploying
to Vercel" section) — the app is structured for that (static assets in
`public/static/`, cache dir falls back to `/tmp` under `os.environ["VERCEL"]`,
`vercel.json` sets `maxDuration`). Live at https://whitespace-lyart-zeta.vercel.app.
**Deployed 2026-09-27** (branch `fix-large-state-zips` fast-forward merged into `main`,
`16b1f25`): ZIP selector/search rebuilt on the `zctas` table (large states work), nearest-
first fitted-circle searches, loading indicator, clearer coverage map, up to 10 ZIPs.
Verified live: map loads, `/api/zctas` served from the database in ~0.2 s.

**Designed but not built:** the MCP + agent layer itself (five tools — Coverage,
Traffic, Demographics, Sentiment, and a `rank_candidates` synthesis tool) and the LLM
anomaly-removal pipeline stage. See `MCP_TOOL_SCHEMAS.md` for the full tool contracts —
that doc is current and should be treated as the spec to implement against, not notes.

**Provisioned:** the Postgres/PostGIS data store (Neon, via Vercel's Storage
integration; PostgreSQL 18, PostGIS 3.6). Schema (`migrations/schema.sql`, applied with
`migrations/apply.py`) and connection layer (`db.py`) are live; only the `zctas` table has
data so far (all 33,791 ZCTAs, ~111 MB; whole DB ~127 MB of the 0.5 GB free tier). Other
tables are empty until their MCP tools are built - see Roadmap item 2.

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
14. (2026-09-26/27) Moved secrets from `config.py` to `.env` + `python-dotenv`; set up
    Python 3.12 `.venv`; deleted dead `static/`; user pushed to GitHub
    (`saurin129/whitespace`) and deployed to Vercel
    (https://whitespace-lyart-zeta.vercel.app). Split into two Google keys (browser key
    referrer-restricted to the Vercel domain + Maps JS only; server `GOOGLE_PLACES_API_KEY`
    Places-only) after the referrer restriction broke server-side searches.
15. Frontend: state selection now zooms immediately from a `data-bbox` on each
    `<option>` (no longer waits on ZCTA + boundary fetches); added a "Reset" map
    control (`resetResults()` in `app.js`) - per user, it clears only search results
    (markers, circles, shading, list) and keeps state, loaded ZIPs, selected ZIPs,
    drawn area and map view. Stale ZCTA
    responses are dropped via a `stateLoadId` counter.
16. Diagnosed the large-state ZIP bug (see Gotchas) and decided to back ZCTAs with the
    database + viewport-based loading (see Roadmap item 2). Sized the whole data store
    against Neon's free tier (see Gotchas: "Data store storage budget").
17. Provisioned Neon, applied the schema (added `zctas`, split `census_tracts`),
    imported all ZCTAs, and rebuilt the ZIP selector/search on top (viewport loading,
    by-code search, multi-part ZIP support, per-ZIP tile cap). Removed the old
    `data/zcta_cache/` disk cache.
18. Browser-tested with Playwright (headless Chromium) and fixed what it found; Reset now
    clears only search results; only the selected state's ZIPs load, cached per state in
    the browser; default radius 2 mi; search loading indicator (button spinner + elapsed
    seconds, map progress bar). Rebuilt ZIP search as nearest-first fitted circles in
    parallel (see Gotchas: Places `radius` is only a preference).

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
- **Git: Claude can commit and push when the user asks** (verified 2026-09-27, running
  directly on the user's Mac). An earlier sandboxed environment couldn't (mount blocked
  git's lock files) - that no longer applies. No git identity is configured on the
  machine; commits pass `-c user.name="Saurin" -c user.email="saurin129@gmail.com"`
  per commit rather than changing git config. Work goes on a branch; merging to `main`
  triggers a Vercel production deploy (branch pushes get preview deploys).
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
- **The map only loads on the production URL (and 127.0.0.1:5001).** The browser key is
  referrer-restricted to `whitespace-lyart-zeta.vercel.app`; Vercel's per-deployment and
  branch-preview URLs get Google's "Oops! Something went wrong" map error
  (`RefererNotAllowedMapError`). Expected, not a bug - test on the production URL or
  locally. Don't add a `*.vercel.app` wildcard to the key (any Vercel site could use it).
- **Static assets live only in `public/static/`** (`app.py`'s `static_folder`). The old
  top-level `static/` duplicate was deleted 2026-09-26 - don't recreate it.
- **Whole-state ZCTA loading doesn't work for large states - don't go back to it.**
  `fetch_state_zctas()` POSTs the full state outline as the TIGERweb spatial filter; for
  big states (CA 257 KB, TX 1.3 MB of geometry) the Census WAF returns an HTML
  "Request Rejected" page, which the code swallows as `"source": "unavailable"` / empty
  features. `/api/search-zips` calls the same function, so ZIP *search* also fails in
  those states. Even if the request went through, a whole state's ZCTAs are far too big
  to ship (RI's 108 ZIPs = 1.7 MB; CA ~2,000 ZIPs ~30 MB; Vercel caps function responses
  at ~4.5 MB). Decided fix: (1) load ZCTAs for the **visible map viewport** only, above a
  minimum zoom ("zoom in to see ZIP codes" below it), refetching on pan; (2) search
  fetches only the 1-3 selected ZIPs **by code**; (3) source both from a `zctas` table in
  Postgres, with a small **envelope (bbox)** TIGERweb query as the fallback when
  `DATABASE_URL` is unset - never the full state polygon. Only the selected state's ZIPs
  are returned from the DB (per user, 2026-09-27: near borders neighbours were most of the
  payload - RI 743 ZIPs/266 KB -> 81/33 KB; same query time). The TIGERweb fallback can't
  filter by state, so it still returns neighbours; the frontend's `selectable` handling
  (faint, unclickable) exists for that case. Search stays scoped to the selected state.
  **Implemented 2026-09-27** (`fetch_zctas_in_bbox`, `fetch_zcta_polygons`,
  `tile_zcta_parts` in `app.py`; `loadVisibleZips` in `app.js`, `MIN_ZIP_ZOOM = 9`).
  Measured locally: dense viewports (NYC, LA at max 8-degree span) <1 MB, ~0.5 s;
  viewport responses capped at 1,500 ZIPs, keeping those nearest the view center.
  Browser-side, `zipCache` keeps each state's Data layer + loaded ZIPs + already-fetched
  viewports for the session; switching states hides/shows layers, and a view is only
  re-requested if no earlier fetch covered it at <=2x its span (`MAX_REUSE_SPAN_RATIO`).
  Reset (`resetResults`) never touches ZIPs. Default radius is 2 miles. Multi-part ZIPs are searched per part, with near-duplicate tiles
  dropped and a 25-tile (= 25 billed Places calls) cap per ZIP - Alaska island ZIP 99574
  would otherwise cost 52 calls.
- **Coverage rendering (2026-09-27):** radius circles are outline-only; the covered area
  is filled once as `turf.intersect(region, union of circles)` (`coveredLayer`), the
  uncovered as `turf.difference` - per-circle fills stacked into opaque green in dense
  areas. Colours in `COVERED`/`UNCOVERED` in `app.js`: covered is **purple**, not covered
  **orange** (user's choice - green blended into Google's parks); legend swatches in
  `style.css` match. Circles and coverage layers are `clickable: false` so
  ZIPs underneath stay hoverable/clickable after a search; selected-ZIP fill fades to an
  outline while coverage is shown. A cursor-following ZIP label (`#zip-hover-label`,
  `updateZipHoverLabel()`) shows the ZIP and whether a click selects/removes it.
- **ZIP areas don't cover unpopulated land - not a bug.** ZCTAs are built from census
  blocks with residential addresses, so federal/military/empty land has no ZIP area:
  56% of Nevada (e.g. Sugar Bunker in the Nevada National Security Site, the Nellis
  range) - confirmed against the Census TIGERweb server too. Users searching there should
  use Draw search area.
- **ZIP selection limit is 10 (user request, 2026-09-27), warning above 5.**
  `MAX_SELECTED_ZIPS` / `ZIP_WARNING_THRESHOLD` in `app.js`, `MAX_ZIPS_PER_SEARCH` in
  `app.py`. The original max of 3 was tied to the old whole-area Places truncation, which
  per-ZIP fitted circles removed. Big rural ZIPs can need up to 25 circles each, so one
  search is capped at `MAX_CIRCLES_PER_SEARCH = 60` (sets `any_zip_truncated`) to bound
  cost and stay under Vercel's 60 s. `MCP_TOOL_SCHEMAS.md`'s `SearchRegion` still says
  maxItems 3 - revisit when building Coverage MCP.
- **ZIP outlines must be hidden while drawing a search area.** The ZIP `Data` layer sits
  above the map and swallows clicks, so draw-mode clicks selected ZIPs instead of placing
  vertices (found in Playwright with real mouse clicks: 1 of 4 points placed, 3 ZIPs
  selected). `startDrawing()` calls `suspendZipLayer()` and locks the state dropdown;
  `clearDrawnPolygon()` calls `resumeZipLayer()`. Keep this if adding other map-click
  features.
- **Places Nearby Search: `radius` is only a preference when a `keyword` is given.**
  Measured 2026-09-27: a 1.4-mile circle in Westwood returned 60 Chipotles out to 18 miles
  (2 inside the circle), so every search paged through all 3 pages with a ~2s wait before
  pages 2 and 3. ZIP search therefore uses `google_places_nearest()` (`rankby=distance`,
  nearest-first) on circles fitted to each ZIP (`fit_search_circles()`: usually 1 circle
  of 0.5-3 mi in cities; parts grouped into <=25-mile circles; grid of 25-mile circles for
  huge rural ZIPs), and `google_places_paginated(stop_after=...)` stops at the first page
  that reaches past the circle. All circles for all selected ZIPs run in parallel
  (`ThreadPoolExecutor`, max 6). `any_zip_truncated` now also means Google's 60-result cap
  was hit inside a circle. Measured: LA 2-ZIP Chipotle 10.6 s -> 0.5 s; Midtown 10001
  Starbucks 5.6 s -> 2.9 s and 18 in-ZIP results vs 17 (old way missed one). The
  drawn-area search (`/api/search-area`) uses the same `fit_search_circles()` +
  `search_circles()` path (drawn shape = one part); measured on a ~10-mile Westside
  area (Chipotle): 5.2 s -> 0.4 s, same 9 results. The radius-based
  `google_places_nearby_search()` is gone; only the unused whole-state `/api/search` still
  uses Text Search.
- **ZCTA data = Census cartographic boundary file, bulk-loaded once.** Use
  `https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_zcta520_500k.zip`
  (67 MB zipped; 33,791 ZCTAs, 5.95M vertices; 111 MB in PostGIS as loaded). Loaded by
  `scripts/import_zctas.py` (needs `requirements-dev.txt` for pyshp; ~1 min). It assigns
  `state_codes` via the matching `cb_2020_us_state_500k` file (primary state by point-on-
  surface, plus any state with >=1% of the ZIP's area; 118 ZIPs span 2 states), then
  `VACUUM FULL`s - without that the post-UPDATE table sits at ~2x (199 MB measured).
  ZCTAs only change each decennial census, so a one-time import beats lazy
  cache-on-miss; no refresh job needed until ~2030. The 500k generalization is plenty
  for click/hover selection; simplify further on import only if storage gets tight.
- **Data store storage budget (Neon free tier, 0.5 GB).** Estimates: `zctas` ~100 MB,
  `census_tracts` ~100 MB per nationwide load (tract file is 62 MB zipped),
  `traffic_stations` ~100-250 MB if all 50 states (rough), a few MB per state;
  `sentiment_samples` ~5 KB/business and grows; `restaurant_locations` and
  `anomaly_log` small. Realistic demo ~220-300 MB fits; "everything nationwide + growth"
  would not. Rules to stay under it, apply as each tool is built:
  (a) **Traffic data loads per state on first request**, never a nationwide backfill.
  (b) **Tract geometry is stored once, separate from ACS values** (done 2026-09-27):
  `census_tracts` (geometry, PK `geoid`) + `census_tract_acs` (values, PK
  `(geoid, vintage_year)`). Don't fold them back together - that stores every tract
  polygon again per ACS vintage (~100 MB each).
  (c) **Expire cached Google data** (see next item).
  (d) Simplify polygons on import if needed. Upgrading to Neon's paid usage-based plan
  is an acceptable escape hatch, not a failure.
- **Google Maps Platform terms limit what can be stored from Places.** As understood
  (verify against current terms before building): place IDs may be stored
  indefinitely, lat/lng cached up to 30 days, other Places content (names, addresses,
  ratings, review text) not meant for long-term storage. Affects `restaurant_locations`
  and `sentiment_samples` regardless of storage size: design them around place IDs +
  TTL/refresh, not permanent copies.
- **Testing: local by default, not the live Vercel site** (user preference, to conserve
  Vercel Hobby usage). Run `.venv` + `python app.py` (127.0.0.1:5001) or the Flask test
  client; check Vercel-only limits (e.g. ~4.5 MB response cap) by measuring locally.
  Keep Google Places calls minimal anywhere - they bill the user's Google Cloud account;
  Census TIGERweb calls are free. One post-deploy Vercel check at the end, with the
  user's OK.
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
   Backend (rebuilt 2026-09-27, see Gotchas): `/api/zctas?state=&bbox=` returns ZIPs in
   the visible viewport from the `zctas` table (TIGERweb envelope query as no-DB
   fallback), only the chosen state's ZIPs (DB path); the old
   whole-state `fetch_state_zctas()` and its disk cache are gone. `/api/search-zips`
   looks up just the selected ZIPs by code and searches each independently by
   reusing the drawn-area search's tiling/point-in-polygon logic (`generate_tile_centers`
   + `point_in_polygon`) against that ZIP's own polygon instead of a hand-drawn one —
   almost always a single tile per ZIP, since ZCTAs are small. Frontend: `onStateChange()`
   loads and renders the ZCTA layer as a `google.maps.Data` overlay with hover/click
   handlers; `searchZips()` unions the selected ZCTAs' geometry client-side (Turf) as the
   region to shade coverage against, per `MCP_TOOL_SCHEMAS.md`'s note that the searched
   area is the union of selected ZCTAs, not the whole state. Frontend loads ZIPs on the
   map's `idle` event (`loadVisibleZips`) once zoom >= `MIN_ZIP_ZOOM`, adding only ZIPs
   not already on the map. Backend verified locally against Neon + TIGERweb with Places
   mocked; frontend verified end-to-end in headless Chromium (Playwright, 2026-09-27):
   CA/TX/RI ZIP loading, selection, cross-border refusal, a real Chipotle search, reset,
   and fast state switching. That run also found and fixed: unselected ZIP outlines were
   invisible against Google's street grid (now darker slate, 1.5px); Flask debug mode
   pretty-printed JSON, inflating local responses ~4x (`app.json.compact = True`);
   simplification tolerance loosened to ~1 screen pixel (`bbox width / 1000`); stale
   status text after switching states.
2. ~~**Postgres + PostGIS data store**~~ — **provisioned on Neon (2026-09-27), schema
   applied, `zctas` loaded.** `migrations/schema.sql` defines 7 tables: `zctas` (ZIP
   outlines for the ZIP selector, bulk-loaded), `restaurant_locations` (Coverage MCP
   cache, with `is_closed` / `duplicate_of_place_id` columns the anomaly-removal pass
   writes to), `traffic_stations` (Traffic MCP), `census_tracts` + `census_tract_acs`
   (Demographics MCP),
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
   tool's real query patterns are known. `db.py` now calls `load_dotenv()` itself so
   scripts importing it directly see `DATABASE_URL`. `app.py` imports `db` (for `zctas`).
   `DATABASE_URL` is the pooled (`-pooler`) Neon string, set in `.env` and by the Vercel
   integration. Temp tables don't survive the pooler across transactions - use a real
   staging table (see `import_zctas.py`).
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
- `migrations/schema.sql` — the data store's DDL (7 tables, see Roadmap item 2), applied
  to Neon. `migrations/apply.py` runs it without psql; idempotent.
- `scripts/import_zctas.py` — one-time nationwide ZIP outline import (see Gotchas).
- `db.py` — the data store's connection layer (`DATABASE_URL`, `DB_ENABLED`,
  `get_connection()`/`fetch_all()`/`execute()`). Used by `app.py` for the ZIP selector
  and by the scripts above; the future MCP tools will use it too.

## Git workflow

Initial repo setup (already done; kept for reference):

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
