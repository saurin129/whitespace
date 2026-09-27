"""
Restaurant Coverage Map - local Flask app.

Search a restaurant chain within a US state, plot every location Google
Places knows about, draw a radius circle (in miles) around each one, and
shade the parts of the state that fall outside every circle.

Run:
    pip install -r requirements.txt
    python app.py
Then open http://127.0.0.1:5001 in your browser.

Set GOOGLE_MAPS_API_KEY in a .env file (see .env.example) or in your
environment. On Vercel, set it in Project Settings -> Environment Variables.
"""

import json
import os
import re
import tempfile
import time
from pathlib import Path

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request

import db
from geo_utils import generate_tile_centers, haversine_miles, point_in_polygon, MAX_TILE_RADIUS_MILES
from us_states import US_STATES, US_STATES_BY_CODE

APP_DIR = Path(__file__).resolve().parent

# Local dev reads secrets from .env (gitignored). On Vercel there's no .env
# file, so this is a no-op and the dashboard's environment variables are used.
# Never overrides a variable that's already set in the real environment.
load_dotenv(APP_DIR / ".env")

def _make_cache_dir(name):
    """Vercel's filesystem is read-only outside /tmp (Vercel sets the VERCEL
    env var at build/runtime, per their docs). Use the OS temp dir there -
    it's ephemeral per invocation, but that's fine, it's just a cache.
    Locally, keep caching next to the project so it survives restarts.

    Returns (path, enabled) - enabled is False if the directory couldn't be
    created (read-only filesystem or similar), so callers can degrade to
    "no caching" instead of crashing the whole app at import time.
    """
    if os.environ.get("VERCEL"):
        path = Path(tempfile.gettempdir()) / "restaurant-coverage-app-cache" / name
    else:
        path = APP_DIR / "data" / name

    enabled = True
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError:
        enabled = False
    return path, enabled


CACHE_DIR, CACHE_ENABLED = _make_cache_dir("state_boundary_cache")

app = Flask(__name__, static_folder="public/static", static_url_path="/static")
# Flask pretty-prints JSON in debug mode (python app.py), which made local
# ZIP-outline responses ~4x bigger than on Vercel. Always compact, so local
# size checks match production.
app.json.compact = True


def get_api_key():
    """The browser-side key, embedded in the rendered page for the Maps
    JavaScript API. Read from the GOOGLE_MAPS_API_KEY environment variable
    (loaded from .env locally, or Vercel's environment variables when deployed).

    This key is necessarily visible to anyone who views the page source -
    that's how the Maps JS API works. Restrict it in Google Cloud Console
    with an HTTP referrer restriction (your domain, e.g. your-app.vercel.app/*)
    once this is deployed somewhere public - see README's Vercel section.
    """
    return os.environ.get("GOOGLE_MAPS_API_KEY", "")


def get_places_api_key():
    """The server-side key used for Places API calls. Defaults to the same
    key as get_api_key() so a single key still works out of the box, but a
    separate GOOGLE_PLACES_API_KEY env var can override it.

    Worth splitting once this is public: an HTTP-referrer-restricted key (for
    the browser) and an unrestricted-but-API-scoped key (for server calls,
    which don't send a referrer header) are two different restriction types -
    Google Cloud only lets one key have one restriction type at a time.
    """
    env_key = os.environ.get("GOOGLE_PLACES_API_KEY")
    if env_key:
        return env_key
    return get_api_key()


TIGERWEB_STATE_QUERY = (
    "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/"
    "MapServer/0/query"
)

# Layer 4 of this service is "2020 Census ZIP Code Tabulation Areas" (ZCTA5).
# Only used as a fallback when no database is configured - the zctas table
# (bulk-loaded by scripts/import_zctas.py) is the primary source. Always
# queried with a small viewport envelope or a list of ZIP codes, never a whole
# state's outline: the Census WAF rejects large state polygons outright (see
# CLAUDE.md Gotchas).
TIGERWEB_ZCTA_QUERY = (
    "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/"
    "PUMA_TAD_TAZ_UGA_ZCTA/MapServer/4/query"
)


