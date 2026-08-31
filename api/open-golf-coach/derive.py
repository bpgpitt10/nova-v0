import json
import math
from http.server import BaseHTTPRequestHandler

import opengolfcoach


REQUIRED_INPUT_FIELDS = (
    "ball_speed_meters_per_second",
    "vertical_launch_angle_degrees",
    "horizontal_launch_angle_degrees",
    "total_spin_rpm",
    "spin_axis_degrees",
)

SELF_TEST_SHOT = {
    "ball_speed_meters_per_second": 70.0,
    "vertical_launch_angle_degrees": 12.5,
    "horizontal_launch_angle_degrees": -2.0,
    "total_spin_rpm": 2800.0,
    "spin_axis_degrees": 15.0,
}


def _missing_or_invalid_fields(payload: dict) -> list[str]:
    missing = []
    for field in REQUIRED_INPUT_FIELDS:
        value = payload.get(field)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            missing.append(field)
    return missing


class handler(BaseHTTPRequestHandler):
    def _write_json(self, status_code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        content_length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(content_length)

        try:
            payload = json.loads(raw_body.decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("payload must be an object")

            invalid_fields = _missing_or_invalid_fields(payload)
            if invalid_fields:
                self._write_json(
                    400,
                    {
                        "error": "OpenGolfCoach requires five finite launch inputs.",
                        "missing_or_invalid_fields": invalid_fields,
                    },
                )
                return

            result_json = opengolfcoach.calculate_derived_values(json.dumps(payload))
            result = json.loads(result_json)
            if not isinstance(result, dict):
                raise ValueError("OpenGolfCoach result must be a JSON object")
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
            self._write_json(400, {"error": str(exc)})
            return
        except Exception as exc:  # noqa: BLE001
            self._write_json(500, {"error": str(exc)})
            return

        self._write_json(200, result)

    def do_GET(self) -> None:
        try:
            invalid_fields = _missing_or_invalid_fields(SELF_TEST_SHOT)
            if invalid_fields:
                raise ValueError(f"OpenGolfCoach self-test inputs invalid: {invalid_fields}")

            result = json.loads(
                opengolfcoach.calculate_derived_values(json.dumps(SELF_TEST_SHOT))
            )
            ogc = result.get("open_golf_coach", {})
            shot_name = ogc.get("shot_name")
            shot_rank = ogc.get("shot_rank")
            carry_yards = ogc.get("us_customary_units", {}).get("carry_distance_yards")
            if shot_name is None or shot_rank is None:
                raise ValueError("OpenGolfCoach self-test did not return expected fields")
        except Exception as exc:  # noqa: BLE001
            self._write_json(
                500,
                {
                    "service": "looper-open-golf-coach",
                    "status": "error",
                    "self_test": {"ok": False, "error": str(exc)},
                },
            )
            return

        self._write_json(
            200,
            {
                "service": "looper-open-golf-coach",
                "status": "ok",
                "method": "POST",
                "required_fields": list(REQUIRED_INPUT_FIELDS),
                "self_test": {
                    "ok": True,
                    "shot_name": shot_name,
                    "shot_rank": shot_rank,
                    "carry_yards": carry_yards,
                },
            },
        )

    def log_message(self, format: str, *args) -> None:
        return
