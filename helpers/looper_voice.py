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

SCHEMA_VERSION = "voice-commands-v1"
SAMPLE_RATE = 16000
BLOCK_FRAMES = 4000  # 0.25 s
KEEPALIVE_S = 6.0  # the page polls about twice a second
DUPLICATE_WINDOW_S = 1.5
MAX_EVENTS = 50

# "caddy" is the same word to a listener; the recogniser may spell it either way.
WAKE_WORDS = ("looper", "caddie", "caddy")

_NUMBERS = {
    1: "one", 2: "two", 3: "three", 4: "four", 5: "five",
    6: "six", 7: "seven", 8: "eight", 9: "nine",
}


def _club_phrases() -> dict[str, str]:
    """Spoken club name -> Looper club id (src/lib/bagConfig.ts)."""
    clubs = {"driver": "Driver", "mini driver": "Mini Driver"}
    for number in (2, 3, 4, 5, 7, 9):
        clubs[f"{_NUMBERS[number]} wood"] = f"{number}W"
    for number in (2, 3, 4, 5, 6, 7):
        clubs[f"{_NUMBERS[number]} hybrid"] = f"{number}H"
    for number in range(1, 10):
        clubs[f"{_NUMBERS[number]} iron"] = f"{number}i"
    clubs.update({
        "pitching wedge": "PW",
        "approach wedge": "AW",
        "gap wedge": "GW",
        "sand wedge": "SW",
        "lob wedge": "LW",
    })
    return clubs


CLUB_PHRASES = _club_phrases()
CLEAR_WORDS = ("clear", "disarm", "cancel")


def command_phrases() -> list[str]:
    """Every command, without a wake word."""
    phrases = ["arm", "arm it"]
    phrases += list(CLEAR_WORDS)
    for spoken in CLUB_PHRASES:
        phrases.append(spoken)
        phrases.append(f"arm {spoken}")
    return phrases


def grammar() -> list[str]:
    """What the recogniser is allowed to hear. "[unk]" soaks up everything else."""
    phrases = []
    for wake in WAKE_WORDS:
        phrases.append(wake)
        phrases.extend(f"{wake} {command}" for command in command_phrases())
    phrases.append("[unk]")
    return phrases


def parse_command(text: str | None) -> dict | None:
    """Recognised text -> a command, or None. Pure, so it is unit-tested."""
    if not text:
        return None
    words = [word for word in text.lower().replace(",", " ").split() if word != "[unk]"]
    wake_at = next((i for i, word in enumerate(words) if word in WAKE_WORDS), None)
    if wake_at is None:
        return None  # no wake word in this breath: not for us
    rest = words[wake_at + 1:]
    # A second wake word starts over ("caddie ... caddie arm it").
    while any(word in WAKE_WORDS for word in rest):
        rest = rest[next(i for i, word in enumerate(rest) if word in WAKE_WORDS) + 1:]
    if not rest:
        return None
    if rest[0] in CLEAR_WORDS:
        return {"action": "clear", "club": None}
    if rest[0] == "arm":
        rest = rest[1:]
        if not rest or rest == ["it"]:
            return {"action": "arm-shown", "club": None}
    # Longest club name first: "mini driver" before "driver".
    spoken = " ".join(rest)
    for phrase in sorted(CLUB_PHRASES, key=len, reverse=True):
        if spoken == phrase or spoken.startswith(phrase + " "):
            return {"action": "arm", "club": CLUB_PHRASES[phrase]}
    return None


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


def _new_recognizer():
    """A fresh recogniser on the shared model (loading the model takes a second)."""
    global _MODEL
    import vosk

    vosk.SetLogLevel(-1)
    with _MODEL_LOCK:
        if _MODEL is None:
            _MODEL = vosk.Model(str(model_dir()))
    return vosk.KaldiRecognizer(_MODEL, SAMPLE_RATE, json.dumps(grammar()))


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
        self._mic_level = 0.0
        # The last thing heard with a wake word in it, command or not, so the
        # player can see why nothing happened ("heard Looper, then nothing").
        self._last_heard: dict | None = None

    def poll(self, since: int | None, listen: bool = True) -> dict:
        error = _engine_error()
        if error:
            return self._payload("unavailable", error, since)
        if listen:
            with self._lock:
                self._wanted_until = time.monotonic() + KEEPALIVE_S
                if self._thread is None or not self._thread.is_alive():
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

    def handle_text(self, text: str | None) -> dict | None:
        command = parse_command(text)
        if text and any(word in WAKE_WORDS for word in text.lower().split()):
            with self._lock:
                self._last_heard = {
                    "text": text,
                    "at": int(time.time() * 1000),
                    "command": command is not None,
                }
        if not command:
            return None
        key = f"{command['action']}:{command['club']}"
        now = time.monotonic()
        with self._lock:
            if self._last and self._last[0] == key and now - self._last[1] < DUPLICATE_WINDOW_S:
                return None
            self._last = (key, now)
            self._seq += 1
            event = {
                "seq": self._seq,
                "at": int(time.time() * 1000),
                "heard": text,
                **command,
            }
            self._events.append(event)
            return event

    def _run(self) -> None:
        try:
            import sounddevice

            recognizer = _new_recognizer()
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
                        self.handle_text(json.loads(recognizer.Result()).get("text"))
            with self._lock:
                self._status, self._reason, self._mic_level = "off", None, 0.0
        except Exception as error:  # no microphone, device busy, driver error
            name = type(error).__name__
            with self._lock:
                self._status = "unavailable"
                self._reason = "no-microphone" if "PortAudio" in name else f"error:{name}"


LISTENER = VoiceListener()


def selftest(wav_path: str) -> dict:
    """Run a 16 kHz mono WAV through the same recogniser and parser (CI, support)."""
    error = _engine_error()
    if error:
        return {"status": "unavailable", "reason": error, "heard": [], "commands": []}
    recognizer = _new_recognizer()
    heard: list[str] = []
    with wave.open(wav_path, "rb") as audio:
        if audio.getframerate() != SAMPLE_RATE or audio.getnchannels() != 1 or audio.getsampwidth() != 2:
            return {"status": "unavailable", "reason": "wav-format", "heard": [], "commands": []}
        while True:
            data = audio.readframes(BLOCK_FRAMES)
            if not data:
                break
            if recognizer.AcceptWaveform(data):
                heard.append(json.loads(recognizer.Result()).get("text", ""))
    heard.append(json.loads(recognizer.FinalResult()).get("text", ""))
    heard = [text for text in heard if text]
    commands = [command for command in (parse_command(text) for text in heard) if command]
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
