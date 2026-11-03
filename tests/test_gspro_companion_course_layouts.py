"""Course-layout endpoint: read-only GKD/GKDalt access for the web app.

Synthetic course folders only; no third-party GKD content.
"""
from contextlib import contextmanager
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock
import json
import os
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "helpers"))
import gspro_course_library as library  # noqa: E402

ORIGIN = {"Origin": "https://thelooper.golf"}


def gkd(name, scene=None, tee_x=0.0):
    raw = {
        "CourseName": name,
        "KeywordLinks": True,
        "KeywordMountain": False,
        "KeywordsString": "Links",
        "altitudeV2": 545.0,
        "Holes": [{
            "HoleNumber": 1,
            "Par": 4,
            "Tees": [{"TeeType": "White", "Position": {"x": tee_x, "y": 0, "z": 0}}],
            "Pins": [{"Day": "Thursday", "Position": {"x": 30, "y": 0, "z": 135}}],
        }],
    }
    if scene:
        raw["SceneFolderName"] = scene
    return "\ufeff" + json.dumps(raw)


def make_install(root: Path) -> Path:
    """C:\\GSProV1-like tree: Core\\GSP\\GSPro.exe and Courses\\<folders>."""
    (root / "Core" / "GSP").mkdir(parents=True)
    (root / "Core" / "GSP" / "GSPro.exe").write_bytes(b"")
    course = root / "Courses" / "Synthetic Links v2"
    course.mkdir(parents=True)
    (course / "synthetic_gsp.GKD").write_text(gkd("Synthetic Links"), encoding="utf-8")
    (course / "Synthetic Kids.GKDalt").write_text(gkd("Synthetic Kids", "synthetic_gsp", 40.0), encoding="utf-8")
    (course / "Other Kids.GKDalt").write_text(gkd("Other Kids", "other_gsp"), encoding="utf-8")
    (course / "synthetic_gsp-1665162593.GKD_BAK").write_text("{}", encoding="utf-8")
    (course / "synthetic_gsp.unity3d").write_bytes(b"\0" * 16)
    other = root / "Courses" / "Aaa Course"
    other.mkdir()
    (other / "aaa_gsp.GKD").write_text(gkd("Aaa"), encoding="utf-8")
    return root / "Core" / "GSP" / "GSPro.exe"


class CourseLibraryTests(unittest.TestCase):
    def setUp(self):
        library.clear_caches()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "GSProV1"
        self.exe = make_install(self.root)

    def tearDown(self):
        self.tmp.cleanup()
        library.clear_caches()

    def test_remembers_gspro_location_for_when_gspro_is_closed(self):
        env = {"LOOPER_COMPANION_SETTINGS_DIR": str(Path(self.tmp.name) / "settings")}
        self.assertEqual(library.list_installed_courses(env=env)["status"], "not-found")
        self.assertEqual(library.list_installed_courses(image_path=str(self.exe), env=env)["status"], "ready")
        library.clear_caches()
        closed = library.list_installed_courses(env=env)  # GSPro not running
        self.assertEqual(closed["status"], "ready")
        self.assertEqual(closed["searchedRoots"][0], "last-gspro")
        self.assertEqual(library.course_layouts("synthetic_gsp", env=env)["status"], "ready")

    def test_finds_courses_folder_beside_gspro(self):
        roots = library.library_roots(image_path=str(self.exe), env={})
        self.assertIn(("beside-gspro", self.root / "Courses"), roots)
        result = library.course_layouts("SYNTHETIC_GSP", image_path=str(self.exe), env={})
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["source"], "beside-gspro")
        names = [(l["kind"], l["fileName"]) for l in result["layouts"]]
        self.assertEqual(names, [("main", "synthetic_gsp.GKD"), ("alt", "Synthetic Kids.GKDalt")],
                         "GKD_BAK, unity3d and other scenes' layouts are never returned")
        self.assertTrue(result["layouts"][0]["text"].startswith('{"CourseName"'), "BOM stripped")
        self.assertNotIn(str(self.root), json.dumps(result), "no local paths in the payload")

    def test_override_and_not_found(self):
        env = {"LOOPER_GSPRO_COURSES_DIR": str(self.root / "Courses")}
        self.assertEqual(library.course_layouts("aaa_gsp", env=env)["source"], "override")
        missing = library.course_layouts("missing_gsp", env=env)
        self.assertEqual(missing["status"], "not-found")
        self.assertEqual(missing["layouts"], [])

    def test_rejects_unsafe_keys(self):
        for key in (None, "", "../x", "..\\x", "a/b", "a\\b", "C:x", "x" * 200):
            self.assertEqual(library.course_layouts(key, env={})["status"], "invalid-request", key)

    def test_cached_folder_and_changed_files(self):
        env = {"LOOPER_GSPRO_COURSES_DIR": str(self.root / "Courses")}
        first = library.course_layouts("synthetic_gsp", env=env)
        with mock.patch.object(library, "find_scene_dir", side_effect=AssertionError("searched again")):
            again = library.course_layouts("synthetic_gsp", env=env)
        self.assertEqual(again["source"], "cached")
        self.assertEqual(again["layouts"], first["layouts"])
        path = self.root / "Courses" / "Synthetic Links v2" / "synthetic_gsp.GKD"
        path.write_text(gkd("Synthetic Links", tee_x=5.0), encoding="utf-8")
        os.utime(path, ns=(1, 2_000_000_000_000_000_000))
        changed = library.course_layouts("synthetic_gsp", env=env)
        self.assertIn('"x": 5.0', changed["layouts"][0]["text"], "changed file is re-read")
        # Folder moved: cached location no longer holds the course -> search again.
        (self.root / "Courses" / "Synthetic Links v2").rename(self.root / "Courses" / "Synthetic Links v3")
        moved = library.course_layouts("synthetic_gsp", env=env)
        self.assertEqual(moved["status"], "ready")
        self.assertEqual(moved["source"], "override")

    def test_library_listing(self):
        env = {"LOOPER_GSPRO_COURSES_DIR": str(self.root / "Courses")}
        listing = library.list_installed_courses(env=env)
        self.assertEqual(listing["status"], "ready")
        keys = [c["courseKey"] for c in listing["courses"]]
        self.assertEqual(sorted(keys), ["aaa_gsp", "synthetic_gsp"])
        synth = next(c for c in listing["courses"] if c["courseKey"] == "synthetic_gsp")
        self.assertEqual(synth["courseName"], "Synthetic Links")
        self.assertEqual(synth["holes"], 1)
        self.assertEqual(synth["alternateLayouts"], ["Synthetic Kids"], "other scenes' GKDalt not attached")
        self.assertEqual(synth["pars"], {"1": 4}, "par per hole for the Rounds scorecard")
        self.assertEqual(synth["keywords"], ["links"], "designer style tags, true ones only")
        self.assertEqual(synth["altitude"], 545.0)
        self.assertNotIn(str(self.root), json.dumps(listing), "no local paths")
        self.assertEqual(library.list_installed_courses(env={"LOOPER_GSPRO_COURSES_DIR": str(self.root / "nope")})["status"],
                         "not-found")

    def test_listing_remembers_course_folders(self):
        env = {"LOOPER_GSPRO_COURSES_DIR": str(self.root / "Courses")}
        library.list_installed_courses(env=env)
        with mock.patch.object(library, "find_scene_dir", side_effect=AssertionError("searched again")):
            found = library.course_layouts("aaa_gsp", env=env)
        self.assertEqual(found["status"], "ready")
        self.assertEqual(found["source"], "cached")

    def test_lookup_reaches_as_far_as_the_listing(self):
        # A library with more than 1,500 folders ahead of the course (3 Nov: every
        # per-course lookup on the sim PC came back empty while the listing worked).
        courses = self.root / "Courses"
        for index in range(1600):
            (courses / f"Aa Filler {index:04d}").mkdir()
        (courses / "Zz Late").mkdir()
        (courses / "Zz Late" / "late_gsp.GKD").write_text(gkd("Late Course"), encoding="utf-8")
        env = {"LOOPER_GSPRO_COURSES_DIR": str(courses)}
        self.assertEqual(library.course_layouts("late_gsp", env=env)["status"], "ready")

    def test_walk_is_bounded(self):
        env = {"LOOPER_GSPRO_COURSES_DIR": str(self.root / "Courses")}
        self.assertIsNone(library.find_scene_dir(library.library_roots(env=env), "missing_gsp", max_visited=2))


