#!/usr/bin/env python3
from pathlib import Path


def replace_one(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


# --- aimOptimization.ts ----------------------------------------------------
path = Path('src/liveCaddie/aimOptimization.ts')
text = path.read_text(encoding='utf-8')
text = replace_one(
    text,
    "import { classifyPoint } from '../courseGeometry/geometry'\n",
    "import { classifyPoint } from '../courseGeometry/geometry'\nimport type { GreywolfGreenDetail } from '../courseGeometry/greywolfGreenDetail'\n",
    'aim import green detail',
)
text = replace_one(
    text,
    "import { buildLiveCaddieProfileSet } from './profileProvider'\n",
    "import { redirectGreywolfGreenRollout } from './greenTargeting'\nimport { buildLiveCaddieProfileSet } from './profileProvider'\n",
    'aim import rollout',
)
text = replace_one(
    text,
    "  lieLeftRightDeg?: number | null\n  lieSource?: string\n  /**\n   * Optional per-club strategic target.",
    "  lieLeftRightDeg?: number | null\n  lieSource?: string\n  /** Exact GSPro pin in the same hole-local coordinate system as the course geometry. */\n  exactPinLocalYds?: CoursePointYds | null\n  /** Optional 1 yd Greywolf green grid used to shape destination rollout. */\n  greenDetail?: GreywolfGreenDetail | null\n  /**\n   * Optional per-club strategic target.",
    'aim environment fields',
)
text = replace_one(
    text,
    "  const geometrySurface = classifyPoint(hole, ball).kind\n  const ballSurface = environment.surfaceOverride?.trim() || geometrySurface\n\n  const evaluations = profileSet.clubs.map((profile): ClubAimEvaluation => {",
    "  const geometrySurface = classifyPoint(hole, ball).kind\n  const ballSurface = environment.surfaceOverride?.trim() || geometrySurface\n  const exactPinLocalYds = environment.exactPinLocalYds ?? hole.markers.pin ?? null\n  const greenLandingTransform = environment.greenDetail\n    ? (carryLanding: CoursePointYds, baselineLanding: CoursePointYds) =>\n        redirectGreywolfGreenRollout({\n          hole,\n          detail: environment.greenDetail!,\n          carryLanding,\n          baselineLanding,\n        }).landing\n    : undefined\n\n  const evaluations = profileSet.clubs.map((profile): ClubAimEvaluation => {",
    'aim rollout transform setup',
)
text = replace_one(
    text,
    "        totalSigmaYds: profile.total_sigma_yds,\n        lateralSigmaYds: profile.lateral_sigma_yds,\n      })",
    "        totalSigmaYds: profile.total_sigma_yds,\n        lateralSigmaYds: profile.lateral_sigma_yds,\n        pinLocalYds: exactPinLocalYds,\n        landingTransform: greenLandingTransform,\n      })",
    'aim sample args',
)
text = replace_one(
    text,
    "        carryAdjustmentYds: empiricalCarryAdjustmentYds,\n        lateralAdjustmentYds: empiricalLateralAdjustmentYds,\n      })",
    "        carryAdjustmentYds: empiricalCarryAdjustmentYds,\n        lateralAdjustmentYds: empiricalLateralAdjustmentYds,\n        pinLocalYds: exactPinLocalYds,\n        landingTransform: greenLandingTransform,\n      })",
    'aim risk args',
)
path.write_text(text, encoding='utf-8')


# --- LiveCaddiePage.tsx ----------------------------------------------------
path = Path('src/pages/LiveCaddiePage.tsx')
text = path.read_text(encoding='utf-8')
text = replace_one(
    text,
    "        lieUpDownDeg,\n        lieLeftRightDeg,\n        lieSource,\n      },",
    "        lieUpDownDeg,\n        lieLeftRightDeg,\n        lieSource,\n        exactPinLocalYds:\n          liveMatchesHole && liveSnapshot?.pinSource === 'output-log-course-layout'\n            ? liveSnapshot.pinLocalYds\n            : null,\n        greenDetail:\n          courseId === GREYWOLF_COURSE_ID\n          && liveMatchesHole\n          && liveSnapshot?.pinSource === 'output-log-course-layout'\n            ? greenDetail\n            : null,\n      },",
    'page worker environment',
)
text = replace_one(
    text,
    "    lieLeftRightDeg,\n    lieSource,\n  ])",
    "    lieLeftRightDeg,\n    lieSource,\n    courseId,\n    greenDetail,\n    liveMatchesHole,\n    liveSnapshot?.pinLocalYds,\n    liveSnapshot?.pinSource,\n  ])",
    'page worker dependencies',
)
path.write_text(text, encoding='utf-8')


# --- LiveCaddieWorker.ts ---------------------------------------------------
path = Path('src/pages/LiveCaddieWorker.ts')
text = path.read_text(encoding='utf-8')
text = replace_one(
    text,
    "import { estimateGreywolfTerrain as estimateCourseTerrain } from '../courseGeometry/lidar'\n",
    "import { sampleGreywolfGreenElevation } from '../courseGeometry/greywolfGreenDetail'\nimport { estimateGreywolfTerrain as estimateCourseTerrain } from '../courseGeometry/lidar'\n",
    'worker green elevation import',
)
text = replace_one(
    text,
    "const EVALUATION_CACHE_NAME = 'looper-live-caddie-evaluations-v7'",
    "const EVALUATION_CACHE_NAME = 'looper-live-caddie-evaluations-v8'",
    'worker cache version',
)
text = replace_one(
    text,
    "    pin: request.hole.markers.pin ?? null,",
    "    pin: request.environment.exactPinLocalYds ?? request.hole.markers.pin ?? null,",
    'worker exact pin descriptor',
)
text = replace_one(
    text,
    "  const landing = modeledCarryLandingPoint(evaluation, ball)\n  const landingTerrain = estimateCourseTerrain(hole, landing)\n  if (!landingTerrain) return fallback\n\n  return {",
    "  const landing = modeledCarryLandingPoint(evaluation, ball)\n  const greenLandingElevationFt = environment.greenDetail\n    ? sampleGreywolfGreenElevation(environment.greenDetail, landing)\n    : null\n  if (greenLandingElevationFt != null) {\n    return {\n      deltaFt: greenLandingElevationFt - ballTerrain.elevationFt,\n      source: 'modeled carry landing · 1 yd green LiDAR',\n      fromTerrain: true,\n    }\n  }\n\n  const landingTerrain = estimateCourseTerrain(hole, landing)\n  if (!landingTerrain) return fallback\n\n  return {",
    'worker detailed landing elevation',
)
text = replace_one(
    text,
    "      lieUpDownDeg: finiteKeyNumber(environment.lieUpDownDeg),\n      lieLeftRightDeg: finiteKeyNumber(environment.lieLeftRightDeg),\n    },",
    "      lieUpDownDeg: finiteKeyNumber(environment.lieUpDownDeg),\n      lieLeftRightDeg: finiteKeyNumber(environment.lieLeftRightDeg),\n      exactPinLocalYds: environment.exactPinLocalYds\n        ? [\n            finiteKeyNumber(environment.exactPinLocalYds[0]),\n            finiteKeyNumber(environment.exactPinLocalYds[1]),\n          ]\n        : null,\n      greenDetail: environment.greenDetail\n        ? [\n            environment.greenDetail.holeNumber,\n            environment.greenDetail.grid.spacingYds,\n            environment.greenDetail.grid.width,\n            environment.greenDetail.grid.height,\n            finiteKeyNumber(environment.greenDetail.greenSummary.meanElevationFt),\n            finiteKeyNumber(environment.greenDetail.greenSummary.elevationRangeFt),\n          ]\n        : null,\n    },",
    'worker cache environment signature',
)
path.write_text(text, encoding='utf-8')
