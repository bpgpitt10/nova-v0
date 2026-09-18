import argparse
import json
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))
import gspro_calibration_harness as harness


class HarnessTests(unittest.TestCase):
    def test_profile_controls_full_ball_packet(self):
        profile = harness.Profile("driver-draw", 151, 13.5, 1.2, 2350, -8.5)
        packet = harness.lab.build_open_connect_shot(42, profile.launch())
        ball = packet["BallData"]
        self.assertEqual((151, 13.5, 1.2, 2350, -8.5),
                         (ball["Speed"], ball["VLA"], ball["HLA"], ball["TotalSpin"], ball["SpinAxis"]))
        self.assertNotIn("CarryDistance", ball)

    def test_profile_file_supports_multiple_launch_shapes(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "profiles.json"
            path.write_text(json.dumps({"profiles": [
                {"label": "driver", "ballSpeedMph": 150, "vlaDeg": 14, "spinRpm": 2400, "spinAxisDeg": 3},
                {"label": "iron", "ballSpeedMph": 118, "vlaDeg": 18, "spinRpm": 5800, "spinAxisDeg": -2},
                {"label": "wedge", "ballSpeedMph": 85, "vlaDeg": 30, "spinRpm": 9000},
            ]}), encoding="utf-8")
            profiles = harness.load_profiles(path)
            self.assertEqual(["driver", "iron", "wedge"], [p.label for p in profiles])
            self.assertEqual(9000, profiles[2].spinRpm)

    def test_context_keeps_physical_lie_as_metadata(self):
        args = argparse.Namespace(
            condition_label="sidehill", lie_up_down=4.2, lie_left_right=-2.1,
            surface="fairway", course="Test", hole=7, position_label="A",
        )
        ctx = harness.context(args)
        self.assertEqual((4.2, -2.1), (ctx.lieUpDownDeg, ctx.lieLeftRightDeg))
        packet = harness.lab.build_open_connect_shot(1, harness.Profile("x", 118, 18, 0, 5800, 0).launch())
        self.assertEqual(0.0, packet["ClubData"]["Lie"])

    def test_builtin_self_test(self):
        self.assertEqual(0, harness.self_test())


if __name__ == "__main__":
    unittest.main()
