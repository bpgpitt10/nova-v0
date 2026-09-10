# Step 2 status

The one-shot GSPro course archaeology collector is implemented on `hazard-field-lab-v0`.

Included:
- read-only GSPro LocalLow discovery
- `GSPro.db` schema and recent-Round snapshotting
- `Round.CourseGKD`-driven current/recent course discovery with fallbacks
- recursive course-folder inventory
- bounded hashing/fingerprinting, magic bytes, entropy, and printable-string forensics
- bounded text previews and course-signal string extraction
- copies of small archaeology-relevant course files
- bounded snapshots of `currentRound.dat`, `Settings.vgs`, and `output_log.txt`
- fail-soft manifest/warnings/errors
- bounded review ZIP packaging
- one-command Windows launcher
- standard-library unit/smoke tests included for the collector logic

This step does not add GSPro actuation, screen capture, VLM calls, strategy authority, Unity semantic parsing, or GKD semantic parsing.