@contextmanager
def running_service():
    import looper_companion as companion
    server = ThreadingHTTPServer(("127.0.0.1", 0), companion.LooperCompanionHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


def get(port, path, headers):
    client = HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        client.request("GET", path, headers={**headers, "Host": f"127.0.0.1:{port}"})
        response = client.getresponse()
        raw = response.read()
        return response.status, dict(response.getheaders()), json.loads(raw) if raw else {}
    finally:
        client.close()


class CourseLayoutsEndpointTests(unittest.TestCase):
    def setUp(self):
        library.clear_caches()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "GSProV1"
        make_install(self.root)

    def tearDown(self):
        self.tmp.cleanup()
        library.clear_caches()

    def test_endpoint_serves_layouts_to_looper_origins_only(self):
        import looper_companion as companion
        env = {"LOOPER_GSPRO_COURSES_DIR": str(self.root / "Courses")}
        with mock.patch.dict(os.environ, env), \
                mock.patch.object(companion.native, "find_gspro_window", return_value={"status": "waiting"}), \
                running_service() as port:
            status, headers, body = get(port, "/companion/v1/course-layouts?courseKey=synthetic_gsp", ORIGIN)
            self.assertEqual(status, 200)
            self.assertEqual(headers.get("Access-Control-Allow-Origin"), "https://thelooper.golf")
            self.assertEqual(body["status"], "ready")
            self.assertEqual(body["version"], companion.COMPANION_VERSION)
            self.assertEqual([l["fileName"] for l in body["layouts"]], ["synthetic_gsp.GKD", "Synthetic Kids.GKDalt"])
            status, _, body = get(port, "/companion/v1/course-layouts?courseKey=synthetic_gsp",
                                  {"Origin": "https://evil.example"})
            self.assertEqual(status, 403)
            self.assertNotIn("layouts", body)
            status, _, body = get(port, "/companion/v1/course-layouts?courseKey=..%2Fsecrets", ORIGIN)
            self.assertEqual(body["status"], "invalid-request")

    def test_status_advertises_course_layouts(self):
        import looper_companion as companion
        with mock.patch.object(companion, "discover_gspro_context", return_value={
            "gspro": {"status": "waiting"}, "dataFolder": {"status": "not-found"}, "_window": {},
        }), running_service() as port:
            status, _, body = get(port, "/companion/v1/status", ORIGIN)
            self.assertEqual(status, 200)
            self.assertTrue(body["capabilities"]["courseLayouts"])
            self.assertFalse(body["capabilities"]["autoAim"])


if __name__ == "__main__":
    unittest.main()
