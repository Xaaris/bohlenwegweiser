package main

import "testing"

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
