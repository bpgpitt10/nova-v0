# GSPro GKD Archaeology v0

This is Step 3 of the isolated `hazard-field-lab-v0` work. It turns installed GKD-family data and `Round.CourseGKD` payload candidates into a normalized, reviewable archaeology dataset. It is **read-only** and every result is `strategy_authority=false`.

## What it does

- Finds recent GSPro `Round` rows and uses `CourseName` / `CourseCode` as the primary installed-course identity hints.
- Treats `Round.CourseGKD` as an opaque payload unless it clearly looks like an actual `.gkd` / `.gkdalt` / `.gkd_bak` path. This avoids the prior bad assumption that the large base64-looking DB field is a Windows filename.
- Finds all GKD-family variants under the resolved course folder.
- Tries multiple non-destructive decode paths: plain JSON; UTF-8/16/32; JSON after a binary/text prefix; nested JSON-string roots; base64; gzip; zlib/raw DEFLATE; bzip2; LZMA; and ZIP members.
- Records every decode attempt when a payload stays opaque so the next parser iteration can be done from the review artifacts.
- Recursively inventories JSON schema paths/types.
- Extracts coordinate-bearing structures without requiring one hard-coded GKD schema. It recognizes x/z or x/y/z point dictionaries and numeric 2D/3D point arrays under coordinate-like keys.
- Preserves source JSON path, scalar supporting fields, hole hints, bounds, centroid, polygon candidacy/closure, and all points.
- Adds semantic *candidates* from names such as penalty, water, OB, drop-zone, tee, pin, green, fairway, rough, sand/bunker, or generic hazard.
- Explicitly keeps generic `Hazards` as `hazard_unspecified` unless stronger evidence exists. **`GKD.Hazards` is never assumed to mean bunker geometry.**
- Compares GKD variants by hash, metadata candidates, feature counts, and semantic counts.

## Outputs

A run creates `tools/minimap_probe/output/gkd_archaeology_<timestamp>/` containing:

- `summary.json`
- `features.json`
- `schema_inventory.json`
- `variant_comparison.json`
- `round_course_context.json`
- `manifest.json`
- `reports/*.report.json`
- `reports/*.decoded.json` when a decoded payload is reasonably sized

## Windows run

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\minimap_probe\run_gkd_archaeology_windows.ps1
```

Optional overrides are available for `-LocalLow`, `-GsproRoot`, `-CourseFolder`, and repeatable `-GkdFile` paths.

## Important boundary

This step does **not** parse Unity / `.gspcrse` physical terrain assets. That is Step 4. It also does not capture the screen, call Gemini, run SAM, actuate GSPro, or alter any Looper recommendation.
