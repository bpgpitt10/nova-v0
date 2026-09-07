import unittest

from tools.live_caddie.shot_progression import ShotProgressionInputs, infer_shot_progression


class ShotProgressionTests(unittest.TestCase):
    def setUp(self):
        self.hole2 = {"course_name": "The Old Game", "hole_number": 2}
        self.hole3 = {"course_name": "The Old Game", "hole_number": 3}

    def test_normal_shot_increment(self):
        decision = infer_shot_progression(ShotProgressionInputs(
            previous_identity=self.hole2,
            current_identity=self.hole2,
            previous_screen_shot_number=1,
            current_screen_shot_number=2,
            previous_distance_to_pin_yds=501,
            current_distance_to_pin_yds=245,
        ))
        self.assertEqual(decision.event, "shot-advanced")
        self.assertTrue(decision.shot_advanced)
        self.assertAlmostEqual(decision.distance_change_yds, -256.0)

    def test_same_counter_does_not_create_duplicate_shot(self):
        decision = infer_shot_progression(ShotProgressionInputs(
            previous_identity=self.hole2,
            current_identity=self.hole2,
            previous_screen_shot_number=2,
            current_screen_shot_number=2,
        ))
        self.assertEqual(decision.event, "unchanged")
        self.assertFalse(decision.shot_advanced)

    def test_hole_change_wins_over_counter_reset(self):
        decision = infer_shot_progression(ShotProgressionInputs(
            previous_identity=self.hole2,
            current_identity=self.hole3,
            previous_screen_shot_number=5,
            current_screen_shot_number=1,
        ))
        self.assertEqual(decision.event, "hole-changed")
        self.assertTrue(decision.hole_changed)
        self.assertFalse(decision.shot_advanced)

    def test_backward_counter_is_not_silently_counted(self):
        decision = infer_shot_progression(ShotProgressionInputs(
            previous_identity=self.hole2,
            current_identity=self.hole2,
            previous_screen_shot_number=3,
            current_screen_shot_number=2,
        ))
        self.assertEqual(decision.event, "counter-reset-or-mulligan")
        self.assertFalse(decision.shot_advanced)

    def test_jump_requires_reconciliation(self):
        decision = infer_shot_progression(ShotProgressionInputs(
            previous_identity=self.hole2,
            current_identity=self.hole2,
            previous_screen_shot_number=2,
            current_screen_shot_number=4,
        ))
        self.assertEqual(decision.event, "counter-jump")
        self.assertFalse(decision.shot_advanced)


if __name__ == "__main__":
    unittest.main()