def fetch_state_boundary(state_code):
    """Return a GeoJSON geometry (Polygon/MultiPolygon) for the given state.

    Tries the Census Bureau's TIGERweb service first (real state outline,
    cached to disk after the first successful fetch). Falls back to a
    rectangle built from the state's bounding box if that's unreachable,
    so the app still works offline / without the Census service.
    """
    state_code = state_code.upper()
    cache_file = CACHE_DIR / f"{state_code}.json"
    if CACHE_ENABLED and cache_file.exists():
        try:
            return json.loads(cache_file.read_text()), "cached"
        except (json.JSONDecodeError, OSError):
            pass

    state = US_STATES_BY_CODE.get(state_code)
    if state is None:
        raise ValueError(f"Unknown state code: {state_code}")

    try:
        resp = requests.get(
            TIGERWEB_STATE_QUERY,
            params={
                "where": f"STUSAB='{state_code}'",
                "outFields": "STUSAB,NAME",
                "returnGeometry": "true",
                "geometryPrecision": 4,
                "outSR": 4326,
                "f": "geojson",
            },
            timeout=10,
            headers={"User-Agent": "restaurant-coverage-app/1.0"},
        )
        resp.raise_for_status()
        data = resp.json()
        features = data.get("features") or []
        if features:
            geometry = features[0]["geometry"]
            if CACHE_ENABLED:
                try:
                    cache_file.write_text(json.dumps(geometry))
                except OSError:
                    pass  # caching is a nice-to-have, not worth failing the request over
            return geometry, "live"
    except (requests.RequestException, ValueError, KeyError, json.JSONDecodeError):
        pass

    # Fallback: rectangle from the bounding box.
    south, west, north, east = state["bbox"]
    geometry = {
        "type": "Polygon",
        "coordinates": [[
            [west, south], [east, south], [east, north], [west, north], [west, south],
        ]],
    }
    return geometry, "fallback_bbox"


ZIP_RE = re.compile(r"^\d{5}$")

# The browser only asks for ZIPs once zoomed in to about county level
# (MIN_ZIP_ZOOM in app.js); this rejects anything much bigger, so one request
# can never try to ship a whole large state's outlines (~30 MB for CA).
MAX_VIEWPORT_SPAN_DEGREES = 8.0
MAX_VIEWPORT_ZCTAS = 1500


def parse_bbox(raw):
    """'south,west,north,east' -> (s, w, n, e) floats, or raise ValueError."""
    try:
        south, west, north, east = (float(v) for v in (raw or "").split(","))
    except ValueError:
        raise ValueError("Provide 'bbox' as south,west,north,east.")
    if not (-90 <= south < north <= 90 and -180 <= west < east <= 180):
        raise ValueError("bbox is out of range.")
    if north - south > MAX_VIEWPORT_SPAN_DEGREES or east - west > MAX_VIEWPORT_SPAN_DEGREES:
        raise ValueError("Area too large - zoom in to load ZIP codes.")
    return south, west, north, east


def fetch_zctas_in_bbox(state_code, bbox):
    """The selected state's ZCTA outlines intersecting the viewport, as a
    GeoJSON FeatureCollection with properties {ZCTA5, selectable}. Neighbouring
    states' ZIPs aren't returned: they can't be searched anyway, and near a
    border they're most of the payload (RI's state view: 743 ZIPs / 266 KB
    with neighbours vs 81 / 33 KB without). Outlines are simplified to roughly
    screen resolution for the viewport size, which keeps a dense viewport
    (e.g. around NYC) well under Vercel's ~4.5 MB response cap.

    Returns (geojson, source, truncated).
    """
    south, west, north, east = bbox
    tolerance = (east - west) / 1000  # degrees; about one screen pixel for a typical map width

    if db.DB_ENABLED:
        rows = db.fetch_all(
            """
            SELECT zcta5,
                   ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, %s), 5) AS geometry
            FROM zctas
            WHERE geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
              AND %s = ANY(state_codes)
            -- If the cap is hit, keep the ZIPs nearest the middle of the
            -- view, not whichever ZIP numbers sort first.
            ORDER BY geom <-> ST_SetSRID(ST_MakePoint(%s, %s), 4326)
            LIMIT %s
            """,
            (tolerance, west, south, east, north, state_code,
             (west + east) / 2, (south + north) / 2,
             MAX_VIEWPORT_ZCTAS + 1),
        )
        truncated = len(rows) > MAX_VIEWPORT_ZCTAS
        features = [
            {
                "type": "Feature",
                "properties": {"ZCTA5": r["zcta5"], "selectable": True},
                "geometry": json.loads(r["geometry"]),
            }
            for r in rows[:MAX_VIEWPORT_ZCTAS]
        ]
        return {"type": "FeatureCollection", "features": features}, "database", truncated

    # Fallback (no DATABASE_URL): TIGERweb has no state field on this layer,
    # so everything in view is treated as selectable.
    data = _tigerweb_zcta_query({
        "geometry": f"{west},{south},{east},{north}",
        "geometryType": "esriGeometryEnvelope",
        "spatialRel": "esriSpatialRelIntersects",
        "inSR": 4326,
        "maxAllowableOffset": tolerance,
        "resultRecordCount": MAX_VIEWPORT_ZCTAS + 1,
    })
    if data is None:
        return {"type": "FeatureCollection", "features": []}, "unavailable", False
    features = data.get("features", [])
    truncated = len(features) > MAX_VIEWPORT_ZCTAS
    features = features[:MAX_VIEWPORT_ZCTAS]
    for f in features:
        f["properties"] = {"ZCTA5": (f.get("properties") or {}).get("ZCTA5"), "selectable": True}
    return {"type": "FeatureCollection", "features": features}, "tigerweb", truncated


