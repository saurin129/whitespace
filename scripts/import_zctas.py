"""One-time import of every US ZIP code (ZCTA) boundary into the zctas table.

    pip install -r requirements-dev.txt
    python migrations/apply.py          # creates the zctas table, if not done yet
    python scripts/import_zctas.py

Source: the Census Bureau's 2020 cartographic boundary files (the "500k"
generalized versions - plenty of detail for clicking ZIPs on a map, and
~100 MB in PostGIS for all 33,791 ZCTAs). ZCTAs only change each decennial
census, so this runs once, not on a schedule. See CLAUDE.md Gotchas for why
the app stopped querying TIGERweb with whole-state polygons.

Each ZCTA also gets state_codes: the state it mostly sits in, plus any other
state holding at least MIN_STATE_SHARE of its area (a few ZIPs straddle a
state line). Computed in PostGIS against the matching state boundary file.

Safe to re-run: rows are upserted by zcta5. Pass --shapefile-dir to reuse
already-downloaded/unzipped files instead of downloading again.
"""

import argparse
import io
import sys
import tempfile
import time
import zipfile
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db  # noqa: E402  (needs the sys.path tweak above)

try:
    import shapefile  # pyshp
except ImportError:
    sys.exit("This script needs pyshp: pip install -r requirements-dev.txt")

from psycopg2.extras import execute_values  # noqa: E402

CENSUS_BASE = "https://www2.census.gov/geo/tiger/GENZ2020/shp/"
ZCTA_FILE = "cb_2020_us_zcta520_500k"
STATE_FILE = "cb_2020_us_state_500k"

BATCH_SIZE = 500
COORD_DECIMALS = 6  # ~0.1 m; the 500k source isn't more precise than this anyway
MIN_STATE_SHARE = 0.01  # a secondary state must hold >= 1% of the ZIP's area

# Staging table for state outlines, dropped at the end. A regular table, not a
# TEMP one: Neon's pooled connection string can hand each transaction a
# different server connection, and temp tables don't survive that.
STAGING_STATES = "_import_state_boundaries"


def ensure_shapefile(name, shapefile_dir):
    """Return the path stem for `name`, downloading + unzipping it if needed."""
    stem = shapefile_dir / name
    if stem.with_suffix(".shp").exists():
        return stem
    url = f"{CENSUS_BASE}{name}.zip"
    print(f"Downloading {url} ...")
    resp = requests.get(url, timeout=300, headers={"User-Agent": "restaurant-coverage-app/1.0"})
    resp.raise_for_status()
    zipfile.ZipFile(io.BytesIO(resp.content)).extractall(shapefile_dir)
    return stem


def round_coords(coords):
    """Recursively round a GeoJSON coordinates array - shrinks what's sent to
    the database by roughly a third without any visible change."""
    if coords and isinstance(coords[0], (int, float)):
        return [round(c, COORD_DECIMALS) for c in coords[:2]]
    return [round_coords(c) for c in coords]


def geojson_text(shape):
    import json
    geo = shape.__geo_interface__
    return json.dumps({"type": geo["type"], "coordinates": round_coords(geo["coordinates"])})


def load_states(conn, stem):
    reader = shapefile.Reader(str(stem))
    rows = [
        (rec["STUSPS"], geojson_text(shp))
        for shp, rec in zip(reader.iterShapes(), reader.iterRecords())
    ]
    with conn.cursor() as cur:
        cur.execute(f"DROP TABLE IF EXISTS {STAGING_STATES}")
        cur.execute(
            f"CREATE TABLE {STAGING_STATES} ("
            "  state_code TEXT PRIMARY KEY,"
            "  geom GEOMETRY(MULTIPOLYGON, 4326) NOT NULL)"
        )
        execute_values(
            cur,
            f"INSERT INTO {STAGING_STATES} (state_code, geom) VALUES %s",
            rows,
            template="(%s, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)))",
        )
        cur.execute(f"CREATE INDEX ON {STAGING_STATES} USING GIST (geom)")
    conn.commit()
    print(f"Loaded {len(rows)} state/territory outlines into staging.")


def load_zctas(conn, stem):
    reader = shapefile.Reader(str(stem))
    total = len(reader)
    batch, done = [], 0
    started = time.time()
    with conn.cursor() as cur:
        for shp, rec in zip(reader.iterShapes(), reader.iterRecords()):
            batch.append((rec["ZCTA5CE20"], geojson_text(shp)))
            if len(batch) >= BATCH_SIZE:
                done += _upsert_zctas(cur, batch)
                conn.commit()
                batch = []
                print(f"  {done:,}/{total:,} ZCTAs ({time.time() - started:.0f}s)", end="\r", flush=True)
        if batch:
            done += _upsert_zctas(cur, batch)
            conn.commit()
    print(f"  {done:,}/{total:,} ZCTAs ({time.time() - started:.0f}s)")


