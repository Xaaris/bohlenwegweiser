/**
 * Turns dataset ways into boardwalk groups.
 *
 * Steps:
 *   1. parseWays       - measure each way and classify what it is
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
 * a field per way, so this file no longer repeats the union-find over vertex
 * distances. That copy had to be kept in step with group.go by hand, and cost
 * 29 ms on every page load; bucketing by the shipped id costs 12 ms, and both
 * were checked to produce the same 8357 groups.
 *
 * Deciding *whether* a way is a boardwalk also happens in the builder: the
 * dataset only contains ways that passed those filters. Repeating them here
 * dropped 0 of 15,256 ways, so the check was dead weight. What stays is saying
 * what each one is, because the UI shows it.
 */

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
 * Sorted by length alone, because that is what the cards show and it is the only
 * key that does not move as the map does.
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
  const kind = dominantKind(ways);

  return {
    // The builder's group id: stable across rebuilds and independent of input
    // order, so a selection survives re-rendering.
    id: String((ways[0] as Way).groupId),
    title: titleOf(ways, kind),
    ways,
    lengthM: ways.reduce((sum, way) => sum + way.lengthM, 0),
    kind,
    bounds: boundsOf(ways.flatMap((way) => way.points)),
    tagSummary: summarizeTags(ways),
  };
}

/**
 * The kind that accounts for most of the group's length.
 *
 * By length, not by number of ways: 1577 groups mix kinds, and a 200 m boardwalk
 * with a 5 m bridge in the middle is a boardwalk. Counting ways would let a
 * handful of short segments outvote the thing you actually walk on.
 */
function dominantKind(ways: Way[]): Kind {
  const total = new Map<Kind, number>();

  for (const way of ways) {
    total.set(way.kind, (total.get(way.kind) ?? 0) + way.lengthM);
  }

  let best = (ways[0] as Way).kind;
  let bestLength = -1;
  for (const [kind, length] of total) {
    if (length > bestLength) {
      best = kind;
      bestLength = length;
    }
  }
  return best;
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
