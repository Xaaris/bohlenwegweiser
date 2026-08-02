import { describe, expect, it } from "vitest";

import { confidenceOf, groupWays, parseWays } from "../src/boardwalks.js";
import type { RawWay } from "../src/types.js";

/** Builds a dataset way for tests. */
function way(
  id: number,
  tags: Record<string, string>,
  coords: [number, number][],
): RawWay {
  return {
    id,
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

  it("rates a name-only match lowest", () => {
    expect(confidenceOf({ name: "Bohlenweg" })).toBe("low");
    expect(confidenceOf({ name: "Alter BOHLENWEG am Moor" })).toBe("low");
  });

  it("returns null when nothing suggests a boardwalk", () => {
    expect(confidenceOf({ highway: "footway" })).toBeNull();
    expect(confidenceOf({ name: "Hauptstraße" })).toBeNull();
    expect(confidenceOf({})).toBeNull();
  });
});

describe("parseWays", () => {
  it("keeps a boardwalk footpath and measures it", () => {
    const ways = parseWays([
      way(1, { highway: "footway", bridge: "boardwalk" }, line(53, 8, 200)),
    ]);

    expect(ways).toHaveLength(1);
    expect(ways[0]!.lengthM).toBeGreaterThan(190);
    expect(ways[0]!.lengthM).toBeLessThan(210);
    expect(ways[0]!.confidence).toBe("high");
  });

  it("drops roads, even wooden ones", () => {
    const ways = parseWays([
      way(1, { highway: "residential", surface: "wood" }, line(53, 8, 200)),
    ]);
    expect(ways).toHaveLength(0);
  });

  it("drops paths with no boardwalk signal", () => {
    const ways = parseWays([
      way(1, { highway: "footway", surface: "asphalt" }, line(53, 8, 200)),
    ]);
    expect(ways).toHaveLength(0);
  });

  it("keeps piers, which have no highway tag", () => {
    const ways = parseWays([
      way(1, { man_made: "pier", surface: "wood" }, line(53, 8, 80)),
    ]);
    expect(ways).toHaveLength(1);
  });

  it("drops ways with too few points to be a line", () => {
    const ways = parseWays([
      way(1, { highway: "footway", bridge: "boardwalk" }, line(53, 8, 100)),
      way(2, { highway: "footway", bridge: "boardwalk" }, [[53, 8]]),
    ]);

    expect(ways.map((w) => w.id)).toEqual([1]);
  });
});

describe("groupWays", () => {
  it("returns nothing for no ways", () => {
    expect(groupWays([])).toEqual([]);
  });

  it("merges segments that meet end to end", () => {
    const ways = parseWays([
      way(1, { highway: "footway", bridge: "boardwalk" }, [
        [53, 8],
        [53.001, 8],
      ]),
      way(2, { highway: "footway", bridge: "boardwalk" }, [
        [53.001, 8],
        [53.002, 8],
      ]),
    ]);

    const groups = groupWays(ways);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.ways).toHaveLength(2);
    expect(groups[0]!.lengthM).toBeGreaterThan(200);
  });

  it("merges a whole chain of segments", () => {
    const ways = Array.from({ length: 5 }, (_, i) =>
      way(i + 1, { highway: "footway", bridge: "boardwalk" }, [
        [53 + i * 0.001, 8],
        [53 + (i + 1) * 0.001, 8],
      ]),
    );

    const groups = groupWays(parseWays(ways));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.ways).toHaveLength(5);
  });

  it("keeps far-apart paths separate", () => {
    const ways = parseWays([
      way(1, { highway: "footway", bridge: "boardwalk" }, line(53, 8, 200)),
      way(2, { highway: "footway", bridge: "boardwalk" }, line(53.4, 8.4, 200)),
    ]);

    expect(groupWays(ways)).toHaveLength(2);
  });

  it("does not merge touching ways with different names", () => {
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
    const a = way(1, { highway: "footway", bridge: "boardwalk" }, [
      [53, 8],
      [53.001, 8],
    ]);
    const b = way(2, { highway: "footway", bridge: "boardwalk" }, [
      [53.001, 8],
      [53.002, 8],
    ]);

    const idOf = (ways: RawWay[]) => groupWays(parseWays(ways))[0]!.id;

    expect(idOf([a, b])).toBe(idOf([b, a]));
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

  it("stays fast with a lot of ways", () => {
    // The grid lookup avoids comparing all pairs, which at 1500 ways would be
    // over a million comparisons.
    const ways = Array.from({ length: 1500 }, (_, i) =>
      way(
        i + 1,
        { highway: "footway", bridge: "boardwalk" },
        line(53 + i * 0.01, 8 + i * 0.01, 100),
      ),
    );

    const started = Date.now();
    const groups = groupWays(parseWays(ways));

    expect(groups).toHaveLength(1500);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
