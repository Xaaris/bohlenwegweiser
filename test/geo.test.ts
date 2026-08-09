import { describe, expect, it } from "vitest";

import {
  boundsOf,
  boundsOverlap,
  distance,
  formatDistance,
  lineLength,
} from "../src/geo.js";

describe("distance", () => {
  it("is zero for the same point", () => {
    expect(distance({ lat: 53, lon: 8 }, { lat: 53, lon: 8 })).toBe(0);
  });

  it("matches a known distance (Bremen to Hamburg, ~95 km)", () => {
    const d = distance({ lat: 53.0793, lon: 8.8017 }, { lat: 53.5511, lon: 9.9937 });
    expect(d).toBeGreaterThan(94_000);
    expect(d).toBeLessThan(97_000);
  });

  it("treats one degree of latitude as about 111 km", () => {
    const d = distance({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
    expect(d).toBeGreaterThan(111_000);
    expect(d).toBeLessThan(111_400);
  });
});

describe("lineLength", () => {
  it("is zero for fewer than two points", () => {
    expect(lineLength([])).toBe(0);
    expect(lineLength([{ lat: 1, lon: 1 }])).toBe(0);
  });

  it("adds up the segments", () => {
    const points = [
      { lat: 53, lon: 8 },
      { lat: 53.001, lon: 8 },
      { lat: 53.002, lon: 8 },
    ];
    expect(lineLength(points)).toBeCloseTo(distance(points[0]!, points[1]!) * 2, 3);
  });
});

describe("boundsOf", () => {
  it("finds the enclosing box", () => {
    expect(
      boundsOf([
        { lat: 53, lon: 8 },
        { lat: 53.5, lon: 7.5 },
        { lat: 52.5, lon: 8.5 },
      ]),
    ).toEqual({ minLat: 52.5, minLon: 7.5, maxLat: 53.5, maxLon: 8.5 });
  });
});

describe("boundsOverlap", () => {
  const view = { minLat: 52.9, minLon: 7.9, maxLat: 53.1, maxLon: 8.1 };

  it("accepts a box inside the view", () => {
    expect(
      boundsOverlap({ minLat: 53, minLon: 8, maxLat: 53.01, maxLon: 8.01 }, view),
    ).toBe(true);
  });

  it("accepts a box that spans the view with all corners outside", () => {
    expect(boundsOverlap({ minLat: 53, minLon: 7, maxLat: 53, maxLon: 9 }, view)).toBe(
      true,
    );
  });

  it("accepts a box that only touches a corner", () => {
    expect(
      boundsOverlap({ minLat: 53.1, minLon: 8.1, maxLat: 53.5, maxLon: 8.5 }, view),
    ).toBe(true);
  });

  it("rejects a box beside the view", () => {
    expect(
      boundsOverlap({ minLat: 50, minLon: 8, maxLat: 50.1, maxLon: 8.1 }, view),
    ).toBe(false);
  });
});

describe("formatDistance", () => {
  it("uses metres below a kilometre", () => {
    expect(formatDistance(0)).toBe("0 m");
    expect(formatDistance(45.4)).toBe("45 m");
    expect(formatDistance(999)).toBe("999 m");
  });

  it("uses one decimal for kilometres", () => {
    expect(formatDistance(1000)).toBe("1,0 km");
    expect(formatDistance(2500)).toBe("2,5 km");
  });

  it("drops the decimal above ten kilometres", () => {
    expect(formatDistance(10_000)).toBe("10 km");
    expect(formatDistance(48_700)).toBe("49 km");
  });

  it("copes with nonsense input", () => {
    expect(formatDistance(Number.NaN)).toBe("–");
    expect(formatDistance(Number.POSITIVE_INFINITY)).toBe("–");
  });
});
