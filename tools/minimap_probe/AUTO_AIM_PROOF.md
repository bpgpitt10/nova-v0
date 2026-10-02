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

## Live physical simulator proof — PASS

Greywolf Hole 8 was validated live on 2026-10-02.

Tee calibration:

- par 4 gray-waypoint calibration resolved successfully;
- authoritative tee scale: `0.575811 yd/px`;
- calibration state cached successfully.

Shot 2 preview:

- requested controlled target: `75 yd forward, +10 yd right`;
- current target pixel: `(234.0, 618.0)`;
- verified current->canonical pin cross-check: `0.73 px`;
- preview produced no mouse input.

Shot 2 physical click:

- same requested target: `75 yd forward, +10 yd right`;
- GSPro accepted the click and displayed the 75-yard AIM target plus magenta minimap marker;
- current->canonical pin cross-check remained `0.73 px`;
- accepted magenta target transformed back into the calibrated tee frame with **0.36 yd vector error**;
- acceptance threshold was `<= 3 yd`;
- result: **AUTO AIM PASS**.

This is the first live end-to-end proof of the complete physical actuator chain:

`tee calibration -> post-shot zoom registration -> pin verification -> canonical target -> inverse transform -> GSPro minimap click -> magenta accepted-target verification`.

The remaining integration step is no longer pixel math. It is to feed the actual Live Caddie recommendation/aim point into this proven actuator path, then validate that real recommendation on a small number of live holes before enabling automatic triggering.

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

## Re-running the physical simulator gate

Update the isolated worktree:

```powershell
cd C:\Users\User\nova-click-lab
git fetch origin
git switch --detach origin/minimap-waypoint-scale-v1
```

At a normal tee, cache the tee calibration:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\minimap_probe\run_auto_aim_windows.ps1 `
  -CalibrateTee -Par 4
```

For a par 3, use `-Par 3`.

After GSPro re-centers/zooms for the next shot, preview a controlled target:

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

Add `-Click` only after preview validation. The next gate is to bridge the actual Live Caddie aim point into this mode and validate a few real recommendations before production auto-triggering.
