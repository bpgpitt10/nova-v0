"""EXPERIMENTAL voice commands: the parser and the listener's bookkeeping.

No speech engine or microphone here; the packaged build's selftest covers those.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "helpers"))

import looper_voice as voice  # noqa: E402


class ParseCommandTest(unittest.TestCase):
    def test_arm_a_named_club(self):
        self.assertEqual(voice.parse_command("looper arm three wood"), {"action": "arm", "club": "3W"})
        self.assertEqual(voice.parse_command("caddie arm seven iron"), {"action": "arm", "club": "7i"})
        self.assertEqual(voice.parse_command("caddy sand wedge"), {"action": "arm", "club": "SW"})
        self.assertEqual(voice.parse_command("looper driver"), {"action": "arm", "club": "Driver"})
        self.assertEqual(voice.parse_command("looper arm mini driver"), {"action": "arm", "club": "Mini Driver"})
        self.assertEqual(voice.parse_command("looper four hybrid"), {"action": "arm", "club": "4H"})

    def test_club_nicknames(self):
        self.assertEqual(voice.parse_command("looper pitching"), {"action": "arm", "club": "PW"})
        self.assertEqual(voice.parse_command("looper arm lob"), {"action": "arm", "club": "LW"})
        self.assertEqual(voice.parse_command("caddie four rescue"), {"action": "arm", "club": "4H"})

    def test_arm_what_the_screen_shows(self):
        self.assertEqual(voice.parse_command("looper arm it"), {"action": "arm-shown"})
        self.assertEqual(voice.parse_command("caddie arm"), {"action": "arm-shown"})

    def test_clear(self):
        for word in ("clear", "disarm", "cancel"):
            self.assertEqual(voice.parse_command(f"looper {word}"), {"action": "clear"})

    def test_aim(self):
        self.assertEqual(voice.parse_command("looper aim left five yards"),
                         {"action": "aim", "direction": "left", "yards": 5})
        self.assertEqual(voice.parse_command("looper aim right ten"),
                         {"action": "aim", "direction": "right", "yards": 10})
        self.assertEqual(voice.parse_command("looper aim left twenty five"),
                         {"action": "aim", "direction": "left", "yards": 25})
        self.assertEqual(voice.parse_command("looper aim right one yard"),
                         {"action": "aim", "direction": "right", "yards": 1})
        # No number: one aim step.
        self.assertEqual(voice.parse_command("caddie aim left"),
                         {"action": "aim", "direction": "left", "yards": voice.DEFAULT_AIM_YARDS})
        self.assertEqual(voice.parse_command("looper reset aim"), {"action": "aim-reset"})
        self.assertEqual(voice.parse_command("looper aim center"), {"action": "aim-reset"})
        self.assertIsNone(voice.parse_command("looper aim"))
        self.assertIsNone(voice.parse_command("looper aim five"))
        self.assertIsNone(voice.parse_command("looper aim left thirty five"))  # past the limit

    def test_other_looper_actions(self):
        self.assertEqual(voice.parse_command("looper club up"), {"action": "club-step", "direction": "up"})
        self.assertEqual(voice.parse_command("caddie club down"), {"action": "club-step", "direction": "down"})
        self.assertEqual(voice.parse_command("looper refresh wind"), {"action": "wind"})
        self.assertEqual(voice.parse_command("looper details"), {"action": "details"})

    def test_gspro_views_are_their_own_commands_not_clubs(self):
        # "Looper, flyover" used to be heard as five wood.
        self.assertEqual(voice.parse_command("looper flyover"), {"action": "gspro", "key": "flyover"})
        self.assertEqual(voice.parse_command("looper fly over"), {"action": "gspro", "key": "flyover"})
        self.assertEqual(voice.parse_command("caddie scorecard"), {"action": "gspro", "key": "scorecard"})
        self.assertEqual(voice.parse_command("looper heat map"), {"action": "gspro", "key": "heatmap"})

    def test_nothing_without_a_wake_word(self):
        self.assertIsNone(voice.parse_command("arm three wood"))
        self.assertIsNone(voice.parse_command("three wood"))
        self.assertIsNone(voice.parse_command("aim left five"))
        self.assertIsNone(voice.parse_command(""))
        self.assertIsNone(voice.parse_command(None))

    def test_wake_word_alone_or_noise_is_not_a_command(self):
        self.assertIsNone(voice.parse_command("looper"))
        self.assertIsNone(voice.parse_command("[unk] looper [unk]"))

    def test_every_word_must_belong_to_the_command(self):
        self.assertIsNone(voice.parse_command("looper three wood left"))
        self.assertIsNone(voice.parse_command("looper arm it up"))
        self.assertIsNone(voice.parse_command("looper clear three wood"))
        self.assertIsNone(voice.parse_command("looper club"))

    def test_noise_around_a_command_is_ignored(self):
        self.assertEqual(voice.parse_command("[unk] caddie arm nine iron"), {"action": "arm", "club": "9i"})
        self.assertEqual(voice.parse_command("looper looper arm it"), {"action": "arm-shown"})

    def test_bag_limits_what_can_be_heard(self):
        full = voice.grammar()
        bag = voice.grammar(frozenset({"Driver", "7i", "SW"}))
        self.assertIn("five wood", full)
        self.assertNotIn("five wood", bag)
        self.assertIn("seven iron", bag)
        self.assertIn("sand", bag)
        self.assertIn("flyover", bag)
        self.assertEqual(bag[-1], "[unk]")
        self.assertEqual(len(bag), len(set(bag)))

    def test_confidence_is_the_weakest_real_word(self):
        result = {"text": "looper arm three wood", "result": [
            {"word": "looper", "conf": 1.0}, {"word": "arm", "conf": 0.9},
            {"word": "[unk]", "conf": 0.1}, {"word": "three", "conf": 0.42}, {"word": "wood", "conf": 1.0},
        ]}
        self.assertEqual(voice.confidence(result), 0.42)
        self.assertIsNone(voice.confidence({"text": ""}))


class ListenerBookkeepingTest(unittest.TestCase):
    def test_events_are_numbered_and_duplicates_dropped(self):
        listener = voice.VoiceListener()
        first = listener.handle_text("looper arm three wood", 0.9)
        self.assertEqual(first["seq"], 1)
        self.assertEqual(first["club"], "3W")
        self.assertEqual(first["conf"], 0.9)
        # The recogniser can report the same breath twice.
        self.assertIsNone(listener.handle_text("looper arm three wood"))
        second = listener.handle_text("looper clear")
        self.assertEqual(second["seq"], 2)
        self.assertIsNone(second["club"])

    def test_first_poll_never_replays_old_commands(self):
        listener = voice.VoiceListener()
        listener.handle_text("looper arm three wood")
        first_poll = listener._payload("listening", None, None)
        self.assertEqual(first_poll["events"], [])
        self.assertEqual(first_poll["latest"], 1)
        listener.handle_text("looper clear")
        later = listener._payload("listening", None, first_poll["latest"])
        self.assertEqual([event["action"] for event in later["events"]], ["clear"])

    def test_wake_word_alone_opens_a_short_window(self):
        listener = voice.VoiceListener()
        self.assertIsNone(listener.handle_text("looper"))
        heard = listener._payload("listening", None, 0)["lastHeard"]
        self.assertTrue(heard["waiting"])
        self.assertFalse(heard["command"])
        # The command follows without the wake word.
        event = listener.handle_text("aim left five")
        self.assertEqual((event["action"], event["direction"], event["yards"]), ("aim", "left", 5))
        # The window closes once it is used.
        self.assertIsNone(listener.handle_text("three wood"))

    def test_wake_word_with_a_bad_command_is_a_miss_not_a_window(self):
        listener = voice.VoiceListener()
        self.assertIsNone(listener.handle_text("looper three wood left"))
        heard = listener._payload("listening", None, 0)["lastHeard"]
        self.assertFalse(heard["waiting"])
        self.assertFalse(heard["command"])
        self.assertIsNone(listener.handle_text("three wood"))

    def test_chatter_is_not_remembered(self):
        listener = voice.VoiceListener()
        listener.handle_text("looper arm it")
        listener.handle_text("[unk] three wood [unk]")
        self.assertEqual(listener._payload("listening", None, 0)["lastHeard"]["text"], "looper arm it")

    def test_level_and_resampling(self):
        import array
        import math

        silence = array.array("h", [0] * 4000).tobytes()
        self.assertEqual(voice._level(silence), 0.0)
        loud = array.array("h", [int(20000 * math.sin(i / 5)) for i in range(4000)]).tobytes()
        self.assertGreater(voice._level(loud), 0.3)
        # 48 kHz -> 16 kHz keeps a third of the samples, across block edges too.
        block = array.array("h", [1000] * 12000).tobytes()
        out_a, state = voice._to_16k(block, 48000, None)
        out_b, state = voice._to_16k(block, 48000, state)
        self.assertAlmostEqual((len(out_a) + len(out_b)) / 2, 8000, delta=4)
        self.assertEqual(voice._to_16k(block, 16000, None)[0], block)

    def test_no_model_means_unavailable_and_no_microphone(self):
        # In this test environment there is no speech model, so a poll must
        # not start a listening thread.
        if voice.available():
            self.skipTest("a speech model is installed here")
        payload = voice.LISTENER.poll(None, clubs=frozenset({"Driver"}))
        self.assertEqual(payload["status"], "unavailable")
        self.assertIsNone(voice.LISTENER._thread)


if __name__ == "__main__":
    unittest.main()
