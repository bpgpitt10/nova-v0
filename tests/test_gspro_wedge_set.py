"""Partial wedges in the shot tools: the wedge set in the lab, and typed distances in test_shots."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "gspro_lie_lab"))
import roll_replay as rr  # noqa: E402
import test_shots as ts  # noqa: E402


class WedgeSetTests(unittest.TestCase):
    def test_set_is_four_flights_clean_and_low_spin(self):
        types = rr.wedge_types()
        self.assertEqual(list(types), ["runner", "runner low", "flighted", "flighted low",
                                       "standard", "standard low", "high", "high low"])
        self.assertAlmostEqual(types["standard low"]["spin"] / types["standard"]["spin"], 0.75, places=2)
        self.assertEqual(types["standard"]["vla"], 29.0)
        shots = rr.chip_set(types, rr.read_wedge_carries("wedge 65 stimp 11"), rr.WEDGE_SPEED_POWER)
        self.assertEqual(len(shots), 8)

    def test_typed_carries(self):
        self.assertEqual(rr.read_wedge_carries("wedge stimp 11"), (65.0,))
        self.assertEqual(rr.read_wedge_carries("wedge 50 stimp 13"), (50.0,))
        self.assertEqual(rr.read_wedge_carries("wedge 50 65 80"), (50.0, 65.0, 80.0))
        self.assertEqual(rr.read_wedge_carries("wedge 30 95"), (65.0,))  # outside 40 to 90: the stock carry

    def test_speed_and_spin_scale_to_the_carry(self):
        types = rr.wedge_types()
        (_, to50), (_, to80) = rr.chip_set({"standard": types["standard"]}, (50.0, 80.0), rr.WEDGE_SPEED_POWER)
        near, far = rr.chip_speed(to50, None), rr.chip_speed(to80, None)
        self.assertAlmostEqual(near["speed"], 52.8, delta=0.3)  # Brian's own 50.7 yd shot left at 53.2 mph
        self.assertAlmostEqual(far["speed"], 70.8, delta=0.4)
        self.assertAlmostEqual(near["spin"] / near["speed"], 137, delta=1)  # spin goes with ball speed
        self.assertAlmostEqual(rr.chip_expected_carry(to80, far["speed"]), 80.0, delta=0.2)
        # The chip set still uses its own speed power.
        _, chip = rr.chip_set(rr.CHIP_TYPES)[0]
        self.assertAlmostEqual(rr.chip_expected_carry(chip, rr.chip_speed(chip, None)["speed"]), 5.0, delta=0.1)


class TypedDistanceTests(unittest.TestCase):
    def test_a_bare_number_is_a_distance_not_a_club(self):
        five = ts.parse("5")
        self.assertIn("5 yd carry", five["label"])
        self.assertLess(five["speed"], 25)
        self.assertEqual(ts.parse("5i")["club"], "5i")
        self.assertEqual(ts.parse("7i")["label"], "stock 7i")

    def test_a_short_distance_gets_the_swing_that_hits_it(self):
        pitch = ts.parse("23")  # was a lob wedge at 50% with its full 10,800 rpm
        self.assertEqual(pitch["vla"], 28.0)
        self.assertLess(pitch["spin"], 5000)
        partial = ts.parse("60")
        self.assertEqual(partial["vla"], 29.0)
        self.assertAlmostEqual(partial["spin"] / partial["speed"], 137, delta=1)
        self.assertEqual(ts.parse("60 L")["hla"], -3.0)
        # Within 5% of the shortest club it is still that club, eased off, with less spin.
        eased = ts.parse("82")
        self.assertEqual(eased["club"], "LW")
        self.assertLess(eased["spin"], ts.BAG["LW"]["spin"])

    def test_flights_by_name(self):
        self.assertEqual(ts.parse("flighted 70")["vla"], 23.0)
        low, clean = ts.parse("high 65 low"), ts.parse("high 65")
        self.assertAlmostEqual(low["spin"] / clean["spin"], 0.75, places=2)
        self.assertEqual(low["speed"], clean["speed"])
        with self.assertRaises(ts.ShotError):
            ts.parse("standard")


if __name__ == "__main__":
    unittest.main()
