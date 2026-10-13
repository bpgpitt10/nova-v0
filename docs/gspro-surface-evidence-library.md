# GSPro surface evidence library — working inventory (2026-10-13)

**Scope.** This is NOT a complete, confirmed list of GSPro's lie surfaces and not a universal numeric codebook. It is a distinction between (1) surface identification, (2) independently measured shot-launch modifiers, and (3) OSM terrain/hazard polygons. These sources MUST NOT be silently interchanged. The user recalls ~11 GSPro surface types; no source currently verifies that total. Observing numeric code **18** for a tee proves raw codes cannot safely be assumed contiguous 0..10.

## Current physics coverage (`src/liveCaddie/surfaceResponse.ts`)

| Current physical-shot category | Launch speed / spin / VLA | Source status | Consequence |
| --- | --- | --- | --- |
| Tee / fairway baseline | 100% / 100% / 100% | Baseline | Normal stock flight |
| Rough | 96% / 61% / 100% | Previously observed GSPro modifiers | Modeled rough response |
| Deep Rough | 82% / 49% / 98% | Previously observed GSPro modifiers; exact HUD text not yet native OCR'd | Distinct deep-rough response |
| Sand / bunker | 77% / 76.5% / 100% | Midpoint of previously observed sand ranges | Model only when independently recognized |
| Green | Not a full-shot modifier | Live Caddie pauses on green | No club recommendation |
| Unrecognized surfaces | No assumed modifier | Unverified | Unknown / explicitly provisional; do not invent a sand penalty |

These are **4 modeled launch-response groups**, not 4 total GSPro lie types. Semi-rough currently shares the rough physics pending independent measurements. Other potential labels (fringe, path, hardpan, pine straw, etc.) are not verified here as actual GSPro enum entries and do not get invented coefficients.

### External GSPro documentation: HUD authority and dynamic penalties

GSPro's own [in-game UI guide](https://gspro.gitbook.io/gspro-knowledge-base/in-game-information/in-game-user-interface) states that the **center text at the top of the minimap is the current lie**; the bottom of the minimap separately displays the up/down and left/right slope angles. This confirms that the existing Companion slope-footer OCR is reading the wrong region for the surface *name*. A bounded OCR pass over the **top bar of the SAME captured minimap frame** is our preferred path to automatically detect Deep Rough, with source freshness/shot identity checked before overriding the rough fallback.

GSPro's [published V2 user guide](https://www.golfinsim.com/wp-content/uploads/2023/11/GSPro-Users-Guide-V2.0.2.pdf) also explains that deep-rough penalties vary dynamically with launch angle and ball speed. Thus 82% speed / 49% spin / 98% VLA is an **observed representative model**, NOT universally correct across a 3W versus 9i (or even across two different launch-angle shots). Accurate next-stage physics requires collecting and fitting actual surface-specific penalty measurements across loft/VLA, not freezing these four coefficients as an exhaustive GSPro emulation.

A third-party simulator venue explicitly enumerates at least eight displayed lie labels—Tee, Fairway, Semi-Rough, Rough, Deep Rough, Pine Straw, Sand, Green—but this is not an official exhaustive GSPro enum specification and does NOT verify the total count of 11. [Venue description](https://loftgolfstudios.com/gameplay).


## Raw `currentRound.dat` IDs: what we know vs what we don't

The reviewed, executable working inventory is `src/adapters/gsproSurfaceCodes.ts`; every other numeric ID is currently unknown:

| Numeric code | Existing parser interpretation | Confidence for operational use |
| --- | --- | --- |
| 1 | rough | Legacy working assumption; needs matched label samples |
| 2 | fairway | Legacy working assumption; needs matched label samples |
| 3 | **unknown; blocked** | Previously guessed sand. Not independently verified; never use bunker penalty solely on this code |
| 5 | green | Legacy working assumption; needs matched label samples |
| 11 | **unknown; blocked** | Conflicting historical bunker/woods evidence |
| 18 | tee | Independently observed as `StartingSurfaceRaw:18` on FarmLinks Hole 1; does not prove all cases |
| All others | unknown | No mapping without evidence |

**Important nuance about the 2026-10-13 FarmLinks error:** Round 255, first shot traveled 39.9 yd and GSPro's **Shot 2 HUD** unequivocally displayed **Deep Rough**. Live Caddie previously displayed **Sand**, applying a -91.6 yd modeled carry modifier. However, the native JSON exported for that session showed `startingSurfaceRaw:18` and did NOT expose `endingSurfaceRaw`; therefore the particular raw ending code cannot yet be assigned to Deep Rough from that export. The existing decoder's `3 -> sand` association was unsafe, but assigning `3 -> deep rough` would ALSO be premature.

## How to build trustworthy coverage

1. **Observe** a completed GSPro shot with round/course/hole/shot identity and both raw `StartingSurface` and `EndingSurface` from canonical `currentRound.dat`. The Companion now exposes `endingSurfaceRaw` for *future* Windows builds. Do not mistake starting surface for where the ball landed.
2. **Confirm GSPro's actual next-shot HUD label** on the same current hole, either by carefully cropped read-only native OCR or explicit golfer confirmation through the shot-scoped Lie buttons. Present native Lie OCR only reads the 0.9° down / 0.5° right footer and returns `surface:null`; it cannot automatically tell Deep Rough from Sand.
3. **Pair**, with provenance, the HUD label and raw code to the just-completed shot ID, never the stale preceding hole. The new browser evidence store records **local-only** matched pairs when a user clicks a HUD-confirmation button; it does not silently upload data or certify a codebook.
4. **Validate** across several independent shots/holes and GSPro conditions, especially ambiguous code 3 or 11. Record raw speed/spin/VLA penalty log measurements for individual surface types before establishing distinct physics for any new category.
5. **Promote** a mapping to approved interpretation only when there are consistent paired examples with no contradictory samples. A new GSPro version or conflicting pair returns that ID to `unknown`.
6. **Only then automate.** Prefer actual readable HUD surface labels in a bounded native capture for immediate shot state; use numeric code crosswalk where corroborated; use OSM surfaces as uncertain map fallback. Keep physical lie modifiers separate from landing-hazard semantics.

## Hard club policy, independent of surfaces

Driver and Mini Driver are tee-only **by identity** in `clubShotEligibility.ts` and excluded before full-shot candidate/risk evaluation and decision ranking when current shot origin is not explicitly tee. A manual Deep Rough correction changes the surface flight prior but MUST NOT re-enable either driver. Shorter fairway woods/hybrids remain eligible. Offline Aim Lab can infer tee from its mapped tee polygon when there is no live GSPro state; live unknown is NOT tee.

## Field regression

- FarmLinks White H1, Round 255: shot 1 ~39.9 yd total; Shot 2 449.6 yd remaining, GSPro labeled **Deep Rough**, manual correction permitted. Driver and Mini Driver **must** be ineligible and their existing bag-rail buttons should show **TEE ONLY** disabled.
- New read-only Companion diagnostic `endingSurfaceRaw` is the required next data point; no extra shot or one-code global relabel should be requested merely to guess.
- Confirm live wind and slope are sourced from the current HUD and never override verified surface semantics.
