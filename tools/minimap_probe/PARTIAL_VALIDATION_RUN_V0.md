# Greywolf Partial Validation Run v0

## Goal

Use one short natural-play GSPro session to validate the next decision-engine inputs without adding new live UI actuation. The watcher remains validation-only: no recommendation authority, no automatic aim choice, no W zoom, and no post-tee Y heatmap toggle.

## Recommended session

Play about **5 holes normally** with the existing persistent watcher running. Five contiguous holes are fine. If it is easy to choose a useful mix, prefer coverage that includes a dogleg, a hole with adjacent-course visual clutter, a bunker-heavy landing area, at least one visible red/white boundary, and a par 5. Do not hunt for special shots or alter play just for the test.

Optional one-time setup test: if changing GSPro team/player color is easy, use a clearly different color such as purple for this session. That gives us a clean saved corpus for checking whether player-marker detection is actually color-agnostic. Skip this if it is inconvenient.

## Run

From `tools/minimap_probe` on the simulator PC:

```powershell
.\run_round_watch_windows.ps1
```

Start a **fresh** watcher session, then play naturally. The watcher automatically captures:

- one tee HoleModel per hole;
- the normal/Y-toggle tee pair and heatmap-derived target-green mask;
- tee hazard geometry and canonical minimap geometry;
- PIN and AIM distance/elevation;
- post-tee PIN/AIM state and lie;
- post-tee registration back to the tee HoleModel;
- post-tee target-green visibility/cropping evidence;
- AIM summon/return diagnostics;
- durable course/hole/shot/session metadata.

Stop the watcher with `Ctrl+C` after the partial session. No additional Y/W key work is required during play.

Then package only that watcher session:

```powershell
.\run_package_partial_validation_v0_windows.ps1
```

Upload:

`tools/minimap_probe/output/latest_partial_validation.zip`

The package includes a `partial_validation_manifest.json` summary plus the tagged raw capture artifacts needed for offline review.

## What the next package will test

### 1. Fairway — primary open validation

Run Carry Arc v1 offline on each useful tee capture at approximately `C-sigma`, `C`, and `C+sigma` for the selected player/club profile. Grade current-hole route identity, fairway-edge accuracy, and continuity across nearby radii. We do not need station/corridor reconstruction.

### 2. Green — heatmap approach

Validate the already-implemented tee heatmap extractor rather than building a new green Carry Arc model. Review target-green mask/bbox, heatmap confidence, changed-pixel behavior, pin proximity, and visual boundary quality.

The key second-shot test is whether the **tee-captured canonical green** remains correctly usable after post-tee registration. If it does, Looper can reuse one green region for the hole instead of toggling Y again on every approach.

### 3. Post-tee coordinate geometry

Review registration confidence/inliers, canonical player position, PIN-distance cross-check, green visibility, and cases where the current minimap crops the target green. W recovery remains observational only; the watcher does not press W.

### 4. Target-card / elevation robustness

Verify PIN and AIM distance/elevation across natural shots, including any yard or feet/inches elevation formats encountered. Confirm signed uphill/downhill behavior. Under the locked v1 elevation contract, tee uses AIM elevation for nearby candidate aims and approaches to the green use PIN elevation; candidate-specific terrain elevation is not required.

### 5. Lie

Check post-tee lie OCR presence and plausibility across fairway/rough/bunker states encountered naturally.

### 6. Hazard evidence

Review bunker/red/white geometry alignment from the same captures. Preserve red/white boundary-heavy examples for the next unsafe-side orientation work.

### 7. UI / marker robustness

Review AIM summon/return verification and confirm the heatmap state was restored after tee capture. Use saved pixels to test player-marker robustness, especially if the team/player color was changed for the session.

## Deliberately deferred

- Candidate-specific landing-zone elevation.
- Strategy recommendation authority / automatic aim actuation.
- A new post-tee heatmap toggle path unless tee-green reuse fails validation.
- Full continuous fairway/terrain reconstruction.
- Wind extraction in this package unless an independent validated Looper wind source is already populating ShotState; current watcher capture should not invent one.

## Pass/fail decision after upload

This run is intended to answer three architecture questions quickly:

1. Is Carry Arc fairway extraction stable enough to become the strategy surface primitive?
2. Is the tee heatmap-derived green region accurate enough to become canonical green geometry?
3. Can post-tee registration reliably reuse that canonical tee geometry for approach decisions?

If all three are yes, the next engineering focus should move away from surface extraction and toward unsafe-side penalty/OB orientation plus decision utility/scoring.
