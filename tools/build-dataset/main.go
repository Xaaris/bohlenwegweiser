// Command build-dataset downloads all boardwalk candidates in Germany from
// Overpass and writes them as a single compact JSON file for the web app.
//
// Shipping the data as a static file makes searching instant and removes the
// runtime dependency on Overpass, which measured a median of 2.9 s per search
// and regularly timed out.
//
// Run it whenever you want fresh data:
//
//	go run ./tools/build-dataset
//
// Flags:
//
//	-out    where to write the dataset (default public/boardwalks.json)
//	-from   read a saved Overpass response instead of querying (for testing)
//	-save   also keep the raw Overpass response at this path
package main

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"maps"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// Germany, generously bounded. Widen this to cover more countries; nothing else
// assumes a region, but the dataset grows roughly with the area.
var bbox = [4]float64{47.2, 5.8, 55.1, 15.1} // minLat, minLon, maxLat, maxLon

// Tag/value pairs that on their own mark a way as a boardwalk.
//
// Used for both halves of the job: building the Overpass query and deciding
// which returned ways to keep. One list, so the two cannot drift apart.
//
// kindOf() in src/boardwalks.ts classifies the same tags into the labels the UI
// shows, so a new pair usually wants a case there too.
//
// Three of these earn their keep only in principle: in Germany `boardwalk=yes`
// and `footway=boardwalk` match zero ways and `surface=boardwalk` matches 4. Keep
// them anyway — the region is a single variable (`bbox` below) and those tags are
// used elsewhere, so deleting them would quietly break the first wider rebuild.
var boardwalkTags = []struct{ Key, Value string }{
	{"surface", "wood"},
	{"bridge", "boardwalk"},
	{"boardwalk", "yes"},
	{"footway", "boardwalk"},
	{"surface", "boardwalk"},
}

// Ways whose name alone suggests a boardwalk, even without telling tags.
//
// Matched **exactly**, because that is what Overpass indexes: `way["name"="X"]`
// is fast, while a regex over all of Germany makes the planner pick a far slower
// route (measured: 1 s versus 30 s+). A name like "Holzbohlenweg" is therefore
// never fetched by this half of the query, only by the tag half.
//
// Keep in step with nameFragments below: a word needs to be in *both* lists to
// have any effect through the name path. This list decides what gets downloaded;
// that one decides what is kept.
var boardwalkNames = []string{
	"Bohlenweg", "Bohlensteg", "Bohlenpfad", "Holzsteg", "Moorsteg",
	"Moorstege", "Bretterweg", "Knüppeldamm", "Knüppelweg", "Knüppelpfad",
	"Plankenweg", "Boardwalk",
}

// Lower-case fragments that hint at a boardwalk, covering plurals and compounds
// the exact names above miss. A way that only matches here gets the UI's lowest
// confidence label.
//
// The rule for adding a word: it must name the **structure**, not the setting.
// Bohle, Bretter, Planke, Knüppel and Steg all describe planks, logs or a raised
// walkway. Words that only say where the path goes, or what was carried along it,
// are not evidence and were measured to be mostly noise:
//
//	Holzweg   973 ways, 72 walkable and untagged — a timber haul road, and the
//	          idiom for being on the wrong track. Almost none are planked.
//	Moorweg   884 ways, 51 — a path through a moor need not be planked at all.
//	Moorpfad    7 ways,  2 — same reasoning as Moorweg.
//	Stegweg    19 ways,  4 — a way *to* a Steg is not itself one.
//
// Knüppelweg by contrast is a corduroy road by definition: 21 of the ways already
// in the file are called that, and 8 more qualify on the name alone.
var nameFragments = []string{
	"bohlenweg", "bohlensteg", "bohlenpfad", "holzsteg", "moorsteg",
	"bretterweg", "knüppeldamm", "knüppelweg", "knüppelpfad", "plankenweg",
	"boardwalk",
}

// Surfaces that rule out wooden planks.
//
// Only consulted for ways that qualify on their *name* alone. "Bohlenweg" is an
// ordinary German street name, so an asphalt track called Bohlenweg is an address,
// not a boardwalk: 39 of the 50 name-only ways in Germany are this case.
//
// A way with real evidence (bridge=boardwalk, surface=wood, ...) is never judged
// by this list. `surface=compacted` next to `bridge=boardwalk` is odd tagging, but
// the explicit tag is the stronger signal.
var nonWoodSurfaces = []string{
	"asphalt", "concrete", "concrete:lanes", "concrete:plates",
	"paving_stones", "sett", "cobblestone", "unhewn_cobblestone",
	"compacted", "gravel", "fine_gravel", "pebblestone",
	"dirt", "ground", "earth", "mud", "sand", "grass", "grass_paver",
	"metal", "clay", "rock", "stone", "unpaved", "paved",
}

