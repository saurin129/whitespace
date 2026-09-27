// Restaurant Coverage Map - frontend logic.
//
// Two search modes:
//  - State mode: pick a US state, backend runs a Places Text Search and we
//    fetch the real state outline (Census TIGERweb) to shade against.
//  - Drawn-area mode: draw a custom shape on the map (like Zillow's
//    draw-an-area search), backend tiles Nearby Search calls across it and
//    filters results down to points inside the shape; we shade against the
//    drawn polygon itself instead of a state outline.

const MILES_TO_METERS = 1609.344;
const US_VIEW = { center: { lat: 39.5, lng: -98.35 }, zoom: 4 }; // continental US

let map;
let markers = [];
let circles = [];
let stateOutlineLayer = null;
let uncoveredLayer = null;
let infoWindow;

// Google deprecated the Maps JavaScript API's Drawing library (Aug 2025,
// unavailable as of May 2026), so the search-area shape is built by hand:
// click the map to place vertices, then click "Finish area" to close it.
let drawnPolygon = null; // google.maps.Polygon overlay, persists across searches
let drawModePoints = []; // [{lat, lng}, ...] while actively placing vertices
let drawModePolygon = null; // live preview polygon while drawing
let mapClickListener = null;
let stateSelect;

let drawBtn, finishDrawBtn, clearDrawBtn;

// ZIP (ZCTA) selector: click up to 3 ZIP codes on the map to scope a search,
// instead of searching an entire state - see CLAUDE.md Gotchas on why
// (Google's Text Search silently truncates for whole-state chain searches).
//
// ZIP outlines load for the visible map area only, once zoomed in to
// MIN_ZIP_ZOOM, and more load as the user pans - a whole large state's ZIPs
// are far too much data to send at once (see CLAUDE.md Gotchas).
//
// Each state's loaded ZIPs are kept in the browser (zipCache) for the whole
// session: switching to another state just hides them, and switching back
// shows them again without re-requesting areas already viewed.
const MAX_SELECTED_ZIPS = 3;
const MIN_ZIP_ZOOM = 9; // roughly county level
// A view is re-requested only if no earlier request for this state covered
// it at a similar zoom - outlines are simplified to ~1px for the view they
// were fetched at, so reusing a much more zoomed-out load would look jagged.
const MAX_REUSE_SPAN_RATIO = 2;
const zipCache = new Map(); // stateCode -> { layer, loadedZips: Set, fetchedBoxes: [[s, w, n, e], ...] }
let zctaLayer = null; // google.maps.Data for the selected state (from zipCache)
let loadedZips = new Set(); // ZIP codes already in zctaLayer, so panning back doesn't re-add them
let fetchedBoxes = []; // viewports already requested for the selected state
let zipIdleListener = null; // map "idle" listener that loads ZIPs for the new view
let zipViewportAbort = null; // AbortController for the in-flight viewport request
let selectedZips = []; // [{ zip, feature: <GeoJSON Feature> }, ...] in click order, max 3
let zipPanel, zipChips, zipZoomHint;
// Bumped on every state change / reset, so a slow ZCTA response for a state
// the user has since moved away from is dropped instead of drawn.
let stateLoadId = 0;

function initMap() {
  map = new google.maps.Map(document.getElementById("map"), {
    ...US_VIEW,
    mapTypeControl: false,
    streetViewControl: false,
  });
  infoWindow = new google.maps.InfoWindow();
  stateSelect = document.getElementById("state-select");
  zipPanel = document.getElementById("zip-panel");
  zipChips = document.getElementById("zip-chips");
  zipZoomHint = document.getElementById("zip-zoom-hint");

  document.getElementById("search-form").addEventListener("submit", onSearch);
  stateSelect.addEventListener("change", onStateChange);

  drawBtn = document.getElementById("draw-btn");
  finishDrawBtn = document.getElementById("finish-draw-btn");
  clearDrawBtn = document.getElementById("clear-draw-btn");

  drawBtn.addEventListener("click", startDrawing);
  finishDrawBtn.addEventListener("click", finishDrawing);
  clearDrawBtn.addEventListener("click", onClearOrCancelClick);

  addResetControl();
}

