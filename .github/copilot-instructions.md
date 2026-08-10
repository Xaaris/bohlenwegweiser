# Bohlenwegweiser — AI agent guide

Static, no-backend web app that finds OSM boardwalks (Bohlenwege, Moorstege) in
Germany. TypeScript + Vite + Leaflet in the browser; a Go CLI prebuilds the
dataset. Deployed to GitHub Pages at
<https://xaaris.github.io/bohlenwegweiser/>.

## Architecture in one line

`public/boardwalks.json` → `loadDataset` (`src/dataset.ts`) → `parseWays` →
`groupWays` → `groupsInBounds` (`src/boardwalks.ts`) → `BoardwalkMap` + DOM
(`src/map.ts`, `src/main.ts`). Types: `RawWay` → `Way` → `Group` in
`src/types.ts` — read that file first.

Key design decision: there is **no runtime Overpass query**. The whole German
dataset (~0.57 MB gzipped, 15,728 ways) is fetched once and filtered in memory
on every pan/zoom. Do not reintroduce per-search network calls.

Second decision, easy to undo by accident: **grouping happens once, over the
whole dataset**, and the viewport filter (`groupsInBounds`) runs on finished
groups. Filtering ways first and then grouping rebuilt each group from whatever
was on screen, so `way/18963200` reported 3219 m at full extent and 1590 m with
half of it off screen, and sometimes appeared as two cards. Bucketing all 15,728
ways by their group id costs 10 ms once; the box test per pan is 0.1 ms.

## Duplicated logic that must stay in sync

`tools/build-dataset` decides **everything** about which ways are boardwalks and
which ones belong together. The grouping used to exist twice; the builder now
emits a group id per way (`c` in the JSON, the smallest member way id) and
`groupWays` (`src/boardwalks.ts`) just buckets by it. Verified equal on the real
file: the shipped ids reproduced the browser union-find's 8357 groups exactly
before that copy was removed.

What is left to keep in step:

| Browser | Go builder |
| --- | --- |
| `MIN_LENGTH_M` = 25 (`src/config.ts`) | `minLengthM` (`main.go`) |
| `kindOf` (`src/boardwalks.ts`) | `boardwalkTags`, `keepTags` (`main.go`) |

**Deciding what counts as a boardwalk lives only in the builder** (`isRelevant`,
`looksLikeBoardwalk`, `boardwalkTags`, `nameFragments`, `relevantHighways`,
`nonWoodSurfaces`). `nonWoodSurfaces` applies **only** to ways that qualify on
their name alone — "Bohlenweg" is a common street name, and 37 asphalt or
compacted tracks were being shipped as boardwalks. Never let it override an
explicit `bridge=boardwalk`, and note that any value mentioning wood is kept. The
browser used to repeat those checks defensively; measured against the real file
the copy dropped 0 of 15,256 ways, so it was removed. `kindOf`
(`src/boardwalks.ts`) only *classifies* what the builder shipped — add a tag to
`boardwalkTags` and it usually wants a case there too, and anything `kindOf` reads
has to be in `keepTags`.

Joining lives only in the builder too (`joinDistanceM`, `connectedComponents` in
`group.go`). Changing either needs `npm run data` to take effect — the browser
cannot recompute it.

**Proximity is the only join test.** A `samePath` check used to refuse to join two
named ways whose names differed; measured, it blocked 137 pairs and its tag
branches blocked 0, and the blocked pairs were things like "Steg West"/"Steg Ost"
and "Strandübergang 17"/"Dünenpromenade" — five of seven sampled pairs share an
OSM node. Don't reintroduce a name or tag similarity test. Don't reach for `layer`
either: 2472 pairs share a coordinate while differing in layer, same-named ways
included, because a ramp onto a bridge changes layer.

`connectedComponents` compares **every vertex**, not just endpoints: OSM splits
ways so one ends mid-way through another, and endpoints-only left 303 real
networks split. Don't add an angle test — a right-angle branch is still the same
network. Don't raise `joinDistanceM` either; 20 m already covers 69% of joins
(median 5.41 m) and widening it risks chaining parallel boardwalks.

Two more copies that are *not* Go-related and get missed:

- Line colours in `LINE_STYLE`/`SELECTED_STYLE` (`src/map.ts`) are hard-coded hex
  because CSS variables aren't readable from JS. Keep them in step with the
  palette in `src/styles.css`.
- `boardwalkNames` (exact, builds the query) and `nameFragments` (substring,
  filters the response) in `main.go` are two halves of one rule: a new word needs
  to be in **both** or it is either never fetched or fetched and discarded.
  `TestNameListsAgree` guards this. Don't switch the query to `name~"..."` —
  measured ~30x slower.
- The `<option>` values of `#minLengthSelect` (`index.html`) are hand-written.
  The lowest one must equal `MIN_LENGTH_M`; `main.ts` clamps the value anyway so
  a stale option can't request data that isn't in the file.


Length filtering runs on **groups, not individual ways** — the median OSM way is
10 m and 81% are under 25 m. Filtering per way would delete real boardwalks.

## UI invariants that broke before

- **No search radius, no search button.** Every pan/zoom redraws whatever is in
  `map.bounds`. Don't reintroduce a search centre; result sorting is by
  `lengthM` alone, because a viewport centre moves and made the list reorder
  itself on every pan.
- **Below `MIN_ZOOM_FOR_RESULTS` (9) nothing is drawn** and `#zoomHint` says so.
  The threshold is a measurement (zoom 8 = 2559 lines = an 87 ms blocking task).
- **Any call that recentres the map must pass `hiddenMapHeight()`** as
  `moveTo`'s `offsetY`. On narrow screens the panel is a bottom sheet *over* the
  map, so without the offset results land behind it and the feature looks dead.
