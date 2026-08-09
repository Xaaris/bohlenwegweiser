/**
 * Everything Leaflet-specific.
 *
 * The rest of the app works with plain `{lat, lon}` points, so this is the only
 * file that needs to know about Leaflet's `LatLng`, layers and styling.
 */

import L from "leaflet";
import "leaflet/dist/leaflet.css";

import { DEFAULT_CENTER, DEFAULT_ZOOM, TILE_ATTRIBUTION, TILE_URL } from "./config.js";
import { formatDistance } from "./geo.js";
import type { Bounds, Confidence, Group, Point } from "./types.js";

/* Line colours follow the logo's wood brown, with distinguishable tones for the
 * lower confidence levels. Kept in step with the palette in styles.css by hand,
 * since CSS variables are not readable from here. */
const LINE_STYLES: Record<Confidence, L.PolylineOptions> = {
  high: { color: "#532d14", weight: 5, opacity: 0.9 },
  medium: { color: "#8a6a3f", weight: 5, opacity: 0.88 },
  low: { color: "#b7791f", weight: 5, opacity: 0.84, dashArray: "6 6" },
};

const SELECTED_STYLE: L.PolylineOptions = { color: "#a44a3f", weight: 7, opacity: 0.96 };

export type MapCallbacks = {
  /** Fires after any pan or zoom, and once on startup. */
  onViewChange: () => void;
  onGroupClick: (groupId: string) => void;
};

export class BoardwalkMap {
  private map: L.Map;
  private resultLayer = L.layerGroup();
  private lines = new Map<string, { group: Group; layers: L.Polyline[] }>();

  constructor(containerId: string, callbacks: MapCallbacks) {
    this.map = L.map(containerId).setView(
      [DEFAULT_CENTER.lat, DEFAULT_CENTER.lon],
      DEFAULT_ZOOM,
    );

    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(this.map);
    L.control.scale({ imperial: false }).addTo(this.map);
    this.resultLayer.addTo(this.map);

    // Leaflet fires moveend for zooms too, so this covers both.
    this.map.on("moveend", callbacks.onViewChange);

    this.onGroupClick = callbacks.onGroupClick;
  }

  private onGroupClick: (groupId: string) => void;

  get zoom(): number {
    return this.map.getZoom();
  }

  /** Centre of the current view. */
  get center(): Point {
    const c = this.map.getCenter();
    return { lat: c.lat, lon: c.lng };
  }

  /** The currently visible area. */
  get bounds(): Bounds {
    const b = this.map.getBounds();
    return {
      minLat: b.getSouth(),
      minLon: b.getWest(),
      maxLat: b.getNorth(),
      maxLon: b.getEast(),
    };
  }

  /** Tells Leaflet the container size changed, e.g. after the sheet moved. */
  invalidateSize(): void {
    this.map.invalidateSize();
  }

  /**
   * Moves the view; the resulting moveend triggers a redraw.
   *
   * `offsetY` is how much of the map is covered by the bottom sheet, so the
   * target lands in the visible part rather than behind it.
   */
  moveTo(point: Point, zoom = this.map.getZoom(), offsetY = 0): void {
    const target = L.latLng(point.lat, point.lon);

    if (offsetY === 0) {
      this.map.setView(target, zoom);
      return;
    }

    // Convert to pixels at the target zoom, shift, and convert back.
    const shifted = this.map.unproject(
      this.map.project(target, zoom).add([0, offsetY / 2]),
      zoom,
    );
    this.map.setView(shifted, zoom);
  }

  fitTo(bounds: Bounds, maxZoom = 15): void {
    this.map.fitBounds(
      L.latLngBounds([bounds.minLat, bounds.minLon], [bounds.maxLat, bounds.maxLon]).pad(
        0.1,
      ),
      { maxZoom },
    );
  }

  /** Replaces all drawn results. */
  draw(groups: Group[]): void {
    this.resultLayer.clearLayers();
    this.lines.clear();

    for (const group of groups) {
      const layers = group.ways.map((way) => {
        const line = L.polyline(
          way.points.map((p) => [p.lat, p.lon] as [number, number]),
          LINE_STYLES[group.confidence],
        );

        line.bindTooltip(`${group.title} · ${formatDistance(group.lengthM)}`, {
          sticky: true,
        });
        line.on("click", (event) => {
          L.DomEvent.stopPropagation(event);
          this.onGroupClick(group.id);
        });

        line.addTo(this.resultLayer);

        // Keep the lines out of the tab order: Leaflet makes every interactive
        // path focusable, which put 16 tab stops before the first control with
        // just 7 results on screen, and a focused line offers no action anyway.
        // The same groups are reachable as buttons in the result list.
        line.getElement()?.setAttribute("tabindex", "-1");

        return line;
      });

      this.lines.set(group.id, { group, layers });
    }
  }

  /** Highlights one group, optionally zooming to it. */
  select(groupId: string | null, zoomTo = false): void {
    for (const [id, { group, layers }] of this.lines) {
      const style = id === groupId ? SELECTED_STYLE : LINE_STYLES[group.confidence];
      for (const layer of layers) {
        layer.setStyle(style);
        if (id === groupId) layer.bringToFront();
      }
    }

    const selected = groupId ? this.lines.get(groupId) : undefined;
    if (selected && zoomTo) this.fitTo(selected.group.bounds, 16);
  }
}