function addResetControl() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "map-control-btn";
  btn.textContent = "Reset";
  btn.title = "Clear the search results (keeps your selected ZIPs and map view)";
  btn.addEventListener("click", resetResults);
  map.controls[google.maps.ControlPosition.TOP_RIGHT].push(btn);
}

// Clears only the search results (store markers, radius circles, coverage
// shading, results list). The state, the ZIP outlines already loaded, the
// selected ZIPs / drawn area and the map view all stay, so the user can
// change the restaurant or radius and search the same area again.
function resetResults() {
  clearResults();
  infoWindow.close();
  setStatus("");
}

function startDrawing() {
  if (drawnPolygon) {
    clearDrawnPolygon();
  }

  drawModePoints = [];
  drawModePolygon = new google.maps.Polygon({
    map,
    paths: [],
    strokeColor: "#3866f2",
    strokeWeight: 2,
    fillColor: "#3866f2",
    fillOpacity: 0.08,
  });

  mapClickListener = map.addListener("click", (e) => {
    drawModePoints.push({ lat: e.latLng.lat(), lng: e.latLng.lng() });
    drawModePolygon.setPath(drawModePoints);
    finishDrawBtn.disabled = drawModePoints.length < 3;
  });

  drawBtn.classList.add("hidden");
  finishDrawBtn.classList.remove("hidden");
  finishDrawBtn.disabled = true;
  clearDrawBtn.classList.remove("hidden");
  clearDrawBtn.textContent = "Cancel";

  // ZIP outlines sit on top of the map and would catch these clicks
  // (selecting ZIPs instead of placing points), so hide them while a drawn
  // area is in play. The state dropdown is locked too, like after Finish.
  suspendZipLayer();
  stateSelect.disabled = true;

  setStatus("Click points on the map to outline your search area, then click “Finish area” (at least 3 points).");
}

function finishDrawing() {
  if (drawModePoints.length < 3) return;

  if (mapClickListener) {
    google.maps.event.removeListener(mapClickListener);
    mapClickListener = null;
  }

  drawnPolygon = drawModePolygon;
  drawnPolygon.setEditable(true);
  drawModePolygon = null;
  drawModePoints = [];

  drawBtn.classList.remove("hidden");
  drawBtn.textContent = "Redraw search area";
  finishDrawBtn.classList.add("hidden");
  clearDrawBtn.classList.remove("hidden");
  clearDrawBtn.textContent = "Clear";

  stateSelect.required = false;
  stateSelect.disabled = true;
  zipPanel.classList.add("hidden");

  setStatus("Search area drawn (drag its corners to adjust). This will be used instead of the state dropdown.");
}

function onClearOrCancelClick() {
  const wasDrawing = !!mapClickListener;
  clearDrawnPolygon();
  setStatus(wasDrawing ? "Drawing cancelled." : "");
}

function clearDrawnPolygon() {
  if (mapClickListener) {
    google.maps.event.removeListener(mapClickListener);
    mapClickListener = null;
  }
  if (drawModePolygon) {
    drawModePolygon.setMap(null);
    drawModePolygon = null;
  }
  drawModePoints = [];
  if (drawnPolygon) {
    drawnPolygon.setMap(null);
    drawnPolygon = null;
  }

  drawBtn.classList.remove("hidden");
  drawBtn.textContent = "Draw search area";
  finishDrawBtn.classList.add("hidden");
  clearDrawBtn.classList.add("hidden");

  stateSelect.required = true;
  stateSelect.disabled = false;
  if (stateSelect.value) zipPanel.classList.remove("hidden");
  resumeZipLayer();
}

