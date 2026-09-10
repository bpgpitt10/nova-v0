# VLM hazard semantics v0

## Decision

The current whole-image HSV/Lab bunker and water classifiers are retained only as
training/candidate baselines. They are not the primary semantic recognizer.

V0 separates the task:

1. A multimodal vision model identifies **what** current-hole regions are bunkers,
   water, or uncertain.
2. Looper validates the structured response.
3. Existing cheap pixel masks run only inside the VLM-localized region to tighten
   the visible edge.
4. The ball/pin/scale transform converts the refined polygon to Looper yard
   coordinates when tee geometry is available.
5. Every V0 result remains `strategy_authority=false` until reviewed against a
   sufficiently broad real-course corpus.

Red penalty boundaries remain a separate deterministic CV signal.

## Why

A field benchmark on the saved DPC Pebble tee image produced roughly 186 bunker and
21 water positives from the broad handcrafted whole-image segmentation, while a
general multimodal visual read identified 8 current-hole bunker regions and no
visible water. The failure mode is semantic, not merely a threshold calibration
problem.

## Provider-neutral contract

Each saved tee capture gets `hazard_vlm_request_v0.json`. It contains:
- source image and dimensions;
- fixed current-hole hazard prompt;
- JSON response schema;
- normalized `[x1,y1,x2,y2]` coordinate contract.

The canonical model response has this form:

```json
{
  "schema_version": "looper-hazard-vlm-v0",
  "bunkers": [
    {"id": "b1", "confidence": 0.97, "bbox_norm": [0.2,0.3,0.3,0.4], "note": null}
  ],
  "water": [],
  "uncertain": []
}
```

`hazard_vlm_shadow.py` consumes provider-neutral responses and writes diagnostic
refinement artifacts.

## Gemini adapter

`hazard_vlm_gemini.py` is the first provider adapter. It reads `GEMINI_API_KEY`
from the local process and sends the saved minimap to Gemini's image-understanding
API. No Gemini SDK package is required.

For Gemini, the adapter intentionally uses the provider's native object-detection
format rather than forcing Looper coordinates in the prompt:

- `box_2d = [ymin, xmin, ymax, xmax]`, integer coordinates on a 0-1000 scale;
- optional segmentation polygon `mask`, `[x,y]` points on the same 0-1000 scale;
- bunker / water / uncertain semantic class;
- confidence.

The adapter preserves Gemini's raw response, converts its box into Looper's 0-1
`[x1,y1,x2,y2]` contract, and then runs the local CV refinement independently. This
lets us compare three geometries later: Gemini's native polygon, Gemini's box, and
CV refinement inside the VLM box.

Artifacts are model-specific and include:

- `hazard_vlm_provider_raw_<model>_v0.json`
- `hazard_vlm_response_<model>_v0.json`
- `hazard_vlm_native_overlay_<model>_v0.png`
- `hazard_vlm_overlay_<model>_v0.png` (local CV refinement)
- `hazard_vlm_gemini_<model>_v0.json`

## Cost-sensitive benchmark

The default Windows benchmark compares:

1. `gemini-3.7-flash` — stronger multimodal baseline, low thinking.
2. `gemini-3.1-flash-lite` — low-cost baseline, minimal thinking.

Both are diagnostic only. The benchmark defaults to the latest five tee captures and
one call per model per image (10 calls total):

```powershell
powershell -ExecutionPolicy Bypass -File `
  ".\tools\minimap_probe\run_gemini_hazard_benchmark_windows.ps1"
```

It writes `hazard_vlm_gemini_benchmark_v0.json` under the output directory and leaves
model-specific overlays in each tee capture folder.

For a repeatability check after the first pass:

```powershell
powershell -ExecutionPolicy Bypass -File `
  ".\tools\minimap_probe\run_gemini_hazard_benchmark_windows.ps1" `
  -Latest 5 -Repeats 3
```

Do not start with repeats=3; first confirm the prompt/schema works and inspect the
single-pass semantic quality.

## Fail-soft rules

- No VLM response: request is logged and play continues.
- Bad/malformed provider response: error is logged and play continues.
- Pixel refinement fails: keep the semantic VLM box as diagnostic geometry.
- No HoleModel geometry: semantic/local pixel geometry is still saved.
- No VLM or CV hazard result can block tee capture or post-shot capture.
- Nothing in V0 can alter aim or influence the caddie recommendation.

## Promotion criteria

Do not promote a model based only on object count. Review:

- false-positive bunker/water objects;
- missed current-hole hazards;
- adjacent-hole contamination;
- native box/polygon placement;
- CV refinement quality versus native Gemini geometry;
- repeatability across identical images;
- latency and token usage.

Use the cheapest model whose semantic and localization performance is effectively
indistinguishable from the best model on the Looper corpus.
