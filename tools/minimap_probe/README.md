# GSPro Minimap Hazard Probe

Standalone proof-of-concept for turning the GSPro minimap into usable course geometry without touching Looper app code.

## What it does now

- Captures the GSPro monitor or analyzes a saved screenshot.
- Crops the minimap using the current GSPro layout proportions.
- Detects the player marker without assuming it is red. This is intentional because the marker may follow team color.
- Detects the white pin marker.
- Reads `DistanceToPin` from `C:\Users\<user>\AppData\LocalLow\GSPro\GSPro\currentRound.dat` when available.
- Recomputes minimap scale every shot as `DistanceToPin / ball-to-pin pixels`, so GSPro zoom changes do not need to be reverse engineered.
- Treats GSPro red boundary lines as penalty-area boundaries.
- Reports each visible penalty-boundary component in yards relative to the ball-to-pin axis, including whether it enters a configurable target corridor.
- Writes `latest_crop.png` and `latest_debug.png` so we can inspect what the CV actually detected.

No Looper UI, persistence, aim recommendation, bunker classification, or Stock/Pure integration is included yet.

## Fastest live test on the sim PC

From the repo root on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File tools\minimap_probe\run_probe_windows.ps1
```

The launcher creates its own small Python virtual environment on first run, installs `numpy`, `opencv-python`, and `mss`, then checks the screen every 2 seconds.

Stop with `Ctrl+C`.

Debug images are written to:

```text
tools\minimap_probe\output\latest_crop.png
tools\minimap_probe\output\latest_debug.png
```

## One-shot screenshot test

```powershell
tools\minimap_probe\.venv\Scripts\python.exe tools\minimap_probe\probe.py --image C:\path\to\screenshot.png --distance 440
```

`--distance` is useful when testing a screenshot or if the current GSPro state file is stale.

## Useful options

```text
--monitor 1            Physical monitor index used by mss.
--watch 2              Re-run every 2 seconds.
--distance 245         Override currentRound.dat pin distance.
--corridor 40          Half-width of the target corridor in yards.
--roi x,y,w,h          Override the minimap crop in screen pixels.
--json                 Emit structured JSON instead of console prose.
```

Example with a manual ROI:

```powershell
powershell -ExecutionPolicy Bypass -File tools\minimap_probe\run_probe_windows.ps1 -Roi "1735,600,300,510"
```

## POC validation already performed

The algorithm was run against the screenshots collected in the September 5 minimap experiment.

Observed automatic map scales:

- Hole 1 tee, 440 yd: about `1.191 yd/px`
- Hole 3 tee, 344 yd: about `0.940 yd/px`
- Hole 3 fairway, 116 yd after GSPro zoomed: about `0.315 yd/px`

The same ball/pin detector found the correct markers across those zoom states, and the red penalty-boundary extractor produced the visible red geometry. This is the reason the probe recalibrates each shot instead of trying to model GSPro's zoom behavior.

## Known POC limitations

1. `currentRound.dat` is useful but has previously been observed to lag or be incomplete around some hole/tee transitions. For the probe, `--distance` is the fallback. Looper can later supply its existing live shot-state distance instead.
2. Player-marker hue is deliberately not hard-coded. We still need to verify whether changing team color changes the minimap marker color.
3. The default minimap crop is based on the current screenshots. If the monitor/UI layout differs, pass `--roi` and then update the normalized defaults once we have the real sim-PC capture.
4. Penalty areas are the first high-confidence hazard class. Bunkers are visibly segmentable but are intentionally deferred until this live capture path is proven on the sim PC.
5. This reports geometry; it does not yet overlay Looper dispersion or choose an aim point.

## Next step if the live probe holds up

Feed the penalty mask and current map transform into a small aim-risk layer that projects Looper's Stock/Pure shot pattern into the minimap coordinate system. That should remain separate until the screen capture and hazard geometry are stable.
