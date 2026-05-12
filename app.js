const OVERPASS_ENDPOINTS = [
  {
    name: "Main Overpass",
    url: "https://overpass-api.de/api/interpreter",
  },
  {
    name: "Private.coffee Overpass",
    url: "https://overpass.private.coffee/api/interpreter",
  },
];

const SEARCHABLE_HIGHWAYS =
  "^(footway|path|cycleway|bridleway|pedestrian|steps|track)$";
const NAME_REGEX = "(Bohlenweg|Bohlensteg|Holzsteg|Moorsteg|Moorstege|boardwalk|plank)";
const EXACT_NAME_CANDIDATES = [
  "Bohlenweg",
  "Bohlensteg",
  "Holzsteg",
  "Moorsteg",
  "Moorstege",
  "Boardwalk",
  "boardwalk",
];
const ENDPOINT_JOIN_METERS = 20;
const REQUEST_TIMEOUT_MS = 18000;

const state = {
  map: null,
  resultLayer: null,
  searchMarker: null,
  searchCircle: null,
  selectedPoint: null,
  selectedGroupId: null,
  suppressMovePrompt: false,
  suppressMovePromptTimer: null,
  resultGroups: [],
};

const els = {};

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  initMap();
  bindEvents();
  renderResults([]);
});

function cacheElements() {
  els.locateButton = document.querySelector("#locateButton");
  els.searchButton = document.querySelector("#searchButton");
  els.mapSearchButton = document.querySelector("#mapSearchButton");
  els.radiusSelect = document.querySelector("#radiusSelect");
  els.minLengthSelect = document.querySelector("#minLengthSelect");
  els.status = document.querySelector("#status");
  els.resultsList = document.querySelector("#resultsList");
  els.resultCount = document.querySelector("#resultCount");
  els.longestLength = document.querySelector("#longestLength");
}

function initMap() {
  state.map = L.map("map", {
    zoomControl: true,
  }).setView([51.1657, 10.4515], 6);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    maxZoom: 20,
    subdomains: "abcd",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(state.map);

  state.resultLayer = L.layerGroup().addTo(state.map);

  state.map.on("click", (event) => {
    setSearchPoint(event.latlng, "Map point selected.");
  });

  state.map.on("moveend", handleMapMoveEnd);
}

function bindEvents() {
  els.locateButton.addEventListener("click", locateUser);
  els.searchButton.addEventListener("click", () => {
    const point = isMapSearchPromptVisible()
      ? state.map.getCenter()
      : state.selectedPoint || state.map.getCenter();
    setSearchPoint(point, "Searching from selected map position.");
    runSearch(point);
  });

  els.mapSearchButton.addEventListener("click", () => {
    const point = state.map.getCenter();
    setSearchPoint(point, "Searching from map center.");
    runSearch(point);
  });

  els.radiusSelect.addEventListener("change", () => {
    if (state.selectedPoint) {
      drawSearchArea(state.selectedPoint);
    }
  });

  els.minLengthSelect.addEventListener("change", () => {
    if (state.selectedPoint && state.resultGroups.length) {
      renderResults(filterGroups(state.resultGroups));
      drawResults(filterGroups(state.resultGroups));
    }
  });
}

function locateUser() {
  if (!navigator.geolocation) {
    setStatus("This browser does not expose geolocation.", "error");
    return;
  }

  setBusy(true);
  setStatus("Waiting for location permission...", "busy");

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const point = L.latLng(position.coords.latitude, position.coords.longitude);
      setMapViewQuietly(point, 13);
      setSearchPoint(point, "Location selected.");
      runSearch(point);
    },
    (error) => {
      setBusy(false);
      const message =
        error.code === error.PERMISSION_DENIED
          ? "Location permission denied. Click the map instead."
          : "Could not determine location. Click the map instead.";
      setStatus(message, "error");
    },
    {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 120000,
    },
  );
}

function setSearchPoint(point, message) {
  state.selectedPoint = L.latLng(point.lat, point.lng);
  hideMapSearchPrompt();
  drawSearchArea(state.selectedPoint);
  setStatus(message);
}