- **Collapsing the sheet hides `.results`/`footer`**; it never translates the
  panel by a measured pixel offset. The panel's height changes with the result
  count, so any stored offset goes stale and can push the handle off-screen.
- **The ODbL attribution must stay reachable.** Desktop: `.panel > footer`.
  Narrow: cloned to the end of the list by `appendAttribution()`. Both paths have
  to keep working when the viewport crosses 820 px.
- Leaflet polylines get `tabindex="-1"`; without it every line is a tab stop
  (16 before the first control at 7 results). Groups stay keyboard-reachable as
  buttons in the list.
- Result cards are built with `createElement`/`textContent`, never `innerHTML` —
  OSM names are untrusted input.
- The list is capped at `MAX_LIST_ITEMS` with a "… und N weitere" note; the map
  still draws everything.
- **A result is labelled by `kind`, not called "Bohlenweg" regardless.** Only 877
  of 8022 groups are boardwalks; 3237 are wooden bridges and 572 are stairs. The
  kind is the one covering most of the group's *length* (1577 groups mix kinds),
  `man_made=pier` beats any bridge tag, and nothing is excluded — that was a
  deliberate product call, so don't start dropping kinds in the builder.
- **Every map line is the same brown, solid, and only the selection is rust.**
  Per-kind colours were tried and removed: there was no legend, and the median
  minority stretch in a mixed group is 10.7 m, which is 1.9 px at zoom 14. Don't
  reintroduce per-kind or per-way colours without a legend and a measurement, and
  don't use dashes — they read as "uncertain" for the most explicitly tagged
  features in the file, and vanish on a 5 px line. The kind belongs on the card
  (`group.composition`) and in the tooltip.
- **The card lists every kind above `MIN_KIND_SHARE`,** longest first. The floor
  exists because 512 of the 1577 mixed groups have only trivial extra kinds;
  without it a 7 m staircase earns a pill on a 400 m boardwalk.
- **There is no confidence label.** `Sicher`/`Wahrscheinlich`/`Unsicher` was
  removed: it graded the same tags `kindOf` reads and had become meaningless, with
  8006 of 8022 groups rated "Sicher" because `surface=wood` alone earned the top
  grade. Don't reintroduce it as a second opinion on the same data.
- **All empty-state wording comes from `emptyReason()`** (`main.ts`), used by both
  the list and the status line. They said different things when the wording was
  duplicated. Outside the dataset's bbox it says so rather than "none here",
  which would claim more than we know.

## Conventions

- Points are `{ lat, lon }` everywhere. Leaflet's `lng`/`LatLng` is confined to
  `src/map.ts`; nothing else imports Leaflet.
- All tunables live in `src/config.ts` with a comment explaining the number
  (usually a measurement). Don't scatter magic values into logic files.
- `tsconfig.json` is strict with `noUncheckedIndexedAccess`; existing code uses
  `points[i] as Point` with a short "safe because" comment rather than `!`
  (non-null assertions are only allowed in `test/**` per `biome.json`).
- ESM with `verbatimModuleSyntax`: relative imports use the `.js` extension
  (`./geo.js`), and types are imported with `import type`.
- Biome formats: 2 spaces, 90-column lines. Run `npm run fix`.
- Comments explain *why* (trade-offs, measurements), not what. Match that tone;
  README sections mirror these rationales — update both when behaviour changes.
- User-facing strings are German (`KIND_LABELS`, `SearchError` messages); code and
  comments are English.
- `src/geo.ts` and `src/boardwalks.ts` are pure functions — keep DOM and network
  out of them so `test/*.test.ts` stays trivial.

## Workflows

```sh
npm install
npm run dev        # http://localhost:5173 (geolocation needs localhost/HTTPS)
npm run check      # typecheck + biome + vitest — run this before finishing
npm test           # vitest run
npm run data       # go run ./tools/build-dataset → rewrites public/boardwalks.json
```

Dataset work without hammering Overpass:

```sh
go run ./tools/build-dataset -save raw.json   # keep the raw response
go run ./tools/build-dataset -from raw.json   # rebuild offline
go test ./tools/build-dataset
```

Go 1.26, standard library only — do not add Go dependencies. Region is the
`bbox` var in `tools/build-dataset/main.go`.

`.github/workflows/deploy.yml` runs `npm run check` then `npm run build` and
publishes `dist/` on push to `main`. `base: "./"` in `vite.config.ts` is required
for the project-page subpath — don't change it.

## Verifying changes

`npm run check` is necessary but does not cover the UI — there are no DOM tests.
For anything touching layout, the map or the panel, drive the dev server with
the Playwright MCP and **measure** (`getBoundingClientRect`, computed styles,
console messages) instead of reasoning about the CSS. Bugs found only that way
include the bottom sheet hiding all results, a grid where auto-placement pushed
the panel into a second row, and a lone card stretched to 511 px.

Measure before optimising, too. Several plausible-looking changes were wrong:
adding a `highway` filter to the Overpass query made it ~30× slower (see the
comment in `buildQuery`), and switching `around` to `bbox` changed nothing.
Numbers in comments and in the README come from real runs — don't invent new
ones.

When you change the builder's grouping, prove the browser still agrees: rebuild,
then compare the shipped group ids against a throwaway re-implementation of the
union-find in the page. That check is what confirmed the two produce identical
8357 groups.

## Testing

Vitest, `test/*.test.ts`, no DOM tests. Tests build fixtures with small helpers
(`way()`, `line()` in `test/boardwalks.test.ts`) and assert lengths with ranges
(`toBeGreaterThan(190)`) rather than exact floats. `way()` takes an optional
`groupId` so tests can put ways in one group the way the builder would. Go tests
use table-driven subtests in `tools/build-dataset/group_test.go`.
