from __future__ import annotations
import json
from pathlib import Path
from typing import Any

class Assumptions:
    def __init__(self, payload: dict[str, Any], source: Path | None = None):
        self.payload = payload
        self.source = source
        if payload.get("schema_version") != "looper-live-caddie-assumptions-v0":
            raise ValueError("Unsupported live-caddie assumptions schema")

    @classmethod
    def load(cls, path: str | Path | None = None) -> "Assumptions":
        if path is None:
            path = Path(__file__).resolve().parents[2] / "config" / "looper-live-caddie.json"
        path = Path(path)
        return cls(json.loads(path.read_text(encoding="utf-8")), path)

    @property
    def version(self) -> str:
        return str(self.payload.get("assumptions_version", "unknown"))

    def get(self, dotted_key: str, default: Any = None) -> Any:
        cur: Any = self.payload
        for part in dotted_key.split("."):
            if not isinstance(cur, dict) or part not in cur:
                if default is not None:
                    return default
                raise KeyError(dotted_key)
            cur = cur[part]
        return cur
