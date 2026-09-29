# GSPro Minimap Click Lab

Branch: `minimap-click-lab-v0`

This is an isolated native validation harness. It does **not** import Live Caddie recommendations and it does **not** change normal Looper behavior.

## What it proves

Given a desired point in the live ball-to-pin coordinate frame (or full Looper course coordinates), predict the matching GSPro minimap pixel, click it exactly once when explicitly enabled, then verify the target GSPro actually accepted.

## Safety contract

- Preview-only unless `-Click` is explicitly supplied.
- Never presses W/Q or changes minimap zoom.
- Never sends LEFT/RIGHT aim keys.
- Requires ball and pin marker detection in the current minimap.
- Refuses targets outside the minimap interior.
- Requires a visible verified GSPro window before input.
- Requires the click point to be inside the GSPro window.
- Sends exactly one left click and restores the previous cursor position.
- Saves before / minimap / preview / after screenshots plus JSON evidence.
- Ball registration is fail-closed when the actual player marker cannot be distinguished from GSPro's magenta current-aim marker.

## Current runtime

`run_click_lab_windows.ps1` now launches `click_lab_ready_runner.py`.

That runner layers the live-sim hardening on top of the original lab and resolves distance-to-pin in this order:

1. explicit `-Distance` override, if supplied;
2. fresh GSPro `currentRound.dat` DistanceToPin when the file is no more than 10 minutes old;
3. GSPro PIN-card OCR as the final automatic fallback.

If none is safe, the lab refuses to calibrate and asks for an explicit `-Distance` rather than trusting stale state.

The hardened runtime also:

1. rejects the magenta GSPro current-aim target as a possible ball marker;
2. prints the registered BALL, PIN, and scale before any click;
3. verifies a completed click by detecting the magenta GSPro target marker directly on the minimap;
4. converts that accepted target back into forward/right yards and compares it with the requested target;
5. uses the old AIM-card OCR only as a fallback if direct minimap-marker verification is unavailable;
6. writes `latest_click_lab_marker_verify.png` when direct marker verification succeeds.

`PASS_DISTANCE` now means the accepted GSPro minimap target is within the configured tolerance (default 3 yd) of the requested forward/right target vector. The name is retained for compatibility with the original harness result schema.

## Live validation completed — 2026-09-29

Greywolf Hole 1, tee, approximately 350.2 yd to pin:

- Transform proof passed center/left/right handedness, rotated-minimap math, and zoom/scale conversion.
- 200 yd center preview visually landed on the GSPro ball-to-pin line.
- A repeated 200 yd center one-shot click was accepted by GSPro and visually landed essentially on the intended line/depth.
- Mouse actuation path is therefore proven: Looper can focus GSPro, move to the predicted minimap pixel, send one click, and GSPro accepts that click.

### Failure discovered during +10 yd lateral validation

After GSPro had a magenta current-aim marker visible, the original generic player-marker detector sometimes selected that magenta marker as the ball. That corrupted registration:

- sane first-run scale: roughly `0.52 yd/px`
- bad rerun scale: roughly `1.22 yd/px`
- requested target: `200 yd forward, +10 yd right`
- GSPro accepted target: roughly `270 yd` radial distance

This was a marker-identity failure, **not** a mouse-coordinate failure. The hardened runner now rejects the magenta current-aim marker before registration and verifies the resulting magenta target directly after the click.

## Next sim validation — start here

Do **not** redo the center test.

First update the isolated worktree:

```powershell
cd C:\Users\User\nova-click-lab
git fetch origin
git switch --detach origin/minimap-click-lab-v0
```

Then, with GSPro stopped before a normal full shot, run exactly:

### 1. Preview

```powershell
.\tools\minimap_probe\run_next_click_lab_test.ps1
```

This runs the transform + marker proofs, then previews `+10 yd right / 200 yd forward` with **no mouse input**.

Confirm the console shows:

- `Registration BALL` on the actual player marker, not the magenta current-aim target;
- `Registration PIN` on the white pin marker;
- a plausible scale;
- preferably `Distance source: currentRound.dat ...` so no manual distance is needed.

### 2. One click

If the preview is right:

```powershell
.\tools\minimap_probe\run_next_click_lab_test.ps1 -Click
```

Expected output after the click:

- direct minimap-marker verification;
- observed forward/right yard values;
- vector error;
- `PASS_DISTANCE` if vector error is <=3 yd.

Review:

`tools\minimap_probe\output\click_lab\latest_click_lab_marker_verify.png`

If automatic distance resolution refuses to run, use the standard launcher with an explicit visible GSPro distance:

```powershell
.\tools\minimap_probe\run_click_lab_windows.ps1 -Right 10 -Forward 200 -Distance 350.2
```

## Remaining acceptance sequence

1. **Center point:** SIM validated visually.
2. **+10 yd right:** repeat with hardened registration + direct target verification.
3. **-10 yd left:** validate after right passes.
4. Manually change minimap zoom and repeat one target.
5. Repeat from an approach position after the tee shot.
6. Repeat on a rotated/dogleg minimap.
7. Feed one real Looper absolute recommendation point.

Do not connect this harness to automatic Live Caddie execution until these cases are repeatable.

## Offline screenshot replay

A previously captured GSPro screenshot can validate marker detection, scale, handedness and predicted click location without GSPro running and without any mouse actuation:

```powershell
python .\click_lab_replay.py `
  --image "C:\path\to\gspro_screenshot.png" `
  --distance 410 `
  --right 10 `
  --forward 220
```

## Absolute Looper-coordinate mode

When the mechanical cases above pass, feed an actual recommendation point rather than a synthetic offset:

```powershell
.\tools\minimap_probe\run_click_lab_windows.ps1 `
  -BallCourse "12.4,84.1" `
  -PinCourse "18.7,421.6" `
  -TargetCourse "23.3,281.0"
```

The harness converts the absolute target into right/forward components using Looper's course frame, then maps those components into the live GSPro ball/pin minimap frame. Fresh `currentRound.dat` supplies the GSPro distance automatically when available. Add `-Click` only after preview validation.
