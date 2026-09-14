#!/usr/bin/env python3
from __future__ import annotations

import json
import tempfile
import unittest
from collections import Counter
from pathlib import Path

import compile_course_geometry as compiler


REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG = REPO_ROOT / "config" / "course-geometry" / "greywolf-v1.json"
GENERATED = REPO_ROOT / "public" / "course-geometry" / "greywolf-v1.json"


class CourseGeometryCompilerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.package = compiler.compile_package(CONFIG)

    def test_greywolf_package_contract_and_gates(self) -> None:
        package = self.package
        self.assertEqual(package["schemaVersion"], compiler.SCHEMA_VERSION)
        self.assertEqual(package["course"]["holeCount"], 18)
        self.assertEqual(len(package["holes"]), 18)
        self.assertTrue(package["compilerDiagnostics"]["allHolesStaticGeometryReady"])
        self.assertTrue(package["compilerDiagnostics"]["allAnchorEvidenceWithinQuarterYard"])
        self.assertTrue(package["registration"]["validation"]["activationGatePassed"])
        self.assertLess(package["registration"]["validation"]["maxResidualYards"], 0.25)

    def test_polygon_and_multipolygon_topology_is_closed(self) -> None:
        for feature in self.package["features"]:
            geometry = feature["geometry"]
            if geometry["type"] == "Polygon":
                polygons = [geometry["coordinates"]]
            elif geometry["type"] == "MultiPolygon":
                polygons = geometry["coordinates"]
            else:
                continue
            for polygon in polygons:
                self.assertGreaterEqual(len(polygon), 1, feature["id"])
                for ring in polygon:
                    self.assertGreaterEqual(len(ring), 4, feature["id"])
                    self.assertEqual(ring[0], ring[-1], feature["id"])

    def test_spatial_index_covers_every_strategy_queryable_feature(self) -> None:
        expected = {
            feature["id"]
            for feature in self.package["features"]
            if feature["role"] in {"surface", "obstruction"}
        }
        indexed = {
            feature_id
            for feature_ids in self.package["spatialIndex"]["cells"].values()
            for feature_id in feature_ids
        }
        self.assertEqual(indexed, expected)

    def test_hole_views_reference_course_wide_features(self) -> None:
        feature_ids = {feature["id"] for feature in self.package["features"]}
        for hole in self.package["holes"]:
            view_ids = set(hole["view"]["featureIds"])
            self.assertTrue(view_ids <= feature_ids)
            self.assertIn(hole["anchors"]["selectedTee"]["featureId"], view_ids)
            self.assertIn(hole["anchors"]["targetGreen"]["featureId"], view_ids)
            self.assertFalse(hole["view"].get("features"), "hole views must not duplicate geometry")

    def test_hole_one_surface_set_matches_the_approved_render(self) -> None:
        hole = self.package["holes"][0]
        by_id = {feature["id"]: feature for feature in self.package["features"]}
        counts: dict[str, int] = {}
        for feature_id in hole["view"]["featureIds"]:
            feature = by_id[feature_id]
            if feature["role"] == "surface":
                counts[feature["kind"]] = counts.get(feature["kind"], 0) + 1
        self.assertEqual(counts, {
            "bunker": 4,
            "fairway": 2,
            "green": 1,
            "rough": 1,
            "tee": 1,
            "water": 2,
        })
        self.assertAlmostEqual(hole["view"]["clipBounds"]["minY"], -28.0)
        self.assertAlmostEqual(hole["view"]["clipBounds"]["maxY"], 391.726)

    def test_environment_is_generic_but_only_activated_for_hole_one(self) -> None:
        feature_by_id = {feature["id"]: feature for feature in self.package["features"]}
        environment = [
            feature
            for feature in self.package["features"]
            if feature["kind"] in {"woods", "scrub", "grass_context"}
        ]
        counts = Counter(feature["kind"] for feature in environment)
        self.assertEqual(counts, Counter({"woods": 88, "grass_context": 16, "scrub": 2}))
        self.assertTrue(all(
            feature["role"] == ("obstruction" if feature["kind"] in {"woods", "scrub"} else "context")
            for feature in environment
        ))

        hole_one = next(hole for hole in self.package["holes"] if hole["number"] == 1)
        hole_one_environment = {
            feature_id
            for feature_id in hole_one["view"]["featureIds"]
            if feature_by_id[feature_id]["kind"] in {"woods", "scrub", "grass_context"}
        }
        self.assertEqual(hole_one_environment, {"osm:way:1209222802", "osm:way:1209268500"})
        self.assertTrue(hole_one["quality"]["environmentPilotActive"])
        self.assertEqual(hole_one["quality"]["environmentFeatureCount"], 2)

        for hole in self.package["holes"][1:]:
            self.assertFalse(hole["quality"]["environmentPilotActive"])
            self.assertEqual(hole["quality"]["environmentFeatureCount"], 0)
            self.assertFalse(any(
                feature_by_id[feature_id]["kind"] in {"woods", "scrub", "grass_context"}
                for feature_id in hole["view"]["featureIds"]
            ))

    def test_source_labels_do_not_invent_bad_osm_par_values(self) -> None:
        by_number = {hole["number"]: hole for hole in self.package["holes"]}
        self.assertEqual(by_number[1]["par"]["value"], 4)
        self.assertIsNone(by_number[6]["par"]["value"])
        self.assertEqual(by_number[6]["par"]["rawOsmValue"], "6")
        self.assertIsNone(by_number[15]["par"]["value"])

    def test_wind_remains_required_external_gspro_ocr_state(self) -> None:
        contract = self.package["integrationContract"]
        wind = contract["wind"]
        self.assertFalse(contract["strategyAuthority"])
        self.assertEqual(contract["activation"], "render-and-strategy-shadow-only")
        self.assertTrue(wind["requiredForLiveDecisionSnapshot"])
        self.assertEqual(wind["source"], "gspro-screen-wind-panel")
        self.assertEqual(wind["failurePolicy"], "unavailable-never-assume-calm")
        self.assertFalse(wind["embeddedInStaticGeometry"])

    def test_relation_members_compile_as_real_multipolygon_with_inner_ring(self) -> None:
        def points(rows: list[tuple[float, float]]) -> list[dict[str, float]]:
            return [{"lat": lat, "lon": lon} for lat, lon in rows]

        relation = {
            "type": "relation",
            "id": 99,
            "tags": {"type": "multipolygon", "golf": "fairway"},
            "members": [
                {"role": "outer", "geometry": points([(0, 0), (0, 2), (2, 2)])},
                {"role": "outer", "geometry": points([(2, 2), (2, 0), (0, 0)])},
                {"role": "outer", "geometry": points([(4, 4), (4, 5), (5, 5), (5, 4), (4, 4)])},
                {"role": "inner", "geometry": points([(0.5, 0.5), (0.5, 1), (1, 1), (1, 0.5), (0.5, 0.5)])},
            ],
        }
        geometry = compiler.polygon_geometry(relation, (0.0, 0.0))
        self.assertIsNotNone(geometry)
        self.assertEqual(geometry["type"], "MultiPolygon")
        self.assertEqual(len(geometry["coordinates"]), 2)
        self.assertEqual(sorted(len(polygon) for polygon in geometry["coordinates"]), [1, 2])

    def test_generated_package_is_reproducible(self) -> None:
        encoded = json.dumps(self.package, indent=2, sort_keys=False) + "\n"
        self.assertEqual(GENERATED.read_text(encoding="utf-8"), encoded)
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "greywolf-v1.json"
            output.write_text(encoded, encoding="utf-8")
            self.assertEqual(output.read_text(encoding="utf-8"), encoded)


if __name__ == "__main__":
    unittest.main()
