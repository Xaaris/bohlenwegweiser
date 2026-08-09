/**
 * App wiring: draws whatever boardwalks are in view, renders the list.
 *
 * The interesting logic lives in boardwalks.ts (labelling, grouping and the
 * viewport filter) and dataset.ts (loading). This file is mostly DOM plumbing.
 */

import "./styles.css";

import { CONFIDENCE_LABELS, groupsInBounds, groupWays, parseWays } from "./boardwalks.js";
import {
  DEFAULT_MIN_LENGTH_M,
  MAX_LIST_ITEMS,
  MIN_LENGTH_M,
  MIN_ZOOM_FOR_RESULTS,
} from "./config.js";
import { type Dataset, isCovered, loadDataset, SearchError } from "./dataset.js";
import { formatDistance } from "./geo.js";
import { BoardwalkMap } from "./map.js";
import type { Group } from "./types.js";

/** Everything the UI needs to know. */
const state = {
  minLengthM: DEFAULT_MIN_LENGTH_M,
  /** Loaded once, then reused for every redraw. */
  dataset: null as Dataset | null,
  /**
   * Every group in the dataset, assembled once.
   *
   * Grouping the whole country up front rather than per viewport is what keeps a
   * group's length and identity stable while panning; see boardwalks.ts.
   */
  allGroups: [] as Group[],
  /** All groups in view, before the minimum-length filter. */
  groups: [] as Group[],
  /** Groups currently shown, after the filter. */
  visible: [] as Group[],
  selectedId: null as string | null,
  /** Lets us drop a load that a newer one has replaced. */
  inFlight: null as AbortController | null,
};

const el = {
  locate: byId<HTMLButtonElement>("locateButton"),
  minLength: byId<HTMLSelectElement>("minLengthSelect"),
  status: byId<HTMLParagraphElement>("status"),
  results: byId<HTMLOListElement>("results"),
  mapBusy: byId<HTMLDivElement>("mapBusy"),
  zoomHint: byId<HTMLDivElement>("zoomHint"),
  panel: document.querySelector<HTMLElement>(".panel"),
  sheetToggle: byId<HTMLButtonElement>("sheetToggle"),
  sheetLabel: document.querySelector<HTMLElement>(".sheet-label"),
  footer: document.querySelector<HTMLElement>(".panel > footer"),
};

function byId<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

const map = new BoardwalkMap("map", {
  onViewChange: () => void refresh(),
  onGroupClick: (id) => select(id, false),
});

el.locate.addEventListener("click", () => void locate());

el.sheetToggle.addEventListener("click", () => toggleSheet());

el.minLength.addEventListener("change", () => {
  // Clamped, because the dataset contains nothing shorter: the builder filtered
  // those out. A lower value here would just promise results that cannot exist.
  state.minLengthM = Math.max(MIN_LENGTH_M, Number(el.minLength.value));
  applyFilter();
  reportCount();
});

/** Collapses the sheet to just its handle and header, or opens it again. */
function toggleSheet(collapse = !isCollapsed()): void {
  const panel = el.panel;
  if (!panel) return;

  panel.classList.toggle("collapsed", collapse);
  el.sheetToggle.setAttribute("aria-expanded", String(!collapse));
  if (el.sheetLabel) {
    el.sheetLabel.textContent = collapse ? "Liste anzeigen" : "Liste einklappen";
  }

  // Leaflet needs to know the visible area changed, or clicks land in the wrong
  // place after the sheet moves.
  map.invalidateSize();
}

function isCollapsed(): boolean {
  return el.panel?.classList.contains("collapsed") ?? false;
}

// Draw whatever is in the initial view.
void refresh();

/** Asks the browser for the user's position and moves there. */
async function locate(): Promise<void> {
  if (!navigator.geolocation) {
    setStatus("Dieser Browser kann den Standort nicht bestimmen.", "error");
    return;
  }

  el.locate.disabled = true;
  setStatus("Warte auf Standortfreigabe …", "busy");

  try {
    const position = await new Promise<GeolocationPosition>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: false,
        timeout: 20_000,
        maximumAge: 300_000,
      });
    });

    // moveTo triggers a moveend, which redraws for the new view.
    map.moveTo(
      { lat: position.coords.latitude, lon: position.coords.longitude },
      Math.max(map.zoom, 13),
      hiddenMapHeight(),
    );
  } catch (error) {
    setStatus(locationErrorMessage(error), "error");
  } finally {
    el.locate.disabled = false;
  }
}

