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


def rectangular_tee(osm_id, lat, lon, tags=None):
    return way(osm_id, {"golf": "tee", **(tags or {})}, [
        (lat - 0.00004, lon - 0.00006),
        (lat + 0.00004, lon - 0.00006),
        (lat + 0.00004, lon + 0.00006),
        (lat - 0.00004, lon + 0.00006),
        (lat - 0.00004, lon - 0.00006),
    ])


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
                rectangular_tee(401, 40.00003, -75.0000, {
                    "tee": "blue",
                    "name": "Blue Tees",
                    "colour": "blue",
                }),
                rectangular_tee(402, 39.99981, -75.0000, {
                    "tee": "white",
                    "name": "White Tees",
                    "ref": "W",
                }),
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

    def test_unlabeled_tee_geometry_gets_canonical_course_wide_identity(self):
        payload = {
            "elements": [
                way(101, {"golf": "hole", "ref": "1", "par": "4"}, [
                    (40.0000, -75.0000),
                    (40.0040, -75.0000),
                ]),
                way(201, {"golf": "green"}, [
                    (40.00395, -75.00008),
                    (40.00405, -75.00008),
                    (40.00405, -74.99992),
                    (40.00395, -74.99992),
                    (40.00395, -75.00008),
                ]),
                way(301, {"golf": "fairway"}, [
                    (40.00040, -75.00010),
                    (40.00375, -75.00010),
                    (40.00375, -74.99990),
                    (40.00040, -74.99990),
                    (40.00040, -75.00010),
                ]),
                rectangular_tee(401, 39.99970, -75.0000),
                rectangular_tee(402, 39.99995, -75.0000),
                rectangular_tee(403, 40.00020, -75.0000),
            ]
        }
        features, hole_routes = v6.normalize_osm(payload)
        config = {
            "courseId": "synthetic-unlabeled",
            "courseName": "Synthetic Unlabeled",
            "location": "Test",
            "selection": {
                "teeStartRadiusYards": 220,
                "contextRouteDistanceYards": 90,
                "fairwayCorridorYards": 70,
                "hazardCorridorYards": 70,
                "geometrySimplifyYards": 0.25,
            },
            "holes": {"1": {"par": 4, "targetYards": 450}},
        }

        model, diagnostic = v6.model_for_hole(1, config, features, hole_routes)
        candidates = model["teeCandidates"]
        expected = ["Tee 1 (Back)", "Tee 2", "Tee 3 (Front)"]

        self.assertEqual(diagnostic["courseTeeSets"], expected)
        self.assertEqual(model["teeSetContract"]["teeSets"], expected)
        self.assertEqual({candidate["teeSet"] for candidate in candidates}, set(expected))
        self.assertEqual(
            {alias for candidate in candidates for alias in candidate["teeAliases"]},
            set(expected),
        )
        self.assertTrue(all(candidate["sourceTags"].get("golf") == "tee" for candidate in candidates))

    def test_fewer_physical_boxes_still_resolve_every_course_tee_set_once(self):
        slots = [
            {"index": 0, "label": "Tee 1 (Back)", "normalized": "tee 1 (back)", "sourceKey": None},
            {"index": 1, "label": "Tee 2", "normalized": "tee 2", "sourceKey": None},
            {"index": 2, "label": "Tee 3", "normalized": "tee 3", "sourceKey": None},
            {"index": 3, "label": "Tee 4", "normalized": "tee 4", "sourceKey": None},
            {"index": 4, "label": "Tee 5 (Front)", "normalized": "tee 5 (front)", "sourceKey": None},
        ]
        records = [
            {"sourceLabel": None},
            {"sourceLabel": None},
            {"sourceLabel": None},
        ]
        assignments = v6._slot_assignments(records, slots)
        flattened = [label for aliases in assignments.values() for label in aliases]
        self.assertCountEqual(flattened, [slot["label"] for slot in slots])
        self.assertEqual(len(flattened), len(set(flattened)))
        self.assertTrue(any(len(aliases) > 1 for aliases in assignments.values()))


if __name__ == "__main__":
    unittest.main()