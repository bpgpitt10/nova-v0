# Browser-native GSPro connection

Production candidate for hosted Looper on Windows + Chrome/Edge.

- User selects the GSPro folder once and grants persistent read/write permission.
- Looper stores the directory handle in IndexedDB and restores it on later visits.
- The browser reads `GSPro.db` directly and polls `DrivingRangeShot` for new rows.
- Browser events are normalized into the existing SimRead final-shot shape so the downstream Looper session and OGC enrichment pipeline stays unchanged.
- Tauri/local SimRead remains available as a fallback path.
- Mac and other non-Windows web viewers are not gated by the GSPro filesystem setup.

Validation already completed on the simulator PC for the spike implementation: direct database read, live shot detection, write access, persistent permission after browser restart, and normal Looper shot ingestion all worked. The `web-browser-gspro` branch is the hardened candidate for final parity testing before merge into `web-gspro-clean`.