// Hide the selected state's ZIP outlines and stop loading more, without
// dropping them (see startDrawing). resumeZipLayer() brings them back.
function suspendZipLayer() {
  if (zipIdleListener) {
    google.maps.event.removeListener(zipIdleListener);
    zipIdleListener = null;
  }
  if (zipViewportAbort) {
    zipViewportAbort.abort();
    zipViewportAbort = null;
  }
  if (zctaLayer) zctaLayer.setMap(null);
  if (zipZoomHint) zipZoomHint.classList.add("hidden");
}

function resumeZipLayer() {
  if (!stateSelect.value || !zctaLayer) return;
  zctaLayer.setMap(map);
  if (!zipIdleListener) zipIdleListener = map.addListener("idle", loadVisibleZips);
  loadVisibleZips();
}

function getDrawnPolygonPath() {
  if (!drawnPolygon) return null;
  const path = drawnPolygon.getPath().getArray().map((ll) => ({ lat: ll.lat(), lng: ll.lng() }));
  return path.length >= 3 ? path : null;
}

function onStateChange() {
  const stateCode = stateSelect.value;
  stateLoadId++;
  clearZipSelection();
  clearZctaLayer();
  setStatus(""); // drop leftover "N ZIP codes selected" from the previous state

  if (!stateCode) {
    zipPanel.classList.add("hidden");
    return;
  }

  zipPanel.classList.remove("hidden");
  showStateZips(stateCode);
  // Load ZIPs whenever the map settles after a pan/zoom - including right
  // after the fitMapToBbox() below.
  zipIdleListener = map.addListener("idle", loadVisibleZips);

  // Zoom right away from the bbox baked into the <option>.
  const bbox = JSON.parse(stateSelect.selectedOptions[0].dataset.bbox || "null");
  if (bbox) fitMapToBbox(bbox);
}

// Hides the selected state's ZIPs and stops loading more. They stay in
// zipCache, so coming back to this state shows them again instantly.
function clearZctaLayer() {
  if (zipIdleListener) {
    google.maps.event.removeListener(zipIdleListener);
    zipIdleListener = null;
  }
  if (zipViewportAbort) {
    zipViewportAbort.abort();
    zipViewportAbort = null;
  }
  if (zctaLayer) {
    zctaLayer.setMap(null);
    zctaLayer = null;
  }
  loadedZips = new Set();
  fetchedBoxes = [];
  if (zipZoomHint) zipZoomHint.classList.add("hidden");
}

function showStateZips(stateCode) {
  if (!zipCache.has(stateCode)) {
    zipCache.set(stateCode, { layer: createZctaLayer(), loadedZips: new Set(), fetchedBoxes: [] });
  }
  const entry = zipCache.get(stateCode);
  zctaLayer = entry.layer;
  loadedZips = entry.loadedZips;
  fetchedBoxes = entry.fetchedBoxes;
  zctaLayer.setMap(map);
}

function alreadyFetched([south, west, north, east]) {
  return fetchedBoxes.some(
    ([s, w, n, e]) =>
      s <= south && w <= west && n >= north && e >= east &&
      (e - w) <= (east - west) * MAX_REUSE_SPAN_RATIO
  );
}

async function loadVisibleZips() {
  const stateCode = stateSelect.value;
  if (!stateCode || !zctaLayer) return;

  const tooFar = map.getZoom() < MIN_ZIP_ZOOM;
  zipZoomHint.classList.toggle("hidden", !tooFar);
  if (tooFar) return;

  const bounds = map.getBounds();
  if (!bounds) return;
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  // A view crossing the 180th meridian (western Alaska) has west > east;
  // just load the part east of the western edge.
  const east = ne.lng() < sw.lng() ? 180 : ne.lng();
  const box = [sw.lat(), sw.lng(), ne.lat(), east];
  if (alreadyFetched(box)) return; // every ZIP in this view is already on the map
  const bbox = box.map((v) => v.toFixed(4)).join(",");

  if (zipViewportAbort) zipViewportAbort.abort();
  zipViewportAbort = new AbortController();
  const loadId = stateLoadId;

  try {
    const resp = await fetch(
      `/api/zctas?state=${encodeURIComponent(stateCode)}&bbox=${bbox}`,
      { signal: zipViewportAbort.signal }
    ).then(parseJsonOrThrow);
    if (loadId !== stateLoadId || !zctaLayer) return; // user picked another state or reset meanwhile

    if (!resp.truncated) fetchedBoxes.push(box);
    resp.geojson.features.forEach((f) => {
      const zip = f.properties.ZCTA5;
      if (!zip || loadedZips.has(zip)) return;
      loadedZips.add(zip);
      zctaLayer.addGeoJson(f).forEach(styleZctaFeature);
    });
    if (resp.truncated) {
      setStatus("This view has a lot of ZIP codes — zoom in further to see all of them.");
    }
  } catch (err) {
    if (err.name === "AbortError" || loadId !== stateLoadId) return;
    console.error(err);
    setStatus(err.message || "Could not load ZIP code boundaries for this area.", true);
  }
}

