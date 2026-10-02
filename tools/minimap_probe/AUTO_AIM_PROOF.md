# Verified GSPro Auto Aim proof

Branch: `minimap-waypoint-scale-v1`

This remains isolated from production Live Caddie. Preview is the default; mouse input requires an explicit `-Click`.

## What is already proven offline

- Tee minimap scale resolves 18/18 Greywolf tee captures: gray waypoint ruler on par 4/5, direct ball->pin on par 3.
- Strong dual-waypoint tee cases agree within ~0.23% or better.
- Post-shot zoom/rotation registers back to the calibrated tee frame using a similarity transform.
- Greywolf H8 shot 2: ~0.387x / +24.0 deg, recovered 150.71 yd vs GSPro 150.6 yd.
- Greywolf H13 shot 2: ~0.346x / +32.7 deg, recovered 112.97 yd vs GSPro 112.5 yd.
- The white pin marker is an independent fail-closed transform check; visually plausible wrong registrations miss by hundreds of pixels.
- Canonical->current inverse target math is locked by `auto_aim_transform_proof.py` on the saved H8/H13 zoom matrices.

## Runtime model

1. At the tee, capture and cache the canonical GSPro minimap plus authoritative yards/pixel.
2. Before every Auto Aim click, capture the current minimap.
3. Detect current ball + pin.
4. Register current minimap -> cached tee minimap.
5. Require the current white pin to map onto the cached tee pin within tolerance.
6. Convert desired Looper target into canonical tee pixels.
7. Invert the transform to get the current GSPro minimap click pixel.
8. Preview by default.
9. If `-Click` is explicitly supplied, click once.
10. Detect the accepted magenta GSPro target, transform it back to canonical pixels, and measure vector error using the calibrated tee scale. No ball->pin distance ruler is used for click verification.

## First physical simulator gate

Update the isolated worktree:

```powershell
cd C:\Users\User\nova-click-lab
git fetch origin
git switch --detach origin/minimap-waypoint-scale-v1
```

At a normal tee before hitting, run all offline proofs and cache the tee calibration:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\minimap_probe\run_auto_aim_windows.ps1 `
  -RunProof -CalibrateTee -Par 4
```

For a par 3, use `-Par 3`.

Hit the tee shot normally. Once GSPro has re-centered/zoomed for shot 2, preview a controlled target 75 yd forward and 10 yd right of the current ball:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\minimap_probe\run_auto_aim_windows.ps1 `
  -Forward 75 -Right 10
```

This produces no mouse input. Inspect:

`tools\minimap_probe\output\auto_aim\latest_auto_aim_preview.png`

If the preview is correct, run exactly one click:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\minimap_probe\run_auto_aim_windows.ps1 `
  -Forward 75 -Right 10 -Click
```

PASS requires the accepted magenta target to map back within 3 yd of the requested canonical target. Evidence is written under:

`tools\minimap_probe\output\auto_aim\`

## Real Looper target mode

The runner already accepts an absolute Looper/course target without changing the math:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\minimap_probe\run_auto_aim_windows.ps1 `
  -TeeCourse "teeX,teeY" `
  -PinCourse "pinX,pinY" `
  -TargetCourse "aimX,aimY"
```

Add `-Click` only after preview validation. Production Live Caddie should not auto-trigger this until the controlled post-shot physical gate passes.
