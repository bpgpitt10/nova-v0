"""The wander walk: where it clicks, when it walks back, and when it stops (no GSPro needed)."""
import random
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "gspro_lie_lab"))
import wander  # noqa: E402

WINDOW = (0, 0, 3840, 2160)


class FakeDesktop:
    def __init__(self, move_mouse_after: int | None = None):
        self.clicks = []
        self.move_mouse_after = move_mouse_after

    def gspro_window(self):
        return 1, WINDOW

    def mouse(self):
        x, y = self.clicks[-1]
        if self.move_mouse_after is not None and len(self.clicks) >= self.move_mouse_after:
            return x + 200, y  # the player picked up the mouse
        return x, y

    def click(self, hwnd, x, y):
        self.clicks.append((x, y))


class WanderTests(unittest.TestCase):
    def run_walk(self, desktop, spots, starts, pins):
        """`starts`: where GSPro says each spot's shot was hit from; `pins`: yards to the pin."""
        positions = iter(starts)
        pin_iter = iter(pins)

        def fake_hit_spot(path, writer, flush, **kwargs):
            row = {"spot": kwargs["spot"], "db_pin_yd": next(pin_iter), "note": kwargs["typed"], **kwargs["labels"]}
            return [row] * len(kwargs["spot_shots"]), True

        current = {"start": None}

        def fake_ball_position(_):
            return current["start"]

        def advancing_hit(*args, **kwargs):
            current["start"] = next(positions)
            return fake_hit_spot(*args, **kwargs)

        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(wander, "hit_spot", advancing_hit), patch.object(wander, "ball_position", fake_ball_position):
            folder = Path(tmp)
            said = []
            rows = wander.wander(None, None, lambda: None, desktop=desktop, spots=spots, shots_per_spot=3, side="right",
                                 labels={"test": "wander"}, round_file=folder / "r", log_file=folder / "l", db_path=folder / "d",
                                 notes_file=folder / "n", read_lie=lambda: {"slope_up_deg": 2.0, "slope_right_deg": -1.5,
                                                                            "slope_read": "companion"},
                                 rng=random.Random(7), sleep=lambda _s: None, say=said.append)
        return rows, said

    def test_clicks_land_inside_the_minimap_map(self):
        desktop = FakeDesktop()
        starts = [(i * 20.0, 0.0, i * 30.0) for i in range(6)]
        rows, _ = self.run_walk(desktop, 6, starts, [300, 260, 220, 180, 140, 100])
        left, top, right, bottom = wander.map_rect(WINDOW, "right")
        self.assertEqual(len(desktop.clicks), 6)
        for x, y in desktop.clicks:
            self.assertTrue(left <= x <= right and top <= y <= bottom, (x, y))
        self.assertEqual(len(rows), 18)  # three shots a spot
        self.assertEqual(rows[0]["slope_up_deg"], 2.0)
        self.assertIn("slope 2.0 up 1.5 left", rows[0]["note"])

    def test_near_the_pin_it_walks_back_down_the_hole(self):
        desktop = FakeDesktop()
        starts = [(i * 20.0, 0.0, i * 30.0) for i in range(3)]
        self.run_walk(desktop, 3, starts, [40, 30, 20])
        left, top, right, bottom = wander.map_rect(WINDOW, "right")
        for _, y in desktop.clicks[1:]:  # after the first spot the pin is known to be close
            self.assertGreater(y, top + 0.84 * (bottom - top))

    def test_moving_the_mouse_stops_it(self):
        desktop = FakeDesktop(move_mouse_after=2)
        starts = [(i * 20.0, 0.0, i * 30.0) for i in range(10)]
        rows, said = self.run_walk(desktop, 10, starts, [300] * 10)
        self.assertEqual(len(desktop.clicks), 2)
        self.assertTrue(any("mouse moved" in line for line in said))

    def test_three_clicks_that_do_not_move_the_ball_stop_it(self):
        desktop = FakeDesktop()
        rows, said = self.run_walk(desktop, 10, [(5.0, 0.0, 5.0)] * 10, [300] * 10)
        self.assertEqual(len(desktop.clicks), 4)  # the first spot, then three that went nowhere
        self.assertTrue(any("did not move the ball" in line for line in said))


if __name__ == "__main__":
    unittest.main()
