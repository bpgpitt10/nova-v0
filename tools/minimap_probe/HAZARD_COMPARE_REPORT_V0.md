# Hazard Comparison Report v0 — Step 10

Step 10 turns the field-lab hazard sources into one evidence report. It answers a narrower and more useful question than “did an extractor run?”: **which sources agree, which sources contradict physical GSPro outcomes, and which sources cannot yet be compared without inventing a coordinate transform?**

This is validation tooling only. The production product remains hosted `looper.golf`; Step 10 does not create a required Python/PowerShell/Tauri/local-helper architecture.

## Inputs

The report consumes one or more `hazard_geometry_v0.json` bundles emitted by Step 8/9. Those bundles may contain:

- GKD course/rules geometry;
- Unity/course-asset candidate geometry;
- deterministic red-penalty extraction;
- Gemini semantic localization;
- prompt segmentation/SAM geometry;
- legacy bunker and water CV baselines.

It can also consume `currentRound.dat` snapshots or the live LocalLow `currentRound.dat` as physical-shot truth.

## Coordinate comparison rules

Step 10 never fabricates a transform merely to make two sources comparable.

Spatial comparisons are allowed only when two objects share a real coordinate space. The priority is:

1. `gspro_world_xz`;
2. `hole_local_yards`;
3. `minimap_normalized`;
4. `minimap_pixel`.

Minimap/image and hole-local geometry is also identity-gated: explicit course/hole/capture disagreement blocks comparison. Missing identity can remain a wildcard because older/static course artifacts may not carry capture identity.

`unknown_asset_or_serialized_space` is **not** spatially compared to GSPro world data. Unity/course-asset candidates remain transform-blocked until the object/Transform/mesh chain is proven against known GSPro shot coordinates.

Pairwise source comparison currently uses bounding-box IoU as a deliberately simple common denominator. It reports one-to-one spatial match F1 and semantic agreement on matched overlaps. This is a baseline comparison metric, not final hazard-boundary accuracy.

## Direct HazardGeometry → physical-shot truth bridge

Step 10 bridges world-comparable HazardGeometry objects directly into the existing `hazard_world_truth.py` rules. That preserves the field-established truth contract:

- sand / `TVGsand` is strong bunker/sand truth;
- `waterhit` / water material is strong water-event truth;
- non-zero hazard entry points from water events are boundary truth;
- tee/fairway/rough/green points can expose geometry contradictions, but their absence from hazards does not prove source completeness;
- synthetic gimme terminal records are excluded from physical geometry truth.

Only HazardGeometry representations explicitly marked `gspro_world_xz` and `comparable_to_gspro_world=true` enter this scoring path.

### Critical GKD archaeology guard

A known sand landing validates only bunker/sand semantics. It does **not** validate a nearby or containing `penalty_area` object.

This matters because the simulator-PC archaeology already falsified the broader assumption that `GKD.Hazards[]` describes bunkers: a physical sand landing was about 32 world units from the nearest GKD Hazard geometry. Step 10 therefore preserves semantic compatibility when awarding truth credit. GKD penalty geometry can still prove useful for penalty/water boundaries without being silently relabeled as bunker geometry.

## Evidence states

Each source receives a current-corpus evidence state:

- `coordinate-transform-blocked` — candidate geometry exists but is still in unproven serialized/asset space;
- `image-or-hole-local-only` — usable for same-space source comparison, not physical world truth;
- `world-comparable-but-no-shot-truth` — world geometry exists but the run lacks relevant physical observations;
- `contradicted-on-current-corpus` — current physical truth exposes a miss/contradiction;
- `promising-needs-more-corpus` — at least one positive/boundary truth match and no current contradiction;
- `insufficient-positive-truth` — world-comparable source is present but current truth does not establish correctness.

These labels are diagnostic. They are not promotion decisions.

## Outputs

Each run creates `hazard_comparison_<timestamp>/` containing:

- `REPORT.md` — human-readable decision report;
- `summary.json` — run-level counts and evidence states;
- `source_scorecard.json` — per-source inventory + shot-truth scorecard;
- `pairwise_comparisons.json` — same-space cross-source matches/disagreements;
- `shot_truth.json` — detailed existing world-truth validation output;
- `hazard_inventory.json` — normalized HazardGeometry objects used in the report;
- `shot_observations.json` — physical observations derived from currentRound;
- `manifest.json` — inputs, warnings, errors and hard safety flags.

Unless `--no-zip` is used, it also writes `hazard_comparison_review_<timestamp>.zip`.

Windows launcher:

```powershell
.\run_hazard_compare_report_windows.ps1 -CaptureRoot .\output
```

No dependencies are installed by the launcher.

## Promotion / strategy safety

Step 10 has no automatic promotion path. Every output keeps `strategy_authority=false`, every source scorecard keeps `promotion_eligible=false`, and the run-level promotion decision is `none`.

A later promotion gate must be explicit and class-specific: representative corpus, false-positive/false-negative performance, geometry error tolerance relevant to dispersion decisions, known failure modes, fallback behavior, and the exact HazardGeometry contract/version being promoted.
