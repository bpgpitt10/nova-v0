"""Tests for gkd_native on a synthetic GKD (no third-party course data).

Run: python3 -m unittest tools/course_model/test_gkd_native.py
"""
import json
import math
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gkd_native as g  # noqa: E402


def pos(x, z, y=10.0):
    return {'x': x, 'y': y, 'z': z}


def synthetic_gkd():
    # Tee (0,0) -> AimPoint1 (0,100) -> green centre (30,140): 100 + 50 = 150 m.
    return {
        'gkversion': 2.0, 'CourseName': 'Synthetic Links',
        'Holes': [{
            'HoleNumber': 1, 'Par': 4, 'Index': 7,
            'Tees': [
                {'TeeType': 'Black', 'Enabled': True, 'Distance': 150.0, 'Position': pos(0, 0)},
                {'TeeType': 'White', 'Enabled': True, 'Distance': 130.0, 'Position': pos(0, 20)},
                {'TeeType': 'Red', 'Enabled': True, 'Distance': 129.0, 'Position': pos(1, 21)},
                {'TeeType': 'Yellow', 'Enabled': True, 'Distance': 0.0, 'Position': None},
                {'TeeType': 'AimPoint1', 'Enabled': True, 'Distance': 0.0, 'Position': pos(0, 100)},
                {'TeeType': 'AimPoint2', 'Enabled': True, 'Distance': 0.0, 'Position': None},
                {'TeeType': 'GreenCenterPoint', 'Enabled': False, 'Distance': 0.0, 'Position': pos(30, 140)},
            ],
            'Pins': [
                {'Day': 'Thursday', 'Position': pos(30, 135)},
                {'Day': 'Friday', 'Position': pos(36, 150)},
            ],
        }],
        'Hazards': [
            {'pointCount': 4, 'coords': [pos(50, 50, 5.0), pos(60, 50, 5.1), pos(60, 60, 5.0), pos(50, 60, 4.9)],
             'DZpos': pos(0, 0, 0), 'hasDZ': False, 'freeDrop': False, 'innerOOB': False,
             'islandGreen': False, 'noAIL': False},
            {'pointCount': 4, 'coords': [pos(-50, 50, 5.0), pos(-40, 50, 9.0), pos(-40, 60, 14.0), pos(-50, 60, 2.0)],
             'DZpos': pos(-45, 40, 6.0), 'hasDZ': True, 'freeDrop': True, 'innerOOB': False,
             'islandGreen': False, 'noAIL': False},
        ],
        'pOOB': {'pointCount': 3, 'coords': [pos(-200, -50), pos(200, -50), pos(0, 400)]},
    }


class GkdNativeTests(unittest.TestCase):
    def setUp(self):
        self.course = g.normalize(synthetic_gkd(), 'sha-test')

    def test_tee_distance_is_aim_route_metres(self):
        check = g.check_tee_distances(self.course)
        # Black matches 150 m exactly; White is 130 m vs route 80+50=130; Red 129 vs ~129.0.
        self.assertEqual(check['checked'], 3)
        self.assertEqual(check['mismatches'], [])

    def test_forward_tee_skips_aim_points_behind_it(self):
        # A Par3-style tee at (20,120) is past AimPoint1 (0,100): route is straight to green.
        course = g.normalize(synthetic_gkd())
        tee = pos(20, 120)
        gc = g.hole(course, 1)['greenCenter']
        self.assertAlmostEqual(g.route_distance_m(tee, g.hole(course, 1)['aimPoints'], gc),
                               math.hypot(10, 20), places=9)

    def test_null_positions_skipped(self):
        h = g.hole(self.course, 1)
        self.assertNotIn('Yellow', h['tees'])
        self.assertEqual(len(h['aimPoints']), 1)

    def test_tee_from_starting_pos(self):
        r = g.resolve_tee(self.course, 1, pos(0.0, 0.0))
        self.assertEqual((r['status'], r['tee']), ('matched', 'Black'))
        r = g.resolve_tee(self.course, 1, pos(0.3, 20.2))
        self.assertEqual(r['status'], 'ambiguous-same-spot')
        self.assertEqual(set(r['candidates']), {'White', 'Red'})
        self.assertEqual(g.resolve_tee(self.course, 1, pos(80, 80))['status'], 'no-match')

    def test_pin_slot_from_distance_to_pin(self):
        end = pos(30, 100)
        d1 = math.hypot(0, 35)
        r = g.resolve_pin(self.course, 1, end, d1)
        self.assertEqual((r['status'], r['slot'], r['label']), ('matched', 1, 'Thursday'))
        self.assertEqual(g.resolve_pin(self.course, 1, end, 999)['status'], 'no-match')

    def test_tee_hud_uses_route_to_active_pin(self):
        # Black -> AimPoint1 (100) -> pin slot 1 (30,135): 100 + sqrt(900+1225).
        expected = (100 + math.hypot(30, 35)) * g.METERS_TO_YARDS
        self.assertAlmostEqual(g.tee_hud_yards(self.course, 1, 'Black', 1), expected, places=6)

    def test_penalty_area_flags_and_hint(self):
        flat, steep = self.course['penaltyAreas']
        self.assertEqual(flat['surfaceHint'], 'likely-water')
        self.assertEqual(steep['surfaceHint'], 'likely-dry-or-mixed')
        self.assertTrue(steep['freeDrop'])
        self.assertIsNotNone(steep['dropZone'])
        self.assertIsNone(flat['dropZone'])

    def test_fingerprint_ignores_metadata_but_not_layout(self):
        raw = synthetic_gkd()
        raw['CourseName'] = 'Renamed'
        self.assertEqual(g.normalize(raw)['layoutFingerprint'], self.course['layoutFingerprint'])
        raw['Holes'][0]['Pins'][0]['Position']['x'] += 1.0
        self.assertNotEqual(g.normalize(raw)['layoutFingerprint'], self.course['layoutFingerprint'])

    def test_malformed_files_fail_closed(self):
        with tempfile.TemporaryDirectory() as d:
            bad = Path(d) / 'bad.GKD'
            bad.write_text('{"CourseName": "x"}')
            with self.assertRaises(g.GkdError):
                g.load_raw(bad)
            bad.write_text('not json')
            with self.assertRaises(g.GkdError):
                g.load_raw(bad)
            ok = Path(d) / 'ok.GKD'
            ok.write_bytes(b'\xef\xbb\xbf' + json.dumps(synthetic_gkd()).encode())
            raw, sha = g.load_raw(ok)
            self.assertEqual(len(sha), 64)


if __name__ == '__main__':
    unittest.main()
