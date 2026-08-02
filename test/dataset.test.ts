import { describe, expect, it } from "vitest";
import type { Dataset } from "../src/dataset.js";
import { isCovered, waysInBounds } from "../src/dataset.js";
import type { RawWay } from "../src/types.js";

const GERMANY: [number, number, number, number] = [47.2, 5.8, 55.1, 15.1];

function dataset(ways: RawWay[]): Dataset {
  return { generated: null, osmBase: null, bbox: GERMANY, ways };
}

function way(id: number, coords: [number, number][]): RawWay {
  return {
    id,
    tags: { highway: "footway", bridge: "boardwalk" },
    points: coords.map(([lat, lon]) => ({ lat, lon })),
  };
}

describe("waysInBounds", () => {
  const view = { minLat: 52.9, minLon: 7.9, maxLat: 53.1, maxLon: 8.1 };

  it("keeps ways inside the box and drops the rest", () => {
    const data = dataset([
      way(1, [
        [53, 8],
        [53.001, 8],
      ]),
      way(2, [
        [50, 8],
        [50.001, 8],
      ]),
    ]);

    expect(waysInBounds(data, view).map((w) => w.id)).toEqual([1]);
  });

  it("keeps a way that crosses the box with both ends outside", () => {
    // A long east-west line through the middle of the view. Every one of its
    // points is outside, so a point-in-box test would wrongly discard it.
    const data = dataset([
      way(1, [
        [53, 7],
        [53, 9],
      ]),
    ]);

    expect(waysInBounds(data, view)).toHaveLength(1);
  });

  it("keeps a way that only overlaps at a corner", () => {
    const data = dataset([
      way(1, [
        [53.05, 8.05],
        [53.5, 8.5],
      ]),
    ]);

    expect(waysInBounds(data, view)).toHaveLength(1);
  });

  it("returns nothing for an empty dataset", () => {
    expect(waysInBounds(dataset([]), view)).toEqual([]);
  });
});

describe("isCovered", () => {
  const data = dataset([]);

  it("accepts points inside the region", () => {
    expect(isCovered(data, { lat: 53, lon: 8 })).toBe(true);
    expect(isCovered(data, { lat: 47.9, lon: 9.9 })).toBe(true);
  });

  it("rejects points outside it", () => {
    expect(isCovered(data, { lat: 40.4, lon: -3.7 })).toBe(false); // Madrid
    expect(isCovered(data, { lat: 59.3, lon: 18.1 })).toBe(false); // Stockholm
  });
});
