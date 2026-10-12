# The Looper — Windows Companion / Native AutoAim execution plan (V2)

**Updated:** 2026-10-11 (post Greywolf H8/H9 first simulator test)  
**Status:** implementation plan / authoritative new-chat handoff; **not** a production release or approval to click.  
**Working branch:** `auto-aim-windows-companion-v1` in `bpgpitt10/nova-v0`.  
**Current tested package:** prerelease `looper-companion-autoaim-stage-c-5543b4f4`, build from `5543b4f4` (Windows CI passed; native simulator proof limited to read-only).  
**Most recent implementation pass:** `f434685a5fd6c06d1a0a42ab6b801410e2b2809c` (diagnostic-only/version contract fix; Windows and web CI passed). Keep this plan updated as development progresses.  
**Production/main:** do **not** merge or deploy the experimental native-input path before the specific acceptance gates below.

## Incremental implementation log — 2026-10-11 (V2 small pass #1)

**Purpose:** fix one real integration blocker from the first sim test while deliberately avoiding a second Live Caddie shot-state engine. This is a **contract/UI hardening pass**, not a full replacement of native diagnostics or OCR repair.

- [x] Fix `/companion/v1/observations` to include `version`, which the existing `getCompanionReadOnly()` browser transport already requires. Previously the native diagnostic HTML could read this endpoint while the Live Caddie client rejected it before consuming wind/lie observations.
- [x] Explicit `stateAuthority: "diagnostic-only"` contract in the endpoint and TypeScript consumer. Structured records are never dispatched as authoritative current ball/tee/hole; the existing `browserGsproCourseStateCore.ts` remains untouched.
- [x] Change the diagnostic card from misleading "GSPro ball world" to **shot-record evidence**; display `StartingPOS` only for an observed `CurrentShot`, and `EndingPOS` for a `last_completed` record with a prominent previous-hole warning. Does not invent a next tee or "current" ball in Python.
- [x] Add Python/HTTP tests for the version and diagnostic-only invariants, previous-shot labeling, and retained origin/host/POST protection.
- [x] **CI passed on implementation commit `f434685a`:** [Web Alpha CI](https://github.com/bpgpitt10/nova-v0/actions/runs/38197311740) and [Windows Companion build, native contract tests and packaged EXE smoke test](https://github.com/bpgpitt10/nova-v0/actions/runs/38197311877) both succeeded. The branch-only [Windows ZIP prerelease](https://github.com/bpgpitt10/nova-v0/releases/tag/looper-companion-autoaim-stage-c-f434685a) was published; **do not reinstall for this contract-only fix**, wait for the consolidated OCR/capture validation build. Physical OCR remains unverified/unfixed.
- [ ] Further native file-evidence transport through the **existing JS parsers** remains future work; we have intentionally NOT ported hole-transition logic to Python.
- [ ] Wind/lie OCR from verified GSPro HWND in-memory pixels, waypoint label OCR, zoom registration and paired one-click AutoAim are **not changed in this pass**. No production deployment/merge and no simulator reinstall requested.

**Next smallest sensible pass after CI:** one native OCR/HWND capture repair with an isolated Windows test fixture (prefer wind first), without touching shot-state ownership or activating mouse input. A separate future pass addresses file evidence/transport parity for removing the browser folder picker. Avoid conflating these workstreams.

## Read this first: immutable architectural boundaries

**Do NOT duplicate or replace Live Caddie's already functioning shot-state engine.** The user expressly confirmed that Live Caddie correctly tracks the ball and transitions from a completed putt/hole to the **next tee**, even if `currentRound.dat` is temporarily stale. The first Windows diagnostic showed H8 on the H9 tee because it used a NEW simplistic Python interpretation — **not** because Live Caddie needs that logic rebuilt.

| Authority | What it owns | What it does NOT own |
| --- | --- | --- |
| **Existing Live Caddie state engine** (TypeScript, browser) | Course/round/shot identity; physical shot records; starting and ending ball positions; inferred current ball in Looper local coordinates; surface; stale-file quarantine; terminal/gimme/holed-out detection; hole advancement and tee reset; sourced geometry/pin confidence | Desktop mouse clicks; minimap image pixel locations |
| **Existing Looper recommender** | Suggested club or under-range Shot Strategy, target `CoursePointYds`, hazard/elevation/wind/lie constraints, target revision. Must distinguish evaluated full-shot vs uncalibrated short-shot strategy | Operating system input; raw GSPro HWND/screen pixels |
| **Windows Companion EXE** | Find GSPro process/window/files; capture *specific GSPro window*; native HUD wind/lie OCR; detect live minimap player/pin/waypoint/accepted-target pixels; scale/zoom registration; verify authorized browser-intended target against **trusted shared coordinate frame**; perform **one explicit native click** and verify the changed magenta accepted aim | Decide the playing shot, infer next tee by replacing Live Caddie, invent hazard advice, or equate raw GSPro-world X/Z with OSM by assumption |

The EXE may **independently recheck minimal fresh file/window/shot facts for click safety** (freshness, same course/round/hole/shot identity, unchanged window, tee vs green), but this is a *fail-closed guard*, **not** a second game-state engine. If Looper and physical GSPro do not agree, DO NOT CLICK. The browser's `Tap to Arm` club UI alone is NOT consent to move the mouse: require a distinct, deliberate **Set Aim** action.

### Source of truth — reuse, do not rewrite

- `src/adapters/browserGsproCourseStateCore.ts`: `buildSnapshot` interprets completed `StartingPOS`/`EndingPOS`, `CurrentShot`, shot lineage, `output_log.txt currentHole`, `AllPlayersHoledOut`, `isHoled`/`isGimme`; uses a **cached tee** if the hole advanced while `currentRound.dat` still shows the completed previous hole. In particular inspect its `buildSnapshot` branch around lines 509–706. It already publishes `ballLocalYds` as latest shot END point when on a current playable hole.
- `src/adapters/browserGsproCourseState.ts`: wraps that core, reconciles `preShotStart` against supported tees and selected course, exact-pin attempts, manual-start stale-shot quarantine; dispatches `LIVE_CADDIE_SHOT_STATE_CHANGED_EVENT`.
- `src/adapters/gsproStartingPosition.ts`, `src/adapters/gsproCourseLayoutPin.ts`, `src/liveCaddie/roundRuntime.ts`, `src/liveCaddie/roundTeeValidator.ts`: existing state-related helpers and validation.
- `src/pages/LiveCaddiePage.tsx` and `src/pages/LiveCaddieWorker.ts`: existing player-state and recommendation/target UI and computation.
- `src/adapters/looperCompanionAim.ts`: already has a **READ-ONLY**, `nativeInputAuthorized:false`, `looper-hole-local-yards-unverified` intent. DO NOT bypass its warnings to issue a click.
- `helpers/gspro_minimap_pipeline.py`, `helpers/gspro_minimap_markers.py`, `helpers/auto_aim_transform.py`, `helpers/minimap_registration.py`, `helpers/gspro_direct_click.py`, `helpers/waypoint_scale.py`, `helpers/waypoint_scale_cv.py`: existing native capture/transform/detection/safety/registration proof; reuse, don't create a parallel click geometry pipeline.
- `docs/companion-native-aim-pairing-v1.md`: existing **security design** for explicit native pairing/session authorization, bounded nonce/request/shot. **Still relevant and mandatory before enabling POST.**
- `docs/shot-strategy-windows-companion-merge-plan.md`: existing **separate cross-branch Shot Strategy integration plan** (partial shots). Still relevant, but **NOT** the overall native companion roadmap. Keep strategy and companion branches separate until narrow manual reconciliation.
- `docs/auto-aim-windows-companion-v1.md`: long-form original architecture and Stage A–E history. This V2 document is the current priority/order/acceptance handoff. Keep historical test findings rather than trying to merge their different stage labels.

## Current reality after the FIRST physical simulator test

**Platform:** Windows, GSPro running on one monitor at 3840×2160 and negative display X; Chrome was in foreground.  
**Golf:** Greywolf H8 par 4 tee → after drive → H9 par 3 tee → after tee shot.  
**Evidence:** four user-exported `looper-native-observations-2026-10-12T...json` diagnostic snapshots plus GSPro screenshots were reviewed in the conversation. They are **not checked into GitHub** (may contain locally identifying metadata). See timestamps 02:20:10Z, 02:24:07Z, 02:26:15Z; two 02:24-era exports contain identical payloads. The latest H9 output is the most useful comparative fixture.

| Component | Real observed result | Accurate interpretation |
| --- | --- | --- |
| Local installation, Chrome→127.0.0.1 bridge, process + folder discovery | PASS; correct GSPro PID, `currentRound.dat`/`output_log.txt`/`GSPro.db` present | Installation/diagnostic read-only bridge works on this PC |
| Nonblank `PrintWindow` capture while Chrome in foreground | PASS on H8/H9 and negative-X 4K window | Pixels appear live; still need independent native ROI freshness/click/monitor verification |
| Minimap player/pin detection | Coordinates produced: H8 ~ (280,850) ball / (280,173) pin; H9 approach ~ (279,600) ball / (279,427) pin | Matches broad red player/white pin arrangement shown in screenshots, but exact detector error and dynamic zoom still require quantitative proof |
| World shot records | Fresh records after shot; H9 `StartingPOS`→`EndingPOS` 3D length ~146.3yd vs GSPro displayed 146.3 total; `DistanceToPin` 16.94yd vs on-screen 16.9 | GSPro structured data is real, useful, reliable **for completed shots**; native diagnostic selected `last_completed`, not current ball when new tee loaded |
| H8→H9 hole transition | New Python diagnostic stayed on old completed H8 shot while screen showed H9 tee | **Diagnostic-only duplicate parser deficiency. Existing Live Caddie has already-solved handoff/tee reset** |
| GSPro world tee/pin layout | `course_layout_not_found` throughout | Current new Python search assumptions/last-N-MB limitations, **not proof GSPro layout unavailable**; existing TypeScript `gsproCourseLayoutPin.ts` has balanced-array parser and match guard |
| Windows native wind OCR | UNAVAILABLE: PowerShell `You cannot call a method on a null-valued expression.` | Repair async WinRT OCR call or replace with supported native OCR path; current `CopyFromScreen` may capture Chrome rather than GSPro when backgrounded |
| Lie OCR | UNAVAILABLE: no usable candidates | Same screen-copy concern, ROI/resolution/WinRT readiness; H9 on-screen 0.0 UP/RIGHT at tee, 2.9 DOWN/0.9 RIGHT after shot |
| Scale and world→OSM | UNAVAILABLE | Current diagnostic gates on simplistic `pre_shot` + layout; coordinate frame and non-par-3 waypoint reading not independently verified |
| Desktop aim click | **NOT IMPLEMENTED/ENABLED in current branch**; `POST /companion/*` HTTP 405 | Do not confuse successful read-only image capture with AutoAim readiness |

### Known technical debt introduced in Stage D, to correct rather than extend

`helpers/gspro_live_observations.py` contains `parse_current_round()` and `parse_course_layout()` implemented independently of existing TypeScript logic. They were written solely to populate new diagnostic cards, and should **not** be promoted to the Live Caddie state source. Keep/label as legacy diagnostic only until a shared evidence reader replaces that interpretation. Some raw numeric surface information and old shot coordinates were erroneously presented as live ball state. Diagnostic page should show **"last completed shot"** vs **"current ball"** clearly, or source current state from the established engine.

`src/adapters/looperCompanion.ts` currently allows an **opt-in native wind/lie poller**; `src/pages/LiveCaddiePage.tsx` still uses the existing browser state watcher and Chrome visual capture by default. The branch preview is research-only. `nativeCapture:false` is intentionally conservative: proven on-demand PrintWindow diagnosis is not the same as reliable always-on native capture. Never rewrite live state simply because this companion diagnostic file uses stale records.

## Forward work — order and acceptance gates

### Step 1. Tighten architecture, retire duplicate diagnostics as authority **(NEXT CODE PASS)**

**Goal:** keep ONE canonical shot-state engine, make EXE a data/capture/actuation adapter.

- Preserve `buildSnapshot`/`enrichSnapshotWithStartingPosition` and the current `LIVE_CADDIE_SHOT_STATE_CHANGED_EVENT` contract. Add no new Python tee transitions or post-putt state machine.
- If native file access is to replace Chrome's folder picker in future, implement a **small read-only file-evidence transport**: native sends bounded raw `currentRound.dat` and required `output_log.txt` excerpt with source freshness/round identity, to the SAME existing TypeScript parsers (or a shared normalized envelope produced from them). **Do not independently compute `holeNumber`, `nextShotNumber`, `ballLocalYds` in Python**. Keep browser folder route as fallback until end-to-end parity tests. Secure loopback and minimize/exclude private records; no cloud upload.
- Eliminate or quarantine `helpers/gspro_live_observations.py`'s competing shot/hole interpretation from Live Caddie wiring; its simple Python interpretation can remain *explicitly diagnostic only* while transitioning. Fix dashboard labels so `last_completed StartingPOS` is never called "current ball".
- Replay same saved physical shot and hole-transition fixtures through existing state engine and both file transports; assert **identical** hole, shot number, current ball coordinate/source, pin/source, surface, and next-tee behavior; no regressions to manual round-start quarantine.

**Gate:** automatic next-tee after holed-out/gimme, stale previous hole, no completed shots, first tee, fairway second shot, mulligan/restart, no new duplicate runtime ownership.

### Step 2. Repair the native **visual observation layer**

- Continue using the verified GSPro HWND `PrintWindow` pixels (and WGC HWND backend **only if** freshness or capture quality fails). **Feed native wind and lie OCR from those in-memory GSPro pixels**, not Windows desktop `CopyFromScreen` while Chrome has focus.
- Diagnose/fix `$getAwaiterBaseMethod` null WinRT async invocation in `helpers/open_golf_coach_helper.py` and `helpers/open_golf_coach_helper_lie_footer.py`; or use a packaged reliable Windows OCR alternative. Tests must include 3840×2160, negative display X, Chrome foreground, GSPro not foreground, unreadable HUD and the lie footer on different surfaces. Keep user-visible OCR provenance and fail-closed status.
- Reuse `gspro_minimap_markers.py` with actual player marker **red** (not magenta aim), **white pin**, gray waypoint references, distinct **magenta accepted target**. Quantitatively test the ROI and marker center tolerance against H8/H9 and fresh screenshots, not only plausible vertical ordering.
- Cache an authoritative tee-frame calibration when evidence exists; register after-shot zoom/pan using existing `minimap_registration.py`. Demonstrate changed scale/registration when H9 tee shifts to ~17yd approach. Never assume constant yards/pixel or confuse pinned pixel position with actual same world position.
- Par-3 direct ball-to-pin scaling is a **conditional reference** (valid live ball/pin and direct distance verified). On par-4/5, use the existing **gray waypoint yardage OCR** or equivalent independently validated ruler. The Tesseract prototype `waypoint_scale_cv.py` is not bundled by default. No hole-scorecard routed-yardage/pixel fallback for doglegs.
- Expose explicit confidence statuses: `unavailable`, `detected_unverified`, `scale_verified`, `registered_verified`; accompany pixels, source, age, confidence, independent check error. Do not exaggerate confidence on a single frame.

**Gate:** background/foreground fresh pixels, correct OCR values vs screenshot, marker tracking across tee/fairway/rough, reliable scale/zoom registration with reproducible independent error metrics. No native clicking yet.

### Step 3. Verify browser recommendation target and native GSPro coordinate equivalence

- Receive the **existing** Live Caddie/recommender target; do not recompute the aim inside the EXE.
- Define a typed **aim intent** with `kind: evaluated-shot | shot-strategy`, `courseId`, `roundId`, `holeNumber`, `nextShotNumber`, immutable `shotReference`, `recommendationRevision`, `club` when truly recommended, `targetLocalYds`, coordinate-frame ID/transform provenance, and pinned `tee`/`pin` anchors. Do not describe uncalibrated partial-shot strategy as a club recommendation.
- Current `prepareReadOnlyNativeAimIntent` intentionally labels its coordinates `looper-hole-local-yards-unverified`. **Never** reinterpret course-local XY as GSPro-world X/Z or pixels. Establish and independently test per-hole GSPro↔course registered anchors (tee/pin length/direction; pin can move within green). Greywolf validated geometry is the control; imported courses with incomplete tees need separate confidence gates (see separate importer research branch), **not** a forced 18/18 prerequisite.
- Native pixel transform requires a fresh correctly calibrated canonical minimap frame and valid zoom registration. If geometry, current ball, shot identity, or coordinate frame uncertain, show **Manual aim required**; keep the rest of Live Caddie operational.
- Test preview-only target positions on known Greywolf H8/H13 lab fixtures and physical holes. Confirm native predicted click coordinates match target **in yards** and stay within minimap before any actuator is reachable.

**Gate:** a complete request/response contract for course-local↔GSPro-world↔minimap frame with independently verified accuracy; *preview-only*, zero mouse input.

### Step 4. Pair and enable the one native click with mandatory verification

- Implement `docs/companion-native-aim-pairing-v1.md`: companion-local user-present pairing (not Origin-only), scoped per-tab expiring token, cryptographic challenge/nonce, exact Origin, strict loopback, browser permission, short-lived shot/revision identity, request idempotency, runtime freshness. All native write/input routes disabled without pairing + explicit per-shot **Set Aim**.
- Native rechecks selected GSPro PID/HWND, per-monitor DPI, foreground/focus transition policy, current shot identity, current frame age, calibration, pin registration, expected aim target, unsupported green/putt, exact user intent. Must perform **one bounded native minimap click**, no L/R pulses, no unverified background click assumption.
- Capture **new** GSPro frame afterward; detect **new magenta accepted marker** (not red player or stale target); independently measure target error in yards; report success only if <=3yd and shot identity unchanged. On failure: no silent retry, no click to compensate, explicit manual aim fallback.
- Test initially on Greywolf H8 with user-present, low-risk target, compare actual GSPro display. No writing GSPro files. No remote cloud cursor-control route.

**Gate:** 3+ controlled physical accepted-marker confirmations under <=3 yd error and zero unexpected clicks; additional green/stale/zoom/shift/restart tests.

### Step 5. Integrate UI and strategy, then package beta (AFTER native gate)

- Live Caddie selects target; explicit Set Aim button sends *one* intention, shows `SETTING GSPRO AIM`, then `AIM SET` only on independently verified PASS; otherwise `MANUAL AIM` with reason. Reset on club/shot/target/hole change.
- Reconcile `live-caddie-shot-strategy-v1` manually using `docs/shot-strategy-windows-companion-merge-plan.md`; avoid wholesale merge of legacy Tauri experiments. Shorter-than-calibrated-shot strategy may have a tactical aim point **without** a named calibrated club. No predicted success % or fake dispersion.
- Browser-read-only Live Caddie and Chrome fallback continue working if companion absent/blocked. Full/partial confidence logic for imported holes is a separate course-importer workstream; integrate only via explicit validity gates.
- Final production acceptance: stage preview, security tests, user-consented actual sim tests, robust Win10/11, 1080p/4K, DPI/multiple monitors, GSPro restart, new course/hole/pin, minimap zoom, install/autostart/uninstall, browser permissions; THEN consider release/merge.

## The very next implementation task (not another 18-hole study)

**First coding pass should address Step 1 + a narrow slice of Step 2:**

1. Make `last_completed` diagnostic shot labels explicitly **not current ball/hole**, reuse the existing JS state engine for authoritative current state. Extract a small native `GSPro file evidence` reader so the EXISTING JS parser can consume it rather than independently porting the shot state. Keep any raw file evidence strictly local, bounded, and read-only; no screenshots/cloud uploads.
2. Refactor Windows wind/lie OCR to consume verified in-memory GSPro window capture, fixing the observed PowerShell WinRT/null async issue; add Windows CI assertions and local evidence fixtures.
3. Expose image ROI and scaling/registration confidence in the read-only dashboard, using the already packaged CV code. Preserve `POST /companion/*` 405 and `autoAim:false`.
4. Publish one isolated Windows ZIP and **one** matching Vercel branch preview after all tests pass; avoid repeated simulator installs for every small change. Next physical test = capture/OCR/tee→fairway accuracy plus preview-only target placement, NOT a live native click.

This is NOT a request to restart AutoAim work or build another desktop application: extend the **existing** `LooperCompanion.exe` installer/autostart system only. Don't change main/production or course importer work in this pass.

## Links and existing artifacts

- Long-form historical architecture: [`docs/auto-aim-windows-companion-v1.md`](./auto-aim-windows-companion-v1.md)
- Security: [`docs/companion-native-aim-pairing-v1.md`](./companion-native-aim-pairing-v1.md)
- Partial/under-range integration: [`docs/shot-strategy-windows-companion-merge-plan.md`](./shot-strategy-windows-companion-merge-plan.md)
- Standalone debug dashboard: `public/dev/companion-observations.html`
- Read-only GSPro EXE: `helpers/looper_companion.py`, `helpers/gspro_live_observations.py`
- Native image/registration/click proof: `helpers/gspro_minimap_pipeline.py`, `helpers/gspro_direct_click.py`
- Windows CI build: `.github/workflows/build-looper-companion-windows.yml`
- First real-PC passing prerelease: https://github.com/bpgpitt10/nova-v0/releases/tag/looper-companion-autoaim-stage-c-5543b4f4
- Successful Windows CI run for package: https://github.com/bpgpitt10/nova-v0/actions/runs/38191039860
- Preview from first test: https://looper-80boi0fa0-wqk25hkxcg-3591.vercel.app/dev/companion-observations.html
- Other independent course geometry/OSM study branch: `web-course-e2e-preflight-v1`, with separate course-confidence research. Don't merge its importer changes as a prerequisite to next native observation pass.

## Copy into a new chat to resume

> Continue The Looper's Windows Companion / native AutoAim work in `bpgpitt10/nova-v0`. **FIRST read `docs/windows-companion-autoaim-execution-plan-v2.md` on branch `auto-aim-windows-companion-v1`** and cross-check `docs/auto-aim-windows-companion-v1.md`, `docs/companion-native-aim-pairing-v1.md`, and `docs/shot-strategy-windows-companion-merge-plan.md`. We have ALREADY solved ball-position tracking, tee initialization, holed-out hole transition, and stale GSPro file reconciliation in TypeScript Live Caddie. DO NOT port or duplicate that state machine in the Windows EXE. EXE must do native GSPro capture, OCR, minimap scale/registration, **one secured explicit Set Aim click**, and post-click verification; recommender chooses target. The first real Greywolf H8/H9 session proved HWND capture and real shot data but Windows wind/lie OCR failed, layout/scale diagnostics unavailable, and the Python diagnostic misleadingly showed prior completed shot/hole. Next code pass: preserve JS state engine, fix native OCR using GSPro window pixels, build read-only evidence integration/parity, refine pixel calibration and confidence. Keep native input OFF, no production merge/deploy, publish ONE development test package only after CI. Report what changed, tests, and what's still sim-gated.

