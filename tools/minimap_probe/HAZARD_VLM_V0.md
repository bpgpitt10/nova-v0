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

## Contract

Each saved tee capture gets `hazard_vlm_request_v0.json`. It contains:
- source image and dimensions;
- fixed current-hole hazard prompt;
- JSON response schema;
- normalized `[x1,y1,x2,y2]` coordinate contract.

A model response is stored as `hazard_vlm_response_v0.json`:

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

`hazard_vlm_shadow.py` consumes the response if present, creates
`hazard_vlm_shadow_v0.json`, and writes `hazard_vlm_overlay_v0.png`.

## Fail-soft rules

- No VLM response: request is logged and play continues.
- Bad/malformed response: error is logged and play continues.
- Pixel refinement fails: keep the semantic VLM box as diagnostic geometry.
- No HoleModel geometry: semantic/local pixel geometry is still saved.
- No VLM or CV hazard result can block tee capture or post-shot capture.
- Nothing in V0 can alter aim or influence the caddie recommendation.

## Next validation

Run the same prompt/schema over the saved tee corpus with a consistent multimodal
model. Review false positives, false negatives, duplicate objects, box tightness,
and repeatability. Only then decide which provider/model to wire for live calls and
what confidence/refinement gates are required for strategy.
