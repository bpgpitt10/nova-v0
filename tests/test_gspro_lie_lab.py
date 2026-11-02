"""Lie lab end to end against a fake GSPro (Open Connect socket + data folder)."""
import json
import math
import socket
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "gspro_lie_lab"))
import analyze  # noqa: E402
import lie_lab  # noqa: E402
import plan as planlib  # noqa: E402
from open_connect import StreamParser  # noqa: E402

PENALTY = {  # GSPro name, base factors, code
    "rough": ("TVGrough", 0.96, 0.61, 1.00, 1),
    "deep rough": ("TVGdeeprough", 0.82, 0.49, 0.98, 3),
    "sand": ("TVGsand", 0.77, 0.765, 1.00, 11),
}


class FakeGSPro:
    """Accepts one launch monitor, writes output_log.txt and currentRound.dat per shot."""

    def __init__(self, folder: Path, send_202: bool = True, log_name: str = "output_log.txt"):
        self.folder = folder
        self.log_name = log_name
        self.send_202 = send_202
        self.lie = "fairway"
        self.side = 0.0  # HUD left/right degrees (+ = Left)
        self.club = "7I"
        self.shots = 0
        self.heartbeats = 0
        self.disconnected = False
        (folder / log_name).write_text("GSPro version 1.2.3 test\n", encoding="utf-8")
        self.server = socket.socket()
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(1)
        self.port = self.server.getsockname()[1]
        threading.Thread(target=self._serve, daemon=True).start()

    def factors(self, speed: float):
        if self.lie not in PENALTY:
            return None
        name, sp, spin, vla, code = PENALTY[self.lie]
        # Speed factor drops slightly with ball speed so the input fit has something to find.
        return name, round(sp - 0.0005 * (speed - 100), 4), spin, vla, code

    def _serve(self):
        conn, _ = self.server.accept()
        parser = StreamParser()
        with conn:
            while True:
                data = conn.recv(65536)
                if not data:
                    return
                for msg in parser.feed(data):
                    opts = msg.get("ShotDataOptions", {})
                    if msg.get("DisconnectLaunchMonitor") or opts.get("DisconnectLaunchMonitor"):
                        self.disconnected = True
                        continue
                    if opts.get("IsHeartBeat"):
                        self.heartbeats += 1
                        continue
                    if opts.get("ContainsBallData"):
                        self._shot(conn, msg["BallData"])

    def _shot(self, conn, ball):
        self.shots += 1
        conn.sendall(b'{"Code":200,"Message":"Shot received successfully"}'
                     + json.dumps({"Code": 201, "Player": {"Handed": "RH", "Club": self.club}}).encode())
        lines = [f"LaunchExt Vars: sp {ball['Speed']}, el {ball['VLA']}, az {ball['HLA']}, "
                 f"ts {ball['TotalSpin']}, sa {ball['SpinAxis']}, cy 150.0, id {self.shots}",
                 "LaunchExt - Regular Mode"]
        f = self.factors(ball["Speed"])
        code = 2
        if f:
            name, sp, spin, vla, code = f
            lines += [f"Penalty Surface {name}, Spin{spin * 100:g}%, Speed {sp * 100:g}%, VLA {vla * 100:g}%",
                      f" ... corrected type {code}"]
        with (self.folder / self.log_name).open("a", encoding="utf-8") as h:
            h.write("\n".join(lines) + "\n")
        time.sleep(0.15)
        carry_m = ball["Speed"] * 1.2 * (f[1] if f else 1.0)
        club = min(planlib.STOCK, key=lambda c: abs(planlib.STOCK[c]["speed"] - ball["Speed"]))
        loft = analyze.LOFT[club]
        dev = math.radians(0.5 * math.degrees(math.atan(
            math.tan(math.radians(loft)) * math.sin(math.radians(self.side)))))
        td = {"x": 10.0 + carry_m * math.sin(dev), "y": 0.0, "z": 20.0 + carry_m * math.cos(dev)}
        record = {"RoundID": 7, "ShotID": self.shots, "GlobalShotNumber": self.shots, "Hole": 1,
                  "StartingSurface": code, "EndingSurface": 2, "TotalDistance": carry_m + 5,
                  "StartingPOS": {"x": 10.0, "y": 0.0, "z": 20.0},
                  "EndingPOS": {"x": 10.0, "y": 0.0, "z": 25.0 + carry_m},
                  "GhostData": {"lmfSP": ball["Speed"], "atShotData": {"tdpoint": td}}}
        (self.folder / "currentRound.dat").write_text(json.dumps({"shots": [record]}), encoding="utf-8")
        if self.send_202:
            conn.sendall(b'{"Code":202,"Message":"Ball stopped"}')


def scripted_ask(fake: FakeGSPro):
    def ask(prompt, default=""):
        if "Surface" in prompt:
            fake.lie = default
            return default
        if "up/down" in prompt:
            return "2U" if fake.lie != "fairway" else "0"
        if "left/right" in prompt:
            fake.side = 4.0 if fake.lie != "fairway" else 0.0
            return "4L" if fake.lie != "fairway" else "0"
        if prompt.strip().startswith("Select"):
            fake.club = prompt.split("Select ")[1].split(" ")[0].upper()
            return ""
        if "Continue this spot" in prompt:
            return "y"
        return ""
    return ask


