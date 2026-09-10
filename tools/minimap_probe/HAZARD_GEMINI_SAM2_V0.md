# Gemini -> SAM2 Hazard Field Benchmark v0

Step 6 of `hazard-field-lab-v0` tests a clean separation of responsibilities:

1. **Gemini 3.1 Flash-Lite** answers only *what* is visible on the current hole and returns a tight box.
2. **SAM2** receives each Gemini box and returns the exact visible pixel mask.
3. Existing class-specific CV refinement is retained only as a comparison baseline.
4. Every result remains `strategy_authority=false`.

This benchmark operates only on already-saved tee captures. It does not actuate GSPro.

## Why the Gemini request changed

The first Gemini benchmark showed excellent semantic counting/localization but poor native polygons. The Step 6 request therefore omits polygons entirely. That reduces output size and prevents Gemini geometry from accidentally becoming the edge source.

The prompt also explicitly states that GSPro's colored green heatmap/slope overlay is **not water**. More importantly, the benchmark refuses a heatmap-only tee image unless `--allow-heatmap` is explicitly supplied. Preferred inputs are, in order:

1. `tee_hazard_safe_minimap.png`
2. `tee_canonical_minimap.png`
3. `tee_initial_minimap.png`
4. `watcher_prelaunch_minimap.png`

`tee_heatmap_minimap.png` is diagnostic fallback only.

## SAM2 implementation choice for the field lab

The test backend uses Hugging Face Transformers' SAM2 support with `facebook/sam2.1-hiera-tiny`. This is deliberate: it gives us box-prompted SAM2 without asking the user to clone Meta's repository, compile its optional CUDA extension, or use WSL. The launcher installs the field-lab Python dependencies into the existing isolated minimap-probe virtual environment.

This is **not** a production architecture decision for `looper.golf`. If the segmentation approach proves valuable, the browser/WebGPU or cloud production implementation is a separate choice. Step 6 answers the computer-vision question first: does promptable segmentation trace GSPro hazards accurately when Gemini identifies the object?

## Segmentation QA

For every Gemini object, the segmenter:

- pads the semantic box slightly so the true edge is not clipped;
- asks SAM2 for multiple candidate masks;
- scores candidates using SAM's predicted mask quality plus fit to the prompt box;
- removes disconnected components that do not meaningfully intersect the prompt region;
- rejects pathological masks that are tiny, cover most of the minimap, barely overlap the semantic box, or extend many times beyond it;
- converts the accepted component to both pixel and normalized polygons;
- saves the raw binary mask for review.

The benchmark separately rasterizes the existing cheap CV refinement and reports SAM2-vs-legacy IoU. That IoU is an agreement diagnostic, **not ground truth**.

## Run later on the GSPro PC

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\minimap_probe\run_gemini_sam2_hazard_benchmark_windows.ps1
```

Defaults:

- latest 5 saved tee captures
- Gemini `gemini-3.1-flash-lite`
- SAM2 `facebook/sam2.1-hiera-tiny`
- CUDA when PyTorch sees an NVIDIA GPU; otherwise CPU fallback
- heatmap-only inputs refused
- regression tests run before API/model work

On the first run, PyTorch/Transformers and the SAM2 tiny checkpoint may need to download. Later runs reuse their normal local caches.

## Artifacts

Each capture receives:

- Gemini box-only canonical response
- provider-native Gemini box response
- Gemini usage/latency metadata
- box overlay
- SAM2 result JSON
- one binary mask PNG per accepted object
- SAM2 overlay
- SAM2-vs-legacy comparison JSON

The output root also receives:

- `hazard_gemini_sam2_benchmark_v0.json`
- `gemini_sam2_hazard_review_<timestamp>.zip`

The review ZIP is intentionally sufficient to inspect results remotely after one simulator-PC run.
