package main

import (
	"math"
	"slices"
	"testing"
)

// A short way of roughly the given length, running north from (lat, lon).
func testWay(id int64, lat, lon, meters float64, tags map[string]string) outWay {
	return outWay{
		I: id,
		T: tags,
		G: [][2]float64{{lat, lon}, {lat + meters/111_320, lon}},
	}
}

// A way through explicit [lat, lon] vertices, for junctions that are not at an
// endpoint. testWay only builds two-point lines, which cannot express "ends in
// the middle of another way".
func testWayAt(id int64, tags map[string]string, points ...[2]float64) outWay {
	return outWay{I: id, T: tags, G: points}
}

// Metres north/east of a base point, as a degree offset. Longitude is scaled by
// cos(lat) so "20 m east" really is 20 m.
func offset(lat, lon, northM, eastM float64) [2]float64 {
	return [2]float64{
		lat + northM/111_320,
		lon + eastM/(111_320*math.Cos(lat*math.Pi/180)),
	}
}

var boardwalk = map[string]string{"highway": "footway", "bridge": "boardwalk"}

func TestGroupAndFilterJoinsSegments(t *testing.T) {
	// Six 10 m segments end to end: 60 m in total, so the group stays even
	// though every single way is well under the 25 m limit. This is the case
	// that makes per-way filtering wrong: 81% of real ways are under 25 m.
	var ways []outWay
	for i := range 6 {
		lat := 53.0 + float64(i)*10/111_320
		ways = append(ways, testWay(int64(i+1), lat, 8.0, 10, boardwalk))
	}

	kept, groups := groupAndFilter(ways, 25)

	if len(kept) != 6 {
		t.Errorf("kept %d ways, want all 6: short segments of a long path must survive",
			len(kept))
	}
	if groups != 1 {
		t.Errorf("groups = %d, want 1", groups)
	}
	// All six must name the same group, so the browser reassembles them.
	for _, w := range kept {
		if groupIDOf(w) != 1 {
			t.Errorf("way %d has group %d, want 1", w.I, groupIDOf(w))
		}
	}
}

func TestGroupAndFilterDropsShortGroups(t *testing.T) {
	ways := []outWay{
		// Isolated 10 m way: nothing to join with, so it goes.
		testWay(1, 53.0, 8.0, 10, boardwalk),
		// Isolated 40 m way: long enough on its own.
		testWay(2, 54.0, 9.0, 40, boardwalk),
	}

	kept, groups := groupAndFilter(ways, 25)

	if len(kept) != 1 || kept[0].I != 2 {
		t.Errorf("kept %+v, want only way 2", ids(kept))
	}
	if groups != 1 {
		t.Errorf("groups = %d, want 1", groups)
	}
	// A lone way is its own group, and C stays unset to keep the file small.
	if kept[0].C != 0 {
		t.Errorf("C = %d, want 0 (omitted) for a single-way group", kept[0].C)
	}
	if groupIDOf(kept[0]) != 2 {
		t.Errorf("group id = %d, want the way's own id 2", groupIDOf(kept[0]))
	}
}

// Names no longer affect grouping. This assertion is the inverse of what it was:
// the builder used to refuse to join two named ways whose names differed, which
// measured 137 blocked pairs, none of them convincing. "Steg West" and "Steg Ost"
// are two fingers of one jetty, and five of seven sampled pairs share an OSM node.
func TestGroupAndFilterIgnoresNames(t *testing.T) {
	// Two 15 m ways that touch and carry *different* names. Together they are a
	// 30 m network, so both survive the 25 m minimum.
	a := testWay(1, 53.0, 8.0, 15, map[string]string{"highway": "footway", "surface": "wood"})
	a.N = "Moorsteg"
	b := testWay(2, 53.0+15/111_320, 8.0, 15, map[string]string{"highway": "footway", "surface": "wood"})
	b.N = "Holzsteg"

	kept, groups := groupAndFilter([]outWay{a, b}, 25)
	if len(kept) != 2 {
		t.Errorf("kept %v, want both: touching ways form one network whatever they are called",
			ids(kept))
	}
	if groups != 1 {
		t.Errorf("groups = %d, want 1", groups)
	}

	// Same name behaves identically, which is the point: the name is not consulted.
	b.N = "Moorsteg"
	kept, groups = groupAndFilter([]outWay{a, b}, 25)
	if len(kept) != 2 || groups != 1 {
		t.Errorf("kept %v in %d groups, want 2 in 1", ids(kept), groups)
	}
}

// Differing tags do not block a join either. The old samePath had branches for
// bridge=boardwalk and surface=wood, but they rejected nothing in the real data.
func TestGroupAndFilterIgnoresTagDifferences(t *testing.T) {
	a := testWay(1, 53.0, 8.0, 15, map[string]string{"highway": "footway", "bridge": "boardwalk"})
	b := testWay(2, 53.0+15/111_320, 8.0, 15, map[string]string{"highway": "path", "surface": "wood"})

	kept, groups := groupAndFilter([]outWay{a, b}, 25)
	if len(kept) != 2 || groups != 1 {
		t.Errorf("kept %v in %d groups, want 2 in 1: proximity is the only test",
			ids(kept), groups)
	}
}

