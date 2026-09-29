# High-resolution green terrain in the course importer

Looper treats detailed green terrain as an optional sidecar to the canonical `course-v1.json` package:

`public/course-geometry/<courseSlug>/green-detail-v1.json`

The sidecar uses schema `looper-course-green-detail-v1`. It contains a compact high-resolution elevation grid around each target green plus a coarse 3×3 tactical summary (`front|middle|back` × `left|center|right`). It is intended for approach/short-game landing strategy, not putting-break prediction.

## Build from a configured DEM

A course build config may add:

```json
{
  "greenTerrain": {
    "demUrl": "https://example.org/course-bare-earth-dem.tif",
    "datasetName": "Provider / dataset name",
    "sourceResolutionMeters": 1,
    "spacingYards": 1,
    "marginYards": 12
  }
}
```

`demUrl` must resolve directly to a georeferenced GeoTIFF/COG readable by Rasterio. The canonical rebuild downloads it and runs `tools/build_course_green_detail.py` against the freshly generated course package. The compiler uses the package's selected-tee and target-green WGS84 anchors plus its hole-local green polygon; no course-specific coordinate constants are required.

The importer intentionally does **not** discover or guess an elevation provider. A trusted DEM source must be configured explicitly. Automatic source discovery/selection is a separate future capability and should not be added until source quality and GSPro correspondence are proven across more than the Greywolf pilot.

## Carry forward a proven sidecar

When rebuilding geometry without a fresh DEM, `config/course-rebuild-request.json` may specify:

```json
{
  "greenDetailSourceRef": "<git ref or commit containing the proven sidecar>"
}
```

If `greenDetailSourceRef` is omitted, the importer falls back to `terrainSourceRef` for the green-detail lookup. A sidecar is only carried when that exact source ref contains `public/course-geometry/<courseSlug>/green-detail-v1.json`.

## Validation and provenance

Every generated or carried sidecar is checked by `tools/validate_course_green_detail.py` before the rebuild can commit it. Structural validation covers the 18-hole contract, grid encoding/dimensions, <=2 yd runtime spacing, green summaries, 3×3 sector IDs, and compatibility with the canonical course package's green polygons and geodetic anchors.

The rebuild then runs `tools/audit_course_green_surface_quality.py` against the actual canonical green polygons. That audit checks DEM coverage and registration and reports the same 3-yard local-plane fit quality used by Live Caddie tactical slope logic. A patch is considered tactically trusted when at least 8 on-green samples fit a local plane with <=0.35 ft RMS residual.

**Slope magnitude is not a rejection criterion.** Coherent steep banks are valid terrain. Low local-planarity is reported because it may indicate a real tier/ledge or a source-quality problem; it is not automatically flattened or rejected. Missing green coverage or a mismatch between the sidecar and canonical green polygon is a hard ingest failure.

`cache-v1.json` records the green-detail schema, SHA-256, spacing/margin, and source dataset so a later rebuild can detect exactly which high-resolution terrain asset was used.

## Current automation boundary

Today the automatic path is:

`configured trusted DEM -> canonical green polygons -> ~1 yd green-detail sidecar -> structural validation -> surface-quality audit -> provenance/cache -> runtime`

The intentionally manual boundary is choosing the trusted DEM source. Once GSPro heatmap validation confirms the source terrain corresponds closely enough to the simulator model, provider discovery and automatic source selection can be considered separately.
