# Hazard Field Lab — Wiring Backlog

This file is the explicit integration ledger for `hazard-field-lab-v0`. It exists so isolated spikes can be completed one at a time without losing the work needed to connect them later.

**Hard product constraint:** the production product is hosted `looper.golf`. No required Python/PowerShell/Tauri/local-helper installer may become the default production architecture. Field-lab runners are validation tooling only.

**Safety constraint:** all hazard sources remain `strategy_authority=false` until explicit promotion criteria are defined and met.

| Wiring item | Status | Planned step / dependency | Notes |
| --- | --- | --- | --- |
| Step 3 GKD output -> unified HazardGeometry | Adapter complete; native emission deferred | Later integration | `features.json` can already be normalized. Step 8 collects it when explicitly supplied/copied into a capture, but does not rerun GKD archaeology every tee. Native producer emission can wait until schemas are field-confirmed. |
| Step 4 Unity/course-asset output -> unified HazardGeometry | Adapter complete; transform validation blocked | Needs first real Step 4 ZIP | Step 8 collects `geometry_candidates.json` when supplied/present. Unity geometry stays `unknown_asset_or_serialized_space` and not world-comparable until real course assets establish the transform. |
| Step 5 truth validator -> consume HazardGeometry directly | **TODO** | After Step 8 / comparison work | Replace/bridge Step 5 source-specific geometry loader with the unified contract while preserving its existing truth rules. |
| Step 6 Gemini bbox -> unified HazardGeometry | **STEP 8 WIRED** | Field validation now; production port later | `hazard_field_shadow.py` can make a fresh Flash-Lite box call and emits semantic bbox + semantic confidence into HazardGeometry. It runs only from a confirmed heatmap-off image unless explicitly overridden for diagnostics. Producer-specific direct emission can remain optional because the orchestrator owns the field contract. |
| Step 6 SAM2 result -> unified HazardGeometry | **STEP 8 WIRED** | Field validation now; production port later | Step 8 carries semantic bbox, pixel/normalized polygon and accepted mask reference through the unified adapter. Semantic and geometry confidence stay separate. It does not install SAM dependencies. |
| Red penalty extractor -> unified HazardGeometry | **STEP 8 WIRED for current schema** | Later: preserve exact pixel boundary if useful | Current `PenaltyObject` exposes yard extents/crossings rather than its raw pixel polyline. Step 8 maps those to a `penalty_area` yard-space extent + centerline point set and explicitly labels the extent as non-exact. Never infer water from red. |
| Legacy bunker CV -> unified HazardGeometry | **STEP 8 WIRED** | Keep as baseline | Current `polygon_pixel` + `polygon_yards` schema maps directly into pixel and hole-local-yard representations. Always shadow only. |
| Legacy water CV -> unified HazardGeometry | **STEP 8 WIRED** | Keep as baseline | Current `polygon_pixel` + `polygon_yards` schema maps directly into pixel and hole-local-yard representations. Always shadow only. |
| Watcher tee capture -> run/collect all unified hazard emitters | **STEP 8 WIRED** | Next field run validates behavior | `run_probe_resilient_windows.ps1` now queues `hazard_field_shadow.py` asynchronously after every saved tee capture. The worker is non-blocking, waits briefly for watcher context, runs legacy CV, conditionally runs Gemini/SAM, collects red CV and optional course artifacts, writes `hazard_geometry_v0.json`, and records independent failures. |
| Confirm semantic input is truly heatmap-off | **STEP 8 GUARD WIRED; FIELD CONFIRMATION NEEDED** | Next field run | Filename is not trusted. Step 8 requires `normal_frame_selection.trusted_for_red_penalty` plus a non-heatmap source before fresh Gemini/SAM run. Manifest retains before/toggle policy evidence. Need field artifacts to confirm this gate behaves correctly across courses. |
| Step 8 field manifest -> watcher/app observability | **PARTIAL** | Later integration | Each tee capture gets `hazard_field_shadow_v0.json` and HoleModel references the manifest/bundle. Watcher does not yet emit a later event when async shadow work finishes; add only if useful for diagnostics. |
| Exact red-boundary pixel/polyline retention | **TODO** | Later extractor cleanup if Step 10 shows value | Current red extractor collapses boundary pixels into derived `PenaltyObject` yard extents/crossings. If exact penalty shape matters for dispersion overlap, preserve the original red component/polyline in the producer rather than reconstructing it later. |
| Course-analysis cache keyed by course/version/hash | **TODO** | **Step 9** | GKD/Unity archaeology should happen once per course asset version, never once per hole. Step 8 intentionally does not turn course archaeology into a per-tee job. |
| Automatic comparison/report generator -> HazardGeometry | **TODO** | **Step 10** | Compare GKD/Unity/red-CV/Gemini/SAM/legacy sources plus Step 5 shot truth using one schema. |
| One combined field-test launcher/review ZIP | **TODO** | **Step 11** | One start, play, Ctrl+C, one bounded ZIP; individual probes must fail soft. |
| Regression corpus -> unified schema fixtures | Step 7 + Step 8 unit fixtures; **TODO** real corpus | **Step 12** | Add real Pebble/Trosper/etc. artifacts once packaged fixtures are available. |
| Step 4 candidate mesh world transform | **BLOCKED** | Real Step 4 field ZIP | Test object/Transform/mesh local->world chain against known GSPro shot x/z before setting world comparability. |
| GKD penalty geometry vs red minimap boundary agreement | **TODO** | Next field dataset + Step 10 | Important independent cross-source validation target. |
| Physical sand landing vs Unity bunker surface/mesh | **TODO** | Step 4 ZIP + Step 5 unified wiring | Strong automatic evidence for physical bunker provenance. |
| Browser-native GSPro course-folder access | **TODO production port** | After course-data approach proves useful | Extend the existing File System Access architecture only as needed; prefer a persistent one-time folder grant over session screen capture. |
| Production Gemini call | **TODO production port** | After semantic approach passes validation | Keep API key server-side. Browser client must never contain the production Gemini secret. |
| Production promptable segmentation | **TODO production port** | After Step 6 quality is validated | Evaluate browser WebGPU/WASM/ONNX or cloud. Field-lab Python SAM2 is not the production decision. |
| Production async/background hazard lifecycle | **TODO production port** | After source validation | Preserve Step 8's fail-soft/non-blocking semantics without requiring local Python/PowerShell. Hosted app needs its own job/status lifecycle. |
| Screen/window capture | **FALLBACK ONLY** | Do not default-wire yet | Browser `getDisplayMedia` picker-per-session UX is undesirable. Exhaust static course/runtime data first. |
| HazardGeometry -> HoleModel strategy hazards | **BLOCKED intentionally** | Explicit promotion gate after validation | Requires class-specific accuracy/geometry thresholds and failure behavior. Step 8 only attaches shadow references; it does not promote objects. |
| HazardGeometry -> live aim/dispersion recommendations | **BLOCKED intentionally** | After HoleModel promotion | No experimental geometry may influence aim before promotion. |

## Step 8 outputs

Every successful Step 8 tee worker writes:

- `hazard_shadow_v0.json` plus legacy masks/overlays from the existing training baseline;
- fresh Gemini box artifacts when heatmap-off is confirmed and `GEMINI_API_KEY` is available;
- fresh SAM2 result/masks when semantic objects and already-present dependencies are available;
- `hazard_geometry_v0.json`, the unified source-neutral bundle;
- `hazard_field_shadow_v0.json`, the source-status/input-policy/error manifest;
- a non-authoritative `hazards.field_shadow` reference in `hole_model.json`.

A zero-detection bunker/water run is still recorded as a completed run. Missing API keys, missing SAM dependencies, model errors, and adapter errors are explicit source statuses rather than reasons to fail the tee HoleModel or watcher.

## Promotion ledger

Current promoted hazard geometry sources for strategy: **none**.

Current shadow sources: GKD archaeology, Unity/course-asset archaeology, deterministic red penalty CV, Gemini semantic localization, SAM2 prompt segmentation, legacy bunker CV, legacy water CV.

Before any source is promoted, record here: validation corpus, false-positive/false-negative performance, geometry error tolerance relevant to dispersion decisions, known failure modes, fallback behavior, and the exact contract version being promoted.
