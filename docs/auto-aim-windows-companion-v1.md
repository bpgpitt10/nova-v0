# Auto Aim V1 — Windows companion architecture and handoff

**Decision date:** 2026-10-06  
**New active implementation branch:** `auto-aim-windows-companion-v1`  
**Base:** `web-course-importer-current-lineage-v1` (working hosted Live Caddie baseline).  
**Status:** Stage A code implemented on isolated branch, Windows build/smoke tests passed on initial CI run, dedicated development prerelease/preview validation pending. No production changes; no native input or aim control added.

## Product decision

Looper remains the hosted website (`thelooper.golf`). Auto Aim will use **one optional Windows installer**, rather than attempting to inject desktop mouse/keyboard input directly from Chrome. A small user-session tray companion discovers GSPro, reads needed local state, captures its minimap, performs **one direct minimap click**, and verifies GSPro's accepted magenta aim marker. No keyboard LEFT/RIGHT pulse loop is required. Live Caddie remains useful without the optional companion (manual/suggested aim).

The helper is **not** a second Looper app, replacement UI, browser extension, PowerShell script, localhost page, or full Tauri desktop conversion. There is no recurring manual selection of the GSPro folder or window. If automatic discovery fails, provide a narrow, one-time fallback picker with path/window verification.

## Stage A implementation handoff (2026-10-06)

**Existing foundation found:** The repository ALREADY contained `helpers/looper_companion.py`, a PyInstaller one-file Windows build, a PowerShell + CMD one-time per-user installer, HKCU Run autostart, an existing wind/lie OCR helper and a GitHub Actions workflow. Do not invent or install a second parallel helper. The existing binary listens on `127.0.0.1:8787` when started by the installer. It has no tray icon yet; that is future polish.

**New code on this branch:**

- `helpers/looper_companion.py`: new read-only `GET /companion/v1/status` endpoint on the SAME companion process; exact origin restrictions for `thelooper.golf`, localhost development and Looper's team-scoped preview hosts; Host validation; no POST/actuation endpoints. Reports `gspro.status` `connected` / `waiting` / `ambiguous` using HWND/PID and verified executable basename (no blind window-title trust). Advertises `autoAim:false`, `nativeCapture:false`, `folderDiscovery:false` accurately. Existing `/health`, `/wind`, `/lie`, `/derive` preserved.
- `src/adapters/looperCompanion.ts`: typed Chrome `fetch` status adapter with explicit `targetAddressSpace: 'loopback'` for current LNA browser permission flows.
- `public/dev/companion-connect.html`: standalone one-button **read-only** browser ↔ companion test, purposely outside existing Live Caddie folder access gate.
- `tests/test_looper_companion_stage_a.py`: HTTP test for allowed/blocked origins, Host spoofing, OPTIONS, no click endpoint, and legacy `/health`.
- `.github/workflows/build-looper-companion-windows.yml`: build/test/smoke + **isolated** development prerelease for this branch, never overwrite `looper-companion-latest`. GitHub Actions standard artifact uploads failed due account storage quota; deliver via dedicated tagged GitHub prerelease asset instead.

**Connection test:** Install development companion package on the GSPro Windows computer, open `https://<preview-host>/dev/companion-connect.html` in Chrome, click Connect, allow Apps on device / loopback network access when prompted. A PASS is `service:looper-companion`, `version:autoaim-stage-a.1`, and `gspro.status:connected` when GSPro is running (or `waiting` before launch). This verifies secure-enough **read-only** Stage A connectivity only; actual native click and window capture remain entirely unimplemented.

**Limitations deliberately retained until Stage B:** No GSPro folder autodiscovery yet. No minimap capture, aim actuator, on-shot lifecycle, tray interface, or browser pairing secret for future write commands. Live Caddie still has its original Chrome folder picker/screen capture path. Never remove/bypass that gate until helper data-ingestion parity is proven. Future native actuation MUST require explicit pairing/authentication beyond allowed Origin and hostile-site CSRF tests; `GET /status` alone is not permission to click.

## Relevant research and tested proof

