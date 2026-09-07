import unittest

from tools.live_caddie.round_replay import _default_sequence, replay


class RoundReplayTests(unittest.TestCase):
    def test_default_two_hole_sequence_routes_expected_actions(self):
        result = replay(_default_sequence(), actions_enabled=False)
        actions = [step["planned_action"]["action"] for step in result["steps"]]
        self.assertEqual(
            actions,
            ["capture-tee", "capture-posttee", "capture-posttee", "capture-posttee", "capture-tee"],
        )
        self.assertFalse(result["actions_enabled"])
        self.assertEqual(result["final_state"]["tracker"]["active_identity"]["hole_number"], 3)
        self.assertEqual(result["final_state"]["tracker"]["shots_recorded_on_active_hole"], 0)


if __name__ == "__main__":
    unittest.main()