class LieLabTests(unittest.TestCase):
    def test_stream_parser_handles_run_together_and_split_objects(self):
        parser = StreamParser()
        self.assertEqual(parser.feed(b'{"Code":200}{"Code":201,"Player":{"Cl'), [{"Code": 200}])
        self.assertEqual(parser.feed(b'ub":"7I"}}\r\n{"Code":202}'),
                         [{"Code": 201, "Player": {"Club": "7I"}}, {"Code": 202}])

    def test_angle_parsing(self):
        self.assertEqual(lie_lab.parse_angle("3U", "U", "D"), 3.0)
        self.assertEqual(lie_lab.parse_angle("2.5d", "U", "D"), -2.5)
        self.assertEqual(lie_lab.parse_angle("1R", "L", "R"), -1.0)
        self.assertIsNone(lie_lab.parse_angle("", "L", "R"))

    def test_default_plan_shape(self):
        plan = planlib.build_plan()
        shots = sum(len(s["shots"]) for s in plan["spots"])
        self.assertEqual(len(plan["spots"]), 42)
        self.assertEqual(shots, 42 * 18)
        first = plan["spots"][0]["shots"]
        self.assertEqual(first[0]["kind"], "stock")
        self.assertEqual(first[0]["ballSpeedMph"], first[1]["ballSpeedMph"])

    def _run(self, send_202: bool, api_version: str, log_name: str = "output_log.txt", lies=None):
        tmp = Path(tempfile.mkdtemp())
        gspro = tmp / "GSPro"
        gspro.mkdir()
        fake = FakeGSPro(gspro, send_202=send_202, log_name=log_name)
        plan = planlib.build_plan(lies=lies or [("fairway", 1), ("rough", 2), ("deep rough", 1)],
                                  clubs=["7i", "PW", "SW"])
        plan_path = planlib.write_plan(tmp / "plan.json", plan)
        out = tmp / "session"
        argv = ["run", "--gspro-dir", str(gspro), "--plan", str(plan_path), "--out", str(out),
                "--port", str(fake.port), "--api-version", api_version, "--settle", "0.05",
                "--quiet", "0.3", "--fallback", "1.5", "--timeout", "6"]
        with patch.object(lie_lab, "ask", scripted_ask(fake)):
            self.assertEqual(lie_lab.main(argv), 0)
        time.sleep(0.4)
        fake.server.close()
        return fake, out

    def test_full_session_with_202_then_analysis(self):
        fake, out = self._run(send_202=True, api_version="2")
        rows = [json.loads(l) for l in (out / "shots.jsonl").read_text().splitlines()]
        self.assertEqual(len(rows), 9 + 4 * 9)
        self.assertEqual(fake.shots, len(rows))
        self.assertTrue(fake.disconnected)
        self.assertTrue(all(r["stopSource"] == "202" for r in rows))
        rough = [r for r in rows if r["spot"] == 2]
        self.assertEqual(rough[0]["evidence"]["log"]["penalties"][0]["surfaceName"], "TVGrough")
        self.assertEqual(rough[0]["evidence"]["round"]["startingSurface"], 1)
        self.assertEqual(rows[0]["gsproClubSelected"], "7i")

        self.assertEqual(lie_lab.main(["analyze", str(out)]), 0)
        model = json.loads((out / "lie-model.json").read_text())
        self.assertAlmostEqual(model["factors"]["TVGrough"]["overall"]["spin"], 0.61)
        self.assertAlmostEqual(model["factors"]["TVGdeeprough"]["overall"]["vla"], 0.98)
        self.assertEqual(model["factors"]["TVGdeeprough"]["typeCodes"], [3])
        self.assertTrue(model["randomness"]["TVGrough"]["deterministic"])
        fit = model["inputDependence"]["TVGrough"]["fits"]["speed"]
        self.assertAlmostEqual(fit["perMph"], -0.0005, places=4)
        self.assertGreater(fit["r2"], 0.99)
        labels = model["labelCheck"]
        self.assertEqual(set(labels), {"7i", "PW", "Driver"})
        self.assertEqual(labels["PW"]["gsproReported"], ["PW"])
        self.assertIn("TVGrough", model["slope"]["byLie"])
        self.assertAlmostEqual(model["sidehill"]["gain"], 0.5, places=2)
        summary = (out / "summary.md").read_text()
        self.assertIn("deterministic", summary)

    def test_session_without_202_uses_file_watch(self):
        fake, out = self._run(send_202=False, api_version="1")
        rows = [json.loads(l) for l in (out / "shots.jsonl").read_text().splitlines()]
        self.assertEqual(fake.shots, len(rows))
        self.assertTrue(all(r["stopSource"] == "files" for r in rows))
        # Every shot's own log slice: one launch line each, nothing bleeding across shots.
        self.assertTrue(all(len(r["evidence"]["log"]["launches"]) == 1 for r in rows))
        self.assertGreater(fake.heartbeats, 0)


class BetaLogTests(unittest.TestCase):
    def test_public_beta_player_log_is_followed(self):
        tc = LieLabTests()
        fake, out = tc._run(send_202=True, api_version="2", log_name="Player.log", lies=[("rough", 1)])
        session = json.loads((out / "session.json").read_text())
        self.assertEqual(session["logFile"], "Player.log")
        rows = [json.loads(l) for l in (out / "shots.jsonl").read_text().splitlines()]
        spot_rows = [r for r in rows if r["spot"] == 1]
        self.assertTrue(spot_rows)
        self.assertTrue(all(len(r["evidence"]["log"]["launches"]) == 1 for r in spot_rows))


if __name__ == "__main__":
    unittest.main()
