/**
 * Loading and searching the prebuilt dataset.
 *
 * All of Germany is about 0.5 MB gzipped, so the browser downloads it once and
 * filters in memory rather than querying Overpass per search — which measured a
 * median of 2.9 s with regular timeouts, public instances being shared.
 *
 * Rebuild the file with: go run ./tools/build-dataset
 */

import { DATASET_URL } from "./config.js";
import type { Point, RawWay } from "./types.js";

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
    /** Group id; omitted when the way starts its own group. */
    c?: number;
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
        // The builder omits `c` when it equals the way's own id, which is the
        // common case: 8357 of 15,283 ways start their own group.
        groupId: w.c ?? w.i,
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
