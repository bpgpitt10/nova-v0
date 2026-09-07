import unittest

from tools.live_caddie.assumptions import Assumptions
from tools.live_caddie.source_resolution import resolve_distance_to_pin


class SourceResolutionTests(unittest.TestCase):
    def setUp(self):
        self.assumptions = Assumptions.load()

    def test_upper_left_wins_when_sources_agree(self):
        result = resolve_distance_to_pin(
            upper_left_yds=245,
            pin_card_yds=245,
            canonical_yds=244.4,
            canonical_registration_confidence=0.92,
            assumptions=self.assumptions,
        )
        self.assertEqual(result.source, "upper-left-distance-to-pin")
        self.assertEqual(result.status, "resolved")
        self.assertEqual(result.value_yds, 245.0)

    def test_pin_card_wins_before_upper_left_exists(self):
        result = resolve_distance_to_pin(
            pin_card_yds=245,
            canonical_yds=244.4,
            canonical_registration_confidence=0.92,
            assumptions=self.assumptions,
        )
        self.assertEqual(result.source, "pin-card-distance-to-pin")
        self.assertEqual(result.status, "resolved")

    def test_low_confidence_canonical_is_not_eligible(self):
        result = resolve_distance_to_pin(
            canonical_yds=245,
            canonical_registration_confidence=0.40,
            assumptions=self.assumptions,
        )
        self.assertIsNone(result.source)
        self.assertEqual(result.status, "unavailable")

    def test_large_disagreement_surfaces_hard_conflict(self):
        result = resolve_distance_to_pin(
            upper_left_yds=245,
            pin_card_yds=210,
            canonical_yds=244,
            canonical_registration_confidence=0.95,
            assumptions=self.assumptions,
        )
        self.assertEqual(result.source, "upper-left-distance-to-pin")
        self.assertEqual(result.status, "hard-conflict")
        self.assertLessEqual(result.confidence, 0.35)


if __name__ == "__main__":
    unittest.main()
