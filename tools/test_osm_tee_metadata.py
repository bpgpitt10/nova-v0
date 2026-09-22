#!/usr/bin/env python3

import unittest

import build_osm_course_package_v6 as v6


def point(lat, lon):
    return {"lat": lat, "lon": lon}


def way(osm_id, tags, coordinates):
    return {
        "type": "way",
        "id": osm_id,
        "tags": tags,
        "geometry": [point(lat, lon) for lat, lon in coordinates],
    }


class TeeMetadataTests(unittest.TestCase):
    def test_owned_tee_candidates_keep_tags_and_local_geometry(self):
        payload = {
            "elements": [
                way(101, {"golf": "hole", "ref": "1", "par": "4"}, [
                    (40.0000, -75.0000),
                    (40.0030, -75.0000),
                ]),
                way(102, {"golf": "hole", "ref": "2", "par": "4"}, [
                    (40.0000, -74.9900),
                    (40.0030, -74.9900),
                ]),
                way(201, {"golf": "green"}, [
                    (40.00295, -75.00008),
                    (40.00305, -75.00008),
                    (40.00305, -74.99992),
                    (40.00295, -74.99992),
                    (40.00295, -75.00008),
                ]),
                way(301, {"golf": "fairway"}, [
                    (40.00035, -75.00010),
                    (40.00275, -75.00010),
                    (40.00275, -74.99990),
                    (40.00035, -74.99990),
                    (40.00035, -75.00010),
                ]),
                way(401, {
                    "golf": "tee",
                    "tee": "blue",
                    "name": "Blue Tees",
                    "colour": "blue",
                }, [
                    (39.99998, -75.00006),
                    (40.00008, -75.00006),
                    (40.00008, -74.99994),
                    (39.99998, -74.99994),
                    (39.99998, -75.00006),
                ]),
                way(402, {
                    "golf": "tee",
                    "tee": "white",
                    "name": "White Tees",
                    "ref": "W",
                }, [
                    (39.99976, -75.00006),
                    (39.99986, -75.00006),
                    (39.99986, -74.99994),
                    (39.99976, -74.99994),
                    (39.99976, -75.00006),
                ]),
            ]
        }
        features, hole_routes = v6.normalize_osm(payload)
        tee_features = [feature for feature in features if feature["kind"] == "tee"]
        self.assertEqual({feature["source_tags"].get("tee") for feature in tee_features}, {"blue", "white"})

        config = {
            "courseId": "synthetic",
            "courseName": "Synthetic",
            "location": "Test",
            "selection": {
                "teeStartRadiusYards": 220,
                "contextRouteDistanceYards": 90,
                "fairwayCorridorYards": 70,
                "hazardCorridorYards": 70,
                "geometrySimplifyYards": 0.25,
            },
            "holes": {"1": {"par": 4, "targetYards": 365}},
        }
        model, diagnostic = v6.model_for_hole(1, config, features, hole_routes)
        candidates = model["teeCandidates"]

        self.assertEqual(len(candidates), 2)
        self.assertEqual({candidate["teeSet"] for candidate in candidates}, {"blue", "white"})
        self.assertEqual({candidate["osmId"] for candidate in candidates}, {401, 402})
        self.assertEqual(sum(1 for candidate in candidates if candidate["selectedAnchor"]), 1)
        self.assertTrue(all(len(candidate["coursePoint"]) == 2 for candidate in candidates))
        self.assertTrue(all(candidate["polygons"] for candidate in candidates))
        self.assertTrue(all(candidate["teeToGreenCentroidYards"] > 0 for candidate in candidates))
        self.assertEqual(diagnostic["ownedTeeCandidateCount"], 2)

        blue = next(candidate for candidate in candidates if candidate["teeSet"] == "blue")
        self.assertEqual(blue["color"], "blue")
        self.assertEqual(blue["sourceTags"]["name"], "Blue Tees")

        white = next(candidate for candidate in candidates if candidate["teeSet"] == "white")
        self.assertEqual(white["ref"], "W")
        self.assertNotEqual(blue["coursePoint"], white["coursePoint"])


if __name__ == "__main__":
    unittest.main()