function createZctaLayer() {
  const layer = new google.maps.Data();

  // Only the visible (selected state's) layer gets events, so the handlers
  // below can use the global zctaLayer.
  layer.addListener("mouseover", (e) => {
    const zip = e.feature.getProperty("ZCTA5");
    if (!e.feature.getProperty("selectable")) {
      if (zip) setStatus(`ZIP ${zip} is outside ${stateName()}.`);
      return;
    }
    zctaLayer.overrideStyle(e.feature, { strokeWeight: 2.5, fillOpacity: 0.25 });
    if (zip) setStatus(`ZIP ${zip}${isZipSelected(zip) ? " (selected)" : " — click to select"}`);
  });
  layer.addListener("mouseout", (e) => {
    zctaLayer.revertStyle(e.feature);
    styleZctaFeature(e.feature);
  });
  layer.addListener("click", (e) => onZctaClick(e.feature));
  return layer;
}

function stateName() {
  return stateSelect.selectedOptions[0] ? stateSelect.selectedOptions[0].textContent : "this state";
}

function styleZctaFeature(feature) {
  if (!feature.getProperty("selectable")) {
    // Neighbouring state's ZIP: faint outline only, not clickable-looking.
    zctaLayer.overrideStyle(feature, {
      fillOpacity: 0,
      strokeColor: "#8a90a3",
      strokeOpacity: 0.45,
      strokeWeight: 0.75,
    });
    return;
  }
  // Unselected outlines need to be darker than Google's grey street grid,
  // or they disappear into it (ZIP lines often follow streets).
  const selected = isZipSelected(feature.getProperty("ZCTA5"));
  zctaLayer.overrideStyle(feature, {
    fillColor: selected ? "#3866f2" : "#4a5068",
    fillOpacity: selected ? 0.3 : 0.04,
    strokeColor: selected ? "#3866f2" : "#4a5068",
    strokeOpacity: selected ? 1 : 0.8,
    strokeWeight: selected ? 2.5 : 1.5,
  });
}

function isZipSelected(zip) {
  return selectedZips.some((z) => z.zip === zip);
}

function onZctaClick(feature) {
  const zip = feature.getProperty("ZCTA5");
  if (!zip) return;
  if (!feature.getProperty("selectable")) {
    setStatus(`ZIP ${zip} is outside ${stateName()} — pick that state to search it.`, true);
    return;
  }

  const existingIndex = selectedZips.findIndex((z) => z.zip === zip);
  if (existingIndex !== -1) {
    selectedZips.splice(existingIndex, 1);
  } else {
    if (selectedZips.length >= MAX_SELECTED_ZIPS) {
      setStatus(`Already selected ${MAX_SELECTED_ZIPS} ZIP codes — remove one before adding another.`, true);
      return;
    }
    selectedZips.push({ zip, feature: zctaFeatureToGeoJson(feature) });
  }

  styleZctaFeature(feature);
  updateZipChips();
  setStatus(
    selectedZips.length
      ? `${selectedZips.length} ZIP code${selectedZips.length === 1 ? "" : "s"} selected.`
      : "Click up to 3 ZIP codes on the map."
  );
}

