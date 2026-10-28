# Looper course-data foundation — implementation plan V1

**Created:** 2026-10-28  
**Status:** APPROVED DIRECTION / IMPLEMENTATION NOT STARTED  
**Tracking owner:** Looper course-data pipeline  
**Working baseline:** `web-alpha-mishits`  
**Reference pilot:** FarmLinks at Pursell Farms, **Hole 1 first**, then all 18 holes  
**Second-course acceptance:** independently chosen course with different OSM/GSPro layout conditions  
**This is the canonical checklist for the course-data redesign.** Update this document at the end of each implementation pass; record the commit/PR, test evidence and date beside each checked item.

## Why this plan exists

Current Looper imports useful fairways, greens, bunkers, water, limited context and DEM elevation, but the pipeline is optimized too early for a small tactical package. Source features are filtered, assigned to a route, clipped to narrow corridors and sometimes generalized before we have an accountable full picture of the real-world hole. A "runtime ready" report does **not** measure source-retention or GSPro correspondence. We need:

1. A **source-faithful course model** retaining original OSM feature identity, shapes, tags, route, terrain source and provenance, plus independently sourced context (LiDAR / imagery when justified).
2. A **native GSPro course metadata layer** from the installed GKD, containing tee/pin/aim/OB/hazard evidence in its own coordinate frame.
3. A **verified per-course/per-GKD-version registration** between GSPro X/Z and real-world OSM/DEM coordinates.
4. Small **derived tactical/browser packages**, generated *from* the richer data, without becoming the only copy.
5. Automated local GKD discovery via the Windows Companion and reproducible course import/quality gates.

**No dependency on the external Reddit developer, his private source code, 3D rendering, shot replay, or the 638 MB Unity bundle.** Those may inform later research but are not prerequisites.

## Evidence and status baseline (2026-10-28)

These items are **research findings, not release approval**.

- [x] FarmLinks GKD fixture available for research; it encodes 18 holes, multiple tee locations, four daily pins per hole, designer AimPoint routing, hazards and OB. Native X/Z coordinates are in a shared course-local frame; the GKD does not supply a guaranteed geographic origin.
- [x] Offline FarmLinks GSPro↔OSM **research** alignment calculated from native GKD green positions and OSM green centers. Reported global fit: approximately **3.59 m RMS green-center residual**, **1.0008 fitted scale**, about **0.11° rotation**, **6.82 m maximum green-center residual**. All **72/72 GKD pin positions** transformed inside their corresponding 18 OSM green polygons.
- [x] Confirmed this is **not independent cross-course or live-shot certification**. All green centers participated in the research fit; the 72 pin-in-green test is a strong sanity check but not an independent landmark holdout. No automatic aim/click approval follows from these numbers.
- [x] Inspected canonical Looper importer: `tools/fetch_osm_course_snapshot_core.py`, `tools/build_osm_course_package_v5.py` / `v7.py`, `tools/fetch_course_dem.py`, `tools/build_course_terrain.py`, `tools/enrich_worldcover_context.py`, `tools/import_course_canonical.py`.
- [x] Verified source-loss mechanisms: narrow initial OSM tag allowlist; route-corridor clipping (default ~110 yd context / hazards, ~85 yd fairway); 0.2 yd OSM polygon simplification; a ~10-yard whole-hole runtime elevation grid; 10 m ESA WorldCover converted into broad context polygons. FarmLinks original OSM woods context was absent in the preserved snapshot; missing features cannot be restored solely by changing the clipper.
- [x] Confirmed existing `currentRound.dat` archive parsing reads `StartingPOS`, `EndingPOS`, `GhostData.atShotData.tdpoint` when available, plus launch/spin fields. Actual touchdown and final rest can be distinguished; frame-by-frame bounce replay is not an established data product.
- [x] Confirmed existing OSM `golf=hole` routing in the importer and native GKD `AimPoint` routes. The present runtime package should retain both, rather than confuse intended designer aim with geometric fairway centerline.

**Current release state:** The research supports implementation, but the new native parser, Companion GKD library scan, versioned native cache, full-fidelity source package, independent holdout tests and new tactical integration are **not complete**. Do not check implementation tasks based only on discussion, synthetic math or screenshots.

## Governing design decisions

