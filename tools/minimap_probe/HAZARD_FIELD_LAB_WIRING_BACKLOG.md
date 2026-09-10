# Hazard Field Lab — Wiring Backlog

This file is the explicit integration ledger for `hazard-field-lab-v0`. It exists so isolated spikes can be completed one at a time without losing the work needed to connect them later.

**Hard product constraint:** the production product is hosted `looper.golf`. No required Python/PowerShell/Tauri/local-helper installer may become the default production architecture. Field-lab runners are validation tooling only.

**Safety constraint:** all hazard sources remain `strategy_authority=false` until explicit promotion criteria are defined and met.

| Wiring item | Status | Planned step / dependency | Notes |
| --- | --- | --- | --- |
| Step 3 GKD output -> unified HazardGeometry | Adapter complete; native emission deferred | Later integration | `features.json` can already be normalized. Step 9 caches it by course/analysis fingerprint when explicitly supplied/copied into a capture, so later tees reuse the course bundle. Native producer emission can wait until schemas are field-confirmed. |
| Step 4 Unity/course-asset output -> unified HazardGeometry | Adapter complete; transform validation blocked | Needs first real Step 4 ZIP | Step 9 caches `geometry_candidates.json` when supplied/present. Unity geometry stays `unknown_asset_or_serialized_space` and not world-comparable until real course assets establish the transform. |
| Step 5 truth validator -> consume HazardGeometry directly | **STEP 10 BRIDGE COMPLETE** | Real field corpus; optional native-loader cleanup later | `hazard_compare_report.py` converts only explicitly world-comparable HazardGeometry representations into the existing physical-shot truth contract, preserving Step 5's sand/water/safe-surface semantics. The older source-specific loader can remain for standalone archaeology tooling. |
| Step 6 Gemini bbox -> unified HazardGeometry | **STEP 8 WIRED** | Field validation now; production port later | `hazard_field_shadow.py` can make a fresh Flash-Lite box call and emits semantic bbox + semantic confidence into HazardGeometry. It runs only from a confirmed heatmap-off image unless explicitly overridden for diagnostics. Producer-specific direct emission can remain optional because the orchestrator owns the field contract. |
| Step 6 SAM2 result -> unified HazardGeometry | **STEP 8 WIRED** | Field validation now; production port later | Step 8 carries semantic bbox, pixel/normalized polygon and accepted mask reference through the unified adapter. Semantic and geometry confidence stay separate. It does not install SAM dependencies. |
| Red penalty extractor -> unified HazardGeometry | **STEP 8 WIRED for current schema** | Later: preserve exact pixel boundary if useful | Current `PenaltyObject` exposes yard extents/crossings rather than its raw pixel polyline. Step 8 maps those to a `penalty_area` yard-space extent + centerline point set and explicitly labels the extent as non-exact. Never infer water from red. |
| Legacy bunker CV -> unified HazardGeometry | **STEP 8 WIRED** | Keep as baseline | Current `polygon_pixel` + `polygon_yards` schema maps directly into pixel and hole-local-yard representations. Always shadow only. |
| Legacy water CV -> unified HazardGeometry | **STEP 8 WIRED** | Keep as baseline | Current `polygon_pixel` + `polygon_yards` schema maps directly into pixel and hole-local-yard representations. Always shadow only. |
| Watcher tee capture -> run/collect all unified hazard emitters | **STEP 8+9 WIRED** | Next field run validates behavior | `run_probe_resilient_windows.ps1` now queues `hazard_field_shadow_cached.py` asynchronously after every saved tee capture. The wrapper runs Step 8 unchanged, then resolves/builds the Step 9 course cache without blocking live play. |
| Confirm semantic input is truly heatmap-off | **STEP 8 GUARD WIRED; FIELD CONFIRMATION NEEDED** | Next field run | Filename is not trusted. Step 8 requires `normal_frame_selection.trusted_for_red_penalty` plus a non-heatmap source before fresh Gemini/SAM run. Manifest retains before/toggle policy evidence. Need field artifacts to confirm this gate behaves correctly across courses. |
| Step 8 field manifest -> watcher/app observability | **PARTIAL** | Later integration | Each tee capture gets `hazard_field_shadow_v0.json` and HoleModel references the manifest/bundle. Step 9 adds its cache match/build state to the same source-status record. Watcher does not yet emit a later event when async shadow work finishes; add only if useful for diagnostics. |
| Exact red-boundary pixel/polyline retention | **TODO** | Later extractor cleanup if Step 10 field results show value | Current red extractor collapses boundary pixels into derived `PenaltyObject` yard extents/crossings. If exact penalty shape matters for dispersion overlap, preserve the original red component/polyline in the producer rather than reconstructing it later. |
| Course-analysis cache keyed by course/version/hash | **STEP 9 WIRED** | Field validation now; production port later | `course_hazard_cache.py` fingerprints analysis artifacts and optional raw asset/version evidence, stores a course-only HazardGeometry bundle, and reuses it across tees. Exact asset fingerprint matches are distinguished from course-key-only latest matches; the latter are explicitly diagnostic. Expensive asset hashing is build/validation-only, never required per tee. |
| Automatic comparison/report generator -> HazardGeometry | **STEP 10 BASELINE COMPLETE** | Real field corpus | `hazard_compare_report.py` inventories every source, performs same-space pairwise geometry/semantic comparison, bridges world-comparable objects into Step 5 shot truth, and emits JSON scorecards + `REPORT.md` + review ZIP. It never fabricates a transform: unknown Unity space stays blocked; different minimap captures cannot be compared. |
| One combined field-test launcher/review ZIP | **TODO** | **Step 11** | One start, play, Ctrl+C, one bounded ZIP; individual probes must fail soft. Include the Step 10 report as the final evidence summary rather than making the user run it separately. |
| Regression corpus -> unified schema fixtures | Step 7 + Step 8 + Step 9 + Step 10 unit fixtures; **TODO** real corpus | **Step 12** | Add real Pebble/Trosper/etc. artifacts once packaged fixtures are available. Step 10 should become the regression scorecard over this corpus. |
| Step 4 candidate mesh world transform | **BLOCKED** | Real Step 4 field ZIP | Test object/Transform/mesh local->world chain against known GSPro shot x/z before setting world comparability. Step 10 explicitly reports this source as transform-blocked instead of comparing serialized coordinates to world coordinates. |
| GKD penalty geometry vs red minimap boundary agreement | **STEP 10 COMPARATOR READY; DATA NEEDED** | Next field dataset | Step 10 can compare these once both sources expose a shared coordinate space. Current red Step 8 geometry is hole-local while GKD is world-space, so no agreement is fabricated until a real bridge/transform exists. |
| Physical sand landing vs Unity bunker surface/mesh | **STEP 10 TRUTH PATH READY; TRANSFORM BLOCKED** | Step 4 ZIP + transform validation | Physical sand truth is now wired directly from HazardGeometry comparison. Unity candidates still cannot receive world-truth credit until their coordinate transform is proven. |
| Browser-native GSPro course-folder access | **TODO production port** | After course-data approach proves useful | Extend the existing File System Access architecture only as needed; prefer a persistent one-time folder grant over session screen capture. Step 9's logical course/version/hash cache should be ported to browser/server persistence rather than replaced by a local helper. |
| Production Gemini call | **TODO production port** | After semantic approach passes validation | Keep API key server-side. Browser client must never contain the production Gemini secret. |
| Production promptable segmentation | **TODO production port** | After Step 6 quality is validated | Evaluate browser WebGPU/WASM/ONNX or cloud. Field-lab Python SAM2 is not the production decision. |
| Production async/background hazard lifecycle | **TODO production port** | After source validation | Preserve Step 8's fail-soft/non-blocking semantics without requiring local Python/PowerShell. Hosted app needs its own job/status lifecycle. |
| Screen/window capture | **FALLBACK ONLY** | Do not default-wire yet | Browser `getDisplayMedia` picker-per-session UX is undesirable. Exhaust static course/runtime data first. |
| HazardGeometry -> HoleModel strategy hazards | **BLOCKED intentionally** | Explicit promotion gate after validation | Requires class-specific accuracy/geometry thresholds and failure behavior. Step 8/9/10 remain shadow/evidence-only; none promotes objects. |
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

