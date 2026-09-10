# GSPro watcher v3.2 field contract

Status: field-validated source policy after the 2026-09-09 four-hole DPC Pebble run.

## Normal round lifecycle

For normal sequential play, **hole identity is a state-machine problem** once the
round is bootstrapped.

1. `currentRound.dat` new `ShotID` is completed-shot truth.
2. `output_log.txt` `AllPlayersHoledOut` is authoritative hole-terminal evidence.
3. Terminal Hole N means Looper immediately expects Hole N+1.
4. On the next pre-shot screen, `Shot 1 + Tee` is sufficient corroboration of the
   deterministic N+1 expectation. Header `Hole N+1` plus either pre-shot cue is also
   sufficient.
5. Screen readiness (PIN stable, result overlay gone) is separate from hole identity.
6. `GSPro.db Round.ActiveHole` is **diagnostic only**. In the DPC Pebble run it stayed
   raw `0` / display Hole 1 while Holes 1-4 were played, so it must never advance or
   veto live hole state.

`GSPro.db` remains useful for round/course/player metadata and round-boundary checks.

## Structured distances

The DPC Pebble corpus showed that `currentRound.DistanceToPin` and `TotalDistance`
match screen/coordinate values when interpreted as **meters**. Looper therefore:

- preserves the raw GSPro value;
- records an explicit meters field;
- converts to yards with `1 m = 1.0936132983377078 yd`;
- uses converted `DistanceToPin` to sanity-check/fallback screen PIN OCR after a
  completed shot.

Example from the field run: `168.6337 m -> 184.42 yd`, matching a displayed 184 yd.

## Synthetic gimme closure

GSPro can append an `isGimme=true`, `isHoled=true` record whose
`GlobalShotNumber` repeats the preceding physical shot. Looper retains that record
as terminal evidence but marks it `synthetic_terminal_record=true` and
`physical_shot=false`. It must not enter club/shot/mishit performance datasets as a
struck golf shot.

## Observed surface enums

Current field-observed mapping is intentionally partial:

| Raw | Meaning |
| ---: | --- |
| 18 | tee |
| 2 | fairway |
| 1 | rough |
| 11 | sand |
| 5 | green |

Unknown enums remain raw/unknown until additional evidence establishes semantics.

## Screen PIN policy

Watcher readiness uses an adaptive distance-only multi-crop OCR reader. Child tee
and post-shot probes use the same full-card consensus reader. Post-shot screen PIN is
validated against converted structured `DistanceToPin`; a large disagreement rejects
screen OCR rather than rejecting the shot. At a tee, current-hole header yardage can
serve as a fallback if PIN OCR is unavailable or obviously inconsistent.

## Fail-soft capture contract

A HoleModel/ShotState is a collection of independently available facts, not an
all-or-nothing transaction.

### Tee HoleModel

Base model:
- canonical normal/as-presented minimap;
- ball marker;
- pin marker;
- yard/pixel scale.

Optional semantic layers:
- green heatmap/mask;
- red penalty boundary objects;
- later bunker/water classifiers.

A failed green extractor no longer destroys the base HoleModel. Raw
before/toggled/restored minimaps are retained for replay. Red-penalty CV may still run
when green classification fails, but its objects are marked diagnostic-only if the
heatmap-off frame cannot be established confidently.

Bunker and water classifiers are **not promoted into the live authoritative model yet**.

### Post-shot ShotState

PIN, AIM, lie slope, structured surface, minimap and canonical registration fail
independently. Lie/PIN OCR failure must not discard the ShotState. Canonical geometry
uses only the exact current-hole tee HoleModel; it never falls back to the newest
model from another hole.

## Actuation safety

- W zoom remains off.
- Post-shot Y remains off.
- Tee Y is only the existing toggle/capture/restore sequence.
- Existing bounded LEFT/RIGHT AIM-card summon/return remains available.
- No extra aim-calibration pulses and no auto-aim recommendation actuation are part
  of v3.2.
