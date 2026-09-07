import unittest

from tools.live_caddie.assumptions import Assumptions
from tools.live_caddie.round_orchestrator import RoundObservation, RoundOrchestrator


class RoundOrchestratorTests(unittest.TestCase):
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

    def test_mid_round_tee_can_be_detected_from_surface_and_distance(self):
        orchestrator = RoundOrchestrator(assumptions=self.assumptions)
        action = orchestrator.observe(RoundObservation(
            identity=self.hole2,
            minimap_surface_label="tee",
            minimap_surface_is_tee=True,
            pin_card_distance_to_pin_yds=501,
            flat_lie=True,
            full_hole_minimap=True,
        ))
        self.assertEqual(action.action, "capture-tee")
        self.assertFalse(action.execute_allowed)

    def test_shot_counter_advance_routes_to_posttee_capture(self):
        orchestrator = RoundOrchestrator(assumptions=self.assumptions)
        tee = orchestrator.observe(RoundObservation(
            identity=self.hole2,
            minimap_surface_label="tee",
            minimap_surface_is_tee=True,
            upper_left_shot_number=1,
            upper_left_distance_to_pin_yds=501,
        ))
        self.assertEqual(tee.action, "capture-tee")
        orchestrator.accept_tee_capture(identity=self.hole2)

        # Establish first playable observation after tee capture.
        orchestrator.observe(RoundObservation(
            identity=self.hole2,
            minimap_surface_label="tee",
            minimap_surface_is_tee=True,
            upper_left_shot_number=1,
            upper_left_distance_to_pin_yds=501,
        ))
        action = orchestrator.observe(RoundObservation(
            identity=self.hole2,
            minimap_surface_label="fairway",
            minimap_surface_is_tee=False,
            upper_left_shot_number=2,
            upper_left_distance_to_pin_yds=245,
        ))
        self.assertEqual(action.action, "capture-posttee")
        self.assertEqual(orchestrator.tracker.shots_recorded_on_active_hole, 1)

    def test_fast_hole_change_routes_back_to_tee_capture(self):
        orchestrator = RoundOrchestrator(assumptions=self.assumptions)
        orchestrator.tracker.active_identity = dict(self.hole2)
        orchestrator.tracker.shots_recorded_on_active_hole = 4
        orchestrator.mark_terminal()
        action = orchestrator.observe(RoundObservation(
            identity=self.hole3,
            minimap_surface_label="tee",
            minimap_surface_is_tee=True,
            upper_left_shot_number=1,
            upper_left_distance_to_pin_yds=412,
            flat_lie=True,
        ))
        self.assertEqual(action.action, "capture-tee")

    def test_counter_reset_requires_reconciliation(self):
        orchestrator = RoundOrchestrator(assumptions=self.assumptions)
        orchestrator.tracker.active_identity = dict(self.hole2)
        orchestrator.previous_observation = RoundObservation(
            identity=self.hole2,
            minimap_surface_label="fairway",
            minimap_surface_is_tee=False,
            upper_left_shot_number=3,
            upper_left_distance_to_pin_yds=160,
        )
        action = orchestrator.observe(RoundObservation(
            identity=self.hole2,
            minimap_surface_label="fairway",
            minimap_surface_is_tee=False,
            upper_left_shot_number=2,
            upper_left_distance_to_pin_yds=160,
        ))
        self.assertEqual(action.action, "reconcile-round-state")


if __name__ == "__main__":
    unittest.main()
