# GSPro Minimap / Live Caddie Capture

This folder is the GSPro screen-understanding layer for Looper's full-shot live caddie. It should answer **what is happening in GSPro** and hand clean state to `tools/live_caddie/`; recommendation math does not belong here.

## Current capture architecture

### Tee

`run_probe_windows.ps1` runs the field-proven v8 tee capture:

- never presses `W` at the tee;
- reads the white PIN card for distance/elevation;
- treats tee lie as GSPro invariant `0.0 / 0.0` unless diagnostic OCR is requested;
- toggles `Y` using the proven fixed settle timing;
- stores one canonical heatmap-on minimap;
- extracts the current target green and red penalty boundaries;
- acquires the player-color AIM card with neutral LEFT/RIGHT-arrow return verification;
- writes `HoleModel` + tee `ShotState`;
- writes review imagery after `STATE READY`;
- **after `STATE READY`, OCRs the persistent upper-right course/hole header and tags the cached HoleModel.**

The upper-right identity is currently:

```text
hole number | course name
            | PAR n | nnn YDS
```

That identity is the preferred cache key for every later shot. Newest-capture selection is only an explicit legacy fallback.

### Post-tee

`probe_approach_v2.py` / `run_approach_probe_v2_windows.ps1` are the identity-safe read-only post-tee path:

- PIN card, real directional lie, and course/hole identity OCR overlap AIM acquisition;
- course + hole select the correct cached tee HoleModel;
- the current minimap is feature-registered back to the tee minimap;
- current ball position is transformed into canonical hole coordinates;
- **the white minimap pin is optional after the tee**;
- the cached canonical pin is projected back into the current viewport when GSPro crops the real pin offscreen;
- the PIN card remains the preferred fresh distance/elevation measurement and cross-checks canonical geometry;
- the gray GSPro AIM marker is located and mapped into canonical coordinates;
- green visibility is evaluated against the cached green footprint;
- recommendation output is read-only; it never applies solver-driven aim yet.

## Source hierarchy

### Hole identity

1. Upper-right GSPro course/hole header.
2. Other round-state source if one becomes authoritative.
3. Newest cached tee model only as an explicit lower-confidence legacy fallback.

### Current PIN distance/elevation

1. White PIN card.
2. Future upper-left distance-to-pin state when validated.
3. Canonical map distance as fallback/check.

### PIN / green geometry after the tee

1. Cached canonical HoleModel.
2. Visible white minimap pin as a confirmation/refinement signal.

This inversion matters: **cropped minimap pin does not mean post-tee failure anymore.**

## Automatic tee-state direction

Tee detection is a separate calculation in `tools/live_caddie/tee_state.py`. It does not guess from one pixel pattern. It combines evidence such as:

- course/hole transition from the upper-right header;
- future upper-left shot number = `1`;
- no Looper-recorded shot yet on the new hole;
- current DTP reasonably matching displayed hole yardage;
- optional previous-hole made/gimme/terminal signal;
- flat `0.0 / 0.0` lie;
- full-hole minimap appearance.

The weights and thresholds live in `config/looper-live-caddie.json`, not inline in the screen code. `RoundTracker` deliberately keeps the previous active hole until a new tee is accepted, so a very fast made/gimme -> next tee transition does **not** require us to capture an intermediate result screen.

The upper-left shot-number/DTP OCR adapter is intentionally not implemented yet because we do not have a representative non-practice-mode screenshot. The tee-state calculation already accepts those fields, so adding that reader later will not change lifecycle math.

## Next live validation

When back at the sim:

1. Validate upper-right OCR on several courses/holes.
2. Run post-tee v2 and confirm exact HoleModel selection.
3. Confirm post-tee registration still works with the minimap pin cropped.
4. Validate `2.8 DOWN / 2.5 RIGHT` lie fix on a real shot.
5. Exercise bounded `W` green recovery and later `Y` refinement.
6. Provide one full non-practice-mode screenshot showing the upper-left shot number + DTP so that adapter can be calibrated.

Putting is not part of this workstream.
