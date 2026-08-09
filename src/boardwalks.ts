/**
 * Turns dataset ways into boardwalk groups.
 *
 * Steps:
 *   1. parseWays       - measure each way and label how sure we are
 *   2. groupWays       - collect ways by the group id the builder assigned
 *   3. sort            - longest first
 *   4. groupsInBounds  - pick the ones the viewport shows
 *
 * Grouping happens over the whole dataset, once, not per viewport: a group
 * assembled from only the ways on screen reported a different length after every
 * pan (way/18963200 measured 3219 m at full extent but 1590 m with half of it off
 * screen) and could split into two cards. Filtering runs on finished groups.
 *
 * *Which* ways belong together is decided in tools/build-dataset and shipped as
 * a field per way, so this file no longer repeats the union-find over endpoint
 * distances. That copy had to be kept in step with group.go by hand, and cost
 * 29 ms on every page load; bucketing by the shipped id costs 12 ms, and both
 * were checked to produce the same 8357 groups.
 *
 * Deciding *whether* a way is a boardwalk also happens in the builder: the
 * dataset only contains ways that passed those filters. Repeating them here
 * dropped 0 of 15,256 ways, so the check was dead weight. What stays is the
 * labelling, because the UI shows it.
 */

import { boundsOf, boundsOverlap, lineLength } from "./geo.js";
import type { Bounds, Confidence, Group, RawWay, Tags, Way } from "./types.js";

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
      groupId: way.groupId,
      tags: way.tags,
      points: way.points,
      lengthM: lineLength(way.points),
      confidence: confidenceOf(way.tags),
    });
  }

  return result;
}

/**
 * Collects ways into groups by the builder's group id, longest first.
 *
 * Sorted by length alone, because that is what the cards show. Confidence is a
 * label of its own, and mixing it into the order only makes the list look wrong.
 */
export function groupWays(ways: Way[]): Group[] {
  const byGroup = new Map<number, Way[]>();

  for (const way of ways) {
    const members = byGroup.get(way.groupId);
    if (members) members.push(way);
    else byGroup.set(way.groupId, [way]);
  }

  return [...byGroup.values()].map(toGroup).sort((a, b) => b.lengthM - a.lengthM);
}

/**
 * Groups whose extent overlaps the given box.
 *
 * A box test on the finished group, so panning cannot change a group's length or
 * break it in two. Measured at 0.1 ms per pan, against 0.5 ms (a village) to
 * 1.4 ms (Hamburg) for the re-grouping this replaced.
 */
export function groupsInBounds(groups: Group[], bounds: Bounds): Group[] {
  return groups.filter((group) => boundsOverlap(group.bounds, bounds));
}

function toGroup(ways: Way[]): Group {
  const best = ways.reduce((acc, way) =>
    CONFIDENCE_RANK[way.confidence] > CONFIDENCE_RANK[acc.confidence] ? way : acc,
  );

  return {
    // The builder's group id: stable across rebuilds and independent of input
    // order, so a selection survives re-rendering.
    id: String((ways[0] as Way).groupId),
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
