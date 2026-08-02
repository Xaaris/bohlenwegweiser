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
 * Measured over Hamburg, the densest area, drawing every way in view:
 *
 *   zoom 10:  291 lines, no blocking
 *   zoom  9:  741 lines, no blocking
 *   zoom  8: 2559 lines, an 87 ms task that stalls the UI
 *
 * So 9 is the lowest level that still pans smoothly. Further out the lines also
 * overlap into noise, which makes them useless to look at anyway.
 */
export const MIN_ZOOM_FOR_RESULTS = 9;

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
