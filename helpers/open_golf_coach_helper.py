#!/usr/bin/env python3

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import opengolfcoach


HOST = os.environ.get("OPEN_GOLF_COACH_HOST", "127.0.0.1")
PORT = int(os.environ.get("OPEN_GOLF_COACH_PORT", "8787"))


def derive_values(payload: dict) -> dict:
    result_json = opengolfcoach.calculate_derived_values(json.dumps(payload))
    result = json.loads(result_json)
    if not isinstance(result, dict):
        raise ValueError("OpenGolfCoach result must be a JSON object")
    return result


class OpenGolfCoachHandler(BaseHTTPRequestHandler):
    def _write_json(self, status_code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self._write_json(204, {})

    def do_POST(self) -> None:
        if self.path != "/derive":
            self._write_json(404, {"error": "not found"})
            return

        content_length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(content_length)

        try:
            payload = json.loads(raw_body.decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("payload must be an object")
            derived_values = derive_values(payload)
        except Exception as exc:  # noqa: BLE001
            self._write_json(500, {"error": str(exc)})
            return

        self._write_json(200, derived_values)

    def log_message(self, format: str, *args) -> None:
        return


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), OpenGolfCoachHandler)
    print(f"OpenGolfCoach helper listening on http://{HOST}:{PORT}")
    server.serve_forever()
