"""Turn Wander (and lie test) CSVs from the shot tool into the post series' numbers.

    python analyze_wander.py looper_lab_*.csv [--out folder]

Writes, next to the first CSV unless --out is given:
  wander_summary.md   readable tables
  wander_shots.csv    every shot kept, flat, with the derived columns
  wander_model.json   the same numbers, for charts and the caddie

What it answers:
  1. Lie penalty: how much speed, spin and launch GSPro keeps from each lie, and how that
     changes with launch angle (lower launch, bigger penalty: 20 Nov).
  2. Roll after landing: by club and by the lie it was hit from (spin cut by the lie means
     more roll), by landing surface, and by descent angle.
  3. Green shots: how close they finished, how many held the green, short or long.
  4. Elevation: how much a drop or a climb changes carry, from clean lies.

Shots left out (each counted in the summary): never taken, from or into water, into the trees,
Driver off the ground, and green shots sent much faster than the club's stock speed (an old
Wander bug, 20 Nov). Standard library only.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import statistics
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

M_TO_YD = 1.0936133
M_TO_FT = 3.2808399

#: GSPro's surface numbers (StartingSurface, landing and finish), from the lab logs' material names.
SURFACES = {1: "rough", 2: "fairway", 3: "deep rough", 4: "path", 5: "green", 10: "pin", 11: "sand",
            12: "semi-rough", 14: "trees", 15: "water", 16: "pine straw", 18: "tee", 19: "no surface"}
#: GSPro's material names in the log, by the same names.
MATERIALS = {"TVGrough": "rough", "TVGfairway": "fairway", "TVGdeeprough": "deep rough", "TVGgreen": "green",
             "TVGsand": "sand", "TVGsemirough": "semi-rough", "TVGwood": "trees", "TVGpinestraw": "pine straw",
             "TVGconcrete": "path", "TVGpin": "pin", "TVGnone": "no surface", "TVGtimber": "trees", "TVGwater": "water", "water": "water"}
#: Stock ball speed of the clubs the shot tool sends (its bag, plus Brian's 3W).
STOCK_SPEED = {"Driver": 143.8, "3W": 142.4, "3H": 134.2, "5i": 123.5, "6i": 121.5, "7i": 113.1, "8i": 105.7,
               "9i": 102.9, "PW": 94.4, "GW": 88.7, "SW": 78.6, "LW": 75.6}
CLUB_ORDER = list(STOCK_SPEED)
#: A green shot sent faster than this share of stock is not a swing a player makes.
TOO_HARD = 1.12
NEXT_FROM_RE = re.compile(r"next:\s*\S+\s+from\s+(\d+(?:\.\d+)?)")
WATER_RE = re.compile(r"water|hazard|lake|pond|creek|penalty", re.I)


# ---- Reading -----------------------------------------------------------------------------------

def num(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if out == out else None  # NaN


def surface(code: Any) -> str | None:
    value = num(code)
    return SURFACES.get(int(value), f"surface {int(value)}") if value is not None else None


def club_of(name: str) -> str:
    """The club a shot stands for: 'Driver off the tee' and '3H to green' are clubs; lie test
    shots ('soft 60', 'mid 105') keep their own names."""
    first = (name or "").split(" ")[0]
    return first if first in STOCK_SPEED else name


def aim_of(row: dict[str, Any]) -> str:
    """Older Wander runs had no aim column: tell it from the shot's name."""
    if row.get("aim"):
        return str(row["aim"])
    name = str(row.get("club") or "")
    if name.endswith("off the tee"):
        return "tee"
    if name.endswith("to green"):
        return "green"
    return "lie"


def start_lie(row: dict[str, Any]) -> str:
    """Where the shot was hit from: GSPro's penalty line names the lie; with no line, the start surface."""
    named = row.get("lie_surface")
    if named:
        return MATERIALS.get(str(named), str(named))
    return surface(row.get("start_surface")) or "unknown"


