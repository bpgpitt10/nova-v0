#!/usr/bin/env python3
"""Offline unit checks for round_watch_v3 deterministic state/fusion rules."""
from __future__ import annotations

import contextlib
import io
import unittest

import round_watch_v3 as rw


class RoundWatchV3StateTests(unittest.TestCase):
    def test_trusted_db_next_hole_outranks_bad_screen_ocr(self):
        fusion = rw._transition(
            current=4,
            expected=5,
            db_hole=5,
            db_trusted=True,
            log_hole=4,
            log_fresh=False,
            header_hole=9,
            shot=7,
            tee=False,
        )
        self.assertTrue(fusion["accepted"])
        self.assertEqual(fusion["authority"], "structured")
        self.assertIn("db=expected-5", fusion["authoritative_matches"])
        self.assertIn("header=9", fusion["disagreements"])
        self.assertIn("shot=7", fusion["disagreements"])

    def test_screen_recovery_can_confirm_deterministic_next_hole(self):
        fusion = rw._transition(
            current=4,
            expected=5,
            db_hole=4,
            db_trusted=True,
            log_hole=4,
            log_fresh=False,
            header_hole=None,
            shot=1,
            tee=True,
        )
        self.assertTrue(fusion["accepted"])
        self.assertEqual(fusion["authority"], "screen-recovery")

    def test_unrelated_trusted_db_hole_is_hard_contradiction(self):
        fusion = rw._transition(
            current=4,
            expected=5,
            db_hole=8,
            db_trusted=True,
            log_hole=None,
            log_fresh=False,
            header_hole=5,
            shot=1,
            tee=True,
        )
        self.assertFalse(fusion["accepted"])
        self.assertIn("trusted-db=8", fusion["hard_contradictions"])

    def test_terminal_moves_to_expected_next_hole(self):
        state = rw._blank_state()
        state["session_id"] = "test"
        state["phase"] = rw.PLAYING
        state["current_hole"] = 7
        state["pending_posttee"] = {"shot_id": "x"}
        state["pending_tee"] = {"hole": 7}
        with contextlib.redirect_stdout(io.StringIO()):
            rw._terminal(
                state,
                "output_log AllPlayersHoledOut",
                as_json=True,
                source="output_log AllPlayersHoledOut",
            )
        self.assertEqual(state["phase"], rw.EXPECT_NEXT)
        self.assertEqual(state["expected_next_hole"], 8)
        self.assertIsNone(state["pending_posttee"])
        self.assertIsNone(state["pending_tee"])
        self.assertEqual(state["terminal_latch"]["hole"], 7)

    def test_hole_18_terminal_completes_round(self):
        state = rw._blank_state()
        state["session_id"] = "test"
        state["phase"] = rw.PLAYING
        state["current_hole"] = 18
        with contextlib.redirect_stdout(io.StringIO()):
            rw._terminal(state, "holed", as_json=True, source="currentRound")
        self.assertEqual(state["phase"], rw.COMPLETE)
        self.assertIsNone(state["expected_next_hole"])

    def test_entering_new_hole_clears_previous_model_pointer(self):
        state = rw._blank_state()
        state["session_id"] = "test"
        state["phase"] = rw.EXPECT_NEXT
        state["course_name"] = "Trosper Golf Club"
        state["current_hole"] = 3
        state["expected_next_hole"] = 4
        state["active_hole_model_path"] = "old/hole_model.json"
        state["active_tee_capture_dir"] = "old"
        with contextlib.redirect_stdout(io.StringIO()):
            rw._enter_hole(
                state, 4, {"course_name": "Trosper Golf Club", "hole_number": 4},
                None, "structured progression", as_json=True, prepare_tee=True
            )
        self.assertEqual(state["current_hole"], 4)
        self.assertIsNone(state["active_hole_model_path"])
        self.assertIsNone(state["active_tee_capture_dir"])
        self.assertEqual(state["hole_models"]["4"]["status"], "pending")

    def test_penalty_style_forward_screen_shot_is_not_stale(self):
        self.assertEqual(rw._screen_validator_state(4, 3), "ahead")
        self.assertEqual(rw._screen_validator_state(3, 3), "match")
        self.assertEqual(rw._screen_validator_state(2, 3), "stale")

    def test_player_mismatch_is_rejected(self):
        state = rw._blank_state()
        state["player_name"] = "Brian"
        ok, mismatches = rw._shot_matches_latch(
            state,
            {"player_name": "Other Player", "round_id": None, "user_guid": None},
        )
        self.assertFalse(ok)
        self.assertIn("player_name", mismatches)

    def test_db_course_mismatch_is_not_trusted(self):
        state = rw._blank_state()
        state["course_name"] = "Trosper Golf Club"
        trust = rw._db_consistency(
            state,
            {"ID": 1, "CourseName": "Different Course", "PlayerName": None},
        )
        self.assertFalse(trust["trusted"])
        self.assertIn("course", trust["contradictions"])


if __name__ == "__main__":
    unittest.main()
