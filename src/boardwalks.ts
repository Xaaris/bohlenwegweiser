/**
 * Turns dataset ways into boardwalk groups.
 *
 * Steps:
 *   1. parseWays       - measure each way and classify what it is
 *   2. groupWays       - collect ways by the group id the builder assigned
 *   3. sort            - longest first
 *   4. groupsInBounds  - pick the ones the viewport shows
 *
 * Group over the whole dataset, then filter to the viewport — never the other way
 * round. A group assembled from only the ways on screen changes length as the map
 * moves: way/18963200 measures 3219 m at full extent but 1590 m with half of it
 * off screen, and can split into two cards.
 *
 * tools/build-dataset decides both *whether* a way is a boardwalk and *which*
 * ways belong together, so neither test lives here. This file measures, labels
 * and buckets by the shipped group id.
 */

import { MIN_KIND_SHARE } from "./config.js";
import { boundsOf, boundsOverlap, lineLength } from "./geo.js";
import type { Bounds, Group, Kind, RawWay, Tags, Way } from "./types.js";

/**
 * What kind of wooden structure a way is.
 *
 * The dataset is not all boardwalks: 5070 of 15,728 ways are wooden bridges and
 * 1861 are wooden stairs. `surface=wood` cannot tell them apart, because it is
 * near-universal in every kind (100% of bridges, 100% of steps, 97% of piers).
 * `highway` and `bridge` can, and both are already in the file.
 *
 * Order matters. `man_made=pier` wins over any bridge tag: 163 ways carry both,
 * and a jetty that happens to be built as a bridge is still a jetty — "Steg" is
 * the more useful word for it. Otherwise an explicit `bridge=boardwalk` beats
 * the geometry-led guesses below it.
 */
export function kindOf(tags: Tags): Kind {
  if (tags.man_made === "pier") return "pier";
  if (tags.bridge === "boardwalk") return "boardwalk";
  if (tags.highway === "steps") return "steps";
  if (tags.bridge) return "bridge";
  return "path";
}

/** German labels for the kinds, shown on the result card. */
export const KIND_LABELS: Record<Kind, string> = {
  boardwalk: "Bohlenweg",
  pier: "Steg",
  bridge: "Holzbrücke",
  steps: "Holztreppe",
  path: "Holzweg",
};

/** Measures the given ways and classifies each one. */
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
      kind: kindOf(way.tags),
    });
  }

  return result;
}

/**
 * Collects ways into groups by the builder's group id, longest first.
 *
 * Sorted by length alone: it is what the cards show, and the only key that does
 * not move as the map does.
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
 * break it in two. 0.1 ms per pan over the whole country.
 */
export function groupsInBounds(groups: Group[], bounds: Bounds): Group[] {
  return groups.filter((group) => boundsOverlap(group.bounds, bounds));
}

function toGroup(ways: Way[]): Group {
  const composition = compositionOf(ways);
  // Safe: a group always has at least one way, so composition is never empty.
  const kind = composition[0] as Kind;

  return {
    // The builder's group id: stable across rebuilds and independent of input
    // order, so a selection survives re-rendering.
    id: String((ways[0] as Way).groupId),
    title: titleOf(ways, kind),
    ways,
    lengthM: ways.reduce((sum, way) => sum + way.lengthM, 0),
    kind,
    composition,
    bounds: boundsOf(ways.flatMap((way) => way.points)),
    tagSummary: summarizeTags(ways),
  };
}

/**
 * What the group is made of, longest kind first.
 *
 * Ranked by length, not by number of ways: 1577 groups mix kinds, and a 200 m
 * boardwalk with a 5 m bridge in the middle is a boardwalk. Counting ways would
 * let a handful of short segments outvote the thing you actually walk on.
 *
 * Kinds under MIN_KIND_SHARE of the total are left out, so the first entry is the
 * group's kind and the rest are worth naming. Always at least one entry.
 */
export function compositionOf(ways: Way[]): Kind[] {
  const byKind = new Map<Kind, number>();
  let total = 0;

  for (const way of ways) {
    byKind.set(way.kind, (byKind.get(way.kind) ?? 0) + way.lengthM);
    total += way.lengthM;
  }

  const ranked = [...byKind.entries()].sort((a, b) => b[1] - a[1]);

  // A zero-length group cannot come from the builder, but guard the division
  // rather than filtering every kind out on a NaN comparison.
  const floor = total > 0 ? MIN_KIND_SHARE * total : 0;
  const worthNaming = ranked.filter(([, length]) => length >= floor);

  return (worthNaming.length > 0 ? worthNaming : ranked.slice(0, 1)).map(
    ([kind]) => kind,
  );
}

/** The group's own name, or a description of what it is. */
function titleOf(ways: Way[], kind: Kind): string {
  const name = ways.find((way) => way.tags.name)?.tags.name;
  if (name) return name.trim();

  // Named after what it is rather than always "Bohlenweg": a wooden bridge used
  // to be listed as "Holzweg (unbenannt)", which described neither.
  return `${KIND_LABELS[kind]} (unbenannt)`;
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
