"""The loader's find stage: which golf-course outline it takes when the request's coordinates are off."""
import argparse
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "course_model"))
import find_course as fc  # noqa: E402


def way(osm_id, name, lat, lon, size=0.004):
    ring = [{"lat": lat, "lon": lon}, {"lat": lat + size, "lon": lon}, {"lat": lat + size, "lon": lon + size},
            {"lat": lat, "lon": lon + size}, {"lat": lat, "lon": lon}]
    return {"type": "way", "id": osm_id, "tags": {"name": name}, "geometry": ring}


def args(**over):
    base = {"name_regex": "Dunes.*West", "lat": 32.79, "lon": -79.88, "radius_m": 8000, "osm_id": None, "osm_type": None}
    return argparse.Namespace(**{**base, **over})


class FakeOverpass:
    """Answers the near query, the by-id query and the wide query from fixed lists."""

    def __init__(self, near=(), by_id=(), wide=()):
        self.near, self.by_id, self.wide, self.asked = list(near), list(by_id), list(wide), []

    def __call__(self, query):
        self.asked.append(query)
        if '["name"~' in query:
            return {"elements": self.wide}
        if "around:" in query:
            return {"elements": self.near}
        return {"elements": self.by_id}


class FindTests(unittest.TestCase):
    def test_name_match_nearby_wins_as_before(self):
        fake = FakeOverpass(near=[way(1, "Dunes West Golf Club", 32.79, -79.88), way(2, "Other Links", 32.79, -79.87)])
        best, how = fc.find(args(), re.compile("Dunes.*West", re.I), fake)
        self.assertEqual((best["id"], how), (1, "near"))
        self.assertEqual(len(fake.asked), 1)

    def test_osm_id_far_from_the_coordinates_is_fetched_by_id(self):
        # Dunes West: the crosswalk had the right outline but coordinates 15 km off.
        fake = FakeOverpass(near=[way(2, "Charleston Municipal", 32.79, -79.88)],
                            by_id=[way(15701177, "Dunes West Golf Club", 32.92, -79.83)])
        best, how = fc.find(args(osm_id=15701177, osm_type="way"), re.compile("Dunes.*West", re.I), fake)
        self.assertEqual((best["id"], how), (15701177, "by id"))
        self.assertIn("way(15701177);", fake.asked[1])
        self.assertNotIn("relation(15701177)", fake.asked[1])

    def test_osm_id_nearby_is_taken_even_without_a_name_match(self):
        fake = FakeOverpass(near=[way(7, "", 32.79, -79.88), way(8, "Dunes West", 32.795, -79.88, size=0.01)])
        best, how = fc.find(args(osm_id=7), re.compile("Dunes.*West", re.I), fake)
        self.assertEqual((best["id"], how), (7, "near"))

    def test_nothing_named_nearby_searches_wider_and_takes_the_nearest(self):
        fake = FakeOverpass(near=[way(2, "Starmount Forest Country Club", 36.01, -79.89)],
                            wide=[way(3, "Sedgefield Country Club", 36.03, -79.85),
                                  way(4, "Sedgefield Golf Course", 36.25, -79.60)])
        best, how = fc.find(args(name_regex="Sedgefield", lat=36.0138, lon=-79.8878), re.compile("Sedgefield", re.I), fake)
        self.assertEqual((best["id"], how), (3, "wide"))
        self.assertIn(f"around:{fc.WIDE_RADIUS_M}", fake.asked[-1])

    def test_nothing_anywhere(self):
        best, how = fc.find(args(), re.compile("Dunes.*West", re.I), FakeOverpass())
        self.assertIsNone(best)

    def test_distance(self):
        c = fc.parse_candidates({"elements": [way(1, "x", 32.80, -79.88)]}, re.compile("x"))
        self.assertAlmostEqual(fc.distance_m(32.79, -79.88, c[0]) / 1000, 1.3, delta=0.2)


if __name__ == "__main__":
    unittest.main()