def _upsert_zctas(cur, batch):
    execute_values(
        cur,
        "INSERT INTO zctas (zcta5, geom) VALUES %s "
        "ON CONFLICT (zcta5) DO UPDATE SET geom = EXCLUDED.geom",
        batch,
        template="(%s, ST_Multi(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326))))",
    )
    return len(batch)


def assign_states(conn):
    """Fill zctas.state_codes. Two passes, since ST_Intersection is slow and
    almost every ZIP sits entirely inside one state:
      1. primary state = whichever state contains a point inside the ZIP;
      2. only for ZIPs whose outline touches more than one state, add any
         other state holding >= MIN_STATE_SHARE of the ZIP's area.
    """
    with conn.cursor() as cur:
        cur.execute(
            f"""
            UPDATE zctas z SET state_codes = ARRAY[s.state_code]
            FROM {STAGING_STATES} s
            WHERE ST_Intersects(s.geom, ST_PointOnSurface(z.geom))
            """
        )
        print(f"Primary state assigned for {cur.rowcount:,} ZCTAs.")
        conn.commit()

        cur.execute(
            f"""
            WITH multi AS (
                SELECT z.zcta5, z.geom
                FROM zctas z
                JOIN {STAGING_STATES} s ON ST_Intersects(z.geom, s.geom)
                GROUP BY z.zcta5, z.geom
                HAVING count(*) > 1
            ),
            shares AS (
                SELECT m.zcta5, s.state_code
                FROM multi m
                JOIN {STAGING_STATES} s ON ST_Intersects(m.geom, s.geom)
                WHERE ST_Area(ST_Intersection(m.geom, s.geom)) >= %s * ST_Area(m.geom)
            )
            UPDATE zctas z
            SET state_codes = ARRAY(
                SELECT DISTINCT unnest(z.state_codes || array_agg_states.codes) ORDER BY 1
            )
            FROM (SELECT zcta5, array_agg(state_code) AS codes FROM shares GROUP BY zcta5) array_agg_states
            WHERE z.zcta5 = array_agg_states.zcta5
            """,
            (MIN_STATE_SHARE,),
        )
        print(f"Checked border ZCTAs; {cur.rowcount:,} touch more than one state.")
        cur.execute(f"DROP TABLE IF EXISTS {STAGING_STATES}")
    conn.commit()


def compact():
    """Reclaim the space from assign_states()'s UPDATEs. Postgres keeps the
    old version of every updated row until vacuumed, and ZIP outlines are
    mostly stored inline, so without this the table sits at ~2x its real
    size (measured: 199 MB before, 111 MB after). VACUUM can't run inside a
    transaction, hence the separate autocommit connection."""
    import psycopg2
    conn = psycopg2.connect(db.get_db_url())
    try:
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute("VACUUM (FULL, ANALYZE) zctas")
    finally:
        conn.close()


def report():
    row = db.fetch_all(
        """
        SELECT count(*) AS n,
               count(*) FILTER (WHERE cardinality(state_codes) = 0) AS no_state,
               count(*) FILTER (WHERE cardinality(state_codes) > 1) AS multi_state,
               pg_size_pretty(pg_total_relation_size('zctas')) AS table_size,
               pg_size_pretty(pg_database_size(current_database())) AS db_size
        FROM zctas
        """
    )[0]
    print(
        f"zctas: {row['n']:,} rows | {row['multi_state']:,} span 2+ states | "
        f"{row['no_state']:,} with no state | table {row['table_size']} | whole database {row['db_size']}"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--shapefile-dir", type=Path, help="Folder with (or to download) the Census shapefiles")
    args = parser.parse_args()

    if not db.DB_ENABLED:
        sys.exit("DATABASE_URL isn't set (or psycopg2 isn't installed) - see README's Data store section.")

    shapefile_dir = args.shapefile_dir or Path(tempfile.gettempdir()) / "restaurant-coverage-app-census"
    shapefile_dir.mkdir(parents=True, exist_ok=True)
    state_stem = ensure_shapefile(STATE_FILE, shapefile_dir)
    zcta_stem = ensure_shapefile(ZCTA_FILE, shapefile_dir)

    with db.get_connection() as conn:
        load_states(conn, state_stem)
        load_zctas(conn, zcta_stem)
        assign_states(conn)
    compact()
    report()


if __name__ == "__main__":
    main()
