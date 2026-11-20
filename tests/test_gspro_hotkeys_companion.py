"""EXPERIMENTAL GSPro shortcut presses: what is allowed, and when nothing is sent."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "helpers"))

import gspro_hotkeys as hotkeys  # noqa: E402
import looper_voice as voice  # noqa: E402

CONNECTED = {"status": "connected", "hwnd": 4242, "minimized": False}


class PressHotkeyTest(unittest.TestCase):
    def press(self, name, window=CONNECTED, in_front=True):
        sent = []
        result = hotkeys.press_hotkey(
            name,
            find_window=lambda: window,
            front=lambda hwnd: in_front,
            send=lambda vk, ctrl: sent.append((vk, ctrl)),
        )
        return result, sent

    def test_named_shortcut_is_pressed_once(self):
        result, sent = self.press("flyover")
        self.assertEqual(result, {"status": "sent", "key": "flyover"})
        self.assertEqual(sent, [(0x4F, False)])

    def test_mulligan_uses_ctrl(self):
        result, sent = self.press("mulligan")
        self.assertEqual(result["status"], "sent")
        self.assertEqual(sent, [(0x4D, True)])

    def test_only_named_shortcuts(self):
        for name in ("a", "enter", "", None, 79, "FLYOVER", "alt+f4"):
            result, sent = self.press(name)
            self.assertEqual(result, {"status": "blocked", "reason": "unknown-key"})
            self.assertEqual(sent, [])

    def test_nothing_is_sent_without_gspro_in_front(self):
        for window, in_front, reason in (
            ({"status": "not-connected"}, True, "gspro-not-connected"),
            ({**CONNECTED, "minimized": True}, True, "gspro-minimized"),
            ({"status": "connected", "hwnd": None}, True, "gspro-not-connected"),
            (CONNECTED, False, "gspro-not-in-front"),
        ):
            result, sent = self.press("scorecard", window=window, in_front=in_front)
            self.assertEqual(result["status"], "blocked")
            self.assertEqual(result["reason"], reason)
            self.assertEqual(sent, [])

    def test_every_voice_view_has_a_shortcut(self):
        for key in set(voice.GSPRO_VIEWS.values()):
            self.assertIn(key, hotkeys.HOTKEYS, key)


if __name__ == "__main__":
    unittest.main()
