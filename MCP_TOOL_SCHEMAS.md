# MCP tool schemas

Design spec for the three MCP tools described in the architecture diagrams. This is the
contract the Claude agent sees and calls against — write this first, implement second.

## Two region types, not one

Earlier draft had a single `Region` type shared by all three tools (state OR freeform
polygon). Splitting it in two turns out to be more accurate:

- **`SearchRegion`** — how a *search* gets scoped: a state plus up to 3 ZIP codes
  (ZCTAs) within it. This is the new zip-code-based selection model, and it's only used
  by `search_coverage`'s input.
- **`GeoArea`** — a plain geographic area: a state, or an arbitrary polygon. Used by
  `search_coverage`'s *output* (`uncovered_geojson`) and by `get_traffic_data` /
  `get_demographics`'s `region` input. This is the type that makes tool-chaining work —
  a gap polygon from one call becomes the `polygon` in the next call's `region`,
  regardless of whether that gap came from a zip-based search or anything else.

### `SearchRegion`

```json
{
  "SearchRegion": {
    "type": "object",
    "properties": {
      "state_code": { "type": "string", "pattern": "^[A-Z]{2}$" },
      "zip_codes": {
        "type": "array",
        "items": { "type": "string", "pattern": "^\\d{5}$" },
        "minItems": 1,
        "maxItems": 3,
        "description": "ZCTAs within state_code, selected on the map (hover to preview, click to select — max 3)"
      }
    },
    "required": ["state_code", "zip_codes"]
  }
}
```

**Why max 3, tied to pagination:** Google Places Text/Nearby Search caps at 60 results
per query (3 pages of 20), and — as we hit earlier — a whole-state query often doesn't
even paginate that far, because Text Search isn't built to exhaustively enumerate a
chain's locations. A single ZIP code is small enough that one chain rarely has more than
a handful of locations in it, so each ZIP's query reliably finishes in page 1 — the
truncation bug can't recur at this granularity. 3 ZIPs means at most 3 independent
paginated searches (worst case 3 × 60 = 180 results merged and deduped), which bounds
both latency and Places API cost per `search_coverage` call.

### `GeoArea`

```json
{
  "GeoArea": {
    "type": "object",
    "oneOf": [
      {
        "properties": {
          "state_code": { "type": "string", "pattern": "^[A-Z]{2}$" }
        },
        "required": ["state_code"]
      },
      {
        "properties": {
          "polygon": {
            "type": "array",
            "items": {
              "type": "array",
              "items": { "type": "number" },
              "minItems": 2,
              "maxItems": 2
            },
            "minItems": 3,
            "description": "[[lat, lng], ...] — an open ring, first point not repeated"
          }
        },
        "required": ["polygon"]
      }
    ]
  }
}
```

---

## 1. `search_coverage` (Coverage MCP)

Wraps the existing `app.py` / `geo_utils.py` logic. Finds every location of a restaurant
chain in a region, and computes how much of that region falls outside every location's
radius.

**Description (shown to the agent):** "Search for a restaurant chain across up to 3 ZIP
codes within a US state, and compute the geographic area not covered by any location
within a given radius. Returns locations plus the uncovered area as GeoJSON."

**Input schema**

```json
{
  "type": "object",
  "properties": {
    "restaurant_name": { "type": "string", "minLength": 1 },
    "radius_miles": { "type": "number", "exclusiveMinimum": 0, "maximum": 100 },
    "region": { "$ref": "#/$defs/SearchRegion" }
  },
  "required": ["restaurant_name", "radius_miles", "region"]
}
```

**Output**

```json
{
  "query": "string",
  "zip_codes_searched": ["43215", "43201"],
  "locations": [
    { "name": "string", "address": "string", "place_id": "string", "lat": 0.0, "lng": 0.0, "rating": 0.0, "zip_code": "43215" }
  ],
  "uncovered_geojson": { "type": "Polygon | MultiPolygon", "coordinates": "..." },
  "coverage_stats": {
    "region_area_sq_mi": 0.0,
    "uncovered_area_sq_mi": 0.0,
    "pct_covered": 0.0
  },
  "search_meta": {
    "per_zip_result_counts": { "43215": 12, "43201": 8 },
    "any_zip_truncated": false
  }
}
```

