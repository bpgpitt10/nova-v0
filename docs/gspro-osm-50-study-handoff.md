# GSPro → OSM 50-course coverage audit: durable handoff

**Study ID:** `gspro-osm-50-2026-10`  
**Created:** October 11, 2026  
**Repo:** `bpgpitt10/nova-v0`  
**Working branch:** `web-course-e2e-preflight-v1` — staging only; do not modify `main`/production.  
**Frozen input:** [research/course-coverage/gspro-osm-50-2026-10.json](../research/course-coverage/gspro-osm-50-2026-10.json)  
**Public GSPro catalog evidence:** https://simulatorgolftour.com/courses/ — public SGT course directory, 2,721 courses at selection. GSPro states that it includes the SGT course server: https://gsprogolf.com/courses/ .

## Read me first / current progress

**ROSTER PREPARED. STUDY NOT YET RUN. NO COURSE PASSES CLAIMED.**

A preselected set of **50 distinct, real-world U.S. courses listed in the public SGT/GSPro course catalog** covers **25 states** and five geographic strata. This is a judgment-stratified engineering study, **not** a true random sample of all courses, so percentages are indicative for the selected sample, not a statistically representative national success rate. SGT listing status is documentary catalog evidence; precise naming/current availability can still be reconfirmed in the actual installed GSPro course selector if necessary.

Excluded controls: **Valhalla Golf Club** (map-ready, live-blocked on tees); **FarmLinks at Pursell Farms** (runtime-ready via some curated tee metadata); **Greywolf Golf Course** (legacy supported course with extensive calibration). None counts toward the 50. Do **not** substitute a similarly named venue, a 9-hole course, a fantasy course, or an alternative layout quietly.

**Key question:** For how many *GSPro-listed courses* does the existing OSM-based Looper geometry and tee-set pipeline produce **trustworthy golfer-selectable tee coordinates** without special case corrections? For the rest, list *every* missing/incorrect input and quantify the most frequently repeated blockers.

**Known existing functionality:** Name-to-OSM course discovery; raw OSM map feature snapshot; 18-hole route geometry; green/fairway/hazard and tee-polygon extraction; standalone OSM tee-point evidence; USGS LiDAR and WorldCover/green processing; strict full runtime tee contract; map-only staging preview. Valhalla's failure arose because 12 raw physical tee polygons were associated with six holes, leaving 12 without owned tee polygons. Crucially, `build_osm_course_package_v6.py` currently derives a tee-set catalog from Hole 1, and may use generic `Tee 1` labels. This is **not proof those labels match real scorecard tee colors**.

## Strict budget / restart discipline

1. **Do not start 50 full LiDAR imports.** Begin with a read-only, geometry-only OSM preflight; measure coverage cheaply before making expensive packages.
2. Work in **five batches of ten**, in frozen roster order. At every batch boundary, commit a compact results ledger to the staging branch. Record unsuccessful probes as real results, with distinct 'source error' versus 'data absent' states. Do not silently replace failed subjects.
3. **Never bulk scrape public Nominatim or hammer the OSM core map API.** Use a legitimately sourced local/regional OSM extract (e.g., Geofabrik PBF) or bounded compliant lookups. Log source and observation date. Respect OSM attribution and ODbL requirements. This study does NOT use OpenGolfAPI or any third-party scorecard bulk import.
4. Deduplicate and cache source snapshots. On resumption, skip `completed` records and rerun only `not_started` or `retryable_source_error` items. Never redo already completed LiDAR steps unless inputs changed.
5. If a provider or source is blocked, rate-limited or unavailable, stop network requests and write a handoff note. Don't burn time on uncontrolled retry loops or broaden into course-importer rewrites mid-experiment.
6. No changes to runtime course registry, production domains, or the publish pipeline for this diagnostic experiment. Use staging branch and read-only audit output only. Any full import is a separately approved trial after the cheap audit.

## Exact per-course procedure

**0 — GSPro identity gate.** Read frozen `gsproListingName` + city/state. Source is the public SGT/GSPro catalog. Resolve title/aliases carefully, ensuring the OSM course is the *same facility and specific course routing*. Keep `gsproEvidence` separate from OSM evidence. The frozen 50 already have listing evidence; do not waste 50 repeated generic web searches unless needed to resolve ambiguity.

**1 — Course identity & hole inventory (cheap).** Match one OSM `leisure=golf_course` polygon/way/relation at the recorded location, then collect OSM `golf=hole` lines by `ref`. Record 0–18, absent refs, duplicate refs, reversed/ambiguous routing, and whether the venue has multiple layouts. If no OSM match, don't infer its geometry from the GSPro course package.

**2 — Surface inventory (cheap).** For all 18 holes, count/associate `golf=green`, `golf=fairway`, `golf=bunker`, water, and tee polygons **and** tee nodes. Capture each hole's tee polygons, any `name`, `ref`, `tee`, `colour/color` tags, and nearest-route ownership; don't stop reporting after the first missing polygon. Explicitly distinguish an OSM missing feature from Looper rejecting an existing feature due to search radius or ownership rules.

**3 — Tee-set audit (cheap).** Dry-run existing v5/v6/v7 tee modeling and its contract **without changing importer code**. Identify whether each hole has one/multiple legitimate mapped starting positions, whether a *consistent real named tee set* maps across 18 holes, and whether we only have artificial generic labels like `Tee 1`. Tee polygon presence alone is necessary but not sufficient for a correct real tee set.

**4 — Ground truth (focused).** For plausible candidates, check an **official course scorecard** for tee names, pars and hole-by-hole yardages. Keep scorecard source URL/date and rights/license notes. This is for verification, not 50 automated third-party scrapes. Where scoring is absent, use `scorecard_unverified`, not `pass`. Check that tee-to-green distances are consistent within a realistic tolerance and document doglegs / fairway-line versus straight-line differences. Do not claim subyard accuracy; tee markers are movable.

