# Bohlenwegweiser

Static, local-first finder for OSM-mapped Bohlenwege and boardwalk-like paths.

## Run

```sh
python3 -m http.server 5173
```

Then open <http://localhost:5173>.

Use `localhost` instead of opening `index.html` directly, because browser
geolocation is only available in secure contexts. `localhost` counts for local
development.

## Map style

The base map uses CARTO Voyager raster tiles with OpenStreetMap and CARTO
attribution.

## Data

The app sends direct Overpass API POST requests. It tries:

1. `https://overpass-api.de/api/interpreter`
2. `https://overpass.private.coffee/api/interpreter`

The query looks for pedestrian-ish OSM ways using:

- `bridge=boardwalk`
- `surface=wood`
- `surface=boardwalk`
- `boardwalk=yes`
- `footway=boardwalk`
- exact common names such as `Bohlenweg`, `Bohlensteg`, `Holzsteg`,
  `Moorsteg`, `Moorstege`, and `Boardwalk`

Results are deduplicated, grouped when adjacent, measured client-side, and
ranked by length first with confidence and distance as smaller signals.

The app avoids broad Overpass name-regex scans by default because they can make
otherwise small searches time out.

## Notes

This is a personal MVP. It is not configured for public hosting, GitHub Pages,
or heavy Overpass usage.
