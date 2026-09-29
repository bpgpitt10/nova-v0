# Looper course terrain package v1

`looper-course-terrain-v1` is the reusable intermediate contract between LiDAR/DEM ingestion and the final browser course package.

The browser does **not** load this file directly. `tools/compose_course_package.py` combines it with a `looper-static-course-package-v1` geometry package so each course ships as one self-contained runtime artifact containing OSM geometry/context plus LiDAR terrain/contours.

## Required top-level fields

```json
{
  "schemaVersion": "looper-course-terrain-v1",
  "courseId": "royal-new-kent-providence-forge-va",
  "source": {
    "dataset": "source dataset name",
    "sourceResolutionMeters": 1
  },
  "runtimeTerrain": {
    "interpolation": "bilinear",
    "encoding": "uint16 deci-feet above per-hole offset",
    "nodata": 65535,
    "note": "optional source/runtime note"
  },
  "holes": {}
}
```

`courseId` must exactly match the geometry package.

## Required per-hole fields

Every hole 1-18 must be present when a course is promoted to a complete package.

```json
{
  "coordinateSystem": {
    "origin": "osm-hole-route-start"
  },
  "grid": {
    "minX": -115,
    "minY": -28,
    "spacingYds": 10,
    "width": 24,
    "height": 48,
    "elevationOffsetFt": 142.3,
    "compression": "deflate",
    "valuesBase64": "..."
  },
  "contours": [
    {
      "elevationFt": 150,
      "points": [[-12.1, 85.0], [-8.2, 90.4]]
    }
  ]
}
```

The per-hole `coordinateSystem.origin` must match the corresponding geometry package hole. The composer rejects mismatches rather than combining unregistered OSM and LiDAR data.

## Grid encoding

The runtime grid uses the same proven representation as the Greywolf terrain package:

1. Elevations are feet.
2. Choose a per-hole `elevationOffsetFt`.
3. Store `(elevationFt - elevationOffsetFt) * 10` as unsigned 16-bit integers.
4. Reserve `65535` for nodata.
5. Serialize values in row-major **little-endian uint16** order.
6. Deflate the bytes.
7. Base64-encode the compressed bytes into `valuesBase64`.

The browser loader explicitly decodes little-endian values and verifies that the decompressed byte count equals `width * height * 2`.

## Final static package

The composer embeds the terrain in each static-package hole as:

- `terrain`: self-contained grid metadata + compressed values
- `contours`: visualization lines in the same Looper hole-local yard frame as OSM geometry

It also retains top-level `terrainProvenance` so source metadata travels with the final artifact.

Existing OSM-only `looper-static-course-package-v1` files remain valid. Terrain is optional at the schema level for backward compatibility, but a new pilot course should not move from `packageStatus: missing` to a user-selectable status until its intended OSM + terrain package has been composed and validated.
