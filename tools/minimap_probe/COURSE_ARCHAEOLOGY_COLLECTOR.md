# GSPro Course Archaeology Collector v0

Purpose: capture a complete, low-risk forensic snapshot of the currently relevant GSPro course so later course-file archaeology can be done remotely without repeated simulator-PC interaction.

This collector is diagnostic only. It does not actuate GSPro, does not alter Looper strategy, and does not require Gemini.

## What it collects

The collector attempts to discover:

- GSPro LocalLow data directory
- `GSPro.db`
- current/recent round course identity
- the active/recent course GKD path from `Round.CourseGKD` when present
- the corresponding installed course folder

For the selected course folder it writes:

- recursive file inventory
- size, timestamps, extension, SHA-256, entropy sample, magic bytes
- printable-string samples for opaque/binary files
- text previews for text-like files
- copies of small archaeology-relevant files such as GKD/GKDalt/GKD_BAK/LRS/LRSv2/LRSv35/CSV/JSON/TXT/BIOME/DAT files
- a SQLite schema snapshot and recent `Round` rows from `GSPro.db`
- currentRound / output_log / settings snapshots when available
- one manifest JSON describing discovery decisions and all collector warnings/errors

Large Unity/course binaries are NOT blindly copied into the review ZIP. The collector inventories them and stores bounded forensic samples so the bundle stays uploadable.

## Windows run

From the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\minimap_probe\run_course_archaeology_collector_windows.ps1
```

Optional overrides:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\minimap_probe\run_course_archaeology_collector_windows.ps1 `
  -GsproRoot "C:\GSProV1" `
  -CourseFolder "C:\GSProV1\Core\GSP\Courses\pebblebeach_gsp"
```

The launcher prints the final review ZIP path. Upload that one ZIP for remote analysis.

## Safety / size rules

- Read-only collection.
- No keyboard/mouse input.
- No screen capture.
- No secrets or environment variables are collected.
- Files larger than the copy threshold are inventoried only.
- Per-file text/string extraction is bounded.
- Individual failures are logged and the collector continues.

## Output

Default output root:

`tools/minimap_probe/output/course_archaeology_<timestamp>/`

Review archive:

`tools/minimap_probe/output/course_archaeology_review_<timestamp>.zip`
