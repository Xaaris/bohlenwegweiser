/**
 * Loading and searching the prebuilt dataset.
 *
 * This replaces the old per-search Overpass request. Querying Overpass live
 * measured a median of 2.9 s across five places, with regular timeouts, because
 * public instances are shared and unpredictable. All of Germany fits in about
 * 1.3 MB gzipped, so the app now downloads it once and searches in memory.
 *
 * Rebuild the file with: go run ./tools/build-dataset
 */

import { DATASET_URL } from "./config.js";
import type { Bounds, Point, RawWay } from "./types.js";

/** An error with a message that is safe and useful to show the user. */
export class SearchError extends Error {
  /** Whether retrying might work. */
  readonly retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = "SearchError";
    this.retryable = retryable;
  }
}

/** The dataset file as written by tools/build-dataset. */
type DatasetFile = {
  generated: string;
  osmBase?: string;
  /** minLat, minLon, maxLat, maxLon. */
  bbox: [number, number, number, number];
  ways: {
    i: number;
    n?: string;
    t?: Record<string, string>;
    /** Geometry as [lat, lon] pairs. */
    g: [number, number][];
  }[];
};

export type Dataset = {
  /** When the dataset was built. */
  generated: Date | null;
  /** Timestamp of the underlying OSM data. */
  osmBase: Date | null;
  bbox: [number, number, number, number];
  ways: RawWay[];
};

/** Shared so a second search reuses the first load instead of fetching again. */
let pending: Promise<Dataset> | null = null;

/**
 * Loads the dataset, at most once per page.
 *
 * Concurrent callers share one request; a failed load is forgotten so a retry
 * can try again.
 */
export function loadDataset(signal?: AbortSignal): Promise<Dataset> {
  pending ??= fetchDataset(signal).catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}

async function fetchDataset(signal?: AbortSignal): Promise<Dataset> {
  let response: Response;
  try {
    response = await fetch(DATASET_URL, { signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new SearchError("Die Wegedaten konnten nicht geladen werden.", true);
  }

  if (!response.ok) {
    throw new SearchError(
      `Die Wegedaten sind nicht verfügbar (HTTP ${response.status}).`,
      true,
    );
  }

  let file: DatasetFile;
  try {
    file = (await response.json()) as DatasetFile;
  } catch {
    throw new SearchError("Die Wegedaten sind beschädigt.", true);
  }

  if (!Array.isArray(file?.ways) || !Array.isArray(file?.bbox)) {
    throw new SearchError("Die Wegedaten haben ein unerwartetes Format.", true);
  }

  return {
    generated: parseDate(file.generated),
    osmBase: parseDate(file.osmBase),
    bbox: file.bbox,
    ways: file.ways.map(
      (w): RawWay => ({
        id: w.i,
        tags: { ...w.t, ...(w.n ? { name: w.n } : {}) },
        points: w.g.map(([lat, lon]) => ({ lat, lon })),
      }),
    ),
  };
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Ways whose extent overlaps the given box.
 *
 * Compares extents rather than testing individual points: a long way can cross
 * the viewport while all of its points lie outside.
 */
export function waysInBounds(dataset: Dataset, bounds: Bounds): RawWay[] {
  const found: RawWay[] = [];

  for (const way of dataset.ways) {
    if (overlaps(way.points, bounds)) found.push(way);
  }

  return found;
}

function overlaps(points: Point[], bounds: Bounds): boolean {
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;

  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  return (
    minLat <= bounds.maxLat &&
    maxLat >= bounds.minLat &&
    minLon <= bounds.maxLon &&
    maxLon >= bounds.minLon
  );
}

/** Whether the point lies inside the region the dataset covers. */
export function isCovered(dataset: Dataset, point: Point): boolean {
  const [minLat, minLon, maxLat, maxLon] = dataset.bbox;
  return (
    point.lat >= minLat &&
    point.lat <= maxLat &&
    point.lon >= minLon &&
    point.lon <= maxLon
  );
}