**Notes**
- The searched area is the **union of the selected ZCTA polygons**, not the whole state —
  that union is what `coverage_stats` and `uncovered_geojson` are computed against.
- `locations[].zip_code` and `search_meta.per_zip_result_counts` exist because each ZIP is
  its own independent Places query internally (see the pagination note under
  `SearchRegion` above) — surfacing that per-ZIP breakdown makes it obvious to the agent
  (and to you, debugging) if one specific ZIP's query got truncated, rather than a single
  opaque total.
- `uncovered_geojson` is new work: today that polygon only exists transiently in the
  browser (Turf.js). The handler needs a server-side port (circle union + difference) —
  see the internal-flow diagram's note on this.
- `coverage_stats` is new: raw GeoJSON is not something an LLM should reason over directly,
  so precompute the summary numbers it actually needs.
- The old whole-state and freehand-polygon search modes are superseded by ZIP selection
  for this tool. Whole-state search is still useful as a *display* mode in the browser UI
  (zoom out, see the whole state before drilling into ZIPs) — see the UI note below.

---

## 2. `get_traffic_data` (Traffic MCP)

**Description:** "Get vehicle traffic counts (AADT) for a region, optionally scored
against a specific set of candidate points."

**Input schema**

```json
{
  "type": "object",
  "properties": {
    "region": { "$ref": "#/$defs/GeoArea" },
    "points": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": { "lat": { "type": "number" }, "lng": { "type": "number" } },
        "required": ["lat", "lng"]
      },
      "description": "Optional candidate sites to score directly, e.g. a grid sampled from a coverage gap"
    }
  },
  "required": ["region"]
}
```

**Output**

```json
{
  "source": "string — which state DOT adapter served this",
  "data_year": 2024,
  "station_count": 0,
  "stations": [
    { "lat": 0.0, "lng": 0.0, "aadt": 0, "route_name": "string" }
  ],
  "point_scores": [
    { "lat": 0.0, "lng": 0.0, "nearest_station_aadt": 0, "distance_miles": 0.0 }
  ]
}
```

**Notes**
- `region.state_code` is effectively required in practice (even when `region.polygon` is
  given) because it selects which state DOT adapter to call — polygons can span state
  lines in theory, but the adapter registry is per-state. Worth deciding now: either
  require `state_code` explicitly alongside a polygon, or infer it server-side from the
  polygon's centroid. Recommend requiring it explicitly — inferring silently is the kind
  of thing that produces a confusing wrong answer near a state border.
- `point_scores` is only populated if `points` was supplied.
- This is the tool where "source" varies most per call — 50 different DOT backends,
  inconsistent schemas. `source` in the output lets the agent (and you, debugging) see
  which adapter actually ran.

---

## 3. `get_demographics` (Demographics MCP)

**Description:** "Get Census ACS population, income, and age data for a region, by census
tract, optionally scored against specific candidate points."

**Input schema**

```json
{
  "type": "object",
  "properties": {
    "region": { "$ref": "#/$defs/GeoArea" },
    "points": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": { "lat": { "type": "number" }, "lng": { "type": "number" } },
        "required": ["lat", "lng"]
      }
    },
    "acs_year": { "type": "integer", "description": "Defaults to latest available 5-year estimate" }
  },
  "required": ["region"]
}
```

**Output**

```json
{
  "source": "Census ACS 5-year estimate",
  "vintage_year": 2023,
  "tracts": [
    { "geoid": "string", "population": 0, "median_household_income": 0, "median_age": 0.0 }
  ],
  "point_demographics": [
    { "lat": 0.0, "lng": 0.0, "tract_geoid": "string", "population": 0, "median_household_income": 0 }
  ]
}
```

**Notes**
- Single stable federal API, one schema — the simplest of the three to implement.
- `point_demographics` requires a point-in-polygon join against tract boundaries — same
  technique already used in `geo_utils.py` for drawn-area filtering, just against Census
  TIGER tract polygons instead of a user-drawn one.

---

## 4. `get_location_sentiment` (Sentiment MCP)

**Description:** "Get a sentiment summary for candidate locations, based on Google
Places reviews of nearby existing businesses in the same category."

