/**
 * Turns dataset ways into boardwalk groups.
 *
 * Steps:
 *   1. parseWays   - measure each way and label how sure we are
 *   2. groupWays   - merge ways that touch and look like the same path
 *   3. sort        - longest first
 *
 * Deciding *whether* a way is a boardwalk happens in tools/build-dataset: the
 * dataset only contains ways that passed those filters. Repeating them here
 * dropped 0 of 15,256 ways, so the check was dead weight. What stays is the
 * labelling, because the UI shows it.
 */

import { JOIN_DISTANCE_M } from "./config.js";
import { boundsOf, distance, lineLength } from "./geo.js";
import type { Confidence, Group, Point, RawWay, Tags, Way } from "./types.js";

/**
 * How strongly the tags suggest a boardwalk.
 *
 * OSM has no single canonical tag for a Bohlenweg, so this is a judgement call
 * shown to the user as "Sicher" / "Wahrscheinlich" / "Unsicher". Everything in
 * the dataset qualifies as at least "low", which is the name-only case.
 */
export function confidenceOf(tags: Tags): Confidence {
  if (tags.bridge === "boardwalk" || tags.surface === "wood") return "high";
  if (tags.boardwalk === "yes" || tags.footway === "boardwalk") return "medium";
  if (tags.surface === "boardwalk") return "medium";
  return "low";
}

export const CONFIDENCE_LABELS: Record<Confidence, string> = {
  high: "Sicher",
  medium: "Wahrscheinlich",
  low: "Unsicher",
};

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

/** Measures the given ways and labels each one. */
export function parseWays(ways: RawWay[]): Way[] {
  const result: Way[] = [];

  for (const way of ways) {
    // A single point cannot be drawn or measured. The builder drops these too;
    // this guards the rest of the file against a malformed dataset.
    if (way.points.length < 2) continue;

    result.push({
      id: way.id,
      tags: way.tags,
      points: way.points,
      lengthM: lineLength(way.points),
      confidence: confidenceOf(way.tags),
    });
  }

  return result;
}

/**
 * Merges connected ways into groups, longest first.
 *
 * Sorted by length alone, because that is what the cards show. Confidence is a
 * label of its own, and mixing it into the order only makes the list look wrong.
 */
export function groupWays(ways: Way[]): Group[] {
  return connectedComponents(ways)
    .map(toGroup)
    .sort((a, b) => b.lengthM - a.lengthM);
}

/**
 * Groups ways that are both adjacent and plausibly the same path.
 *
 * Only ways whose endpoints share a grid cell are compared, so this stays fast
 * even when a wide viewport contains thousands of ways.
 */
function connectedComponents(ways: Way[]): Way[][] {
  const cellSize = (JOIN_DISTANCE_M * 2) / 111_320; // degrees
  const grid = new Map<string, number[]>();

  const cellKey = (p: Point) =>
    `${Math.floor(p.lat / cellSize)}:${Math.floor(p.lon / cellSize)}`;

  const endpointsOf = (way: Way): Point[] => [
    way.points[0] as Point,
    way.points[way.points.length - 1] as Point,
  ];

  ways.forEach((way, index) => {
    for (const point of endpointsOf(way)) {
      const key = cellKey(point);
      const bucket = grid.get(key);
      if (bucket) bucket.push(index);
      else grid.set(key, [index]);
    }
  });

  const parent = ways.map((_, index) => index);

  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] as number;
    // Flatten the path so later lookups are cheap.
    let node = i;
    while (parent[node] !== root) {
      const next = parent[node] as number;
      parent[node] = root;
      node = next;
    }
    return root;
  };

  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  ways.forEach((way, index) => {
    for (const point of endpointsOf(way)) {
      // Check the point's own cell and the eight around it.
      const lat = Math.floor(point.lat / cellSize);
      const lon = Math.floor(point.lon / cellSize);

      for (let dLat = -1; dLat <= 1; dLat++) {
        for (let dLon = -1; dLon <= 1; dLon++) {
          for (const other of grid.get(`${lat + dLat}:${lon + dLon}`) ?? []) {
            if (other <= index) continue;
            const otherWay = ways[other] as Way;
            if (samePath(way, otherWay) && touches(way, otherWay)) {
              union(index, other);
            }
          }
        }
      }
    }
  });

  const components = new Map<number, Way[]>();
  ways.forEach((way, index) => {
    const root = find(index);
    const existing = components.get(root);
    if (existing) existing.push(way);
    else components.set(root, [way]);
  });

  return [...components.values()];
}

/** Whether two ways plausibly belong to the same path. */
function samePath(a: Way, b: Way): boolean {
  const nameA = a.tags.name?.trim().toLowerCase();
  const nameB = b.tags.name?.trim().toLowerCase();

  // Different names are a strong hint that these are different paths, even
  // where they meet.
  if (nameA && nameB) return nameA === nameB;

  if (a.tags.bridge === "boardwalk" && b.tags.bridge === "boardwalk") return true;
  if (a.tags.surface === "wood" && b.tags.surface === "wood") return true;

  return !nameA && !nameB;
}

/** Whether two ways have endpoints close enough to be the same junction. */
function touches(a: Way, b: Way): boolean {
  const endsA = [a.points[0] as Point, a.points[a.points.length - 1] as Point];
  const endsB = [b.points[0] as Point, b.points[b.points.length - 1] as Point];

  return endsA.some((pa) => endsB.some((pb) => distance(pa, pb) <= JOIN_DISTANCE_M));
}

function toGroup(ways: Way[]): Group {
  const best = ways.reduce((acc, way) =>
    CONFIDENCE_RANK[way.confidence] > CONFIDENCE_RANK[acc.confidence] ? way : acc,
  );

  return {
    // Sorted ids make the id stable regardless of input order, so a selection
    // survives re-rendering.
    id: ways
      .map((w) => w.id)
      .sort((a, b) => a - b)
      .join("-"),
    title: titleOf(ways),
    ways,
    lengthM: ways.reduce((sum, way) => sum + way.lengthM, 0),
    confidence: best.confidence,
    bounds: boundsOf(ways.flatMap((way) => way.points)),
    tagSummary: summarizeTags(ways),
  };
}

function titleOf(ways: Way[]): string {
  const name = ways.find((way) => way.tags.name)?.tags.name;
  if (name) return name.trim();

  if (ways.some((w) => w.tags.bridge === "boardwalk")) return "Bohlenweg (unbenannt)";
  if (ways.some((w) => w.tags.man_made === "pier")) return "Steg (unbenannt)";
  if (ways.some((w) => w.tags.surface === "wood")) return "Holzweg (unbenannt)";
  return "Möglicher Bohlenweg";
}

const SUMMARY_KEYS = ["highway", "man_made", "bridge", "surface", "boardwalk", "footway"];

function summarizeTags(ways: Way[]): string[] {
  const summary: string[] = [];

  for (const key of SUMMARY_KEYS) {
    const values = new Set(
      ways.map((way) => way.tags[key]).filter((v): v is string => v !== undefined),
    );
    for (const value of values) summary.push(`${key}=${value}`);
  }

  return summary.slice(0, 6);
}
