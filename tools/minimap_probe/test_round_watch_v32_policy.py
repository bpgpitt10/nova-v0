#!/usr/bin/env python3
"""Offline policy tests for the DPC-Pebble-driven watcher v3.2 changes."""
from __future__ import annotations

import time
import unittest

import gspro_structured
import round_watch_v32 as v32


class WatcherV32PolicyTests(unittest.TestCase):
    def setUp(self):
        v32._CTX.update({
            "round_id": None,
            "db_round_id": None,
            "authoritative_hole": None,
            "screen_shot": None,
            "surface_label": None,
            "surface_tee": False,
            "header": None,
            "structured_pin": None,
            "last_pin": None,
            "last_overlay": None,
        })

    def test_structured_distance_is_meters_to_yards(self):
        self.assertAlmostEqual(
            gspro_structured.meters_to_yards(168.6337),
            184.4201,
            places=3,
        )

    def test_observed_surface_mapping(self):
        self.assertEqual(gspro_structured.surface_label(18), "tee")
        self.assertEqual(gspro_structured.surface_label(2), "fairway")
        self.assertEqual(gspro_structured.surface_label(1), "rough")
        self.assertEqual(gspro_structured.surface_label(11), "sand")
        self.assertEqual(gspro_structured.surface_label(5), "green")
        self.assertIsNone(gspro_structured.surface_label(999))

    def test_stale_db_cannot_veto_shot1_plus_tee(self):
        fusion = v32._transition(
            current=2,
            expected=3,
            db_hole=1,
            db_trusted=True,
            log_hole=2,
            log_fresh=False,
            header_hole=None,
            shot=1,
            tee=True,
        )
        self.assertTrue(fusion["accepted"])
        self.assertEqual(fusion["authority"], "screen-recovery")
        self.assertEqual(fusion["hard_contradictions"], [])

    def test_db_active_hole_alone_is_never_live_authority(self):
        fusion = v32._transition(
            current=2,
            expected=3,
            db_hole=3,
            db_trusted=True,
            log_hole=None,
            log_fresh=False,
            header_hole=None,
            shot=None,
            tee=False,
        )
        self.assertFalse(fusion["accepted"])

    def test_fresh_output_log_expected_hole_is_structured_authority(self):
        fusion = v32._transition(
            current=2,
            expected=3,
            db_hole=1,
            db_trusted=True,
            log_hole=3,
            log_fresh=True,
            header_hole=None,
            shot=None,
            tee=False,
        )
        self.assertTrue(fusion["accepted"])
        self.assertEqual(fusion["authority"], "structured")

    def test_bad_screen_pin_is_rejected_against_structured_dtp(self):
        v32._CTX.update({
            "authoritative_hole": 2,
            "screen_shot": 3,
            "surface_tee": False,
            "header": {"hole_number": 2, "hole_yards": 363},
            "structured_pin": {
                "epoch": time.time(),
                "hole": 2,
                "distance_to_pin_yds": 83.2,
            },
        })
        resolved, warning = v32._resolve_pin(2.0, None, [])
        self.assertAlmostEqual(resolved, 83.2, places=3)
        self.assertIn("rejected", warning)

    def test_tee_header_is_fallback_when_pin_ocr_missing(self):
        v32._CTX.update({
            "authoritative_hole": 2,
            "screen_shot": 1,
            "surface_tee": True,
            "header": {"hole_number": 2, "hole_yards": 363},
        })
        resolved, warning = v32._resolve_pin(None, "OCR unavailable", [])
        self.assertEqual(resolved, 363.0)
        self.assertIn("header yardage", warning)

    def test_repeated_global_number_gimme_is_synthetic_terminal(self):
        state = {"last_physical_global_shot_by_hole": {}}
        physical = {
            "round_id": 212,
            "user_guid": "u",
            "hole_display": 3,
            "global_shot_number": 11,
            "is_gimme": False,
            "is_holed": False,
        }
        synthetic = {
            "round_id": 212,
            "user_guid": "u",
            "hole_display": 3,
            "global_shot_number": 11,
            "is_gimme": True,
            "is_holed": True,
        }
        v32._classify_new_shots([physical, synthetic], state)
        self.assertTrue(physical["physical_shot"])
        self.assertFalse(physical["synthetic_terminal_record"])
        self.assertFalse(synthetic["physical_shot"])
        self.assertTrue(synthetic["synthetic_terminal_record"])

    def test_round_id_owns_identity_key_after_latch(self):
        v32._CTX["round_id"] = 212
        key = v32._identity_key({"course_name": "DPC Pebble", "hole_number": 4})
        self.assertEqual(key, "round-212::hole-04")

    def test_state_schema_marks_v32_policy(self):
        state = v32._blank_state()
        self.assertEqual(state["schema_version"], "gspro-round-watch-state-v3.2")
        self.assertEqual(state["source_policy"]["gspro_db_active_hole"], "diagnostic-only-field-proven-stale")


if __name__ == "__main__":
    unittest.main()