- **Preserve first; interpret second.** Keep complete available source evidence in an import/source layer. The smaller strategy package is derived, never the authoritative master.
- **Each source retains its identity and license:** OSM data/tag provenance, LiDAR/DEM acquisition and classification, imagery provenance, GKD version/hash and optional approved native cache. Do not silently merge sources without lineage.
- **Native ≠ geographic:** GKD positions, GSPro current round and OSM/DEM each have an explicit coordinate reference. Transform only with version-matched, validated registration.
- **GSPro vs real-world mismatch is expected:** Golf simulators may modify terrain, vegetation, hazards and greens. Never promise real-world LiDAR/OSM exactly matches GSPro. Classify uncertain or missing areas as **unknown**, not automatically ordinary rough or deep rough.
- **Keep raw/source archives out of browser bundles:** Retain high-resolution source artifacts outside runtime; produce compact, versioned runtime tiles and tactical summaries.
- **Do not rely on GKD filenames for identity:** Names differ. Use file content, course folder metadata, current GSPro `CourseKey` and tee/pin/layout correspondence with ambiguity checks.
- **Read-only and privacy-respecting:** Companion searches configured/verified GSPro course-library roots, never arbitrary drives. It reads relevant metadata, returns bounded data, and does not expose full file paths or raw user folders to the hosted browser. No automatic upload of third-party GKD files to a shared server without rights review and appropriate permission.
- **No regressions to current Live Caddie:** Existing OSM-only fallback remains usable when native data unavailable. Do not publish hazard-aware precision/Auto Aim based on provisional registration.

## Milestone 0 — lock fixtures, reproducibility, and baseline

**Goal:** A repeatable test suite for FarmLinks without re-importing all 18 holes or requiring a simulator for every edit.

- [ ] **M0.1** Commit sanitized, legally appropriate FarmLinks **GKD-derived test fixture** or build a private test-fixture mechanism; preserve hashes, known 18-hole expected counts and per-hole values. Do not blindly commit raw proprietary GKD assets.
- [ ] **M0.2** Save the 2026-10-28 coordinate research as a reproducible script and JSON result (source references, fit method, scale convention, residuals, 72 pin inclusion, input hashes). Recompute, don't copy numbers as constants.
- [ ] **M0.3** Establish the **current** FarmLinks Hole 1 geometry/terrain inventory: original source classes, after-fetch surviving classes, after-normalization classes, after-clip counts, runtime polygons, source resolution, runtime grid and package size.
- [ ] **M0.4** Capture representative ground-truth screenshot(s)/course landmarks where permitted, with a private test protocol and no user-private files committed.
- [ ] **M0.5** Freeze existing importer, browser course-load, lie/surface, live ball-position and shot-state regression commands before altering packages.

**Gate M0:** One read-only command regenerates baseline reports and explicitly separates measured evidence, assumptions and missing sources.

## Milestone 1 — normalized GKD parser and course registration

**Goal:** Parse installed native GKD geometry without needing a filename convention or a live GSPro round.

- [ ] **M1.1** Build an offline parser for real `.GKD` and supported `.GKDalt` variants, with schema validation, safe size limits and deterministic behavior on malformed files.
- [ ] **M1.2** Extract *all* tee positions, applicable pin locations, par, native hole routes/`AimPoint`s, hazard and out-of-bounds polygons. Preserve any unknown raw GKD hazard type; do **not** assert "bunker" or "water" unless encoded or independently confirmed.
- [ ] **M1.3** Publish a normalized `looper-gspro-native-course-v1` contract with GKD source SHA-256, semantic fingerprint, parser version, course identity evidence, geometry and raw-unit/axis documentation.
- [ ] **M1.4** Write native fixture tests for FarmLinks regular and Kids variants, multiple tee sets, daily pins, duplicate/ambiguous names, same geometry under revised tees, incomplete and malformed GKD.
- [ ] **M1.5** Keep *native course identity*, *native layout revision*, *selected round tee/pin* and *real-world course ID* distinct. Prove exact-version lookup and fail-closed ambiguous identity behavior.
- [ ] **M1.6** Validate the normalized GKD tee→designer aimpoints→pin distances against expected FarmLinks in-game readings, with correct horizontal vs routed distances and units.

**Gate M1:** One offline command parses FarmLinks and emits deterministic, self-contained, reviewed native metadata. No runtime/Companion changes required.

## Milestone 2 — Companion discovery, local native cache and optional shared cache