Originally scoped around Yelp and Reddit; both turned out to have real access
constraints (Yelp's Reviews API caps at 3 review excerpts, 160 characters each, even on
paid plans — no bulk text access at any tier; Reddit closed self-serve API registration
in late 2025 and now requires manual approval with a real chance of rejection, plus a
48-hour content-deletion-sync obligation for anything stored). Decision: skip both,
use Google Places reviews — the app already calls that API, and Place Details returns up
to 5 full-text reviews per business, no separate contract.

**Input schema**

```json
{
  "type": "object",
  "properties": {
    "points": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": { "lat": { "type": "number" }, "lng": { "type": "number" } },
        "required": ["lat", "lng"]
      },
      "minItems": 1
    },
    "category_keyword": { "type": "string", "description": "e.g. \"coffee\", \"fast food\" - scopes which nearby businesses to sample" },
    "sample_radius_miles": { "type": "number", "default": 1.0 }
  },
  "required": ["points", "category_keyword"]
}
```

**Output**

```json
{
  "source": "Google Places reviews",
  "point_sentiment": [
    {
      "lat": 0.0, "lng": 0.0,
      "businesses_sampled": [
        { "name": "string", "place_id": "string", "rating": 0.0, "review_count": 0, "reviews_fetched": 5 }
      ],
      "sentiment_summary": "string — LLM-generated, 2-3 sentences",
      "demand_signals": ["string — short LLM-extracted phrases, e.g. \"multiple reviews mention long wait times\""],
      "sample_size_caveat": "string — e.g. \"based on 12 reviews across 3 nearby businesses\""
    }
  ]
}
```

**Notes**
- `sample_size_caveat` is not decoration — it's required input to `rank_candidates`'
  confidence computation below. A point with 2 nearby businesses and 6 total reviews
  should visibly lower confidence relative to one with 5 businesses and 40 reviews.
- The LLM's job here is summarization and phrase-extraction over a small, real text
  sample — not inventing a number. Keep it that way; see the confidence-score note under
  `rank_candidates`.

---

## 5. `rank_candidates` (synthesis / ranking)

**Description:** "Given candidate sites already scored by the other tools, compute a
confidence score for each and return the top 3, ranked, with a written rationale."

This is the step that turns four separate tool outputs into one answer. It's a
dedicated tool rather than the agent free-styling a score, on purpose — see the
confidence-score note below.

**Input schema**

```json
{
  "type": "object",
  "properties": {
    "candidates": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "lat": { "type": "number" },
          "lng": { "type": "number" },
          "traffic": { "type": "object", "description": "a point_scores entry from get_traffic_data, or null" },
          "demographics": { "type": "object", "description": "a point_demographics entry from get_demographics, or null" },
          "sentiment": { "type": "object", "description": "a point_sentiment entry from get_location_sentiment, or null" }
        },
        "required": ["lat", "lng"]
      },
      "minItems": 1
    },
    "weights": {
      "type": "object",
      "properties": {
        "traffic": { "type": "number", "default": 0.34 },
        "demographics": { "type": "number", "default": 0.33 },
        "sentiment": { "type": "number", "default": 0.33 }
      },
      "description": "Optional override; must sum to 1.0"
    }
  },
  "required": ["candidates"]
}
```

**Output**

```json
{
  "ranked": [
    {
      "lat": 0.0, "lng": 0.0,
      "confidence_score": 0,
      "score_breakdown": {
        "data_completeness": 0.0,
        "source_agreement": 0.0,
        "recency": 0.0
      },
      "rationale": "string — LLM-written, references the actual numbers in score_breakdown"
    }
  ],
  "methodology_note": "string — fixed text explaining how confidence_score is computed, shown alongside every result"
}
```

**Notes — how `confidence_score` actually gets computed, and why it isn't just an
LLM-generated number:**
- LLM self-reported confidence ("on a scale of 1-100...") is well known to be
  uncalibrated — it doesn't reliably track actual correctness. Asking the model for a
  number here would look precise and be meaningless.
- Instead, `confidence_score` is a deterministic function of three computed
  sub-scores:
  - `data_completeness` — did this candidate have traffic AND demographics AND
    sentiment data, or only 1-2 of 3? (Directly uses `sentiment.sample_size_caveat`
    and whether `traffic`/`demographics` are null.)
  - `source_agreement` — do the signals point the same direction (e.g. high traffic
    + high income + positive sentiment) or conflict? Conflicting signals lower
    confidence even if individual scores are high.
  - `recency` — how old is the underlying traffic/demographic data (both sources
    report a data year already — `data_year` from Traffic MCP, `vintage_year` from
    Demographics MCP).
