# GSPro Calibration Harness v1

Purpose: prove a reliable **controlled launch packet -> GSPro -> captured result** path before designing the physical-lie experiment.

This is local calibration tooling, not part of the browser product. It reuses the useful packet and `DrivingRangeShot` primitives from `gspro_physics_lab.py` while adding explicit transport diagnostics, multi-profile support, timing, and experiment metadata.

## What v1 proves

`tools/gspro_calibration_harness.py` can:

- inject arbitrary BallData profiles through GSPro Open Connect (`Speed`, `VLA`, `HLA`, `TotalSpin`, `SpinAxis`);
- omit `CarryDistance` so GSPro must simulate the shot;
- handle segmented `201` and `200` responses on the raw TCP stream;
- capture the resulting `DrivingRangeShot` row from `GSPro.db`;
- verify that GSPro persisted the launch values that were injected;
- record connect, acknowledgement, result, and full-cycle timing;
- retain measured terrain `Up/Down` and `Left/Right` lie values as **metadata only**;
- select one profile or sweep every profile in a JSON profile file.

Terrain lie is intentionally **not** placed in `ClubData.Lie`; the course lie must come from the actual GSPro ball position.

## Step 1 - local self-test

This requires no GSPro process. It starts a mock TCP server, deliberately fragments the Open Connect responses, writes a synthetic `DrivingRangeShot`, and verifies the whole harness path.

```powershell
python tools/gspro_calibration_harness.py --self-test
```

Expected result: `SELF-TEST PASS`.

## Step 2 - live preflight

Run with GSPro open. No shot is sent.

```powershell
python tools/gspro_calibration_harness.py --preflight
```

Expected results:

- `PASS capture`: `GSPro.db` was found and has `DrivingRangeShot`.
- `PASS transport`: `127.0.0.1:921` accepted the Open Connect TCP connection.

If transport fails with connection refused, GSPro is not listening on Open Connect. That is an environment/configuration failure, not evidence that packet generation is broken.

If DB auto-discovery misses the file, pass it explicitly:

```powershell
python tools/gspro_calibration_harness.py --preflight --db "C:\Users\brian\AppData\LocalLow\GSPro\GSPro\GSPro.db"
```

## Step 3 - one live smoke shot

Start on the GSPro Driving Range for this first transport/capture proof:

```powershell
python tools/gspro_calibration_harness.py `
  --profile smoke-mid-iron `
  --speed 118 `
  --vla 18 `
  --hla 0 `
  --spin 5800 `
  --axis 0 `
  --condition-label "live smoke" `
  --repetitions 1 `
  --output "gspro-calibration-smoke.json"
```

Success means the command prints a GSPro carry/offline value, a cycle time, and saves one observation whose persisted launch values match the packet.

## Multiple launch/spin profiles

`config/gspro-calibration-profiles.example.json` demonstrates the schema. The numbers are examples, not Looper calibration values.

Run one profile:

```powershell
python tools/gspro_calibration_harness.py `
  --profile-file config/gspro-calibration-profiles.example.json `
  --profile mid-iron-neutral-example
```

Run every profile in the file:

```powershell
python tools/gspro_calibration_harness.py `
  --profile-file config/gspro-calibration-profiles.example.json `
  --all-profiles
```

The final lie experiment should use player-representative launch profiles rather than the example file.

## Physical-lie metadata

The harness already reserves the experiment dimensions we will need later:

```powershell
  --lie-up-down 4.2 `
  --lie-left-right -2.1 `
  --surface fairway `
  --course "Course Name" `
  --hole 7 `
  --position-label "hole7-sidehill-A"
```

These values are recorded with the observation but do not alter the Open Connect packet.

## Important v1 limitation

The current capture adapter is `GSPro.db:DrivingRangeShot`, intentionally retained for the first smoke test because it is known and easy to validate. **Do not use it as proof of terrain-lie behavior.** Physical-lie calibration needs an on-course/practice capture adapter tied to an actual sloped ball position. The packet injector is separated from capture so that adapter can be added without rewriting transport or profile logic.

## Gate before beta experiment

Do not build the experiment matrix until all three are true:

1. local `--self-test` passes;
2. live `--preflight` passes on the sim PC;
3. one injected smoke shot produces a captured result and reports its cycle time.

That measured cycle time determines how large the first beta experiment should be.