- **Direct click proof:** `live-caddie-auto-aim-v1` (historic native launcher, not desired final architecture), `minimap-waypoint-scale-v1`, `minimap-click-lab-v0`. See `tools/minimap_probe/AUTO_AIM_PROOF.md` and `CLICK_LAB.md` on `live-caddie-auto-aim-v1`.
- **2026-10-02 Greywolf H8 live proof:** tee scale 0.575811 yd/px; 75 yd forward / +10 yd right requested; current->canonical pin error 0.73 px; GSPro accepted native minimap click; magenta-marker verified position with 0.36 yd vector error (threshold <=3 yd). This was OS-level Windows actuation, **not** webpage JavaScript.
- **Browser research branch:** `web-auto-aim-closed-loop-v0`, head `ece26e4`. Contains an actuator-agnostic L/R angular closed-loop controller and a **retired** file-write experiment; do not merge or revive the mutation probe. Pixel click proof is preferable and avoids the angular steering idea entirely.
- The original Chrome `showDirectoryPicker` access and `getDisplayMedia` sharing remain usable for other Looper features, but cannot control GSPro's native mouse.
- Do **not** mutate live `currentRound.dat`, `tdpoint`, or `TargetDirection` to attempt actuation.

## Desired end-user experience

1. User installs **Looper Companion** once on the Windows sim PC (ideally per-user, no ongoing administrator privilege).
2. Companion starts silently in the logged-in user's session on Windows login; sits idle in system tray. **Not a Windows service** (Windows services cannot reliably interact with the interactive game desktop).
3. When user opens `thelooper.golf` and clicks **Live Caddie**, browser connects to the companion on **127.0.0.1 only**, with one-time permission/handshake where required. Companion discovers or reattaches to the running GSPro process, window, and installation/data folder. No repeated folder picker or window-sharing prompt if native capture works.
4. Companion watches GSPro state and captures the required minimap only while Live Caddie is active. Website continues to compute recommended club and aim point.
5. At explicit **Tap to Arm / Set Aim** request (V1; no automatic click on navigation), website transmits the exact recommended point, course/hole/shot identity and nonce. Companion validates game/window/shot and calibration, computes GSPro minimap screen click, and performs **one native click**. It captures GSPro again and verifies the accepted magenta marker in yard-space.
6. Website shows `SETTING GSPRO AIM…`, then `7I AIM SET` only after verified PASS; otherwise a clear failure / manual aim option. Never silently retry arbitrary clicks. Invalidate old aim on shot/hole/club/target changes.
7. Quitting Live Caddie stops active capture/watching; tray companion remains available. Users can disable startup or uninstall.

## Auto-discovery (must be reliable, not magic)

- First find a legitimate **GSPro process** (executable identity/path and candidate top-level HWND); prefer process path to blind directory scans.
- Resolve installation/data directory from verified process executable and expected GSPro data/log locations; fall back to known registry/install directories, recent known good path, and finally a **one-time manual folder picker** only if necessary.
- Validate `currentRound.dat`, `output_log.txt` or other needed files in the actual discovered location; do not assume file paths always equal the executable folder.
- Discover and track game HWND by process ID, not just window title; handle GSPro restart, relaunch, changed window bounds, multi-monitor, and Windows display scaling.
- Consider working without GSPro running yet: show Waiting for GSPro and attach automatically when it appears. If multiple plausible GSPro instances, disambiguate visibly rather than guessing.
- File watching should avoid replacing currently valid Live Caddie shot ingestion with an untested path. Either retain website's current data route for V1 or validate helper ingestion end-to-end before switching.

## Native capture + click contract