function drawSearchArea(point) {
  const radius = Number(els.radiusSelect.value);

  if (!state.searchMarker) {
    state.searchMarker = L.circleMarker(point, {
      radius: 7,
      color: "#ffffff",
      weight: 2,
      fillColor: "#315f49",
      fillOpacity: 1,
    }).addTo(state.map);
  } else {
    state.searchMarker.setLatLng(point);
  }

  if (!state.searchCircle) {
    state.searchCircle = L.circle(point, {
      radius,
      color: "#315f49",
      weight: 2,
      opacity: 0.88,
      fillColor: "#315f49",
      fillOpacity: 0.12,
      dashArray: "8 8",
    }).addTo(state.map);
  } else {
    state.searchCircle.setLatLng(point);
    state.searchCircle.setRadius(radius);
  }
}

async function runSearch(point) {
  const radius = Number(els.radiusSelect.value);
  const query = buildOverpassQuery(point, radius);

  setBusy(true);
  hideMapSearchPrompt();
  setStatus(`Searching OSM within ${formatDistance(radius)}...`, "busy");
  state.resultLayer.clearLayers();
  renderResults([]);

  try {
    const { data, endpointName } = await fetchOverpass(query);
    const ways = parseWays(data, point);
    const grouped = groupWays(ways, point);

    state.resultGroups = grouped.sort((a, b) => b.score - a.score);
    const visibleGroups = filterGroups(state.resultGroups);

    drawResults(visibleGroups);
    renderResults(visibleGroups);

    if (visibleGroups.length === 0) {
      setStatus(`No candidates found via ${endpointName}. Try a larger radius.`);
    } else {
      setStatus(`${visibleGroups.length} candidate groups found via ${endpointName}.`);
      fitResultBounds(visibleGroups, false);
    }
  } catch (error) {
    state.resultGroups = [];
    drawResults([]);
    renderResults([]);
    setStatus(error.message || "Overpass search failed.", "error");
  } finally {
    setBusy(false);
  }
}

function buildOverpassQuery(point, radius) {
  const lat = point.lat.toFixed(7);
  const lon = point.lng.toFixed(7);
  const exactNameQueries = EXACT_NAME_CANDIDATES.map(
    (name) =>
      `  way["name"="${escapeOverpassString(name)}"](around:${radius},${lat},${lon});`,
  ).join("\n");

  return `
[out:json][timeout:40];
(
  way["bridge"="boardwalk"](around:${radius},${lat},${lon});
  way["surface"="wood"](around:${radius},${lat},${lon});
  way["surface"="boardwalk"](around:${radius},${lat},${lon});
  way["boardwalk"="yes"](around:${radius},${lat},${lon});
  way["footway"="boardwalk"](around:${radius},${lat},${lon});
${exactNameQueries}
);
out tags geom;
`.trim();
}

async function fetchOverpass(query) {
  const errors = [];

  for (const endpoint of OVERPASS_ENDPOINTS) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        body: new URLSearchParams({ data: query }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`${endpoint.name} returned HTTP ${response.status}.`);
      }

      const data = await response.json();
      return { data, endpointName: endpoint.name };
    } catch (error) {
      if (controller.signal.aborted) {
        errors.push(
          `${endpoint.name}: timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s.`,
        );
      } else {
        errors.push(`${endpoint.name}: ${error.message}`);
      }
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  throw new Error(`Overpass search failed. ${errors.join(" ")}`);
}

function parseWays(data, origin) {
  const byId = new Map();

  for (const element of data.elements || []) {
    if (element.type !== "way" || !Array.isArray(element.geometry)) {
      continue;
    }

    if (element.geometry.length < 2 || byId.has(element.id)) {
      continue;
    }

    const tags = element.tags || {};
    if (!isRelevantHighway(tags)) {
      continue;
    }

    const geometry = element.geometry.map((point) => L.latLng(point.lat, point.lon));
    const lengthM = lineLength(geometry);

    byId.set(element.id, {
      id: element.id,
      tags,
      nodes: Array.isArray(element.nodes) ? element.nodes : [],
      geometry,
      lengthM,
      confidence: confidenceFor(tags),
      distanceM: minDistanceToLine(origin, geometry),
      endpoints: endpointsFor(element, geometry),
    });
  }

  return Array.from(byId.values());
}