def pin_from_spot_yd(row: dict[str, Any]) -> float | None:
    """How far the pin was from where the shot was hit (yards). See wander.pin_from_spot_yd."""
    given = num(row.get("pin_from_spot_yd"))
    if given is not None:
        return given
    sx, sz, px, pz = (num(row.get(k)) for k in ("start_x", "start_z", "pin_x", "pin_z"))
    if None not in (sx, sz, px, pz):
        return ((px - sx) ** 2 + (pz - sz) ** 2) ** 0.5 * M_TO_YD
    found = NEXT_FROM_RE.search(str(row.get("status") or ""))
    if found and float(found[1]) >= 1.0:
        return float(found[1]) * M_TO_YD
    return None


TYPE_NAMES = {0: "Bentgrass", 1: "Bermuda", 2: "Links"}  # GSPro's Course Type: soft, medium, firm
FIRM_NAMES = {0: "soft", 1: "medium", 2: "firm"}
TEXT_LEVEL = {"soft": 0, "medium": 1, "firm": 2}
LOG_ALTITUDE_RE = re.compile(r"\|\s*elevation\s+(-?\d+)")


def altitude_ft(csv_path: Path) -> float | None:
    """The course's altitude: GSPro writes it on every impact line of its log ("| elevation 545")."""
    log = csv_path.with_name(csv_path.stem + "_log.txt")
    if not log.exists():
        return None
    found = Counter(int(m) for m in LOG_ALTITUDE_RE.findall(log.read_text(encoding="utf-8", errors="replace")))
    return float(found.most_common(1)[0][0]) if found else None


LOG_SHOT_RE = re.compile(r"^--- spot (\d+) shot \d+ \((.*)\) (\S+)")
FOLIAGE_RE = re.compile(r"Leaves hitTime|Bush penalty", re.I)


def foliage_hits(csv_path: Path) -> set[tuple[str, str, str]]:
    """Shots that clipped leaves or a bush in flight (GSPro: "Leaves hitTime ... Penalty 34%"):
    (spot, shot name, time sent), from the log beside the CSV."""
    log = csv_path.with_name(csv_path.stem + "_log.txt")
    hits: set[tuple[str, str, str]] = set()
    if not log.exists():
        return hits
    current = None
    for line in log.read_text(encoding="utf-8", errors="replace").splitlines():
        found = LOG_SHOT_RE.match(line)
        if found:
            current = (found[1], found[2], found[3][:19])
        elif current and FOLIAGE_RE.search(line):
            hits.add(current)
    return hits


def setting(row: dict[str, Any], log_key: str, text_key: str | None) -> int | None:
    value = num(row.get(log_key))
    if value is not None:
        return int(value)
    if text_key:
        return TEXT_LEVEL.get(str(row.get(text_key) or "").strip().lower())
    return None


def load(paths: Iterable[Path]) -> list[dict[str, Any]]:
    """Every Wander and lie test row from the CSVs, once each (a shot can be in two exports)."""
    rows, seen = [], set()
    for path in paths:
        files = sorted(path.glob("looper_lab_*.csv")) if path.is_dir() else [path]
        for file in files:
            altitude = altitude_ft(file)
            leaves = foliage_hits(file)
            with open(file, newline="", encoding="utf-8-sig") as handle:
                for raw in csv.DictReader(handle):
                    if raw.get("test") not in ("wander", "lie"):
                        continue
                    key = raw.get("db_id") or raw.get("row_id") or (raw.get("sent_at"), raw.get("club"))
                    if key in seen:
                        continue
                    seen.add(key)
                    clipped = (str(raw.get("spot")), str(raw.get("club")), str(raw.get("sent_at") or "")[:19]) in leaves
                    rows.append(derive({**raw, "source_file": file.name, "altitude_ft": altitude, "clipped_foliage": clipped}))
    return rows


