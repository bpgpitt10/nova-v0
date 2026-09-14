# GSPro Physics Lab

Purpose: measure **GSPro's response to a frozen launch packet** and compare it with `looper-flight-physics-v1` without mixing in human swing variability.

This is a development/calibration tool. It does not change Live Caddie recommendations by itself.

## What is automated

`tools/gspro_physics_lab.py`:

1. connects to GSPro Open Connect at `127.0.0.1:921`;
2. sends the same raw launch packet (ball speed, VLA, HLA, total spin, spin axis);
3. intentionally omits `CarryDistance`, so GSPro solves the shot;
4. polls the local `GSPro.db` `DrivingRangeShot` table;
5. captures GSPro Carry, Offline, TotalDistance, PeakHeight and Descent plus the echoed launch packet;
6. writes a portable `looper-gspro-physics-lab-v1` JSON file.

The browser Model Inspector can import that file. It pairs each conditioned shot with a calm shot having the exact same launch signature and calculates:

`GSPro delta - looper-flight-physics-v1 delta = residual`

The residual is evidence for the future GSPro correction layer. It is **not applied** to recommendations until explicitly promoted.

## What remains manual

GSPro Open Connect v1 can accept shot data but does not expose an environment-setting command. For V1, change the wind in GSPro between batches.

Use the GSPro Driving Range and set a known wind condition before each command. The Looper convention records the direction the wind comes **from** relative to the target line:

- `0°` = headwind
- `45°` = headwind + from right
- `90°` = from right
- `135°` = tailwind + from right
- `180°` = tailwind
- `225°` = tailwind + from left
- `270°` = from left
- `315°` = headwind + from left

## First experiment

Start small. Use one representative mid-iron launch packet and confirm repeatability before running a matrix.

The exact launch numbers should come from the **Representative Stock launch** section on `/caddie-inputs`. Example only:

```powershell
python tools/gspro_physics_lab.py `
  --db "C:\path\to\GSPro.db" `
  --speed 118 `
  --vla 18 `
  --hla 0 `
  --spin 5800 `
  --axis 0 `
  --wind 0 `
  --wind-relative 0 `
  --label calm `
  --repetitions 3 `
  --output "C:\temp\looper-wind-mid-iron.json"
```

Then leave every launch argument unchanged, change only GSPro's wind, and append to the same output file:

```powershell
python tools/gspro_physics_lab.py `
  --db "C:\path\to\GSPro.db" `
  --speed 118 `
  --vla 18 `
  --hla 0 `
  --spin 5800 `
  --axis 0 `
  --wind 10 `
  --wind-relative 0 `
  --label "10 mph headwind" `
  --repetitions 3 `
  --output "C:\temp\looper-wind-mid-iron.json"
```

Import the resulting JSON in `/caddie-inputs` under **Wind Calibration**. Select the trajectory class before importing; the current importer assigns the imported batch to that class.

## Initial test sequence

Do not run all 120 matrix cells first.

1. Calm, 3 identical shots.
2. 10 mph headwind, 3 identical shots.
3. 10 mph tailwind, 3 identical shots.
4. 10 mph from right, 3 identical shots.

If identical packets produce identical or nearly identical results, reduce future repetitions to one per cell. If they do not, preserve repetitions and investigate the simulator state before fitting a correction.

After the mid-iron passes, expand to the five trajectory classes and the 5/10/15 mph × eight-direction matrix already shown in the Model Inspector.

## Safety / validity checks

- Stay on the GSPro Driving Range so the `DrivingRangeShot` capture path is valid.
- The script expects the same `GSPro.db` file selected by Looper's browser GSPro setup.
- GSPro Open Connect must be available on port 921. Disconnect another Open Connect client if it prevents the lab from connecting.
- The runner compares the launch packet persisted in `DrivingRangeShot` with what it sent and prints a warning when they differ.
- Never type a carry distance into the injected packet; doing so would invalidate the calibration.
- Do not treat a physics-prior absolute carry as a player carry. Only the condition delta is relevant to calibration.

## Promotion rule

Current model status:

- Open physics prior: **active for review**
- Controlled GSPro residuals: **collecting**
- Wind recommendation adjustment: **0.0 yd applied**

A future `gspro-wind-calibration-v1` should be promoted only after residual behavior is stable across representative trajectories and conditions and the Model Inspector shows the evidence used by the fitted correction.
