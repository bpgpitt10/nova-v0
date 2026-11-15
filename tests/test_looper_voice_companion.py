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

    def test_arm_what_the_screen_shows(self):
        self.assertEqual(voice.parse_command("looper arm it"), {"action": "arm-shown", "club": None})
        self.assertEqual(voice.parse_command("caddie arm"), {"action": "arm-shown", "club": None})

    def test_clear(self):
        for word in ("clear", "disarm", "cancel"):
            self.assertEqual(voice.parse_command(f"looper {word}"), {"action": "clear", "club": None})

    def test_nothing_without_a_wake_word(self):
        self.assertIsNone(voice.parse_command("arm three wood"))
        self.assertIsNone(voice.parse_command("three wood"))
        self.assertIsNone(voice.parse_command(""))
        self.assertIsNone(voice.parse_command(None))

    def test_wake_word_alone_or_noise_is_not_a_command(self):
        self.assertIsNone(voice.parse_command("looper"))
        self.assertIsNone(voice.parse_command("[unk] looper [unk]"))
        self.assertIsNone(voice.parse_command("looper arm banana"))

    def test_noise_around_a_command_is_ignored(self):
        self.assertEqual(voice.parse_command("[unk] caddie arm nine iron"), {"action": "arm", "club": "9i"})
        self.assertEqual(voice.parse_command("looper looper arm it"), {"action": "arm-shown", "club": None})

    def test_every_grammar_phrase_with_a_command_parses(self):
        for phrase in voice.grammar():
            if phrase == "[unk]" or phrase in voice.WAKE_WORDS:
                continue
            self.assertIsNotNone(voice.parse_command(phrase), phrase)


class ListenerBookkeepingTest(unittest.TestCase):
    def test_events_are_numbered_and_duplicates_dropped(self):
        listener = voice.VoiceListener()
        first = listener.handle_text("looper arm three wood")
        self.assertEqual(first["seq"], 1)
        self.assertEqual(first["club"], "3W")
        # The recogniser can report the same breath twice.
        self.assertIsNone(listener.handle_text("looper arm three wood"))
        second = listener.handle_text("looper clear")
        self.assertEqual(second["seq"], 2)

    def test_first_poll_never_replays_old_commands(self):
        listener = voice.VoiceListener()
        listener.handle_text("looper arm three wood")
        first_poll = listener._payload("listening", None, None)
        self.assertEqual(first_poll["events"], [])
        self.assertEqual(first_poll["latest"], 1)
        listener.handle_text("looper clear")
        later = listener._payload("listening", None, first_poll["latest"])
        self.assertEqual([event["action"] for event in later["events"]], ["clear"])

    def test_no_model_means_unavailable_and_no_microphone(self):
        # In this test environment there is no speech model, so a poll must
        # not start a listening thread.
        if voice.available():
            self.skipTest("a speech model is installed here")
        payload = voice.LISTENER.poll(None)
        self.assertEqual(payload["status"], "unavailable")
        self.assertIsNone(voice.LISTENER._thread)


if __name__ == "__main__":
    unittest.main()