def derive(row: dict[str, Any]) -> dict[str, Any]:
    name = str(row.get("club") or "")
    carry, total, roll = num(row.get("carry_yd")), num(row.get("total_yd")), num(row.get("roll_yd"))
    flat = num(row.get("db_raw_carry_game_yd"))
    start_y, land_y = num(row.get("start_y")), num(row.get("land_y"))
    pin_left = num(row.get("db_pin_yd"))  # GSPro's DistanceToPin: metres, from where the ball stopped
    distance = pin_from_spot_yd(row)
    sent = num(row.get("sent_speed_mph"))
    club = club_of(name)
    course_type = setting(row, "log_course_type", "course_type")
    fairway = setting(row, "log_fairway_firmness", "fairway_firmness")
    green = setting(row, "log_green_firmness", "green_firmness")
    return {**row,
            "course_type": TYPE_NAMES.get(course_type) if course_type is not None else None,
            "fairway_setting": f"{TYPE_NAMES[course_type]} {FIRM_NAMES[fairway]}"
            if course_type in TYPE_NAMES and fairway in FIRM_NAMES else None,
            "green_setting": f"{TYPE_NAMES[course_type]} {FIRM_NAMES[green]}"
            if course_type in TYPE_NAMES and green in FIRM_NAMES else None,
            "shot": name, "club_group": club, "aim": aim_of(row), "lie": start_lie(row),
            "landed_on": MATERIALS.get(str(row.get("landing_material") or ""), surface(row.get("landing_surface")) or "unknown"),
            "finished_on": surface(row.get("finish_surface")) or "unknown",
            "carry": carry, "total": total, "roll": roll,
            "roll_share": roll / carry if roll is not None and carry and carry > 5 else None,
            "carry_vs_flat": carry / flat if carry and flat and flat > 5 else None,
            "drop_ft": (land_y - start_y) * M_TO_FT if start_y is not None and land_y is not None else None,
            "speed_kept": num(row.get("lie_speed_pct")), "spin_kept": num(row.get("lie_spin_pct")),
            "vla_kept": num(row.get("lie_vla_pct")),
            "launch": num(row.get("sent_vla_deg")), "descent": num(row.get("descent_deg")),
            "landing_spin": num(row.get("landing_spin_rpm")),
            "pin_from_spot": distance,
            "left_from_pin": pin_left * M_TO_YD if pin_left is not None else None,
            "long_by": total - distance if total is not None and distance is not None else None,
            "speed_vs_stock": sent / STOCK_SPEED[club] if sent and club in STOCK_SPEED else None}


def why_left_out(row: dict[str, Any]) -> str | None:
    if row["carry"] is None:
        return "not taken (no carry)"
    if row["aim"] == "water" or row["lie"] == "water" or WATER_RE.search(str(row.get("lie_surface") or "")):
        return "hit from water"
    if row["landed_on"] == "trees" or row["finished_on"] == "trees":
        return "into the trees"
    if row.get("clipped_foliage"):
        return "clipped leaves or a bush in flight"
    if "water" in (row["landed_on"], row["finished_on"]):
        return "into water"
    if "no surface" in (row["lie"], row["landed_on"], row["finished_on"]):
        return "no surface (unpainted ground)"
    if row["finished_on"] in ("unknown",) and row["landed_on"] == "unknown":
        return "no landing recorded"
    if row["club_group"] == "Driver" and row["lie"] not in ("tee",) and row["aim"] != "tee":
        return "Driver off the ground"
    if row["aim"] == "green" and (row["speed_vs_stock"] or 1.0) > TOO_HARD:
        return "green shot swung too hard (old Wander)"
    return None


# ---- Numbers -----------------------------------------------------------------------------------

def med(values: Iterable[float | None]) -> float | None:
    kept = [v for v in values if v is not None]
    return statistics.median(kept) if kept else None


def line_fit(xs: list[float], ys: list[float]) -> dict[str, float] | None:
    """y = a + b x by least squares, with r²."""
    if len(xs) < 4 or len(set(round(x, 3) for x in xs)) < 3:
        return None
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    b = sxy / sxx
    a = my - b * mx
    ss = sum((y - my) ** 2 for y in ys)
    res = sum((y - (a + b * x)) ** 2 for x, y in zip(xs, ys))
    return {"a": a, "b": b, "r2": 1 - res / ss if ss else 1.0, "n": len(xs)}


def band(value: float | None, edges: list[float], unit: str = "") -> str:
    if value is None:
        return "unknown"
    for low, high in zip(edges, edges[1:]):
        if low <= value < high:
            return f"{low:g}–{high:g}{unit}"
    return f"{edges[-1]:g}{unit}+" if value >= edges[-1] else f"under {edges[0]:g}{unit}"


def club_rank(name: str) -> tuple[int, str]:
    return (CLUB_ORDER.index(name), "") if name in CLUB_ORDER else (len(CLUB_ORDER), name)