function confidenceFor(tags) {
  let score = 0;

  if (tags.bridge === "boardwalk") {
    score = Math.max(score, 3);
  }
  if (tags.surface === "wood") {
    score = Math.max(score, 2.5);
  }
  if (tags.boardwalk === "yes" || tags.footway === "boardwalk") {
    score = Math.max(score, 2);
  }
  if (tags.surface === "boardwalk") {
    score = Math.max(score, 1.5);
  }
  if (tags.name && new RegExp(NAME_REGEX, "i").test(tags.name)) {
    score = Math.max(score, 1.4);
  }

  return score || 1;
}

function groupWays(ways, origin) {
  if (ways.length === 0) {
    return [];
  }

  const dsu = new DisjointSet(ways.length);

  for (let i = 0; i < ways.length; i += 1) {
    for (let j = i + 1; j < ways.length; j += 1) {
      if (areCompatible(ways[i], ways[j]) && areAdjacent(ways[i], ways[j])) {
        dsu.union(i, j);
      }
    }
  }

  const groups = new Map();

  ways.forEach((way, index) => {
    const root = dsu.find(index);
    if (!groups.has(root)) {
      groups.set(root, []);
    }
    groups.get(root).push(way);
  });

  return Array.from(groups.values()).map((groupWaysForResult, index) => {
    const totalLengthM = groupWaysForResult.reduce((sum, way) => sum + way.lengthM, 0);
    const distanceM = Math.min(...groupWaysForResult.map((way) => way.distanceM));
    const confidence = Math.max(...groupWaysForResult.map((way) => way.confidence));
    const score = totalLengthM + confidence * 75 - (distanceM / 1000) * 5;
    const bounds = L.latLngBounds(
      groupWaysForResult.flatMap((way) => way.geometry),
    );

    return {
      id: `group-${index}-${groupWaysForResult.map((way) => way.id).join("-")}`,
      ways: groupWaysForResult,
      title: titleFor(groupWaysForResult),
      totalLengthM,
      distanceM: minDistanceToLine(origin, groupWaysForResult.flatMap((way) => way.geometry)),
      confidence,
      confidenceLabel: confidenceLabel(confidence),
      score,
      bounds,
      tagSummary: summarizeTags(groupWaysForResult),
      layers: [],
    };
  });
}

function areCompatible(a, b) {
  const aName = normalizedName(a.tags.name);
  const bName = normalizedName(b.tags.name);

  if (aName && bName && aName !== bName) {
    return false;
  }

  if (aName && bName && aName === bName) {
    return true;
  }

  if (a.tags.bridge === "boardwalk" && b.tags.bridge === "boardwalk") {
    return true;
  }

  const bothWood = a.tags.surface === "wood" && b.tags.surface === "wood";
  const boardwalkish =
    isBoardwalkish(a.tags) &&
    isBoardwalkish(b.tags) &&
    !aName &&
    !bName;

  return bothWood || boardwalkish;
}

function areAdjacent(a, b) {
  for (const aEndpoint of a.endpoints) {
    for (const bEndpoint of b.endpoints) {
      if (
        aEndpoint.nodeId &&
        bEndpoint.nodeId &&
        aEndpoint.nodeId === bEndpoint.nodeId
      ) {
        return true;
      }

      if (aEndpoint.point.distanceTo(bEndpoint.point) <= ENDPOINT_JOIN_METERS) {
        return true;
      }
    }
  }

  return false;
}

function isBoardwalkish(tags) {
  return (
    tags.bridge === "boardwalk" ||
    tags.surface === "wood" ||
    tags.surface === "boardwalk" ||
    tags.boardwalk === "yes" ||
    tags.footway === "boardwalk" ||
    (tags.name && new RegExp(NAME_REGEX, "i").test(tags.name))
  );
}

function isRelevantHighway(tags) {
  return typeof tags.highway === "string" && new RegExp(SEARCHABLE_HIGHWAYS).test(tags.highway);
}

function endpointsFor(element, geometry) {
  return [
    {
      nodeId: element.nodes?.[0],
      point: geometry[0],
    },
    {
      nodeId: element.nodes?.[element.nodes.length - 1],
      point: geometry[geometry.length - 1],
    },
  ];
}

function filterGroups(groups) {
  const minLength = Number(els.minLengthSelect.value);
  return groups.filter((group) => group.totalLengthM >= minLength);
}

