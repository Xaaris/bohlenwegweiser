import { describe, expect, it } from "vitest";

import {
  compositionOf,
  groupsInBounds,
  groupWays,
  kindOf,
  parseWays,
} from "../src/boardwalks.js";
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

describe("kindOf", () => {
  it("names the structure from the tags", () => {
    expect(kindOf({ bridge: "boardwalk" })).toBe("boardwalk");
    expect(kindOf({ man_made: "pier" })).toBe("pier");
    expect(kindOf({ highway: "steps", surface: "wood" })).toBe("steps");
    expect(kindOf({ bridge: "yes", surface: "wood" })).toBe("bridge");
    expect(kindOf({ highway: "footway", surface: "wood" })).toBe("path");
  });

  it("lets a pier win over any bridge tag", () => {
    // 163 ways carry both. A jetty built as a bridge is still a jetty, and
    // "Steg" is the more useful word for it.
    expect(kindOf({ man_made: "pier", bridge: "yes" })).toBe("pier");
    expect(kindOf({ man_made: "pier", bridge: "boardwalk" })).toBe("pier");
    expect(kindOf({ man_made: "pier", highway: "steps" })).toBe("pier");
  });

  it("prefers an explicit boardwalk over the generic bridge and steps cases", () => {
    expect(kindOf({ bridge: "boardwalk", highway: "steps" })).toBe("boardwalk");
  });

  it("does not rely on surface=wood, which every kind has", () => {
    // Measured: surface=wood covers 100% of bridges, 100% of steps, 97% of
    // piers, so it cannot separate them.
    expect(kindOf({ surface: "wood", bridge: "yes" })).toBe("bridge");
    expect(kindOf({ surface: "wood", highway: "steps" })).toBe("steps");
    expect(kindOf({ surface: "wood" })).toBe("path");
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
    expect(ways[0]!.kind).toBe("boardwalk");
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
    // Touching but separately grouped: whatever the builder decided, the browser
    // must not second-guess it. Only the builder knows why two neighbours are
    // separate — most often that they are simply more than 20 m apart somewhere.
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

  it("merges touching ways with different names when the builder grouped them", () => {
    // The inverse of an assertion this file used to make. Differing names no
    // longer block a join: "Steg West" and "Steg Ost" are one jetty, and the old
    // rule blocked 137 such pairs. The group takes the name of its first named
    // way, so the title is one of the two.
    const ways = parseWays([
      way(
        1,
        { highway: "footway", surface: "wood", name: "Steg West" },
        [
          [53, 8],
          [53.001, 8],
        ],
        1,
      ),
      way(
        2,
        { highway: "footway", surface: "wood", name: "Steg Ost" },
        [
          [53.001, 8],
          [53.002, 8],
        ],
        1,
      ),
    ]);

    const groups = groupWays(ways);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.ways).toHaveLength(2);
    expect(groups[0]!.title).toBe("Steg West");
  });

  it("puts the longest group first", () => {
    const ways = parseWays([
      way(1, { highway: "footway", bridge: "boardwalk" }, line(53, 8, 100)),
      way(2, { highway: "footway", bridge: "boardwalk" }, line(53.3, 8.3, 900)),
    ]);

    const groups = groupWays(ways);
    expect(groups[0]!.lengthM).toBeGreaterThan(groups[1]!.lengthM);
  });

  it("sorts by length alone, ignoring kind", () => {
    // The card shows the length, so ranking kinds would put a shorter way above
    // a longer one and look like a bug.
    const ways = parseWays([
      // A plain wooden path, but the longest.
      way(1, { highway: "footway", surface: "wood" }, line(53, 8, 500)),
      way(2, { highway: "footway", bridge: "boardwalk" }, line(53.3, 8.3, 300)),
      way(3, { man_made: "pier", surface: "wood" }, line(53.6, 8.6, 100)),
    ]);

    const groups = groupWays(ways);
    const lengths = groups.map((g) => Math.round(g.lengthM));

    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
    expect(groups[0]!.kind).toBe("path");
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

  it("names a group after its way, or after what it is", () => {
    const named = parseWays([
      way(1, { highway: "footway", surface: "wood", name: "Moorsteg" }, line(53, 8, 100)),
    ]);
    expect(groupWays(named)[0]!.title).toBe("Moorsteg");

    const unnamed = parseWays([
      way(1, { highway: "footway", bridge: "boardwalk" }, line(53, 8, 100)),
    ]);
    expect(groupWays(unnamed)[0]!.title).toBe("Bohlenweg (unbenannt)");
  });

  it("does not call a wooden bridge or a staircase a Holzweg", () => {
    // These used to be listed as "Holzweg (unbenannt)", which described neither.
    // 3237 groups are bridges and 572 are stairs, so this was most of the list.
    const bridge = parseWays([
      way(1, { highway: "footway", bridge: "yes", surface: "wood" }, line(53, 8, 100)),
    ]);
    expect(groupWays(bridge)[0]!.title).toBe("Holzbrücke (unbenannt)");
    expect(groupWays(bridge)[0]!.kind).toBe("bridge");

    const steps = parseWays([
      way(1, { highway: "steps", surface: "wood" }, line(53, 8, 40)),
    ]);
    expect(groupWays(steps)[0]!.title).toBe("Holztreppe (unbenannt)");

    const pier = parseWays([way(1, { man_made: "pier" }, line(53, 8, 80))]);
    expect(groupWays(pier)[0]!.title).toBe("Steg (unbenannt)");
  });

  it("gives a mixed group the kind that covers most of its length", () => {
    // 1577 groups mix kinds. A 400 m boardwalk with a 20 m bridge in the middle
    // is a boardwalk; counting ways instead of metres would let short segments
    // outvote the thing you actually walk on.
    const ways = parseWays([
      way(1, { highway: "footway", bridge: "boardwalk" }, line(53, 8, 400), 1),
      way(
        2,
        { highway: "footway", bridge: "yes", surface: "wood" },
        line(53.004, 8, 20),
        1,
      ),
      way(3, { highway: "steps", surface: "wood" }, line(53.0042, 8, 15), 1),
    ]);

    const groups = groupWays(ways);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe("boardwalk");
    expect(groups[0]!.ways).toHaveLength(3);
  });

  it("does not let a long staircase be outvoted by two short boardwalks", () => {
    // The rule is length, not a ranking of kinds: a group that is mostly stairs
    // should say so.
    const ways = parseWays([
      way(1, { highway: "steps", surface: "wood" }, line(53, 8, 300), 1),
      way(2, { highway: "footway", bridge: "boardwalk" }, line(53.003, 8, 30), 1),
      way(3, { highway: "footway", bridge: "boardwalk" }, line(53.0033, 8, 30), 1),
    ]);

    expect(groupWays(ways)[0]!.kind).toBe("steps");
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

describe("compositionOf", () => {
  it("reports a single kind as the whole group", () => {
    const ways = parseWays([
      way(1, { highway: "footway", bridge: "boardwalk" }, line(53, 8, 100), 1),
      way(2, { highway: "footway", bridge: "boardwalk" }, line(53.001, 8, 100), 1),
    ]);

    expect(compositionOf(ways)).toEqual([{ kind: "boardwalk", share: 1 }]);
  });

  it("orders kinds by share of length, longest first", () => {
    const ways = parseWays([
      way(1, { man_made: "pier" }, line(53, 8, 600), 1),
      way(
        2,
        { highway: "footway", bridge: "yes", surface: "wood" },
        line(53.01, 8, 300),
        1,
      ),
      way(3, { highway: "footway", surface: "wood" }, line(53.02, 8, 100), 1),
    ]);

    const composition = compositionOf(ways);
    expect(composition.map((c) => c.kind)).toEqual(["pier", "bridge", "path"]);
    expect(composition[0]!.share).toBeCloseTo(0.6, 2);
    expect(composition[1]!.share).toBeCloseTo(0.3, 2);
    expect(composition[2]!.share).toBeCloseTo(0.1, 2);
  });

  it("drops kinds too small to be worth a word", () => {
    // 7 m of steps onto a 400 m boardwalk is a connector, not a feature of the
    // walk. 512 mixed groups are this case and show a single pill.
    const ways = parseWays([
      way(1, { highway: "footway", bridge: "boardwalk" }, line(53, 8, 400), 1),
      way(2, { highway: "steps", surface: "wood" }, line(53.004, 8, 7), 1),
    ]);

    expect(compositionOf(ways)).toEqual([
      { kind: "boardwalk", share: expect.any(Number) },
    ]);
    expect(compositionOf(ways)[0]!.share).toBeCloseTo(400 / 407, 2);
  });

  it("keeps a minority kind that is a real part of the walk", () => {
    // Moorrundweg Pietzmoor is 59% boardwalk and 41% wooden bridge: both belong
    // on the card, and the map cannot show the difference.
    const ways = parseWays([
      way(1, { highway: "footway", bridge: "boardwalk" }, line(53, 8, 590), 1),
      way(
        2,
        { highway: "footway", bridge: "yes", surface: "wood" },
        line(53.01, 8, 410),
        1,
      ),
    ]);

    const composition = compositionOf(ways);
    expect(composition).toHaveLength(2);
    expect(composition.map((c) => c.kind)).toEqual(["boardwalk", "bridge"]);
  });

  it("never returns an empty list, so the group always has a kind", () => {
    const ways = parseWays([way(1, { man_made: "pier" }, line(53, 8, 50))]);
    expect(compositionOf(ways)).toHaveLength(1);
  });

  it("is exposed on the group, with the dominant kind first", () => {
    const groups = groupWays(
      parseWays([
        way(1, { man_made: "pier" }, line(53, 8, 700), 1),
        way(2, { highway: "steps", surface: "wood" }, line(53.01, 8, 300), 1),
      ]),
    );

    const group = groups[0]!;
    expect(group.kind).toBe("pier");
    expect(group.composition[0]!.kind).toBe("pier");
    expect(group.composition.map((c) => c.kind)).toEqual(["pier", "steps"]);
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