function zctaFeatureToGeoJson(feature) {
  // google.maps.Data features don't expose raw GeoJSON directly - rebuild
  // it from the geometry object so it can be turf.union'd at search time.
  // ZIPs with islands or split areas come back as MultiPolygons.
  const polygonCoords = (polygon) =>
    polygon.getArray().map((ring) => ring.getArray().map((ll) => [ll.lng(), ll.lat()]));
  const geometry = feature.getGeometry();
  if (geometry.getType() === "MultiPolygon") {
    return {
      type: "Feature",
      properties: {},
      geometry: { type: "MultiPolygon", coordinates: geometry.getArray().map(polygonCoords) },
    };
  }
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: polygonCoords(geometry) } };
}

function updateZipChips() {
  zipChips.innerHTML = selectedZips
    .map(
      (z) =>
        `<span class="zip-chip">${escapeHtml(z.zip)} <button type="button" data-zip="${escapeHtml(z.zip)}" class="zip-chip-remove" aria-label="Remove ${escapeHtml(z.zip)}">&times;</button></span>`
    )
    .join("");
  zipChips.querySelectorAll(".zip-chip-remove").forEach((btn) => {
    btn.addEventListener("click", () => removeZip(btn.dataset.zip));
  });
}

function removeZip(zip) {
  selectedZips = selectedZips.filter((z) => z.zip !== zip);
  if (zctaLayer) {
    zctaLayer.forEach((feature) => {
      if (feature.getProperty("ZCTA5") === zip) styleZctaFeature(feature);
    });
  }
  updateZipChips();
}

function clearZipSelection() {
  selectedZips = [];
  if (zctaLayer) zctaLayer.forEach(styleZctaFeature);
  if (zipChips) zipChips.innerHTML = "";
}

function fitMapToZips(zips) {
  const bounds = new google.maps.LatLngBounds();
  zips.forEach((z) => {
    const [west, south, east, north] = turf.bbox(z.feature);
    bounds.extend({ lat: south, lng: west });
    bounds.extend({ lat: north, lng: east });
  });
  map.fitBounds(bounds);
}

function setStatus(msg, isError) {
  const el = document.getElementById("status");
  el.textContent = msg || "";
  el.style.color = isError ? "#a12a2a" : "#55596b";
}

function clearResults() {
  markers.forEach((m) => m.setMap(null));
  markers = [];
  circles.forEach((c) => c.setMap(null));
  circles = [];
  if (stateOutlineLayer) {
    stateOutlineLayer.setMap(null);
    stateOutlineLayer = null;
  }
  if (uncoveredLayer) {
    uncoveredLayer.setMap(null);
    uncoveredLayer = null;
  }
  document.getElementById("results").innerHTML = "";
  document.getElementById("legend").classList.add("hidden");
}

async function onSearch(evt) {
  evt.preventDefault();

  const restaurantName = document.getElementById("restaurant-name").value.trim();
  const radiusMiles = parseFloat(document.getElementById("radius-miles").value);
  const stateCode = stateSelect.value;
  const drawnPath = getDrawnPolygonPath();
  const btn = document.getElementById("search-btn");

  if (!restaurantName || !radiusMiles || radiusMiles <= 0) {
    setStatus("Fill in a restaurant name and a positive radius.", true);
    return;
  }
  if (!drawnPath && (!stateCode || selectedZips.length === 0)) {
    setStatus("Pick a state and at least one ZIP code, or draw a search area on the map.", true);
    return;
  }

  btn.disabled = true;
  const stopLoading = startLoading(btn);
  clearResults();

  try {
    if (drawnPath) {
      await searchDrawnArea(restaurantName, radiusMiles, drawnPath);
    } else {
      await searchZips(restaurantName, radiusMiles, stateCode, selectedZips);
    }
    document.getElementById("legend").classList.remove("hidden");
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Something went wrong.", true);
  } finally {
    stopLoading();
    btn.disabled = false;
  }
}

