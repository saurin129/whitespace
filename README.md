# Restaurant Coverage Map

A small local web app: enter a restaurant name and a radius in miles, then
either pick a US state or draw a custom search area on the map (like
Zillow's draw-an-area search). It plots every location Google Places finds
for that restaurant in the area, draws a radius circle (in miles) around
each one, and shades the part of the area that falls outside every circle —
i.e. not covered by any location within that radius.

## Setup

1. **Enable APIs on your Google Cloud key** (Google Cloud Console →
   APIs & Services → Library):
   - Maps JavaScript API
   - Places API

2. **Add your key.** Copy `.env.example` to `.env` and paste it in:

   ```bash
   cp .env.example .env
   ```

   ```
   GOOGLE_MAPS_API_KEY=your-key-here
   ```

   `.env` is gitignored — never commit it. The app loads it at startup via
   `python-dotenv`. A variable already set in your shell environment takes
   priority over `.env`.

3. **Install dependencies** (Python 3.9+):

   ```bash
   pip install -r requirements.txt
   ```

4. **Run it:**

   ```bash
   python app.py
   ```

   Then open **http://127.0.0.1:5001** in your browser.

## How it works

### ZIP code search (state dropdown)

- Pick a state and the map zooms to it. Once you're zoomed in to about
  county level, ZIP code (ZCTA) outlines appear for the part of the map
  you're looking at, and more load as you pan. Hover a ZIP to preview it,
  click to select it (up to 10 at once; more than 5 makes the search slower and may leave some results out). Only the selected state's ZIPs are
  shown. Each state's loaded ZIPs stay in the browser for the session, so
  switching back to a state doesn't reload areas you've already viewed.
- ZIP outlines come from the `zctas` database table (see "Data store"
  below). Without a database, the app falls back to querying the Census
  Bureau's TIGERweb service for the visible area directly — slower, and
  it can't tell which state a ZIP belongs to.
- The backend searches each selected ZIP independently — Google Places
  Text Search silently truncates results for broad "restaurant in a whole
  state" queries (it's not built for exhaustively enumerating a chain's
  locations), so instead each ZIP gets its own Nearby Search call scoped
  to that ZIP's actual shape. This is small enough that one chain rarely
  has more than a handful of locations in it, so results don't get cut off.
- Coverage shading is computed against the combined area of your selected
  ZIP(s), not the whole state.
- The state's own boundary is still fetched (and cached to
  `data/state_boundary_cache/`) to size the map view; if that lookup fails,
  the app falls back to a rectangular bounding box instead.

### Drawn-area search ("Draw search area" button)

- Click **Draw search area**, click points on the map to outline a shape,
  then click **Finish area** (needs at least 3 points; you can drag the
  corners afterward to adjust). This replaces the state dropdown for that
  search — the shape stays on the map and is reused until you click
  **Clear**. (Google's built-in map-drawing tool was deprecated, so this app
  places vertices with plain map clicks instead.)