**5 — Classification.** Label each course:
- `A_verified_usable`: complete 18-hole routing + sufficiently complete surfaces, **real tee identities verified against source**, and plausible positions for one or more selectable tee sets on *all 18 holes*, no per-course manual fixes. List which tee sets passed.
- `B_near_usable`: near-complete geometry or tee data with identifiable generic fix, **not presently usable**.
- `C_incomplete`: multiple / material geometry or tee problems; extensive work required.
- `D_no_usable_osm`: no reliable course match or critical holes missing.
- `U_unverified`: temporary lack of trustworthy external evidence or source access; distinguish from actual OSM absence.

Independently record `existing_strict_validator_pass` and `map_only_ready`. These are **not** equivalent to `A_verified_usable`. A fabricated/auto-assigned `Tee 1` or a single mapped tee polygon for each hole isn't by itself an honest successful tee-set match.

**6 — Promotion (later separate action).** Only after the full audit, pick an initial subset of A courses for normal USGS DEM, WorldCover, green-detail and strict runtime builds, staging preview, scorer/yardage sanity check and GSPro identity check. A 30/50 OSM success result makes 30 **priority full-import candidates**, not 30 immediately playable courses; full-import gates still apply.

## Required machine-readable ledger fields

Maintain one row per frozen course plus a compact summary, under `research/course-coverage/results/`. Recommended fields:

```json
{
  "number": 1,
  "gsproListingName": "En-Joie Golf Club",
  "osmCourseMatch": "matched|ambiguous|not_found|source_error",
  "osmCourseId": null,
  "holeRouteRefsFound": [],
  "missingHoleRefs": [],
  "duplicateHoleRefs": [],
  "holeTeePolygons": {},
  "holeTeeNodes": {},
  "teeOwnershipFailures": [],
  "teeSetsNamedFromOSM": [],
  "teeSetsVerifiedAgainstScorecard": [],
  "scorecardSource": null,
  "perTeeSet18HoleCoverage": {},
  "existingStrictValidatorPass": false,
  "mapOnlyReady": false,
  "classification": "U_unverified",
  "failureCodes": [],
  "sourceObservedAt": null,
  "auditNotes": ""
}
```

All `failureCodes` must be **multi-label**, not first-error-only:
`GSPro_NAME_AMBIGUOUS`, `OSM_COURSE_NOT_FOUND`, `OSM_MULTIPLE_LAYOUTS`, `HOLE_MISSING`, `HOLE_DUPLICATE`, `HOLE_ORIENTATION`, `GREEN_MISSING`, `FAIRWAY_MISSING`, `TEE_POLYGON_MISSING`, `TEE_NODE_ONLY`, `TEE_OWNERSHIP_REJECTED`, `TEE_IDENTITY_MISSING`, `TEE_SET_INCONSISTENT`, `PAR_MISMATCH`, `SCORECARD_UNVERIFIED`, `DISTANCE_DISAGREEMENT`, `OSM_SOURCE_ERROR`, `RUNTIME_CONTRACT_ERROR`. Use `DEM_COVERAGE` only in later full-import trials.

## Required summary & decision

For denominator **50**, show:
- count verified A / near B / incomplete C / no match D / unknown U
- separate strict current-importer pass count and physical tee-coverage distribution (0–18 mapped holes)
- proportion with verified at least one real tee set, and distribution of **sets per course**
- **multi-label** blocker prevalence: how many courses each issue affects, even if multiple overlap
- 'If we fix X, how many extra courses might become usable?' with conditional overlap-aware estimates
- source failures, ambiguous identities, and performance/cost recorded separately
- expected practical near-term import list, followed by recommendation for only the highest-unlock general importer improvement.

This supports the user's decision: if 30 of 50 have real tee sets and usable geometry, immediately proceed to full-import validation on those 30, **not** building an aerial tee detector. If the entire sample shares one remediable blocker, prioritize that instead.

## Handoff to another chat / agent

Paste exactly:

> Continue the Looper GSPro–OSM 50-course coverage study in GitHub `bpgpitt10/nova-v0`, branch `web-course-e2e-preflight-v1`. First read `docs/gspro-osm-50-study-handoff.md` and `research/course-coverage/gspro-osm-50-2026-10.json`, then read any existing `research/course-coverage/results/` ledgers. Process only the next incomplete ten-course batch using read-only, inexpensive OSM geometry checks; preserve the fixed roster and GSPro identities. Do not call map-only success playable, assume Tee 1 is a real tee set, fetch LiDAR for all 50, scrape OpenGolfAPI, or deploy production. Record all reasons a course fails, commit results at batch boundary, and report exact results and remaining work. If an external data provider blocks progress, write down the blocker and stop gracefully.

## Reference implementation pointers

- OSM discovery: `tools/discover_osm_course_by_name.py`
- OSM core feature fetch: `tools/fetch_osm_course_snapshot_core.py`
- OSM normalizer: `tools/build_osm_course_package.py`
- Tee ownership/fallback: `tools/build_osm_course_package_v5.py`
- Tee-set derivation: `tools/build_osm_course_package_v6.py`
- Map-only contract: `tools/validate-course-map-contract.mjs`
- Strict runtime gate: `tools/validate-course-import-contract.mjs`
- Canonical full importer: `tools/import_course_canonical.py`
- Existing timing receipts: `artifacts/course-geometry/*/import-timing-v1.json`

If result data doesn't yet exist, state that only roster preparation is done. **Never invent an audit success rate.**
