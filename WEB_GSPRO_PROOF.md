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

Browser file permissions and IndexedDB are scoped to the site origin. During preview testing always use the stable branch alias:

`https://looper-web-git-web-gspro-proof-wqk25hkxcg-3591.vercel.app`

Do not switch between Vercel's one-off deployment URLs when testing remembered access; Chrome treats each hostname as a different site. A future production/custom domain will provide the same stable-origin behavior.

If a Session Intelligence URL is refreshed directly, Looper attempts to restore the remembered folder silently when Chrome still reports read permission as granted. It never opens a folder picker from background initialization. If permission must be renewed, return to the landing page and use **Start** or **Connect GSPro** so Chrome can request permission from a user gesture.

## Live Windows validation

Use the stable Vercel branch alias above for branch `web-gspro-proof` in desktop Chrome.

1. Launch GSPro and enter the Practice Range.
2. Open the Looper preview.
3. Connect the GSPro folder if this browser has not already remembered it.
4. Open **GSPro Diagnostics** and confirm browser file access, the remembered folder, `GSPro.db`, and hosted OGC all report ready/healthy.
5. Choose a club and start a Looper session.
6. The browser reader baselines the latest existing `DrivingRangeShot.ID`; old range shots should **not** be imported into the new session.
7. Hit one Practice Range shot.
8. Confirm one new shot appears in Session Intelligence.
9. Compare at least carry, total, offline, ball speed, VLA, HLA, spin and spin axis against GSPro.
10. Hit several shots at normal pace and confirm each produces exactly one Looper shot.
11. Hit multiple shots close together and confirm none are skipped or duplicated.
12. Leave Looper in the background while GSPro is foregrounded, hit shots, then return to Looper. The watcher should force a fresh read on visibility/focus return and drain accumulated rows.
13. End the Looper session and start a second one without reconnecting the folder. Confirm no file picker is required unless Chrome explicitly asks to restore permission.
14. Refresh/reopen the web app and confirm the GSPro folder is still remembered.
15. If anything fails, return to **GSPro Diagnostics** before clearing data or reconnecting so the persisted runtime traces can be inspected.

## Success criteria

The browser-first architecture is proven when all of the following are true:

- A new GSPro Practice Range row is detected reliably while GSPro is running.
- The first shot after Looper session start is captured; pre-session rows are ignored.
- Multiple new rows are drained in ID order without gaps or duplicates.
- Existing Looper Session Intelligence receives the shot without a Tauri or SimRead runtime.
- Hosted OpenGolfCoach enrichment succeeds for rows with the five required launch inputs.
- The GSPro folder survives a browser reload through the remembered IndexedDB handle.
- Returning to a throttled/background Looper tab catches up promptly.
- An incomplete row missing carry, total, or offline is diagnosed and skipped rather than inserted into Looper analytics.

## Current safeguards

- Poll interval: 750 ms.
- Dedupe/cursor: `DrivingRangeShot.ID`.
- Catch-up reads are ordered by ascending row ID.
- Full catch-up batches force another read even when file metadata does not change again.
- A failed SQLite snapshot read does not advance the file signature, so the next poll retries it.
- The browser reads a fresh `File` snapshot from the granted handle before parsing SQLite.
- Returning browser focus or visibility invalidates the file signature so the next poll performs a fresh read.
- Direct route refresh can silently restore a remembered GSPro handle only when permission is already granted.
- Carry, total, and offline are required before a GSPro row is emitted into the Looper shot pipeline.
- Hosted OGC requests require all five finite launch inputs before the request is made.
- Hosted OGC has an 8-second client timeout so enrichment cannot hang indefinitely.
- Hosted OGC JSON responses use `Cache-Control: no-store`, including the live self-test.

## GSPro Diagnostics

The landing page links to `/gspro-web-proof`, now used as the shared **GSPro Diagnostics** page rather than a separate proof implementation. It exercises the same browser connection and database reader as the live session path.

Use it to distinguish where a failure occurred:

- **Browser file access / GSPro connection**: whether desktop Chrome can use the File System Access API, whether a directory handle is remembered, and its current permission state.
- **GSPro.db**: whether the database can be read and the latest `DrivingRangeShot.ID` plus raw `ShotData`.
- **Hosted OGC self-test**: a real calculation executed inside the deployed Vercel Python function.
- **Last live-session GSPro runtime trace**: baseline row ID, poll count, successful reads, read retries, latest observed/emitted row, rows emitted, incomplete rows skipped, page visibility, file signature/timestamps, and last error.
- **Last real-shot OGC runtime trace**: the actual five-field request input from a detected shot, missing fields if any, request count, HTTP status, request duration, derived values, and last error.

The traces are persisted in browser localStorage so they remain available after navigating away from Session Intelligence.

## Hosted OpenGolfCoach proof

CI installs `opengolfcoach==0.3.0` on Python 3.12 and runs a real calculation. CI also checks the five-field hosted request contract.

The deployed GET health route runs a real OpenGolfCoach calculation inside Vercel and returns `self_test.ok: true` when the hosted runtime is functioning.

The hosted POST route requires finite numeric values for:

- `ball_speed_meters_per_second`
- `vertical_launch_angle_degrees`
- `horizontal_launch_angle_degrees`
- `total_spin_rpm`
- `spin_axis_degrees`

For the GSPro path, OGC results are merged as interpretation only; GSPro carry, total, and offline remain authoritative.

## Migration caution

This branch was created from the remote GSPro beta work (`wip-packaged-simread-sse-bridge`). It must **not** be merged blindly over newer local Looper work. Once the browser architecture is proven on Windows, reconcile these plumbing changes against the actual latest Looper branch while preserving the current UI and analytics.
