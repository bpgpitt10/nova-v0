#!/usr/bin/env python3
from pathlib import Path


def replace_one(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


path = Path('src/pages/LiveCaddiePage.tsx')
text = path.read_text(encoding='utf-8')
text = replace_one(
    text,
    "import { greywolfHole01Geometry } from '../courseGeometry/greywolfHole01'\nimport {\n  loadGreywolfGreenDetail,\n  sampleGreywolfGreenElevation,\n  type GreywolfGreenDetail,\n} from '../courseGeometry/greywolfGreenDetail'\n",
    "import { greywolfHole01Geometry } from '../courseGeometry/greywolfHole01'\nimport {\n  loadCourseGreenDetail,\n  sampleCourseGreenElevation as sampleGreywolfGreenElevation,\n  type CourseGreenDetail as GreywolfGreenDetail,\n} from '../courseGeometry/courseGreenDetail'\n",
    'green detail import',
)
text = replace_one(
    text,
    "  useEffect(() => {\n    let active = true\n    setGreenDetail(null)\n    if (courseId !== GREYWOLF_COURSE_ID) return () => { active = false }\n    void loadGreywolfGreenDetail(holeNumber).then((detail) => {\n      if (active) setGreenDetail(detail)\n    })\n    return () => {\n      active = false\n    }\n  }, [courseId, holeNumber])",
    "  useEffect(() => {\n    let active = true\n    setGreenDetail(null)\n    if (!selectedCourse) return () => { active = false }\n    void loadCourseGreenDetail(selectedCourse.slug, holeNumber).then((detail) => {\n      if (active) setGreenDetail(detail)\n    })\n    return () => {\n      active = false\n    }\n  }, [selectedCourse?.slug, holeNumber])",
    'green detail loading effect',
)
text = replace_one(
    text,
    "    const refinedGreenTarget = courseId === GREYWOLF_COURSE_ID\n      && greenDetail\n",
    "    const refinedGreenTarget = greenDetail\n",
    'refined target course guard',
)
text = replace_one(
    text,
    "  const greenBallElevationFt = courseId === GREYWOLF_COURSE_ID && greenDetail\n    ? sampleGreywolfGreenElevation(greenDetail, ball)\n    : null",
    "  const greenBallElevationFt = greenDetail\n    ? sampleGreywolfGreenElevation(greenDetail, ball)\n    : null",
    'ball green elevation guard',
)
text = replace_one(
    text,
    "  const greenTargetElevationFt = courseId === GREYWOLF_COURSE_ID && greenDetail\n    ? sampleGreywolfGreenElevation(greenDetail, target)\n    : null",
    "  const greenTargetElevationFt = greenDetail\n    ? sampleGreywolfGreenElevation(greenDetail, target)\n    : null",
    'target green elevation guard',
)
text = replace_one(
    text,
    "  const greenGuidance = !isGreenSurface\n    && courseId === GREYWOLF_COURSE_ID\n    && hole\n",
    "  const greenGuidance = !isGreenSurface\n    && hole\n",
    'green guidance course guard',
)
text = replace_one(
    text,
    "        greenDetail:\n          courseId === GREYWOLF_COURSE_ID\n          && liveMatchesHole\n          && liveSnapshot?.pinSource === 'output-log-course-layout'\n            ? greenDetail\n            : null,",
    "        greenDetail:\n          liveMatchesHole\n          && liveSnapshot?.pinSource === 'output-log-course-layout'\n            ? greenDetail\n            : null,",
    'worker green detail course guard',
)
path.write_text(text, encoding='utf-8')
