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

    def test_natural_wordings(self):
        same = {
            "wind": ["wind", "update wind", "fix the wind", "give me new wind", "new wind", "check the wind"],
            "arm-shown": ["arm that", "lock it in", "send it"],
            "arm-recommended": ["your call", "your pick", "the play", "arm your pick"],
            "clear": ["never mind", "stop", "cancel"],
            "aim-reset": ["reset aim", "center it", "aim center"],
            "confirm": ["yes", "do it", "confirm"],
            "details": ["show details", "hide details"],
        }
        for action, wordings in same.items():
            for wording in wordings:
                self.assertEqual(voice.parse_command("looper " + wording), {"action": action}, wording)
        left5 = {"action": "aim", "direction": "left", "yards": 5}
        for wording in ("left five", "five left", "five yards left", "move it left five", "aim five left"):
            self.assertEqual(voice.parse_command("looper " + wording), left5, wording)
        self.assertEqual(voice.parse_command("looper a little right"),
                         {"action": "aim", "direction": "right", "yards": voice.DEFAULT_AIM_YARDS})
        for wording in ("up a club", "more club", "one more club", "give me more club"):
            self.assertEqual(voice.parse_command("caddie " + wording),
                             {"action": "club-step", "direction": "up"}, wording)
        self.assertEqual(voice.parse_command("caddie less club"), {"action": "club-step", "direction": "down"})
        for wording in ("give me the three wood", "switch two three wood", "i want the three wood"):
            self.assertEqual(voice.parse_command("looper " + wording), {"action": "arm", "club": "3W"}, wording)
        self.assertEqual(voice.parse_command("looper two iron"), {"action": "arm", "club": "2i"})
        for wording, key in (("show the overview", "flyover"), ("card", "scorecard"), ("grid", "greengrid"),
                             ("flag", "pin"), ("shot camera", "shotcam"), ("putting mode", "putt")):
            self.assertEqual(voice.parse_command("looper " + wording), {"action": "gspro", "key": key}, wording)

    def test_retry_does_the_same_aim_again(self):
        for wording in ("retry", "try again", "again", "do it again", "aim again", "please retry"):
            self.assertEqual(voice.parse_command("looper " + wording), {"action": "retry"}, wording)
        self.assertEqual(voice.parse_command("looper do it"), {"action": "confirm"})
        self.assertIn("retry", voice.grammar())

    def test_chip_shots_show_or_arm(self):
        # Brian, 21 Nov: "pitch" shows it, "show me the pitch shot" too; "arm" aims it.
        for wording, shot in (("pitch", "pitch"), ("show me the pitch shot", "pitch"), ("show me pitch", "pitch"),
                              ("flop", "flop"), ("the flop shot", "flop"), ("chip", "chip"),
                              ("bump and run", "bump"), ("give me the bump and run", "bump")):
            self.assertEqual(voice.parse_command("looper " + wording),
                             {"action": "chip", "shot": shot, "arm": False}, wording)
        for wording, shot in (("arm the pitch", "pitch"), ("arm flop", "flop"), ("arm the bump and run", "bump")):
            self.assertEqual(voice.parse_command("looper " + wording),
                             {"action": "chip", "shot": shot, "arm": True}, wording)
        # Wedges stay wedges: "pitching" and "lob" are clubs, not chips.
        self.assertEqual(voice.parse_command("looper pitching wedge"), {"action": "arm", "club": "PW"})
        self.assertEqual(voice.parse_command("looper lob"), {"action": "arm", "club": "LW"})
        self.assertEqual(voice.parse_command("looper arm it"), {"action": "arm-shown"})
        self.assertIn("pitch", voice.grammar())
        self.assertIn("bump and run", voice.grammar())

    def test_aim_lines_show_or_arm(self):
        for wording, line in (("second best", "second"), ("the safest line", "safest"), ("best line", "best"),
                              ("show me the safe line", "safest")):
            self.assertEqual(voice.parse_command("looper " + wording),
                             {"action": "aim-line", "line": line, "arm": False}, wording)
        for wording, line in (("arm second best", "second"), ("arm the safest", "safest"), ("arm best", "best"),
                              ("arm the safe one", "safest")):
            self.assertEqual(voice.parse_command("looper " + wording),
                             {"action": "aim-line", "line": line, "arm": True}, wording)
        # Still clubs and plain arming, not lines.
        self.assertEqual(voice.parse_command("looper arm three wood"), {"action": "arm", "club": "3W"})
        self.assertEqual(voice.parse_command("looper arm it"), {"action": "arm-shown"})
        self.assertIsNone(voice.parse_command("looper safest three wood"))

    def test_natural_wordings_do_not_loosen_the_rules(self):
        for wording in ("five wood left", "wind left", "left right", "wind wind", "three wood wind",
                        "club", "give me the", "more", "left five three wood"):
            self.assertIsNone(voice.parse_command("looper " + wording), wording)
        self.assertIsNone(voice.parse_command("update wind"))  # still needs the wake word

    def test_gspro_views_are_their_own_commands_not_clubs(self):
        # "Looper, flyover" used to be heard as five wood.
        self.assertEqual(voice.parse_command("looper flyover"), {"action": "gspro", "key": "flyover"})
        self.assertEqual(voice.parse_command("looper fly over"), {"action": "gspro", "key": "flyover"})
        # Ending a flyover is its own wording (19 Nov), not "clear" or "cancel" on their own.
        for wording in ("end flyover", "cancel flyover", "stop flyover", "kill flyover", "escape flyover"):
            self.assertEqual(voice.parse_command(f"looper {wording}"), {"action": "gspro", "key": "flyover"}, wording)
        self.assertEqual(voice.parse_command("looper cancel"), {"action": "clear"})
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
        # One spelling per sound, or the recogniser's confidence is split.
        self.assertIn("caddy", full)
        self.assertNotIn("caddie", full)
        self.assertNotIn("fly over", full)

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