// highway values that can plausibly be walked on.
var relevantHighways = []string{
	"footway", "path", "cycleway", "bridleway", "pedestrian", "steps", "track",
}

// Tags the UI needs: enough for kindOf(), titleOf() and the tag pills on a result
// card. Grouping reads none of them, so this list is purely about display.
var keepTags = []string{
	"highway", "man_made", "bridge", "surface", "boardwalk", "footway",
}

// Overpass mirrors, tried in order. One request per manual rebuild is well
// within their usage policy.
var endpoints = []string{
	"https://overpass-api.de/api/interpreter",
	"https://maps.mail.ru/osm/tools/overpass/api/interpreter",
}

const (
	// Overpass needs a long leash for a country-wide query: measured at 90 s.
	overpassTimeoutS = 900
	httpTimeout      = 20 * time.Minute
	userAgent        = "Bohlenwegweiser-dataset-builder/0.1 (hobby project)"

	// Paths shorter than this are dropped: a 20 m plank across a ditch is not
	// something anyone travels to see, and leaving them out halves the file to
	// 0.54 MB gzipped. Must match MIN_LENGTH_M in src/config.ts.
	minLengthM = 25.0
)

// --- Overpass response ---

type overpassResponse struct {
	Elements []overpassWay `json:"elements"`
	// Set when Overpass fails despite answering HTTP 200.
	Remark string `json:"remark"`
	OSM3S  struct {
		TimestampOSMBase string `json:"timestamp_osm_base"`
	} `json:"osm3s"`
}

type overpassWay struct {
	Type     string            `json:"type"`
	ID       int64             `json:"id"`
	Tags     map[string]string `json:"tags"`
	Geometry []*geoPoint       `json:"geometry"`
}

type geoPoint struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

// --- Output format ---
//
// Keys are short because they repeat tens of thousands of times. The matching
// reader is loadDataset() in src/dataset.ts.

type dataset struct {
	// When the data was generated, so the UI can show its age.
	Generated string `json:"generated"`
	// Timestamp of the underlying OSM data, straight from Overpass.
	OSMBase string `json:"osmBase,omitzero"`
	// minLat, minLon, maxLat, maxLon of the covered region.
	BBox [4]float64 `json:"bbox"`
	Ways []outWay   `json:"ways"`
}

type outWay struct {
	I int64             `json:"i"`          // OSM way id
	N string            `json:"n,omitzero"` // name
	T map[string]string `json:"t,omitzero"` // the kept tags
	G [][2]float64      `json:"g"`          // geometry as [lat, lon] pairs
	// Group id: the smallest way id in this way's group. Omitted when it equals
	// I, so the field only appears on ways that join a lower-numbered one. The
	// browser groups by this instead of recomputing the components.
	C int64 `json:"c,omitzero"`
}

func main() {
	log.SetFlags(0)

	out := flag.String("out", filepath.Join("public", "boardwalks.json"),
		"where to write the dataset")
	from := flag.String("from", "",
		"read a saved Overpass response instead of querying")
	save := flag.String("save", "",
		"also keep the raw Overpass response at this path")
	flag.Parse()

	if err := run(*out, *from, *save); err != nil {
		log.Fatal(err)
	}
}

