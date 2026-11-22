"""EXPERIMENTAL: local voice commands for Looper.

"Looper, arm three wood" -> {"action": "arm", "club": "3W"}

Everything voice-related lives in this module so it can be merged into the
companion, or left out, as one piece. The companion calls three things:
``available()``, ``LISTENER.poll(since)`` and ``selftest(wav)``.

Design:
  * Speech is recognised on this PC by Vosk with a small English model that
    sits next to the executable (``voice/model``). No audio leaves the PC and
    none is stored.
  * The microphone is only open while the Looper page is asking for commands
    (it polls); a few seconds after the page stops, the microphone closes.
  * The recogniser is given a fixed list of phrases, so chatter, a TV or a
    ball strike cannot become a command, and a command only counts when it
    follows a wake word in the same breath.
  * This module never sends input to GSPro. It only reports what it heard;
    the Looper page decides what to do with it.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import wave
from collections import deque
from pathlib import Path

SCHEMA_VERSION = "voice-commands-v2"
SAMPLE_RATE = 16000
BLOCK_FRAMES = 4000  # 0.25 s
KEEPALIVE_S = 6.0  # the page polls about twice a second
DUPLICATE_WINDOW_S = 1.5
RETRY_AFTER_FAILURE_S = 5.0  # no microphone: try again now and then, not on every poll
MAX_EVENTS = 50

# "caddy" is the same word to a listener; the recogniser may spell it either way.
WAKE_WORDS = ("looper", "caddie", "caddy")
# After a wake word on its own, a command may follow without repeating it.
WAKE_WINDOW_S = 5.0

_NUMBERS = {
    1: "one", 2: "two", 3: "three", 4: "four", 5: "five",
    6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten",
    11: "eleven", 12: "twelve", 13: "thirteen", 14: "fourteen", 15: "fifteen",
    16: "sixteen", 17: "seventeen", 18: "eighteen", 19: "nineteen",
    20: "twenty", 30: "thirty",
}
_NUMBER_VALUES = {word: value for value, word in _NUMBERS.items()}
DEFAULT_AIM_YARDS = 3  # "aim left" with no number: one aim step
MAX_AIM_YARDS = 30


def _club_phrases() -> dict[str, str]:
    """Spoken club name -> Looper club id (src/lib/bagConfig.ts)."""
    clubs = {"driver": "Driver", "mini driver": "Mini Driver"}
    for number in (2, 3, 4, 5, 7, 9):
        clubs[f"{_NUMBERS[number]} wood"] = f"{number}W"
    for number in (2, 3, 4, 5, 6, 7):
        clubs[f"{_NUMBERS[number]} hybrid"] = f"{number}H"
        clubs[f"{_NUMBERS[number]} rescue"] = f"{number}H"
    for number in range(1, 10):
        clubs[f"{_NUMBERS[number]} iron"] = f"{number}i"
    for spoken, club in (("pitching", "PW"), ("approach", "AW"), ("gap", "GW"),
                         ("sand", "SW"), ("lob", "LW")):
        clubs[f"{spoken} wedge"] = club
        clubs[spoken] = club
    return clubs


CLUB_PHRASES = _club_phrases()

# ---- How people actually say it -------------------------------------------
# Several wordings per command. The recogniser matches sounds, not meaning, so
# every wording here is a deliberate addition: each extra word is one more
# thing chatter can be mistaken for. Add what players really say (the miss
# log on their account shows it), not every synonym.

# Said around a command and ignored: "give me the three wood", "show flyover".
# No "to" or "for": they sound like "two" and "four".
FILLER_WORDS = frozenset((
    "the", "a", "my", "me", "please", "give", "get", "show", "open", "use",
    "hit", "with", "switch", "change", "grab", "take", "pull", "want", "i",
    "need", "now", "go", "can", "you", "we",
))

CLEAR_PHRASES = frozenset(("clear", "disarm", "cancel", "never mind", "stop", "clear it"))
CONFIRM_PHRASES = frozenset(("confirm", "yes", "do it", "yes do it"))
# Arm whatever club the screen is showing.
ARM_SHOWN_PHRASES = frozenset((
    "arm", "arm it", "arm that", "arm that one", "that one", "lock it", "lock it in", "send it",
))
# Arm Looper's own pick, even if another club is being looked at.
ARM_RECOMMENDED_PHRASES = frozenset((
    "your call", "your pick", "your club", "arm your pick", "arm your call",
    "recommended", "arm recommended", "play", "arm play",
))
DETAILS_PHRASES = frozenset(("details", "hide details"))
# The three aim lines on the map, for the club on screen. Said alone it shows
# the line; with "arm" in front it arms it.
AIM_LINE_PHRASES = {
    "best": "best", "best line": "best", "best aim": "best",
    "second best": "second", "second best line": "second", "second line": "second", "second": "second",
    "safest": "safest", "safest line": "safest", "safe line": "safest", "safe": "safest", "safe one": "safest",
}
# Chip shots around the green (Brian, 21 Nov): "Looper, pitch", "show me the flop shot".
# Said alone it shows that chip; with "arm" in front it aims it. Not "lob": that is the lob wedge.
CHIP_PHRASES = {
    "bump and run": "bump", "bump": "bump", "bump run": "bump",
    "chip": "chip", "chip shot": "chip",
    "pitch": "pitch", "pitch shot": "pitch",
    "flop": "flop", "flop shot": "flop",
}
AIM_RESET_PHRASES = frozenset((
    "reset aim", "aim reset", "aim center", "center", "center it", "center aim",
    "your line", "aim your line", "back center",
))
# Any of these with "wind" (or "wind" alone) re-reads the wind.
WIND_VERBS = frozenset(("refresh", "update", "new", "fix", "check", "reset", "read", "reread"))
AIM_VERBS = frozenset(("aim", "move", "it"))
AIM_QUALIFIERS = frozenset(("yards", "yard", "more", "little", "bit", "over"))
CLUB_STEP_UP = frozenset(("up", "more", "longer"))
CLUB_STEP_DOWN = frozenset(("down", "less", "shorter"))

# GSPro's own views. Recognised so they are never mistaken for a club
# ("flyover" used to come out as "five wood"); the page decides what to do.
GSPRO_VIEWS = {
    "flyover": "flyover",
    "fly over": "flyover",
    "overview": "flyover",
    "hole overview": "flyover",
    # GSPro's flyover key starts and stops it; players say "end flyover" to stop.
    # It is the same key press, so said with no flyover running it starts one.
    "end flyover": "flyover",
    "cancel flyover": "flyover",
    "stop flyover": "flyover",
    "kill flyover": "flyover",
    "escape flyover": "flyover",
    "exit flyover": "flyover",
    "skip flyover": "flyover",
    "scorecard": "scorecard",
    "score card": "scorecard",
    "card": "scorecard",
    "score": "scorecard",
    "mulligan": "mulligan",
    "heat map": "heatmap",
    "green grid": "greengrid",
    "grid": "greengrid",
    "shot cam": "shotcam",
    "shot camera": "shotcam",
    "pin": "pin",
    "flag": "pin",
    "pin indicator": "pin",
    "putt mode": "putt",
    "putting mode": "putt",
    "hide": "hideui",
    "hide screen": "hideui",
}
# Two spellings of one sound halve the recogniser's confidence: listen for one.
_NOT_LISTENED = frozenset(("caddie", "fly over", "score card"))


def grammar(clubs: frozenset[str] | None = None) -> list[str]:
    """What the recogniser may hear. It strings these together freely, so the
    parser below decides what counts; "[unk]" soaks up everything else.

    ``clubs``: only these club ids are listenable (the player's bag)."""
    phrases: list[str] = list(WAKE_WORDS)
    phrases += [phrase for phrase, club in CLUB_PHRASES.items() if clubs is None or club in clubs]
    phrases += list(GSPRO_VIEWS)
    for table in (CLEAR_PHRASES, CONFIRM_PHRASES, ARM_SHOWN_PHRASES, ARM_RECOMMENDED_PHRASES,
                  DETAILS_PHRASES, AIM_RESET_PHRASES):
        phrases += sorted(table)
    phrases += list(AIM_LINE_PHRASES)
    phrases += list(CHIP_PHRASES)
    words: set[str] = set(FILLER_WORDS) | WIND_VERBS | AIM_VERBS | AIM_QUALIFIERS
    words |= CLUB_STEP_UP | CLUB_STEP_DOWN | {"wind", "club", "left", "right", "one"}
    phrases += sorted(words)
    phrases += list(_NUMBER_VALUES)
    seen: set[str] = set()
    unique = [phrase for phrase in phrases
              if phrase not in _NOT_LISTENED and not (phrase in seen or seen.add(phrase))]
    return unique + ["[unk]"]


def _parse_number(words: list[str]) -> tuple[int | None, list[str]]:
    """Leading number words -> (value, remaining words). "twenty five" = 25."""
    if not words or words[0] not in _NUMBER_VALUES:
        return None, words
    value = _NUMBER_VALUES[words[0]]
    rest = words[1:]
    if value in (20, 30) and rest and rest[0] in _NUMBER_VALUES and _NUMBER_VALUES[rest[0]] < 10:
        value += _NUMBER_VALUES[rest[0]]
        rest = rest[1:]
    return value, rest


def _match_phrase(words: list[str], table: dict[str, str]) -> tuple[str | None, list[str]]:
    """Longest phrase from ``table`` at the start of ``words``."""
    spoken = " ".join(words)
    for phrase in sorted(table, key=len, reverse=True):
        if spoken == phrase or spoken.startswith(phrase + " "):
            return table[phrase], words[len(phrase.split()):]
    return None, words


def _parse_aim(words: list[str]) -> dict | None:
    """"aim left five", "five yards left", "move it a little right", "left"."""
    rest = list(words)
    while rest and rest[0] in AIM_VERBS:
        rest = rest[1:]
    directions = [word for word in rest if word in ("left", "right")]
    if len(directions) != 1:
        return None
    rest = [word for word in rest if word not in ("left", "right") and word not in AIM_QUALIFIERS]
    yards, leftover = _parse_number(rest)
    if leftover:
        return None
    yards = DEFAULT_AIM_YARDS if yards is None else yards
    if not 1 <= yards <= MAX_AIM_YARDS:
        return None
    return {"action": "aim", "direction": directions[0], "yards": yards}


def _parse_words(rest: list[str]) -> dict | None:
    """The words after the wake word -> a command. Every word must belong to it
    (filler words aside), so half-heard sentences do nothing."""
    spoken_all = " ".join(rest)
    # Whole phrases first: some contain words that are filler elsewhere ("do it").
    if spoken_all in CONFIRM_PHRASES:
        return {"action": "confirm"}
    words = [word for word in rest if word not in FILLER_WORDS]
    if not words:
        return None
    spoken = " ".join(words)
    if spoken in CLEAR_PHRASES:
        return {"action": "clear"}
    if spoken in CONFIRM_PHRASES:
        return {"action": "confirm"}
    if spoken in ARM_SHOWN_PHRASES:
        return {"action": "arm-shown"}
    if spoken in ARM_RECOMMENDED_PHRASES:
        return {"action": "arm-recommended"}
    if spoken in DETAILS_PHRASES:
        return {"action": "details"}
    if spoken in AIM_RESET_PHRASES:
        return {"action": "aim-reset"}
    if words.count("wind") == 1 and all(word == "wind" or word in WIND_VERBS for word in words):
        return {"action": "wind"}
    if "club" in words:
        others = [word for word in words if word not in ("club", "one")]
        if len(others) == 1 and others[0] in CLUB_STEP_UP:
            return {"action": "club-step", "direction": "up"}
        if len(others) == 1 and others[0] in CLUB_STEP_DOWN:
            return {"action": "club-step", "direction": "down"}
        return None
    view, after_view = _match_phrase(words, GSPRO_VIEWS)
    if view and not after_view:
        return {"action": "gspro", "key": view}
    club_words = words[1:] if words[0] == "arm" else words
    if " ".join(club_words) in CHIP_PHRASES:
        return {"action": "chip", "shot": CHIP_PHRASES[" ".join(club_words)], "arm": words[0] == "arm"}
    if " ".join(club_words) in AIM_LINE_PHRASES:
        return {"action": "aim-line", "line": AIM_LINE_PHRASES[" ".join(club_words)], "arm": words[0] == "arm"}
    club, after_club = _match_phrase(club_words, CLUB_PHRASES)
    if club and not after_club:
        return {"action": "arm", "club": club}
    # "switch to seven iron" is heard as "two seven iron".
    if len(club_words) > 1 and club_words[0] in ("two", "four"):
        club, after_club = _match_phrase(club_words[1:], CLUB_PHRASES)
        if club and not after_club:
            return {"action": "arm", "club": club}
    if "left" in words or "right" in words:
        return _parse_aim(words)
    return None


def _clean_words(text: str | None) -> list[str]:
    if not text:
        return []
    return [word for word in text.lower().replace(",", " ").split() if word != "[unk]"]


def has_wake_word(text: str | None) -> bool:
    return any(word in WAKE_WORDS for word in _clean_words(text))


def parse_command(text: str | None, wake_open: bool = False) -> dict | None:
    """Recognised text -> a command, or None. Pure, so it is unit-tested.

    A command needs a wake word in the same breath, unless ``wake_open``: the
    wake word was said on its own a moment ago."""
    words = _clean_words(text)
    wake_at = next((i for i, word in enumerate(words) if word in WAKE_WORDS), None)
    if wake_at is None:
        return _parse_words(words) if wake_open else None
    rest = words[wake_at + 1:]
    # A second wake word starts over ("caddie ... caddie arm it").
    while any(word in WAKE_WORDS for word in rest):
        rest = rest[next(i for i, word in enumerate(rest) if word in WAKE_WORDS) + 1:]
    return _parse_words(rest)


def confidence(result: dict) -> float | None:
    """Lowest per-word confidence in a recogniser result (noise words aside)."""
    words = [entry for entry in result.get("result") or [] if entry.get("word") != "[unk]"]
    scores = [float(entry["conf"]) for entry in words if isinstance(entry.get("conf"), (int, float))]
    return round(min(scores), 3) if scores else None


def model_dir() -> Path:
    override = os.environ.get("LOOPER_VOICE_MODEL")
    if override:
        return Path(override)
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent / "voice" / "model"
    return Path(__file__).resolve().parent.parent / "voice-model"


_ENGINE_ERROR: str | None = None
_ENGINE_CHECKED = False


def _engine_error() -> str | None:
    """None when Vosk and the model can be used; otherwise why not."""
    global _ENGINE_ERROR, _ENGINE_CHECKED
    if _ENGINE_CHECKED:
        return _ENGINE_ERROR
    _ENGINE_CHECKED = True
    if not model_dir().is_dir():
        _ENGINE_ERROR = "no-model"
        return _ENGINE_ERROR
    try:
        import vosk  # noqa: F401
    except Exception as error:  # missing package or native library
        _ENGINE_ERROR = f"no-engine:{type(error).__name__}"
        return _ENGINE_ERROR
    _ENGINE_ERROR = None
    return None


def available() -> bool:
    return _engine_error() is None


_MODEL = None
_MODEL_LOCK = threading.Lock()


def _new_recognizer(clubs: frozenset[str] | None = None):
    """A fresh recogniser on the shared model (loading the model takes a second)."""
    global _MODEL
    import vosk

    vosk.SetLogLevel(-1)
    with _MODEL_LOCK:
        if _MODEL is None:
            _MODEL = vosk.Model(str(model_dir()))
    recognizer = vosk.KaldiRecognizer(_MODEL, SAMPLE_RATE, json.dumps(grammar(clubs)))
    recognizer.SetWords(True)  # per-word confidence
    return recognizer


def _level(data: bytes) -> float:
    """Loudness of one block of 16-bit audio, 0..1. Shown so a dead mic is obvious."""
    count = len(data) // 2
    if count == 0:
        return 0.0
    import array

    samples = array.array("h")
    samples.frombytes(data[: count * 2])
    total = 0
    for sample in samples[::8]:  # every 8th sample is plenty for a meter
        total += sample * sample
    used = max(1, len(samples[::8]))
    return min(1.0, (total / used) ** 0.5 / 32768.0)


def _open_microphone(sounddevice):
    """The default microphone at 16 kHz, or at its own rate when it refuses 16 kHz.

    Returns (stream, rate, device_name).
    """
    try:
        name = str(sounddevice.query_devices(kind="input").get("name") or "microphone")
    except Exception:
        name = "microphone"
    try:
        stream = sounddevice.RawInputStream(
            samplerate=SAMPLE_RATE, blocksize=BLOCK_FRAMES, dtype="int16", channels=1)
        return stream, SAMPLE_RATE, name
    except Exception:
        rate = int(sounddevice.query_devices(kind="input")["default_samplerate"])
        stream = sounddevice.RawInputStream(
            samplerate=rate, blocksize=max(1, rate // 4), dtype="int16", channels=1)
        return stream, rate, name


def _to_16k(data: bytes, rate: int, state):
    """Resample one block to 16 kHz (linear). Returns (data, state)."""
    if rate == SAMPLE_RATE:
        return data, state
    import array

    samples = array.array("h")
    samples.frombytes(data[: (len(data) // 2) * 2])
    if not samples:
        return b"", state
    step = rate / SAMPLE_RATE
    position = max(0.0, state or 0.0)
    out = array.array("h")
    last = len(samples) - 1
    while position < last:
        index = int(position)
        fraction = position - index
        out.append(int(samples[index] * (1 - fraction) + samples[index + 1] * fraction))
        position += step
    return out.tobytes(), position - len(samples)


class VoiceListener:
    """Opens the microphone while polled; keeps the last few commands."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._events: deque[dict] = deque(maxlen=MAX_EVENTS)
        self._seq = 0
        self._thread: threading.Thread | None = None
        self._wanted_until = 0.0
        self._status = "off"
        self._reason: str | None = None
        self._last: tuple[str, float] | None = None
        self._device: str | None = None
        self._failed_at = float("-inf")
        self._mic_level = 0.0
        # The last thing heard with a wake word in it, command or not, so the
        # player can see why nothing happened ("heard Looper, then nothing").
        self._last_heard: dict | None = None
        self._clubs: frozenset[str] | None = None  # the player's bag, when the page sent it
        self._wake_until = 0.0

    def poll(self, since: int | None, listen: bool = True, clubs: frozenset[str] | None = None) -> dict:
        if clubs is not None:
            self._clubs = clubs or None
        error = _engine_error()
        if error:
            return self._payload("unavailable", error, since)
        if listen:
            with self._lock:
                self._wanted_until = time.monotonic() + KEEPALIVE_S
                idle = self._thread is None or not self._thread.is_alive()
                if idle and time.monotonic() - self._failed_at >= RETRY_AFTER_FAILURE_S:
                    self._status, self._reason = "starting", None
                    self._thread = threading.Thread(
                        target=self._run, name="looper-voice", daemon=True)
                    self._thread.start()
        with self._lock:
            return self._payload(self._status, self._reason, since)

    def _payload(self, status: str, reason: str | None, since: int | None) -> dict:
        events = [event for event in self._events if since is None or event["seq"] > since]
        return {
            "service": "looper-companion",
            "schemaVersion": SCHEMA_VERSION,
            "status": status,
            "reason": reason,
            "latest": self._seq,
            "wakeWords": list(WAKE_WORDS),
            "device": self._device,
            "level": round(self._mic_level, 3),
            "lastHeard": self._last_heard,
            # A first poll (no "since") only learns where the list ends, so a
            # page that opens mid-round never replays old commands.
            "events": events if since is not None else [],
        }

    def handle_text(self, text: str | None, conf: float | None = None) -> dict | None:
        now = time.monotonic()
        wake_open = now < self._wake_until
        woke = has_wake_word(text)
        command = parse_command(text, wake_open=wake_open)
        # "Looper" on its own: a command may follow in the next few seconds.
        waiting = False
        if woke and command is None:
            words = _clean_words(text)
            waiting = bool(words) and words[-1] in WAKE_WORDS
        if woke or (wake_open and command is not None):
            with self._lock:
                self._wake_until = now + WAKE_WINDOW_S if waiting else 0.0
                self._last_heard = {
                    "text": text,
                    "at": int(time.time() * 1000),
                    "command": command is not None,
                    "waiting": waiting,
                    "conf": conf,
                }
        if not command:
            return None
        key = json.dumps(command, sort_keys=True)
        with self._lock:
            if self._last and self._last[0] == key and now - self._last[1] < DUPLICATE_WINDOW_S:
                return None
            self._last = (key, now)
            self._seq += 1
            event = {
                "seq": self._seq,
                "at": int(time.time() * 1000),
                "heard": text,
                "conf": conf,
                "club": None,
                **command,
            }
            self._events.append(event)
            return event

    def _run(self) -> None:
        try:
            import sounddevice

            listening_for = self._clubs
            recognizer = _new_recognizer(listening_for)
            stream, rate, name = _open_microphone(sounddevice)
            block = BLOCK_FRAMES if rate == SAMPLE_RATE else max(1, rate // 4)
            resample_state = None
            with stream:
                with self._lock:
                    self._status, self._reason, self._device = "listening", None, name
                while time.monotonic() < self._wanted_until:
                    raw, _overflowed = stream.read(block)
                    data, resample_state = _to_16k(bytes(raw), rate, resample_state)
                    self._mic_level = _level(data)
                    if data and recognizer.AcceptWaveform(data):
                        result = json.loads(recognizer.Result())
                        self.handle_text(result.get("text"), confidence(result))
                    if self._clubs != listening_for:
                        # The bag changed: only its clubs stay listenable.
                        listening_for = self._clubs
                        recognizer = _new_recognizer(listening_for)
            with self._lock:
                self._status, self._reason, self._mic_level = "off", None, 0.0
        except Exception as error:  # no microphone, device busy, driver error
            name = type(error).__name__
            with self._lock:
                self._failed_at = time.monotonic()
                self._mic_level = 0.0
                self._status = "unavailable"
                self._reason = "no-microphone" if "PortAudio" in name else f"error:{name}"


LISTENER = VoiceListener()


def selftest(wav_path: str) -> dict:
    """Run a 16 kHz mono WAV through the same recogniser and parser (CI, support)."""
    error = _engine_error()
    if error:
        return {"status": "unavailable", "reason": error, "heard": [], "commands": []}
    recognizer = _new_recognizer()
    results: list[dict] = []
    with wave.open(wav_path, "rb") as audio:
        if audio.getframerate() != SAMPLE_RATE or audio.getnchannels() != 1 or audio.getsampwidth() != 2:
            return {"status": "unavailable", "reason": "wav-format", "heard": [], "commands": []}
        while True:
            data = audio.readframes(BLOCK_FRAMES)
            if not data:
                break
            if recognizer.AcceptWaveform(data):
                results.append(json.loads(recognizer.Result()))
    results.append(json.loads(recognizer.FinalResult()))
    results = [result for result in results if result.get("text")]
    heard = [result["text"] for result in results]
    commands = []
    for result in results:
        command = parse_command(result["text"])
        if command:
            commands.append({"club": None, **command, "conf": confidence(result)})
    return {"status": "ok", "reason": None, "heard": heard, "commands": commands}


def run_selftest_cli(argv: list[str]) -> bool:
    """``--voice-selftest in.wav out.json``. True when the arguments were ours."""
    if "--voice-selftest" not in argv:
        return False
    at = argv.index("--voice-selftest")
    wav_path = argv[at + 1] if len(argv) > at + 1 else ""
    out_path = argv[at + 2] if len(argv) > at + 2 else ""
    try:
        result = selftest(wav_path)
    except Exception as error:
        result = {"status": "error", "reason": f"{type(error).__name__}: {error}", "heard": [], "commands": []}
    text = json.dumps(result)
    if out_path:
        Path(out_path).write_text(text, encoding="utf-8")
    else:
        print(text)
    return True


if __name__ == "__main__":
    if not run_selftest_cli(sys.argv):
        print(json.dumps({"grammarPhrases": len(grammar()), "available": available()}))
