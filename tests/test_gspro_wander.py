"""The wander walk: where it clicks, how it steps down a hole, when it changes hole and when it stops."""
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
    def __init__(self, move_mouse_after=None, water_until=0):
        self.moves = []      # minimap clicks that moved the ball
        self.plain = []      # other clicks (the flag, a hole)
        self.looks = 0
        self.water_until = water_until
        self.move_mouse_after = move_mouse_after

    def gspro_window(self):
        return 1, WINDOW

    def last(self):
        clicks = self.moves + self.plain
        return clicks[-1] if clicks else (10, 10)

    def mouse(self):
        x, y = self.last()
        if self.move_mouse_after is not None and len(self.moves) >= self.move_mouse_after:
            return x + 200, y  # the player picked up the mouse
        return x, y

    def colours(self, hwnd, points):
        self.looks += 1
        return [(14, 24, 38)] * len(points) if self.looks <= self.water_until else [(64, 85, 41)] * len(points)

    def move_ball(self, hwnd, button, x, y):
        self.button = button
        self.moves.append((x, y))

    def click_at(self, hwnd, x, y):
        self.plain.append((x, y))


class WalkTests(unittest.TestCase):
    def run_walk(self, desktop, pins, starts=None, lies=None, carries=None, surfaces=None):
        """`pins`: yards from each spot to the pin. `starts`: where each spot was hit from (default: moves
        every spot). `lies`: GSPro's lie name per spot. `carries`: what each green shot carried."""
        fired = []
        carry_iter = iter(carries or [])
        state = {"start": None}

        def fake_hit_spot(path, writer, flush, **kwargs):
            index = kwargs["spot"] - 1
            state["start"] = (starts or [(i * 25.0, 0.0, i * 25.0) for i in range(len(pins))])[index]
            aim = kwargs["labels"].get("aim")
            fired.append((kwargs["spot"], aim, kwargs["spot_shots"]))
            rows = []
            for _ in kwargs["spot_shots"]:
                rows.append({"spot": kwargs["spot"], "note": kwargs["typed"], **kwargs["labels"],
                             "status": f"GSPro took it, ball at rest after 6.0 s; next: 7i from {pins[index] / wander.M_TO_YD:.1f} yd",
                             "lie_surface": (lies or {}).get(index + 1),
                             "start_surface": (surfaces or {}).get(index + 1),
                             "carry_yd": next(carry_iter, 45.0) if aim == "green" else 45.0, "db_raw_carry_game_yd": 50.0})
            return rows, True

        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(wander, "hit_spot", fake_hit_spot), \
                patch.object(wander, "ball_position", lambda _: state["start"]):
            folder = Path(tmp)
            said = []
            rows = wander.wander(None, None, lambda: None, desktop=desktop, spots=len(pins), shots_per_spot=3, side="right",
                                 labels={"test": "wander"}, round_file=folder / "r", log_file=folder / "l", db_path=folder / "d",
                                 notes_file=folder / "n", read_lie=lambda: {"slope_up_deg": 2.0, "slope_right_deg": -1.5,
                                                                            "slope_read": "companion"},
                                 rng=random.Random(7), sleep=lambda _s: None, say=said.append, hole=4)
        self.fired, self.said = fired, said
        return rows

    def test_it_steps_forward_then_takes_spots_across_the_hole(self):
        desktop = FakeDesktop()
        self.run_walk(desktop, [420, 340, 335, 338, 330, 270])
        # Spot 1 is where the ball was; then forward, three across, forward.
        self.assertEqual(len(desktop.moves), 5)
        left, top, right, bottom = wander.map_rect(WINDOW, "right")
        for x, y in desktop.moves:
            self.assertTrue(left <= x <= right and top <= y <= bottom, (x, y))
        across = desktop.moves[1:4]
        for x, y in across:  # level with the ball, out to one side
            self.assertGreater(y, top + 0.95 * (bottom - top))
            self.assertGreater(abs(x - (left + right) / 2), 0.14 * (right - left))
        for x, y in (desktop.moves[0], desktop.moves[4]):  # forward: up the middle
            self.assertLess(y, top + 0.9 * (bottom - top))
        self.assertEqual(len({spot for spot, _, _ in self.fired}), 6)
        # The move-ball button is at the top left.
        self.assertLess(desktop.button[0], 0.1 * WINDOW[2])

    def test_inside_50_yards_it_moves_to_the_next_hole(self):
        desktop = FakeDesktop()
        self.run_walk(desktop, [45, 380])
        flag, hole = desktop.plain
        self.assertEqual(flag, wander.button_point(WINDOW, wander.FLAG_BUTTON))
        self.assertEqual(hole, wander.hole_point(WINDOW, 5))  # it started on hole 4
        self.assertTrue(any("hole 5" in line for line in self.said))

    def test_a_par_3_tee_is_hit_from_and_then_left(self):
        desktop = FakeDesktop()
        self.run_walk(desktop, [45, 175, 400])  # hole 5 tee is 175 yd: a par 3
        self.assertEqual(desktop.plain[1], wander.hole_point(WINDOW, 5))
        self.assertEqual(desktop.plain[3], wander.hole_point(WINDOW, 6))
        self.assertEqual(desktop.moves, [])  # never stepped down the par 3

    def test_a_par_4_tee_hits_driver_hybrid_and_iron(self):
        desktop = FakeDesktop()
        self.run_walk(desktop, [45, 380])
        tee = [shots for spot, aim, shots in self.fired if spot == 2 and aim == "tee"]
        self.assertEqual([name for name, _ in tee[0]], ["Driver off the tee", "3H off the tee", "5i off the tee"])

    def test_after_hole_18_comes_hole_1(self):
        self.assertEqual(wander.hole_point(WINDOW, 19), wander.hole_point(WINDOW, 1))
        x10, _ = wander.hole_point(WINDOW, 10)
        x3, _ = wander.hole_point(WINDOW, 3)
        self.assertGreater(x10, x3)  # 10-18 are the right-hand block

    def test_it_looks_before_clicking_and_avoids_water(self):
        desktop = FakeDesktop(water_until=2)
        self.run_walk(desktop, [300, 280])
        self.assertEqual(desktop.looks, 3)  # two water spots turned down, the third taken
        self.assertEqual(len(desktop.moves), 1)

    def test_a_ball_in_water_is_not_hit_again(self):
        desktop = FakeDesktop()
        rows = self.run_walk(desktop, [300, 280], lies={2: "TVGwater"})
        spot_two = [row for row in rows if row["spot"] == 2]
        self.assertEqual(len(spot_two), 1)
        self.assertEqual(spot_two[0]["aim"], "water")

    def test_the_second_green_shot_is_corrected_by_the_first(self):
        desktop = FakeDesktop()
        # 150 yd; the first green shot carried 160 (a green well below): the second is slowed.
        self.run_walk(desktop, [150], carries=[160.0, 148.0])
        green = [shots for _, aim, shots in self.fired if aim == "green"]
        self.assertEqual(len(green), 2)
        (first_name, first), (second_name, second) = green[0][0], green[1][0]
        stock = wander.green_shots(150.0, 0.9, 2)[1][1]
        self.assertLess(second["speed"], stock["speed"])

    def test_a_ball_left_on_a_tee_gets_tee_shots(self):
        # Farmlinks 2, 20 Nov: started on a 300 yd tee and hit PW and 5i instead of tee shots.
        desktop = FakeDesktop()
        self.run_walk(desktop, [300, 240], surfaces={1: "18"})
        first = [shots for spot, aim, shots in self.fired if spot == 1 and aim == "tee"]
        self.assertEqual([name for name, _ in first[0]], ["Driver off the tee", "3H off the tee", "5i off the tee"])

    def test_no_driver_off_the_ground_and_no_200_mph_hybrid(self):
        # 235 yd out of deep rough that plays 63%: out of reach, so lie shots, and never the driver.
        desktop = FakeDesktop()
        with patch.object(wander, "plays_here", lambda _row: 0.63):
            self.run_walk(desktop, [235])
        names = [name for _, _, shots in self.fired for name, _ in shots]
        self.assertFalse(any(name.startswith("Driver") for name in names), names)
        self.assertFalse(any(aim == "green" for _, aim, _ in self.fired))
        # From the fairway at 200 yd, green shots stay near stock speed, the second one too.
        desktop = FakeDesktop()
        self.run_walk(desktop, [200], carries=[150.0, 190.0])
        for _, aim, shots in self.fired:
            for name, shot in shots:
                if aim == "green":
                    self.assertFalse(name.startswith("Driver"))
                    stock = wander.BAG[name.split()[0]]["speed"]
                    self.assertLessEqual(shot["speed"], stock * wander.SPEED_SCALE[1] + 0.05, name)

    def test_moving_the_mouse_stops_it(self):
        desktop = FakeDesktop(move_mouse_after=1)
        self.run_walk(desktop, [300] * 6)
        self.assertEqual(len(desktop.moves), 1)
        self.assertTrue(any("mouse moved" in line for line in self.said))

    def test_three_clicks_that_do_not_move_the_ball_stop_it(self):
        desktop = FakeDesktop()
        self.run_walk(desktop, [300] * 10, starts=[(5.0, 0.0, 5.0)] * 10)
        self.assertEqual(len(desktop.moves), 3)
        self.assertTrue(any("did not move the ball" in line for line in self.said))