def fetch_zcta_polygons(zip_codes):
    """Full-detail outlines for specific ZIPs, for searching them.

    Returns {zip: {"state_codes": [...] or None, "polygons": [ring, ...]}},
    where each ring is the outer boundary of one part as [[lat, lng], ...]
    (geo_utils' convention). Multi-part ZIPs (islands, split areas) get one
    ring per part. ZIPs that don't exist are simply absent. state_codes is
    None when it's unknown (TIGERweb fallback).
    """
    if db.DB_ENABLED:
        rows = db.fetch_all(
            "SELECT zcta5, state_codes, ST_AsGeoJSON(geom, 6) AS geometry "
            "FROM zctas WHERE zcta5 = ANY(%s)",
            (list(zip_codes),),
        )
        found = {r["zcta5"]: (r["state_codes"], json.loads(r["geometry"])) for r in rows}
    else:
        quoted = ",".join(f"'{z}'" for z in zip_codes)  # safe: callers validate with ZIP_RE
        data = _tigerweb_zcta_query({"where": f"ZCTA5 IN ({quoted})"}) or {}
        found = {
            (f.get("properties") or {}).get("ZCTA5"): (None, f.get("geometry") or {})
            for f in data.get("features", [])
        }

    result = {}
    for zip_code, (state_codes, geometry) in found.items():
        if geometry.get("type") == "Polygon":
            parts = [geometry["coordinates"]]
        elif geometry.get("type") == "MultiPolygon":
            parts = geometry["coordinates"]
        else:
            continue
        # GeoJSON rings are [lng, lat]; flip to [lat, lng] for geo_utils.
        polygons = [[[lat, lng] for lng, lat in part[0]] for part in parts if part]
        result[zip_code] = {"state_codes": state_codes, "polygons": polygons}
    return result


MAX_TILES_PER_ZIP = 25  # same ceiling as a drawn area; each tile is one billed Places call
DUPLICATE_TILE_MILES = 1.0


def tile_zcta_parts(parts):
    """Search-tile centers covering every part of a (possibly multi-part) ZIP.

    Multi-part ZIPs are mostly island chains, whose parts sit close together
    and would otherwise each get their own near-identical tile (ZIP 99574 in
    Alaska: 35 parts, 52 tiles). Near-duplicate tiles are dropped, and the
    total is capped at MAX_TILES_PER_ZIP. Returns (centers, truncated).
    """
    centers, truncated = [], False
    for part in parts:
        part_tiles, part_truncated = generate_tile_centers(part)
        truncated = truncated or part_truncated
        for lat, lng in part_tiles:
            if all(haversine_miles(lat, lng, c_lat, c_lng) > DUPLICATE_TILE_MILES for c_lat, c_lng in centers):
                centers.append((lat, lng))
    if len(centers) > MAX_TILES_PER_ZIP:
        centers, truncated = centers[:MAX_TILES_PER_ZIP], True
    return centers, truncated


def _tigerweb_zcta_query(params):
    """GET the TIGERweb ZCTA layer; returns parsed GeoJSON or None on any
    failure (including the WAF's HTML rejection page)."""
    try:
        resp = requests.get(
            TIGERWEB_ZCTA_QUERY,
            params={
                "outFields": "ZCTA5",
                "returnGeometry": "true",
                "outSR": 4326,
                "geometryPrecision": 5,
                "f": "geojson",
                **params,
            },
            timeout=20,
            headers={"User-Agent": "restaurant-coverage-app/1.0"},
        )
        resp.raise_for_status()
        data = resp.json()
        return data if "features" in data else None
    except (requests.RequestException, ValueError):
        return None


