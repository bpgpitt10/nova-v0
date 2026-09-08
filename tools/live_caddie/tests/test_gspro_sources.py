from __future__ import annotations

import unittest

from tools.live_caddie.gspro_sources import (
    normalize_round_db_row,
    parse_output_log_line,
    shot_ids_from_summaries,
    summarize_current_round_payload,
)


class GsproSourcesTests(unittest.TestCase):
    def test_current_round_summary_preserves_raw_and_display_hole(self) -> None:
        payload = [{
            "ShotID": "shot-1",
            "RoundID": 183,
            "PlayerName": "Brian",
            "Hole": 6,
            "HoleShot": 1,
            "GlobalShotNumber": 14,
            "DistanceToPin": 32.1,
            "StartingSurface": 0,
            "EndingSurface": 2,
            "HolePar": 3,
            "CourseKey": "CanyonRun_gsp",
            "activeShot": {
                "sd": {
                    "isPutt": False,
                    "isHoled": False,
                    "isGimme": False,
                    "waterhit": False,
                    "HazardNumber": 1000,
                    "TargetDirection": 12.3,
                    "TDmaterial": 2,
                },
                "materialHit": "TVGfairway",
            },
        }]
        summaries = summarize_current_round_payload(payload)
        self.assertEqual(len(summaries), 1)
        shot = summaries[0]
        self.assertEqual(shot["hole_raw_zero_based"], 6)
        self.assertEqual(shot["hole_display"], 7)
        self.assertEqual(shot["hole_shot"], 1)
        self.assertEqual(shot["material_hit"], "TVGfairway")
        self.assertFalse(shot["is_putt"])
        self.assertEqual(shot_ids_from_summaries(summaries), {"shot-1"})

    def test_output_log_known_facts(self) -> None:
        lines = [
            "magnitude: 6.98 | yForce 4.32 | material TVGfairway | elevation 3911",
            "ActivePlayer: 0  currentHole: 6  strokes: 1  Previous Score: 0",
            "Logging tdist: 93.60216 and ActiveGameGimmieDistance: 1.83",
            "|| FinalBounce 0.21|| SpinAngleLoss 1.000|| SurfAngl -1.8",
            "Real putt made and all players done - AllPlayersHoledOut",
            "Wind Direction Capped Negative",
        ]
        facts = [fact.to_dict() for line in lines for fact in parse_output_log_line(line)]
        kinds = [fact["kind"] for fact in facts]
        self.assertIn("surface_material", kinds)
        self.assertIn("active_game_state", kinds)
        self.assertIn("distance_state", kinds)
        self.assertIn("surface_angle_physics", kinds)
        self.assertIn("hole_terminal", kinds)
        self.assertIn("wind_log_line", kinds)
        active = next(f for f in facts if f["kind"] == "active_game_state")
        self.assertEqual(active["hole_raw_zero_based"], 6)
        self.assertEqual(active["hole_display"], 7)

    def test_db_active_hole_normalization(self) -> None:
        row = normalize_round_db_row({
            "ID": 162,
            "CourseName": "greywolf_gsp",
            "ActiveHole": 6,
            "RoundStatus": 1,
        })
        self.assertEqual(row["ActiveHoleRawZeroBased"], 6)
        self.assertEqual(row["ActiveHoleDisplay"], 7)


if __name__ == "__main__":
    unittest.main()