LIE_ORDER = ["tee", "fairway", "semi-rough", "rough", "deep rough", "sand", "pine straw", "path", "green"]


def lie_rank(name: str) -> tuple[int, str]:
    return (LIE_ORDER.index(name), "") if name in LIE_ORDER else (len(LIE_ORDER), name)


def lie_penalty(rows: list[dict[str, Any]]) -> dict[str, Any]:
    by_lie: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if row["speed_kept"] is not None:
            by_lie[row["lie"]].append(row)
    table, fits, bands = [], {}, []
    for lie in sorted(by_lie, key=lie_rank):
        group = by_lie[lie]
        table.append({"lie": lie, "n": len(group), "speed": med(r["speed_kept"] for r in group),
                      "spin": med(r["spin_kept"] for r in group), "vla": med(r["vla_kept"] for r in group),
                      "speed_low": min(r["speed_kept"] for r in group), "speed_high": max(r["speed_kept"] for r in group)})
        pairs = [(r["launch"], r["speed_kept"]) for r in group if r["launch"] is not None]
        fit = line_fit([p[0] for p in pairs], [p[1] for p in pairs])
        if fit:
            fits[lie] = fit
        by_band: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for r in group:
            by_band[band(r["launch"], [0, 10, 15, 20, 25, 90], "°")].append(r)
        for name in sorted(by_band, key=lambda b: float(re.sub(r"[^\d.].*", "", b.replace("under ", "")) or 0)):
            bands.append({"lie": lie, "launch": name, "n": len(by_band[name]),
                          "speed": med(r["speed_kept"] for r in by_band[name]),
                          "spin": med(r["spin_kept"] for r in by_band[name])})
    clean = [r for r in rows if r["speed_kept"] is None and r["lie"] in ("fairway", "tee", "green")]
    return {"table": table, "fits": fits, "bands": bands, "clean_lies": len(clean)}


def roll_tables(rows: list[dict[str, Any]]) -> dict[str, Any]:
    landed = [r for r in rows if r["roll"] is not None and r["landed_on"] not in ("unknown", "pin")]
    by_club: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for r in landed:
        if r["club_group"] in STOCK_SPEED:
            by_club[(r["club_group"], r["lie"], r["landed_on"])].append(r)
    clubs = [{"club": c, "from": lie, "landed": land, "n": len(g), "carry": med(r["carry"] for r in g),
              "roll": med(r["roll"] for r in g), "roll_share": med(r["roll_share"] for r in g),
              "landing_spin": med(r["landing_spin"] for r in g), "descent": med(r["descent"] for r in g)}
             for (c, lie, land), g in sorted(by_club.items(), key=lambda kv: (club_rank(kv[0][0]), lie_rank(kv[0][1]), kv[0][2]))]
    by_surface: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for r in landed:
        by_surface[(r["landed_on"], band(r["descent"], [0, 30, 40, 50, 90], "°"))].append(r)
    surfaces = [{"landed": land, "descent": d, "n": len(g), "roll": med(r["roll"] for r in g),
                 "roll_share": med(r["roll_share"] for r in g), "landing_spin": med(r["landing_spin"] for r in g)}
                for (land, d), g in sorted(by_surface.items(), key=lambda kv: (lie_rank(kv[0][0]), kv[0][1]))]
    # Same club, clean lie vs a lie that cut the spin: the flyer.
    flyers = []
    for club in sorted({r["club_group"] for r in landed if r["club_group"] in STOCK_SPEED}, key=club_rank):
        clean = [r for r in landed if r["club_group"] == club and r["spin_kept"] is None and r["landed_on"] == "fairway"]
        cut = [r for r in landed if r["club_group"] == club and r["spin_kept"] is not None and r["landed_on"] == "fairway"]
        if clean and cut:
            flyers.append({"club": club, "clean_n": len(clean), "clean_roll": med(r["roll"] for r in clean),
                           "cut_n": len(cut), "cut_roll": med(r["roll"] for r in cut),
                           "spin_kept": med(r["spin_kept"] for r in cut)})
    return {"clubs": clubs, "surfaces": surfaces, "flyers": flyers}