- Google's Nearby Search (which this mode uses instead of Text Search) caps
  its radius at about 31 miles per call, so the backend covers your drawn
  shape with a grid of overlapping ~25-mile-radius sub-searches ("tiles"),
  merges and de-duplicates the results, then keeps only the ones that
  actually fall inside the shape you drew (a tile's search circle pokes out
  past the shape's edge; that overhang gets trimmed off). The status line
  after a search tells you how many tiles were used.
- To keep this from generating unbounded API calls (and cost) if you draw a
  very large shape, the number of tiles is capped at 25 (covers roughly a
  100–150 mile-wide area). If your shape needs more than that, you'll see a
  truncation warning — draw a smaller area, or run a few smaller searches
  and combine the results yourself.

### Coverage shading (both modes)

In the browser, [Turf.js](https://turfjs.org/) builds a circle polygon
(radius in miles) around every location, unions them together, and
subtracts that union from the state or drawn-area polygon. Whatever's left
— shown in red — is outside every location's radius.

## Deploying to Vercel

The app deploys to Vercel with no code changes beyond what's already in this repo
(it auto-detects the `app` Flask instance in `app.py`).

1. **Push this repo to GitHub** (see the Git workflow section in `CLAUDE.md` if you
   haven't already).
2. **Import the repo in Vercel** (vercel.com → Add New → Project → import your GitHub
   repo). Framework preset should auto-detect as Flask/Python.
3. **Set environment variables** in the Vercel project's Settings → Environment
   Variables — `.env` is gitignored and won't be in the deployed bundle. (Once the
   project is linked with the Vercel CLI, `vercel env pull .env` copies these back into
   a local `.env`.)
   - `GOOGLE_MAPS_API_KEY` — required.
   - `GOOGLE_PLACES_API_KEY` — optional, see the key-splitting note below. If unset,
     the app falls back to using `GOOGLE_MAPS_API_KEY` for both.
4. **Restrict the browser key.** `GOOGLE_MAPS_API_KEY` is embedded in the page source
   and visible to anyone who visits the deployed site — that's inherent to how the Maps
   JavaScript API works, not a bug. In Google Cloud Console, add an HTTP referrer
   restriction scoped to your Vercel domain (`your-app.vercel.app/*`) so the key can't
   be lifted and reused elsewhere. This matters much more once it's public than it did
   running on `127.0.0.1`.
5. **Consider splitting into two keys.** The same key currently does double duty:
   embedded client-side (needs an HTTP referrer restriction) and called server-side for
   Places searches (server calls don't send a referrer header, so a referrer-restricted
   key can fail there under some configurations). Google Cloud only allows one
   restriction type per key. Cleanest fix: create a second key restricted by *API*
   (Places API only, no application restriction) and set it as `GOOGLE_PLACES_API_KEY`.
   One key still works for a quick deploy; two keys is the more correct setup.
6. **Redeploy** after adding env vars (Vercel doesn't hot-reload them into an existing
   deployment).

**Known constraint:** Google's page-token pagination retries (`google_places_paginated`
in `app.py`) can take several seconds on a multi-page search. `vercel.json` sets
`maxDuration: 60` for this reason — if you're on a plan where that's not allowed, lower
it, but a very large state search may then time out before finishing all 3 pages.

## Data store (recommended)

The Flask app works with zero database configured, but the ZIP selector is faster and
more reliable with one: ZIP outlines are served from a `zctas` table instead of the
Census Bureau's servers. The planned MCP tool layer (`MCP_TOOL_SCHEMAS.md`) will also
read/write through this store instead of hitting Places/DOT/Census/Reviews APIs on every
agent call. `migrations/schema.sql` + `db.py` are the store's schema and connection
layer.

1. **Provision a Postgres database with PostGIS.** Either works, both have a free tier:
   - [Neon](https://neon.tech) — new project, then in the SQL editor or via `psql`, run
     `CREATE EXTENSION IF NOT EXISTS postgis;` (or just run the migration below, it does
     this for you).
   - [Supabase](https://supabase.com) — new project; PostGIS can be enabled from
     Database → Extensions in their dashboard, or again, the migration handles it.
   - Both integrate directly with Vercel (Vercel's Storage tab can provision either one
     and sets the connection env var for you automatically).
2. **Run the schema** against your new database:
   ```bash
   python migrations/apply.py
   # or, with psql installed: psql "$DATABASE_URL" -f migrations/schema.sql
   ```
   Safe to re-run — every statement is idempotent.
3. **Load the ZIP code outlines** (one time, about a minute; downloads ~70 MB from the
   Census Bureau and uses ~110 MB of database storage):
   ```bash
   pip install -r requirements-dev.txt
   python scripts/import_zctas.py
   ```
   ZIP outlines only change with each decennial census, so there's nothing to refresh.
4. **Set `DATABASE_URL`** — locally as an environment variable, or in Vercel's
   Environment Variables settings for a deployed instance (same place as
   `GOOGLE_MAPS_API_KEY`), or in your local `.env` for the data-store tooling. It's
   optional infrastructure, not a required secret, so "unset" just means the app runs
   without the caching layer.
5. **Install `psycopg2-binary`** (already in `requirements.txt`) if you haven't:
   `pip install -r requirements.txt`.

`db.py`'s `DB_ENABLED` flag is `False` whenever `DATABASE_URL` is unset (or
`psycopg2` isn't installed), so nothing that depends on the data store should crash if
it's skipped — it should just fall back to calling the live API directly (as the ZIP
selector does), the same way the on-disk state-boundary cache degrades to "no caching"
rather than crashing (see `app.py`'s `CACHE_ENABLED`).

## Notes / limitations

- Both search modes (ZIP and drawn-area) use Nearby Search per tile/ZIP,
  which caps at 60 results per call (3 pages of 20) — rarely hit in
  practice, since ZIPs and tiles are relatively small areas. An unused
  `/api/search` endpoint still does a whole-state Google Places Text Search,
  which reliably does hit that cap for large states and common chain names;
  it's kept for reference but the browser UI no longer calls it.
- The Places API has a free monthly usage credit, but is a paid API beyond
  that — check your Google Cloud billing/quota settings, especially before
  drawing many large search areas.
- State boundary fallback rectangles (used only if TIGERweb is unreachable)
  are approximate, not exact state outlines.
