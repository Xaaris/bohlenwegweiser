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
under 25 m the file holds 15,728 ways at 0.57 MB gzipped — small enough to ship
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

- removes the duplication — the union-find over vertex distances now exists only
  in Go;
- cuts the browser's grouping from 29 ms to 10 ms on the real 15,728 ways;
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

The cost went the right way. Assembling all 15,728 ways into groups measures
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
of these apply:

- `bridge=boardwalk` or `surface=wood`
- `boardwalk=yes`, `footway=boardwalk`, `surface=boardwalk`
- only a matching name such as _Bohlenweg_

Three of those tags match almost nothing in Germany — `boardwalk=yes` and
`footway=boardwalk` match zero ways, `surface=boardwalk` matches 4. They stay
anyway: the covered region is one variable (`bbox`), and those tags are used
elsewhere, so removing them would quietly break the first wider rebuild.

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

### Not everything is a Bohlenweg

The app used to label every result "Bohlenweg". Counting the shipped groups, most
of them are not one:

| kind | label | groups | median length |
| ---- | ----- | ------ | ------------- |
| wooden bridge | _Holzbrücke_ | 3237 | 40 m |
| wooden path | _Holzweg_ | 2328 | 83 m |
| pier or jetty | _Steg_ | 1008 | 63 m |
| boardwalk | _Bohlenweg_ | 877 | 81 m |
| wooden stairs | _Holztreppe_ | 572 | 41 m |

A 40 m wooden bridge over a stream is not a boardwalk, and neither is a flight of
steps. Each group now carries a `kind`, shown as the first pill on its card and as
the line colour on the map. Nothing is excluded — a 443 m wooden staircase is
worth seeing, it just should not claim to be a Bohlenweg.

`surface=wood` cannot make this distinction: it covers 100% of the bridges, 100%
of the stairs and 97% of the piers. `highway` and `bridge` can, and both were
already in the file, so no new data was needed:

```
man_made=pier              -> Steg          (wins over any bridge tag)
bridge=boardwalk           -> Bohlenweg
highway=steps              -> Holztreppe
bridge=<anything else>      -> Holzbrücke
otherwise                  -> Holzweg
```

163 ways carry both `man_made=pier` and `bridge=*`. The pier wins: a jetty built
as a bridge is still a jetty, and _Steg_ is the more useful word for it.

A group's kind is the one covering most of its **length**, not the most ways.
1577 groups mix kinds, and a 400 m boardwalk with a 20 m bridge in the middle is a
boardwalk; counting ways would let a handful of short segments outvote the thing
you actually walk on. Checked against OSM: Seebrücke Lubmin is 74% boardwalk by
length, the Schwedenlöcher 97% stairs, Neue Seebrücke 69% pier.

This also fixed `titleOf`, which called an unnamed wooden bridge
"Holzweg (unbenannt)" — 2411 groups now read "Holzbrücke (unbenannt)" instead.

The old _Sicher_ / _Wahrscheinlich_ / _Unsicher_ confidence label is gone. It was
derived from the same tags and had stopped saying anything useful: 8006 of 8022
groups were "Sicher", because `surface=wood` alone earned the top grade. Naming
the structure is the honest version of what it was trying to convey.

### Which names count

Two lists drive the name half of the search, and they work differently:

- `boardwalkNames` builds the Overpass query and matches names **exactly**
- `nameFragments` filters the response and matches **substrings**

So a word has to be in **both** to have any effect. The exact matching is not an
oversight: `way["name"="Bohlenweg"]` uses an index, while a regex over all of
Germany makes Overpass pick a far slower plan (1 s versus 30 s+). A way called
_Holzbohlenweg_ is therefore never fetched by name, only by its tags.

The rule for adding a word is that it must name the **structure**, not the
setting. _Bohle_, _Bretter_, _Planke_, _Knüppel_ and _Steg_ describe planks, logs
or a raised walkway. Words that only say where a path goes were measured and left
out:

| candidate  | ways in Germany | walkable, untagged | verdict |
| ---------- | --------------- | ------------------ | ------- |
| `Knüppelweg` | 33 | 8 | **added** — a corduroy road by definition |
| `Plankenweg` | 10 | 3 | **added** — planks are in the name |
| `Knüppelpfad` | 1 | 0 | **added** for symmetry; its one way was already in via `surface=wood` |
| `Holzweg` | 973 | 72 | rejected — a timber haul road, and the idiom for the wrong track |
| `Moorweg` | 884 | 51 | rejected — a path through a moor need not be planked |
| `Moorpfad` | 7 | 2 | rejected — same reasoning |
| `Stegweg` | 19 | 4 | rejected — a way *to* a Steg is not itself one |

Adding the three words brought in 11 ways: 8 `Knüppelweg` and 3 `Plankenweg`.
`Knüppelpfad` added none. _Bohlenstraße_ deliberately does not match — a
_Straße_ is a street whatever it is called.

### Grouping

OSM often splits one path into several ways — the median way in the dataset is
just 10 m long. The builder merges any two ways that come within 20 m of each
other. Proximity is the only test.

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

**Names used to block a join** and no longer do. The rule was that two named ways
whose names differ are different paths. It sounded reasonable and was measured to
be the only constraint that ever fired — 137 pairs blocked by names, 0 by the tag
branches beside it — and it was mostly wrong:

```
"Steg West"          <->  "Steg Ost"            two fingers of one jetty
"Strandübergang 17"  <->  "Dünenpromenade"     a crossing onto the promenade
"Quellentalbrücke"   <->  "Zollhausbrücke"      consecutive spans of one crossing
"Baumwipfelpfad"     <->  "Baumwipfelpfad Harz"  one treetop walk
"Parc éco-Pédagogique" <-> "Parc Eco-Pédagogique" the same name, one accent apart
```

Checked seven pairs against the OSM API: five **share a node**, so they are
physically connected and joining them is simply correct. Dropping the rule merged
27 groups. With it gone, `samePath` had nothing left to do and was deleted rather
than left as a function that always returns true.

`layer` looks like it should keep a bridge crossing *over* a boardwalk separate,
and it is in the raw response. It is not usable: **2472 pairs share an exact
coordinate while differing in layer**, including ways with identical names, because
a ramp onto a bridge legitimately changes layer. A shared node means you can walk
from one to the other, whatever the layer says.

One side effect worth knowing: a group is titled after its lowest-numbered named
way, so the 2.6 km beach network at Grömitz is listed as "Strandübergang 4" even
though it contains eight crossings and two promenades. Not wrong, but not the name
a local would use.

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