func TestGroupAndFilterIgnoresDistantWays(t *testing.T) {
	// 15 m each, 1 km apart: too far to join, so both are dropped.
	ways := []outWay{
		testWay(1, 53.0, 8.0, 15, boardwalk),
		testWay(2, 53.01, 8.0, 15, boardwalk),
	}

	if kept, _ := groupAndFilter(ways, 25); len(kept) != 0 {
		t.Errorf("kept %v, want none: ways 1 km apart are separate paths", ids(kept))
	}
}

// The group id must be the smallest member id and must not depend on input
// order: Go randomises map iteration, so anything derived from it would rewrite
// public/boardwalks.json on every rebuild.
func TestGroupIDIsSmallestMemberAndOrderIndependent(t *testing.T) {
	build := func() []outWay {
		return []outWay{
			testWay(500, 53.0, 8.0, 10, boardwalk),
			testWay(100, 53.0+10/111_320, 8.0, 10, boardwalk),
			testWay(300, 53.0+20/111_320, 8.0, 10, boardwalk),
		}
	}

	forward, _ := groupAndFilter(build(), 25)

	reversed := build()
	slices.Reverse(reversed)
	backward, _ := groupAndFilter(reversed, 25)

	for _, kept := range [][]outWay{forward, backward} {
		if len(kept) != 3 {
			t.Fatalf("kept %v, want all three", ids(kept))
		}
		for _, w := range kept {
			if got := groupIDOf(w); got != 100 {
				t.Errorf("way %d has group %d, want the smallest member id 100", w.I, got)
			}
		}
	}
}

func TestGroupAndFilterJoinsAtInteriorVertices(t *testing.T) {
	const lat, lon = 53.0, 8.0

	// A 100 m through-way running east, with a vertex in the middle at 50 m.
	through := testWayAt(1, boardwalk,
		offset(lat, lon, 0, 0),
		offset(lat, lon, 0, 50),
		offset(lat, lon, 0, 100),
	)

	cases := []struct {
		name   string
		branch outWay
		want   int // expected number of groups
	}{
		{
			// Straight south off the middle vertex: a right angle. This must join;
			// direction is irrelevant to whether it is the same network.
			name: "right-angle T at the middle vertex",
			branch: testWayAt(2, boardwalk,
				offset(lat, lon, 0, 50),
				offset(lat, lon, -40, 50),
			),
			want: 1,
		},
		{
			// Not exactly on the vertex, but within the join distance of it.
			name: "near the middle vertex, inside the join distance",
			branch: testWayAt(3, boardwalk,
				offset(lat, lon, -15, 50),
				offset(lat, lon, -60, 50),
			),
			want: 1,
		},
		{
			// Meets the shared endpoint instead: the case that already worked.
			name: "at an endpoint",
			branch: testWayAt(4, boardwalk,
				offset(lat, lon, 0, 100),
				offset(lat, lon, -40, 100),
			),
			want: 1,
		},
		{
			// Off the end of the middle vertex by more than the join distance, and
			// not near any other vertex either.
			name: "too far from every vertex",
			branch: testWayAt(5, boardwalk,
				offset(lat, lon, -60, 50),
				offset(lat, lon, -100, 50),
			),
			want: 2,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			kept, groups := groupAndFilter([]outWay{through, c.branch}, 25)

			if groups != c.want {
				t.Errorf("groups = %d, want %d (kept %v)", groups, c.want, ids(kept))
			}
			if c.want == 1 {
				// One group means both ways report the same group id.
				for _, w := range kept {
					if got := groupIDOf(w); got != 1 {
						t.Errorf("way %d has group %d, want 1", w.I, got)
					}
				}
			}
		})
	}
}

// A vertex in the middle of a way does not join ways that merely cross without
// sharing a vertex. OSM models a real crossing with a shared node, so two ways
// passing over each other at different heights stay separate.
func TestGroupAndFilterIgnoresCrossingsWithoutAVertex(t *testing.T) {
	const lat, lon = 53.0, 8.0

	// East-west, vertices only at its two ends, 200 m apart.
	eastWest := testWayAt(1, boardwalk,
		offset(lat, lon, 0, -100),
		offset(lat, lon, 0, 100),
	)
	// North-south through the same middle point, again only end vertices. The
	// lines cross geometrically but share no vertex within 20 m.
	northSouth := testWayAt(2, boardwalk,
		offset(lat, lon, -100, 0),
		offset(lat, lon, 100, 0),
	)

	_, groups := groupAndFilter([]outWay{eastWest, northSouth}, 25)
	if groups != 2 {
		t.Errorf("groups = %d, want 2: a crossing without a shared vertex is not a junction",
			groups)
	}
}

func TestDistanceMatchesKnownValue(t *testing.T) {
	// Bremen to Hamburg, about 95 km.
	got := distance([2]float64{53.0793, 8.8017}, [2]float64{53.5511, 9.9937})
	if got < 94_000 || got > 97_000 {
		t.Errorf("distance = %.0f m, want roughly 95 km", got)
	}
}

// groupIDOf resolves the omitted-when-equal encoding the way the browser does.
func groupIDOf(w outWay) int64 {
	if w.C != 0 {
		return w.C
	}
	return w.I
}

func ids(ways []outWay) []int64 {
	out := make([]int64, len(ways))
	for i, w := range ways {
		out[i] = w.I
	}
	return out
}