// Search-in-progress indicators: spinner + elapsed seconds on the Search
// button, an animated bar across the top of the map, and a note on why it's
// slow. A search is one request with no progress updates (Places pages have
// a required ~2s pause between them), so this is indeterminate, not a %.
function startLoading(btn) {
  const label = btn.querySelector(".label");
  const bar = document.getElementById("map-loading-bar");
  const hint = document.getElementById("search-wait-hint");
  const started = Date.now();
  const tick = () => {
    const secs = Math.floor((Date.now() - started) / 1000);
    label.textContent = secs >= 1 ? `Searching… ${secs}s` : "Searching…";
  };
  tick();
  const timer = setInterval(tick, 1000);
  btn.classList.add("loading");
  bar.classList.remove("hidden");
  hint.classList.remove("hidden");
  return () => {
    clearInterval(timer);
    label.textContent = "Search";
    btn.classList.remove("loading");
    bar.classList.add("hidden");
    hint.classList.add("hidden");
  };
}

async function searchZips(restaurantName, radiusMiles, stateCode, zips) {
  setStatus(`Searching ${zips.length} ZIP code${zips.length === 1 ? "" : "s"}…`);

  const searchResp = await fetch("/api/search-zips", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      restaurant_name: restaurantName,
      state_code: stateCode,
      zip_codes: zips.map((z) => z.zip),
    }),
  }).then(parseJsonOrThrow);

  // Shade against the union of the selected ZCTA polygons, not the whole
  // state - see MCP_TOOL_SCHEMAS.md's SearchRegion notes on why.
  let regionGeometry = zips[0].feature.geometry;
  for (let i = 1; i < zips.length; i++) {
    try {
      const merged = turf.union(turf.feature(regionGeometry), turf.feature(zips[i].feature.geometry));
      if (merged) regionGeometry = merged.geometry;
    } catch (e) {
      console.warn("Could not union ZIP polygons, shading against the first ZIP only", e);
    }
  }

  renderLocations(searchResp.locations, radiusMiles);
  computeAndRenderCoverage(regionGeometry, searchResp.locations, radiusMiles);
  renderResultsList(searchResp.locations, radiusMiles);
  fitMapToZips(zips);

  let msg =
    `Showing ${searchResp.locations.length} location${searchResp.locations.length === 1 ? "" : "s"} ` +
    `across ${zips.length} ZIP code${zips.length === 1 ? "" : "s"} with a ${radiusMiles}-mile radius.`;
  if (searchResp.any_zip_truncated) {
    msg += " Note: Google capped the results for at least one ZIP, so some locations there may be missing.";
  }
  setStatus(msg, !!searchResp.any_zip_truncated);
}

async function searchDrawnArea(restaurantName, radiusMiles, drawnPath) {
  setStatus("Searching your drawn area (this can take a few seconds for larger areas)…");

  const polygonForApi = drawnPath.map((p) => [p.lat, p.lng]);
  const searchResp = await fetch("/api/search-area", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ restaurant_name: restaurantName, polygon: polygonForApi }),
  }).then(parseJsonOrThrow);

  const geometry = polygonPathToGeoJSON(drawnPath);
  renderLocations(searchResp.locations, radiusMiles);
  computeAndRenderCoverage(geometry, searchResp.locations, radiusMiles);
  renderResultsList(searchResp.locations, radiusMiles);
  fitMapToBbox(polygonPathBbox(drawnPath));

  let msg = `Showing ${searchResp.locations.length} location${searchResp.locations.length === 1 ? "" : "s"} ` +
    `with a ${radiusMiles}-mile radius (searched using ${searchResp.tiles_used} sub-area${searchResp.tiles_used === 1 ? "" : "s"}).`;
  if (searchResp.truncated) {
    msg += " Note: some locations in this area may be missing (it was very large, or Google capped the results).";
  }
  setStatus(msg, !!searchResp.truncated);
}

async function parseJsonOrThrow(resp) {
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.error || `Request failed (${resp.status})`);
  }
  return data;
}

