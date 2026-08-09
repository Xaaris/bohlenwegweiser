import { describe, expect, it } from "vitest";

import { confidenceOf, groupsInBounds, groupWays, parseWays } from "../src/boardwalks.js";
import type { RawWay } from "../src/types.js";

/**
 * Builds a dataset way for tests.
 *
 * `groupId` defaults to the way's own id, which is how the builder encodes a way
 * that starts its own group. Pass it explicitly to put ways in one group.
 */
function way(
  id: number,
  tags: Record<string, string>,
  coords: [number, number][],
  groupId = id,
): RawWay {
  return {
    id,
    groupId,
    tags,
    points: coords.map(([lat, lon]) => ({ lat, lon })),
  };
}

/** A straight north-south line of roughly `meters` length. */
function line(lat: number, lon: number, meters: number): [number, number][] {
  return [
    [lat, lon],
    [lat + meters / 111_320, lon],
  ];
}

describe("confidenceOf", () => {
  it("rates an explicit boardwalk bridge highest", () => {
    expect(confidenceOf({ bridge: "boardwalk" })).toBe("high");
    expect(confidenceOf({ surface: "wood" })).toBe("high");
  });

  it("rates boardwalk hints in the middle", () => {
    expect(confidenceOf({ boardwalk: "yes" })).toBe("medium");
    expect(confidenceOf({ footway: "boardwalk" })).toBe("medium");
    expect(confidenceOf({ surface: "boardwalk" })).toBe("medium");
  });

  it("falls back to low, the name-only case", () => {
    // The builder only ships ways with some boardwalk evidence, so anything
    // without a telling tag got in on its name.
    expect(confidenceOf({ name: "Bohlenweg" })).toBe("low");
    expect(confidenceOf({ highway: "footway" })).toBe("low");
  });
});

describe("parseWays", () => {
  it("measures a way and labels it", () => {
    const ways = parseWays([
      way(1, { highway: "footway", bridge: "boardwalk" }, line(53, 8, 200)),
    ]);

    expect(ways).toHaveLength(1);
    expect(ways[0]!.lengthM).toBeGreaterThan(190);
    expect(ways[0]!.lengthM).toBeLessThan(210);
    expect(ways[0]!.confidence).toBe("high");
  });

  it("drops ways with too few points to be a line", () => {
    const ways = parseWays([
      way(1, { highway: "footway", bridge: "boardwalk" }, line(53, 8, 100)),
      way(2, { highway: "footway", bridge: "boardwalk" }, [[53, 8]]),
    ]);

    expect(ways.map((w) => w.id)).toEqual([1]);
  });

  it("carries the builder's group id through", () => {
    const ways = parseWays([
      way(7, { highway: "footway", bridge: "boardwalk" }, line(53, 8, 100), 3),
    ]);

    expect(ways[0]!.groupId).toBe(3);
  });
});