func run(out, from, save string) error {
	// Ctrl-C cancels the download instead of leaving it running.
	ctx, stop := context.WithCancel(context.Background())
	defer stop()

	raw, err := fetch(ctx, from, save)
	if err != nil {
		return fmt.Errorf("fetching: %w", err)
	}

	var resp overpassResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return fmt.Errorf("parsing Overpass response: %w", err)
	}
	// Overpass reports its own timeouts with HTTP 200 and a remark, so an
	// unchecked response can look like "nothing found".
	if resp.Remark != "" {
		return fmt.Errorf("Overpass reported: %s", resp.Remark)
	}
	if len(resp.Elements) == 0 {
		return fmt.Errorf("Overpass returned no elements")
	}

	ways, st := convert(resp.Elements)
	if len(ways) == 0 {
		return fmt.Errorf("no ways left after filtering: the tag filters are probably wrong")
	}

	// Drop paths shorter than the UI's minimum. This has to run on assembled
	// groups, not single ways: 81% of ways are under 25 m because OSM splits
	// paths into short segments, so filtering them individually would delete 725
	// boardwalks that are long enough once joined.
	beforeLength := len(ways)
	ways, groupCount := groupAndFilter(ways, minLengthM)
	if len(ways) == 0 {
		return fmt.Errorf("no ways left after the length filter")
	}

	// Sorting by id makes the output stable, so re-running with unchanged data
	// produces an identical file and git shows no diff.
	slices.SortFunc(ways, func(a, b outWay) int { return cmp.Compare(a.I, b.I) })

	size, err := writeJSON(out, dataset{
		Generated: time.Now().UTC().Format(time.RFC3339),
		OSMBase:   resp.OSM3S.TimestampOSMBase,
		BBox:      bbox,
		Ways:      ways,
	})
	if err != nil {
		return fmt.Errorf("writing %s: %w", out, err)
	}

	log.Printf("elements from Overpass: %d", len(resp.Elements))
	log.Printf("  dropped, wrong tags:  %d", st.notRelevant)
	log.Printf("  dropped, no evidence: %d", st.noConfidence)
	log.Printf("  dropped, < 2 points:  %d", st.tooFewPoints)
	log.Printf("  dropped, duplicate:   %d", st.duplicate)
	log.Printf("  dropped, group < %.0fm: %d", minLengthM, beforeLength-len(ways))
	log.Printf("ways written:           %d", len(ways))
	log.Printf("groups:                 %d", groupCount)
	log.Printf("%s: %.2f MB (roughly a fifth of that gzipped)",
		out, float64(size)/(1<<20))

	return nil
}

// fetch returns the raw Overpass response, either from a file or from the API.
func fetch(ctx context.Context, from, save string) ([]byte, error) {
	if from != "" {
		log.Printf("reading %s", from)
		return os.ReadFile(from)
	}

	query := buildQuery()
	client := &http.Client{Timeout: httpTimeout}

	var errs []error
	for _, url := range endpoints {
		log.Printf("querying %s (a country-wide query takes a minute or two)", url)

		start := time.Now()
		body, err := postQuery(ctx, client, url, query)
		if err != nil {
			log.Printf("  failed after %s: %v", time.Since(start).Round(time.Second), err)
			errs = append(errs, fmt.Errorf("%s: %w", url, err))
			continue
		}

		log.Printf("  %.1f MB in %s",
			float64(len(body))/(1<<20), time.Since(start).Round(time.Second))

		if save != "" {
			if err := os.WriteFile(save, body, 0o644); err != nil {
				return nil, fmt.Errorf("saving raw response: %w", err)
			}
			log.Printf("  raw response saved to %s", save)
		}
		return body, nil
	}

	// errors.Join keeps every failure, so a hidden cause is not lost behind the
	// last one.
	return nil, fmt.Errorf("all endpoints failed: %w", errors.Join(errs...))
}

func postQuery(ctx context.Context, client *http.Client, url, query string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url,
		strings.NewReader(query))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "text/plain;charset=UTF-8")
	// Several mirrors answer 429 or 406 without a meaningful User-Agent.
	req.Header.Set("User-Agent", userAgent)

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		excerpt := strings.TrimSpace(string(body))
		if len(excerpt) > 200 {
			excerpt = excerpt[:200] + "…"
		}
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, excerpt)
	}
	return body, nil
}

func buildQuery() string {
	var b strings.Builder
	fmt.Fprintf(&b, "[out:json][timeout:%d][bbox:%g,%g,%g,%g];\n(\n",
		overpassTimeoutS, bbox[0], bbox[1], bbox[2], bbox[3])

	for _, t := range boardwalkTags {
		fmt.Fprintf(&b, "  way[%q=%q];\n", t.Key, t.Value)
	}
	for _, n := range boardwalkNames {
		fmt.Fprintf(&b, "  way[\"name\"=%q];\n", n)
	}

	// Note: no highway filter here. It looks like an optimisation but makes
	// Overpass pick a far slower plan (measured: 1 s without, 30 s+ with).
	// Filtering by highway happens below instead.
	b.WriteString(");\nout tags geom;\n")
	return b.String()
}

