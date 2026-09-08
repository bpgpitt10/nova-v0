# GSPro Live-State Source Contract

Status: field-research contract for Looper full-shot caddie. This document separates facts already observed in GSPro sources from hypotheses that the passive timing probe still needs to prove.

## Governing rule

Use the strongest machine-readable GSPro source that is temporally valid. Screen OCR/CV owns only facts that GSPro does not expose reliably in a structured source, plus validation/recovery.

Normal real-round play is sequential. Day-one lifecycle does not need to support manually jumping between holes; on-course practice hole jumping can be added later as a separate recovery/practice capability.

## Source roles

### `currentRound.dat` — completed-shot truth

Observed fields include `ShotID`, `RoundID`, `PlayerName`, `UserGuid`, `Hole`, `HoleShot`, `GlobalShotNumber`, `DistanceToPin`, `StartingSurface`, `EndingSurface`, `HolePar`, `CourseKey`, `TotalDistance`, `ClubIndex`, `ShotResult`, `HoleResult`, positions, and a rich `activeShot.sd` object.

Observed `activeShot.sd` fields include `isPutt`, `isHoled`, `isGimme`, `waterhit`, `HazardNumber`, `HazardLastPointOfEntry`, `TargetDirection`, `TDmaterial`, `finalSpeed`, `finalSpin`, and shot path/position data. `activeShot.materialHit` has been observed as values such as `TVGfairway` and `TVGgreen`.

Observed `Hole` values are zero-based. Preserve the raw value and derive display hole as `Hole + 1` rather than silently changing source semantics.

Important limitation: a fresh next tee does not create a new completed-shot record merely because GSPro advanced to it. Therefore this source drives **shot completion**, not all pre-shot state.

### `output_log.txt` — live/between-shot semantic events

Observed useful lines include:

- `material TVGfairway`
- `material TVGgreen`
- `ActivePlayer: 0  currentHole: 0  strokes: 1  Previous Score: ...`
- `Logging tdist: ... and ActiveGameGimmieDistance: ...`
- `Select Shot - active user ball is within Gimmie distance`
- `Real putt made and all players done - AllPlayersHoledOut`
- physics diagnostic `SurfAngl ...`
- wind diagnostic lines such as `Wind Direction Capped Negative`

Observed `currentHole` is zero-based.

Parser policy: retain every raw appended log byte during research and parse semantic facts conservatively. Unknown `TVG*` materials must be preserved verbatim; do not hard-code a complete surface taxonomy from only the currently observed fairway/green samples.

`SurfAngl` is not yet proven to equal the two-axis lie slope shown in the minimap footer. Treat it as a physics diagnostic until field evidence proves otherwise.

Wind diagnostic lines seen so far do not expose a usable numeric wind speed/vector.

### `GSPro.db` / `Round` — round/course/current-hole candidate authority

Previously observed `Round` columns:

- `ID`
- `PlayerName`
- `PlayerID`
- `DateCreated`
- `DateModified`
- `CourseCode`
- `CourseName`
- `ActiveHole`
- `RoundStatus`
- `RoundType`
- `NumberOfPlayers`
- `RoundSettings`
- `RoundData`
- `CourseGKD`

`ActiveHole = 0` was observed while on display Hole 1. Preserve raw zero-based and display values separately.

**Primary open question:** does `ActiveHole` change as soon as GSPro advances to the next tee, before a shot is hit? If yes, it becomes the preferred normal-play current-hole source. If not, sequential inference from last completed hole + terminal/new-tee evidence remains necessary.

`RoundData` and `RoundSettings` appear encoded/opaque in existing captures. The passive probe fingerprints them to detect changes without assuming their encoding.

### Screen — missing live facts and recovery

Keep screen ownership for facts with no proven reliable machine-readable equivalent:

- target elevation / signed elevation
- two-axis lie slope (up/down and left/right)
- wind speed/direction for now
- minimap hazard geometry
- green geometry / heatmap
- tee visual state when needed

Upper-right course/hole/par/yard OCR and upper-left shot-number OCR should become validators/bootstrap/recovery sources, not normal lifecycle authorities.

## Intended field precedence

| Looper fact | Preferred source | Fallback / validator | Current status |
|---|---|---|---|
| Round ID | `GSPro.db Round.ID` / `currentRound.RoundID` | screen only if necessary | structured |
| Course identity | `GSPro.db CourseCode/CourseName` | `currentRound.CourseKey`, header OCR | structured |
| Current hole | `GSPro.db ActiveHole` if transition timing proves timely | sequential inference; header OCR validation | needs timing proof |
| Shot completed | new `currentRound.ShotID` | file fingerprint | structured |
| Shot sequence | `currentRound.HoleShot` / completed-shot records | upper-left OCR validation | structured-first |
| Hole terminal | `output_log AllPlayersHoledOut` | `isHoled`/`isGimme` evidence | structured-first |
| Lie/surface class | `output_log material TVG*` | currentRound material/surface, minimap | structured-first |
| Penalty/water outcome | currentRound hazard/water fields + log | screen if needed | structured-first |
| DTP after shot | structured GSPro distance values | upper-left / target-card screen | mixed |
| Fresh pre-shot tee DTP | upper-left / target card until structured source proves current | geometry cross-check | screen |
| Target elevation | screen | none proven | screen |
| Two-axis lie slope | minimap footer screen | `SurfAngl` is not yet accepted | screen |
| Wind speed/direction | existing screen wind path | log research continues | screen for now |
| Hazard/green geometry | minimap CV / cached HoleModel | none | CV |

## Target lifecycle

Normal play should be event-driven:

1. `currentRound.dat` gains a new `ShotID` -> `ShotCompleted`.
2. `output_log.txt` supplies material/surface and other between-shot facts.
3. If the hole ends, `AllPlayersHoledOut` establishes terminal/transition state.
4. On the next tee, use `GSPro.db ActiveHole` if proven timely. Otherwise infer sequentially from the trusted prior hole plus terminal + stable tee evidence.
5. Screen readers fill elevation, lie slope, wind, and geometry gaps.
6. Header/shot OCR validates or recovers state rather than driving it.

The downstream caddie should consume a resolved `TrustedRoundState` with per-field provenance, never raw OCR/file/log values directly.

## Passive field probe

`tools/minimap_probe/gspro_event_probe.py` records all four source families on one monotonic/UTC timeline without pressing GSPro keys. It saves full changed currentRound snapshots, exact new output-log bytes, Round-table changes, and screen observations. The first field run should specifically establish:

- when `currentRound.dat` changes relative to shot completion;
- when `material TVG*` appears relative to the next playable state;
- when `AllPlayersHoledOut` occurs;
- when `GSPro.db ActiveHole` changes relative to the next tee screen;
- whether additional usable wind or surface lines appear;
- whether structured distance values align consistently with the displayed DTP.