describe("groupWays", () => {
  it("returns nothing for no ways", () => {
    expect(groupWays([])).toEqual([]);
  });

  it("merges ways that share a group id", () => {
    // The builder decided these belong together; the browser just collects them.
    const ways = parseWays([
      way(1, { highway: "footway", bridge: "boardwalk" }, line(53, 8, 100), 1),
      way(2, { highway: "footway", bridge: "boardwalk" }, line(53.001, 8, 100), 1),
    ]);

    const groups = groupWays(ways);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.ways).toHaveLength(2);
    expect(groups[0]!.lengthM).toBeGreaterThan(190);
    expect(groups[0]!.id).toBe("1");
  });

  it("merges a whole chain of segments", () => {
    const ways = Array.from({ length: 5 }, (_, i) =>
      way(
        i + 1,
        { highway: "footway", bridge: "boardwalk" },
        [
          [53 + i * 0.001, 8],
          [53 + (i + 1) * 0.001, 8],
        ],
        1,
      ),
    );

    const groups = groupWays(parseWays(ways));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.ways).toHaveLength(5);
  });

  it("keeps ways with different group ids apart, however close they are", () => {
    // Touching but separately grouped: the builder ruled on this, e.g. because
    // the names differ, and the browser must not second-guess it.
    const ways = parseWays([
      way(1, { highway: "footway", surface: "wood", name: "Moorsteg" }, [
        [53, 8],
        [53.001, 8],
      ]),
      way(2, { highway: "footway", surface: "wood", name: "Holzsteg" }, [
        [53.001, 8],
        [53.002, 8],
      ]),
    ]);

    expect(groupWays(ways)).toHaveLength(2);
  });

  it("puts the longest group first", () => {
    const ways = parseWays([
      way(1, { highway: "footway", bridge: "boardwalk" }, line(53, 8, 100)),
      way(2, { highway: "footway", bridge: "boardwalk" }, line(53.3, 8.3, 900)),
    ]);

    const groups = groupWays(ways);
    expect(groups[0]!.lengthM).toBeGreaterThan(groups[1]!.lengthM);
  });

  it("sorts by length alone, ignoring confidence", () => {
    // The card shows the length, so mixing confidence into the order would put a
    // shorter way above a longer one and look like a bug.
    const ways = parseWays([
      // Name only, so low confidence, but the longest.
      way(1, { highway: "footway", name: "Bohlenweg" }, line(53, 8, 500)),
      way(2, { highway: "footway", bridge: "boardwalk" }, line(53.3, 8.3, 300)),
      way(3, { highway: "footway", surface: "wood" }, line(53.6, 8.6, 100)),
    ]);

    const groups = groupWays(ways);
    const lengths = groups.map((g) => Math.round(g.lengthM));

    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
    expect(groups[0]!.confidence).toBe("low");
  });

  it("gives the same id regardless of input order", () => {
    const a = way(1, { highway: "footway", bridge: "boardwalk" }, line(53, 8, 100), 1);
    const b = way(
      2,
      { highway: "footway", bridge: "boardwalk" },
      line(53.001, 8, 100),
      1,
    );

    const idOf = (ways: RawWay[]) => groupWays(parseWays(ways))[0]!.id;

    expect(idOf([a, b])).toBe(idOf([b, a]));
    expect(idOf([a, b])).toBe("1");
  });

  it("names a group after its way, or falls back to a label", () => {
    const named = parseWays([
      way(1, { highway: "footway", surface: "wood", name: "Moorsteg" }, line(53, 8, 100)),
    ]);
    expect(groupWays(named)[0]!.title).toBe("Moorsteg");

    const unnamed = parseWays([
      way(1, { highway: "footway", bridge: "boardwalk" }, line(53, 8, 100)),
    ]);
    expect(groupWays(unnamed)[0]!.title).toBe("Bohlenweg (unbenannt)");
  });

  it("assembles a branching network into one group", () => {
    // The builder joins ways that meet at *any* vertex, not just at an endpoint,
    // so a group can be a T rather than a chain. The browser must total every
    // branch and cover them all in the bounds — it has no notion of a main line.
    const ways = parseWays([
      // 100 m through-way running east, with a vertex in the middle.
      way(
        1,
        { highway: "footway", bridge: "boardwalk" },
        [
          [53, 8],
          [53, 8 + 50 / 74_000],
          [53, 8 + 100 / 74_000],
        ],
        1,
      ),
      // 40 m branch dropping south from that middle vertex, at a right angle.
      way(
        2,
        { highway: "footway", bridge: "boardwalk" },
        [
          [53, 8 + 50 / 74_000],
          [53 - 40 / 111_320, 8 + 50 / 74_000],
        ],
        1,
      ),
    ]);

    const groups = groupWays(ways);
    expect(groups).toHaveLength(1);

    const group = groups[0]!;
    expect(group.ways).toHaveLength(2);
    // 100 m + 40 m, so the branch is counted rather than treated as a detour.
    expect(group.lengthM).toBeGreaterThan(130);
    expect(group.lengthM).toBeLessThan(150);
    // The bounds have to reach south past the through-way to include the branch.
    expect(group.bounds.minLat).toBeLessThan(53);
  });

  it("stays fast with a lot of ways", () => {
    // Bucketing by group id is a single pass, where the union-find over endpoint
    // distances this replaced cost 29 ms for the real 15,713 ways.
    const ways = Array.from({ length: 15_000 }, (_, i) =>
      way(
        i + 1,
        { highway: "footway", bridge: "boardwalk" },
        line(53 + i * 0.0001, 8, 100),
        // Pairs share a group, so this also exercises the merging path.
        Math.floor(i / 2) * 2 + 1,
      ),
    );

    const started = Date.now();
    const groups = groupWays(parseWays(ways));

    expect(groups).toHaveLength(7500);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("groupsInBounds", () => {
  /** A chain of five 100 m segments running north from `lat`, in one group. */
  function chain(lat: number, lon: number, firstId = 1): RawWay[] {
    return Array.from({ length: 5 }, (_, i) =>
      way(
        firstId + i,
        { highway: "footway", bridge: "boardwalk" },
        [
          [lat + (i * 100) / 111_320, lon],
          [lat + ((i + 1) * 100) / 111_320, lon],
        ],
        firstId,
      ),
    );
  }

  it("keeps a partly visible group whole, at its full length", () => {
    // The bug this replaced: grouping the ways in view rebuilt the group from a
    // fragment, so way/18963200 reported 3219 m at full extent but 1590 m with
    // half of it off screen, and sometimes split into two cards.
    const all = groupWays(parseWays(chain(53, 8)));
    expect(all).toHaveLength(1);
    const full = all[0]!;

    // A box covering only the southern fifth of the group.
    const sliver = {
      minLat: 52.9,
      minLon: 7.9,
      maxLat: 53 + 50 / 111_320,
      maxLon: 8.1,
    };

    const inView = groupsInBounds(all, sliver);
    expect(inView).toHaveLength(1);
    expect(inView[0]!.lengthM).toBe(full.lengthM);
    expect(inView[0]!.ways).toHaveLength(5);
    expect(inView[0]!.id).toBe(full.id);
  });

  it("drops groups whose box is outside the view", () => {
    const groups = groupWays(parseWays([...chain(53, 8), ...chain(48, 9, 100)]));
    const view = { minLat: 52.9, minLon: 7.9, maxLat: 53.1, maxLon: 8.1 };

    expect(groupsInBounds(groups, view)).toHaveLength(1);
  });

  it("keeps a group that crosses the view with both ends outside", () => {
    // Every point lies outside the box, so a point-in-box test would drop it.
    const groups = groupWays(
      parseWays([
        way(1, { highway: "footway", bridge: "boardwalk" }, [
          [53, 7],
          [53, 9],
        ]),
      ]),
    );
    const view = { minLat: 52.9, minLon: 7.9, maxLat: 53.1, maxLon: 8.1 };

    expect(groupsInBounds(groups, view)).toHaveLength(1);
  });

  it("returns nothing when there are no groups", () => {
    expect(groupsInBounds([], { minLat: 52, minLon: 7, maxLat: 54, maxLon: 9 })).toEqual(
      [],
    );
  });
});
