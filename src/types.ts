/**
 * Shared data types.
 *
 * Reading these first is the quickest way to understand the app: data flows
 * dataset JSON -> RawWay[] -> Way[] -> Group[] -> UI.
 */

/** A geographic point. Note `lon`, not Leaflet's `lng`. */
export type Point = {
  lat: number;
  lon: number;
};

/** A bounding box. */
export type Bounds = {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
};

/** OSM tags are arbitrary key/value strings. */
export type Tags = Record<string, string | undefined>;

/** A way as it comes out of the dataset, before we measure it. */
export type RawWay = {
  id: number;
  /**
   * Id of the group this way belongs to, assigned by tools/build-dataset.
   *
   * Equal to `id` for a way that starts its own group. The browser trusts this
   * instead of recomputing which ways touch; see groupWays in boardwalks.ts.
   */
  groupId: number;
  tags: Tags;
  points: Point[];
};

/**
 * What kind of wooden structure this is.
 *
 * The app used to call all of it "Bohlenweg", which was wrong for most of the
 * data: 3237 of 8022 groups are wooden bridges (median 40 m) and 572 are wooden
 * stairs (median 41 m). Neither is a boardwalk.
 */
export type Kind = "boardwalk" | "pier" | "bridge" | "steps" | "path";

/** A single OSM way that looks like a boardwalk. */
export type Way = {
  id: number;
  groupId: number;
  tags: Tags;
  points: Point[];
  /** Length of the way in metres. */
  lengthM: number;
  kind: Kind;
};

/**
 * One or more connected ways that form a single boardwalk.
 *
 * OSM often splits a path into several ways (a bridge section, a change of
 * surface, ...), so we merge them back together for display.
 */
export type Group = {
  /** Stable id derived from the member way ids. */
  id: string;
  title: string;
  ways: Way[];
  /** Combined length of all member ways in metres. */
  lengthM: number;
  /** The kind that accounts for most of the group's length. */
  kind: Kind;
  bounds: Bounds;
  /** Compact `key=value` list shown on the result card. */
  tagSummary: string[];
};
