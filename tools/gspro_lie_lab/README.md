# GSPro lie lab

Fires identical, controlled shots through GSPro Open Connect from real lies and records what GSPro does to them. Standalone: plain Python 3.10+, no packages, no Looper app involved. Only the resulting lie model goes into Looper.

## Why this works well

GSPro already writes its exact lie penalty into `output_log.txt` for every shot from a penalty lie:

```
LaunchExt Vars: sp 76.2, el 27.68, az -14.76, ts 8538.42, sa -4.64, cy 89.77, id 13
Penalty Surface TVGdeeprough, Spin53%, Speed 80%, VLA 98%
 ... corrected type 3
```

So we don't have to back the penalty out of carry numbers. We read GSPro's answer for each shot and map how it changes. Looper currently uses one fixed value per lie (`src/liveCaddie/surfaceResponse.ts`) plus medians learned from real rounds (`src/adapters/gsproPenaltyLog.ts`). The code notes GSPro "varies them with launch conditions"; nobody has measured how.

**Questions this answers**

1. Is the penalty random or fixed for the same shot from the same spot?
2. Does it depend on club / ball speed / spin / launch? (wedge vs 3H vs driver)
3. Does the club selected in GSPro matter, or only the ball data?
4. Does slope change anything: carry from up/down lies, start line from sidehill lies? (Looper's priors: `SIDEHILL_LIE_GAIN 0.5`, `UPDOWN_LIE_GAIN 0.25`, both unvalidated.)
5. Names and codes for lies we've never logged: fringe, semi-rough, pine straw, waste areas.

## Setup

- Get this folder onto the sim PC (branch `gspro-lie-lab-v1`; the folder is self-contained).
- **Close the Uneekor launcher.** GSPconnect takes one launch monitor at a time; the lab connects in its place on `127.0.0.1:921`.
- GSPro wind: **calm**. A practice mode, not a handicap round.
- Everything the lab saves goes to `sessions/` in this folder. It only reads GSPro's files.

## Step 1: ping (2 min)

```
python lie_lab.py ping
```

Fires one 7i through API version 1 and then version 2, and prints GSPro's replies. If a `202` (ball stopped) shows up for a version, use that version for the run (`--api-version 2`). Without 202 the lab watches GSPro's files to know when the ball has stopped, which works but is a little slower.

## Step 2: discover (5 min)

Open a course in Encore practice, put the ball in rough, then:

```
python lie_lab.py discover --fire 3 --api-version 2
```

It snapshots the GSPro folder, fires 3 shots, and lists every file that changed, with the new log lines and any new `GSPro.db` rows. What we're looking for:

- `output_log.txt` gets `Penalty Surface` lines in practice mode: **go**.
- `currentRound.dat` updates: we also get positions, carry and rest (needed for the slope checks).
- A `GSPro.db` table gains a row per shot: pass it to `run` with `--db-table NAME`.

If no penalty lines appear in practice mode, stop and send me `discovery-report.json`.

## Step 3: pilot (15 min)

```
python lie_lab.py run --api-version 2
```

Do the club label check and the first two spots, then type `q` at the next spot prompt. Run `python lie_lab.py analyze sessions/<folder>` and glance at `summary.md`. If it looks sane, carry on with the same folder (`--out sessions/<folder> --start-spot 3 --skip-label-check`).

## Step 4: the full run (about 3 hours of firing, about 45 clicks from you)

At each spot the lab asks you to click a spot in Encore practice and type what GSPro's HUD shows: surface, up/down (`3U`, `2D`, `0`) and left/right (`2L`, `1R`, `0`). Then it fires 18 shots by itself and moves on.

| Lie | Spots | Notes |
|---|---|---|
| Fairway | 6 | Baseline; half flat, half sloped |
| Rough | 10 | Half flat, half sloped (mix uphill, downhill, ball above and below feet) |
| Deep rough | 10 | Same mix |
| Sand | 8 | Fairway and greenside bunkers |
| Fringe | 4 | |
| Other | 4 | Anything else the course has: semi-rough, pine straw, waste area |

**At every spot, 6 clubs × 3 shots**, using your own stock launch numbers (median of your middle-50% shots per club, from Supabase): Driver, 3H, 5i, 7i, PW, SW. Per club: the stock shot, the same shot again (randomness check), and one variant that rotates from spot to spot (speed −15%, spin +25%, launch +3°, spin −25%, a 60% partial swing). HLA and spin axis are zero.

| Club | Ball speed | Launch | Spin |
|---|---|---|---|
| Driver | 143.8 mph | 11.1° | 2,812 |
| 3H | 134.2 | 8.7 | 4,701 |
| 5i | 123.5 | 12.0 | 5,280 |
| 7i | 113.1 | 16.4 | 6,175 |
| PW | 94.4 | 22.4 | 8,646 |
| SW | 78.6 | 26.6 | 9,856 |

No 3W data yet, so the 3H stands in for the woods. `python lie_lab.py plan` writes the full plan to `plan.json` if you want to change clubs or counts; run with `--plan plan.json`.

**Club label check** (once, before the spots): the same 7i shot three times each with 7i, PW and Driver selected in GSPro. If the penalty doesn't change, labels don't matter. If it does, we'll rerun grouped by club.

**Spot tips:** vary slopes; stay a few yards clear of trees (the penalty is unaffected, but carry comparisons get messy); the first shot at each spot should show the surface you expected. The lab warns if the ball stops returning to the same spot (Encore off). Press `p` to pause after the current shot. Ctrl+C stops safely; resume with `--out <same folder> --start-spot N`.

## Step 5: analyze

```
python lie_lab.py analyze sessions/<folder> [more folders]
```

Writes into the first folder:

- `summary.md`: penalty factors per lie and per club, randomness verdict, how factors move with speed/launch/spin, variant-minus-stock deltas, slope fits, sidehill start-line gain, carry vs fairway, club label check, and any log lines we don't parse yet.
- `lie-model.json`: the same numbers, shaped for `surfaceResponse.ts`.
- `shots.csv`: one row per shot.

Send me the folder (or just those three files) and I'll turn it into the Live Caddie lie model.

## Later

- Wind (phase 2): same tool, set a wind in GSPro, and compare against Looper's internal wind model.
- Auto-clicking spots via the companion's minimap reader, only if we want thousands more shots.

## Files

- `lie_lab.py`: commands.
- `open_connect.py`: Open Connect client (reader thread, 1 s heartbeat, waits for 202, clean disconnect).
- `evidence.py`: read-only GSPro file capture and parsers (mirror the TypeScript ones).
- `plan.py`: spots, shots and stock launch numbers.
- `analyze.py`: tables and fits.
- Tests: `python -m unittest tests.test_gspro_lie_lab` from the repo root (fake GSPro socket and data folder).