def google_places_paginated(url, base_params, api_key):
    """Shared pagination/backoff logic for Google Places search endpoints
    (Text Search and Nearby Search share the same status/pagination shape).

    Only the first page is treated as fatal on error. A freshly issued
    next_page_token from a later page can take a few seconds to activate,
    so those are retried with backoff; if a later page still fails after
    retrying, pagination just stops and whatever was already found is
    returned, instead of failing the whole search.
    """
    results = []
    params = dict(base_params, key=api_key)
    next_token = None

    for page_num in range(3):  # Google returns at most 3 pages of ~20 results
        if next_token:
            params = {"pagetoken": next_token, "key": api_key}

        data = {}
        status = None
        # Give a fresh page token time to activate; retry a few times if
        # Google says INVALID_REQUEST before giving up on that page.
        attempts = 4 if next_token else 1
        for attempt in range(attempts):
            if next_token:
                time.sleep(2)
            resp = requests.get(url, params=params, timeout=10)
            resp.raise_for_status()
            data = resp.json()
            status = data.get("status")
            if status != "INVALID_REQUEST":
                break

        if status == "OK":
            results.extend(data.get("results", []))
        elif status == "ZERO_RESULTS":
            pass
        elif page_num == 0:
            raise RuntimeError(
                f"Google Places error: {status} - {data.get('error_message', '')}"
            )
        else:
            # A later page failed even after retries - keep what we have.
            break

        next_token = data.get("next_page_token")
        print(
            f"[places] page {page_num + 1}: status={status}, "
            f"got {len(data.get('results', []))} results, "
            f"next_page_token={'yes' if next_token else 'no'}"
        )
        if not next_token:
            break

    return results


def google_places_text_search(query, api_key):
    """Text Search - used for the 'whole state' search mode."""
    url = "https://maps.googleapis.com/maps/api/place/textsearch/json"
    return google_places_paginated(url, {"query": query}, api_key)


def google_places_nearby_search(lat, lng, radius_miles, keyword, api_key):
    """Nearby Search around a point - used for the drawn-area search mode,
    once per tile covering the drawn polygon."""
    url = "https://maps.googleapis.com/maps/api/place/nearbysearch/json"
    radius_meters = int(min(radius_miles, MAX_TILE_RADIUS_MILES) * 1609.344)
    params = {
        "location": f"{lat},{lng}",
        "radius": radius_meters,
        "keyword": keyword,
    }
    return google_places_paginated(url, params, api_key)


@app.route("/")
def index():
    return render_template(
        "index.html",
        api_key=get_api_key(),
        states=US_STATES,
    )


@app.route("/api/states")
def api_states():
    return jsonify(US_STATES)


@app.route("/api/state-boundary")
def api_state_boundary():
    state_code = request.args.get("state", "").upper()
    if not state_code or state_code not in US_STATES_BY_CODE:
        return jsonify({"error": "Provide a valid 'state' query param (2-letter code)."}), 400

    geometry, source = fetch_state_boundary(state_code)
    return jsonify({
        "state": state_code,
        "source": source,
        "geometry": geometry,
        "bbox": US_STATES_BY_CODE[state_code]["bbox"],
    })


