/** Configuration. Change deployment-specific values here. */

/**
 * The prebuilt dataset, served as a static file.
 *
 * Rebuild it with `go run ./tools/build-dataset`. Querying Overpass per search
 * measured a median of 2.9 s with frequent timeouts; all of Germany is about
 * 1.3 MB gzipped, so it is loaded once instead.
 */
export const DATASET_URL = "boardwalks.json";

/** Base map tiles. */
export const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** Initial view: roughly all of Germany. */
export const DEFAULT_CENTER = { lat: 51.1657, lon: 10.4515 };
export const DEFAULT_ZOOM = 6;
export const DEFAULT_MIN_LENGTH_M = 50;

/**
 * Below this zoom level nothing is drawn.
 *
 * At zoom 10 the viewport covers roughly 80 km. Measured worst case (Berlin,
 * no length filter): 148 groups with the default filter, 837 without. Zoomed
 * further out it would be all 48,000 — slow to draw and useless to look at,
 * since the lines overlap into noise.
 */
export const MIN_ZOOM_FOR_RESULTS = 10;

/** OSM highway values that can plausibly be a boardwalk. */
export const RELEVANT_HIGHWAYS = [
  "footway",
  "path",
  "cycleway",
  "bridleway",
  "pedestrian",
  "steps",
  "track",
];

/**
 * Name fragments that hint at a boardwalk.
 *
 * The dataset builder has its own copy of this list; keep them in step.
 */
export const NAME_PATTERN =
  /(bohlenweg|bohlensteg|bohlenpfad|holzsteg|moorsteg|bretterweg|knüppeldamm|boardwalk)/i;

/** Way endpoints closer than this count as the same junction. */
export const JOIN_DISTANCE_M = 20;

/**
 * Most result cards to put in the sidebar.
 *
 * The map draws everything in view; this only caps the list, which nobody
 * scrolls past a few dozen entries anyway.
 */
export const MAX_LIST_ITEMS = 50;
