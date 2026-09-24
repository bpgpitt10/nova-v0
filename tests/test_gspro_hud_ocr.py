import importlib.util
import pathlib
import unittest


HELPER_PATH = pathlib.Path(__file__).resolve().parents[1] / "helpers" / "open_golf_coach_helper.py"
SPEC = importlib.util.spec_from_file_location("open_golf_coach_helper", HELPER_PATH)
HELPER = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(HELPER)


class WindOcrParserTests(unittest.TestCase):
    def test_parses_speed_and_cardinal(self):
        parsed = HELPER.parse_wind_ocr_text("12 MPH NE")
        self.assertEqual(parsed["status"], "READY")
        self.assertEqual(parsed["speedMph"], 12.0)
        self.assertEqual(parsed["directionDegrees"], 45)
        self.assertEqual(parsed["referenceFrame"], "compass")
        self.assertEqual(parsed["convention"], "toward")

    def test_marks_incomplete_wind_unknown(self):
        parsed = HELPER.parse_wind_ocr_text("NE")
        self.assertEqual(parsed["status"], "UNKNOWN")
        self.assertIsNone(parsed["speedMph"])
        self.assertEqual(parsed["directionDegrees"], 45)


class LieOcrParserTests(unittest.TestCase):
    def test_label_first_layout(self):
        parsed = HELPER.parse_lie_ocr_text("FAIRWAY UP 2.1 RIGHT 0.7")
        self.assertEqual(parsed["status"], "READY")
        self.assertEqual(parsed["surface"], "fairway")
        self.assertAlmostEqual(parsed["upDownDegrees"], 2.1)
        self.assertAlmostEqual(parsed["leftRightDegrees"], 0.7)
        self.assertIn("label-first", parsed["note"])

    def test_value_first_layout(self):
        parsed = HELPER.parse_lie_ocr_text("ROUGH 1.8 DOWN 0.6 LEFT")
        self.assertEqual(parsed["status"], "READY")
        self.assertEqual(parsed["surface"], "rough")
        self.assertAlmostEqual(parsed["upDownDegrees"], -1.8)
        self.assertAlmostEqual(parsed["leftRightDegrees"], -0.6)
        self.assertIn("value-first", parsed["note"])

    def test_label_first_does_not_steal_up_value_for_right_axis(self):
        parsed = HELPER.parse_lie_ocr_text("UP 2.1 RIGHT 0.7")
        self.assertAlmostEqual(parsed["upDownDegrees"], 2.1)
        self.assertAlmostEqual(parsed["leftRightDegrees"], 0.7)

    def test_mixed_layout_can_still_parse_both_axes(self):
        parsed = HELPER.parse_lie_ocr_text("SAND DOWN 1.5 0.4 RIGHT")
        self.assertEqual(parsed["status"], "READY")
        self.assertEqual(parsed["surface"], "sand")
        self.assertAlmostEqual(parsed["upDownDegrees"], -1.5)
        self.assertAlmostEqual(parsed["leftRightDegrees"], 0.4)
        self.assertIn("mixed/partial", parsed["note"])

    def test_missing_axis_stays_unknown(self):
        parsed = HELPER.parse_lie_ocr_text("GREEN UP 0.8")
        self.assertEqual(parsed["status"], "UNKNOWN")
        self.assertAlmostEqual(parsed["upDownDegrees"], 0.8)
        self.assertIsNone(parsed["leftRightDegrees"])


if __name__ == "__main__":
    unittest.main()
