"""Contract tests for native diagnostic observations; never require actual GSPro."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
from contextlib import contextmanager
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from threading import Thread

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "helpers"))
import gspro_live_observations as obs
import looper_companion as companion


@contextmanager
def local_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), companion.LooperCompanionHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=4)


def request(port, path, headers=None, method="GET"):
    connection = HTTPConnection("127.0.0.1", port, timeout=3)
    try:
        connection.request(method, path, headers=headers or {})
        response = connection.getresponse()
        raw = response.read()
        return response.status, json.loads(raw) if raw else None
    finally:
        connection.close()


class ObservationTests(unittest.TestCase):
    def test_current_shot_preferred_over_prior_completed(self):
        raw = json.dumps({
            "CurrentShot": {
                "Hole": 11, "HoleShot": 1, "CourseKey": "Test Layout",
                "RoundID": 21, "ShotID": "tee-current",
                "StartingPOS": {"x": 123.5, "y": 12, "z": -11},
                "DistanceToPin": 155,
            },
            "PreviousShots": [
                {"Hole": 10, "HoleShot": 3, "ShotID": "old",
                 "StartingPOS": {"x": 1, "y": 1, "z": 1}}
            ],
        })
        state = obs.parse_current_round(raw)
        self.assertEqual(state["status"], "ready")
        self.assertEqual(state["holeNumber"], 12)
        self.assertEqual(state["kind"], "pre_shot")
        self.assertEqual(state["startingWorld"]["x"], 123.5)
        self.assertAlmostEqual(state["distanceToPinYds"], 169.51, places=1)

    def test_completed_shot_exposes_raw_ending_code_without_assigning_surface_label(self):
        shot = obs.parse_current_round(json.dumps({
            "Shots": [{"Hole": 0, "HoleShot": 1, "CourseKey": "farmlinks_al_2_7_gsp",
                       "StartingSurface": 18, "EndingSurface": 3,
                       "StartingPOS": {"x": 1, "y": 0, "z": 3},
                       "EndingPOS": {"x": 2, "y": 0, "z": 8}}]
        }))
        self.assertEqual(shot["kind"], "last_completed")
        self.assertEqual(shot["startingSurfaceRaw"], 18)
        self.assertEqual(shot["endingSurfaceRaw"], 3)
        self.assertNotIn("endingSurface", shot)
        self.assertNotIn("lieName", shot)

    def test_bad_and_unavailable_are_not_fake_tee_fixes(self):
        self.assertEqual(obs.parse_current_round("not-json")["status"], "unavailable")
        self.assertEqual(obs.parse_current_round(None)["status"], "unavailable")
        previous = obs.parse_current_round(json.dumps({
            "Shots": [{"Hole": 3, "HoleShot": 1, "StartingPOS": {"x": 2, "y": 0, "z": 1}}]
        }))
        self.assertEqual(previous["kind"], "last_completed")
        self.assertEqual(previous["status"], "completed_record_only")
        # An old completed shot is evidence, not an authoritative tee/current ball.
        self.assertEqual(previous["startingWorld"], {"x": 2.0, "y": 0.0, "z": 1.0})
        self.assertNotIn("currentBallWorld", previous)
        self.assertNotIn("currentHole", previous)

    def test_bounded_log_layout_and_hole_index(self):
        rows = [
            {"active": i == 11, "strokeIdx": i, "par": 3 if i == 11 else 4,
             "teePos": {"x": i, "y": 0, "z": 10}, "pinPos": {"x": i, "y": 0, "z": 145}}
            for i in range(18)
        ]
        log = "2026 INFO loaded\n" + json.dumps(rows) + "\nmore log lines"
        item = obs.parse_course_layout(log, 12)
        self.assertEqual(item["status"], "ready")
        self.assertEqual(item["par"], 3)
        self.assertEqual(item["holeNumber"], 12)
        self.assertAlmostEqual(item["teeToPinWorldYards"], 147.64, places=1)
        self.assertEqual(obs.parse_course_layout("log only", 12)["status"], "unavailable")
        self.assertEqual(obs.parse_course_layout(log, 19)["status"], "unavailable")

    def test_structured_file_has_age_no_local_paths_or_raw_contents(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "currentRound.dat").write_text(json.dumps({
                "CurrentShot": {"Hole": 0, "HoleShot": 1,
                                "StartingPOS": {"x": 0, "y": 1, "z": 2}}
            }))
            result = obs.read_structured_state({"directory": root})
            self.assertEqual(result["shot"]["holeNumber"], 1)
            self.assertIn("fileAgeMs", result)
            self.assertNotIn(str(root), json.dumps(result))
            self.assertNotIn("rawText", json.dumps(result))
            self.assertNotIn("directory", json.dumps(result))

    def test_no_screenshot_or_mouse_data_in_native_json(self):
        with mock.patch.object(obs.native, "find_gspro_window", return_value={"status": "waiting", "reason": "not-running"}), \
             mock.patch.object(obs.native, "discover_gspro_data_directory", return_value={
                 "directory": None, "status": "not-found", "source": None,
                 "files": {"currentRound.dat": False, "output_log.txt": False, "GSPro.db": False},
                 "reason": "not-found"}):
            result = obs.collect_observations()
        self.assertEqual(result["status"], "unavailable")
        self.assertFalse(result["capabilities"]["autoAim"])
        self.assertNotIn("currentBallWorld", json.dumps(result))
        self.assertNotIn("currentHole", json.dumps(result))
        self.assertNotIn("_private_bgra", json.dumps(result))

    def test_stage_timings_are_sanitized_and_monotonic(self):
        with mock.patch.object(obs.native, "find_gspro_window",
                               return_value={"status": "waiting", "reason": "not-running"}), \
             mock.patch.object(obs.native, "discover_gspro_data_directory",
                               return_value={"directory": None, "status": "not-found",
                                             "source": None, "files": {}, "reason": "not-running"}):
            result = obs.collect_observations()
        timers = result["timingMs"]
        self.assertGreaterEqual(timers["total"], 0)
        for name in ("structuredDiscovery", "nativeCapture", "minimapTotal",
                     "windOcr", "lieOcr"):
            self.assertIsInstance(timers[name], float)
            self.assertGreaterEqual(timers[name], 0)
        self.assertGreaterEqual(timers["total"], timers["minimapTotal"])
        self.assertNotIn("_private_bgra", json.dumps(result))
        self.assertFalse(result["capabilities"]["autoAim"])

    def test_dashboard_labels_completed_record_as_evidence_only(self):
        html = (Path(__file__).resolve().parents[1] /
                "public/dev/companion-observations.html").read_text(encoding="utf-8")
        self.assertIn("Last completed EndingPOS", html)
        self.assertIn("May be previous hole; not authoritative current ball", html)
        self.assertNotIn('class="label">GSPro ball world', html)

    def test_http_endpoint_is_origin_and_host_restricted_and_no_post(self):
        fake = {
            "service": "looper-companion", "schemaVersion": "native-observations-v1",
            "status": "unavailable",
            "structured": {"status": "unavailable"},
            "minimap": {"status": "not-connected"},
            "ocr": {"wind": {"status": "UNAVAILABLE"}, "lie": {"status": "UNAVAILABLE"}},
        }
        with local_server() as port, mock.patch.object(companion.observations, "collect_observations", return_value=fake):
            origin = {"Origin": "https://thelooper.golf"}
            ok, data = request(port, "/companion/v1/observations", origin)
            self.assertEqual(ok, 200)
            self.assertEqual(data["schemaVersion"], "native-observations-v1")
            self.assertEqual(data["version"], companion.COMPANION_VERSION)
            self.assertEqual(data["stateAuthority"], "diagnostic-only")
            self.assertNotIn("currentBallWorld", data)
            self.assertNotIn("nextShotNumber", data)
            forbidden, _ = request(port, "/companion/v1/observations", {"Origin": "https://evil.example"})
            self.assertEqual(forbidden, 403)
            forbidden_host, _ = request(port, "/companion/v1/observations",
                                        {**origin, "Host": "attacker.invalid"})
            self.assertEqual(forbidden_host, 403)
            disallowed_post, payload = request(port, "/companion/v1/observations",
                                               origin, "POST")
            self.assertEqual(disallowed_post, 405)
            self.assertEqual(payload["error"], "actuation_not_implemented")


if __name__ == "__main__":
    unittest.main()
