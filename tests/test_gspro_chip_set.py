"""The chip set in the shot tool: every chip type to a few carries, one shot each."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "gspro_lie_lab"))
import roll_replay as rr  # noqa: E402


class FakePath:
    def __init__(self):
        self.sent = []

    def fire(self, shot):
        self.sent.append(shot)
        return "ball at rest"


class ChipSetTests(unittest.TestCase):
    def test_set_is_every_type_to_every_carry_grouped_by_type(self):
        shots = rr.chip_set(rr.CHIP_TYPES)
        self.assertEqual(len(shots), 12)
        self.assertEqual([name for name, _ in shots[:3]], ["bump 5 yd", "bump 10 yd", "bump 16 yd"])
        self.assertEqual({shot["_chip"] for _, shot in shots}, {"bump", "chip", "pitch", "flop"})

    def test_typed_carries(self):
        self.assertEqual(rr.read_chip_carries("chip"), (5.0, 10.0, 16.0))
        self.assertEqual(rr.read_chip_carries("chip 4 8 12 stimp 11"), (4.0, 8.0, 12.0))
        self.assertEqual(rr.read_chip_carries("chip 0 99"), (5.0, 10.0, 16.0))
        self.assertEqual(rr.read_chip_carries("chip 30 45 60"), (30.0, 45.0, 60.0))

    def test_speed_scales_to_the_carry(self):
        _, shot = rr.chip_set(rr.CHIP_TYPES)[0]  # bump to 5 yd; reference carries 10 yd
        sent = rr.chip_speed(shot, None)
        self.assertAlmostEqual(rr.chip_expected_carry(shot, sent["speed"]), 5.0, delta=0.1)
        self.assertEqual(sent["vla"], 12.0)
        self.assertLess(sent["spin"], rr.CHIP_TYPES["bump"]["spin"])  # a shorter chip spins less
        # The type carried 20% further than the scale said: the next one is sent softer.
        self.assertLess(rr.chip_speed(shot, 1.2)["speed"], sent["speed"])

    def test_chips_json_replaces_the_placeholders(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, rr.CHIP_FILE).write_text(json.dumps({"Bump": {"speed": 30, "vla": 12, "spin": 2800, "carry": 9}}))
            self.assertEqual(rr.chip_types(Path(tmp)), {"bump": {"speed": 30.0, "vla": 12.0, "spin": 2800.0, "carry": 9.0}})
            Path(tmp, rr.CHIP_FILE).write_text("{not json")
            self.assertIs(rr.chip_types(Path(tmp)), rr.CHIP_TYPES)
        self.assertIs(rr.chip_types(Path("/nonexistent")), rr.CHIP_TYPES)

    def test_each_type_corrects_from_its_own_first_chip(self):
        path = FakePath()
        shots = rr.chip_set({"bump": rr.CHIP_TYPES["bump"], "flop": rr.CHIP_TYPES["flop"]}, (5.0, 10.0))
        carries = iter([6.0, 12.0, 5.0, 10.0])  # bump flies 20% long; flop is on the scale
        rows = []

        class Writer:
            def writerow(self, row):
                rows.append(row)

        with patch.object(rr, "newest_round_record", return_value=None), \
                patch.object(rr, "record_fingerprint", return_value=None), \
                patch.object(rr, "log_size", return_value=0), \
                patch.object(rr, "latest_row_safely", return_value=None), \
                patch.object(rr, "wait_for_new_record", return_value={}), \
                patch.object(rr, "read_log_since", return_value=""), \
                patch.object(rr, "lie_from_log", return_value={}), \
                patch.object(rr, "wait_for_new_row", return_value=None), \
                patch.object(rr, "measure_landing", side_effect=lambda record: {"carry_yd": next(carries), "roll_yd": 1.0}), \
                tempfile.TemporaryDirectory() as tmp:
            got, connected = rr.hit_spot(path, Writer(), lambda: None, labels={"stimp": 11.0}, spot=1, typed="chip",
                                         spot_shots=shots, round_file=Path(tmp, "r"), log_file=Path(tmp, "l"),
                                         db_path=Path(tmp, "d"), notes_file=Path(tmp, "n.txt"), gap=0, record_wait=0,
                                         sleep=lambda s: None, test="chip")
        self.assertTrue(connected)
        self.assertEqual([r["test"] for r in got], ["chip"] * 4)
        bump_first, bump_second, flop_first, flop_second = (shot["speed"] for shot in path.sent)
        no_correction = rr.chip_speed(shots[1][1], None)["speed"]
        self.assertLess(bump_second, no_correction)  # bump corrected for flying long
        self.assertAlmostEqual(flop_second, rr.chip_speed(shots[3][1], None)["speed"], delta=0.2)  # flop left alone
        self.assertTrue(all("_chip" not in shot for shot in path.sent))

    def test_lie_session_needs_a_stimp_then_hits_the_set(self):
        calls = []

        def fake_hit_spot(path, writer, flush, **kwargs):
            calls.append(kwargs)
            return [], True

        lines = iter(["chip", "chip stimp 11", "q"])
        with patch.object(rr, "hit_spot", fake_hit_spot), tempfile.TemporaryDirectory() as tmp:
            rr.lie_session(FakePath(), lambda prompt: next(lines), None, lambda: None, labels={},
                           round_file=Path(tmp, "r"), log_file=Path(tmp, "l"), db_path=Path(tmp, "d"),
                           notes_file=Path(tmp, "n"), gap=0, record_wait=0, sleep=lambda s: None)
        self.assertEqual(len(calls), 1)  # the first line had no stimp
        self.assertEqual(calls[0]["test"], "chip")
        self.assertEqual(calls[0]["labels"]["stimp"], 11.0)
        self.assertEqual(len(calls[0]["spot_shots"]), 12)


if __name__ == "__main__":
    unittest.main()