/**
 * How much of the map the bottom sheet covers, in pixels.
 *
 * Zero on wide screens, where the panel sits beside the map instead of over it.
 */
function hiddenMapHeight(): number {
  if (!isNarrow() || !el.panel || isCollapsed()) return 0;

  const covered = window.innerHeight - el.panel.getBoundingClientRect().top;
  return Math.max(0, Math.round(covered));
}

/**
 * Turns a GeolocationPositionError into something actionable.
 *
 * Worth distinguishing: a blocked permission is fixed in the browser settings,
 * a timeout by trying again.
 */
function locationErrorMessage(error: unknown): string {
  const code = (error as GeolocationPositionError | undefined)?.code;

  switch (code) {
    case 1: // PERMISSION_DENIED
      return "Standortzugriff ist blockiert. In den Browser-Einstellungen für diese Seite erlauben.";
    case 2: // POSITION_UNAVAILABLE
      return "Standort ließ sich nicht bestimmen. Ortungsdienste prüfen.";
    case 3: // TIMEOUT
      return "Standortabfrage hat zu lange gedauert. Noch einmal versuchen.";
    default:
      return "Standort nicht verfügbar. Karte verschieben oder hineinzoomen.";
  }
}

/**
 * Redraws for the current viewport.
 *
 * Called on every pan and zoom. The dataset is fetched and grouped on the first
 * call and both are kept, so a later call is only a box test per group —
 * measured under 1 ms for the whole country.
 */
async function refresh(): Promise<void> {
  if (map.zoom < MIN_ZOOM_FOR_RESULTS) {
    state.groups = [];
    state.selectedId = null;
    applyFilter();
    el.zoomHint.hidden = false;
    reportCount();
    return;
  }

  el.zoomHint.hidden = true;

  if (!state.dataset) {
    state.inFlight?.abort();
    const controller = new AbortController();
    state.inFlight = controller;

    el.mapBusy.hidden = false;
    setStatus("Lade Wegedaten …", "busy");

    try {
      const dataset = await loadDataset(controller.signal);
      // Grouped once, here, rather than per pan: a group built from only the
      // ways on screen changed length as the map moved. 12 ms for all 15,283
      // ways, inside the busy indicator, against 0.1 ms per pan afterwards.
      // Both fields are set together so a failure leaves neither half-filled.
      state.allGroups = groupWays(parseWays(dataset.ways));
      state.dataset = dataset;
    } catch (error) {
      if (controller.signal.aborted) return;

      const message =
        error instanceof SearchError ? error.message : "Die Suche ist fehlgeschlagen.";
      setStatus(message, "error", error instanceof SearchError && error.retryable);
      return;
    } finally {
      if (state.inFlight === controller) {
        el.mapBusy.hidden = true;
        state.inFlight = null;
      }
    }
  }

  state.groups = groupsInBounds(state.allGroups, map.bounds);
  applyFilter();
  reportCount();
}

/** Applies the minimum-length filter and redraws. */
function applyFilter(): void {
  state.visible = state.groups.filter((group) => group.lengthM >= state.minLengthM);

  // Forget a selection that is no longer on screen, whether the filter hid it or
  // the map moved away from it.
  if (!state.visible.some((group) => group.id === state.selectedId)) {
    state.selectedId = null;
  }

  map.draw(state.visible);
  // draw() rebuilt the layers, so the highlight has to be reapplied.
  if (state.selectedId) map.select(state.selectedId);
  render();
}

function select(groupId: string, zoomTo: boolean): void {
  state.selectedId = groupId;
  map.select(groupId, zoomTo);
  render();
}