def green_table(rows: list[dict[str, Any]]) -> dict[str, Any]:
    shots = [r for r in rows if r["aim"] == "green" and r["left_from_pin"] is not None]
    by_lie: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in shots:
        by_lie[r["lie"]].append(r)
    table = []
    for lie in sorted(by_lie, key=lie_rank):
        g = by_lie[lie]
        table.append({"from": lie, "n": len(g), "left": med(r["left_from_pin"] for r in g),
                      "held": sum(1 for r in g if r["finished_on"] == "green"),
                      "long_by": med(r["long_by"] for r in g),
                      "distance": med(r["pin_from_spot"] for r in g)})
    # The second shot of a spot is corrected by the first: did it get closer?
    pairs = defaultdict(list)
    for r in shots:
        if r.get("test") == "wander":  # the lie test repeats one shot on purpose; only Wander corrects the second
            pairs[(r["source_file"], r.get("spot"))].append(r)
    firsts = [g[0]["left_from_pin"] for g in pairs.values() if len(g) >= 2]
    seconds = [g[1]["left_from_pin"] for g in pairs.values() if len(g) >= 2]
    wander = [r for r in shots if r.get("test") == "wander"]
    return {"table": table, "n": len(shots), "wander_n": len(wander), "wander_left": med(r["left_from_pin"] for r in wander),
            "wander_held": sum(1 for r in wander if r["finished_on"] == "green"),
            "first": med(firsts), "second": med(seconds), "pairs": len(firsts)}


