"""The Wander analysis: what it leaves out, and the numbers it gives."""
import csv
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "gspro_lie_lab"))
import analyze_wander as aw  # noqa: E402

FIELDS = ["test", "club", "aim", "status", "carry_yd", "total_yd", "roll_yd", "lie_surface", "lie_speed_pct", "lie_spin_pct",
          "lie_vla_pct", "start_surface", "landing_material", "landing_surface", "finish_surface", "db_pin_yd",
          "db_raw_carry_game_yd", "start_y", "land_y", "sent_speed_mph", "sent_vla_deg", "descent_deg",
          "landing_spin_rpm", "spot", "db_id", "pin_from_spot_yd", "course_key", "hole"]


def shot(i, **over):
    row = {"test": "wander", "club": "7i to green", "aim": "green", "status": "GSPro took it; next: LW from 140.0 yd",
           "carry_yd": 150, "total_yd": 155, "roll_yd": 5, "start_surface": 2, "landing_material": "TVGgreen",
           "landing_surface": 5, "finish_surface": 5, "db_pin_yd": 2.0, "db_raw_carry_game_yd": 150, "start_y": 30,
           "land_y": 30, "sent_speed_mph": 113.1, "sent_vla_deg": 16.4, "descent_deg": 45, "landing_spin_rpm": 5000,
           "spot": i // 2 + 1, "db_id": i, "course_key": "farmlinks", "hole": 2}
    return {**row, **over}


class AnalysisTests(unittest.TestCase):
    def run_rows(self, rows):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "looper_lab_x.csv"
            with open(path, "w", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=FIELDS)
                writer.writeheader()
                writer.writerows(rows)
            loaded = aw.load([path, path])  # the same file twice: each shot once
            result, kept = aw.analyse(loaded)
            text = aw.summary(result)
            paths = aw.write(Path(tmp) / "out", loaded, result)
            self.assertTrue(all(p.exists() for p in paths))
        return loaded, result, kept, text

    def test_left_out_and_counted(self):
        rows = [shot(0), shot(1),
                shot(2, club="Driver", aim="lie", lie_surface="TVGdeeprough", lie_speed_pct=65, start_surface=3),
                shot(3, landing_material="TVGwood", landing_surface=14, finish_surface=14),
                shot(4, aim="water", lie_surface="TVGwater"),
                shot(5, club="3H to green", sent_speed_mph=201.4),
                shot(6, carry_yd="")]
        loaded, result, kept, text = self.run_rows(rows)
        self.assertEqual(len(loaded), 7)
        self.assertEqual(result["kept"], 2)
        self.assertEqual(set(result["left_out"]), {"Driver off the ground", "into the trees", "hit from water",
                                                   "green shot swung too hard (old Wander)", "not taken (no carry)"})
        self.assertIn("Left out", text)

    def test_a_shot_that_clipped_leaves_is_left_out(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "looper_lab_x.csv"
            rows = [shot(0, sent_at="2026-11-20T15:06:34", spot=18, club="soft 70"),
                    shot(1, sent_at="2026-11-20T15:06:42", spot=18, club="mid 105")]
            with open(path, "w", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=FIELDS + ["sent_at"])
                writer.writeheader()
                writer.writerows(rows)
            path.with_name("looper_lab_x_log.txt").write_text(
                "--- spot 18 shot 1 (soft 70) 2026-11-20T15:06:34 note: wander\n* Shot Fired *\n"
                "Bush penalty applied\n** Leaves hitTime, 0.53 , HitCount 1, Penalty 34.0%\n"
                "--- spot 18 shot 1 (mid 105) 2026-11-20T15:06:42 note: wander\n* Shot Fired *\n")
            result, kept = aw.analyse(aw.load([path]))
        self.assertEqual(result["left_out"], {"clipped leaves or a bush in flight": 1})
        self.assertEqual([r["shot"] for r in kept], ["mid 105"])

    def test_driver_off_the_tee_is_kept(self):
        _, result, kept, _ = self.run_rows([shot(0, club="Driver off the tee", aim="tee", start_surface=18, sent_speed_mph=143.8)])
        self.assertEqual(result["kept"], 1)
        self.assertEqual(kept[0]["lie"], "tee")

    def test_lie_penalty_falls_with_launch(self):
        rows = [shot(i, club="soft", aim="lie", lie_surface="TVGdeeprough", lie_speed_pct=60 + vla * 0.7,
                     lie_spin_pct=54, lie_vla_pct=98, sent_vla_deg=vla, start_surface=3) for i, vla in enumerate((9, 12, 19, 24, 30))]
        _, result, _, text = self.run_rows(rows)
        fit = result["lie_penalty"]["fits"]["deep rough"]
        self.assertAlmostEqual(fit["b"], 0.7, places=3)
        self.assertIn("deep rough", text)

    def test_green_finish_and_elevation(self):
        rows = [shot(0, db_pin_yd=3.0), shot(1, db_pin_yd=1.0),
                shot(2, aim="lie", club="5i", carry_yd=110, db_raw_carry_game_yd=100, land_y=20),  # 10 m below
                shot(3, aim="lie", club="5i", carry_yd=100, db_raw_carry_game_yd=100, land_y=30),
                shot(4, aim="lie", club="5i", carry_yd=90, db_raw_carry_game_yd=100, land_y=40),
                shot(5, aim="lie", club="5i", carry_yd=100, db_raw_carry_game_yd=100, land_y=30)]
        _, result, _, _ = self.run_rows(rows)
        green = result["green"]
        self.assertEqual(green["pairs"], 1)
        self.assertAlmostEqual(green["first"], 3.0 * aw.M_TO_YD, places=3)
        self.assertAlmostEqual(green["second"], 1.0 * aw.M_TO_YD, places=3)
        self.assertLess(result["elevation"]["fit"]["b"], 0)  # landing below carries further


if __name__ == "__main__":
    unittest.main()