type stats struct {
	notRelevant, noConfidence, tooFewPoints, duplicate int
}

// convert filters the Overpass elements down to plausible boardwalks and trims
// each one to what the UI needs.
//
// This is the only place that decides whether a way counts as a boardwalk. Keep
// it that way: the browser sees only what this ships.
func convert(elements []overpassWay) ([]outWay, stats) {
	var st stats
	seen := make(map[int64]bool, len(elements))
	ways := make([]outWay, 0, len(elements))

	for _, e := range elements {
		if e.Type != "way" {
			continue
		}
		switch {
		case seen[e.ID]:
			st.duplicate++
			continue
		case !isRelevant(e.Tags):
			st.notRelevant++
			continue
		case !looksLikeBoardwalk(e.Tags):
			st.noConfidence++
			continue
		}

		geom := geometry(e.Geometry)
		if len(geom) < 2 {
			st.tooFewPoints++
			continue
		}

		seen[e.ID] = true
		ways = append(ways, outWay{
			I: e.ID,
			N: strings.TrimSpace(e.Tags["name"]),
			T: pickTags(e.Tags),
			G: geom,
		})
	}

	return ways, st
}

// geometry drops the null entries Overpass emits for nodes outside the query
// area and rounds to 5 decimals: about 1.1 m, finer than OSM survey accuracy,
// and worth roughly a fifth of the raw size.
func geometry(points []*geoPoint) [][2]float64 {
	out := make([][2]float64, 0, len(points))
	for _, p := range points {
		if p != nil {
			out = append(out, [2]float64{round5(p.Lat), round5(p.Lon)})
		}
	}
	return out
}

func isRelevant(tags map[string]string) bool {
	return slices.Contains(relevantHighways, tags["highway"]) ||
		tags["man_made"] == "pier"
}

// looksLikeBoardwalk reports whether the tags say anything about a boardwalk at
// all. That is the whole test for shipping a way; the browser only grades the
// evidence into a label afterwards.
func looksLikeBoardwalk(tags map[string]string) bool {
	for _, t := range boardwalkTags {
		if tags[t.Key] == t.Value {
			return true
		}
	}

	// No telling tag, so the name is the only evidence — and a name is weak
	// evidence, because "Bohlenweg" is an ordinary German street name. A stated
	// surface that cannot be planks outweighs it.
	return matchesName(tags["name"]) && !hasNonWoodSurface(tags["surface"])
}

func matchesName(name string) bool {
	lower := strings.ToLower(name)
	return lower != "" && slices.ContainsFunc(nameFragments, func(f string) bool {
		return strings.Contains(lower, f)
	})
}

// hasNonWoodSurface reports whether the surface value rules out wooden planks.
//
// Any mention of wood wins, so `wood;gravel` and `woodchips` are kept. That is
// deliberately generous: woodchips are not planks, but a path named Knüppeldamm
// laid with woodchips is a genuine soft-ground path rather than a street address,
// which is what this check is for.
//
// An absent surface tag is not contrary evidence either, so those 11 ways stay.
func hasNonWoodSurface(surface string) bool {
	lower := strings.ToLower(strings.TrimSpace(surface))
	if lower == "" || strings.Contains(lower, "wood") {
		return false
	}
	return slices.Contains(nonWoodSurfaces, lower)
}

// pickTags keeps only the tags the UI reads. Returns nil rather than an empty
// map, because `omitzero` drops a nil map but writes `{}` for an empty one.
func pickTags(tags map[string]string) map[string]string {
	out := maps.Collect(func(yield func(string, string) bool) {
		for _, k := range keepTags {
			if v := tags[k]; v != "" && !yield(k, v) {
				return
			}
		}
	})
	if len(out) == 0 {
		return nil
	}
	return out
}

func round5(v float64) float64 {
	return math.Round(v*1e5) / 1e5
}

// writeJSON writes atomically, so an interrupted run cannot leave the app with a
// half-written dataset. Returns the number of bytes written.
func writeJSON(path string, data dataset) (int, error) {
	if dir := filepath.Dir(path); dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return 0, err
		}
	}

	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(data); err != nil {
		return 0, err
	}

	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, buf.Bytes(), 0o644); err != nil {
		return 0, err
	}
	if err := os.Rename(tmp, path); err != nil {
		return 0, err
	}
	return buf.Len(), nil
}