**Goal:** When a user plays GSPro with the Companion connected, obtain the correct local native layout automatically. Allow non-Companion fallback.

- [ ] **M2.1** Extend existing `helpers/gspro_native_discovery.py` to identify known GSPro course-library roots from process/install/config evidence, with explicit override and bounded scanning. Current discovery targets **LocalLow currentRound/log/GSPro.db**, not arbitrary GKD course libraries.
- [ ] **M2.2** Enumerate GKD candidates and metadata once per library change; use file signatures/hash + content/layout identity, **not** basename as primary key.
- [ ] **M2.3** Match active `currentRound.dat` `CourseKey`, installed folder and known tee/pin evidence to exactly one installed layout. Handle same-name duplicates, alternate GKD, deleted/reinstalled course, missing `CourseKey`, and changed GKD. Ambiguous remains unbound.
- [ ] **M2.4** Add a small **read-only** Companion endpoint returning bounded, sanitized parsed native metadata and identity diagnostics. Keep localhost/origin/pairing threat model and existing Live Caddie state authority intact. No unrestricted filesystem API or raw path leak.
- [ ] **M2.5** Cache the parsed result locally by content version; check mtime/size cheaply, hash when changed, invalidate obsolete registrations when the GKD hash changes.
- [ ] **M2.6** Define a *separate* optional shared/approved GKD-derived course cache associated with Looper course IDs and native version fingerprints; publish only after legal/rights review. Shared cache should accelerate preloading, but **never override a different verified installed revision**.
- [ ] **M2.7** Exercise missing Companion, offline mode, permission denied, custom installation drive, no installed GKD, and local-only cache. Fall back safely to existing imported OSM/LiDAR information.

**Gate M2:** On the real FarmLinks simulator PC, Companion discovers the correct installed native layout with no manual file selection; future loads reuse the exact-version local cache. No raw GKD upload required.

## Milestone 3 — independently validated native↔geographic registration

**Goal:** Replace approximate tee/ball placement with evidence-based course-wide positioning.

- [ ] **M3.1** Implement a robust *course-level* 2D GSPro X/Z → geographic east/north transformation from GKD and OSM green anchors. Explicitly document meters→yards, handedness, axis rotation and constrained vs freely fitted scale.
- [ ] **M3.2** Use held-out **holes and independently identified off-axis landmarks** to measure actual registration quality; avoid treating pins from the same fitted greens as independent holdouts.
- [ ] **M3.3** Compare GKD tee positions transformed to geo against OSM tee pads where available; account for pad centroids, pin options, nonstandard tee ownership and offset from centroid.
- [ ] **M3.4** Bind the fit to `courseId + nativeLayoutFingerprint + OSM package hash + algorithm version`, report RMS/max/holdout errors and status (`candidate` / `validated` / `rejected`).
- [ ] **M3.5** Confirm live `StartingPOS` and later `EndingPOS` land on the correct FarmLinks hole surface within measured bounds, under real installed round/hole/tee evidence.
- [ ] **M3.6** Reject mis-matched courses, coordinate inversion/mirroring, major lateral errors, stale prior rounds and altered GKD. Preserve read-only/local fallback.
- [ ] **M3.7** Define separate **Live Caddie precision** and **native Auto Aim** gates. Registration passing a visual map check is not authorization to click a GSPro minimap.

**Gate M3:** Persisted, versioned registration passes held-out geometric evidence and on-simulator ball/tee tests; measured uncertainty travels with projected points. A 3.59 m all-fit RMS by itself is **not** sufficient.

## Milestone 4 — full-fidelity source importer V2

**Goal:** The import package represents the whole relevant hole, not only currently understood tactical surfaces.

