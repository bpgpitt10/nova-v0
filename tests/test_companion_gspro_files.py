"""Read-only GSPro file bridge and round recorder for the Looper Companion.

Never opens GSPro, never writes to a GSPro folder, never sends desktop input.
"""

from contextlib import contextmanager
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
import json
import sys
import tempfile
import threading
import types
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "helpers"))
import gspro_file_bridge as bridge  # noqa: E402

try:  # CI installs opengolfcoach; local runs without it still test the handler.
    import opengolfcoach  # noqa: F401
except ModuleNotFoundError:
    sys.modules["opengolfcoach"] = types.ModuleType("opengolfcoach")
import looper_companion as companion  # noqa: E402


def shot(round_id, shot_id, hole=0, hole_shot=1, global_shot=1, **extra):
    return {
        "RoundID": round_id, "ShotID": shot_id, "Hole": hole, "HoleShot": hole_shot,
        "GlobalShotNumber": global_shot, "CourseKey": "Links_v1",
        "StartingPOS": {"x": 0, "y": 0, "z": 0}, "EndingPOS": {"x": 1, "y": 0, "z": 200},
        "BallSpeed": 60, "TotalDistance": 200, **extra,
    }


class GsproFileBridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "output_log.txt").write_bytes(b"0123456789")
        (self.root / "secret.txt").write_text("never served")

    def tearDown(self):
        self.tmp.cleanup()

    def test_only_allowlisted_names_are_served(self):
        self.assertEqual(bridge.stat_gspro_file(self.root, "secret.txt")["status"], "forbidden")
        self.assertEqual(bridge.stat_gspro_file(self.root, "../secret.txt")["status"], "forbidden")
        info, data = bridge.read_gspro_file(self.root, "secret.txt")
        self.assertEqual((info["status"], data), ("forbidden", b""))

    def test_stat_reports_size_and_time_without_a_path(self):
        info = bridge.stat_gspro_file(self.root, "output_log.txt")
        self.assertEqual(info["status"], "ok")
        self.assertEqual(info["size"], 10)
        self.assertIsInstance(info["lastModified"], int)
        self.assertNotIn(str(self.root), json.dumps(info))

    def test_ranged_reads_clamp_to_the_file(self):
        self.assertEqual(bridge.read_gspro_file(self.root, "output_log.txt", 7)[1], b"789")
        self.assertEqual(bridge.read_gspro_file(self.root, "output_log.txt", 2, 5)[1], b"234")
        self.assertEqual(bridge.read_gspro_file(self.root, "output_log.txt", 50)[1], b"")

    def test_missing_file_and_missing_folder(self):
        self.assertEqual(bridge.stat_gspro_file(self.root, "GSPro.db")["status"], "not-found")
        self.assertEqual(bridge.stat_gspro_file(None, "GSPro.db")["status"], "gspro-folder-not-found")

    def test_folder_discovery_is_cached(self):
        calls = []
        clock = [0.0]
        folder = bridge.DataFolder(lambda: calls.append(1) or {"directory": self.root},
                                   clock=lambda: clock[0])
        folder.directory()
        folder.directory()
        self.assertEqual(len(calls), 1)
        clock[0] = bridge.FOLDER_CACHE_SECONDS + 1
        folder.directory()
        self.assertEqual(len(calls), 2)


class RoundRecorderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Path(self.tmp.name) / "rounds"
        self.text = None
        self.recorder = bridge.RoundRecorder(self.store, lambda: self.text)

    def tearDown(self):
        self.tmp.cleanup()

    def test_keeps_every_round_and_only_new_or_changed_shots(self):
        self.text = json.dumps([shot(10, "a"), shot(10, "b", hole_shot=2, global_shot=2)])
        self.assertEqual(self.recorder.poll_once(), 2)
        self.assertEqual(self.recorder.poll_once(), 0)  # unchanged
        # GSPro moves on to a new round; the old round's records stay recorded.
        self.text = json.dumps({"shots": [shot(11, "c")]})
        self.assertEqual(self.recorder.poll_once(), 1)
        # GSPro rewrites a shot (e.g. holed flag set) -> recorded again.
        self.text = json.dumps([shot(11, "c", activeShot={"sd": {"isHoled": True}})])
        self.assertEqual(self.recorder.poll_once(), 1)
        page = self.recorder.records_after(0)
        self.assertEqual([entry["seq"] for entry in page["records"]], [1, 2, 3, 4])
        self.assertEqual({entry["record"]["RoundID"] for entry in page["records"]}, {10, 11})
        self.assertEqual(page["activeRoundId"], 11)

    def test_paging_and_restart(self):
        self.text = json.dumps([shot(1, str(i), global_shot=i) for i in range(5)])
        self.recorder.poll_once()
        first = self.recorder.records_after(0, limit=2)
        self.assertEqual((len(first["records"]), first["more"], first["nextAfter"]), (2, True, 2))
        rest = self.recorder.records_after(first["nextAfter"], limit=10)
        self.assertEqual((len(rest["records"]), rest["more"]), (3, False))
        # A restarted companion reloads what it kept and does not duplicate it.
        restarted = bridge.RoundRecorder(self.store, lambda: self.text)
        self.assertEqual(restarted.poll_once(), 0)
        self.assertEqual(restarted.status()["latestSeq"], 5)

    def test_unreadable_or_partial_files_are_harmless(self):
        self.text = '{"not": "finished'
        self.assertEqual(self.recorder.poll_once(), 0)
        self.text = json.dumps([{"ShotID": "x"}, "junk", shot(3, "ok")])
        self.assertEqual(self.recorder.poll_once(), 1)
        broken = bridge.RoundRecorder(self.store, lambda: (_ for _ in ()).throw(OSError("busy")))
        self.assertEqual(broken.poll_once(), 0)
        self.assertEqual(broken.status()["lastError"], "OSError")


def layout_log(pars, pins):
    rows = [{"active": i == 0, "strokeIdx": i, "par": par, "teePos": {"x": 0, "y": 0, "z": 0},
             "pinPos": {"x": pin[0], "y": 0, "z": pin[1]}} for i, (par, pin) in enumerate(zip(pars, pins))]
    return "INFO round loaded\n" + json.dumps(rows) + "\nINFO more lines\n"


OLD_GAME_PARS = [4, 5, 3, 5, 4, 4, 5, 4, 3, 4, 5, 3, 4, 3, 4, 5, 4, 4]  # GSPro's card: 73
PINS = [(i * 50.0, 300.0 + i) for i in range(18)]


