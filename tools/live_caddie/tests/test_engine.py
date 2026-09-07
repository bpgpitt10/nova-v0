import unittest
from tools.live_caddie.assumptions import Assumptions
from tools.live_caddie.engine import recommend
from tools.live_caddie.models import PointYards, HazardBoundary, GreenSurface, ClubProfile, LiveShotState

class EngineTests(unittest.TestCase):
    def setUp(self):
        self.assumptions = Assumptions.load()

    def test_smooth_candidate_exists_and_is_90_percent(self):
        from tools.live_caddie.candidates import generate_candidates
        profiles = [ClubProfile("7i", 160, 7, 0, 9, 166)]
        state = LiveShotState("approach", 145)
        rows = generate_candidates(profiles, state, self.assumptions)
        smooth = [row for row in rows if row.variant == "Smooth"]
        self.assertTrue(smooth)
        self.assertAlmostEqual(smooth[0].planned_carry_yds, 144.0)

    def test_pure_is_reference_not_playable_default(self):
        from tools.live_caddie.candidates import generate_candidates
        profiles = [ClubProfile("7i", 160, 7, 0, 9, 170)]
        state = LiveShotState("approach", 160)
        rows = generate_candidates(profiles, state, self.assumptions)
        self.assertFalse(any(row.variant == "Pure" for row in rows))

    def test_boundary_pushes_aim_away(self):
        profiles = [ClubProfile("6i", 175, 7, 0, 8)]
        state = LiveShotState("strategic", 175, gspro_aim_right_yds=0)
        hazards = [HazardBoundary("right", [PointYards(150, 6), PointYards(200, 6)])]
        result = recommend(profiles=profiles, state=state, hazards=hazards, assumptions=self.assumptions)
        self.assertIsNotNone(result.recommended)
        self.assertLess(result.recommended.candidate.landing.right, 0)

    def test_approach_prefers_green_containment(self):
        profiles = [ClubProfile("7i", 160, 5, 0, 6)]
        state = LiveShotState("approach", 160)
        green = GreenSurface(
            polygon=[
                PointYards(150, -14), PointYards(170, -14),
                PointYards(170, 14), PointYards(150, 14),
            ],
            pin=PointYards(160, 0),
            confidence=0.9,
        )
        result = recommend(profiles=profiles, state=state, hazards=[], green=green, assumptions=self.assumptions)
        self.assertIsNotNone(result.recommended)
        self.assertEqual(result.recommended.candidate.variant, "Stock")
        self.assertLessEqual(abs(result.recommended.candidate.aim_offset_yds), 4)

    def test_low_registration_adds_fallback(self):
        profiles = [ClubProfile("7i", 160, 5, 0, 6)]
        state = LiveShotState("approach", 160, registration_confidence=0.3)
        result = recommend(profiles=profiles, state=state, hazards=[], assumptions=self.assumptions)
        self.assertTrue(any("registration" in item for item in result.fallbacks))

if __name__ == "__main__":
    unittest.main()