function drawResults(groups) {
  state.resultLayer.clearLayers();

  for (const group of groups) {
    group.layers = group.ways.map((way) => {
      const layer = L.polyline(way.geometry, styleForGroup(group)).addTo(
        state.resultLayer,
      );

      layer.on("click", () => selectGroup(group.id, true));
      layer.bindPopup(`
        <p class="popup-title">${escapeHtml(group.title)}</p>
        <p class="popup-meta">${formatDistance(group.totalLengthM)} total</p>
      `);

      return layer;
    });
  }
}

function renderResults(groups) {
  els.resultCount.textContent = String(groups.length);
  els.longestLength.textContent =
    groups.length > 0
      ? formatDistance(Math.max(...groups.map((group) => group.totalLengthM)))
      : "0 m";

  if (groups.length === 0) {
    els.resultsList.innerHTML =
      '<li class="empty-state">No Bohlenwege listed yet.</li>';
    return;
  }

  els.resultsList.innerHTML = groups.map(resultTemplate).join("");

  for (const item of els.resultsList.querySelectorAll("[data-group-id]")) {
    item.addEventListener("click", () => {
      selectGroup(item.dataset.groupId, true);
    });
  }
}

function resultTemplate(group, index) {
  const firstWay = group.ways[0];
  const extraWays = group.ways.length > 1 ? `+${group.ways.length - 1} more` : "";
  const tags = group.tagSummary
    .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
    .join("");

  return `
    <li
      class="result-card${state.selectedGroupId === group.id ? " is-selected" : ""}"
      data-group-id="${escapeHtml(group.id)}"
      tabindex="0"
    >
      <div class="result-topline">
        <h2 class="result-title">${index + 1}. ${escapeHtml(group.title)}</h2>
        <span class="result-length">${formatDistance(group.totalLengthM)}</span>
      </div>
      <div class="result-meta">
        <span class="pill ${group.confidenceLabel.toLowerCase()}">${group.confidenceLabel}</span>
        <span class="pill">${formatDistance(group.distanceM)} away</span>
        <span class="pill">${group.ways.length} segment${group.ways.length === 1 ? "" : "s"}</span>
      </div>
      <div class="tag-list">${tags}</div>
      <div class="result-links">
        <a href="https://www.openstreetmap.org/way/${firstWay.id}" target="_blank" rel="noreferrer">OSM way ${firstWay.id}</a>
        ${extraWays ? `<span class="pill">${extraWays}</span>` : ""}
      </div>
    </li>
  `;
}

function selectGroup(groupId, fitBounds) {
  state.selectedGroupId = groupId;

  for (const group of state.resultGroups) {
    for (const layer of group.layers || []) {
      layer.setStyle(styleForGroup(group));
    }
  }

  const selected = state.resultGroups.find((group) => group.id === groupId);
  if (!selected) {
    return;
  }

  for (const layer of selected.layers || []) {
    layer.setStyle({
      color: "#a44a3f",
      weight: 7,
      opacity: 0.95,
    });
    layer.bringToFront();
  }

  if (fitBounds) {
    state.map.fitBounds(selected.bounds.pad(0.18), { maxZoom: 16 });
  }

  for (const card of els.resultsList.querySelectorAll(".result-card")) {
    card.classList.toggle("is-selected", card.dataset.groupId === groupId);
  }
}

function fitResultBounds(groups, includeSearchArea) {
  if (!groups.length) {
    return;
  }

  const bounds = groups.reduce(
    (acc, group) => acc.extend(group.bounds),
    L.latLngBounds([]),
  );

  if (includeSearchArea && state.searchCircle) {
    bounds.extend(state.searchCircle.getBounds());
  }

  fitMapBoundsQuietly(bounds.pad(0.12), { maxZoom: 14 });
}

function handleMapMoveEnd() {
  if (state.suppressMovePrompt) {
    clearMovePromptSuppression();
    return;
  }

  if (els.searchButton.disabled) {
    return;
  }

  const center = state.map.getCenter();
  const referencePoint = state.selectedPoint;
  const moveThreshold = Math.max(90, Number(els.radiusSelect.value) * 0.015);

  if (!referencePoint || referencePoint.distanceTo(center) > moveThreshold) {
    showMapSearchPrompt();
  }
}

function setMapViewQuietly(point, zoom) {
  suppressNextMovePrompt();
  state.map.setView(point, zoom);
}

function fitMapBoundsQuietly(bounds, options) {
  suppressNextMovePrompt();
  state.map.fitBounds(bounds, options);
}