@app.route("/api/zctas")
def api_zctas():
    """ZCTA (ZIP code) outlines in the visible map area, for the map's
    hover/click ZIP selector. The browser calls this as the user pans/zooms
    (only once zoomed in far enough), never for a whole state at once - see
    fetch_zctas_in_bbox() and CLAUDE.md Gotchas.

    Query params: state (2-letter code), bbox (south,west,north,east).
    """
    state_code = request.args.get("state", "").upper()
    if not state_code or state_code not in US_STATES_BY_CODE:
        return jsonify({"error": "Provide a valid 'state' query param (2-letter code)."}), 400
    try:
        bbox = parse_bbox(request.args.get("bbox"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    geojson, source, truncated = fetch_zctas_in_bbox(state_code, bbox)
    return jsonify({"state": state_code, "source": source, "truncated": truncated, "geojson": geojson})


@app.route("/api/search", methods=["POST"])
def api_search():
    """Whole-state Text Search. Superseded by /api/search-zips as the
    browser UI's default search mode (see CLAUDE.md Gotchas on why - Text
    Search silently truncates for broad chain-enumeration queries), but left
    in place rather than removed: it's still a valid lower-precision search,
    and nothing else in the app depends on it being gone.
    """
    api_key = get_places_api_key()
    if not api_key:
        return jsonify({
            "error": "No Google Maps API key configured. Set "
                      "GOOGLE_MAPS_API_KEY in .env or the environment."
        }), 400

    body = request.get_json(silent=True) or {}
    restaurant_name = (body.get("restaurant_name") or "").strip()
    state_code = (body.get("state_code") or "").strip().upper()

    if not restaurant_name:
        return jsonify({"error": "restaurant_name is required."}), 400
    if state_code not in US_STATES_BY_CODE:
        return jsonify({"error": "A valid state_code is required."}), 400

    state = US_STATES_BY_CODE[state_code]
    query = f"{restaurant_name} restaurant in {state['name']}"

    try:
        raw_results = google_places_text_search(query, api_key)
    except (requests.RequestException, RuntimeError) as exc:
        return jsonify({"error": str(exc)}), 502

    south, west, north, east = state["bbox"]
    # Google's text search is only loosely biased by the query text, so drop
    # anything clearly outside the selected state's bounding box (with a
    # little padding for border-adjacent locations and bbox approximation).
    pad = 0.3
    locations = []
    for r in raw_results:
        loc = r.get("geometry", {}).get("location", {})
        lat, lng = loc.get("lat"), loc.get("lng")
        if lat is None or lng is None:
            continue
        if not (south - pad <= lat <= north + pad and west - pad <= lng <= east + pad):
            continue
        locations.append({
            "name": r.get("name"),
            "address": r.get("formatted_address"),
            "place_id": r.get("place_id"),
            "rating": r.get("rating"),
            "lat": lat,
            "lng": lng,
        })

    return jsonify({
        "query": query,
        "count": len(locations),
        "locations": locations,
    })


@app.route("/api/search-area", methods=["POST"])
def api_search_area():
    """Search a custom, user-drawn polygon (like Zillow's 'draw an area').

    The polygon is covered with a grid of overlapping Nearby Search circles
    (tiles), each queried separately since Google caps Nearby Search radius
    at ~31 miles. Results are deduped by place_id, then filtered down to
    only the ones whose point actually falls inside the drawn polygon
    (a tile's circle extends past the polygon edge, so this trims that
    overhang back to the exact shape the user drew).
    """
    api_key = get_places_api_key()
    if not api_key:
        return jsonify({
            "error": "No Google Maps API key configured. Set "
                      "GOOGLE_MAPS_API_KEY in .env or the environment."
        }), 400

    body = request.get_json(silent=True) or {}
    restaurant_name = (body.get("restaurant_name") or "").strip()
    raw_polygon = body.get("polygon") or []

    if not restaurant_name:
        return jsonify({"error": "restaurant_name is required."}), 400

    polygon = []
    for pt in raw_polygon:
        try:
            lat, lng = float(pt[0]), float(pt[1])
        except (TypeError, ValueError, IndexError):
            continue
        polygon.append([lat, lng])

    if len(polygon) < 3:
        return jsonify({"error": "polygon must have at least 3 points."}), 400

    tile_centers, truncated = generate_tile_centers(polygon)

    by_place_id = {}
    errors = []
    for lat, lng in tile_centers:
        try:
            raw_results = google_places_nearby_search(
                lat, lng, MAX_TILE_RADIUS_MILES, restaurant_name, api_key
            )
        except (requests.RequestException, RuntimeError) as exc:
            errors.append(str(exc))
            continue
        for r in raw_results:
            place_id = r.get("place_id")
            if place_id and place_id not in by_place_id:
                by_place_id[place_id] = r

    if not by_place_id and errors:
        # Every tile failed outright - surface that instead of silently
        # returning zero results.
        return jsonify({"error": errors[0]}), 502

    locations = []
    for r in by_place_id.values():
        loc = r.get("geometry", {}).get("location", {})
        lat, lng = loc.get("lat"), loc.get("lng")
        if lat is None or lng is None:
            continue
        if not point_in_polygon(lat, lng, polygon):
            continue
        locations.append({
            "name": r.get("name"),
            "address": r.get("vicinity") or r.get("formatted_address"),
            "place_id": r.get("place_id"),
            "rating": r.get("rating"),
            "lat": lat,
            "lng": lng,
        })

    return jsonify({
        "query": restaurant_name,
        "count": len(locations),
        "locations": locations,
        "tiles_used": len(tile_centers),
        "truncated": truncated,
    })


@app.route("/api/search-zips", methods=["POST"])
def api_search_zips():
    """Search a restaurant chain across up to 3 selected ZIP codes (ZCTAs)
    within a state - the default browser search mode now (see CLAUDE.md
    Gotchas on why whole-state Text Search was replaced with this).

    Each ZIP is searched independently by tiling Nearby Search over that
    ZCTA's own polygon and filtering results to points actually inside it -
    the exact same tiling/point-in-polygon logic /api/search-area already
    uses for a hand-drawn shape, just applied to a ZCTA's polygon instead.
    A ZIP is small enough that this is almost always a single tile/call.
    Multi-part ZIPs (islands etc.) tile each part.
    """
    api_key = get_places_api_key()
    if not api_key:
        return jsonify({
            "error": "No Google Maps API key configured. Set "
                      "GOOGLE_MAPS_API_KEY in .env or the environment."
        }), 400

    body = request.get_json(silent=True) or {}
    restaurant_name = (body.get("restaurant_name") or "").strip()
    state_code = (body.get("state_code") or "").strip().upper()
    zip_codes = [str(z).strip() for z in (body.get("zip_codes") or []) if str(z).strip()]

    if not restaurant_name:
        return jsonify({"error": "restaurant_name is required."}), 400
    if state_code not in US_STATES_BY_CODE:
        return jsonify({"error": "A valid state_code is required."}), 400
    if not zip_codes:
        return jsonify({"error": "At least one zip_code is required."}), 400
    if len(zip_codes) > 3:
        return jsonify({"error": "At most 3 zip codes can be searched at once."}), 400
    bad = [z for z in zip_codes if not ZIP_RE.match(z)]
    if bad:
        return jsonify({"error": f"Not a 5-digit zip code: {', '.join(bad)}"}), 400

    zctas = fetch_zcta_polygons(zip_codes)
    missing = [
        z for z in zip_codes
        if z not in zctas
        or (zctas[z]["state_codes"] is not None and state_code not in zctas[z]["state_codes"])
    ]
    if missing:
        return jsonify({
            "error": f"Zip code(s) not found in {state_code}: {', '.join(missing)}"
        }), 400

    by_place_id = {}
    per_zip_result_counts = {}
    any_zip_truncated = False
    errors = []

    for zip_code in zip_codes:
        parts = zctas[zip_code]["polygons"]
        tile_centers, truncated = tile_zcta_parts(parts)
        any_zip_truncated = any_zip_truncated or truncated

        zip_result_count = 0
        for lat, lng in tile_centers:
            try:
                raw_results = google_places_nearby_search(
                    lat, lng, MAX_TILE_RADIUS_MILES, restaurant_name, api_key
                )
            except (requests.RequestException, RuntimeError) as exc:
                errors.append(str(exc))
                continue
            for r in raw_results:
                loc = r.get("geometry", {}).get("location", {})
                p_lat, p_lng = loc.get("lat"), loc.get("lng")
                if p_lat is None or p_lng is None:
                    continue
                if not any(point_in_polygon(p_lat, p_lng, part) for part in parts):
                    continue
                place_id = r.get("place_id")
                if place_id and place_id not in by_place_id:
                    by_place_id[place_id] = {
                        "name": r.get("name"),
                        "address": r.get("vicinity") or r.get("formatted_address"),
                        "place_id": place_id,
                        "rating": r.get("rating"),
                        "lat": p_lat,
                        "lng": p_lng,
                        "zip_code": zip_code,
                    }
                    zip_result_count += 1
        per_zip_result_counts[zip_code] = zip_result_count

    if not by_place_id and errors:
        return jsonify({"error": errors[0]}), 502

    return jsonify({
        "query": restaurant_name,
        "zip_codes_searched": zip_codes,
        "count": len(by_place_id),
        "locations": list(by_place_id.values()),
        "per_zip_result_counts": per_zip_result_counts,
        "any_zip_truncated": any_zip_truncated,
    })


if __name__ == "__main__":
    if not get_api_key():
        print(
            "\n*** No Google Maps API key found. Copy .env.example to .env and "
            "paste your key in before searching. ***\n"
        )
    app.run(host="127.0.0.1", port=5001, debug=True)
