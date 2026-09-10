# Hazard Field Lab — Wiring Backlog

This file is the explicit integration ledger for `hazard-field-lab-v0`. It exists so isolated spikes can be completed one at a time without losing the work needed to connect them later.

**Hard product constraint:** the production product is hosted `looper.golf`. No required Python/PowerShell/Tauri/local-helper installer may become the default production architecture. Field-lab runners are validation tooling only.

**Safety constraint:** all hazard sources remain `strategy_authority=false` until explicit promotion criteria are defined and met.

| Wiring item | Status | Planned step / dependency | Notes |
| --- | --- | --- | --- |
| Step 3 GKD output -> unified HazardGeometry | Adapter complete; native emission deferred | Later integration | `features.json` can already be normalized. Native producer emission can wait until schemas are field-confirmed. |
| Step 4 Unity/course-asset output -> unified HazardGeometry | Adapter complete; transform validation blocked | Needs first real Step 4 ZIP | Unity geometry stays `unknown_asset_or_serialized_space` and not world-comparable until real course assets establish the transform. |
| Step 5 truth validator -> consume HazardGeometry directly | **TODO** | After Step 7 | Replace/bridge Step 5 source-specific geometry loader with the unified contract while preserving its existing truth rules. |
| Step 6 Gemini bbox -> unified HazardGeometry | Adapter complete; native emission deferred | Step 8/field orchestration | Gemini should contribute semantic bbox + semantic confidence, not exact polygon authority. |
| Step 6 SAM2 result -> unified HazardGeometry | Adapter complete; native emission deferred | Step 8/field orchestration | Carry pixel + normalized polygon/mask reference; keep semantic and geometry confidence separate. |
| Red penalty extractor -> unified HazardGeometry | Tolerant adapter complete; exact native mapping **TODO** | Step 8 | Inspect the exact current red-CV artifact schema and make native emission deterministic. Do not infer water from a red boundary. |
| Legacy bunker CV -> unified HazardGeometry | Tolerant adapter complete; native emission **TODO** | Step 8 | Remains baseline/shadow only. |
| Legacy water CV -> unified HazardGeometry | Tolerant adapter complete; native emission **TODO** | Step 8 | Remains baseline/shadow only. |
| Watcher tee capture -> run/collect all unified hazard emitters | **TODO** | **Step 8** | Over-collect raw state and independent failures; no extractor may block base HoleModel. |
| Confirm semantic input is truly heatmap-off | **TODO** | Step 8 + next field run | Do not trust filename alone. Record before/toggled/restored evidence and source-image policy. |
| Course-analysis cache keyed by course/version/hash | **TODO** | **Step 9** | GKD/Unity archaeology should happen once per course asset version, never once per hole. |
| Automatic comparison/report generator -> HazardGeometry | **TODO** | **Step 10** | Compare GKD/Unity/red-CV/Gemini/SAM/legacy sources plus Step 5 shot truth using one schema. |
| One combined field-test launcher/review ZIP | **TODO** | **Step 11** | One start, play, Ctrl+C, one bounded ZIP; individual probes must fail soft. |
| Regression corpus -> unified schema fixtures | Partial Step 7 tests; **TODO** full corpus | **Step 12** | Add real Pebble/Trosper/etc. artifacts once packaged fixtures are available. |
| Step 4 candidate mesh world transform | **BLOCKED** | Real Step 4 field ZIP | Test object/Transform/mesh local->world chain against known GSPro shot x/z before setting world comparability. |
| GKD penalty geometry vs red minimap boundary agreement | **TODO** | Next field dataset + Step 10 | Important independent cross-source validation target. |
| Physical sand landing vs Unity bunker surface/mesh | **TODO** | Step 4 ZIP + Step 5 unified wiring | Strong automatic evidence for physical bunker provenance. |
| Browser-native GSPro course-folder access | **TODO production port** | After course-data approach proves useful | Extend the existing File System Access architecture only as needed; prefer a persistent one-time folder grant over session screen capture. |
| Production Gemini call | **TODO production port** | After semantic approach passes validation | Keep API key server-side. Browser client must never contain the production Gemini secret. |
| Production promptable segmentation | **TODO production port** | After Step 6 quality is validated | Evaluate browser WebGPU/WASM/ONNX or cloud. Field-lab Python SAM2 is not the production decision. |
| Screen/window capture | **FALLBACK ONLY** | Do not default-wire yet | Browser `getDisplayMedia` picker-per-session UX is undesirable. Exhaust static course/runtime data first. |
| HazardGeometry -> HoleModel strategy hazards | **BLOCKED intentionally** | Explicit promotion gate after validation | Requires class-specific accuracy/geometry thresholds and failure behavior. |
| HazardGeometry -> live aim/dispersion recommendations | **BLOCKED intentionally** | After HoleModel promotion | No experimental geometry may influence aim before promotion. |

## Promotion ledger

Current promoted hazard geometry sources for strategy: **none**.

Current shadow sources: GKD archaeology, Unity/course-asset archaeology, deterministic red penalty CV, Gemini semantic localization, SAM2 prompt segmentation, legacy bunker CV, legacy water CV.

Before any source is promoted, record here: validation corpus, false-positive/false-negative performance, geometry error tolerance relevant to dispersion decisions, known failure modes, fallback behavior, and the exact contract version being promoted.