function suppressNextMovePrompt() {
  state.suppressMovePrompt = true;
  window.clearTimeout(state.suppressMovePromptTimer);
  state.suppressMovePromptTimer = window.setTimeout(clearMovePromptSuppression, 1000);
}

function clearMovePromptSuppression() {
  state.suppressMovePrompt = false;
  window.clearTimeout(state.suppressMovePromptTimer);
  state.suppressMovePromptTimer = null;
}

function showMapSearchPrompt() {
  els.mapSearchButton.hidden = false;
}

function hideMapSearchPrompt() {
  els.mapSearchButton.hidden = true;
}

function isMapSearchPromptVisible() {
  return !els.mapSearchButton.hidden;
}

function styleForGroup(group) {
  if (state.selectedGroupId === group.id) {
    return {
      color: "#a44a3f",
      weight: 7,
      opacity: 0.95,
    };
  }

  if (group.confidence >= 2.8) {
    return {
      color: "#315f49",
      weight: 5,
      opacity: 0.88,
    };
  }

  if (group.confidence >= 2) {
    return {
      color: "#197278",
      weight: 5,
      opacity: 0.86,
    };
  }

  return {
    color: "#b7791f",
    weight: 5,
    opacity: 0.82,
    dashArray: "6 6",
  };
}

function titleFor(ways) {
  const names = ways
    .map((way) => way.tags.name)
    .filter(Boolean)
    .map((name) => name.trim());

  if (names.length) {
    return mostCommon(names);
  }

  if (ways.some((way) => way.tags.bridge === "boardwalk")) {
    return "Boardwalk candidate";
  }

  if (ways.some((way) => way.tags.surface === "wood")) {
    return "Wooden path candidate";
  }

  return "Bohlenweg candidate";
}

function summarizeTags(ways) {
  const wantedKeys = ["name", "highway", "bridge", "surface", "boardwalk", "footway"];
  const tags = [];

  for (const key of wantedKeys) {
    const values = unique(
      ways
        .map((way) => way.tags[key])
        .filter(Boolean)
        .map((value) => String(value)),
    );

    for (const value of values.slice(0, 2)) {
      tags.push(`${key}=${value}`);
    }
  }

  return tags.slice(0, 7);
}

function confidenceLabel(confidence) {
  if (confidence >= 2.8) {
    return "High";
  }
  if (confidence >= 2) {
    return "Medium";
  }
  return "Loose";
}

function lineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += points[i - 1].distanceTo(points[i]);
  }
  return total;
}

function minDistanceToLine(origin, points) {
  if (!points.length) {
    return 0;
  }

  return Math.min(...points.map((point) => origin.distanceTo(point)));
}

function formatDistance(meters) {
  if (!Number.isFinite(meters)) {
    return "0 m";
  }

  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(meters >= 10000 ? 0 : 1)} km`;
  }

  return `${Math.round(meters)} m`;
}

function setBusy(isBusy) {
  els.locateButton.disabled = isBusy;
  els.searchButton.disabled = isBusy;
  els.mapSearchButton.disabled = isBusy;
}

function setStatus(message, kind = "") {
  els.status.classList.toggle("is-error", kind === "error");
  els.status.classList.toggle("is-busy", kind === "busy");

  if (kind === "busy") {
    els.status.innerHTML = `
      <span class="loading-spinner" aria-hidden="true">
        <span></span>
        <span></span>
        <span></span>
      </span>
      <span>${escapeHtml(message)}</span>
    `;
    return;
  }

  els.status.textContent = message;
}

function normalizedName(name) {
  return name ? name.trim().toLowerCase() : "";
}

function unique(values) {
  return Array.from(new Set(values));
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }

  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0];
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeOverpassString(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

class DisjointSet {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, index) => index);
    this.rank = Array.from({ length: size }, () => 0);
  }

  find(value) {
    if (this.parent[value] !== value) {
      this.parent[value] = this.find(this.parent[value]);
    }
    return this.parent[value];
  }

  union(a, b) {
    const rootA = this.find(a);
    const rootB = this.find(b);

    if (rootA === rootB) {
      return;
    }

    if (this.rank[rootA] < this.rank[rootB]) {
      this.parent[rootA] = rootB;
    } else if (this.rank[rootA] > this.rank[rootB]) {
      this.parent[rootB] = rootA;
    } else {
      this.parent[rootB] = rootA;
      this.rank[rootA] += 1;
    }
  }
}
