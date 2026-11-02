"""Spot and shot plan for the lie lab.

Stock launch numbers are Brian's own: the median of the middle-50% carry band
of included, untagged shots per club in Supabase `shots` (2 Nov 2026). There
is no 3W data yet, so the woods slot is the 3H.

Each spot gets every club. Per club: the stock shot, the same stock shot again
(shows whether GSPro's penalty is random), and one variant. The variant cycles
from spot to spot, so across a lie we see how the penalty moves with speed,
spin and launch. Spin axis and HLA are zero: lateral flight isn't the point.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

STOCK: dict[str, dict[str, float]] = {
    # club: ball speed mph, VLA deg, total spin rpm (stock carry/total for reference)
    "Driver": {"speed": 143.8, "vla": 11.1, "spin": 2812, "carry": 232.9, "total": 249.1},
    "3H": {"speed": 134.2, "vla": 8.7, "spin": 4701, "carry": 196.2, "total": 209.2},
    "5i": {"speed": 123.5, "vla": 12.0, "spin": 5280, "carry": 177.3, "total": 188.1},
    "7i": {"speed": 113.1, "vla": 16.4, "spin": 6175, "carry": 157.6, "total": 166.0},
    "PW": {"speed": 94.4, "vla": 22.4, "spin": 8646, "carry": 120.4, "total": 125.3},
    "SW": {"speed": 78.6, "vla": 26.6, "spin": 9856, "carry": 88.6, "total": 90.8},
}

# The order lies are visited in, with the number of spots for each.
DEFAULT_LIES: list[tuple[str, int]] = [
    ("fairway", 6),
    ("rough", 10),
    ("deep rough", 10),
    ("sand", 8),
    ("fringe", 4),
    ("other", 4),  # semi-rough, pine straw, waste area: whatever the course offers
]

VARIANTS: list[tuple[str, dict[str, float]]] = [
    ("speed-85%", {"speedMul": 0.85}),
    ("spin+25%", {"spinMul": 1.25}),
    ("vla+3", {"vlaAdd": 3.0}),
    ("spin-25%", {"spinMul": 0.75}),
    ("speed-60%", {"speedMul": 0.60}),  # a partial / knockdown swing
]


def _shot(club: str, kind: str, change: dict[str, float] | None = None) -> dict[str, Any]:
    base = STOCK[club]
    change = change or {}
    return {
        "club": club,
        "kind": kind,
        "ballSpeedMph": round(base["speed"] * change.get("speedMul", 1.0), 1),
        "vlaDeg": round(base["vla"] + change.get("vlaAdd", 0.0), 1),
        "spinRpm": round(base["spin"] * change.get("spinMul", 1.0)),
        "hlaDeg": 0.0,
        "spinAxisDeg": 0.0,
    }


def shots_for_spot(spot_index: int, clubs: list[str]) -> list[dict[str, Any]]:
    shots: list[dict[str, Any]] = []
    for club_index, club in enumerate(clubs):
        name, change = VARIANTS[(spot_index + club_index) % len(VARIANTS)]
        shots.append(_shot(club, "stock"))
        shots.append(_shot(club, "stock-repeat"))
        shots.append(_shot(club, name, change))
    return shots


def build_plan(lies: list[tuple[str, int]] | None = None, clubs: list[str] | None = None) -> dict[str, Any]:
    lies = lies or DEFAULT_LIES
    clubs = clubs or list(STOCK)
    spots = []
    index = 0
    for lie, count in lies:
        for n in range(count):
            spots.append({
                "spot": index + 1,
                "targetLie": lie,
                "note": "flat" if n % 2 == 0 else "sloped (any direction)",
                "shots": shots_for_spot(index, clubs),
            })
            index += 1
    return {
        "schema": "looper-gspro-lie-lab-plan-v1",
        "stockSource": "Supabase shots, middle-50% carry band median per club, 2026-11-02",
        "stock": STOCK,
        "labelCheck": {
            "enabled": True,
            "lie": "rough",
            "club": "7i",
            "gsproClubs": ["7i", "PW", "Driver"],
            "repeats": 3,
        },
        "spots": spots,
    }


def label_check_shots(plan: dict[str, Any]) -> list[dict[str, Any]]:
    check = plan.get("labelCheck") or {}
    club = check.get("club", "7i")
    return [_shot(club, "label-check") for _ in range(int(check.get("repeats", 3)))]


def write_plan(path: Path, plan: dict[str, Any] | None = None) -> Path:
    plan = plan or build_plan()
    path.write_text(json.dumps(plan, indent=2) + "\n", encoding="utf-8")
    return path


def load_plan(path: Path) -> dict[str, Any]:
    plan = json.loads(path.read_text(encoding="utf-8"))
    if plan.get("schema") != "looper-gspro-lie-lab-plan-v1":
        raise ValueError(f"{path} is not a lie lab plan")
    return plan
