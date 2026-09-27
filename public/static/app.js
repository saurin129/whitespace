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
const MAX_SELECTED_ZIPS = 3;
let zctaLayer = null; // google.maps.Data, all ZCTAs for the currently selected state
let selectedZips = []; // [{ zip, feature: <GeoJSON Feature> }, ...] in click order, max 3
let zipPanel, zipChips;

function initMap() {
  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 39.5, lng: -98.35 }, // continental US
    zoom: 4,
    mapTypeControl: false,
    streetViewControl: false,
  });
  infoWindow = new google.maps.InfoWindow();
  stateSelect = document.getElementById("state-select");
  zipPanel = document.getElementById("zip-panel");
  zipChips = document.getElementById("zip-chips");

  document.getElementById("search-form").addEventListener("submit", onSearch);
  stateSelect.addEventListener("change", onStateChange);

  drawBtn = document.getElementById("draw-btn");
  finishDrawBtn = document.getElementById("finish-draw-btn");
  clearDrawBtn = document.getElementById("clear-draw-btn");

  drawBtn.addEventListener("click", startDrawing);
  finishDrawBtn.addEventListener("click", finishDrawing);
  clearDrawBtn.addEventListener("click", onClearOrCancelClick);
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
}

function getDrawnPolygonPath() {
  if (!drawnPolygon) return null;
  const path = drawnPolygon.getPath().getArray().map((ll) => ({ lat: ll.lat(), lng: ll.lng() }));
  return path.length >= 3 ? path : null;
}

async function onStateChange() {
  const stateCode = stateSelect.value;
  clearZipSelection();

  if (!stateCode) {
    if (zctaLayer) {
      zctaLayer.setMap(null);
      zctaLayer = null;
    }
    zipPanel.classList.add("hidden");
    return;
  }

  zipPanel.classList.remove("hidden");
  setStatus("Loading ZIP code boundaries…");

  try {
    const zctaResp = await fetch(`/api/zctas?state=${encodeURIComponent(stateCode)}`).then(parseJsonOrThrow);
    renderZctaLayer(zctaResp.geojson);

    const boundaryResp = await fetch(`/api/state-boundary?state=${encodeURIComponent(stateCode)}`).then(parseJsonOrThrow);
    fitMapToBbox(boundaryResp.bbox);

    setStatus("Click up to 3 ZIP codes on the map.");
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Could not load ZIP code boundaries for this state.", true);
  }
}

function renderZctaLayer(geojson) {
  if (zctaLayer) {
    zctaLayer.setMap(null);
  }
  zctaLayer = new google.maps.Data();
  zctaLayer.addGeoJson(geojson);
  zctaLayer.forEach(styleZctaFeature);
  zctaLayer.setMap(map);

  zctaLayer.addListener("mouseover", (e) => {
    zctaLayer.overrideStyle(e.feature, { strokeWeight: 2.5, fillOpacity: 0.25 });
    const zip = e.feature.getProperty("ZCTA5");
    if (zip) setStatus(`ZIP ${zip}${isZipSelected(zip) ? " (selected)" : " — click to select"}`);
  });
  zctaLayer.addListener("mouseout", (e) => {
    zctaLayer.revertStyle(e.feature);
    styleZctaFeature(e.feature);
  });
  zctaLayer.addListener("click", (e) => onZctaClick(e.feature));
}

function styleZctaFeature(feature) {
  const selected = isZipSelected(feature.getProperty("ZCTA5"));
  zctaLayer.overrideStyle(feature, {
    fillColor: selected ? "#3866f2" : "#9aa0b4",
    fillOpacity: selected ? 0.3 : 0.05,
    strokeColor: selected ? "#3866f2" : "#9aa0b4",
    strokeWeight: selected ? 2 : 1,
  });
}

function isZipSelected(zip) {
  return selectedZips.some((z) => z.zip === zip);
}

function onZctaClick(feature) {
  const zip = feature.getProperty("ZCTA5");
  if (!zip) return;

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
  const rings = feature
    .getGeometry()
    .getArray()
    .map((ring) => ring.getArray().map((ll) => [ll.lng(), ll.lat()]));
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: rings } };
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
    z.feature.geometry.coordinates[0].forEach(([lng, lat]) => bounds.extend({ lat, lng }));
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
    btn.disabled = false;
  }
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
    msg += " Note: at least one ZIP needed more sub-searches than the cap allows, so results there may be incomplete.";
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
    msg += " Note: the drawn area was large enough that some of it may not have been searched.";
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