- The LLM's only job in this tool is writing `rationale` in plain language *from* the
  already-computed numbers — not producing the numbers themselves. This is the same
  principle as `get_location_sentiment`: LLM for language, code for arithmetic.

---

## Composability example

`search_coverage` takes the new zip-based `SearchRegion` as input, but its
`uncovered_geojson` output is a plain polygon — which is exactly the shape `GeoArea`
expects. So the chain still has no translation step, it just starts from a ZIP selection
instead of a whole state:

```
search_coverage(
  restaurant_name="Dunkin",
  radius_miles=2,
  region={state_code: "OH", zip_codes: ["43215", "43201", "43206"]}
)
  → uncovered_geojson: {...}   // union of the 3 ZCTAs, minus the radius circles

# agent samples candidate points from uncovered_geojson (e.g. a grid), then:

get_traffic_data(region={polygon: <uncovered_geojson coordinates>}, points=<candidates>)
  → point_scores per candidate

get_demographics(region={polygon: <uncovered_geojson coordinates>}, points=<candidates>)
  → point_demographics per candidate

get_location_sentiment(points=<candidates>, category_keyword="coffee")
  → point_sentiment per candidate

rank_candidates(candidates=<merged per-point bundle from the 3 calls above>)
  → top 3, each with a computed confidence_score + written rationale
```

The agent decides how far down this chain to go — stop after `search_coverage` if the
user only asked "where are the gaps," or run the full chain for "where's the best new
site." That branching, not the chain itself, is the actual point of building this as
MCP tools instead of one big function.

## Data store and the anomaly-removal step

Not an MCP tool — a persistence + cleaning layer the tools above read from and write to.
Given the app is deployed on Vercel serverless (no persistent local disk), this has to
be a hosted database, not a file: **Postgres + PostGIS**, via a Vercel-integrated
provider (Neon or Supabase), is the plan. It also upgrades the point-in-polygon joins
currently hand-rolled in `geo_utils.py` into real spatial SQL once there's enough data
volume to justify it.

**Anomaly removal** is a cleaning pass between "raw API response" and "stored /
returned to the agent," not folded into each tool's happy path. Concretely, things it
should catch: a Places result for a location that's permanently closed but still
listed; duplicate listings for the same physical store (same address, near-identical
name); a traffic count station whose reading is a decade-plus old sitting next to
recent ones. This is a case where an LLM earns its keep over a pure statistics filter —
"CLOSED - Chipotle" in a business name is a text-understanding problem, not a numeric
outlier.

---

## UI note: ZIP selection in the browser

This is a live-app feature, not part of the MCP contract, but it's what produces the
`zip_codes` array above:

- **Data source:** Census TIGERweb has a ZCTA (ZIP Code Tabulation Area) layer, same
  service family as the state boundaries already fetched in `app.py` — same
  fetch-and-cache pattern should carry over directly.
- **Scoping to keep hover performant:** load ZCTAs only for the selected state, not
  nationwide (there are ~33,000 ZCTAs in the US; a single state is a couple hundred at
  most). This mirrors the existing state-first flow: pick a state, *then* the map
  populates with that state's ZIP boundaries to hover/click.
- **Interaction:** hover highlights a ZCTA outline + shows its ZIP code in a tooltip;
  click toggles it selected (up to 3); a 4th click either does nothing with a status
  message, or bumps the oldest selection — worth deciding which feels better once it's
  actually clickable.
- This replaces the current state-dropdown-only and freehand-draw modes in the browser
  UI for *search scoping*. Whether to keep freehand-draw around as a separate, unrelated
  feature (e.g. "just show me this shape, no search") is a separate call — nothing above
  requires removing it.

## UI note: where the agent lives

There is one deployed application — this browser app, hosted on Vercel. The 5 MCP
tools above are not exposed through a separate chat product; they're called by a Claude
agent running behind a backend route on this same deployment (e.g. `/api/agent`),
reached from an embedded assistant panel inside this page. See `CLAUDE.md`'s Gotchas —
an earlier draft described a standalone "chat interface" as a second entry point, which
was corrected. Nothing about the tool schemas above changes based on this — it only
affects how a user reaches the agent.
