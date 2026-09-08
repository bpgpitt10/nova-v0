import unittest

from tools.live_caddie.assumptions import Assumptions
from tools.live_caddie.round_orchestrator import RoundObservation, RoundOrchestrator


class RoundLifecycleOcrGuardTests(unittest.TestCase):
    def test_same_tee_shot_one_ocr_spike_does_not_poison_real_shot_two(self):
        assumptions = Assumptions.load()
        hole = {
            "course_name": "Canyon Run - Par 3",
            "hole_number": 1,
            "par": 3,
            "hole_yards": 85,
        }
        orchestrator = RoundOrchestrator(assumptions=assumptions)

        tee = orchestrator.observe(RoundObservation(
            identity=hole,
            minimap_surface_label="tee",
            minimap_surface_is_tee=True,
            upper_left_shot_number=1,
            upper_left_distance_to_pin_yds=85,
        ))
        self.assertEqual(tee.action, "capture-tee")
        orchestrator.accept_tee_capture(identity=hole)

        # Field reproduction: while the player was still standing on Shot 1,
        # Tesseract briefly hallucinated the digit as 7.
        noisy_tee = orchestrator.observe(RoundObservation(
            identity=hole,
            minimap_surface_label="tee",
            minimap_surface_is_tee=True,
            upper_left_shot_number=7,
            upper_left_distance_to_pin_yds=85,
        ))
        self.assertEqual(noisy_tee.action, "none")
        self.assertEqual(orchestrator.tracker.last_screen_shot_number, 1)

        real_shot_two = orchestrator.observe(RoundObservation(
            identity=hole,
            minimap_surface_label="sand",
            minimap_surface_is_tee=False,
            upper_left_shot_number=2,
            upper_left_distance_to_pin_yds=35.2,
        ))
        self.assertEqual(real_shot_two.action, "capture-posttee")
        self.assertEqual(real_shot_two.payload["shot_progression"]["previous_shot_number"], 1)
        self.assertEqual(real_shot_two.payload["shot_progression"]["current_shot_number"], 2)
        self.assertEqual(orchestrator.tracker.shots_recorded_on_active_hole, 1)


if __name__ == "__main__":
    unittest.main()
