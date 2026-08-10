/** Configuration. Change deployment-specific values here. */

/**
 * The prebuilt dataset, served as a static file.
 *
 * Rebuild it with `go run ./tools/build-dataset`.
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
 * Shortest path the dataset contains.
 *
 * The builder drops anything below this, which halves the download, so the
 * filter cannot go lower. Must match minLengthM in tools/build-dataset/main.go.
 */
export const MIN_LENGTH_M = 25;

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

/**
 * Most result cards to put in the sidebar. The map draws everything in view;
 * this only caps the list.
 */
export const MAX_LIST_ITEMS = 50;

/**
 * Smallest share of a group's length a kind needs before the card mentions it.
 *
 * A fifth of groups mix kinds, but usually trivially: the median minority stretch
 * is 10.7 m, and in 32% of mixed groups the minority is under 10% of the length.
 * A "Holztreppe" pill for 7 m of steps onto a 400 m boardwalk is noise. At 10%
 * the groups that keep a second pill are the ones where it means something —
 * Pietzmoor is 41% wooden bridge, Seebrücke Lubmin 23% pier.
 */
export const MIN_KIND_SHARE = 0.1;
