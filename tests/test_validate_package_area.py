"""The package validator on a whole-area package (DPC Sodgrass, 11/6).

build_area_package.py lists greens by latLon in a heading-0 frame about
area.coordinateFrame.anchorLatLon; the validator must place them in that
frame before judging them against the area box, or every green "fails".

Run: python3 -m pytest -q tests/test_validate_package_area.py
"""
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools' / 'course_model'))
import validate_package as vp  # noqa: E402

ANCHOR = [30.24, -81.3853]


def green_at(east_yds: float, north_yds: float) -> dict:
    lat = ANCHOR[0] + math.degrees(north_yds / vp.M_TO_YD / vp.EARTH_R_M)
    lon = ANCHOR[1] + math.degrees(east_yds / vp.M_TO_YD / vp.EARTH_R_M / math.cos(math.radians(ANCHOR[0])))
    return {'id': f'way/{int(east_yds)}-{int(north_yds)}', 'latLon': [round(lat, 7), round(lon, 7)], 'areaSqYds': 600.0}


def area_package(greens: list[dict]) -> dict:
    return {
        'schemaVersion': 'looper-course-area-v1',
        'courseId': 'dpc-sodgrass', 'courseName': 'DPC Sodgrass',
        'provenance': {'geometrySource': 'osm-course-area'},
        'area': {
            'coordinateFrame': {'anchorLatLon': ANCHOR, 'headingDegreesTrue': 0.0, 'origin': 'area-centre'},
            'viewBounds': {'minX': -900.0, 'maxX': 900.0, 'minY': -700.0, 'maxY': 700.0},
            'greens': greens,
            'surfaces': {'green': [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]},
            'terrain': {'minX': -900.0, 'maxX': 900.0, 'minY': -700.0, 'maxY': 700.0, 'spacingYds': 100.0,
                        'columns': 18, 'rows': 14, 'values': [1.0] * (18 * 14)},
        },
    }


def run(pkg: dict, tmp_path: Path) -> vp.Report:
    path = tmp_path / 'course-area-v1.json'
    path.write_text(json.dumps(pkg))
    return vp.validate_file(path)


def test_latlon_greens_inside_the_box_pass(tmp_path):
    greens = [green_at(-800 + 80 * i, -600 + 60 * i) for i in range(20)]
    rep = run(area_package(greens), tmp_path)
    assert rep.ok, rep.hard
    assert not [m for m in rep.soft if 'no position' in m], rep.soft


def test_a_green_far_outside_the_box_still_fails(tmp_path):
    greens = [green_at(-800 + 80 * i, -600 + 60 * i) for i in range(19)] + [green_at(4000, 0)]
    rep = run(area_package(greens), tmp_path)
    assert [m for m in rep.hard if m == 'green 20 outside the area box'], rep.hard


def test_a_local_centre_is_still_accepted(tmp_path):
    greens = [{'id': f'g{i}', 'center': [-800 + 80 * i, 0]} for i in range(20)]
    rep = run(area_package(greens), tmp_path)
    assert not [m for m in rep.hard if 'outside the area box' in m], rep.hard


def test_a_green_with_no_position_is_a_warning_not_a_failure(tmp_path):
    greens = [green_at(-800 + 80 * i, 0) for i in range(19)] + [{'id': 'odd'}]
    rep = run(area_package(greens), tmp_path)
    assert not [m for m in rep.hard if 'outside the area box' in m], rep.hard
    assert any('no position' in m for m in rep.soft), rep.soft
