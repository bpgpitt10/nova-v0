# Looper 2-D Geometry Review v1

## Purpose

Geometry Review v1 answers one narrow question before any club, bag, dispersion, or recommended-aim logic is allowed into the loop:

> Can Looper reconstruct a strategically faithful 2-D hole from the geometry it already extracted?

This is **offline evidence tooling only**. It never sends GSPro input and every output is `strategy_authority=false`.

## Per-hole review

Each review page has three synchronized panels:

1. **GSPro Actual** — the untouched canonical tee minimap (`tee_heatmap_minimap.png`, or the HoleModel's declared canonical image).
2. **Looper Reconstruction** — green, accepted canonical hazards, tee, and pin rendered without the GSPro image.
3. **Overlay / Difference** — the same Looper geometry over the original GSPro minimap with an opacity control.

Layer toggles are provided for the geometry classes actually present. The page also includes a manual strategic-fidelity scorecard stored in browser localStorage and a **Copy review JSON** button.

## Stronger round-trip mode

When `hole_spatial_model_v1.json` exists, the default reconstruction is not drawn from the stored minimap pixels. Instead Geometry Review takes each hazard's `hole_local_yards` points and projects them **back to minimap pixels** through the exact stored tee/pin pixel basis and `yards_per_pixel` transform.

The page can switch between:

- **Local-yards round trip** — minimap extraction -> hole-local yards -> reconstructed minimap.
- **Direct extracted pixels** — original canonical minimap geometry.

The manifest records per-hazard RMS/max pixel difference between those two representations. That number measures **transform consistency only**. A near-zero round-trip error does not prove the original CV boundary was correct; the Actual/Overlay panels are what test extraction fidelity.

If the spatial model is absent but `hazard_map_shadow_v0.json` exists, the page falls back to direct minimap geometry and labels the review accordingly.

## Green

The green is reconstructed only when the tee HoleModel's `target_green_mask` artifact exists. Its contour is extracted from that saved mask. Geometry Review does not invent a green shape from pin location or other heuristics.

## What is deliberately excluded

- recommended aim point
- current GSPro aim point
- club selection
- bag calibration or generic bag assumptions
- dispersion / shot-shape strategy
- strokes gained or decision scoring
- post-shot minimap registration
- any source promotion into live strategy

Those are downstream decisions. Geometry Review v1 exists specifically so geometry can be accepted/rejected first.

## Run against saved Greywolf captures

From the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\minimap_probe\run_geometry_review_v1_windows.ps1
```

With no `CaptureRoot`, the tool searches the normal `tools\minimap_probe\output` tree for saved tee captures. It does not require a running GSPro session.

To point it at a saved corpus explicitly:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\minimap_probe\run_geometry_review_v1_windows.ps1 `
  -CaptureRoot "C:\path\to\saved\Greywolf\output"
```

To start with a representative subset:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\minimap_probe\run_geometry_review_v1_windows.ps1 `
  -CaptureRoot "C:\path\to\saved\Greywolf\output" `
  -Holes "1,3,6,9,13,18"
```

## Output

A run writes:

`tools/minimap_probe/output/geometry_review_<timestamp>/`

containing:

- `index.html` — entry page for all reviewed holes
- `hole_XX/review.html` — self-contained visual review page
- `hole_XX/manifest.json` — machine-readable per-hole geometry/provenance/round-trip diagnostics
- `geometry_review_manifest.json` — aggregate run manifest

and by default:

`tools/minimap_probe/output/geometry_review_<timestamp>.zip`

The HTML embeds the original minimap image, so the ZIP can be uploaded or moved without breaking the comparison pages.

## Review standard

Do not judge cosmetic similarity. Judge whether the reconstruction preserves geometry that could materially change a golf decision:

- important hazard detected vs missed
- false strategic hazard
- hazard position
- hazard size / reach
- hazard shape where shape changes available landing space
- major boundary displacement
- tee-to-pin orientation
- gross hole shape

A slightly uglier bunker is irrelevant. A bunker edge displaced by enough yards to change a target decision is not.
