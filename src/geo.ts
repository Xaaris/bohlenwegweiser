/**
 * Geodesic maths and formatting. Pure functions, easy to test.
 */

import type { Bounds, Point } from "./types.js";

const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

/** Great-circle distance between two points, in metres. */
export function distance(a: Point, b: Point): number {
  const lat1 = a.lat * DEG;
  const lat2 = b.lat * DEG;
  const dLat = lat2 - lat1;
  const dLon = (b.lon - a.lon) * DEG;

  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Total length of a polyline, in metres. */
export function lineLength(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    // Safe: the loop bounds guarantee both indices exist.
    total += distance(points[i - 1] as Point, points[i] as Point);
  }
  return total;
}

/**
 * Shortest distance from a point to a polyline, in metres.
 *
 * Measures against each segment, not just the corner points, so a long straight
 * segment passing nearby is reported correctly.
 */
export function distanceToLine(from: Point, points: Point[]): number {
  if (points.length === 0) return Number.POSITIVE_INFINITY;
  if (points.length === 1) return distance(from, points[0] as Point);

  let min = Number.POSITIVE_INFINITY;
  for (let i = 1; i < points.length; i++) {
    const d = distanceToSegment(from, points[i - 1] as Point, points[i] as Point);
    if (d < min) min = d;
  }
  return min;
}

/** Distance from `p` to the segment `a`-`b`, in metres. */
function distanceToSegment(p: Point, a: Point, b: Point): number {
  // Project onto a flat plane centred on `p`. Fine over short distances.
  const cosLat = Math.cos(p.lat * DEG);
  const toXY = (q: Point) => ({
    x: (q.lon - p.lon) * DEG * cosLat * EARTH_RADIUS_M,
    y: (q.lat - p.lat) * DEG * EARTH_RADIUS_M,
  });

  const pa = toXY(a);
  const pb = toXY(b);
  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq === 0) return distance(p, a);

  // How far along the segment the closest point lies, clamped to its ends.
  const t = Math.max(0, Math.min(1, (-pa.x * dx - pa.y * dy) / lengthSq));
  return Math.hypot(pa.x + t * dx, pa.y + t * dy);
}

/** Bounding box of some points. */
export function boundsOf(points: Point[]): Bounds {
  let minLat = Number.POSITIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;

  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  return { minLat, minLon, maxLat, maxLon };
}

const nf = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** Formats metres as "450 m", "1,2 km" or "34 km". */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return "–";
  if (meters >= 10_000) return `${nf.format(Math.round(meters / 1000))} km`;
  if (meters >= 1000) return `${nf1.format(meters / 1000)} km`;
  return `${nf.format(Math.round(meters))} m`;
}
