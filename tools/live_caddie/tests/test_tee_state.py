import unittest

from tools.live_caddie.assumptions import Assumptions
from tools.live_caddie.tee_state import TeeStateInputs, infer_tee_state


class TeeStateTests(unittest.TestCase):
    def setUp(self):
        self.assumptions = Assumptions.load()
        self.hole2 = {
            "course_name": "The Old Game",
            "hole_number": 2,
            "par": 5,
            "hole_yards": 501,
            "confidence": 1.0,
        }
        self.hole3 = {
            "course_name": "The Old Game",
            "hole_number": 3,
            "par": 4,
            "hole_yards": 412,
            "confidence": 1.0,
        }

    def test_hole_transition_can_confirm_tee_without_upper_left_state(self):
        decision = infer_tee_state(
            TeeStateInputs(
                previous_identity=self.hole2,
                current_identity=self.hole3,
                pin_card_distance_to_pin_yds=401,
                shots_recorded_on_current_hole=0,
                previous_hole_terminal=True,
                flat_lie=True,
                full_hole_minimap=True,
            ),
            self.assumptions,
        )
        self.assertEqual(decision.status, "confirmed")
        self.assertTrue(decision.should_capture_tee)
        self.assertTrue(decision.hole_changed)

    def test_future_shot_number_one_can_confirm_initial_tee(self):
        decision = infer_tee_state(
            TeeStateInputs(
                current_identity=self.hole2,
                screen_shot_number=1,
                screen_distance_to_pin_yds=484,
                shots_recorded_on_current_hole=0,
                flat_lie=True,
                full_hole_minimap=True,
            ),
            self.assumptions,
        )
        self.assertEqual(decision.status, "confirmed")
        self.assertTrue(decision.should_capture_tee)
        self.assertTrue(decision.anchor_present)

    def test_shot_number_greater_than_one_is_hard_not_tee(self):
        decision = infer_tee_state(
            TeeStateInputs(
                previous_identity=self.hole2,
                current_identity=self.hole3,
                screen_shot_number=2,
                screen_distance_to_pin_yds=401,
                shots_recorded_on_current_hole=0,
                previous_hole_terminal=True,
            ),
            self.assumptions,
        )
        self.assertEqual(decision.status, "not-tee")
        self.assertFalse(decision.should_capture_tee)
        self.assertEqual(decision.confidence, 0.0)

    def test_recorded_shot_on_current_hole_is_hard_not_tee(self):
        decision = infer_tee_state(
            TeeStateInputs(
                current_identity=self.hole2,
                screen_shot_number=None,
                pin_card_distance_to_pin_yds=484,
                shots_recorded_on_current_hole=1,
                flat_lie=True,
                full_hole_minimap=True,
            ),
            self.assumptions,
        )
        self.assertEqual(decision.status, "not-tee")
        self.assertFalse(decision.should_capture_tee)

    def test_no_transition_and_no_shot_counter_does_not_auto_capture(self):
        decision = infer_tee_state(
            TeeStateInputs(
                current_identity=self.hole2,
                pin_card_distance_to_pin_yds=484,
                shots_recorded_on_current_hole=0,
                flat_lie=True,
                full_hole_minimap=True,
            ),
            self.assumptions,
        )
        self.assertFalse(decision.should_capture_tee)
        self.assertFalse(decision.anchor_present)

    def test_distance_mismatch_weakens_but_does_not_erase_transition(self):
        decision = infer_tee_state(
            TeeStateInputs(
                previous_identity=self.hole2,
                current_identity=self.hole3,
                pin_card_distance_to_pin_yds=240,
                shots_recorded_on_current_hole=0,
            ),
            self.assumptions,
        )
        self.assertFalse(decision.distance_matches_hole)
        self.assertEqual(decision.status, "probable")
        self.assertFalse(decision.should_capture_tee)


if __name__ == "__main__":
    unittest.main()
