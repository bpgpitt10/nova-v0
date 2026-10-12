# Course self-service preflight — October 10, 2026

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
