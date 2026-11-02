"""Turn lie lab sessions into tables of GSPro's lie response.

Outputs (in the first session folder unless --out is given):
  shots.csv       one row per shot, flat
  summary.md      readable tables
  lie-model.json  per-lie factors (overall and per club), randomness, input
                  dependence and slope fits, shaped for src/liveCaddie/surfaceResponse.ts

Standard library only.
"""

from __future__ import annotations

import csv
import json
import re
import statistics
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

from evidence import INTEREST_RE, LAUNCH_RE, PENALTY_RE, TYPE_RE

FACTORS = ("speed", "spin", "vla")
CLUB_ORDER = ["Driver", "3W", "3H", "5i", "6i", "7i", "8i", "9i", "PW", "GW", "SW", "LW"]


# --------------------------------------------------------------------------
# Loading

def load_rows(session_dirs: Iterable[Path]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for session in session_dirs:
        path = Path(session) / "shots.jsonl"
        if not path.exists():
            raise SystemExit(f"No shots.jsonl in {session}")
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                raw = json.loads(line)
                raw["_session"] = Path(session).name
                rows.append(raw)
    return rows


def _num(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def flatten(raw: dict[str, Any]) -> dict[str, Any]:
    shot = raw.get("shot") or {}
    info = raw.get("spotInfo") or {}
    evidence = raw.get("evidence") or {}
    log = evidence.get("log") or {}
    rec = evidence.get("round") or {}
    penalty = (log.get("penalties") or [None])[0]
    launch = (log.get("launches") or [None])[0]
    player = raw.get("gsproPlayer") or {}
    row = {
        "session": raw.get("_session"),
        "tag": raw.get("tag"),
        "spot": raw.get("spot"),
        "targetLie": raw.get("targetLie"),
        "hudSurface": info.get("hudSurface"),
        "hudUpDownDeg": info.get("hudUpDownDeg"),
        "hudLeftRightDeg": info.get("hudLeftRightDeg"),
        "club": shot.get("club"),
        "kind": shot.get("kind"),
        "sentSpeed": shot.get("ballSpeedMph"),
        "sentVla": shot.get("vlaDeg"),
        "sentSpin": shot.get("spinRpm"),
        "gsproClub": player.get("Club"),
        "gsproClubSelected": raw.get("gsproClubSelected"),
        "surfaceName": penalty["surfaceName"] if penalty else None,
        "speed": penalty["speed"] if penalty else None,
        "spin": penalty["spin"] if penalty else None,
        "vla": penalty["vla"] if penalty else None,
        "penaltyLines": len(log.get("penalties") or []),
        "typeCode": (log.get("typeCodes") or [None])[-1],
        "logSpeed": launch["ballSpeedMph"] if launch else None,
        "logVla": launch["vlaDeg"] if launch else None,
        "logSpin": launch["spinRpm"] if launch else None,
        "startSurface": rec.get("startingSurface"),
        "endSurface": rec.get("endingSurface"),
        "carryYds": rec.get("carryYds"),
        "restYds": rec.get("restYds"),
        "totalYds": rec.get("totalYds"),
        "touchdownSpinRpm": rec.get("touchdownSpinRpm"),
        "startX": (rec.get("start") or {}).get("x"),
        "startZ": (rec.get("start") or {}).get("z"),
        "tdX": (rec.get("touchdown") or {}).get("x"),
        "tdZ": (rec.get("touchdown") or {}).get("z"),
        "stopSource": raw.get("stopSource"),
    }
    row["lie"] = lie_key(row)
    return row


def lie_key(row: dict[str, Any]) -> str:
    """GSPro's own surface name when it logged a penalty; otherwise the HUD/target label."""
    if row.get("surfaceName"):
        return str(row["surfaceName"])
    label = (row.get("hudSurface") or row.get("targetLie") or "unknown").strip().lower()
    return f"no-penalty:{label}"


# --------------------------------------------------------------------------
# Small stats helpers

def med(values: list[float]) -> float | None:
    values = [v for v in values if v is not None]
    return statistics.median(values) if values else None


def spread(values: list[float]) -> float | None:
    values = [v for v in values if v is not None]
    return max(values) - min(values) if len(values) > 1 else None


def least_squares(xs: list[list[float]], ys: list[float]) -> tuple[list[float], float] | None:
    """Ordinary least squares with intercept via normal equations. Returns (coefs, r2)."""
    n = len(ys)
    if n == 0:
        return None
    k = len(xs[0]) + 1
    if n <= k:
        return None
    design = [[1.0] + list(x) for x in xs]
    xtx = [[sum(r[i] * r[j] for r in design) for j in range(k)] for i in range(k)]
    xty = [sum(r[i] * y for r, y in zip(design, ys)) for i in range(k)]
    # Gauss-Jordan with partial pivoting.
    m = [row[:] + [b] for row, b in zip(xtx, xty)]
    for col in range(k):
        pivot = max(range(col, k), key=lambda r: abs(m[r][col]))
        if abs(m[pivot][col]) < 1e-12:
            return None
        m[col], m[pivot] = m[pivot], m[col]
        for r in range(k):
            if r != col:
                f = m[r][col] / m[col][col]
                m[r] = [a - f * b for a, b in zip(m[r], m[col])]
    coefs = [m[i][k] / m[i][i] for i in range(k)]
    mean_y = sum(ys) / n
    ss_tot = sum((y - mean_y) ** 2 for y in ys)
    ss_res = sum((y - sum(c * v for c, v in zip(coefs, r))) ** 2 for r, y in zip(design, ys))
    r2 = 1 - ss_res / ss_tot if ss_tot > 1e-12 else 1.0
    return coefs, r2


def pct(value: float | None) -> str:
    return "—" if value is None else f"{value * 100:.1f}%"


def num(value: float | None, digits: int = 1) -> str:
    return "—" if value is None else f"{value:.{digits}f}"


def pts(value: float | None) -> str:
    return "—" if value is None else f"{value * 100:+.2f} pts"


def club_sort(club: str) -> int:
    return CLUB_ORDER.index(club) if club in CLUB_ORDER else len(CLUB_ORDER)


# --------------------------------------------------------------------------
# Analyses

def factor_tables(rows: list[dict[str, Any]]) -> dict[str, Any]:
    by_lie: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if row["speed"] is not None:
            by_lie[row["lie"]].append(row)
    out: dict[str, Any] = {}
    for lie, items in sorted(by_lie.items()):
        per_club = {}
        for club in sorted({r["club"] for r in items}, key=club_sort):
            club_rows = [r for r in items if r["club"] == club]
            per_club[club] = {
                "n": len(club_rows),
                **{f: med([r[f] for r in club_rows]) for f in FACTORS},
                **{f"{f}Range": spread([r[f] for r in club_rows]) for f in FACTORS},
            }
        out[lie] = {
            "n": len(items),
            "typeCodes": sorted({r["typeCode"] for r in items if r["typeCode"] is not None}),
            "startSurfaces": sorted({r["startSurface"] for r in items if r["startSurface"] is not None}),
            "overall": {f: med([r[f] for r in items]) for f in FACTORS},
            "overallRange": {f: spread([r[f] for r in items]) for f in FACTORS},
            "perClub": per_club,
        }
    return out


def randomness(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Identical inputs at the same spot (stock vs stock-repeat): do the factors change?"""
    groups: dict[tuple, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if row["speed"] is None:
            continue
        key = (row["session"], row["spot"], row["club"], row["sentSpeed"], row["sentVla"], row["sentSpin"],
               row.get("gsproClubSelected"))
        groups[key].append(row)
    per_lie: dict[str, list[float]] = defaultdict(list)
    for items in groups.values():
        if len(items) < 2:
            continue
        lie = items[0]["lie"]
        per_lie[lie].append(max(spread([r[f] for r in items]) or 0.0 for f in FACTORS))
    return {
        lie: {"pairs": len(d), "maxDifference": max(d), "medianDifference": statistics.median(d),
              "deterministic": max(d) < 0.005}
        for lie, d in sorted(per_lie.items())
    }


def input_fits(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """factor ~ a + b*speed + c*VLA + d*(spin/1000), per lie, all clubs together."""
    out: dict[str, Any] = {}
    by_lie: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if row["speed"] is not None and None not in (row["sentSpeed"], row["sentVla"], row["sentSpin"]):
            by_lie[row["lie"]].append(row)
    for lie, items in sorted(by_lie.items()):
        xs = [[r["sentSpeed"], r["sentVla"], r["sentSpin"] / 1000.0] for r in items]
        fits = {}
        for f in FACTORS:
            fit = least_squares(xs, [r[f] for r in items])
            if fit:
                coefs, r2 = fit
                fits[f] = {"intercept": coefs[0], "perMph": coefs[1], "perDegVla": coefs[2],
                           "perKrpm": coefs[3], "r2": r2}
        out[lie] = {"n": len(items), "fits": fits}
    return out


def variant_effects(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Each variant minus the stock shot of the same club at the same spot."""
    stock: dict[tuple, dict[str, Any]] = {}
    for row in rows:
        if row["kind"] == "stock" and row["speed"] is not None:
            stock[(row["session"], row["spot"], row["club"])] = row
    deltas: dict[tuple[str, str], dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    for row in rows:
        if row["kind"] in ("stock", "stock-repeat", "label-check") or row["speed"] is None:
            continue
        base = stock.get((row["session"], row["spot"], row["club"]))
        if not base:
            continue
        for f in FACTORS:
            deltas[(row["lie"], row["kind"])][f].append(row[f] - base[f])
    return {
        f"{lie} · {kind}": {f: med(v) for f, v in d.items()} | {"n": len(next(iter(d.values())))}
        for (lie, kind), d in sorted(deltas.items())
    }


def slope_fits(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """factor and carry ratio vs HUD lie angles, per lie, stock shots only."""
    fairway_carry: dict[str, float] = {}
    base_rows = [r for r in rows if r["lie"].startswith("no-penalty:") and r["kind"] in ("stock", "stock-repeat")
                 and r["carryYds"] is not None and not r["hudUpDownDeg"] and not r["hudLeftRightDeg"]]
    for club in {r["club"] for r in base_rows}:
        fairway_carry[club] = med([r["carryYds"] for r in base_rows if r["club"] == club])
    out: dict[str, Any] = {}
    by_lie: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if row["kind"] in ("stock", "stock-repeat") and row["hudUpDownDeg"] is not None \
                and row["hudLeftRightDeg"] is not None:
            by_lie[row["lie"]].append(row)
    for lie, items in sorted(by_lie.items()):
        xs = [[r["hudUpDownDeg"], r["hudLeftRightDeg"]] for r in items]
        result: dict[str, Any] = {"n": len(items),
                                  "spots": len({(r["session"], r["spot"]) for r in items})}
        for f in FACTORS:
            ys = [r[f] for r in items]
            if None not in ys:
                fit = least_squares(xs, ys)
                if fit:
                    result[f] = {"perDegUp": fit[0][1], "perDegLeft": fit[0][2], "r2": fit[1]}
        ratio_rows = [(x, r["carryYds"] / fairway_carry[r["club"]]) for x, r in zip(xs, items)
                      if r["carryYds"] and fairway_carry.get(r["club"])]
        if ratio_rows:
            fit = least_squares([x for x, _ in ratio_rows], [y for _, y in ratio_rows])
            if fit:
                result["carryRatio"] = {"intercept": fit[0][0], "perDegUp": fit[0][1],
                                        "perDegLeft": fit[0][2], "r2": fit[1]}
        out[lie] = result
    return {"fairwayStockCarry": fairway_carry, "byLie": out}


# Nominal lofts, as in src/liveCaddie/lieResponse.ts NOMINAL_CLUB_LOFT_DEG.
LOFT = {"Driver": 10.5, "3W": 15, "3H": 19, "5i": 26, "6i": 29, "7i": 33, "8i": 37, "9i": 41,
        "PW": 45, "GW": 50, "SW": 54, "LW": 58}


def sidehill(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Does a sidehill lie push high-loft clubs off line more than low-loft ones?

    All shots at a spot share GSPro's aim and are sent with HLA 0 and axis 0,
    so differences in start direction between clubs at one spot come from the
    lie. Looper's prior: shift = gain * atan(tan(loft) * sin(sideSlope)), gain
    0.5 (SIDEHILL_LIE_GAIN). Here we fit that gain, relative to the lowest-loft
    club at the spot. The sign depends on GSPro's axis handedness; the size is
    what matters.
    """
    import math

    def geometry(loft: float, side: float) -> float:
        return math.degrees(math.atan(math.tan(math.radians(loft)) * math.sin(math.radians(side))))

    xs: list[list[float]] = []
    ys: list[float] = []
    spots = set()
    for key in sorted({(r["session"], r["spot"]) for r in rows}, key=str):
        items = [r for r in rows if (r["session"], r["spot"]) == key and r["kind"] in ("stock", "stock-repeat")
                 and r["club"] in LOFT and None not in (r["startX"], r["startZ"], r["tdX"], r["tdZ"])
                 and r["hudLeftRightDeg"] is not None]
        if len({r["club"] for r in items}) < 2:
            continue
        bearing = {r["tag"]: math.degrees(math.atan2(r["tdX"] - r["startX"], r["tdZ"] - r["startZ"])) for r in items}
        ref_club = min({r["club"] for r in items}, key=lambda c: LOFT[c])
        ref = med([bearing[r["tag"]] for r in items if r["club"] == ref_club])
        side = items[0]["hudLeftRightDeg"]
        for r in items:
            if r["club"] == ref_club:
                continue
            dev = (bearing[r["tag"]] - ref + 180) % 360 - 180
            xs.append([geometry(LOFT[r["club"]], side) - geometry(LOFT[ref_club], side)])
            ys.append(dev)
            spots.add(key)
    fit = least_squares(xs, ys) if xs else None
    return {
        "shots": len(ys), "spots": len(spots),
        "gain": fit[0][1] if fit else None, "offsetDeg": fit[0][0] if fit else None,
        "r2": fit[1] if fit else None, "loopersPriorGain": 0.5,
    }


def carry_ratios(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Median carry and rest vs fairway, stock shots, per lie x club (outcome check)."""
    stock = [r for r in rows if r["kind"] in ("stock", "stock-repeat") and r["carryYds"]]
    base = {club: med([r["carryYds"] for r in stock if r["club"] == club and r["lie"].startswith("no-penalty:fairway")])
            for club in {r["club"] for r in stock}}
    out: dict[str, dict[str, Any]] = defaultdict(dict)
    for lie in sorted({r["lie"] for r in stock}):
        for club in sorted({r["club"] for r in stock if r["lie"] == lie}, key=club_sort):
            carry = med([r["carryYds"] for r in stock if r["lie"] == lie and r["club"] == club])
            out[lie][club] = {"carry": carry, "ratio": carry / base[club] if base.get(club) and carry else None}
    return dict(out)


def label_check(rows: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        if row["kind"] != "label-check" or row["speed"] is None:
            continue
        label = row.get("gsproClubSelected") or row.get("gsproClub") or "?"
        entry = out.setdefault(label, {f: [] for f in FACTORS} | {"gsproReported": set()})
        for f in FACTORS:
            entry[f].append(row[f])
        if row.get("gsproClub"):
            entry["gsproReported"].add(row["gsproClub"])
    return {label: {f: med(v[f]) for f in FACTORS} | {"n": len(v["speed"]), "gsproReported": sorted(v["gsproReported"])}
            for label, v in out.items()}


def unknown_log_lines(raw_rows: list[dict[str, Any]]) -> list[tuple[str, int]]:
    """Log lines that look relevant but that we don't parse yet, by frequency."""
    counter: Counter[str] = Counter()
    for raw in raw_rows:
        for line in ((raw.get("evidence") or {}).get("log") or {}).get("interestingLines", []):
            if LAUNCH_RE.search(line) or PENALTY_RE.search(line) or TYPE_RE.search(line):
                continue
            if not INTEREST_RE.search(line):
                continue
            # Collapse numbers so repeated lines group together.
            counter[re.sub(r"-?\d+(\.\d+)?", "#", line)[:160]] += 1
    return counter.most_common(30)


# --------------------------------------------------------------------------
# Report

def write_report(out_dir: Path, raw_rows: list[dict[str, Any]]) -> dict[str, Any]:
    rows = [flatten(r) for r in raw_rows]
    out_dir.mkdir(parents=True, exist_ok=True)
    with (out_dir / "shots.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()) if rows else ["tag"])
        writer.writeheader()
        writer.writerows(rows)

    model = {
        "schema": "looper-gspro-lie-model-v1",
        "shots": len(rows),
        "shotsWithPenaltyLine": sum(1 for r in rows if r["speed"] is not None),
        "launchEchoMismatches": sum(
            1 for r in rows if r["logSpeed"] is not None and r["sentSpeed"] is not None
            and abs(r["logSpeed"] - r["sentSpeed"]) > 0.6),
        "factors": factor_tables(rows),
        "randomness": randomness(rows),
        "inputDependence": input_fits(rows),
        "variantEffects": variant_effects(rows),
        "slope": slope_fits(rows),
        "sidehill": sidehill(rows),
        "carryVsFairway": carry_ratios(rows),
        "labelCheck": label_check(rows),
        "unparsedLogLines": unknown_log_lines(raw_rows),
    }
    (out_dir / "lie-model.json").write_text(json.dumps(model, indent=2, default=str), encoding="utf-8")

    md: list[str] = ["# GSPro lie lab summary", ""]
    md.append(f"{model['shots']} shots, {model['shotsWithPenaltyLine']} with a GSPro penalty line. "
              f"Launch echo mismatches: {model['launchEchoMismatches']}.")
    md += ["", "## Penalty factors by lie (median over all shots)", "",
           "| Lie (GSPro name) | Shots | Type code | Speed | Spin | VLA | Speed range | Spin range |",
           "|---|---|---|---|---|---|---|---|"]
    for lie, d in model["factors"].items():
        md.append(f"| {lie} | {d['n']} | {','.join(str(c) for c in d['typeCodes']) or '—'} | "
                  f"{pct(d['overall']['speed'])} | {pct(d['overall']['spin'])} | {pct(d['overall']['vla'])} | "
                  f"{pct(d['overallRange']['speed'])} | {pct(d['overallRange']['spin'])} |")
    for lie, d in model["factors"].items():
        md += ["", f"### {lie} by club", "", "| Club | Shots | Speed | Spin | VLA |", "|---|---|---|---|---|"]
        for club, c in d["perClub"].items():
            md.append(f"| {club} | {c['n']} | {pct(c['speed'])} | {pct(c['spin'])} | {pct(c['vla'])} |")
    md += ["", "## Is the penalty random? (identical shot, same spot)", "",
           "| Lie | Pairs | Max difference | Verdict |", "|---|---|---|---|"]
    for lie, d in model["randomness"].items():
        md.append(f"| {lie} | {d['pairs']} | {pct(d['maxDifference'])} | "
                  f"{'deterministic' if d['deterministic'] else 'varies'} |")
    md += ["", "## How the penalty moves with the launch (all clubs, per lie)", "",
           "factor = a + b·speed(mph) + c·VLA(°) + d·spin(krpm). R² near 0 means the inputs don't explain it.", "",
           "| Lie | Factor | per mph | per ° VLA | per 1000 rpm | R² |", "|---|---|---|---|---|---|"]
    for lie, d in model["inputDependence"].items():
        for f, fit in d["fits"].items():
            md.append(f"| {lie} | {f} | {fit['perMph'] * 100:+.3f} pts | {fit['perDegVla'] * 100:+.3f} pts | "
                      f"{fit['perKrpm'] * 100:+.3f} pts | {fit['r2']:.2f} |")
    if model["variantEffects"]:
        md += ["", "## Variant minus stock, same spot (percentage points)", "",
               "| Lie / variant | n | Speed | Spin | VLA |", "|---|---|---|---|---|"]
        for key, d in model["variantEffects"].items():
            md.append(f"| {key} | {d['n']} | " + " | ".join(
                "—" if d.get(f) is None else f"{d[f] * 100:+.1f}" for f in FACTORS) + " |")
    md += ["", "## Slope (HUD lie angles)", ""]
    if not model["slope"]["byLie"]:
        md.append("No spots with HUD angles entered.")
    else:
        md += ["| Lie | Spots | Speed /° up | Speed /° left | Carry ratio /° up | Carry ratio /° left | R² carry |",
               "|---|---|---|---|---|---|---|"]
        for lie, d in model["slope"]["byLie"].items():
            sp = d.get("speed") or {}
            cr = d.get("carryRatio") or {}
            md.append(f"| {lie} | {d['spots']} | {pts(sp.get('perDegUp'))} | {pts(sp.get('perDegLeft'))} | "
                      f"{pts(cr.get('perDegUp'))} | {pts(cr.get('perDegLeft'))} | {num(cr.get('r2'), 2)} |")
        md.append("")
        md.append("Blank cells: not enough different slopes yet (needs several spots with varied HUD angles).")
    sh = model["sidehill"]
    md += ["", "## Sidehill start-line effect", ""]
    if sh["gain"] is None:
        md.append("Not enough sloped spots with positions yet.")
    else:
        md.append(f"Fitted gain {sh['gain']:+.2f} (Looper's prior: ±0.50) from {sh['shots']} shots at "
                  f"{sh['spots']} spots, R² {sh['r2']:.2f}. Gain near 0 means GSPro ignores side slope.")
    md += ["", "## Carry vs fairway (stock shots)", "", "| Lie | Club | Carry | vs fairway |", "|---|---|---|---|"]
    for lie, clubs in model["carryVsFairway"].items():
        for club, d in clubs.items():
            md.append(f"| {lie} | {club} | {num(d['carry'])} | {pct(d['ratio'])} |")
    if model["labelCheck"]:
        md += ["", "## Club label check (identical shot, different club selected in GSPro)", "",
               "| Club selected | n | Speed | Spin | VLA | GSPro reported |", "|---|---|---|---|---|---|"]
        for label, d in model["labelCheck"].items():
            md.append(f"| {label} | {d['n']} | {pct(d['speed'])} | {pct(d['spin'])} | {pct(d['vla'])} | "
                      f"{', '.join(d['gsproReported']) or '—'} |")
    if model["unparsedLogLines"]:
        md += ["", "## Log lines we don't parse yet (numbers collapsed to #)", ""]
        md += [f"- {count}× `{line}`" for line, count in model["unparsedLogLines"]]
    (out_dir / "summary.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    return model


def main(session_dirs: list[str], out_dir: Path | None = None) -> int:
    dirs = [Path(d) for d in session_dirs]
    raw_rows = load_rows(dirs)
    if not raw_rows:
        print("No shots found.")
        return 1
    out = out_dir or dirs[0]
    model = write_report(out, raw_rows)
    print(f"{model['shots']} shots ({model['shotsWithPenaltyLine']} with penalty lines). "
          f"Wrote {out / 'summary.md'}, {out / 'lie-model.json'}, {out / 'shots.csv'}")
    return 0


if __name__ == "__main__":
    import sys

    sys.exit(main(sys.argv[1:]))