function renderLocations(locations, radiusMiles) {
  const radiusMeters = radiusMiles * MILES_TO_METERS;

  locations.forEach((loc) => {
    const position = { lat: loc.lat, lng: loc.lng };

    const marker = new google.maps.Marker({
      position,
      map,
      title: loc.name,
    });
    marker.addListener("click", () => {
      infoWindow.setContent(
        `<strong>${escapeHtml(loc.name)}</strong><br>${escapeHtml(loc.address || "")}` +
          (loc.rating ? `<br>Rating: ${loc.rating}` : "")
      );
      infoWindow.open(map, marker);
    });
    markers.push(marker);

    const circle = new google.maps.Circle({
      center: position,
      radius: radiusMeters,
      map,
      strokeColor: "#2e7d32",
      strokeOpacity: 0.8,
      strokeWeight: 1,
      fillColor: "#388e3c",
      fillOpacity: 0.18,
    });
    circles.push(circle);
  });
}

function computeAndRenderCoverage(regionGeometry, locations, radiusMiles) {
  try {
    const regionFeature = turf.feature(regionGeometry);

    if (!locations.length) {
      drawUncovered(regionFeature);
      return;
    }

    let unioned = turf.circle(
      [locations[0].lng, locations[0].lat],
      radiusMiles,
      { steps: 64, units: "miles" }
    );

    for (let i = 1; i < locations.length; i++) {
      const c = turf.circle(
        [locations[i].lng, locations[i].lat],
        radiusMiles,
        { steps: 64, units: "miles" }
      );
      try {
        const merged = turf.union(unioned, c);
        if (merged) unioned = merged;
      } catch (e) {
        // Skip circles that fail to merge (e.g. degenerate geometry) rather
        // than aborting the whole coverage calculation.
        console.warn("turf.union failed for one circle, skipping it", e);
      }
    }

    const uncovered = turf.difference(regionFeature, unioned);
    if (uncovered) {
      drawUncovered(uncovered);
    }
  } catch (err) {
    console.warn("Coverage shading skipped due to a geometry error:", err);
    setStatus(
      "Locations and radii are plotted, but the uncovered-area shading " +
        "could not be computed for this search.",
      true
    );
  }
}

function drawUncovered(feature) {
  uncoveredLayer = new google.maps.Data();
  uncoveredLayer.addGeoJson(feature);
  uncoveredLayer.setStyle({
    fillColor: "#d32f2f",
    fillOpacity: 0.28,
    strokeColor: "#c62828",
    strokeWeight: 1,
  });
  uncoveredLayer.setMap(map);
}

function renderResultsList(locations, radiusMiles) {
  const container = document.getElementById("results");
  const count = locations.length;

  let html = `<h2>${count} location${count === 1 ? "" : "s"} found</h2>`;
  if (count === 0) {
    html += `<p>No matching locations turned up in this area, so the whole area is shown as uncovered.</p>`;
  } else {
    html += locations
      .map(
        (loc) => `
      <div class="result-item">
        <div class="name">${escapeHtml(loc.name)}</div>
        <div class="addr">${escapeHtml(loc.address || "")}</div>
      </div>`
      )
      .join("");
  }
  container.innerHTML = html;

  setStatus(`Showing ${count} location${count === 1 ? "" : "s"} with a ${radiusMiles}-mile radius.`);
}

function fitMapToBbox(bbox) {
  const [south, west, north, east] = bbox;
  const bounds = new google.maps.LatLngBounds(
    { lat: south, lng: west },
    { lat: north, lng: east }
  );
  map.fitBounds(bounds);
}

function polygonPathToGeoJSON(path) {
  const coords = path.map((p) => [p.lng, p.lat]);
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    coords.push(first);
  }
  return { type: "Polygon", coordinates: [coords] };
}

function polygonPathBbox(path) {
  const lats = path.map((p) => p.lat);
  const lngs = path.map((p) => p.lng);
  return [Math.min(...lats), Math.min(...lngs), Math.max(...lats), Math.max(...lngs)];
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}
