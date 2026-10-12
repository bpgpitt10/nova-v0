# The Looper — Windows Companion / Native AutoAim execution plan (V2)

**Updated:** 2026-10-12 (pass #8: authoritative Live Caddie bridge, read-only recommendation pixel preview, per-stage native timings)  
**Status:** implementation plan / authoritative new-chat handoff; **not** a production release or approval to click.  
**Working branch:** `auto-aim-windows-companion-v1` in `bpgpitt10/nova-v0`.  
**Current latest CI-tested package:** Pass #8 native read-only integration prerelease [`looper-companion-autoaim-stage-c-6cb09a05`](https://github.com/bpgpitt10/nova-v0/releases/tag/looper-companion-autoaim-stage-c-6cb09a05), ~105 MB ZIP with the pinned Tesseract bundle. [Windows tests + packaged EXE smoke + ZIP publication PASS](https://github.com/bpgpitt10/nova-v0/actions/runs/38205307790); [Web Alpha / H8-H13 read-only-preview CI PASS](https://github.com/bpgpitt10/nova-v0/actions/runs/38205307788). [Latest documentation commit web CI PASS](https://github.com/bpgpitt10/nova-v0/actions/runs/38205378136). Native wind/lie are physically validated; new waypoint, zoom and recommendation pixel preview still require simulator verification.  
**Most recent implementation:** pass #8 adds canonical Live Caddie shot reconciliation, a guarded non-clickable minimap aim candidate, a schematic preview, native per-stage timing metrics, and a pinned physically tested portable OCR dependency. Web fixture tests, Python tests, Windows packaged smoke and branch-only preview **PASSED**; actual physical pixel alignment is the next acceptance gate. No native input authorization, no POST, no production merge.  
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

## Incremental implementation log — 2026-10-11 (V2 small pass #2: Wind native OCR)

**Scope: wind ONLY.** The user asked to repair wind OCR without restarting the Live Caddie shot/ball/tee state work. This commit refactors only the local visual-adapter flow. No AutoAim POST, mouse input, course loader, or production changes.

- [x] Added `helpers/gspro_native_wind_ocr.py`: extracts the *GSPro HWND* top-center 36%×16% image from the existing read-only PrintWindow capture, doubles resolution for small HUD text, uses Windows OCR on a temporary **HUD-only** PNG, removes it in `finally`, and passes text through the pre-existing `parse_wind_ocr_text`. No Tesseract bundle, no screenshot/full-frame response, and no Chrome desktop `CopyFromScreen` wind fallback.
- [x] Replaced the defective `GetAwaiter` PowerShell reflection path for *new native wind only* with `System.WindowsRuntimeSystemExtensions.AsTask(IAsyncOperation<T>)`, selecting a generic overload explicitly and returning a meaningful failure reason if unavailable. **Requires real sim-PC validation**; Windows CI proves runtime packaging but cannot guarantee GSPro HUD or user-profile OCR languages.
- [x] Reused **one** GSPro native frame for minimap CV and native wind in `collect_observations`; `/wind` on **LooperCompanion.exe** now uses the same HWND-based wind OCR instead of the legacy screen-copy path. The standalone legacy helper (outside this companion) is untouched.
- [x] Kept current OCR wind schema (`READY/UNKNOWN/UNAVAILABLE`, speed/direction, compass-toward semantics) with `ocrSource: gspro-native-window` and explicitly unverified capture freshness. No guessed values or click authorization.
- [x] Lie reader remains legacy and **unfixed**. Live Caddie remains exclusive authority for ball, hole and shot state; no Python tee transitions or new state parsing in this pass.
- [x] **Build / integration CI passed** for implementation commit `fd6c6f855564e75dea1a1a2b1c75a6f2bf4c6feb`: [Windows companion tests, executable build and packaged smoke test](https://github.com/bpgpitt10/nova-v0/actions/runs/38197689399) and [Web Alpha build](https://github.com/bpgpitt10/nova-v0/actions/runs/38197689558). Development-only ZIP published at [release `looper-companion-autoaim-stage-c-fd6c6f85`](https://github.com/bpgpitt10/nova-v0/releases/tag/looper-companion-autoaim-stage-c-fd6c6f85). Tests use mocked OCR text/frame; **not proof of real GSPro OCR text on the Windows simulator**. No sim reinstall necessary until a consolidated visual test is requested.
- [ ] Next real-PC test when convenient: Greywolf wind HUD showing e.g. `8 MPH W`, with Chrome in foreground, compare companion `/wind` and `/observations`, plus changed wind values. No need to hit a shot. If WinRT OCR fails with a named error, use the precise error from the JSON; do not guess the reading.

**Completed in pass #3:** lie footer OCR is now fed from the same native GSPro HWND capture. Real simulator validation for BOTH OCR readers still pending; independently validate minimap scaling/registration before turning on any click.

## Incremental implementation log — 2026-10-11 (V2 small pass #3: Lie native OCR)

**Scope: lie ONLY**, matching the wind native observation architecture. No shot-state ownership change, minimap registration, POST input or production merge.

- [x] Added `helpers/gspro_native_lie_ocr.py` using the **same GSPro HWND image** as minimap and wind. It crops the established right/left lie footer ROIs in *window-relative coordinates*, splits the overlapping 56%/44% longitudinal/lateral areas, enlarges 4× and uses the repaired WinRT `AsTask` OCR bridge from native wind. No desktop `CopyFromScreen`.
- [x] Preserved existing one-decimal signed lie parsing (`+UP/-DOWN`, `+RIGHT/-LEFT`), `READY/UNKNOWN/UNAVAILABLE` status and event-compatible payload, with native source attribution and unverified single-frame freshness.
- [x] Migrated BOTH `/lie` and `/companion/v1/observations` to native GSPro-window lie OCR; the observation route shares its one captured frame across minimap/wind/lie.
- [x] Added `tests/test_gspro_companion_lie.py` covering window-relative crops, flat tee, DOWN/RIGHT, incomplete and failed OCR. Added native lie module to Windows companion workflow trigger.
- [ ] Windows CI and packaged EXE smoke outcome: **check current GitHub Actions run**. Passing mock tests do not prove actual simulator recognition.
- [ ] Real simulator test: compare `/lie` with visible GSPro footer on flat tee and non-flat lie (e.g. 2.9 DOWN/0.9 RIGHT) with Chrome in foreground and GSPro background. Confirm changed values and capture freshness; use failure notes rather than guessing.

**Next work after combined wind/lie sim proof:** **wind parity repair in pass #4 is required first**. Then minimap marker accuracy, waypoint scaling and zoom registration in read-only mode. Keep desktop clicks disabled. Separate native file-evidence transport/parity from the visual-layer test; do not replace the existing Live Caddie state machine.

## Incremental implementation log — 2026-10-11 (V2 small pass #4: Restore wind OCR parity)

**Reason:** The first physical sim test after Lie OCR showed successful native GSPro background capture and lie (0.0 UP / 0.0 RIGHT), but native wind was UNKNOWN with raw "IO MPH", no cardinal. This is a regression against the *previously validated browser wind implementation*, not evidence that GSPro lacks wind data.

**Root cause identified in source:** \`src/adapters/browserGsproVisualCapture.ts\` uses two tightly bounded crops (speed x .444/y .011/w .033/h .026; direction x .532/y .011/w .020/h .026), 8× enlargement and luminance threshold 190 with separately recognized compass tokens. The new \`helpers/gspro_native_wind_ocr.py\` instead read a giant top-center 36%×16% region with 2× enlargement, asking WinRT to recognize both values together. Direction was not found. The established browser producer also emits compass wind as **from**; the new native producer had reported **toward**, although the TypeScript adapter normalized compass wind back to **from**.

- [x] Restore the two proven **browser** crop coordinates, 8× scaling and thresholded black-on-white images in the **native HWND-only** reader. Preserve one shared \`PrintWindow\` frame for wind/lie/minimap, no \`CopyFromScreen\` and no desktop or screenshot transmission.
- [x] OCR **speed and direction independently** using the packaged WinRT OCR bridge; keep status UNKNOWN unless an independently recognized valid direction is available for nonzero wind. Keep calm (0 MPH) consistent with browser behavior.
- [x] Add narrowly scoped speed-token cleanup for observed \`IO MPH\` → 10, but **never infer direction** or silently return READY from the numeric guess alone. Align produced compass convention to **from**, consistent with browser.
- [x] Update Windows tests for dual crops, 3840×2160 pixel coordinates, source-only binary preprocessing, nonzero missing direction, ambiguous/noisy OCR and the actual \`IO MPH\` trace; ensure read-only shared frame contract includes native lie.
- [x] Windows build, 4K crop/unit contract tests, packaged EXE smoke and Web Alpha CI passed for implementation/test commit `02a3f44c`: [Windows Companion CI](https://github.com/bpgpitt10/nova-v0/actions/runs/38200263011) and [Web Alpha CI](https://github.com/bpgpitt10/nova-v0/actions/runs/38200263004). Single [read-only test ZIP](https://github.com/bpgpitt10/nova-v0/releases/tag/looper-companion-autoaim-stage-c-02a3f44c) published. Earlier intermediate Windows CI failures were an outdated test expecting one broad crop; updated split-crop assertions passed on this build.
- [ ] **Simulator gate (required):** screenshot-compare both raw \`SPEED: … | DIR: …\` fields and parsed wind against actual GSPro HUD for multiple different wind settings, with Chrome foreground / GSPro background. Confirm real compass direction and speed reliably; do not equate mocked WinRT results with production OCR reliability.

**Important testing limit:** the 33-image GSPro browser OCR corpus is documented at \`tools/ocr_corpus_reference_v1.json\`, but the image bytes are not included in this branch. The browser uses Tesseract.js, whereas the native EXE uses Windows WinRT OCR: geometry/preprocessing are restored, but **actual engine parity remains a physical-simulator acceptance requirement**. Do not claim 33/33 parity from unit tests. Keep native AutoAim POST/mouse input disabled, no production merge/deploy.

**Next:** once physical wind and lie pass, advance to read-only minimap marker accuracy and scaling/zoom registration. Native file evidence parity remains separate and must reuse the existing TypeScript Live Caddie state engine.

## Incremental implementation log — 2026-10-11 (V2 small pass #5: WinRT direction-context fallback)

**Real simulator finding:** After pass #4's restored browser-proven image geometry, the *installed updated companion* correctly identified \`SPEED: 9 MPH\` but returned \`DIR: \` (blank) and wind UNKNOWN. This confirms 9 MPH recognition is fixed; the Windows WinRT OCR backend is still failing to recognize the **isolated compass glyph**. The browser Tesseract.js code used explicit single-glyph page segmentation (mode 8), which WinRT OCR does not expose. Do not rework current Live Caddie wind math or speculate which direction was displayed.

- [x] Added a **bounded, conditional** native WinRT OCR retry: only when the independent speed crop is recognized and direction is missing, stitch the two existing preprocessed GSPro HUD regions into one line with a short white gap, for OCR context. This uses the **same** GSPro HWND capture, no desktop capture, no extra HUD pixels, and no remote screenshots.
- [x] Restrict fallback recognition to an actual \`MPH <cardinal>\` token on the stitched line; otherwise leave wind \`UNKNOWN\`. Record \`directionOcrStrategy\` and \`directionFallbackRawText\` (text only) to diagnose the next simulator result. Do **not** guess compass direction or treat 9 MPH alone as ready.
- [x] Added tests for recovered \`9 MPH NW\`, blank single-glyph + blank combined glyph, corrupt OCR, three-call fallback behavior and protected \`READY\`/UNKNOWN boundary.
- [x] Windows tests, EXE build, packaged smoke and prerelease publication **PASSED** for `0b3ec91b`: [Windows Companion CI](https://github.com/bpgpitt10/nova-v0/actions/runs/38200784335), [Web Alpha CI](https://github.com/bpgpitt10/nova-v0/actions/runs/38200784264). [Isolated read-only Windows ZIP](https://github.com/bpgpitt10/nova-v0/releases/tag/looper-companion-autoaim-stage-c-0b3ec91b) published; install this rather than the older 02a3f44c package for the composite fallback.
- [ ] **Physical simulator proof required.** Validate nonzero speed and cardinal with Chrome in front at multiple wind headings. The composite WinRT fallback is an unverified hypothesis, not established Tesseract parity. If it still returns no cardinal, stop tinkering with speed; diagnose/replace the **direction OCR backend** (e.g. existing Tesseract.js path) using a real user-approved wind-crop fixture. Continue fail-closed and keep native clicks off.

**Next gate:** wind speed + cardinal, lie, read-only image capture passing on simulator; then minimap/zoom registration. No production deployment/merge.

## Incremental implementation log — 2026-10-11 (V2 pass #6: Native Tesseract wind, no screen sharing)

**Architectural decision:** Stop iterating Windows WinRT OCR for wind. Keep GSPro-window-only PrintWindow capture, but replace wind text recognition with packaged native Tesseract 5 CLI, following the working browser Tesseract.js crop/threshold/segmentation approach. Chrome screen sharing is **not required**, and no extra Tesseract installation should be needed on the simulator PC.

**Evidence:** User screenshot shows 9 MPH NW on Greywolf hole 8 while the latest native WinRT reader returned SPEED: 9 MPH | DIR: (empty). Locally tested Tesseract CLI on the user-provided 2048×1176 screenshot: NW recognized using the existing direction ROI, 8x enlargement, threshold 190 and PSM 8, 7, 10. The original narrow speed ROI clipped the digit at that screenshot scale; a slightly wider fallback recognized 9MPH. These are **one-screenshot** results, not 33-image or physical live validation.

- [x] Wind reader now uses standalone packaged Tesseract CLI over native GSPro HWND crops (speed PSM7, direction PSM8 then PSM7/10 if missing) and browser-style 8x/threshold-190 preprocessing. Retains reference speed crop first, with a bounded expanded left crop only when needed.
- [x] Conservative status: no nonzero READY wind without both parsed speed and independently recognized valid compass direction. Compass "from" contract retained. Temporary cropped PNGs are deleted; no browser screen share, user desktop screenshot, or remote pixels.
- [x] Preserve already working native WinRT lie reader and its call into the legacy WinRT helper in the wind module. Do not replace lie logic because wind's backend changed.
- [x] Windows workflow provisions Tesseract on CI runner, validates executable/English language, ships portable bin/DLLs plus eng.traineddata in the Windows ZIP. Installer copies the OCR folder next to LooperCompanion.exe into the user's local app directory; **no admin rights or separate OCR installer required on user's PC**.
- [x] Regression tests revised for Tesseract segmentation modes, missing direction fail-closed, no bundled OCR availability, speed crop fallback, and 9 MPH NW recovery.
- [x] **CI and release gate passed:** [Windows CI](https://github.com/bpgpitt10/nova-v0/actions/runs/38201627321) and [Web Alpha CI](https://github.com/bpgpitt10/nova-v0/actions/runs/38201627371) succeeded on commit `d11eb7ad`: portable binary/English-data availability, Windows unit tests, packaged EXE smoke, ZIP assembly, [published Tesseract ZIP](https://github.com/bpgpitt10/nova-v0/releases/download/looper-companion-autoaim-stage-c-d11eb7ad/looper-windows-companion.zip) (~105 MB). This establishes packaging health, **NOT** live on-screen OCR parity.
- [ ] **Simulator acceptance gate:** test 2+ nonzero wind headings including NW, confirm speed, FROM-cardinal, READY, and stable lie with Chrome foreground and GSPro background. Confirm real OCR provenance is tesseract-cli, not WinRT. Do not infer success from CI alone.

**Next work:** once native Tesseract wind and unchanged Lie pass, continue read-only minimap scale, waypoint/zoom registration. Do not merge to main, enable POST/AutoAim click, or rebuild the existing authoritative TypeScript Live Caddie shot/tee engine.

## Simulator acceptance evidence — 2026-10-12 (OCR working; move to minimap)

**User confirmation:** After installing the Tesseract companion, both wind and lie read correctly on the real GSPro simulator. Exported diagnostic `looper-native-observations-2026-10-12T04-02-58-721Z.json` (04:02:52Z observation) confirms the new path without Chrome window sharing. GSPro was `connected`, **not foreground**, with a 3840×2160 HWND on a display whose X origin is -3840; native capture used `PrintWindow` and returned nonblank pixels.

- [x] **Wind** `READY`, **2 MPH from W (270°)**, raw `SPEED: 2 MPH | DIR: W`; `ocrSource: gspro-native-tesseract`, `ocrEngine: tesseract-cli`, `speedOcrStrategy: reference-crop`, `directionOcrStrategy: word-psm8`. User says wind worked great. This is confirmed operation of the packaged Tesseract engine, not just CI mocked values.
- [x] **Lie** `READY`, **+2.1° UP, -1.6° LEFT**, raw `2.1 UP 1.6 LEFT`; native WinRT path preserved and user says Lie worked great. Earlier user also reported lie OCR stopped appropriately on the green. No evidence this latest export independently exercises that transition.
- [x] **Capture** GSPro process found, `foreground:false`, `dpiAwareness: per-monitor`, `minimized:false`; demonstrated direct HWND capture while the other application was foreground. No browser screen-sharing prompt or external OCR setup needed in this workflow.
- [ ] **Not yet solved: minimap registration.** Export reports `minimap.status:markers_found`, right-side map, ball `(278.88, 851.24)`, pin `(277.75, 174.35)` in minimap ROI pixels, `ballToPinPixels:676.89`, but `scale.status:unavailable`, `reason:missing_fresh_world_or_layout`. `structured.shot` is `completed_record_only/last_completed` (GreyWolf hole 8, shot 1), **not** authoritative current ball. `structured.layout.status:unavailable` because `course_layout_not_found`. Do not infer yards-per-pixel from the old shot record or simply call pixel detection accurate without ground-truth checks.
- [ ] **Additional acceptance** for deployment-quality OCR: test multiple wind headings/strengths, lie types and HUD variations, especially compass N/E/NE/SW and no-wind conditions. One successful real export plus user confirmation justifies proceeding to minimap research, **not** claiming exhaustive OCR accuracy or capture freshness.

**Next implementation pass (read-only, small):** (1) verify native marker detector output against screenshots across tee/fairway/zoom states, including confidence/freshness; (2) find/use existing canonical TypeScript Live Caddie current hole/shot/ball/pin facts as read-only evidence and validate the binding to the *same* native minimap frame (do not port the JS state machine to Python); (3) establish trustworthy yards-per-pixel and zoom/viewport registration before even considering a preview target. Maintain `autoAim:false`, `POST` disabled, no click, no main/production merge. Reuse this successful Tesseract+Lie build and do **not** regress it.

## Incremental implementation log — 2026-10-12 (V2 pass #7: Proven waypoint/zoom integration)

**Architectural decision:** Reuse the already validated gray fairway waypoint ruler and post-shot zoom transform. Do not re-research dogleg calibration or port the Live Caddie shot-state machine to Python. This pass is read-only; native input and POST remain disabled.

**Historical proof (separate lab):** 18/18 Greywolf tee minimaps calibrated offline (par-4/5 waypoint, par-3 direct pin). Multi-waypoint rulers agreed within approximately 0.23%; Greywolf H8 physical GSPro proof on 2026-10-02 gave 0.575811 yd/px tee scale, pin residual 0.73 px after zoom registration, and one explicitly requested 75 yd forward/+10 yd right native click with 0.36 yd accepted-target error. That click was in an isolated harness, NOT the new companion or permission to enable production AutoAim.

- [x] Connected existing waypoint_scale_cv.py and waypoint_scale.py with bundled native Tesseract to the companion's current minimap crop. Use labeled gray marker's straight current-ball distance divided by ball-to-marker pixel distance. Par-4/5 routed tee-to-pin scorecard yardage is never substituted as the pixel ruler. Consistency checks require >=75 yd markers, >=4/8 threshold-vote agreement per accepted numeric label, and reject >2.5% scale spread.
- [x] Added bounded live OCR (up to four waypoint candidates and 17 s total OCR budget per snapshot), while preserving the historical offline multi-threshold detector defaults. Bundled tessdata is resolved adjacent to executable; no Chrome screen share or separate Tesseract installation.
- [x] Added gspro_companion_minimap_calibration.py to reuse pipeline.TeeCalibration and the existing SIFT similarity registration + independent white-pin crosscheck. Tee-frame image cache is local process memory only, only seeded by a fresh pre-shot shot #1 record with matching course/round/hole, stable DPI/HWND and tee-like ball position. Completed shot alone never seeds a tee. Later same-hole snapshots return only provisional zoom/rotation/current-scale diagnostics; cache expires or invalidates on changed window/hole.
- [x] Native diagnostics now try the labeled waypoint ruler BEFORE the fragile Python course-layout scan gate. Therefore a correct waypoint scale can be displayed when the diagnostic shot is last_completed or course_layout_not_found, without pretending a last-completed record is the current ball. **Par 3:** reuse the direct ball-to-pin horizontal ruler and tee-image cache only for fresh pre-shot #1, matching actual layout hole and a <=20 yd world tee/start crosscheck; wrong/missing layout fails closed. The older provisional world diagnostic remains untouched.
- [x] Exposed gray waypoint distance, pixel position, OCR voting confidence, scale and provisional zoom-registration pin error on the existing browser diagnostic page. No screenshots are sent over HTTP and no native click is enabled. Wind and lie readers unchanged.
- [x] Added regression tests: waypoint scale despite missing layout, fresh tee-image caching, later registered zoom candidate, no tee from stale completed shot, changed-hole invalidation, two conflicting rulers fail closed, missing bundled OCR, and rejected pin registration, plus par-3 direct-pin tee cache, wrong-tee rejection and low-confidence OCR labels.
- [x] **CI and ZIP published:** implementation/test commit `59bdb329` passed [Windows CI (including stage tests, packaged EXE smoke, and bundle)](https://github.com/bpgpitt10/nova-v0/actions/runs/38203842422) and [Web Alpha CI](https://github.com/bpgpitt10/nova-v0/actions/runs/38203842407). [Download verified test ZIP](https://github.com/bpgpitt10/nova-v0/releases/download/looper-companion-autoaim-stage-c-59bdb329/looper-windows-companion.zip). Remaining physical GSPro waypoint/zoom verification is not established by CI. No merge to production.
- [x] **Matching development web preview READY:** [GSPro native observations — gray waypoint and tee/zoom cards](https://looper-4ytyydzg8-wqk25hkxcg-3591.vercel.app/dev/companion-observations.html), deployment `dpl_EJTPLFxXupBeva7jFtTv8SbJ7R7Y` sourced from branch commit `88877a47`; production domain not changed. Use this preview with ZIP `59bdb329`, not the older immutable preview URL.
- [ ] Simulator check: Greywolf H8 at tee, capture default gray waypoint distance and scale. Compare with historical 0.575811 yd/px only if same zoom/reference frame. Hit shot, verify cached tee to current zoom/rotation and white-pin residual; one dogleg and one par 3 follow. If native files still show last_completed at tee, display provisional ruler but no trusted tee cache until authoritative TypeScript Live Caddie hole/shot evidence is provided.
- [ ] Full AutoAim integration remains separate: secure read-only binding between canonical TS current state and native tee/pin/coordinate frame, preview-only target-to-pixel, explicit user Set Aim consent, fresh native-click preflight/pairing and magenta accepted-target post-click check. Do NOT promote provisional scaling to authoritative on the basis of one snapshot.

**Next:** Use the current companion to verify this existing math on the real Greywolf sim. Do not re-run the entire 18-hole corpus as the default next step.
## Incremental implementation log — 2026-10-12 (V2 pass #8: Connect Live Caddie → preview target → profile performance)

**User request:** Complete priorities 1–3 offline while away from GSPro; then update this implementation plan. Scope is narrow. Do not rebuild the canonical shot-state engine, the recommender, gray waypoint geometry, or wind/lie OCR, and do not enable clicking.

### 1. Browser/native diagnostic reconciliation — implemented

- [x] Reuse the existing authoritative BrowserGsproCourseSnapshot + prepareReadOnlyNativeAimIntent, including selected club and candidate aimPoint. Add lastCompletedShotId to the read-only intent for exact finished-shot evidence matching.
- [x] Retain the existing GET-only companion local observation connection. LiveCaddiePage now saves sanitized native observations instead of only summarizing wind/lie in a status line; native wind and lie event dispatch remains unchanged.
- [x] Added pure src/adapters/looperCompanionAimPreview.ts. Strictly require compatible native schema, autoAim:false, connected GSPro per-monitor DPI/non-minimized, fresh timestamps/file age, exact course key/round/hole, and matching active pre-shot number OR matching latest completed ShotID + shot number. The companion's last_completed record NEVER supersedes Live Caddie's own current hole/ball.
- [x] Prevent false preview on green/unavailable Live Caddie target, geometry length >10 yd disagreement, post-shot pixel-ball mismatch >12 yd, native white-pin check >3 px, uncalibrated tee/zoom, nonfinite/singular transform, or target beyond minimap bounds. All failures render a specific reason and no target pixel.

### 2. Recommendation to GSPro minimap read-only pixel candidate — implemented, NOT physically verified

- [x] Expose only numeric canonical native tee/pin pixel anchors and the previously proven current→canonical 2x3 similarity matrix through the local diagnostics GET; preserve raw GSPro images inside EXE.
- [x] Browser calculation reproduces helpers/auto_aim_transform.py: Looper-local tee/pin axis and right-handed offset to canonical tee minimap pixels, then inverse cached zoom matrix into current ROI pixels. Output is always candidate-unverified; there is NO mouse-command transport, pairing, permission or native POST.
- [x] LiveCaddiePage displays a compact read-only status (blocked vs candidate), target pixel, tee/pin anchor error, current ball error, matching shot evidence, and an illustrative blank minimap schematic with red native ball, white native pin and unverified target. Schematic is NOT an actual GSPro image.
- [x] Added tools/test-looper-native-aim-preview.mjs and npm test:companion-preview, run by Web Alpha CI. Replays saved Greywolf H8/H13 matrices and expected target pixels; rejects wrong hole, wrong round, wrong previous shot, stale records, bad registration pin, bad tee/pin anchors and ball mismatch. The web build and source-level regression tests passed during development.

### 3. Performance instrumentation — implemented, real-PC timing values pending

- [x] Python companion emits numeric timingMs for structured discovery, direct HWND capture, minimap processing, marker detection, waypoint OCR subprocesses, scale math, cached tee/zoom registration, wind OCR, lie OCR and overall elapsed ms (perf_counter). Missing stages are null, not fabricated zero-speed results.
- [x] The existing diagnostics HTML and LiveCaddiePage surface per-stage timing readouts, included in the exported sanitized diagnostic JSON, enabling tomorrow's repeated measurements and identification of the slowest step.
- [x] Tests assert timing fields remain sanitized numeric values and do not leak image bytes, usernames or local paths.

### Build, packaging and safety

- [x] Kept Tesseract wind and WinRT lie implementation unchanged. Worked only on isolated auto-aim-windows-companion-v1 branch. Native POST/AutoAim mouse input remain disabled; browser pixel preview never sends target to native companion.
- [x] Replaced flaky Chocolatey re-install in Windows CI (package feed 504) with a pinned portable OCR bundle from own physically proven Looper release d11eb7ad; keeps English data/DLLs and avoids version drift. GitHub release must be available or build fails closed.
- [x] Fixed intermediate web unused-state variable and numeric-affine test fixture errors discovered in CI. Fixed a missing reason field in mock GSPro discovery response.
- [x] Consolidated code/test build PASS: [Windows CI 38205307790](https://github.com/bpgpitt10/nova-v0/actions/runs/38205307790) (66 Python tests, EXE build, packaged smoke, portable OCR bundle, ZIP prerelease `6cb09a05`). [Web Alpha 38205307788](https://github.com/bpgpitt10/nova-v0/actions/runs/38205307788) including Greywolf H8/H13 read-only pixel fixtures, source-level safety gates, TypeScript compiler and Vite build. [Download test ZIP](https://github.com/bpgpitt10/nova-v0/releases/download/looper-companion-autoaim-stage-c-6cb09a05/looper-windows-companion.zip).
- [x] Matching BRANCH-only Vercel preview `dpl_GYiqKYpPURkArHKcDt8UKS7ZNqCg` **READY** from Git commit `0bd39d60` (source functionality identical to packaged `6cb09a05` except docs): [Live Caddie guarded aim preview](https://looper-6sekyibd4-wqk25hkxcg-3591.vercel.app/live-caddie) and [Native observations performance diagnostics](https://looper-6sekyibd4-wqk25hkxcg-3591.vercel.app/dev/companion-observations.html). Not promoted to thelooper.golf production.
- [ ] Physical Greywolf H8 and par-4 dogleg/par-3 simulator acceptance: waypoint ruler vs displayed yardage, tee cache and zoom pin registration after shot, shot-ID/source reconciliation, correct relative preview placement and per-stage millisecond measurements. Existing H8 0.36 yd physical click proof belongs to older isolated harness; not to this new preview.
- [ ] Coordinate frame is explicitly still unverified even when math and numerical guards pass. Need independent course↔GSPro tee/pin/bearing evidence and real-PC preview error measurements before promoting to aim-ready. A native snapshot showing only a previous-hole last_completed record at the next tee MUST be blocked, not silently treated as a new tee. Browser folder picker for the authoritative Live Caddie shot feed is separate work and remains in place; **no Chrome screen sharing is required for companion capture**.
- [ ] Shorter-than-calibrated partial shot strategy integration remains a separate branch/merge gate; no invented named club or fake success probabilities.

**Next task after physical evidence:** if pixel candidate matches GSPro across at least a par-3, dogleg and post-shot zoom, establish explicit verified coordinate-frame provenance and begin secure user-consented Set Aim command integration, with one native click and magenta acceptance <=3 yd verification. Until then all click routes disabled.
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

## Immediate next acceptance gate — current Live Caddie ↔ native preview physical test

1. Install [pass #8 ZIP `6cb09a05`](https://github.com/bpgpitt10/nova-v0/releases/download/looper-companion-autoaim-stage-c-6cb09a05/looper-windows-companion.zip) and use [matching BRANCH-only Live Caddie preview](https://looper-6sekyibd4-wqk25hkxcg-3591.vercel.app/live-caddie) or [standalone diagnostics](https://looper-6sekyibd4-wqk25hkxcg-3591.vercel.app/dev/companion-observations.html). Keep existing browser GSPro round/folder access; use native observations WITHOUT Chrome screen sharing.
2. At Greywolf H8 tee verify gray waypoint yardage and resulting tee-frame yards/pixel, then move/shot for zoom and inspect cached tee, white-pin residual and both scale/registration states. Capture the new per-stage timingMs.
3. In Live Caddie with selected club/aim, inspect the read-only native aim check. Confirm native record and canonical Live Caddie course/round/hole/shot agreement and candidate screen-ROI pixel. A stale previous-hole record MUST yield an explicit blocked reason. Compare candidate against actual GSPro minimap visually; do not click.
4. Repeat controlled preview for one dogleg and one par 3, capture snapshot JSON and stage performance totals. Only then propose a verified native coordinate-frame contract. Explicit Set Aim/pairing and physical click authorization are distinct later steps.
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

> Continue The Looper Windows Companion native AutoAim work on branch auto-aim-windows-companion-v1, NOT main. Read this V2 plan, the earlier Greywolf H8/H13 physical proof, and docs/companion-native-aim-pairing-v1.md. The packaged Tesseract wind and native lie are already confirmed on the simulator; the old waypoint/zoom transform calibrated 18/18 Greywolf tee frames offline and completed one <=0.36 yd physical isolated-lab click. Pass #7 integrated that geometry into the current read-only companion. Pass #8 now reconciles the existing authoritative TypeScript Live Caddie snapshot with native round/hole/shot evidence, derives a guarded NON-CLICKING recommendation-to-minimap pixel candidate, displays a schematic on Live Caddie, and logs per-stage timing. NEXT: verify consolidated CI and matching branch preview, then run one real simulator preview and performance check tomorrow. Keep companion POST/AutoAim input FALSE, do not recreate shot-state in Python, do not infer GSPro current shot from old last_completed, do not treat Looper-local XY as verified native world coordinates. Later work requires verified per-hole course-frame, secured user consent, one click and magenta marker check. No production merge.
