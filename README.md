# Bohlenwegweiser

Finds Bohlenwege, Moorstege and other boardwalk-like paths using OpenStreetMap
data. Pan and zoom the map; everything in view is drawn and listed.

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
work. Run it whenever you want fresh data — there is no scheduled job.

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
| `src/types.ts`      | The data types. Start here.                             |
| `src/config.ts`     | Tunable values: dataset URL, zoom threshold, tags.      |
| `src/dataset.ts`    | Loads the dataset and filters it to the viewport.       |
| `src/boardwalks.ts` | The interesting part: filter, score and group the ways. |
| `src/geo.ts`        | Distance maths and number formatting.                   |
| `src/map.ts`        | All Leaflet-specific code.                              |
| `src/main.ts`       | Wires the DOM to the above.                             |

Plus `tools/build-dataset/main.go`, which produces the dataset.

The data flow is: `boardwalks.json` → `waysInBounds` → `parseWays` → `groupWays`
→ render.

### Why a prebuilt dataset

The app used to query Overpass on every search. Measured across five places,
that took a median of 2.9 s, ranging from 0.6 s to a timeout, because public
instances are shared and their load is unpredictable. Racing two mirrors helped
but did not fix it.

All boardwalk candidates in Germany come to 48,000 ways, which is 1.3 MB
gzipped — small enough to ship as a static file. Measured after the change:
0.2 s for the first view including the download, then about 20 ms per redraw.

The dataset is as old as the last rebuild. For boardwalks that is fine.

### Viewport rendering

There is no search radius and no search button. Every pan and zoom redraws
whatever falls inside the visible area, which is cheap once the dataset is in
memory.

Below zoom 10 nothing is drawn and the map says so
(`MIN_ZOOM_FOR_RESULTS` in `src/config.ts`). Measured at zoom 10 over Berlin
with the length filter off: 148 groups with the default filter, 837 without.
Further out it would be all 48,000, which is both slow and unreadable — the
lines overlap into noise.

The sidebar list is capped at 50 entries (`MAX_LIST_ITEMS`) with a note about
how many more there are; the map still draws all of them. Without the cap,
rendering 837 cards measured 79 ms of layout for a list nobody scrolls through.

### Finding boardwalks

OSM has no single tag for a Bohlenweg, so `confidenceOf` scores the tags and the
UI shows the result as _Sicher_, _Wahrscheinlich_ or _Unsicher_:

- `bridge=boardwalk` or `surface=wood` → high
- `boardwalk=yes`, `footway=boardwalk`, `surface=boardwalk` → medium
- only a matching name such as _Bohlenweg_ → low

Ways must also be a footpath (`highway=footway`, `path`, ...) or a
`man_made=pier`, which filters out wooden driveways and terraces.

The dataset builder applies the same filters so the file stays small. The
browser then re-applies them, which keeps it authoritative about what counts as
a boardwalk: a stale dataset shows up as extra candidates, not wrong labels.

### Grouping

OSM often splits one path into several ways — the median way in the dataset is
just 10 m long. `groupWays` merges ways that touch (endpoints within 20 m) and
look like the same path. Differently named ways are never merged, even where
they meet.

Only ways whose endpoints fall into the same grid cell are compared, so a large
radius returning thousands of ways stays fast.


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
- GitHub Pages serves JSON gzipped, so the 6.3 MB dataset goes over the wire at
  1.3 MB. Verified against a live Pages site: `content-encoding: gzip`.

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
