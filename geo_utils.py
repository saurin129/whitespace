"""
Small pure-Python geometry helpers for the drawn-area search feature.

No external geometry library (e.g. shapely) is used on purpose, to keep
`pip install -r requirements.txt` simple and dependency-light for a local
hobby app.
"""

import math

EARTH_RADIUS_MILES = 3958.8

# Google Places Nearby Search caps radius at 50,000 meters (~31.07 miles).
# Stay comfortably under that.
MAX_TILE_RADIUS_MILES = 25.0


def haversine_miles(lat1, lng1, lat2, lng2):
    """Great-circle distance between two points, in miles."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    )
    return 2 * EARTH_RADIUS_MILES * math.asin(min(1, math.sqrt(a)))


def point_in_polygon(lat, lng, polygon):
    """Ray-casting point-in-polygon test.

    polygon: list of [lat, lng] pairs describing a single ring (does not
    need to be explicitly closed).
    """
    inside = False
    n = len(polygon)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        lat_i, lng_i = polygon[i]
        lat_j, lng_j = polygon[j]
        if (lng_i > lng) != (lng_j > lng):
            denom = (lng_j - lng_i) or 1e-15
            lat_intersect = (lat_j - lat_i) * (lng - lng_i) / denom + lat_i
            if lat < lat_intersect:
                inside = not inside
        j = i
    return inside


def polygon_bbox(polygon):
    lats = [p[0] for p in polygon]
    lngs = [p[1] for p in polygon]
    return min(lats), min(lngs), max(lats), max(lngs)


def polygon_centroid(polygon):
    lats = [p[0] for p in polygon]
    lngs = [p[1] for p in polygon]
    return sum(lats) / len(lats), sum(lngs) / len(lngs)


def generate_tile_centers(polygon, tile_radius_miles=MAX_TILE_RADIUS_MILES, max_tiles=25):
    """Cover a drawn polygon with a grid of overlapping search circles.

    Returns (centers, truncated) where centers is a list of (lat, lng)
    tuples and truncated is True if the polygon needed more tiles than
    max_tiles allows (in which case coverage may be incomplete).
    """
    tile_radius_miles = min(tile_radius_miles, MAX_TILE_RADIUS_MILES)
    south, west, north, east = polygon_bbox(polygon)
    center_lat = (south + north) / 2

    # ~69 miles per degree of latitude everywhere; longitude degrees shrink
    # with cos(latitude).
    miles_per_deg_lat = 69.0
    miles_per_deg_lng = max(69.0 * math.cos(math.radians(center_lat)), 1.0)

    # Overlapping grid spacing so adjacent tiles' circles overlap a bit
    # rather than leaving gaps at the corners.
    spacing_miles = tile_radius_miles * 1.3
    lat_step = spacing_miles / miles_per_deg_lat
    lng_step = spacing_miles / miles_per_deg_lng

    if lat_step <= 0 or lng_step <= 0:
        centroid = polygon_centroid(polygon)
        return [centroid], False

    centers = []
    lat = south
    while lat <= north + lat_step / 2:
        lng = west
        while lng <= east + lng_step / 2:
            centers.append((lat, lng))
            lng += lng_step
        lat += lat_step

    # Keep tiles whose circle could plausibly touch the polygon: either the
    # tile center is inside the polygon, or it's within tile_radius_miles of
    # some polygon vertex (a cheap stand-in for "near the boundary").
    kept = []
    for lat, lng in centers:
        if point_in_polygon(lat, lng, polygon):
            kept.append((lat, lng))
            continue
        near_edge = any(
            haversine_miles(lat, lng, v_lat, v_lng) <= tile_radius_miles
            for v_lat, v_lng in polygon
        )
        if near_edge:
            kept.append((lat, lng))

    if not kept:
        kept = [polygon_centroid(polygon)]

    truncated = len(kept) > max_tiles
    if truncated:
        kept = kept[:max_tiles]

    return kept, truncated