## Step 9 course cache

`course_hazard_cache.py` separates static course archaeology from per-tee work:

- analysis inputs such as `features.json` and `geometry_candidates.json` are SHA-256 fingerprinted without absolute-path dependence;
- optional raw course files and/or an explicit asset version form a separate asset fingerprint when exact installed-course identity needs to be proven;
- one deterministic cache entry stores the course-only `hazard_geometry_v0.json` plus `course_hazard_cache_manifest.json` provenance;
- rebuilding the same fingerprint reuses the existing entry instead of re-normalizing it;
- exact cache/asset fingerprints can be requested explicitly; a normal tee with only the course key may use the latest known course entry, but that match is marked `course-key-latest-diagnostic` and `exact_asset_match=false`;
- `hazard_field_shadow_cached.py` runs Step 8 first, then replaces any per-tee GKD/Unity copies with the cache's course-only objects when a valid entry exists. Cache miss/error is non-blocking and leaves Step 8 evidence intact;
- raw course-asset hashing is never part of the normal tee loop. It is only done when building or explicitly validating a cache entry.

The Step 9 cache is a field-lab contract, not a deployment decision. Production should implement the same course/version/hash semantics using the hosted `looper.golf` architecture and persistent browser/server storage; it must not require a local companion.

## Step 10 comparison report

`hazard_compare_report.py` is the automatic evidence layer over the shared contract:

- it loads Step 8/9 HazardGeometry bundles rather than maintaining another extractor-specific schema;
- source pairs are spatially compared only in a coordinate space they genuinely share; unknown serialized Unity/course-asset space is never treated as GSPro world space;
- minimap/hole-local comparisons require compatible identity, so two different captures are not silently overlaid;
- world-comparable HazardGeometry is bridged directly into the existing physical-shot truth validator, preserving strong sand/water truth and the weaker interpretation of safe-surface negatives;
- semantic compatibility is mandatory for truth credit. In particular, a known sand landing does not validate a GKD `penalty_area` merely because its geometry is nearby/contains the point;
- the report emits source inventory, pairwise comparisons, physical-shot scorecards, machine-readable summary, human-readable `REPORT.md`, and an optional bounded review ZIP;
- evidence states can say promising, contradicted, image-only, transform-blocked, or insufficient-data, but they never auto-promote a source.

Step 10's pairwise IoU/F1 is a baseline common-denominator metric. Exact boundary error/dispersion relevance can be added after the first real field corpus shows which source pairings are worth deeper geometry scoring.

## Promotion ledger

Current promoted hazard geometry sources for strategy: **none**.

Current shadow sources: GKD archaeology, Unity/course-asset archaeology, deterministic red penalty CV, Gemini semantic localization, SAM2 prompt segmentation, legacy bunker CV, legacy water CV.

Before any source is promoted, record here: validation corpus, false-positive/false-negative performance, geometry error tolerance relevant to dispersion decisions, known failure modes, fallback behavior, and the exact contract version being promoted.
