# GSPro Minimap Click Lab

Branch: `minimap-click-lab-v0`

This is an isolated native validation harness. It does **not** import Live Caddie recommendations and it does **not** change normal Looper behavior.

## What it proves

Given a desired point in the live ball-to-pin coordinate frame (or full Looper course coordinates), predict the matching GSPro minimap pixel, optionally click it exactly once, then verify the resulting GSPro AIM target-card distance.

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

## Offline screenshot replay

A previously captured GSPro screenshot can now validate marker detection, scale, handedness and predicted click location without GSPro running and without any mouse actuation:

```powershell
python .\click_lab_replay.py `
  --image "C:\path\to\gspro_screenshot.png" `
  --distance 410 `
  --right 10 `
  --forward 220
```

The replay writes an annotated PNG beside the source screenshot. Because the distance is supplied explicitly, this path does not require the target-card OCR to be visible in the screenshot.

This is useful for old screenshots from the earlier minimap-probe work: if the full minimap is visible and the ball/pin markers are present, we can validate the transform before returning to the sim.

## First live test: preview only

From `tools\minimap_probe` on the sim PC, with GSPro stopped at a normal full shot:

```powershell
.\run_click_lab_windows.ps1 -Right 0 -Forward 200 -RunProof
```

This does **not** click GSPro. Review:

`output\click_lab\latest_click_lab_preview.png`

The yellow crosshair should be on the ball-to-pin line, 200 yards from the ball.

## First real click

If the preview is correct, run the identical point with one-shot input enabled:

```powershell
.\run_click_lab_windows.ps1 -Right 0 -Forward 200 -Click
```

The harness saves:

- `latest_click_lab_before.png`
- `latest_click_lab_minimap.png`
- `latest_click_lab_preview.png`
- `latest_click_lab_after.png`
- `latest_target_cards_v6.png`
- `latest_click_lab_result.json`

`PASS_DISTANCE` means the post-click player-colored AIM card is within 3 yards of the requested straight-line target distance. This is intentionally only the first verification layer; visual location remains part of the first field review.

## Lateral validation

Once center works, repeat at the same forward depth:

```powershell
.\run_click_lab_windows.ps1 -Right -10 -Forward 200
.\run_click_lab_windows.ps1 -Right  10 -Forward 200
```

Review both preview images first, then add `-Click` one at a time.

## Absolute Looper-coordinate mode

When we are ready to feed an actual recommendation point rather than a synthetic test offset:

```powershell
.\run_click_lab_windows.ps1 `
  -BallCourse "12.4,84.1" `
  -PinCourse "18.7,421.6" `
  -TargetCourse "23.3,281.0"
```

The harness converts the absolute target into right/forward components using Looper's +X-right / +Y-forward coordinate convention, then maps those components into the live GSPro ball/pin minimap frame.

Absolute mode refuses to operate when Looper's ball-to-pin distance disagrees with the GSPro PIN-card distance by more than 8 yards. Add `-Click` only after preview validation.

## Acceptance sequence

1. Offline replay against any useful old screenshot we have.
2. Center point preview.
3. Center point one-shot click.
4. +/-10 yard lateral previews and clicks.
5. Repeat after manually changing minimap zoom.
6. Repeat on an approach after the tee shot.
7. Repeat on a rotated/dogleg minimap.
8. Feed one real Looper absolute recommendation point.

Do not connect this harness to automatic Live Caddie execution until those cases are repeatable.
