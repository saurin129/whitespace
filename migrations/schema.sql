-- Restaurant Coverage Map - data store schema.
--
-- This is the persistence layer the MCP tool layer reads/writes through
-- (see CLAUDE.md "Architecture" and MCP_TOOL_SCHEMAS.md "Data store and the
-- anomaly-removal step") - it is NOT required for the core Flask app, which
-- works fine with zero database configured (see db.py's DB_ENABLED flag).
-- Its job is to cache expensive/rate-limited external API results (Places,
-- state DOT traffic, Census ACS, Places reviews) so the MCP tools don't hit
-- those APIs on every single agent call, and to give the LLM anomaly-removal
-- pass somewhere to write what it found.
--
-- Run this once against a fresh Postgres + PostGIS database (Neon and
-- Supabase both support the postgis extension on their free tiers - see
-- README's "Data store" section for exact provisioning steps):
--
--   psql "$DATABASE_URL" -f migrations/schema.sql
--
-- or, without psql installed:
--
--   python migrations/apply.py
--
-- Safe to re-run - every statement is idempotent (IF NOT EXISTS / OR REPLACE).

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------------------
-- ZIP code (ZCTA) boundaries for the map's ZIP selector and ZIP search.
--
-- Bulk-loaded once from the Census cartographic boundary file by
-- scripts/import_zctas.py (ZCTAs only change each decennial census, so there's
-- no refresh job). Replaces querying TIGERweb with a whole-state polygon,
-- which the Census WAF rejects for large states - see CLAUDE.md Gotchas.
--
-- GEOMETRY rather than GEOGRAPHY (unlike the point tables below): the queries
-- here are bounding-box lookups for the visible map viewport plus
-- ST_Simplify for zoomed-out views, both of which are cheaper and better
-- supported on planar geometry. At ZIP scale the difference is irrelevant.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zctas (
    zcta5           TEXT PRIMARY KEY,           -- 5-digit ZCTA code, e.g. '02903'
    state_codes     TEXT[] NOT NULL DEFAULT '{}', -- states it overlaps; a few ZCTAs span a state line
    geom            GEOMETRY(MULTIPOLYGON, 4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_zctas_geom
    ON zctas USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_zctas_state_codes
    ON zctas USING GIN (state_codes);

-- ---------------------------------------------------------------------------
-- Coverage MCP: cached, cleaned Places search results.
--
-- One row per physical location Google Places has returned for some past
-- search_coverage call. Re-searching the same restaurant/ZIP combo should
-- hit this table first and only re-call Places once a row's data is stale
-- (no fixed TTL enforced here on purpose - that policy belongs in the
-- Coverage MCP tool's implementation, not the schema).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS restaurant_locations (
    place_id            TEXT PRIMARY KEY,
    restaurant_name     TEXT NOT NULL,      -- the chain name searched for, e.g. "Chipotle"
    business_name       TEXT NOT NULL,      -- Places' actual returned name for this listing
    address             TEXT,
    zip_code            TEXT,
    state_code          TEXT NOT NULL,
    lat                 DOUBLE PRECISION NOT NULL,
    lng                 DOUBLE PRECISION NOT NULL,
    geom                GEOGRAPHY(POINT, 4326) NOT NULL,
    rating              DOUBLE PRECISION,

    -- Anomaly-removal pass output (see anomaly_log below for the full
    -- reasoning trail) - denormalized onto the row itself so a normal
    -- Coverage MCP read can just filter WHERE NOT is_closed AND
    -- duplicate_of_place_id IS NULL, no join required.
    is_closed           BOOLEAN NOT NULL DEFAULT FALSE,
    duplicate_of_place_id TEXT REFERENCES restaurant_locations(place_id),

    first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_restaurant_locations_geom
    ON restaurant_locations USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_restaurant_locations_search
    ON restaurant_locations (restaurant_name, state_code, zip_code);

-- ---------------------------------------------------------------------------
-- Traffic MCP: state DOT AADT (annual average daily traffic) station cache.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS traffic_stations (
    id              BIGSERIAL PRIMARY KEY,
    source          TEXT NOT NULL,      -- which state DOT adapter this came from
    state_code      TEXT NOT NULL,
    route_name      TEXT,
    lat             DOUBLE PRECISION NOT NULL,
    lng             DOUBLE PRECISION NOT NULL,
    geom            GEOGRAPHY(POINT, 4326) NOT NULL,
    aadt            INTEGER NOT NULL,
    data_year       INTEGER NOT NULL,   -- surfaced directly in get_traffic_data's output,
                                         -- also read by rank_candidates' recency sub-score
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (source, state_code, lat, lng, data_year)
);

CREATE INDEX IF NOT EXISTS idx_traffic_stations_geom
    ON traffic_stations USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_traffic_stations_state
    ON traffic_stations (state_code);

-- ---------------------------------------------------------------------------
-- Demographics MCP: Census tract boundaries + ACS values, as two tables.
--
-- Split on purpose: tract outlines only change each decennial census, but a
-- new ACS 5-year estimate comes out every year. Keeping the polygon on the
-- per-vintage row would store every tract outline again for each vintage
-- (~100 MB per nationwide load) - see CLAUDE.md's storage budget. Boundaries
-- load per state on first request, not as a nationwide backfill.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS census_tracts (
    geoid           TEXT PRIMARY KEY,   -- Census tract GEOID
    state_code      TEXT NOT NULL,
    geom            GEOGRAPHY(MULTIPOLYGON, 4326) NOT NULL, -- some tracts are multipart (islands)
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_census_tracts_geom
    ON census_tracts USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_census_tracts_state
    ON census_tracts (state_code);

CREATE TABLE IF NOT EXISTS census_tract_acs (
    geoid                       TEXT NOT NULL REFERENCES census_tracts(geoid),
    vintage_year                INTEGER NOT NULL, -- which ACS 5-year estimate this is
    population                  INTEGER,
    median_household_income     INTEGER,
    median_age                  DOUBLE PRECISION,
    fetched_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (geoid, vintage_year)
);

-- ---------------------------------------------------------------------------
-- Sentiment MCP: sampled Places reviews cache, keyed by the point + category
-- a get_location_sentiment call was scoped to (not by place_id alone, since
-- the same business can be sampled under different category_keyword values).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sentiment_samples (
    id                  BIGSERIAL PRIMARY KEY,
    sample_lat          DOUBLE PRECISION NOT NULL,  -- the candidate point this sample serves
    sample_lng          DOUBLE PRECISION NOT NULL,
    category_keyword    TEXT NOT NULL,
    place_id            TEXT NOT NULL,
    business_name       TEXT NOT NULL,
    rating               DOUBLE PRECISION,
    review_count         INTEGER,
    reviews              JSONB NOT NULL DEFAULT '[]',  -- up to 5 full-text reviews, as returned
    fetched_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (sample_lat, sample_lng, category_keyword, place_id)
);

CREATE INDEX IF NOT EXISTS idx_sentiment_samples_point
    ON sentiment_samples (sample_lat, sample_lng, category_keyword);

-- ---------------------------------------------------------------------------
-- Anomaly-removal audit log. Every row here is one thing the LLM
-- anomaly-removal pass flagged - "CLOSED - Chipotle" in a business name,
-- two listings at the same address, a traffic reading a decade old sitting
-- next to recent ones. restaurant_locations.is_closed /
-- .duplicate_of_place_id are the actionable summary; this table is the
-- reasoning trail behind them, useful for debugging false positives.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS anomaly_log (
    id              BIGSERIAL PRIMARY KEY,
    table_name      TEXT NOT NULL,
    record_id       TEXT NOT NULL,          -- place_id, traffic_stations.id, etc., as text
    anomaly_type    TEXT NOT NULL,          -- 'closed_business' | 'duplicate_listing' | 'stale_data'
    reason          TEXT NOT NULL,          -- LLM-written explanation, not a coded enum
    detected_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_anomaly_log_record
    ON anomaly_log (table_name, record_id);
