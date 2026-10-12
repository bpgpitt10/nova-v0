# Course self-service preflight — October 10, 2026

## OpenGolfAPI live API evaluation — FINAL decision, 2026-10-12

**Architectural decision: USE OpenGolfAPI as a PROVENANCE-TAGGED OPTIONAL SOURCE for course identity/discovery and provisional scorecard/tee metadata, NOT as the authoritative tee coordinates, hazards, greens, LiDAR, or geometry source.** Do not replace the canonical OSM→DEM→WorldCover/greens builder or enable course runtime based on OpenGolfAPI alone. Do not implement commercial use in production before the ODbL/equipment-use questions below are cleared. Prior conditional speculation that the `tees` or `holes` endpoint might provide actual pad coordinates is now **refuted for the four tested courses**.

### Evidence from real keyless GET calls — one bounded staging research run

The audit was run as [GitHub Actions read-only comparison run 38255014860](https://github.com/bpgpitt10/nova-v0/actions/runs/38255014860) using `tools/probe_opengolfapi_readonly.py` and isolated `.github/workflows/opengolfapi-readonly-probe.yml`, branch `web-course-e2e-preflight-v1`. No user data/API keys; no imported package writes, private shot events or registry/publication changes. Run calls `/v1/courses/search`, `/api/v1/courses/{id}`, `/{id}/tees`, `/{id}/holes` with per-call timeout/size and one exact name+state identity check. All GET calls returned **200**, including Shaftesbury's name search. Original baseline [three-course run 38254450366](https://github.com/bpgpitt10/nova-v0/actions/runs/38254450366) and detailed [field-shape run 38254640437](https://github.com/bpgpitt10/nova-v0/actions/runs/38254640437) corroborate result.

| Tested course | Name lookup | API tee sets | Hole records | Holes with populated `tee_coords` | Populated fairway/green polygons or hazards | Finding |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Valhalla KY | Unique exact identity | 6 | 18 | **0/18** | **0** | No fix for our **12 mapped-tee omissions** |
| Golf Club of New England NH | Unique exact identity | 7 | 18 | **0/18** | **0** | Yardages useful, no answer for OSM H12/H17 ownership |
| FarmLinks AL | Unique exact identity | 1 | **27**, numbered 1–27 | **0/27** | **0** | Known real course is 18 holes: API returns **9 additional hole records**; do not silently accept |
| Shaftesbury Glen SC | One result, **name variant** `Shaftesbury Glen Golf Fish Club` | not queried (strict exact-name confirmation gate) | not queried | not queried | not queried | Useful **identity candidate** after earlier OSM search picked non-course tram stop; independently verify name/location before match |

On Valhalla, GCNE and FarmLinks, the `tees` endpoint returns tee name/color, course rating, slope, par, total yards, **NO physical lat/lon**. The `holes` endpoint includes keys `tee_coords`, `green_polygon`, `fairway_polygon`, `hazards`, `green.front/center/back`, etc., but for these tested courses **all tee coords, green/fairway polygons, and hazard lists were empty or null** across the returned holes. The **sampled first hole** at each course also had null front/center/back green values; completeness of those three green fields on remaining holes was not exhaustively counted. These are *API schema fields*, not mapped features. The three course details had `sources:null` (no record-level source provenance) in this run. The optional `/api/v1/features` separate spatial endpoint was **not independently sampled**; provider docs say its free results are coarse OSM and more precise detected features require gated access. Verify any separately licensed precise layer on real courses before reconsidering the geometry decision.

### Scorecard inconsistency and where OpenGolfAPI actually helps

**Valhalla:** per-hole Black yardages for H1–18 sum to **7,020** while the corresponding top-level Black tee summary says **6,975** (**45-yard mismatch**); Green hole sum **6,525**, summary **6,540** (**15-yard mismatch**). **GCNE:** hole-wise Green sums **7,024**, top-level Green says **6,938** (**86-yard mismatch**); hole-wise Blue sums **6,561**, top-level Blue says **6,514** (**47-yard mismatch**). Our earlier [official GCNE scorecard fixture](../research/course-coverage/scorecards/gcne-official-six-tees-v1.json) independently shows Green **7,024** and Blue **6,561**, consistent with OpenGolfAPI's **hole-sum totals**, not its headline tee summaries; that strongly favors source-specific arithmetic checks and field precedence rules. **FarmLinks:** API Longhorn 7,444 agrees with hole yardages H1–18, but contains 9 unexplained extra hole records H19–27. None proves accurate physical mapped tee pads or trustworthy full routing in GSPro.

**Use cases with a defensible near-term engineering ROI:**
1. Add OpenGolfAPI as optional **identity alias/lat-lon candidate** for typed-name discovery when existing OSM/Nominatim search misses a course (Shaftesbury case); verify candidate facility address/state and golf-course geometry before matching any OSM course. This is a safer fix for false transit-place discovery.
2. Load tee names, H1–18 published yardages/pars into a **staged metadata evidence layer**; verify course source, number of holes, named tee totals vs hole sums, and against official scorecards if available. Do not accept totals silently when inconsistent or fall back from missing 18-hole card to fabricated yardages. Keep provenance and raw-source ODbL partition distinct.
3. Keep our source-native OSM golf=hole, tee polygon ownership, hazard/green segmentation, LiDAR DEM, WorldCover and GSPro actual ball/zoom alignment. OpenGolfAPI alone adds **0 tee GPS coordinates in tested courses**, so it cannot turn Valhalla into 18-hole runtime-ready or fix GCNE tee-collision ambiguities.

**Legal/service release gate:** [OpenGolfAPI terms](https://courses.opengolfapi.org/legal/terms) explicitly permit commercial use and cache/redistribution under ODbL 1.0 but require proper OSM/OpenGolfAPI attribution and derivative database share-alike, with additional field-specific upstream licenses. `sources:null` in live detail means field-level chain of provenance was not independently established. Per [ODbL Section 4](https://opendatacommons.org/licenses/odbl/1-0/) publicly used adapted databases may require a machine-readable ODbL offer; distinct source-linked database partition is advisable, but have an appropriate lawyer verify what combined generated course data is a derivative vs a collective database. Terms prohibit use to `control equipment` and safety-critical navigation: **obtain maintainer's written permission/clarification before relying on their derived data in AutoAim native mouse clicks**. The API is best-effort, keyless capped at 1,000/day per IP, no SLA. Keep pinned fallback snapshots and cache within license requirements; do not tie shot play to external API uptime.

**What not to do next:** Do NOT scrap the importer, start bulk OpenGolfAPI hydration, loosen mapped tee validator, import 50 full courses, adopt OpenGolf player identity/shot service, send our users' data to OpenGolf, or promote a map-only course simply because the API names a tee. Do NOT claim `automatic.golf` used OpenGolfAPI: unverified and the provider may be unrelated.

**Next small coding pass if approved:** an isolated, cacheable read-only OpenGolfAPI *candidate metadata adapter* behind a feature flag on the importer staging branch (no public view yet), with explicit source/provenance, scorecard arithmetic, named-tee mapping **evidence-only**, 18-hole bounds, alias/manual review and OSM identity crosschecks. Run Valhalla/GCNE/FarmLinks/Shaftesbury regression fixtures, then decide based on actual discovery success and named tee verification rates. Hold all spatial geometry & clickable-AutoAim dependence unless a separately accurate and legally permitted spatial product can demonstrate high-coverage physical tee positions.

## OpenGolfAPI alternative source — 2026-10-12 evaluation (NO integration approved)

**Recommendation:** High-priority, small **read-only source comparison** before further generic tee-identity engineering. OpenGolfAPI openly permits commercial use of data under ODbL 1.0 with attribution and qualifying derivative-database share-alike. It documents full course details, tee ratings/yardages/slopes, per-hole scorecard/hazard information, a geospatial `/api/v1/features` endpoint and free keyless course reads. Do **NOT** assume it offers mapped physical latitude/longitude for every named hole tee: the [bulk schema](https://raw.githubusercontent.com/opengolfapi/data/main/SCHEMA.md) expresses one GeoJSON **Point per entire course**, and a manually inspected 100-record public Illinois sample (`opengolfapi/data/samples/il-public-sample.geojson`) had course-level points, pars and OSM tags, NOT tee-pad positions. API `CourseDetail.tees` and `.holes` are generic object arrays in the [current OpenAPI v3.6.1](https://api.opengolfapi.org/openapi.json), so documented existence of fields doesn't prove physical tee accuracy/completeness. The API's `/api/v1/features` summary describes free features as **coarse OSM**, with a more precise detected layer **gated**; whether that is accessible/licensable and its actual physical tee coverage are unknown. Direct live per-course API responses could not be fetched from our research session, so record this as unverified, not a successful three-course data trial.

**Concrete OpenGolfAPI data-quality example:** Its public [FarmLinks page](https://courses.opengolfapi.org/courses/al/farmlinks-golf-course-at-pursell-farms) identifies a named **Longhorn (7,444-yard)** set that might enrich our generic tee labels, but its hole scorecard shows **Out 36 + In 36 and Tot 108**, while the course headline correctly says **par 72**. This appears to be an internal displayed-total inconsistency (not evidence every hole's par is wrong). Treat API-derived scorecard/tee facts as candidates requiring arithmetic and course-source validation before any runtime promotion. The bulk GeoJSON sample provides only course location Point geometry. This evidence raises the priority of field-by-field comparison, not broad blind replacement.

**First-use priority (what could save us work immediately):** normalized facility/course identity, city/state/lat/lon and OSM identifier where supplied; official-source tee labels and per-hole yardages as independently evaluated *candidates* for `approvedTeeSets`; correct pars and scorecard data; hazard geometry if independently mapped. Keep our DEM, WorldCover, green detail, player/shot intelligence and GSPro native capture pipeline. Their data and ours have **the same upstream OSM** for course geometry; using their API does not by itself resolve OSM tee ownership on GCNE H12/H17 or Valhalla's 12 missing tee polygons.

**Licensing/service gates:** 
- Source [OpenGolfAPI Terms 2026-06-27](https://courses.opengolfapi.org/legal/terms): ODbL 1.0 commercial use and caching possible; prescribed attribution `© OpenStreetMap contributors (ODbL 1.0) via OpenGolfAPI`, plus field-specific credits (Open-Meteo, Wikipedia, Foursquare/Overture, etc.). 1,000 anonymous requests/day per IP; 10,000 keyed/day, more through sponsorship. No SLA, no warranties, key can be revoked.
- [ODbL original terms](https://opendatacommons.org/licenses/odbl/1-0/): database derivative-publication/share-alike and machine-readable offer rules. A qualified legal review must delineate OpenGolfAPI/OSM layers from proprietary course analysis, private GSPro telemetry, and the currently generated bundled course packages. Proprietary *software* isn't automatically ODbL, but a publicly used modified **database** may be.
- **IMPORTANT: terms warn not to use the service for equipment control/navigation or safety-critical applications.** Before integrating with Live Caddie/AutoAim, request **written** confirmation that virtual GSPro-only aim recommendations and mouse clicks, where a human controls a simulator, are within permitted use. Also clarify commercial app caching, local recomputation, reproducible distribution, the distinct provenance of tee/scorecard fields, and whether any higher-accuracy spatial layer is separately licensed.
- Do not upload personal shot data through contribution/identity endpoints: terms grant broad perpetual publication rights to contributed shots/moments. No need for an OpenGolf ID integration for our current course importer (keyless reads are advertised).

**Next bounded read-only comparison** (on this *staging* branch; no automatic writes/merges):
1. Request documented detail / tees / holes / features responses for **Valhalla**, **The Golf Club of New England**, **FarmLinks**; optionally **Shaftesbury Glen** (name-discovery failure). Record stable OpenGolf IDs, cache provenance, returned fields, source timestamps, licensing per field, and URL status codes; avoid synthesizing missing per-tee positions.
2. Compare published tee **names** and **per-hole yardages** against already verified club scorecards and Looper cached OSM tee candidates. For each course/tee ask: physical tee `lat/lon?`, source confidence? 18/18 per-hole coverage? Shared pads? Adjacent-hole ownership? It is a success only if real mapped tee points, not merely a yardage table, fix current 18-hole mapping blockers.
3. If name/yardage evidence is strong, add **optional source enrichment only** behind a flag and continue strict tee approval; do not import large bulk database or switch off validated OSM checks. Preserve exact provider/source/ODbL attribution in the separate sourced database and UI.
4. Have maintainer confirm terms for **commercial cached/enriched course data and sim equipment input**, provenance of scorecard imports and spatial detected layers, and availability/stability. Recheck published terms before product use. Maintain a fallback based on pinned open exports rather than relying on best-effort API availability.
5. Decide after a small three-course quantitative delta: named-tee mapping success increase, physical pad coverage increase, map completeness increase, overhead/latency, and specific ODbL compliance work.

**Bottom line:** likely the easiest way to **avoid manually reconstructing tee names and scorecards**, not yet proven to replace local mapped physical tee positions or our LiDAR/green stack. **Do not assert that automatic.golf used OpenGolfAPI** without independent evidence; its litigation account remains unverified. No terms approval, network import or feature rollout was performed during this research.

## Three-marker alignment course correction — 2026-10-12

**Decision after reviewing early hazard-tagging failures:** Do NOT rely on manually identified bunker corners, hazard boundaries, rough/woods tags, or exact green edges as GSPro↔OSM registration anchors. GSPro native companion already extracts **actual ball at tee**, **gray default-aim/fairway waypoint + its ball-relative OCR distance**, and **white pin**. Reuse those first, with the existing gray-waypoint yards/pixel ruler and cached tee/zoom registration. The waypoint is a GSPro-only aim target; **it has no exact known corresponding OSM coordinate**.

- [x] New research-only `gsproMarkerOnlyAlignment.ts` built on the separate companion branch, using the existing `nearestSurfaceDistance` helper and **no new hazard model**. It compares GSPro tee-ball↔pin straight length with approximate OSM route-start↔green-centroid length, projects the waypoint into existing OSM coordinates on **both mirrored interpretations**, and reports distance to the existing fairway polygon for each.
- [x] The previous `/dev/gspro-course-alignment` manual hazard-tagging research interface has been replaced by a one-button marker-only test: select Greywolf Hole 8, visually confirm tee/hole, click **Read ball, waypoint and pin**, export JSON. No screenshot or manually paired feature clicks required. This is an easier first simulator experiment, not final map registration.
- [x] Added marker-only regression fixtures with mirror/dogleg/scale/shot-state failure cases to existing Web Alpha CI, and retained the no-click/no-course-promotion safety properties.
- [ ] Simulator acceptance and Vercel preview readiness: test actual GSPro at the tee, record native marker OCR, pin distance and candidate waypoint overlay; confirm whether OSM start/centroid differences are manageable. A prior-hole last-completed shot makes results **manual-hole-only**, never current-ball proof.

**Epistemic limit:** Three well-observed GSPro points establish internal 2D geometry, relative bend and scale, but do NOT independently locate themselves on OSM. OSM route start may not be the real tee, green centroid is not actual flag, and fairway proximity is a **weak plausibility test**, not a 3-yard holdout. The gray waypoint OCR yardage is also the source of native scale, so agreement between these two is not independent validation. A second independently grounded correspondence or physically checked GSPro↔OSM course heading remains required to unlock actual Live Caddie positional confidence. Do not weaken tee validations or claim hazard alignment. See [Companion V2 implementation log](https://github.com/bpgpitt10/nova-v0/blob/auto-aim-windows-companion-v1/docs/windows-companion-autoaim-execution-plan-v2.md).
## Current simulator workbench — 2026-10-12 (built on COMPANION branch)

**Test-ready:** [GSPro/OSM alignment workbench](https://looper-1mncjufer-wqk25hkxcg-3591.vercel.app/dev/gspro-course-alignment), branch preview READY, [web CI PASS](https://github.com/bpgpitt10/nova-v0/actions/runs/38270088467). No new Windows Companion installer. The source screenshot stays browser-local; this is manual supervised feature pairing, **not automatic hazard-image recognition** or physical proof.

The separate [auto-aim-windows-companion-v1 branch](https://github.com/bpgpitt10/nova-v0/tree/auto-aim-windows-companion-v1) now incorporates this importer's existing pure landmark evaluator, reusing the native GET, minimap zoom, and course geometry. This is one coordinate-alignment bridge, **NOT** a replacement for hazard classification or a newly invented GSPro shot tracker.

- [x] Browser-only **/dev/gspro-course-alignment** takes an explicitly chosen local GSPro screenshot (no image upload), manual minimap crop, paired exact feature landmarks (A/B fit, C off-axis check, D optional), Looper's existing map polygons from the course provider, and the current native→canonical tee-frame zoom matrix. It calculates research-only scale/yard residuals and exports an image-free diagnostic JSON.
- [x] Retains existing surface semantics, bunker/water/woods coverage, green detail, dispersion model, original tee resolver and Windows Companion. **No native clicks**, no production deployment, no new Windows installer, no course registry changes.
- [x] Supports a deliberately labeled **operator-confirmed-hole-only** geometry calculation when GSPro native records represent the *last completed* shot on a previous hole. That is NOT evidence of the live/current ball or a verified tee; all outputs disallow play, course promotion and native input.
- [ ] User simulator acceptance: start with **Greywolf H8** and existing Companion ZIP 6cb09a05, then FarmLinks only if the exact course is loaded in GSPro. Check 3 genuine distinctive cross-map landmarks and the resulting holdout residual; share the exported JSON (plus screenshot separately if desired). **Valhalla remains map-only and is not yet in runtime catalog.**
- [ ] Only after physical matches are observed: consider assisted feature matching using existing GSPro pixels and OSM green/bunker/fairway shapes. Do not build a second hazard, tee or shot engine. Gate broader rollout through an explicit cross-branch integration plan.

[Companion V2 plan / today's simulator acceptance steps](https://github.com/bpgpitt10/nova-v0/blob/auto-aim-windows-companion-v1/docs/windows-companion-autoaim-execution-plan-v2.md)
## GSPro↔OSM coordinate alignment, without rebuilding hazards — 2026-10-12 pass #1

**Scope/decision:** Before writing a new alignment engine, audited the **existing implementation** on this importer staging branch and the parallel `auto-aim-windows-companion-v1` branch. **Hazard/landing/terrain logic is already built and must remain authoritative.** The only missing capability explored here is independent, course-specific evidence that a GSPro minimap landmark and an imported OSM landmark occupy the *same physical spot* in Looper's hole-local yards. This is **read-only research**, not a course-runtime route or automatic landmark detector.

### Reuse instead of duplicate — ownership map

| Capability | Existing source of truth | Policy for this pass |
| --- | --- | --- |
| OSM/native golf surfaces, bunker, penalty, water and surface provenance | `tools/build_osm_course_package_v7.py`, `src/courseGeometry/routePackagedCourseLoader.ts`, `src/courseGeometry/semantics.ts` | **Reuse unchanged.** `SURFACE_CLASSIFICATION_PRECEDENCE` already puts water/penalty/bunker ahead of green, tee, fairway, woods and ordinary rough. No new hazard taxonomy. |
| Vegetation, scrub/woods obstruction, WorldCover | `src/courseGeometry/tacticalClassification.ts`, `src/courseGeometry/semantics.ts`, `tools/promote_cached_course_surface_semantics_v7.py` | **Reuse unchanged.** Woods/scrub can become tactical deep rough; OSM rough remains ordinary rough; 10m WorldCover context does not magically become a confident penalty area. |
| Landing sample cloud, catastrophic/tail scoring, trouble-side decisions | `src/liveCaddie/aimOutcomeSampling.ts`, `decisionLandingState.ts`, `decisionRiskProfile.ts`, `aimOptimization.ts`, `aimDecisionRanking.ts` | **Reuse unchanged.** 2,048 modeled samples, risk buckets for success/manageable/serious trouble/catastrophe/unknown, explicit obstruction and relief. No new recommender. |
| DEM/green and slope/rollout | `src/courseGeometry/courseGreenDetail.ts`, `src/liveCaddie/greenTargeting.ts`, `tools/build_course_green_detail.py` | **Reuse unchanged.** Existing green polygon/DEM alignment and ~1 yd green detail. A guessed GSPro pin is not equivalent to exact green centroid. |
| GSPro world X/Z→hole-local and tee-candidate/locked calibration | `src/courseGeometry/gsproWorldRegistration.ts`, `greywolfWorldCoordinates.ts`, `greywolfH1StartingPositionCalibration.ts`, `shotOneTeeResolver.ts`, `teeCalibrationStore.ts` | **Reference existing transforms and source state.** Current fixed ~0.531922° GSPro rotation is Greywolf-based, not an independent proof of exact alignment for Valhalla or another imported course; never promote it without local checks. |
| Native GSPro ROI, ball/pin marker extraction, gray waypoint yardage, zoom/rotation | `helpers/gspro_minimap_pipeline.py`, `waypoint_scale_cv.py`, `minimap_registration.py`, `gspro_companion_minimap_calibration.py` on `auto-aim-windows-companion-v1` | **Reuse, don't port to importer.** This already gives canonical tee-frame pixels and zoom similarity. Wind/lie OCR is separate and already physically validated. No Chrome screen share. |
| **Missing course-to-minimap frame proof** | New standalone `src/courseGeometry/gsproCourseLandmarkRegistration.ts` | **Only new math.** Fits a 2D orientation-preserving similarity from independently reviewed, paired GSPro **canonical tee minimap pixels** to **existing Looper hole-local yards**, with independent holdout and native waypoint-scale cross-check. Never modifies the existing `CourseHoleGeometry`. |

### Implementation on isolated staging branch

- [x] `src/courseGeometry/gsproCourseLandmarkRegistration.ts`: small pure 2D similarity/translation diagnostic; does NOT reimplement GSPro window capture, SIFT zoom, green terrain or hazard classification. Requires exact round, course key, hole, timestamp, current native minimap registration, native tee yards/pixel, two distinct stable fit landmarks spanning ≥40 yd and ≥40 px, plus ≥1 independent **off-axis** held-out landmark.
- [x] Rejects guessed/estimated feature correspondences (including an OSM **green centroid passed off as a GSPro pin**), mismatched course/round/hole or stale native frame, duplicated feature ownership, bad white-pin zoom check, reflection/reversed hole, singular transform, >8% disagreement with independently measured waypoint yards/pixel, >2 yd fit RMS or >5 yd independent holdout error. Requires ≥8 yd cross-axis holdout distance to distinguish reflections. Source and native point identifiers must be distinct even when positions coincide.
- [x] Returns only a `research-candidate` or `blocked` result with numerical transform/residual diagnostic. Both results always set `verifiedForPlay:false`, `canPublishCourse:false`, `authorizesNativeAim:false`. **There is no automatic feature matcher or new tee validator in this pass.** Manually supplied landmark correspondences are test fixture inputs until physically reviewed on a real course. Any good numerical fit is *not* a statement that OSM accurately depicts all hazards.
- [x] Added `tools/test-gspro-course-landmark-registration.mjs` tests for valid synthetic alignment, dogleg without tee yardage assumption, wrong hole/round, stale observation, bad pin or independent scale, duplicate source, inferred green centroid, reflected/reversed landmarks, collinear validation and false holdout.
- [x] Extended **Course E2E Preflight (No Imports)** CI to run the new research fixture tests and rerun the **existing** `tools/test-course-surface-classification.mjs` and `tools/test_course_surface_semantics_v7.py`, protecting the original trouble severity, surface precedence, mapped hazards and woods/deep rough. No new source downloads, LiDAR imports or production deploys.
- [x] **CI PASS:** [Course E2E Preflight run 38263069025](https://github.com/bpgpitt10/nova-v0/actions/runs/38263069025), including pure cross-frame/dogleg/safety fixtures, existing runtime hazard classifier precedence/deep-rough checks and Python V7 actual imported-hole surface promotion; [Web Alpha run 38263069099](https://github.com/bpgpitt10/nova-v0/actions/runs/38263069099) includes TypeScript compilation/build. An older run briefly produced a Node/Vite segmentation fault **after** printing existing hazard classification results; latest isolated checks passed with no changes to hazard implementation. **These are offline/synthetic validations, not real GSPro-to-OSM correspondence proof.**
- [ ] **Current-shot integration still outstanding:** This pure evaluator cross-checks course/round/hole and frame age but deliberately does **not** parse shot records or override the existing Live Caddie shot-state engine. When connected to Live Caddie, require the already-built `looperCompanionAimPreview.ts` pre-shot / exact-completed-shot matching rules before accepting live positional evidence. A previous-hole completed record must never seed a fresh tee.
- [ ] **Physical evidence gate:** At a runtime-ready course (FarmLinks if in GSPro) or a known Greywolf calibration frame, capture the actual native minimap canonical tee image plus separate OSM course image; independently identify two stable corresponding corners/boundary points and a third, lateral holdout. Verify accepted same course/round/hole, source coordinates, landmark feature IDs, freshness, waypoint scale, measured residuals. Pins can be used only if actual pin position is known and *not* an inferred green centroid.
- [ ] If proof works, separately design an **automatic or assisted landmark matching** workflow using existing OSM green/bunker/fairway polygons and GSPro captured pixels; don't duplicate hazard class semantics. Then test Valhalla missing-tee holes. No new `GSPro-calibrated` play tier until source quality, safe runtime/tee bypass, terrain anchoring, confidence/recommendation degradation and explicit release gate are validated.

**Important distinction:** registration matches coordinate frames; **it cannot repair a missing OSM bunker/water/woods feature**, nor certify that the GSPro model's penalty boundaries agree with OSM. The existing model deliberately marks unmapped areas unknown. When a source feature is absent, use existing uncertainty logic, not inferred hazard-free terrain. The new evaluator never asks to classify a bunker, recalculate shot dispersion or rewrite hole geometry.

## Flexibility research checkpoint — 2026-10-12 (per-hole data + GSPro actual ball)

**User's product question:** Can Looper use a mostly complete imported course with imperfect/missing mapped tee boxes, if GSPro tells us where the player actually dropped the ball? **Answer: potentially yes for live companion-assisted positioning, but this is NOT already a trustworthy GSPro-to-OSM alignment.** The companion's observed ball/pin **pixels** and wind/lie OCR are not course-geographic coordinates. Actual GSPro ball **world** evidence may also exist in `currentRound.dat` on a completed shot; the current native record often describes the **last completed shot**, not the live pre-shot ball. Do not use that as a fresh tee, do not invent scorecard tee names, and never infer a cross-coordinate transform from one unverified feature.

### Separate three different requirements

1. **Map/terrain usability per hole:** mapped `golf=hole` route, green, whole-hole DEM/green elevation, available fairway/bunker/water surfaces with provenance. A missing tee polygon does **not** erase terrain, hazards or green. Missing hazard mapping means **unknown coverage**, not a certified hazard-free zone; condition the recommender's claims accordingly.
2. **Correct user starting ball:** a recent GSPro observation of actual ball and pin, current round/hole/shot match, pixel/yard ruler with independent stability checks and a **separately verified OSM↔GSPro frame transform**. The current Windows Companion can supply the pixels/scale and existing Live Caddie can supply shot state, but physical matching to the imported OSM hole is still **outstanding**. Moving/dropping the ball on GSPro's fairway may help prove **ball-relative shot advice** without needing an exact tee polygon—only once that transform passes.
3. **Correct named tee-set selection:** published Blue/White/Gold tee identities across 18 holes are a *different* truth. Actual ball position on one shot cannot establish a permanent `Blue` tee's physical location on other holes. Never auto-approve a scorecard tee set because a manually placed ball happens to be inside/near a tee/fairway.

### Proposed release tiers (not currently activated)

| Tier | Evidence | User capability | Automatic registry status |
| --- | --- | --- | --- |
| A. Map review | 18 georeferenced hole/green/terrain datasets pass map gate; any missing tee sets or feature coverage flagged per hole | View/search course map and validation notes | **map-only**, not Live Caddie selectable |
| B. Companion-assisted **candidate** | Same map + **current** matching GSPro round/hole and independent OSM-to-GSPro transformation, source/freshness/pin/ball/yard validation on the actual hole | After physical acceptance: optional *unverified-/limited-confidence* live shot preview from actual GSPro ball, per-hole caveats, missing-hazard fallback | **NOT YET IMPLEMENTED**, no change in runtime registry or enabled aim |
| C. Fully verified named-tee play | Existing 18-hole runtime geometry/terrain, plus every *exposed* tee set independently mapped across all 18 holes and validated against identity/scorecard | Round Setup named tee and normal Live Caddie | Existing canonical strict runtime gate; approved subset policy is a separate future implementation |

A failed tee surface on Hole 12 should not necessarily prevent a *map preview* of Hole 12 or live advice after **verified live calibration**, but it should prevent claims that a complete, correctly identified `Blue` tee set is available. A missing fairway, bunker or hazard should be presented as coverage uncertainty and may disable particular hazard-specific advice, not synthesize empty hazards.

### Observed results on already cached real packages

The offline no-import audit ran in [Course E2E CI](https://github.com/bpgpitt10/nova-v0/actions/runs/38248662600) and printed the actual package counts, rather than guessing:

| Package | Geometry/DEM/green evidence | Owned physical mapped tee on hole | Fairway polygons | Tier |
| --- | --- | --- | --- | --- |
| FarmLinks | **18/18** | **18/18** | **17/18** | Existing runtime-ready, tee labels not independently scorecard-certified by this audit |
| Valhalla | **18/18** | **6/18** | **18/18** | Map-review-only, candidate for *future* GSPro live calibration |

FarmLinks's single hole without a mapped fairway is **Hole 17, par 3, 184.6 reference yards**. A par 3 may legitimately have no fairway, so the audit now raises `missing_mapped_fairway_on_par4_or_par5` **only on par-4/5 holes**; par 3s remain eligible to show map evidence. Valhalla has no owned mapped tee polygons on **holes 3, 4, 5, 6, 8, 10, 12, 14, 15, 16, 17, 18**. These numbers demonstrate why a per-hole inventory is more useful than an undifferentiated whole-course failure.

**Important:** `companionAlignedResearchHoles=0` for both cached packages because no real current-GSPro observations were supplied to this offline audit. That is expected; it does NOT mean native ball/pin capture is broken, which was already observed working on Greywolf. No course was newly imported, published, certified or made playable by these tests.

### Offline implementation completed without changing runtime

- [x] `tools/audit_course_flexible_readiness.py`: independent per-hole evidence inventory. Reports mapped tee/fairway/green/bunker/water counts, DEM/green availability, unknown hazard completeness, incomplete hole concerns and the need for native ball/frame calibration. Labels `map_review_only_companion_calibration_candidate` vs `existing_runtime_ready_not_scorecard_audited` vs `incomplete_source_or_receipt`.
- [x] `tools/test_course_flexible_readiness.py`: no-network regression cases for a course with 18 mapped holes but zero OSM tees; generic `Tee 1` must **not** imply true named tee; GSPro ball + pin pixels without registration stay **unregistered**; independently crosschecked ball/landmarks remain **research only**; mismatched receipt/terrain and 17-hole input fail closed.
- [x] `.github/workflows/course-e2e-preflight-ci.yml`: adds regression tests and tests the real already-committed **FarmLinks** runtime package and **Valhalla** map-only package using the audit without fetching any source data or reimporting.
- [ ] **Cross-frame proof:** build an independent static OSM hole↔GSPro minimap correspondence (e.g., a validated pin plus a second independently matched stable landmark or semantic surface shape) to ground scale, orientation and translation. Do not treat the same ball marker used to fit as independent verification. Require fresh matching round/hole, significant pixel frame confidence and measured target/ball residuals; begin **read-only**.
- [ ] **Dynamic no-tee live policy:** after physical simulator proof, introduce an explicit limited-confidence **GSPro Live** path without publishing guessed tee identities. Gate recommendation assertions *per hole and per feature*; keep unverified hazard/green positioning blocked rather than passing a distorted course. Inactive until separate review, CI and user approval.
- [ ] **Approved named tee subsets:** align the research scorecard matcher with an explicit vetted `approvedTeeSets` allowance; each offered set still requires exactly one independently confirmed tee mapping for **every** hole. Missing other colors must not block a genuinely complete subset. This changes runtime contract only in a separate reviewed pass.

**Next bounded experiment:** Use the **existing Valhalla cached map** (which is valid for all 18 hole geometry/terrain stages but has mapped tee polygons on only six), and the already validated Greywolf companion capture to prototype alignment from **live ball to OSM green/fairway**, with two independent anchors and no native clicking. A change in the companion ball position after a GSPro drop must be shown fresh, not assumed from last-completed. Record before/after pixel coordinates, scale, hole match and yard residual; fail closed on cross-hole stale state. Until that evidence exists, tier B is a **design/research candidate, not available play**.

## Operational status — 2026-10-12 (reviewed; no new import triggered)

**Executive state: canonical course importer works for a mapped/tee-complete course; self-service arbitrary course-to-play is NOT accepted yet.** Keep five states distinct: (1) name request accepted, (2) geometry/map ready, (3) all-18 tee/terrain/green **runtime ready**, (4) browser **player ready**, (5) physically **GSPro verified**. A successful CI job or map preview is not a substitute for the subsequent gates.

**Source branches and release boundary**

- **Production baseline:** `web-alpha-mishits`, deployed READY from `59b017505`. Nothing in this study was merged/promoted to production.
- **Importer + UI reviewed baseline:** `farmlinks-ui-review-v1` at `7a47e74fc`; branch preview READY, and it selectively informed this staging branch. This is not a production release or a GSPro player acceptance result.
- **Current full-name staging:** `web-course-e2e-preflight-v1` at `36f524d4e`; [latest READY preview](https://looper-br26ap57d-wqk25hkxcg-3591.vercel.app/round-setup), [Course E2E Preflight CI PASS](https://github.com/bpgpitt10/nova-v0/actions/runs/38177381530) and [Web Alpha CI PASS](https://github.com/bpgpitt10/nova-v0/actions/runs/38177381516). All importer/data research below lives on this isolated branch, not the Windows Companion/Partial Shots branches.

### Course-specific acceptance, not assumptions

| Course / test | Latest demonstrated state | Exact limitation |
| --- | --- | --- |
| **FarmLinks at Pursell Farms** | **RUNTIME READY**: `artifacts/course-geometry/farmlinks/runtime-ready-v1.json` and `validation-v1.json`, 18/18 routes, all-18 tee contract, whole-hole USGS terrain, ESA WorldCover, same-DEM green detail, canonical registry present, runtime loader validation. | Strong reference build, not proof that an uncurated typed name reliably reaches play, nor physical GSPro play/visual UI acceptance for every hole. Some tee metadata was curated during the prior lineage. |
| **Shaftesbury Glen** | Previously selected for the first typed-name timed test, but discovery returned a non-course/tram-stop result and no trustworthy unique mapped golf boundary. | **Discovery blocked; no valid canonical import.** Do not invent an OSM identity or label the test complete. No verified timing receipt for a full import. |
| **Valhalla Golf Club** | Actual user-name cold workflow resolved Louisville course to OSM way `59737644` automatically and produced **MAP READY** green detail + DEM + WorldCover. `map-ready-v1.json` says only **6/18 holes have a mapped tee surface** and `runtimeReady:false`; no `runtime-ready-v1.json` and not in generated live registry. | Static tee-selection contract failed; no course selectable for live play. [The canonical run](https://github.com/bpgpitt10/nova-v0/actions/runs/38106048959) preserved map-only output and receipts, rather than fabricating tee positions. |

**Valhalla profiling findings:** `artifacts/course-geometry/valhalla-golf-club/import-timing-v1.json` shows `elapsedWallSeconds=23.446` for importer-machine work, including ~10.138 seconds OSM geometry, ~10.286 seconds WorldCover, ~0.703 seconds terrain and ~1.294 seconds green detail; cache pre-existence was **false**, but actual cache hits were **not independently verified**. The job rejected the full static tee contract after producing map-ready data. These are not button-to-preview wall times. **Timing anomaly:** receipt's `requestedAt=2026-10-11T14:25:00Z` is later than importer `startedAt=14:24:39Z` and the discovery's `resolvedAt=14:24:24Z`; thus request-to-import/completion timing fields in this particular run are chronologically inconsistent and MUST NOT be used as end-to-end latency evidence. Before the next true timed button test, confirm one consistent server-stamped request and CI queue/deployment clocks.

### Administrative request / timed end-to-end readiness

- [x] Staging-only **Add a Course** is wired in `/round-setup` for signed-in administrators, plus server-side Supabase user and `allowed_users.is_admin` verification. The server writes only `config/course-name-request.json` on this branch; `Rebuild Course Canonical` watches it, resolves a unique OSM boundary, imports and publishes vetted output. Missing boundary, tee evidence or high-resolution terrain fails closed; map-only package may be previewed in staging but not offered as playable.
- [x] Offline tests cover name resolver (with bounded spatial fallback), failed discovery receipts, timing receipts, auth/request/45-minute cooldown, WorldCover hole masking and tee evidence. Automated no-import preflight and web builds passed at current branch HEAD. 45-minute cooldown is a conservative **single-staging-request guard, not a multiuser queue**.
- [x] Machine timings persist per subprocess/phase, with failures recorded, plus separate discovery timing. The plan distinguishes button acceptance, CI queue, data import, registry/runtime gate, preview deployment and browser/GSPro QA.
- [ ] **Real button is not yet verified usable:** live admin click→authenticated Vercel function→GitHub branch request→Actions→preview was not demonstrated as one uninterrupted path. The connected Vercel project's environment-variable listing did not expose a `LOOPER_GITHUB_DISPATCH_TOKEN` for this preview project/branch at review time; the API is coded to respond `503` when missing. Confirm safe token presence and actual role permissions before claiming request acceptance. Never put credentials in React/Git/logs.
- [ ] Browser QA: actually see `/round-setup`, correct course and tee options, Start Round, Live Caddie geometry/green rendering on the resulting preview; production navigation/release is separate.
- [ ] Physical GSPro course/tee identity and round progression remain an explicit user-present gate. No virtual tee or scorecard label may be misrepresented as verified play.

### Broader GSPro/OSM coverage study and tee-identity blocker

See [GSPro→OSM 50-course durable research handoff](./gspro-osm-50-study-handoff.md) and `research/course-coverage/results/`. This is a **stratified set of 50 GSPro-listed U.S. courses, NOT a random national sample**. Only the first **10** have geometry-only OSM audit results (no 50-course LiDAR import): **0 A_verified_usable, 6 B_near_usable, 3 C_incomplete, 1 D_no_usable_osm**. Forty remain unstudied. The B group can have 18 mapped hole routes and generic tee candidates while lacking trustworthy actual named tee/scorecard correspondence; four strongest examples are Hiawatha Landing, Running Deer, Samoset and The Golf Club of New England. None passed named-tees validation for release.

- [x] Official scorecard checks at four strongest first-batch courses exposed generic `Tee 1` labels that do not prove actual Black/Blue/etc. positions, even when 18/18 OSM tee polygons exist.
- [x] Added research-only scorecard-guided tee identity matching and independent allowed-subset evaluation: **57 subsets at The Golf Club of New England; 0 complete 18-hole verified subsets**. Best Green+Blue has 16/18 and 15/18 unambiguous matches. Holes **12/17** remain difficult, with competing adjacent-hole tee ownership.
- [x] Research-only relaxation from 35-yd route proximity to 65 yds recovered three polygons (H5 and H16) but did **not** increase 18/18 validated subsets and can worsen assignment ambiguity. **Do not raise the production cutoff** without a supported cross-hole ownership model.
- [ ] **Approved-subset tee policy (product decision, not yet runtime implementation):** A new course may offer only Blue/White, for example, if **each exposed named tee set has actual verified 18/18 tee assignments**; absent Gold/Black must not poison validated Blue. Existing runtime validator still derives assumed tee sets from Hole 1; an audited `approvedTeeSets` allowlist does not yet exist. Never show invented generic labels or silently substitute a hole-route start as a real selected tee.
- [ ] Inspect GCNE H12/H17 mapped tee pads on a georeferenced view plus official hole yardages; improve competing-hole and shared-pad matching, rerun the independent-subset test. Only implement runtime allowlisting if at least one real, complete named subset passes. No wholesale 50-course LiDAR imports, aerial tee-detection rewrite or unsupported tee inference.

### Recommended next execution order (one deliberate sequence)

1. **Preserve FarmLinks and Valhalla evidence:** FarmLinks as the known runtime success, Valhalla as the known valid map-only blocker. Do not refetch or rebuild either just to prove existing automation.
2. **Resolve the tee-set release contract using cheap cached geometry/scorecards:** GCNE H12/H17 research and conservative approval subset; then one 18-hole correctly named tee subset if evidence permits. This is the highest-leverage generalizability gap for user-entered courses.
3. **Prepare exact self-service QA:** verify the server-side preview dispatch credential and admin status, validate click→Actions request/release with a user-approved new course (Shaftesbury Glen only if legitimate boundary discovery succeeds), and measure click, queue, machine phases, deployment and browser-ready separately. Do not pretend a map-ready result is a completed playable import.
4. **Only after runtime passes, browser + GSPro acceptance:** assert correct tee names/positions in Round Setup and Live Caddie, terrain/green/mapped hazards at representative holes and corner cases; then physical sim identity/playing positions. Record durations and failure causes in durable receipts.

**Documentation owner:** This file is the canonical operational self-service/importer status and the next E2E test checklist. Keep raw experiment data and tee identity decisions in `docs/gspro-osm-50-study-handoff.md`. The Windows Companion/AutoAim and Partial Shots integration plans should **link** here, not duplicate or overwrite the importer evidence. No importer/main/production changes are authorized by this status review.

## Strict scope
Branch: `web-course-e2e-preflight-v1` forked from `web-alpha-mishits` at
`59b0175`, never from the FarmLinks review or stale importer branches.
The production landing/auth shell is authoritative. Course runtime components,
Round Setup, and reviewed Live Caddie map/aim presentation are selectively
ported from `farmlinks-ui-review-v1`. Live Caddie retains the production
green-detail, GSPro pin position, green-target, and target-elevation changes.
Partial Shots and native Windows Auto Aim remain out of scope.

This preflight does **not** import another course or imply a fully deployed
self-service course service. Do not quietly invoke the discovery command in
CI outside a genuine user request.

## Admin-only staging request flow
Authenticated admin -> /round-setup -> Add a Course -> POST /api/course-request.
The server independently validates the Supabase session and the
`allowed_users.enabled && allowed_users.is_admin` record, and rejects calls
outside this exact staging Git branch.

The server requires secret `LOOPER_GITHUB_DISPATCH_TOKEN` in the **preview**
Vercel environment. Use a fine-grained GitHub token with Contents: Read/Write
on *only* `bpgpitt10/nova-v0`; do not embed a token in React, Git or logs.
Without it, the endpoint deliberately returns HTTP 503 and cannot queue a job.
The server atomically updates `config/course-name-request.json` via GitHub's
Contents API. This commit triggers Rebuild Course Canonical on this branch.

The GitHub workflow resolves the name against one Nominatim request, requires
one exact mapped golf-course boundary (way or relation), writes the generic
config and invokes `tools/import_course_canonical.py`. Ambiguity, missing
holes, absent DEM coverage and bad tee contracts fail closed. No source-code
modifications, predetermined OSM IDs or manual tee guessing are allowed.
On a successful run, the workflow commits the package, generated registry,
config, timing receipt and source provenance to this staging branch. GitHub's
preview deployment then republishes the web package.

Do not turn on this dispatcher for production or non-admin accounts until
authentication, rate limits, observability and API-level tests have passed.

## Timing and status facts
- `artifacts/course-discovery-v1.json`: name-lookup wall time and selected OSM
  identity on success; failure cause and elapsed time on name-lookup failure.
- `artifacts/course-geometry/<slug>/import-timing-v1.json`: durable
  timestamped machine steps, per-phase wall times, elapsed wall time,
  failures and whether a prior cache was present. Presence is *not* proof
  that cache was used.
- GitHub Actions artifact: timing and discovery receipts uploaded even on
  failed builds when those files exist. The machine receipt covers Python **and**
  Node subprocesses; where a name request exists it also measures request-to-importer
  and request-to-runtime-completion time.
- Distinguish first request, CI queue, discovery, import, runtime ready,
  deployment ready and browser QA. The Python machine clock alone does not
  measure customer wait. End-to-end stopwatch should start from click.

## Independent quality gates
- OSM exact-boundary source requires 18 unambiguous golf-hole routes.
- Whole-hole terrain DEM and green sampling from same source.
- Contract gate: every canonical tee set resolves once on all 18 holes.
- New WorldCover gate prevents known tee surfaces being repainted as
  woods/scrub/etc. The H13 failure mode involved both smoothing growth and
  dropping polygon interior holes during serialization.
- Visual QA for representative and outlier holes, plus browser-level
  Round Setup and Live Caddie checks, remains a human release gate.

## Acceptance levels
1. **Request accepted:** real button press creates an authenticated job.
2. **Runtime Ready:** all 18 holes, greens, terrain and tees pass automated
   contracts and runtime loader tests.
3. **Player Ready:** new preview build contains course; Round Setup selects
   plausible tee names and Live Caddie renders cleanly on browser QA.
4. **GSPro Verified:** actual sim identifies and uses course/tee correctly.
   This requires a physical sim session and is *not* implied by 1–3.

**Stop before the next real course until:** the staging dispatcher is
configured and tested without triggering a real import; offline and web builds
are green; UI is visibly acceptable. Preserve original failure timings.

## Staging request throttling
The API rejects new requests for 45 minutes after the previous accepted request. This is a conservative staging-only serialization guard (35-minute importer timeout plus queue/retry margin), not a scalable multi-user queue. Conflicting GitHub file updates return an explicit 409 rather than a false acceptance. Offline mock API tests exercise authorization, malformed inputs, repeat requests, and source-control conflicts. The generated course package commit intentionally does not restage the rebuild-request trigger file.

## Location-first golf fallback (staging pilot)
When the OSM Nominatim name lookup finds **zero** matching golf-course ways/relations, run one independent Photon geocoding request for a golf venue, then read a single bounded OpenStreetMap core map tile around its coordinates. Accept only one unambiguous named OSM `leisure=golf_course` way/relation and continue to the existing strict 18-hole importer. Never infer geometry from a search point, never use a general POI as a boundary, and never bypass the canonical hole/tee/terrain gates. Geocoding and map lookups are server-side with descriptive User-Agent strings; use only on actual user-initiated cold requests, not batch polling. Demo public providers are suitable only for this low-volume pilot; replace them before broader self-service.

## Valhalla cold-run finding (2026-10-10 Eastern)
User-submitted name `Valhalla` resolved automatically through OSM Nominatim to mapped Valhalla Golf Club (`way 59737644`) in Louisville, KY, without geographic fallback or ID hardcoding. The canonical importer fetched 18 routes and completed whole-hole DEM, WorldCover context, and green-detail quality gates; the **runtime static contract rejected Hole 3 for missing mapped tee surface**. Do not call Valhalla imported/runtime-ready or silently synthesize a real tee surface from the playing-line start. Inspect the full per-hole inventory before designing a clearly labeled virtual-tee preview or alternate authoritative tee geometry integration. See run 38106048959.
