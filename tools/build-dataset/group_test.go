package main

import (
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

func TestGroupAndFilterRespectsNames(t *testing.T) {
	// Two 15 m ways that touch but carry different names: they are different
	// paths, so neither reaches 25 m and both go.
	a := testWay(1, 53.0, 8.0, 15, map[string]string{"highway": "footway", "surface": "wood"})
	a.N = "Moorsteg"
	b := testWay(2, 53.0+15/111_320, 8.0, 15, map[string]string{"highway": "footway", "surface": "wood"})
	b.N = "Holzsteg"

	if kept, _ := groupAndFilter([]outWay{a, b}, 25); len(kept) != 0 {
		t.Errorf("kept %v, want none: differently named ways must not be joined", ids(kept))
	}

	// Same name: they join into 30 m and both stay.
	b.N = "Moorsteg"
	kept, groups := groupAndFilter([]outWay{a, b}, 25)
	if len(kept) != 2 {
		t.Errorf("kept %v, want both: same-named touching ways form one path", ids(kept))
	}
	if groups != 1 {
		t.Errorf("groups = %d, want 1", groups)
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
