# Web GSPro proof

This branch is the isolated browser-first Looper migration proof: direct GSPro database access in desktop Chrome plus hosted OpenGolfCoach enrichment, without Tauri or a local SimRead helper in the live GSPro path.

## Target architecture

`GSPro.db -> desktop Chrome -> existing Looper session pipeline -> hosted OpenGolfCoach API`

- GSPro remains authoritative for measured launch and outcome data.
- OpenGolfCoach is hosted at `/api/open-golf-coach/derive` and is interpretation/enrichment only.
- No Tauri bridge is started for the GSPro path.
- No local SimRead server is started for the GSPro path.
- No local OpenGolfCoach helper is required.

## GSPro browser connection

Looper now remembers the GSPro **folder**, not an individual database selection for every session.

Expected Windows folder:

`C:\Users\User\AppData\LocalLow\GSPro\GSPro`

That folder should contain `GSPro.db`.

First setup:

1. Open Looper in desktop Chrome.
2. Choose **Connect GSPro**.
3. Select the GSPro folder above.
4. Chrome grants read access and Looper stores the directory handle in IndexedDB.

Later sessions:

1. Open Looper.
2. The landing screen should show **GSPro ready** or **GSPro remembered**.
3. Press **Start**.
4. Looper reuses the remembered folder. Chrome may occasionally ask to re-authorize access, but the user should not need to browse back to `GSPro.db` every session.

## Live Windows validation

Use the Vercel preview for branch `web-gspro-proof` in desktop Chrome.

1. Launch GSPro and enter the Practice Range.
2. Open the Looper preview.
3. Connect the GSPro folder if this browser has not already remembered it.
4. Choose a club and start a Looper session.
5. The browser reader baselines the latest existing `DrivingRangeShot.ID`; old range shots should **not** be imported into the new session.
6. Hit one Practice Range shot.
7. Confirm one new shot appears in Session Intelligence.
8. Compare at least carry, total, offline, ball speed, VLA, HLA, spin and spin axis against GSPro.
9. Hit several shots at normal pace and confirm each produces exactly one Looper shot.
10. Hit multiple shots close together and confirm none are skipped or duplicated.
11. End the Looper session and start a second one without reconnecting the folder. Confirm no file picker is required unless Chrome explicitly asks to restore permission.
12. Refresh/reopen the web app and confirm the GSPro folder is still remembered.

## Success criteria

The browser-first architecture is proven when all of the following are true:

- A new GSPro Practice Range row is detected reliably while GSPro is running.
- The first shot after Looper session start is captured; pre-session rows are ignored.
- Multiple new rows are drained in ID order without gaps or duplicates.
- Existing Looper Session Intelligence receives the shot without a Tauri or SimRead runtime.
- Hosted OpenGolfCoach enrichment succeeds for rows with the five required launch inputs.
- The GSPro folder survives a browser reload through the remembered IndexedDB handle.

## Current safeguards

- Poll interval: 750 ms.
- Dedupe/cursor: `DrivingRangeShot.ID`.
- Catch-up reads are ordered by ascending row ID.
- Full catch-up batches force another read even when file metadata does not change again.
- A failed SQLite snapshot read does not advance the file signature, so the next poll retries it.
- The browser reads a fresh `File` snapshot from the granted handle before parsing SQLite.

## Hosted OpenGolfCoach proof

CI installs `opengolfcoach==0.3.0` on Python 3.12 and runs a real calculation.

The deployed GET health route also runs a real OpenGolfCoach calculation inside Vercel and returns `self_test.ok: true` when the hosted runtime is functioning.

## Migration caution

This branch was created from the remote GSPro beta work (`wip-packaged-simread-sse-bridge`). It must **not** be merged blindly over newer local Looper work. Once the browser architecture is proven on Windows, reconcile these plumbing changes against the actual latest Looper branch while preserving the current UI and analytics.
