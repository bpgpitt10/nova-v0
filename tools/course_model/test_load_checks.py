"""The loader's up-front OpenStreetMap checks (Kenai and We-Ko-Pa, 24 Nov). Run: python3 tools/course_model/test_load_checks.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import find_course  # noqa: E402
import load_course  # noqa: E402

# A square outline about 1.1 km across.
RING = [(-111.70, 33.58), (-111.69, 33.58), (-111.69, 33.59), (-111.70, 33.59), (-111.70, 33.58)]


def way(golf: str, lon: float, lat: float, ref: str | None = None) -> dict:
    tags = {'golf': golf, **({'ref': ref} if ref else {})}
    return {'tags': tags, 'geometry': [{'lon': lon, 'lat': lat}, {'lon': lon + 0.0004, 'lat': lat + 0.0004}]}


def greens(n: int) -> list[dict]:
    return [way('green', -111.699 + 0.0005 * i, 33.582) for i in range(n)]


def holes(numbers, lat: float) -> list[dict]:
    return [way('hole', -111.699 + 0.0005 * i, lat, str(n)) for i, n in enumerate(numbers)]


def bbox_with(elements: list[dict], sub=None) -> dict:
    choices = [{'name': n, 'osmType': 'way', 'osmId': i, 'lat': 33.58, 'lon': -111.69} for i, n in enumerate(sub or [])]
    return {'osmGolf': find_course.golf_counts(elements, [RING]), **({'courseChoices': choices} if choices else {})}


# Kenai: 16 greens, no hole lines.
kenai = load_course.early_reject(bbox_with(greens(16)))
assert kenai and kenai['errorCode'] == 'holes_not_mapped', kenai
assert '16 of this course' in kenai['errorMessage'] and 'none of its holes' in kenai['errorMessage'], kenai
assert kenai['courseChoices'] == [], kenai

# We-Ko-Pa Golf Club: holes 1-18 drawn twice, about 700 m apart, inside one outline.
club = bbox_with(greens(36) + holes(range(1, 19), 33.581) + holes(range(1, 19), 33.5875), ['Cholla', 'Saguaro'])
assert club['osmGolf']['holesTwice'] == list(range(1, 19)), club['osmGolf']
wk = load_course.early_reject(club)
assert wk and wk['errorCode'] == 'multiple_courses' and '(Cholla, Saguaro)' in wk['errorMessage'], wk
assert [c['name'] for c in wk['courseChoices']] == ['Cholla', 'Saguaro'], wk

# A normal 18 and a complete 9: carry on.
assert load_course.early_reject(bbox_with(greens(18) + holes(range(1, 19), 33.581))) is None
assert load_course.early_reject(bbox_with(greens(9) + holes(range(1, 10), 33.581))) is None
# No holes but all 18 greens: loads as a map area, so carry on.
assert load_course.early_reject(bbox_with(greens(18))) is None
# Hole lines outside the outline don't count as this course's holes.
outside = bbox_with(greens(10) + holes(range(1, 19), 33.60))
assert outside['osmGolf']['holesNumbered'] == [] and load_course.early_reject(outside)['errorCode'] == 'holes_not_mapped'
# Older loads (no counts in the box): never rejected here.
assert load_course.early_reject({}) is None

# The importer's duplicate-hole error still stops a two-course outline if it gets that far.
err = ["ValueError: OpenStreetMap doesn't have exactly one route per hole 1-18 inside the course boundary; "
       "holes mapped twice in different places: [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]. (missing=[]"]
assert load_course.holes_mapped_twice(err) == [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]
assert load_course.holes_mapped_twice(['holes missing: [1, 2]']) == []
print('load checks ok')
