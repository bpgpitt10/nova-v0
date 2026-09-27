#!/usr/bin/env python3
from pathlib import Path


def replace_all(path: str, replacements: list[tuple[str, str]]) -> None:
    file = Path(path)
    text = file.read_text(encoding='utf-8')
    for old, new in replacements:
        if old not in text:
            raise RuntimeError(f'{path}: missing expected text {old!r}')
        text = text.replace(old, new)
    file.write_text(text, encoding='utf-8')


replace_all('src/liveCaddie/greenTargeting.ts', [
    ("  greenSectorAtPoint,\n  sampleGreywolfGreenElevation,\n  type GreywolfGreenDetail,\n} from '../courseGeometry/greywolfGreenDetail'",
     "  courseGreenSectorAtPoint as greenSectorAtPoint,\n  sampleCourseGreenElevation,\n  type CourseGreenDetail,\n} from '../courseGeometry/courseGreenDetail'"),
    ('GreywolfGreenDetail', 'CourseGreenDetail'),
    ('sampleGreywolfGreenElevation', 'sampleCourseGreenElevation'),
    ("source: 'greywolf-green-lidar-1yd'", "source: 'course-green-lidar-1yd'"),
    ('sampleGreywolfGreenSlopeAtPoint', 'sampleCourseGreenSlopeAtPoint'),
    ('redirectGreywolfGreenRollout', 'redirectCourseGreenRollout'),
    ('buildGreywolfGreenApproachTarget', 'buildCourseGreenApproachTarget'),
])

replace_all('src/liveCaddie/aimOptimization.ts', [
    ("import type { GreywolfGreenDetail } from '../courseGeometry/greywolfGreenDetail'",
     "import type { CourseGreenDetail } from '../courseGeometry/courseGreenDetail'"),
    ("import { redirectGreywolfGreenRollout } from './greenTargeting'",
     "import { redirectCourseGreenRollout } from './greenTargeting'"),
    ('GreywolfGreenDetail', 'CourseGreenDetail'),
    ('redirectGreywolfGreenRollout', 'redirectCourseGreenRollout'),
    ('Optional 1 yd Greywolf green grid used to shape destination rollout.',
     'Optional high-resolution course green grid used to shape destination rollout.'),
])

replace_all('src/pages/LiveCaddieWorker.ts', [
    ("import { sampleGreywolfGreenElevation } from '../courseGeometry/greywolfGreenDetail'",
     "import { sampleCourseGreenElevation } from '../courseGeometry/courseGreenDetail'"),
    ('sampleGreywolfGreenElevation', 'sampleCourseGreenElevation'),
])

replace_all('src/pages/LiveCaddiePage.tsx', [
    ('  sampleCourseGreenElevation as sampleGreywolfGreenElevation,\n  type CourseGreenDetail as GreywolfGreenDetail,',
     '  sampleCourseGreenElevation,\n  type CourseGreenDetail,'),
    ('useState<GreywolfGreenDetail | null>', 'useState<CourseGreenDetail | null>'),
    ('sampleGreywolfGreenElevation', 'sampleCourseGreenElevation'),
    ("import { buildGreywolfGreenApproachTarget } from '../liveCaddie/greenTargeting'",
     "import { buildCourseGreenApproachTarget } from '../liveCaddie/greenTargeting'"),
    ('buildGreywolfGreenApproachTarget', 'buildCourseGreenApproachTarget'),
    ('High-resolution 1 yd Greywolf green LiDAR sample.',
     'High-resolution course green terrain sample.'),
])
