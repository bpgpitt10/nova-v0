import unittest

from tools.live_caddie.assumptions import Assumptions
from tools.live_caddie.round_orchestrator import RoundObservation, RoundOrchestrator


class RoundLifecycleOcrGuardTests(unittest.TestCase):
    def setUp(self):
        self.assumptions = Assumptions.load()
        self.hole = {
            "course_name": "Canyon Run - Par 3",
            "hole_number": 1,
            "par": 3,
            "hole_yards": 85,
        }

    def _accepted_tee(self) -> RoundOrchestrator:
        orchestrator = RoundOrchestrator(assumptions=self.assumptions)
        tee = orchestrator.observe(RoundObservation(
            identity=self.hole,
            minimap_surface_label="tee",
            minimap_surface_is_tee=True,
            upper_left_shot_number=1,
            upper_left_distance_to_pin_yds=85,
        ))
        self.assertEqual(tee.action, "capture-tee")
        orchestrator.accept_tee_capture(identity=self.hole)
        return orchestrator

    def test_same_tee_shot_one_ocr_spike_does_not_poison_real_shot_two(self):
        orchestrator = self._accepted_tee()

        noisy_tee = orchestrator.observe(RoundObservation(
            identity=self.hole,
            minimap_surface_label="tee",
            minimap_surface_is_tee=True,
            upper_left_shot_number=7,
            upper_left_distance_to_pin_yds=85,
        ))
        self.assertEqual(noisy_tee.action, "none")
        self.assertEqual(orchestrator.tracker.last_screen_shot_number, 1)

        real_shot_two = orchestrator.observe(RoundObservation(
            identity=self.hole,
            minimap_surface_label="sand",
            minimap_surface_is_tee=False,
            upper_left_shot_number=2,
            upper_left_distance_to_pin_yds=35.2,
        ))
        self.assertEqual(real_shot_two.action, "capture-posttee")
        self.assertEqual(real_shot_two.payload["shot_progression"]["previous_shot_number"], 1)
        self.assertEqual(real_shot_two.payload["shot_progression"]["current_shot_number"], 2)
        self.assertEqual(orchestrator.tracker.shots_recorded_on_active_hole, 1)

    def test_transition_frame_7_then_1_does_not_trigger_false_reset(self):
        orchestrator = self._accepted_tee()

        # Field reproduction from Hole 2: immediately after the swing, the minimap
        # was no longer reliably Tee while the shot-number OCR briefly produced 7,
        # then 1, before the real post-shot counter became available.
        noisy_seven = orchestrator.observe(RoundObservation(
            identity=self.hole,
            minimap_surface_label=None,
            minimap_surface_is_tee=None,
            upper_left_shot_number=7,
            upper_left_distance_to_pin_yds=85,
        ))
        self.assertEqual(noisy_seven.action, "none")
        self.assertEqual(orchestrator.tracker.last_screen_shot_number, 1)

        transient_one = orchestrator.observe(RoundObservation(
            identity=self.hole,
            minimap_surface_label="fairway",
            minimap_surface_is_tee=False,
            upper_left_shot_number=1,
            upper_left_distance_to_pin_yds=84.8,
        ))
        self.assertEqual(transient_one.action, "none")
        self.assertEqual(orchestrator.tracker.last_screen_shot_number, 1)

        real_two = orchestrator.observe(RoundObservation(
            identity=self.hole,
            minimap_surface_label="sand",
            minimap_surface_is_tee=False,
            upper_left_shot_number=2,
            upper_left_distance_to_pin_yds=35.2,
        ))
        self.assertEqual(real_two.action, "capture-posttee")
        self.assertEqual(real_two.payload["shot_progression"]["previous_shot_number"], 1)
        self.assertEqual(real_two.payload["shot_progression"]["current_shot_number"], 2)


if __name__ == "__main__":
    unittest.main()
