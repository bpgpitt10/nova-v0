# GSPro persistent round watcher — field validation

This watcher is the one-launch harness for the current minimap hazard/green validation stage.

## What it does

- Watches GSPro continuously while you play several holes.
- Detects a new tee from the minimap `Tee` surface label plus course/hole identity.
- Runs the proven v8 tee HoleModel capture once for each new hole.
- Watches the upper-left GSPro shot counter after the tee.
- When the shot counter advances by one, runs the safe post-tee v1 canonical-registration / cached-green-visibility probe once for that shot.
- Persists watcher state atomically so `Ctrl+C` or an interrupted session cannot leave a partial JSON state file.

## Safety contract for this validation stage

- Tee capture may press `Y` for the green heatmap and restores the prior heatmap state.
- Tee capture does **not** use `W`.
- Post-tee v1 does **not** use `W` or `Y`; it only reports whether zoom-out recovery would have been recommended.
- Automatic recommendation aim actuation is not part of this watcher.
- The existing AIM-card acquisition may use controlled arrow-key movement, but the capture path verifies return to the original aim.
- A failed capture is not retried repeatedly on the same hole/shot; the watcher records the failure and keeps the round moving.

## Normal field-session launch

Start GSPro and begin on a new-hole tee before hitting. Then in PowerShell:

```powershell
Set-Location "C:\Users\User\nova-v0"
git fetch origin
git switch minimap-hazard-water-v0
git pull --ff-only origin minimap-hazard-water-v0
powershell -ExecutionPolicy Bypass -File ".\tools\minimap_probe\run_round_watch_windows.ps1"
```

Then play normally for roughly 4–6 holes. Auto-putt is fine. Press `Ctrl+C` when finished.

A normal launch starts with fresh watcher state. If the watcher is accidentally stopped mid-round and you want to continue the same round, relaunch with `-Resume`:

```powershell
powershell -ExecutionPolicy Bypass -File ".\tools\minimap_probe\run_round_watch_windows.ps1" -Resume
```

To validate detection only, without launching tee/post-tee captures:

```powershell
powershell -ExecutionPolicy Bypass -File ".\tools\minimap_probe\run_round_watch_windows.ps1" -DryRun
```

## Output

Watcher state is written to:

`tools/minimap_probe/output/round_watch_state.json`

Tee and post-tee probes continue writing their normal capture artifacts under `tools/minimap_probe/output/`. Tee review-ZIP packaging is suppressed during the round to reduce unnecessary latency; raw artifacts are retained for review.

## Current validation boundary

The persistent orchestration code is ready for a simulator field run, but it is not yet field-proven as an end-to-end multi-hole loop. The first 4–6-hole session should validate:

1. new-hole tee detection and one capture per hole;
2. shot-counter transition detection and one post-tee capture per shot;
3. post-tee v1 canonical registration accuracy;
4. cached-green visibility decisions, especially when GSPro crops the green from the minimap;
5. that no duplicate actions or unwanted UI changes occur during normal play.

Do not enable automatic `W` recovery until those post-tee visibility decisions have been reviewed.