def elevation(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Carry against GSPro's flat carry for the same launch, from lies with no penalty."""
    clean = [r for r in rows if r["speed_kept"] is None and r["carry_vs_flat"] is not None and r["drop_ft"] is not None
             and r["lie"] in ("fairway", "tee") and r["carry"] and r["carry"] >= 40]
    fit = line_fit([r["drop_ft"] for r in clean], [100 * (r["carry_vs_flat"] - 1) for r in clean])
    by_band: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in clean:
        by_band[band(r["drop_ft"], [-60, -20, -5, 5, 20, 60], " ft")].append(r)
    bands = [{"height": name, "n": len(g), "carry_vs_flat": med(r["carry_vs_flat"] for r in g),
              "carry": med(r["carry"] for r in g)} for name, g in by_band.items()]
    bands.sort(key=lambda b: med(r["drop_ft"] for r in by_band[b["height"]]) or 0)
    return {"fit": fit, "bands": bands, "n": len(clean)}


# ---- Coverage: is the data set complete? -----------------------------------------------------

SETTINGS = [f"{t} {f}" for t in TYPE_NAMES.values() for f in FIRM_NAMES.values()]
LAUNCH_BANDS = ["under 10°", "10–15°", "15–20°", "20–25°", "25°+"]
SPEED_CLASSES = ["Woods and hybrids", "Long and mid irons", "Short irons", "Wedges"]
DROP_BANDS = ["60 ft+ below", "20–60 ft below", "5–20 ft below", "Level (±5 ft)", "5–20 ft above", "20–60 ft above", "60 ft+ above"]
STANCE_BANDS = ["4°+ down", "2–4° down", "Level (±2°)", "2–4° up", "4°+ up"]
SIDE_BANDS = ["4°+ left", "2–4° left", "Level (±2°)", "2–4° right", "4°+ right"]
ALTITUDE_BANDS = ["Under 250 ft", "250–1,000 ft", "1,000–2,500 ft", "2,500–4,000 ft", "4,000 ft+"]
ROLL_SLOPE_BANDS = ["Down 2 ft+", "Down 6–24 in", "Level (±6 in)", "Up 6–24 in", "Up 2 ft+"]
CLEAN_LIES = ("fairway", "tee")


def pick(value: float | None, edges: list[float], names: list[str]) -> str | None:
    """`edges` are the inner boundaries between len(names) bands, low to high."""
    if value is None:
        return None
    for edge, name in zip(edges, names):
        if value < edge:
            return name
    return names[-1]


def speed_class(row: dict[str, Any]) -> str | None:
    """Ball speed sorts every shot, the lie test's own ones too, into a club family."""
    return pick(num(row.get("sent_speed_mph")), [90, 110, 130], SPEED_CLASSES[::-1])


def coverage(kept: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Every cell of every grid we want filled, with how many shots it has and how many it needs."""
    cells: list[dict[str, Any]] = []

    def grid(group: str, rows_: list[str], cols: list[str], target: Any, key, note: str = "") -> None:
        counts: Counter = Counter()
        for row in kept:
            found = key(row)
            if found and found[0] in rows_ and found[1] in cols:
                counts[found] += 1
        for i, r in enumerate(rows_):
            for j, c in enumerate(cols):
                need = target(r) if callable(target) else target
                cells.append({"group": group, "row": r, "row_order": i, "col": c, "col_order": j,
                              "n": counts[(r, c)], "target": need, "note": note})

    penalty_lies = ["semi-rough", "rough", "deep rough", "sand", "pine straw", "path"]
    grid("Lie penalty by launch", ["fairway"] + penalty_lies, LAUNCH_BANDS, 4,
         lambda r: (r["lie"], pick(r["launch"], [10, 15, 20, 25], LAUNCH_BANDS))
         if r["lie"] == "fairway" or r["speed_kept"] is not None else None)
    grid("Lie penalty by course type", penalty_lies[:4], list(TYPE_NAMES.values()), 5,
         lambda r: (r["lie"], r["course_type"]) if r["speed_kept"] is not None else None)
    grid("Roll by setting", ["fairway", "green", "semi-rough", "rough", "deep rough", "sand"], SETTINGS,
         lambda landed: 20 if landed in ("fairway", "green") else 6,
         lambda r: (r["landed_on"], r["green_setting"] if r["landed_on"] == "green" else r["fairway_setting"])
         if r["roll"] is not None else None, "Green rows use the green firmness, the rest the fairway firmness.")
    grid("Tee shots by setting", ["Driver", "3W", "3H"], SETTINGS, 3,
         lambda r: (r["club_group"], r["fairway_setting"]) if r["aim"] == "tee" or r["lie"] == "tee" else None)
    grid("Elevation change", SPEED_CLASSES, DROP_BANDS, 5,
         lambda r: (speed_class(r), pick(r["drop_ft"], [-60, -20, -5, 5, 20, 60], DROP_BANDS))
         if r["lie"] in CLEAN_LIES and r["speed_kept"] is None else None,
         "Fairway and tee only, so the lie doesn't mix in.")
    grid("Stance slope", STANCE_BANDS, SIDE_BANDS, 5,
         lambda r: (pick(num(r.get("slope_up_deg")), [-4, -2, 2, 4], STANCE_BANDS),
                    pick(num(r.get("slope_right_deg")), [-4, -2, 2, 4], SIDE_BANDS))
         if r.get("slope_read") == "companion" else None, "From the companion's slope read at each spot.")
    grid("Course altitude", ALTITUDE_BANDS, SPEED_CLASSES, 8,
         lambda r: (pick(r.get("altitude_ft"), [250, 1000, 2500, 4000], ALTITUDE_BANDS), speed_class(r))
         if r["lie"] in CLEAN_LIES and r["speed_kept"] is None else None,
         "Altitude from GSPro's log, so send the log with each CSV.")
    grid("Landing slope", ["fairway", "green"], ROLL_SLOPE_BANDS, 6,
         lambda r: (r["landed_on"], pick(num(r.get("roll_height_change_in")), [-24, -6, 6, 24], ROLL_SLOPE_BANDS))
         if r["roll"] is not None else None, "Height the ball gained or lost while rolling.")
    return cells


def inventory(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One line per CSV: where, which settings, how many shots kept."""
    by_file: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_file[row["source_file"]].append(row)
    out = []
    for name, group in sorted(by_file.items()):
        stamp = re.search(r"(\d{8})_(\d{6})", name)
        out.append({"file": name, "run": f"{stamp[1][:4]}-{stamp[1][4:6]}-{stamp[1][6:]} {stamp[2][:2]}:{stamp[2][2:4]}" if stamp else name,
                    "test": Counter(r.get("test") for r in group).most_common(1)[0][0],
                    "course": Counter(r.get("course_key") or "unknown" for r in group).most_common(1)[0][0],
                    "settings": ", ".join(sorted({r["fairway_setting"] for r in group if r["fairway_setting"]})) or "unknown",
                    "altitude_ft": group[0].get("altitude_ft"),
                    "shots": len(group), "kept": sum(1 for r in group if not r["left_out"])})
    return out


def analyse(rows: list[dict[str, Any]]) -> dict[str, Any]:
    reasons = Counter()
    kept = []
    for row in rows:
        why = why_left_out(row)
        row["left_out"] = why or ""
        if why:
            reasons[why] += 1
        else:
            kept.append(row)
    return {
        "shots": len(rows), "kept": len(kept), "left_out": dict(reasons.most_common()),
        "courses": dict(Counter(r.get("course_key") or "unknown" for r in kept).most_common()),
        "holes": len({(r.get("course_key"), r.get("hole")) for r in kept if r.get("hole")}),
        "spots": len({(r["source_file"], r.get("spot")) for r in kept}),
        "aims": dict(Counter(r["aim"] for r in kept).most_common()),
        "lies": dict(Counter(r["lie"] for r in kept).most_common()),
        "lie_penalty": lie_penalty(kept), "roll": roll_tables(kept), "green": green_table(kept),
        "elevation": elevation(kept),
        "coverage": coverage(kept), "inventory": inventory(rows),
    }, kept


# ---- Writing -----------------------------------------------------------------------------------

def f(value: float | None, digits: int = 1, unit: str = "") -> str:
    return "–" if value is None else f"{value:.{digits}f}{unit}"


def pct(value: float | None) -> str:
    return "–" if value is None else f"{value:.0f}%"


def share(value: float | None) -> str:
    return "–" if value is None else f"{100 * value:.0f}%"


def table(headers: list[str], body: list[list[str]]) -> list[str]:
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    out += ["| " + " | ".join(row) + " |" for row in body]
    return out + [""]


def summary(result: dict[str, Any]) -> str:
    lines = ["# Wander data", "",
             f"{result['kept']} shots kept of {result['shots']}, from {result['spots']} spots on {result['holes']} holes.", ""]
    if result["left_out"]:
        lines += ["Left out: " + "; ".join(f"{why} {n}" for why, n in result["left_out"].items()) + ".", ""]
    lines += ["Courses: " + ", ".join(f"{c} {n}" for c, n in result["courses"].items()) + ".",
              "Hit from: " + ", ".join(f"{lie} {n}" for lie, n in result["lies"].items()) + ".", ""]

    lp = result["lie_penalty"]
    lines += ["## 1. What each lie keeps", "",
              "GSPro's penalty line: the share of ball speed, spin and launch it leaves on the ball.", ""]
    lines += table(["Lie", "Shots", "Speed kept", "Range", "Spin kept", "Launch kept"],
                   [[r["lie"], str(r["n"]), pct(r["speed"]), f"{pct(r['speed_low'])}–{pct(r['speed_high'])}",
                     pct(r["spin"]), pct(r["vla"])] for r in lp["table"]])
    if lp["bands"]:
        lines += ["By launch angle (lower launch, bigger penalty):", ""]
        lines += table(["Lie", "Launch", "Shots", "Speed kept", "Spin kept"],
                       [[r["lie"], r["launch"], str(r["n"]), pct(r["speed"]), pct(r["spin"])] for r in lp["bands"]])
    for lie, fit in lp["fits"].items():
        lines.append(f"- {lie}: speed kept ≈ {fit['a']:.0f}% {'+' if fit['b'] >= 0 else '−'} {abs(fit['b']):.2f} points per "
                     f"degree of launch (r² {fit['r2']:.2f}, {fit['n']} shots).")
    lines.append("")

    roll = result["roll"]
    lines += ["## 2. Roll after landing", "", "By club, where it was hit from, and where it landed:", ""]
    lines += table(["Club", "From", "Landed", "Shots", "Carry", "Roll", "Roll / carry", "Landing spin", "Descent"],
                   [[r["club"], r["from"], r["landed"], str(r["n"]), f(r["carry"]), f(r["roll"]), share(r["roll_share"]),
                     f(r["landing_spin"], 0), f(r["descent"], 0, "°")] for r in roll["clubs"]])
    if roll["flyers"]:
        lines += ["Same club onto fairway, clean lie vs a lie that cut the spin:", ""]
        lines += table(["Club", "Clean: shots", "Clean: roll", "Cut: shots", "Cut: roll", "Spin kept"],
                       [[r["club"], str(r["clean_n"]), f(r["clean_roll"]), str(r["cut_n"]), f(r["cut_roll"]),
                         pct(r["spin_kept"])] for r in roll["flyers"]])
    lines += ["Every shot, by landing surface and descent angle:", ""]
    lines += table(["Landed", "Descent", "Shots", "Roll", "Roll / carry", "Landing spin"],
                   [[r["landed"], r["descent"], str(r["n"]), f(r["roll"]), share(r["roll_share"]), f(r["landing_spin"], 0)]
                    for r in roll["surfaces"]])

    green = result["green"]
    lines += ["## 3. Shots at the green", ""]
    if green["n"]:
        lines += table(["From", "Shots", "Pin distance", "Finished from pin", "Held the green", "Long (+) / short (−)"],
                       [[r["from"], str(r["n"]), f(r["distance"], 0), f(r["left"]), f"{r['held']} of {r['n']}",
                         f(r["long_by"])] for r in green["table"]])
        if green["wander_n"]:
            lines += [f"Wander's own green shots: {green['wander_n']}, finishing {f(green['wander_left'])} yd from the pin "
                      f"(median), {green['wander_held']} held the green. The rest are the 18 Nov lie tests.", ""]
        if green["pairs"]:
            lines += [f"First shot at a spot finished {f(green['first'])} yd from the pin (median); the second, "
                      f"corrected by the first, {f(green['second'])} yd ({green['pairs']} spots).", ""]
    else:
        lines += ["No green shots yet.", ""]

    elev = result["elevation"]
    lines += ["## 4. Elevation", "",
              "Carry against GSPro's own flat carry for the same launch, from the fairway and tee only (no lie penalty).", ""]
    if elev["bands"]:
        lines += table(["Landing height vs start", "Shots", "Carry vs flat", "Median carry"],
                       [[r["height"], str(r["n"]), share(r["carry_vs_flat"]), f(r["carry"])] for r in elev["bands"]])
    if elev["fit"]:
        fit = elev["fit"]
        lines += [f"About {abs(fit['b']) * 10:.1f}% of carry per 10 ft of height ({'more' if fit['b'] < 0 else 'less'} "
                  f"carry landing below; r² {fit['r2']:.2f}, {fit['n']} shots).", ""]
    return "\n".join(lines) + "\n"


OUT_FIELDS = ["source_file", "course_key", "hole", "spot", "shot", "club_group", "aim", "lie", "landed_on", "finished_on",
              "left_out", "carry", "total", "roll", "roll_share", "descent", "landing_spin", "launch", "speed_kept",
              "spin_kept", "vla_kept", "pin_from_spot", "left_from_pin", "long_by", "drop_ft", "carry_vs_flat",
              "speed_vs_stock", "slope_up_deg", "slope_right_deg", "sideways_yd", "sent_speed_mph", "sent_vla_deg",
              "sent_spin_rpm", "db_id"]


def write(out_dir: Path, rows: list[dict[str, Any]], result: dict[str, Any]) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    md, shots, model = out_dir / "wander_summary.md", out_dir / "wander_shots.csv", out_dir / "wander_model.json"
    md.write_text(summary(result), encoding="utf-8")
    with open(shots, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=OUT_FIELDS, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({k: (round(v, 4) if isinstance(v, float) else v) for k, v in row.items() if k in OUT_FIELDS})
    model.write_text(json.dumps(result, indent=1, default=str), encoding="utf-8")
    cover, files = out_dir / "wander_coverage.json", out_dir / "wander_runs.json"
    cover.write_text(json.dumps(result["coverage"], ensure_ascii=False), encoding="utf-8")
    files.write_text(json.dumps(result["inventory"], ensure_ascii=False), encoding="utf-8")
    return [md, shots, model, cover, files]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("csv", nargs="+", type=Path, help="lab CSVs, or folders of them")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args(argv)
    rows = load(args.csv)
    if not rows:
        print("No Wander or lie test shots in those files.")
        return 1
    result, _kept = analyse(rows)
    first = args.csv[0]
    for path in write(args.out or (first if first.is_dir() else first.parent), rows, result):
        print("wrote", path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
