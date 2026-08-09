package main

import (
	"slices"
	"strings"
	"testing"
)

// A name is weak evidence: "Bohlenweg" is an ordinary German street name, so a
// stated surface that cannot be planks outweighs it. Ways with a real boardwalk
// tag are never judged by the surface.
func TestLooksLikeBoardwalk(t *testing.T) {
	cases := []struct {
		name string
		tags map[string]string
		want bool
		why  string
	}{
		{
			name: "name only, hard surface",
			tags: map[string]string{"highway": "track", "name": "Bohlenweg", "surface": "asphalt"},
			want: false,
			why:  "an asphalt track called Bohlenweg is a street address",
		},
		{
			name: "name only, compacted surface",
			tags: map[string]string{"highway": "track", "name": "Bohlenweg", "surface": "compacted"},
			want: false,
			why:  "compacted is the most common contradicting surface, 13 ways",
		},
		{
			name: "name only, no surface tag",
			tags: map[string]string{"highway": "track", "name": "Bohlenweg"},
			want: true,
			why:  "absent evidence is not contrary evidence",
		},
		{
			name: "name only, surface=wood",
			tags: map[string]string{"highway": "footway", "name": "Bohlenweg", "surface": "wood"},
			want: true,
			why:  "surface=wood is a boardwalk tag in its own right",
		},
		{
			name: "name only, surface=woodchips",
			tags: map[string]string{"highway": "path", "name": "Knüppeldamm", "surface": "woodchips"},
			want: true,
			why:  "any mention of wood wins; a woodchip Knüppeldamm is a real path",
		},
		{
			name: "name only, compound surface mentioning wood",
			tags: map[string]string{"highway": "path", "name": "Moorsteg", "surface": "wood;gravel"},
			want: true,
			why:  "compound values keep the way rather than guessing which half wins",
		},
		{
			name: "name only, unknown surface value",
			tags: map[string]string{"highway": "path", "name": "Moorsteg", "surface": "something_new"},
			want: true,
			why:  "only known hard surfaces reject; an unknown value is not evidence",
		},
		{
			name: "boardwalk bridge with a contradicting surface",
			tags: map[string]string{"highway": "footway", "bridge": "boardwalk", "surface": "compacted"},
			want: true,
			why:  "odd tagging, but the explicit tag is the stronger signal",
		},
		{
			name: "boardwalk tag and a hard surface, unnamed",
			tags: map[string]string{"highway": "footway", "footway": "boardwalk", "surface": "asphalt"},
			want: true,
			why:  "the surface list must only ever apply to the name-only path",
		},
		{
			name: "no evidence at all",
			tags: map[string]string{"highway": "footway", "name": "Hauptstraße"},
			want: false,
			why:  "neither a telling tag nor a matching name",
		},
		{
			name: "name matches inside a compound",
			tags: map[string]string{"highway": "path", "name": "Alter Bohlenweg am Moor"},
			want: true,
			why:  "fragments match anywhere in the name",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := looksLikeBoardwalk(c.tags); got != c.want {
				t.Errorf("looksLikeBoardwalk(%v) = %t, want %t: %s", c.tags, got, c.want, c.why)
			}
		})
	}
}

func TestHasNonWoodSurface(t *testing.T) {
	cases := []struct {
		surface string
		want    bool
	}{
		{"", false},
		{"wood", false},
		{"woodchips", false},
		{"wood;gravel", false},
		{"asphalt", true},
		{"ASPHALT", true}, // OSM values are lower-case by convention, not by rule
		{" compacted ", true},
		{"concrete:lanes", true},
		{"something_new", false},
	}

	for _, c := range cases {
		t.Run(c.surface, func(t *testing.T) {
			if got := hasNonWoodSurface(c.surface); got != c.want {
				t.Errorf("hasNonWoodSurface(%q) = %t, want %t", c.surface, got, c.want)
			}
		})
	}
}

// The two lists have to stay in step: boardwalkNames decides what Overpass sends
// us, nameFragments decides what we keep. A word in only one list is either never
// fetched or fetched and thrown away.
func TestNameListsAgree(t *testing.T) {
	for _, exact := range boardwalkNames {
		if !matchesName(exact) {
			t.Errorf("boardwalkNames has %q but no fragment matches it, so every way "+
				"fetched by that name is discarded", exact)
		}
	}

	// The reverse direction is looser on purpose: "moorsteg" also covers the
	// plural "Moorstege", and a fragment may be a substring of a longer exact
	// name. Every fragment must still be reachable by *some* exact name.
	for _, fragment := range nameFragments {
		found := slices.ContainsFunc(boardwalkNames, func(exact string) bool {
			return strings.Contains(strings.ToLower(exact), fragment)
		})
		if !found {
			t.Errorf("nameFragments has %q but no exact name contains it, so the name "+
				"half of the query never fetches one", fragment)
		}
	}
}

func TestMatchesName(t *testing.T) {
	cases := []struct {
		name string
		want bool
		why  string
	}{
		{"Bohlenweg", true, "exact match on a listed name"},
		{"Knüppelweg", true, "added because a corduroy road is planked by definition"},
		{"Knüppelpfad", true, "same structure, different suffix"},
		{"Plankenweg", true, "asked for; adds 3 walkable ways in Germany"},
		{"Holzbohlenweg", true, "substring match, which the exact query cannot fetch"},
		{"Bohlenweg ins Schwimmende Moor", true, "fragment found anywhere in the name"},
		{"Moorstege", true, "the plural is covered by the singular fragment"},
		{"bohlenweg", true, "matching is case-insensitive"},

		// Deliberately not matched. Bohlenstraße is a street by its own name: the
		// suffix says road, not path, and nothing about planks. Treating it as
		// evidence would re-add exactly the addresses nonWoodSurfaces removes.
		{"Bohlenstraße", false, "a Straße is a street, whatever it is called"},
		{"Holzweg", false, "a timber haul road, and the idiom for the wrong track"},
		{"Moorweg", false, "a path through a moor need not be planked"},
		{"Stegweg", false, "a way to a Steg is not itself one"},
		{"Hauptstraße", false, "no boardwalk word at all"},
		{"", false, "an unnamed way has no name evidence"},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := matchesName(c.name); got != c.want {
				t.Errorf("matchesName(%q) = %t, want %t: %s", c.name, got, c.want, c.why)
			}
		})
	}
}

// The query is built from the same lists, so a new word cannot be forgotten here.
func TestBuildQueryIncludesEveryNameAndTag(t *testing.T) {
	q := buildQuery()

	for _, n := range boardwalkNames {
		want := `way["name"="` + n + `"];`
		if !strings.Contains(q, want) {
			t.Errorf("query is missing %s", want)
		}
	}
	for _, tag := range boardwalkTags {
		want := `way["` + tag.Key + `"="` + tag.Value + `"];`
		if !strings.Contains(q, want) {
			t.Errorf("query is missing %s", want)
		}
	}

	// Exact matches only: a regex over all of Germany measured 30 s+ against 1 s.
	if strings.Contains(q, `name~`) {
		t.Error("query uses a name regex; that measured ~30x slower on Overpass")
	}
}
