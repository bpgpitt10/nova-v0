#!/usr/bin/env python3
"""
Discover Nova WebSocket endpoint over mDNS and optionally write VITE_NOVA_WS_URL.

Service searched:
- _openlaunch-ws._tcp.local.
"""

from __future__ import annotations

import argparse
import json
import socket
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path

try:
    from zeroconf import ServiceBrowser, ServiceListener, Zeroconf
except Exception:
    print(
        "Missing dependency: zeroconf. Install with: python -m pip install zeroconf",
        file=sys.stderr,
    )
    raise


SERVICE_TYPE = "_openlaunch-ws._tcp.local."


@dataclass
class NovaEndpoint:
    name: str
    host: str
    port: int
    websocket_url: str
    service_name: str


class NovaListener(ServiceListener):
    def __init__(self, zeroconf: Zeroconf) -> None:
        self._zeroconf = zeroconf
        self.records: dict[str, NovaEndpoint] = {}

    def _capture(self, service_type: str, name: str) -> None:
        info = self._zeroconf.get_service_info(service_type, name)
        if not info:
            return

        addresses: list[str] = []
        for raw in info.addresses:
            if len(raw) == 4:
                addresses.append(socket.inet_ntoa(raw))
            elif len(raw) == 16:
                addresses.append(socket.inet_ntop(socket.AF_INET6, raw))

        host = sorted(addresses)[0] if addresses else info.server.rstrip(".")
        if not host:
            return
        ws_host = f"[{host}]" if ":" in host and not host.startswith("[") else host
        endpoint = NovaEndpoint(
            name=name.split(".")[0],
            host=host,
            port=info.port,
            websocket_url=f"ws://{ws_host}:{info.port}",
            service_name=name,
        )
        self.records[name] = endpoint

    def add_service(self, zeroconf: Zeroconf, service_type: str, name: str) -> None:
        self._capture(service_type, name)

    def update_service(self, zeroconf: Zeroconf, service_type: str, name: str) -> None:
        self._capture(service_type, name)

    def remove_service(self, zeroconf: Zeroconf, service_type: str, name: str) -> None:
        self.records.pop(name, None)


def discover(timeout: float) -> list[NovaEndpoint]:
    zeroconf = Zeroconf()
    listener = NovaListener(zeroconf)
    browser = ServiceBrowser(zeroconf, SERVICE_TYPE, listener)  # noqa: F841
    try:
        time.sleep(timeout)
        return sorted(listener.records.values(), key=lambda row: (row.host, row.port, row.name))
    finally:
        zeroconf.close()


def write_env_file(path: Path, websocket_url: str) -> None:
    line = f"VITE_NOVA_WS_URL={websocket_url}\n"
    existing = ""
    if path.exists():
        existing = path.read_text(encoding="utf-8")
    lines = [row for row in existing.splitlines() if not row.startswith("VITE_NOVA_WS_URL=")]
    lines.append(line.strip())
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Discover Nova WebSocket endpoint via mDNS")
    parser.add_argument("--timeout", type=float, default=3.0, help="Discovery timeout in seconds")
    parser.add_argument("--json", action="store_true", help="Print all discovered endpoints as JSON")
    parser.add_argument(
        "--write-env",
        default=".env.local",
        help="Write discovered endpoint to VITE_NOVA_WS_URL in this env file",
    )
    args = parser.parse_args()

    endpoints = discover(args.timeout)
    if not endpoints:
        print("No Nova WebSocket services discovered.", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps([asdict(row) for row in endpoints], indent=2))
    else:
        for row in endpoints:
            print(f"{row.name}: {row.websocket_url} ({row.host}:{row.port})")

    primary = endpoints[0]
    write_env_file(Path(args.write_env), primary.websocket_url)
    print(f"Selected VITE_NOVA_WS_URL={primary.websocket_url} -> {args.write_env}")
    if len(endpoints) > 1:
        print(
            f"Warning: {len(endpoints)} Nova endpoints discovered; selected first by host/port sort.",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