- [ ] **M4.1** Define versioned **full-fidelity source model**: original OSM geometries, complete relevant tags/IDs, bounds, course/hole association, native route, source CRS, capture dates and provenance.
- [ ] **M4.2** Separate **source acquisition** from **tactical interpretation**. Preserve complete geographically relevant OSM features within the course footprint plus explicit safety margin. Keep an archive of original geospatial source evidence instead of irreversibly discarding unrecognized tags.
- [ ] **M4.3** Replace route-corridor **source-retention** clipping with whole-course/complete-hole retention; use a tactical corridor only later for runtime performance or queries.
- [ ] **M4.4** Preserve unclassified geographic features, such as paths, drainage, vegetation, sand, walls or structures when sourced, without inventing golf lie or penalty codes.
- [ ] **M4.5** Preserve polygon holes/interiors, multipolygons, overlapping source objects, geometry IDs and reasonable precision. Document simplification thresholds and store unsimplified source originals.
- [ ] **M4.6** Build a **loss-accounting audit**: for each input source, list total features, included, clipped, simplified, merged, rejected, unknown/unmapped and exact reason. Distinguish **source absence** from **pipeline loss**.
- [ ] **M4.7** Add explicit source-coverage reporting, including missing OSM woodland/rough/other context, to avoid passing a course as "high fidelity" merely because it has a green and fairway.
- [ ] **M4.8** Derive the existing `looper-static-course-package-v1`-compatible runtime shape from V2, initially without changing gameplay or semantics. Verify current Live Caddie tests.

**Gate M4:** FarmLinks Hole 1 source features are accounted for; tactical selection no longer deletes source evidence. Legacy runtime behavior remains stable.

## Milestone 5 — terrain and environment fidelity

**Goal:** Fill gaps where source data does not describe the actual hole, using independent evidence.

- [ ] **M5.1** Preserve original georeferenced DEM/point-cloud provenance, native resolution and raw/derived data distinction. Runtime ~10-yard elevation is a cache optimization, not the master.
- [ ] **M5.2** Compare FarmLinks actual 3DEP DEM availability and source resolution. Measure interpolation/sampling error with 10 yd vs finer tactical landing grids and existing ~1 yd green-detail sidecar.
- [ ] **M5.3** Pilot *bounded* high-resolution LiDAR/point-cloud acquisition for Hole 1 if a licensed/public dataset is suitable, without fetching a whole county or 18-hole bulk dataset.
- [ ] **M5.4** Add source-evidenced vegetation/woodland outlines, open areas and material terrain boundaries where available; individual trees/height/crown estimates are **optional enrichment**, not the primary success criterion.
- [ ] **M5.5** Assess imagery-derived features only when allowed and necessary; preserve imagery dates/license/confidence, and do not fabricate bunkers, water or penalty markings merely from color.
- [ ] **M5.6** Validate actual simulated conditions: compare GSPro screenshots and native GKD hazards/OB with OSM imagery/LiDAR. Record discrepancies; prefer validated native evidence when conflicts are relevant to play.
- [ ] **M5.7** Make missing/uncertain surfaces explicitly **unknown**, not automatically rough or safe. Keep GSPro HUD/current-round lie labels as higher-priority live player-surface evidence.

**Gate M5:** Hole 1's terrain/environment has documented source coverage, improvement over old geometry and independently reviewed discrepancies, not just an attractive rendering.

## Milestone 6 — native routing, derived tactical view, and Live Caddie

**Goal:** Convert rich source evidence into reliable strategy inputs without contaminating the source model.

- [ ] **M6.1** Store OSM `golf=hole` path and GKD designer `AimPoint` routing as *separate first-class polylines*, maintaining source and coordinate frame.
- [ ] **M6.2** Derive fairway centerline/cross-sections, fairway widths, landing zones and reachable corridors from preserved polygon geometry. A geometric centerline is **not** automatically the optimal aiming line.
- [ ] **M6.3** Add source precedence + confidence policy for native hazards/OB, OSM golf surfaces, inferred wooded areas, DEM elevation and unknown areas. No undocumented GKD hazard type promotion.
- [ ] **M6.4** Map native live `currentRound.dat` selected ball/tee/pin evidence into that combined model using only validated GKD/course registrations.
- [ ] **M6.5** Keep existing full-shot, partial-shot/Shot Strategy, wind, lie, surface and green logic working; compare recommendations old vs new for known fixtures and quantify changed recommendations.
- [ ] **M6.6** Publish only appropriately validated tactical geometry to the browser. Preserve old course package fallback and explicit warnings when registration or source detail is inadequate.
- [ ] **M6.7** Optionally preserve touchdown vs final rest for future landing/rollout analysis; **do not** build a shot replay/3D interface as part of this work.

**Gate M6:** On FarmLinks H1, the caddie uses actual ball location and appropriately classified terrain/hazards and can state when it doesn't know the surface. Existing shot recommendation logic passes regressions.

## Milestone 7 — end-to-end importer productization

**Goal:** New course request → reproducible import → validated package → reliable live use.

