import unittest

from tools.live_caddie.assumptions import Assumptions
from tools.live_caddie.round_tracker import RoundTracker


class RoundTrackerTests(unittest.TestCase):
    def setUp(self):
        self.assumptions = Assumptions.load()
        self.hole2 = {
            "course_name": "The Old Game",
            "hole_number": 2,
            "par": 5,
            "hole_yards": 501,
        }
        self.hole3 = {
            "course_name": "The Old Game",
            "hole_number": 3,
            "par": 4,
            "hole_yards": 412,
        }

    def test_fast_terminal_to_next_tee_still_confirms(self):
        tracker = RoundTracker(active_identity=self.hole2, shots_recorded_on_active_hole=4)
        tracker.mark_hole_terminal(True)
        decision = tracker.observe_pre_shot(
            current_identity=self.hole3,
            pin_card_distance_to_pin_yds=401,
            flat_lie=True,
            full_hole_minimap=True,
            assumptions=self.assumptions,
        )
        self.assertTrue(decision.should_capture_tee)
        self.assertEqual(decision.status, "confirmed")
        self.assertEqual(tracker.pending_identity["hole_number"], 3)

    def test_new_hole_anchor_persists_until_tee_is_accepted(self):
        tracker = RoundTracker(active_identity=self.hole2, shots_recorded_on_active_hole=4)
        first = tracker.observe_pre_shot(
            current_identity=self.hole3,
            pin_card_distance_to_pin_yds=401,
            assumptions=self.assumptions,
        )
        second = tracker.observe_pre_shot(
            current_identity=self.hole3,
            pin_card_distance_to_pin_yds=401,
            flat_lie=True,
            assumptions=self.assumptions,
        )
        self.assertTrue(first.hole_changed)
        self.assertTrue(second.hole_changed)
        self.assertEqual(tracker.active_identity["hole_number"], 2)

    def test_accept_tee_resets_shot_count_then_post_tee_is_not_tee(self):
        tracker = RoundTracker(active_identity=self.hole2, shots_recorded_on_active_hole=4)
        tracker.observe_pre_shot(
            current_identity=self.hole3,
            screen_shot_number=1,
            screen_distance_to_pin_yds=401,
            minimap_surface_is_tee=True,
            minimap_surface_label="tee",
            assumptions=self.assumptions,
        )
        tracker.accept_tee()
        tracker.mark_shot_recorded()
        decision = tracker.observe_pre_shot(
            current_identity=self.hole3,
            screen_shot_number=2,
            screen_distance_to_pin_yds=245,
            minimap_surface_is_tee=False,
            minimap_surface_label="fairway",
            assumptions=self.assumptions,
        )
        self.assertEqual(tracker.shots_recorded_on_active_hole, 1)
        self.assertEqual(decision.status, "not-tee")
        self.assertFalse(decision.should_capture_tee)

    def test_mid_round_start_can_confirm_from_minimap_tee_surface(self):
        tracker = RoundTracker()
        decision = tracker.observe_pre_shot(
            current_identity=self.hole3,
            minimap_surface_is_tee=True,
            minimap_surface_label="tee",
            pin_card_distance_to_pin_yds=408,
            flat_lie=True,
            assumptions=self.assumptions,
        )
        self.assertEqual(decision.status, "confirmed")
        self.assertTrue(decision.should_capture_tee)
        self.assertTrue(decision.anchor_present)
        self.assertEqual(tracker.pending_identity["hole_number"], 3)

    def test_recognized_fairway_surface_blocks_false_tee(self):
        tracker = RoundTracker(active_identity=self.hole3, shots_recorded_on_active_hole=0)
        decision = tracker.observe_pre_shot(
            current_identity=self.hole3,
            minimap_surface_is_tee=False,
            minimap_surface_label="fairway",
            pin_card_distance_to_pin_yds=408,
            flat_lie=True,
            assumptions=self.assumptions,
        )
        self.assertEqual(decision.status, "not-tee")
        self.assertFalse(decision.should_capture_tee)
        self.assertTrue(any("Fairway" in item or "fairway" in item for item in decision.hard_contradictions))


if __name__ == "__main__":
    unittest.main()