class RoundParsTests(unittest.TestCase):
    """GSPro's own par per hole (The Old Game's course file says hole 7 is a
    par 4; GSPro's scorecard scores it as a 5)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Path(self.tmp.name) / "rounds"
        self.text = None
        self.log = None
        self.clock = [0.0]
        self.recorder = bridge.RoundRecorder(self.store, lambda: self.text, lambda: self.log, clock=lambda: self.clock[0])

    def tearDown(self):
        self.tmp.cleanup()

    def on_hole(self, round_id, shot_id, hole, to_pin_m, pin):
        # Ball stopped to_pin_m short of the pin, straight down the z axis.
        return shot(round_id, shot_id, hole=hole - 1, EndingPOS={"x": pin[0], "y": 0, "z": pin[1] - to_pin_m},
                    DistanceToPin=to_pin_m)

    def test_pars_are_read_when_the_logged_pins_are_this_rounds(self):
        self.log = "older lines\n" + layout_log([4] * 18, [(0, 0)] * 18) + layout_log(OLD_GAME_PARS, PINS)
        self.text = json.dumps([self.on_hole(268, "a", 1, 120.0, PINS[0]), self.on_hole(268, "b", 1, 4.0, PINS[0])])
        self.recorder.poll_once()
        [entry] = self.recorder.round_pars()
        self.assertEqual(entry["roundId"], 268)
        self.assertEqual(entry["courseKey"], "Links_v1")
        self.assertEqual(entry["pars"]["7"], 5)
        self.assertEqual(sum(entry["pars"].values()), 73)
        self.assertEqual(entry["checkedHoles"], [1])
        # Kept across a restart; not written again while nothing changes.
        self.clock[0] += bridge.PARS_CHECK_SECONDS + 1
        self.recorder.poll_once()
        restarted = bridge.RoundRecorder(self.store, lambda: self.text, lambda: self.log)
        self.assertEqual(len(restarted.round_pars()), 1)
        self.assertEqual(len(restarted.pars_path.read_text().splitlines()), 1)

    def test_a_layout_from_another_course_or_hole_order_is_refused(self):
        self.log = layout_log(OLD_GAME_PARS, PINS)
        # The ball's distance to the pin doesn't fit the logged pin (wrong course).
        wrong = shot(5, "x", hole=0, EndingPOS={"x": 900, "y": 0, "z": 900}, DistanceToPin=12.0)
        self.text = json.dumps([wrong])
        self.recorder.poll_once()
        self.assertEqual(self.recorder.round_pars(), [])
        # No shot to check against yet: nothing recorded either.
        self.clock[0] += bridge.PARS_CHECK_SECONDS + 1
        self.text = json.dumps([shot(6, "y", hole=0, EndingPOS=None)])
        self.recorder.poll_once()
        self.assertEqual(self.recorder.round_pars(), [])
        self.assertIsNone(bridge.latest_hole_layout("no layout here"))

    def test_without_a_log_reader_recording_is_unchanged(self):
        plain = bridge.RoundRecorder(Path(self.tmp.name) / "plain", lambda: json.dumps([shot(1, "a")]))
        self.assertEqual(plain.poll_once(), 1)
        self.assertEqual(plain.round_pars(), [])


@contextmanager
def running_service():
    server = ThreadingHTTPServer(("127.0.0.1", 0), companion.LooperCompanionHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


def get(port, path, origin="https://thelooper.golf"):
    client = HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        client.request("GET", path, headers={"Origin": origin} if origin else {})
        response = client.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        client.close()


class CompanionEndpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        (root / "gspro").mkdir()
        (root / "gspro" / "currentRound.dat").write_text(json.dumps([shot(7, "s1")]))
        self.saved = (companion.GSPRO_DATA_FOLDER, companion.ROUND_RECORDER)
        companion.GSPRO_DATA_FOLDER = bridge.DataFolder(lambda: {"directory": root / "gspro"})
        companion.ROUND_RECORDER = bridge.RoundRecorder(
            root / "store", bridge.current_round_reader(companion.GSPRO_DATA_FOLDER))
        companion.ROUND_RECORDER.poll_once()

    def tearDown(self):
        companion.GSPRO_DATA_FOLDER, companion.ROUND_RECORDER = self.saved
        self.tmp.cleanup()

    def test_file_stat_and_bytes(self):
        with running_service() as port:
            status, _, body = get(port, "/companion/v1/gspro-file?name=currentRound.dat&stat=1")
            info = json.loads(body)
            self.assertEqual((status, info["status"]), (200, "ok"))
            status, headers, body = get(port, "/companion/v1/gspro-file?name=currentRound.dat&start=2")
            self.assertEqual(status, 200)
            self.assertEqual(int(headers["X-Looper-File-Size"]), info["size"])
            self.assertEqual(int(headers["X-Looper-Range-Start"]), 2)
            self.assertEqual(len(body), info["size"] - 2)
            self.assertEqual(headers["Access-Control-Allow-Origin"], "https://thelooper.golf")
            self.assertIn("X-Looper-File-Size", headers["Access-Control-Expose-Headers"])

    def test_refuses_other_files_and_other_sites(self):
        with running_service() as port:
            self.assertEqual(get(port, "/companion/v1/gspro-file?name=..%2Fsecret")[0], 403)
            self.assertEqual(get(port, "/companion/v1/gspro-file?name=GSPro.db")[0], 404)
            self.assertEqual(
                get(port, "/companion/v1/gspro-file?name=currentRound.dat", origin="https://evil.example")[0],
                403,
            )

    def test_round_records_and_status_capabilities(self):
        with running_service() as port:
            status, _, body = get(port, "/companion/v1/round-records?after=0")
            page = json.loads(body)
            self.assertEqual((status, page["status"], len(page["records"])), (200, "ok", 1))
            self.assertEqual(page["activeRoundId"], 7)
            self.assertNotIn(self.tmp.name, body.decode("utf-8"))
            status, _, body = get(port, "/companion/v1/round-pars")
            pars = json.loads(body)
            self.assertEqual((status, pars["schemaVersion"], pars["status"]), (200, "looper-companion-round-pars-v1", "ok"))
            self.assertIsInstance(pars["rounds"], list)
            self.assertNotIn(self.tmp.name, body.decode("utf-8"))


if __name__ == "__main__":
    unittest.main()
