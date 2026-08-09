<p align="center">
  <img src="docs/logo.png" alt="Bohlenwegweiser" width="200" />
</p>

# Bohlenwegweiser

Finds Bohlenwege, Moorstege and other boardwalk-like paths using OpenStreetMap
data. Pan and zoom the map; everything in view is drawn and listed.

Live at <https://xaaris.github.io/bohlenwegweiser/>.

Searching runs entirely in the browser against a prebuilt dataset of all
boardwalks in Germany, so it updates as you move.

## Getting started

```sh
npm install
npm run dev
```

Then open <http://localhost:5173>.

The repository includes a prebuilt `public/boardwalks.json`, so this works
straight away. To refresh it, see [Updating the data](#updating-the-data).

Geolocation only works over HTTPS or on `localhost`, so use the dev server
rather than opening `index.html` directly.

## Commands

| Command             | What it does                        |
| ------------------- | ----------------------------------- |
| `npm run dev`       | Dev server with hot reload          |
| `npm run build`     | Type-check, then build into `dist/` |
| `npm run preview`   | Serve the built output locally      |
| `npm test`          | Run the tests                       |
| `npm run typecheck` | Type-check only                     |
| `npm run lint`      | Lint and check formatting (Biome)   |
| `npm run fix`       | Auto-fix lint and formatting issues |
| `npm run check`     | Type-check, lint and test together  |
| `npm run data`      | Rebuild the dataset from Overpass   |

## Updating the data

```sh
npm run data          # or: go run ./tools/build-dataset
```

This queries Overpass once for the whole of Germany and rewrites
`public/boardwalks.json`. It takes one to two minutes; Overpass is doing real
work. Run it whenever you want fresh data — there is no scheduled job yet.

Useful flags while working on the builder:

```sh
go run ./tools/build-dataset -save raw.json    # keep the raw Overpass response
go run ./tools/build-dataset -from raw.json    # rebuild from it, no network
```

To cover a different region, change `bbox` in `tools/build-dataset/main.go`.

Needs Go 1.26 or newer. There are no dependencies beyond the standard library.

## How it works

The code is deliberately small. In rough order of interest:

| File                | Contains                                                |
| ------------------- | ------------------------------------------------------- |
| `src/types.ts`      | The data types. Start here.                              |
| `src/config.ts`     | Tunable values: dataset URL, zoom threshold, list cap.   |
| `src/dataset.ts`    | Loads the dataset.                                       |
| `src/boardwalks.ts` | Label, group, sort and clip to view.                     |
| `src/geo.ts`        | Distance maths and number formatting.                    |
| `src/map.ts`        | All Leaflet-specific code.                               |
| `src/main.ts`       | Wires the DOM to the above.                              |

Plus `tools/build-dataset/`, which produces the dataset and decides both what
counts as a boardwalk and which ways belong together.

The data flow is: `boardwalks.json` → `parseWays` → `groupWays` →
`groupsInBounds` → render. Grouping happens once for the whole country, the
viewport filter runs on finished groups.

### Why a prebuilt dataset

The app used to query Overpass on every search. Measured across five places,
that took a median of 2.9 s, ranging from 0.6 s to a timeout, because public
instances are shared and their load is unpredictable. Racing two mirrors helped
but did not fix it.

All boardwalk candidates in Germany come to 51,000 ways. After dropping paths
under 25 m the file holds 15,677 ways at 0.57 MB gzipped — small enough to ship
as a static file.

The dataset is as old as the last rebuild. For boardwalks that is fine.

### The 25 m minimum

Nothing shorter than 25 m is shipped, so the length filter starts there. A 20 m
plank across a ditch is not something anyone travels to see, and leaving them out
halved the download: 1.26 MB to 0.54 MB gzipped.

The filter has to run on assembled groups, not on individual ways. Measured on
the real data: the median OSM way is 10 m long and **81% are under 25 m**,
because paths get split into many short segments. Filtering ways individually
would have deleted 725 boardwalks that are over 25 m once joined, losing 60.7 km
of real path.

### Who groups the ways

The builder does, and it writes the answer into the file: every way carries the
id of its group (`c`, the smallest OSM way id in that group). The browser buckets
ways by that field and never decides adjacency itself.

This used to be a second implementation of the same union-find over endpoint
distances, in `src/boardwalks.ts`, that had to be kept in step with `group.go` by
hand. Shipping the id instead:

- removes the duplication — `connectedComponents`, `samePath` and `touches` now
  exist only in Go;
- cuts the browser's grouping from 29 ms to 10 ms on the real 15,677 ways;
- costs 25 KB gzipped, 4.5% of the file, measured by stripping the field from the
  same data and re-compressing.

The two were checked against each other before the browser copy was deleted: the
shipped ids reproduced the union-find's 8357 groups **exactly**, with no group
appearing in one and not the other.

The trade-off is that a change to the joining rules needs `npm run data` to take
effect. That was already true of the length filter, which the builder applies.

### Viewport rendering

Every pan and zoom redraws whatever falls inside the visible area, which
is cheap once the dataset is in memory.

Grouping runs **once**, over the whole dataset, and only the finished groups are
filtered to the viewport. Doing it the other way round — filter, then group —
assembled each group from just the ways on screen, so the same boardwalk changed
length as the map moved and could split into two cards. Measured on
`way/18963200`, a 3219 m network of 16 ways: with half of it off screen it
reported 1590 m, and at one clipping it appeared as two entries. Since the length
is the only sort key, the list order moved with the map too.

The cost went the right way. Assembling all 15,677 ways into groups measures
10 ms, once, inside the loading indicator; the per-pan work drops from re-grouping
(0.5 ms in a village, 1.4 ms over Hamburg) to a bounding-box test per group at
0.1 ms. First load measured 95–119 ms before and about 167 ms after. The map draws
the same number of lines either way — 1016 over Hamburg at zoom 9 — because a
group is only drawn when its box is in view.

Outside the covered region the app says so instead of "no boardwalks here" —
that would claim OSM has none, when really the dataset just stops at the border.

Below zoom 9 nothing is drawn and the map says so (`MIN_ZOOM_FOR_RESULTS` in
`src/config.ts`). Measured over Hamburg, the densest area:

| zoom | lines drawn | blocking |
| ---- | ----------- | -------- |
| 10   | 291         | none     |
| 9    | 741         | none     |
| 8    | 2559        | 87 ms    |

So 9 is the lowest level that still pans smoothly. Further out the lines also
overlap into noise, which makes them useless to look at anyway.

The sidebar list is capped at 50 entries (`MAX_LIST_ITEMS`) with a note about
how many more there are; the map still draws all of them. Without the cap,
rendering 837 cards measured 79 ms of layout for a list nobody scrolls through.

### Finding boardwalks

OSM has no single tag for a Bohlenweg, so the dataset builder keeps a way if any
of these apply, and `confidenceOf` in the browser grades the evidence into
_Sicher_, _Wahrscheinlich_ or _Unsicher_:

- `bridge=boardwalk` or `surface=wood` → high
- `boardwalk=yes`, `footway=boardwalk`, `surface=boardwalk` → medium
- only a matching name such as _Bohlenweg_ → low

Ways must also be a footpath (`highway=footway`, `path`, ...) or a
`man_made=pier`, which filters out wooden driveways and terraces.

A **name on its own is weak evidence**, because "Bohlenweg" is an ordinary German
street name. So a way that qualifies only through its name is rejected when its
`surface` rules out planks: an asphalt track called Bohlenweg is an address, not a
boardwalk. That dropped 37 ways, all of them streets — 13 `compacted`, 4 each of
`dirt`, `gravel` and `fine_gravel`, 3 `sand`, 3 `concrete`, 2 `asphalt` and so on.

Two deliberate exceptions:

- An **absent** `surface` tag is not contrary evidence, so those ways stay. There
  are 11, such as `way/47591162` (`Bohlenweg`, `highway=track`, no surface).
- Any surface value **mentioning wood** stays, including `woodchips` and compound
  values like `wood;gravel`. Woodchips are not planks, but a `Knüppeldamm` laid
  with woodchips is a real soft-ground path rather than a street address, which is
  what this check is for.

The surface test applies **only** to the name-only path. A way tagged
`bridge=boardwalk` with `surface=compacted` is odd tagging, but the explicit tag
is the stronger signal and it is kept.

Deciding *whether* a way qualifies happens only in `tools/build-dataset`. The
browser used to repeat those checks as a safety net, but measured against the
real file they dropped 0 of 15,256 ways — a second copy to keep in sync for no
effect. It now only labels what the builder shipped. Across the whole dataset
that is 15,665 high, 4 medium and 8 low — the 8 being the name-only ways with no
surface tag.

### Grouping

OSM often splits one path into several ways — the median way in the dataset is
just 10 m long. The builder merges ways that come within 20 m of each other and
look like the same path. Differently named ways are never merged, even where
they meet.

Proximity is tested between **all vertices**, not just the two endpoints of each
way. OSM routinely splits a way so that one *ends in the middle of another* — a
side branch off a boardwalk, a jetty off a walkway — and neither endpoint of the
through-way is anywhere near that junction. Comparing endpoints only left **303
networks split** that are one thing on the ground.

Wurzacher Ried is the clearest example: five side branches attach at shared nodes
partway along one 15-vertex way, so its network went from 321 m in 7 sections to
349 m in 12. The five branches were previously an orphan below the 25 m minimum
and were dropped entirely.

Direction is deliberately ignored — a branch meeting a path at a right angle is
still part of the same network, so there is no angle test. Two ways that merely
cross without sharing a vertex are not joined, because OSM models a real junction
with a shared node.

Only vertices in the same or an adjacent grid cell are compared, so grouping all
51,000 candidates stays near-linear: the whole build takes 0.8 s. See
[Who groups the ways](#who-groups-the-ways) for why the browser no longer repeats
this.

## Deploying

The site is static files, so any static host works. A GitHub Actions workflow
(`.github/workflows/deploy.yml`) publishes to GitHub Pages on every push to
`main`.

To switch it on once: **Settings → Pages → Source: GitHub Actions**. The site
then appears at `https://<user>.github.io/<repo>/`.

Two things make this work without further configuration:

- `base: "./"` in `vite.config.ts`, so assets resolve relative to the page. The
  usual failure mode for project pages is absolute `/assets/...` paths, which
  404 under a subpath.
- GitHub Pages serves JSON gzipped, so the 2.7 MB dataset goes over the wire at
  0.57 MB. Verified against a live Pages site: `content-encoding: gzip`.

Pages limits are 1 GB per site and 100 GB of traffic per month, both far above
what this needs. The deploy workflow runs `npm run check` first, so a failing
test blocks publication.

Updating the map data is separate: run `npm run data` locally and commit
`public/boardwalks.json`. The workflow does not query Overpass.

## Still missing for a public site

The dataset removed the old problem of hitting public Overpass instances on
every search; one query per manual rebuild is well within their usage policy.
Two things remain:

- A paid or self-hosted tile provider (`TILE_URL` in `src/config.ts`). The
  OpenStreetMap tile server is not meant for public apps.
- Impressum and Datenschutzerklärung pages.

## Data

Map data from [OpenStreetMap](https://www.openstreetmap.org/copyright),
available under the Open Database License (ODbL).
