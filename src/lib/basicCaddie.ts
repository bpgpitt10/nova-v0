/**
 * A course with no Looper map: fictional, or real but not mapped. The caddie plays from GSPro's own
 * course file (gsproOnlyCourse.ts). The same words everywhere it shows: Live Caddie, Start a Round's
 * course picker and the Load page (Brian, 25 Nov: "so it's clear they're not getting everything").
 */
export const BASIC_CADDIE_WORKS = [
  'Yardages to the pin',
  'Club picks from your bag',
  "GSPro's penalty areas and out of bounds",
  'Tees and pin positions',
  'Shot tracking and club tagging',
] as const

export const BASIC_CADDIE_MISSING = [
  'Fairway, rough and bunker outlines',
  'Trees',
  'Green slopes and putt reads',
] as const

export const BASIC_CADDIE_SUMMARY =
  "No Looper map for this course, so the caddie works from what GSPro itself knows about it."