class ReachTests(unittest.TestCase):
    def test_nothing_is_sent_far_past_the_pin(self):
        shots = [(name, {}) for name in wander.LIE_FLAT_CARRY_YD]
        kept = [name for name, _ in wander.within_reach(shots, 60.0)]
        self.assertTrue(kept)
        self.assertTrue(all(wander.LIE_FLAT_CARRY_YD[name] <= 75.0 for name in kept))
        self.assertEqual(len(wander.within_reach(shots, None)), len(shots))  # unknown: no limit

    def test_distance_after_a_click_shrinks_toward_the_pin(self):
        self.assertGreater(wander.distance_after_click(200.0, 1.0), 150.0)
        self.assertLess(wander.distance_after_click(200.0, 0.0), 10.0)
        self.assertIsNone(wander.distance_after_click(None, 0.5))

    def test_water_and_hazard_lines_are_recognised(self):
        self.assertTrue(wander.looks_like_water([(14, 24, 38), (34, 39, 45), (14, 17, 33)]))
        self.assertTrue(wander.looks_like_water([(200, 30, 30)] * 4))  # a red hazard line
        for name, colour in (("fairway", (64, 85, 41)), ("rough", (38, 51, 28)), ("trees", (14, 30, 12)),
                             ("sand", (171, 155, 120))):
            self.assertFalse(wander.looks_like_water([colour] * 9), name)
        self.assertFalse(wander.looks_like_water([]))


class PinDistanceTests(unittest.TestCase):
    def test_a_shot_past_the_pin_does_not_add_its_overshoot(self):
        # Farmlinks, 20 Nov: soft 70 from 71.5 yd went 82 yd, 11 past. GSPro's reply has the true distance.
        row = {"status": "GSPro took it, ball at rest after 7.4 s; next: LW from 65.4 yd", "total_yd": 82.48, "db_pin_yd": 9.98}
        self.assertAlmostEqual(wander.pin_from_spot_yd(row), 71.5, delta=0.1)

    def test_a_shot_that_finishes_by_the_pin_is_not_zero_yards_out(self):
        # Farmlinks 1, 20 Nov: soft 50 finished by the pin; GSPro's reply said "from 0.0 yd".
        row = {"status": "GSPro took it, ball at rest after 6.2 s; next: LW from 0.0 yd", "total_yd": 47.9}
        self.assertAlmostEqual(wander.pin_from_spot_yd(row), 47.9)


if __name__ == "__main__":
    unittest.main()