- [ ] **M7.1** Finish FarmLinks Hole 1 acceptance before bulk 18-hole work; then run all 18 and record exceptions per hole.
- [ ] **M7.2** Test a *second course* not used to tune the original alignment/geometry algorithms. Include poor OSM coverage and mismatched/absent GKD as scenarios.
- [ ] **M7.3** Instrument timers for discovery, fetch, geometry normalization, terrain, environmental enrichment, registration, validation and publish; record compute/download sizes and costs.
- [ ] **M7.4** Add CI for deterministic parser/importer/geometry contracts, source-retention counts, coordinate holdout regression, bad-source rejection and existing runtime compatibility.
- [ ] **M7.5** Define promotion tiers: source-captured, map-ready, registered-for-live, fully strategy-ready. Never label "runtime ready" equivalent to source-fidelity or native precision certification.
- [ ] **M7.6** Add operator-facing progress/status and clear failure reasons (not found, missing raw source, incomplete OSM, invalid GKD, registration failed, low-confidence tactical areas).
- [ ] **M7.7** Complete licensing and redistribution checks for OSM/ODbL, elevation/imagery and GSPro-derived GKD metadata before public shared-cache publication.
- [ ] **M7.8** Physical simulator acceptance across beginning of round, shot 2+, hole transitions, Companion restart, missing local course, and course revision change; retain safe fallback.

**Gate M7:** A separate user/cold machine can request a new course, produce a documented source-fidelity audit and a validated package, and play through without manual hole-by-hole repairs.

## Done / pending / deferred policy

- **[x] means completed with evidence**, not designed, discussed, mocked, or CI-only when physical acceptance is required.
- Check off *only* the smallest verified task. Append an entry to the change log each time, with branch, PR/commit, tests and remaining limitations.
- If a strategy feature passes offline but requires physical confirmation, keep the physical acceptance item unchecked.
- Do not widen from FarmLinks H1 to all 18 until its milestone gate passes.
- When another branch carries implementation, note its ref and whether merged into `web-alpha-mishits`. **A working branch is not a deployed release**.
- Keep Windows Auto Aim implementation/permission gates in its **separate** plan; this document owns only the native course data and registration dependency.

## Out of scope / parked

- Reverse engineering/rendering Unity `.unity3d` asset bundles as the core data source.
- Interactive 3D golf visualization, replay animations or frame-accurate bounce reconstruction.
- Auto-publishing proprietary third-party GKD content or raw user GSPro logs.
- Automatic native mouse aiming before independent physical and security acceptance.
- Bulk course imports until the pilot's source fidelity and quality gates work.

## Related existing plans and code

- [Canonical course terrain package contract](./course-terrain-package-v1.md)
- [Green-detail terrain sidecar](./course-green-terrain.md)
- [Windows Companion Auto Aim execution plan](./windows-companion-autoaim-execution-plan-v2.md)
- [Shot Strategy ↔ Companion merge plan](./shot-strategy-windows-companion-merge-plan.md)
- [Course self-service preflight research (separate staging branch)](https://github.com/bpgpitt10/nova-v0/blob/web-course-e2e-preflight-v1/docs/course-self-service-preflight.md)
- Import pipeline: `tools/import_course_canonical.py`, `tools/build_osm_course_package_v5.py`, `tools/fetch_course_dem.py`, `tools/enrich_worldcover_context.py`
- Companion: `helpers/looper_companion.py`, `helpers/gspro_native_discovery.py`, `src/adapters/looperCompanion.ts`
- Runtime: `src/courseGeometry/courseProvider.ts`, `src/adapters/browserGsproCourseStateCore.ts`, `src/adapters/browserGsproCourseArchive.ts`

## Change log — append, never silently rewrite history

| Date | Item(s) | Change / evidence | Branch / PR / commit | Status |
| --- | --- | --- | --- | --- |
| 2026-10-28 | Research baseline | GKD, OSM/DEM, existing importer and round files investigated; plan established. **No implementation tasks claimed complete.** | `web-alpha-mishits` / this document | Research complete; engineering pending |

### Handoff for a new chat

Open this document, read the unchecked items and latest change log, verify the current branch and related PR status, then work only on the **next unmet milestone gate**. Preserve current working runtime and update checkboxes/commit links in the same change as completed code. Start with **M0** followed by **M1**; do not launch large course imports or start unrelated visualizations.