- Prefer Windows Graphics Capture of the **specific GSPro HWND**, crop minimap, read ball/pin, register zoom/rotation to calibrated tee frame, validate pin, invert target transform, and do **one minimap click**.
- Convert window-relative coordinates to desktop physical pixels with DPI awareness and correct client/nonclient/window-bounds handling. Do not assume fixed minimap screen coordinates.
- Confirm game can receive the click when another app/browser has focus. OS `SendInput` clicks target the interactive desktop; GSPro may need to be foregrounded briefly. If so, surface and test the focus switch before designing polished UX. Do not claim arbitrary true background clicking until demonstrated.
- Reject click if GSPro is minimized, capture stale, marker identification ambiguous, minimap hidden, calibration bad, user has interacted/cancelled, course/shot identity changed, point off-map, or aim is on an unsupported screen/green.
- After click, verify the accepted **magenta GSPro target** against requested coordinates in yards (proof benchmark <=3 yd); fail closed if cannot verify.
- First version explicitly requests a click per shot; later auto-arm only after live simulator reliability tests.

## Local browser-to-companion security / interoperability

- Use a small bound-to-`127.0.0.1` API; start with authenticated HTTP request/response and only add WebSocket streaming if required.
- Native installer creates a per-install random secret/handshake, enforce precise origin allowlist for `https://thelooper.golf` and approved previews, strict CORS/Origin checks, CSRF protections, short-lived command IDs and shot identity. Do not expose arbitrary cursor/mouse/file-write operations to websites.
- Chromium since Chrome 142 requires **Local Network Access / loopback permission** for a hosted HTTPS site connecting to localhost; design one clear Connect Companion interaction, test this early on actual simulator Chrome.
- No cloud service controlling the user's desktop. No public bind address.
- Log coarse success/failure evidence, not private screen captures by default.

## Implementation stages and acceptance gates

**Stage A: Companion shell + browser handshake (first proof).** Choose lean native Windows distribution (prefer self-contained build), package one installer/tray startup, prove thelooper.golf can reliably connect via loopback under 2026 Chrome LNA prompts, report version and `GSPro connected/waiting` status. No desktop input yet.

**Stage B: Discovery + capture.** Detect GSPro executable, resolved folder, HWND; attach after game launch/restart; capture minimap with GSPro in foreground/background; validate overlay/fullscreen, multi-monitor, DPI. Prove it can read correct live shot state at tee and after first shot.

**Stage C: Port proven direct-click harness.** Reuse and port minimap calibration, current-frame registration, pin crosscheck, GSPro one-click actuator and magenta verification from the 2026-10-02 physical proof; do NOT re-implement L/R pulses. First test with manual 75/+10 target on Greywolf H8; target <=3 yd verification threshold and zero inadvertent clicks.

**Stage D: Live Caddie recommendation integration.** Website sends current recommendation's absolute aim point and shot identity. One explicit Tap to Arm/Set Aim button; results `SETTING…`, `AIM SET` only on verified success, or `FAILED / MANUAL AIM`. Ignore stale commands, prevent repeats, honor course/pin/shot changes and disabled Auto Aim on green.

**Stage E: Packaging and public beta.** Single signed installer if distributing externally, auto-start setting, versioned updates, diagnostics, uninstall, graceful error states, minimum permissions, and tests across PCs with different GSPro installs/monitor layouts.

## Non-goals / pitfalls

- No rewriting live GSPro state files for commands.
- No blanket auto-click when Live Caddie opens: opening connects and observes; user arms one shot explicitly for V1.
- No promise that GSPro accepts genuine out-of-focus mouse clicks until proven.
- No full-screen video streaming to the cloud; image processing remains local when possible.
- No mass port of dormant Tauri files or old experimental branches.
- Existing website/product work on other branches is left untouched until acceptance gates.

## Resume instructions for a new ChatGPT chat

> Continue The Looper Auto Aim **Windows companion** work. Read `docs/auto-aim-windows-companion-v1.md` on branch `auto-aim-windows-companion-v1` in `bpgpitt10/nova-v0`. User approved a **single-install quiet Windows helper**: auto-find GSPro process/folder/window when Live Caddie opens, native minimap capture, one direct window click (not L/R keys), post-click magenta verification, hosted Looper UI. Starting point is Stage A: lean helper shell and secure 127.0.0.1 Chrome handshake. Reuse physical proof files on `live-caddie-auto-aim-v1` and avoid the retired `web-auto-aim-closed-loop-v0` file-write experiment. Do not mutate production or claim native click is implemented until tested.
