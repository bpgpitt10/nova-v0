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
        x, y = self.clicks[-1] if self.clicks else (10, 10)
        if self.move_mouse_after is not None and len(self.clicks) >= self.move_mouse_after:
            return x + 200, y  # the player picked up the mouse
        return x, y

    def move_ball(self, hwnd, button, x, y):
        self.buttons = getattr(self, "buttons", []) + [button]
        self.clicks.append((x, y))


class WanderTests(unittest.TestCase):
    def run_walk(self, desktop, spots, starts, pins):
        """`starts`: where GSPro says each spot's shots were hit from; `pins`: yards to the pin from there."""
        fired = []
        current = {"start": None}

        def fake_hit_spot(path, writer, flush, **kwargs):
            index = kwargs["spot"] - 1
            current["start"] = starts[index]
            fired.append((kwargs["spot"], kwargs["labels"].get("aim"), [name for name, _ in kwargs["spot_shots"]]))
            row = {"spot": kwargs["spot"], "note": kwargs["typed"], **kwargs["labels"],
                   # A shot that went 50 yd straight at the pin, which is pins[index] yd from the spot.
                   "total_yd": 50.0, "db_pin_yd": (pins[index] - 50.0) / wander.M_TO_YD,
                   "carry_yd": 45.0, "db_raw_carry_game_yd": 50.0}
            return [dict(row) for _ in kwargs["spot_shots"]], True

        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(wander, "hit_spot", fake_hit_spot), \
                patch.object(wander, "ball_position", lambda _: current["start"]):
            folder = Path(tmp)
            said = []
            rows = wander.wander(None, None, lambda: None, desktop=desktop, spots=spots, shots_per_spot=3, side="right",
                                 labels={"test": "wander"}, round_file=folder / "r", log_file=folder / "l", db_path=folder / "d",
                                 notes_file=folder / "n", read_lie=lambda: {"slope_up_deg": 2.0, "slope_right_deg": -1.5,
                                                                            "slope_read": "companion"},
                                 rng=random.Random(7), sleep=lambda _s: None, say=said.append)
        self.fired = fired
        return rows, said

    def test_two_shots_go_at_the_green_when_it_is_in_reach(self):
        desktop = FakeDesktop()
        starts = [(i * 20.0, 0.0, i * 30.0) for i in range(2)]
        rows, _ = self.run_walk(desktop, 2, starts, [300.0, 150.0])
        # 300 yd: out of reach, the other two lie shots. 150 yd: two at the green.
        self.assertEqual([aim for _, aim, _ in self.fired], ["lie", "lie", "lie", "green"])
        green = self.fired[-1][2]
        self.assertEqual(len(green), 2)
        self.assertTrue(all(name.endswith("to green") for name in green))
        # The lie made the test shot carry 90% of flat, so 150 yd plays about 164: the 7i first.
        self.assertEqual(green[0].split()[0], "7i")
        self.assertEqual(rows[-1]["pin_from_spot_yd"], 150.0)

    def test_clicks_land_inside_the_minimap_map(self):
        desktop = FakeDesktop()
        starts = [(i * 20.0, 0.0, i * 30.0) for i in range(6)]
        rows, _ = self.run_walk(desktop, 6, starts, [300, 260, 220, 180, 140, 100])
        left, top, right, bottom = wander.map_rect(WINDOW, "right")
        self.assertEqual(len(desktop.clicks), 5)  # the first spot is where the ball already was
        for x, y in desktop.clicks:
            self.assertTrue(left <= x <= right and top <= y <= bottom, (x, y))
            # Near the hole's line up the middle of the map, never out at the edges.
            self.assertTrue(left + 0.19 * (right - left) <= x <= left + 0.81 * (right - left), (x, y))
        self.assertEqual(len(rows), 18)  # three shots a spot
        # The move-ball button: top left of GSPro's window.
        self.assertTrue(all(bx < 0.1 * WINDOW[2] and by < 0.1 * WINDOW[3] for bx, by in desktop.buttons))
        self.assertEqual(rows[0]["slope_up_deg"], 2.0)
        self.assertIn("slope 2.0 up 1.5 left", rows[0]["note"])

    def test_near_the_pin_it_walks_back_down_the_hole(self):
        desktop = FakeDesktop()
        starts = [(i * 20.0, 0.0, i * 30.0) for i in range(3)]
        self.run_walk(desktop, 3, starts, [40, 30, 20])
        left, top, right, bottom = wander.map_rect(WINDOW, "right")
        for _, y in desktop.clicks:  # the pin is known to be close from the first spot
            self.assertGreater(y, top + 0.89 * (bottom - top))

    def test_moving_the_mouse_stops_it(self):
        desktop = FakeDesktop(move_mouse_after=1)
        starts = [(i * 20.0, 0.0, i * 30.0) for i in range(10)]
        rows, said = self.run_walk(desktop, 10, starts, [300] * 10)
        self.assertEqual(len(desktop.clicks), 1)
        self.assertTrue(any("mouse moved" in line for line in said))

    def test_three_clicks_that_do_not_move_the_ball_stop_it(self):
        desktop = FakeDesktop()
        rows, said = self.run_walk(desktop, 10, [(5.0, 0.0, 5.0)] * 10, [300] * 10)
        self.assertEqual(len(desktop.clicks), 3)  # three clicks after the starting spot, none moved it
        self.assertTrue(any("did not move the ball" in line for line in said))


class ReachTests(unittest.TestCase):
    def test_nothing_is_sent_far_past_the_pin(self):
        shots = [(name, {}) for name in wander.LIE_FLAT_CARRY_YD]
        kept = [name for name, _ in wander.within_reach(shots, 60.0)]
        self.assertTrue(kept)
        self.assertTrue(all(wander.LIE_FLAT_CARRY_YD[name] <= 75.0 for name in kept))
        self.assertNotIn("SW", kept)
        self.assertEqual(len(wander.within_reach(shots, None)), len(shots))  # unknown: no limit

    def test_distance_after_a_click_shrinks_toward_the_pin(self):
        near_ball = wander.distance_after_click(200.0, 1.0)
        near_pin = wander.distance_after_click(200.0, 0.0)
        self.assertGreater(near_ball, 150.0)
        self.assertLess(near_pin, 10.0)
        self.assertIsNone(wander.distance_after_click(None, 0.5))


if __name__ == "__main__":
    unittest.main()
