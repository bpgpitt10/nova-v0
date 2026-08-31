import json
from http.server import BaseHTTPRequestHandler

import opengolfcoach


class handler(BaseHTTPRequestHandler):
    def _write_json(self, status_code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
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
        self._write_json(
            200,
            {
                "service": "looper-open-golf-coach",
                "status": "ok",
                "method": "POST",
            },
        )

    def log_message(self, format: str, *args) -> None:
        return