/** Renders the result list. */
function render(): void {
  el.results.replaceChildren();

  if (state.visible.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = emptyReason();
    el.results.append(empty);
    appendAttribution();
    return;
  }

  // Cap the list: dense areas at the minimum zoom yield hundreds of groups,
  // which costs about 79 ms of layout for something nobody scrolls through. The
  // map still draws all of them.
  const shown = state.visible.slice(0, MAX_LIST_ITEMS);
  shown.forEach((group, index) => {
    el.results.append(resultCard(group, index));
  });

  if (state.visible.length > shown.length) {
    const more = document.createElement("li");
    more.className = "empty";
    more.textContent = `… und ${state.visible.length - shown.length} weitere. Hineinzoomen oder Mindestlänge erhöhen.`;
    el.results.append(more);
  }

  appendAttribution();
}

/**
 * On narrow screens the ODbL attribution goes at the end of the list, so it stays
 * reachable without taking 77 px of a short panel.
 */
function appendAttribution(): void {
  if (!el.footer || !isNarrow()) return;

  const item = document.createElement("li");
  item.className = "attribution";
  // Cloned so the desktop footer keeps working when the viewport widens again.
  item.append(...[...el.footer.cloneNode(true).childNodes]);
  el.results.append(item);
}

function isNarrow(): boolean {
  return window.matchMedia("(max-width: 820px)").matches;
}

/**
 * Builds one result card.
 *
 * Built with createElement and textContent rather than innerHTML, so OSM names
 * can never be interpreted as HTML.
 */
function resultCard(group: Group, index: number): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "card";
  if (group.id === state.selectedId) item.classList.add("selected");

  // A real button, so it works with keyboard and screen readers.
  const button = document.createElement("button");
  button.type = "button";
  button.className = "card-body";
  button.addEventListener("click", () => select(group.id, true));

  const top = document.createElement("span");
  top.className = "card-top";
  top.append(
    span("card-title", `${index + 1}. ${group.title}`),
    span("card-length", formatDistance(group.lengthM)),
  );

  const meta = document.createElement("span");
  meta.className = "card-meta";
  meta.append(
    span(`pill ${group.confidence}`, CONFIDENCE_LABELS[group.confidence]),
    span("pill", `${group.ways.length} Abschnitt${group.ways.length === 1 ? "" : "e"}`),
  );

  const tags = document.createElement("span");
  tags.className = "card-tags";
  for (const tag of group.tagSummary) tags.append(span("tag", tag));

  button.append(top, meta, tags);

  const link = document.createElement("a");
  link.className = "card-link";
  link.href = `https://www.openstreetmap.org/way/${group.ways[0]?.id}`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "In OpenStreetMap ansehen";

  item.append(button, link);
  return item;
}

function span(className: string, text: string): HTMLSpanElement {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = text;
  return node;
}

function setStatus(
  message: string,
  kind: "" | "busy" | "error" = "",
  retry = false,
): void {
  el.status.className = `status ${kind}`;
  el.status.textContent = message;

  if (retry) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "retry";
    button.textContent = "Erneut versuchen";
    button.addEventListener("click", () => void refresh());
    el.status.append(" ", button);
  }
}

/**
 * Why there is nothing to show. Shared by the list and the status line so the
 * two cannot contradict each other.
 */
function emptyReason(): string {
  if (map.zoom < MIN_ZOOM_FOR_RESULTS) {
    return "Hineinzoomen, um Bohlenwege zu sehen.";
  }
  if (state.groups.length > 0) {
    return "Keine Treffer über der Mindestlänge. Mindestlänge verringern.";
  }
  if (state.dataset && !isCovered(state.dataset, map.center)) {
    // Outside the dataset's region there is nothing to say about boardwalks, so
    // "none here" would claim more than we know.
    return "Dieser Bereich liegt außerhalb der Daten (nur Deutschland).";
  }
  return "Hier sind keine Bohlenwege verzeichnet.";
}

/** Puts the current result count into the status line. */
function reportCount(): void {
  if (state.visible.length > 0) {
    const longest = formatDistance(Math.max(...state.visible.map((g) => g.lengthM)));
    const label = state.visible.length === 1 ? "Bohlenweg" : "Bohlenwege";
    setStatus(`${state.visible.length} ${label}, längster ${longest}.`);
  } else {
    setStatus(emptyReason());
  }
}
