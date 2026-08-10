// Grouping. This is the only implementation: each shipped way carries the id of
// its group (`c` in the JSON, the smallest OSM way id in it), and
// src/boardwalks.ts just buckets by that field.
//
// The group id must be derived from the data, never from iteration order. Go
// randomises map iteration, so a sequential index would rewrite the whole of
// public/boardwalks.json on every rebuild even when nothing changed.
//
// The length filter has to run on the assembled group, not on single ways: the
// median way is 10 m and 81% are under 25 m, because OSM splits paths into many
// short segments. Filtering per way would delete 725 boardwalks that clear 25 m
// once assembled, losing 60.7 km of real path.

package main

import "math"

// Vertices closer than this count as the same junction.
//
// `out tags geom` returns no node ids, so distance is all we have. 20 m already
// accounts for 69% of all joins (median 5.41 m); widening it risks chaining
// parallel boardwalks that merely run near each other.
const joinDistanceM = 20.0

const earthRadiusM = 6371008.8

// groupAndFilter assigns each way its group id and returns the ways whose group
// reaches minLengthM in total, plus the number of groups that survived.
func groupAndFilter(ways []outWay, minLengthM float64) ([]outWay, int) {
	groups := connectedComponents(ways)

	kept := make([]outWay, 0, len(ways))
	groupCount := 0

	for _, members := range groups {
		var total float64
		for _, i := range members {
			total += lineLength(ways[i].G)
		}
		if total < minLengthM {
			continue
		}

		// The smallest member id names the group: stable across rebuilds and
		// independent of the order the components came out in.
		groupID := ways[members[0]].I
		for _, i := range members {
			if ways[i].I < groupID {
				groupID = ways[i].I
			}
		}

		groupCount++
		for _, i := range members {
			w := ways[i]
			// Left unset when it equals the way's own id, which covers every
			// single-way group and the first member of every larger one. The
			// reader falls back to `i`, so this costs nothing to interpret.
			if groupID != w.I {
				w.C = groupID
			}
			kept = append(kept, w)
		}
	}

	return kept, groupCount
}

// connectedComponents groups indices of ways that meet.
//
// Proximity is the only test, and deliberately so. Names look like a signal but
// are not: requiring equal names blocks 137 pairs in the real data and is wrong
// in nearly all of them — "Steg West"/"Steg Ost" are two fingers of one jetty,
// "Strandübergang 17" leads onto the "Dünenpromenade", "Quellentalbrücke" and
// "Zollhausbrücke" are consecutive spans of one crossing. Five of seven sampled
// pairs share an OSM node outright.
//
// `layer` is tempting too, for a bridge crossing *over* a boardwalk, and it is in
// the raw response. Also unusable: 2472 pairs share an exact coordinate while
// differing in layer, same-named ways included, because a ramp onto a bridge
// legitimately changes layer. A shared node means you can walk from one to the
// other, whatever the layer says.
//
// Every vertex counts as a possible junction, not just the two endpoints: OSM
// frequently splits a way so one *ends in the middle of another* — a side branch
// off a boardwalk, a jetty off a walkway — and endpoints alone leave 303 real
// networks split. Direction is ignored on purpose: a branch meeting a path at a
// right angle is still the same network, so there is no angle test.
//
// Vertices are indexed in a grid whose cells are two join distances wide, so two
// vertices within joinDistanceM always land in the same or an adjacent cell. That
// keeps this near-linear in the 48,000 ways instead of comparing all pairs.
func connectedComponents(ways []outWay) [][]int {
	const cellSize = (joinDistanceM * 2) / 111_320 // degrees

	type cell struct{ lat, lon int }
	cellOf := func(p [2]float64) cell {
		return cell{int(math.Floor(p[0] / cellSize)), int(math.Floor(p[1] / cellSize))}
	}

	// Which way each indexed vertex belongs to, and where it is. Storing the point
	// alongside the index lets the neighbour scan compare two vertices directly,
	// rather than re-testing every vertex pair of both ways.
	type vertex struct {
		way   int
		point [2]float64
	}

	total := 0
	for _, w := range ways {
		total += len(w.G)
	}

	grid := make(map[cell][]vertex, total)
	for i := range ways {
		for _, p := range ways[i].G {
			c := cellOf(p)
			grid[c] = append(grid[c], vertex{way: i, point: p})
		}
	}

	parent := make([]int, len(ways))
	for i := range parent {
		parent[i] = i
	}

	var find func(int) int
	find = func(i int) int {
		for parent[i] != i {
			parent[i] = parent[parent[i]] // path halving
			i = parent[i]
		}
		return i
	}

	union := func(a, b int) {
		ra, rb := find(a), find(b)
		if ra != rb {
			parent[rb] = ra
		}
	}

	for i := range ways {
		for _, p := range ways[i].G {
			c := cellOf(p)
			// The point's own cell and the eight around it.
			for dLat := -1; dLat <= 1; dLat++ {
				for dLon := -1; dLon <= 1; dLon++ {
					for _, v := range grid[cell{c.lat + dLat, c.lon + dLon}] {
						if v.way <= i {
							continue
						}
						// Already joined, so the distance does not matter.
						if find(v.way) == find(i) {
							continue
						}
						if distance(p, v.point) <= joinDistanceM {
							union(i, v.way)
						}
					}
				}
			}
		}
	}

	components := make(map[int][]int, len(ways))
	for i := range ways {
		root := find(i)
		components[root] = append(components[root], i)
	}

	out := make([][]int, 0, len(components))
	for _, members := range components {
		out = append(out, members)
	}
	return out
}

func lineLength(points [][2]float64) float64 {
	var total float64
	for i := 1; i < len(points); i++ {
		total += distance(points[i-1], points[i])
	}
	return total
}

// distance is the great-circle distance between two [lat, lon] points, in
// metres.
func distance(a, b [2]float64) float64 {
	const deg = math.Pi / 180

	lat1, lat2 := a[0]*deg, b[0]*deg
	dLat := lat2 - lat1
	dLon := (b[1] - a[1]) * deg

	sinLat := math.Sin(dLat / 2)
	sinLon := math.Sin(dLon / 2)
	h := sinLat*sinLat + math.Cos(lat1)*math.Cos(lat2)*sinLon*sinLon

	return 2 * earthRadiusM * math.Asin(math.Min(1, math.Sqrt(h)))
}
