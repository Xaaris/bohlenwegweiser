import { describe, expect, it } from "vitest";
import type { Dataset } from "../src/dataset.js";
import { isCovered } from "../src/dataset.js";
import type { RawWay } from "../src/types.js";

const GERMANY: [number, number, number, number] = [47.2, 5.8, 55.1, 15.1];

function dataset(ways: RawWay[]): Dataset {
  return { generated: null, osmBase: null, bbox: GERMANY, ways };
}

// The viewport filter now runs on assembled groups, not on ways: see
// groupsInBounds in test/boardwalks.test.ts.

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
