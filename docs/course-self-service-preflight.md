# Course self-service preflight — October 10, 2026

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
