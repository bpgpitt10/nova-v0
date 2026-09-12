#!/usr/bin/env python3
"""Generate a static GSPro-vs-Looper spatial calibration page.

Diagnostic only. No strategy, recommendations, or GSPro input.

The page scans tee_capture_* folders that already contain:
  - tee_canonical_minimap.png (or tee_heatmap_minimap.png fallback)
  - hole_spatial_model_v1.json

For each hole it places the saved GSPro minimap beside a clean SVG render of the
Looper hole-local model. The goal is visual fidelity review before any strategy
logic is allowed to use the spatial model.
"""
from __future__ import annotations

import argparse
import html
import json
from pathlib import Path
from typing import Any


HAZARD_STYLE = {
    "bunker": ("#d9c58f", "#9d8751"),
    "water": ("#4a9fd8", "#2473a8"),
    "penalty_area": ("#c7544f", "#8f342f"),
    "red_penalty": ("#c7544f", "#8f342f"),
}


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def f(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def find_actual_image(capture: Path) -> Path | None:
    candidates = [
        capture / "tee_canonical_minimap.png",
        capture / "tee_heatmap_minimap.png",
        capture / "tee_initial_minimap.png",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def collect_points(model: dict[str, Any]) -> list[tuple[float, float]]:
    pts: list[tuple[float, float]] = [(0.0, 0.0)]
    transform = model.get("transform") or {}
    pin_yds = f(transform.get("world_xz_tee_to_pin_yds"))
    pts.append((0.0, pin_yds))
    for hazard in model.get("hazards") or []:
        for point in hazard.get("hole_local_yards") or []:
            pts.append((f(point.get("lateral_yds")), f(point.get("forward_yds"))))
    return pts


def view_box(model: dict[str, Any]) -> tuple[float, float, float, float]:
    pts = collect_points(model)
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    # Keep the tee/pin axis visually useful even on sparse par-3 models.
    x_pad = max(18.0, (x1 - x0) * 0.16)
    y_pad = max(12.0, (y1 - y0) * 0.06)
    return x0 - x_pad, y0 - y_pad, x1 + x_pad, y1 + y_pad


def svg_point(x: float, y: float, vb: tuple[float, float, float, float], width: float, height: float) -> tuple[float, float]:
    x0, y0, x1, y1 = vb
    sx = width / max(1e-6, x1 - x0)
    sy = height / max(1e-6, y1 - y0)
    scale = min(sx, sy)
    used_w = (x1 - x0) * scale
    used_h = (y1 - y0) * scale
    ox = (width - used_w) / 2.0
    oy = (height - used_h) / 2.0
    px = ox + (x - x0) * scale
    py = height - (oy + (y - y0) * scale)
    return px, py


def render_hazard(hazard: dict[str, Any], vb: tuple[float, float, float, float], width: float, height: float) -> str:
    raw = hazard.get("hole_local_yards") or []
    if len(raw) < 2:
        return ""
    pts = [svg_point(f(p.get("lateral_yds")), f(p.get("forward_yds")), vb, width, height) for p in raw]
    point_text = " ".join(f"{x:.1f},{y:.1f}" for x, y in pts)
    cls = str(hazard.get("hazard_class") or "unknown").lower()
    fill, stroke = HAZARD_STYLE.get(cls, ("#7c8f78", "#52624f"))
    geom = str(hazard.get("geometry_type") or "polygon").lower()
    source = html.escape(str(hazard.get("source") or "unknown"))
    confidence = hazard.get("confidence")
    title = html.escape(f"{cls} | {source}" + (f" | conf {f(confidence):.2f}" if confidence is not None else ""))
    if "line" in geom:
        return f'<polyline points="{point_text}" fill="none" stroke="{stroke}" stroke-width="3"><title>{title}</title></polyline>'
    return f'<polygon points="{point_text}" fill="{fill}" fill-opacity="0.72" stroke="{stroke}" stroke-width="1.8"><title>{title}</title></polygon>'


def render_model_svg(model: dict[str, Any]) -> str:
    width, height = 520.0, 720.0
    vb = view_box(model)
    transform = model.get("transform") or {}
    pin_forward = f(transform.get("world_xz_tee_to_pin_yds"))
    tee = svg_point(0.0, 0.0, vb, width, height)
    pin = svg_point(0.0, pin_forward, vb, width, height)

    hazards = "".join(render_hazard(h, vb, width, height) for h in model.get("hazards") or [])
    center = f'<line x1="{tee[0]:.1f}" y1="{tee[1]:.1f}" x2="{pin[0]:.1f}" y2="{pin[1]:.1f}" stroke="#d7e5d1" stroke-opacity="0.42" stroke-width="2" stroke-dasharray="7 7" />'

    # Do not invent fairway or green geometry. Those get drawn only when the
    # spatial model actually carries those semantic layers in a later version.
    return f'''<svg class="model-svg" viewBox="0 0 {width:.0f} {height:.0f}" role="img" aria-label="Looper 2-D spatial model">
      <rect width="100%" height="100%" rx="18" fill="#102016" />
      <rect x="16" y="16" width="{width-32:.0f}" height="{height-32:.0f}" rx="14" fill="#173021" stroke="#31563c" />
      {center}
      {hazards}
      <circle cx="{tee[0]:.1f}" cy="{tee[1]:.1f}" r="8" fill="#ffffff" stroke="#0c1510" stroke-width="3"><title>Tee</title></circle>
      <circle cx="{pin[0]:.1f}" cy="{pin[1]:.1f}" r="8" fill="#d6b65d" stroke="#fff3bf" stroke-width="2"><title>Pin</title></circle>
      <text x="20" y="34" fill="#a9baa7" font-size="13">right +  →   |   forward +  ↑</text>
    </svg>'''


def hole_label(model: dict[str, Any], capture: Path) -> str:
    ident = model.get("identity") or {}
    course = str(ident.get("course_name") or ident.get("course_key") or "Unknown course")
    hole = ident.get("hole_display")
    par = ident.get("par")
    parts = [course]
    if hole is not None:
        parts.append(f"Hole {hole}")
    if par is not None:
        parts.append(f"Par {par}")
    parts.append(capture.name)
    return " · ".join(parts)


def make_panel(capture: Path, model: dict[str, Any], page_dir: Path) -> str:
    image = find_actual_image(capture)
    image_html = '<div class="missing">No saved canonical minimap found</div>'
    if image is not None:
        try:
            rel = image.relative_to(page_dir)
            src = rel.as_posix()
        except ValueError:
            src = image.resolve().as_uri()
        image_html = f'<img src="{html.escape(src)}" alt="Saved GSPro minimap" loading="lazy" />'

    match = ((model.get("anchors") or {}).get("match") or {})
    match_error = match.get("distance_error_yds")
    hazard_count = int(model.get("hazard_count") or len(model.get("hazards") or []))
    skipped = len(model.get("skipped_hazards") or [])
    pin_yds = f((model.get("transform") or {}).get("world_xz_tee_to_pin_yds"))
    counts = model.get("hazard_class_counts") or {}
    count_text = ", ".join(f"{html.escape(str(k))}={v}" for k, v in sorted(counts.items())) or "none"

    return f'''<section class="hole-panel">
      <header>
        <div><h2>{html.escape(hole_label(model, capture))}</h2><p>Calibration only · strategy authority OFF</p></div>
        <div class="metrics">
          <span><b>{pin_yds:.1f}</b> yd tee→pin</span>
          <span><b>{hazard_count}</b> hazards</span>
          <span><b>{f(match_error):.2f}</b> yd anchor error</span>
        </div>
      </header>
      <div class="compare-grid">
        <article>
          <div class="pane-title"><strong>GSPro actual</strong><span>saved tee minimap</span></div>
          <div class="canvas actual">{image_html}</div>
        </article>
        <article>
          <div class="pane-title"><strong>Looper render</strong><span>hole-local yards</span></div>
          <div class="canvas">{render_model_svg(model)}</div>
        </article>
      </div>
      <footer>
        <span>Classes: {count_text}</span>
        <span>Skipped hazards: {skipped}</span>
        <span>Fairway/green polygons: <em>not drawn unless modeled</em></span>
      </footer>
    </section>'''


def build_page(output_root: Path, destination: Path) -> tuple[int, int]:
    captures: list[tuple[Path, dict[str, Any]]] = []
    skipped = 0
    for capture in sorted(output_root.glob("tee_capture_*")):
        model_path = capture / "hole_spatial_model_v1.json"
        if not model_path.is_file():
            skipped += 1
            continue
        try:
            captures.append((capture, read_json(model_path)))
        except Exception:
            skipped += 1

    destination.parent.mkdir(parents=True, exist_ok=True)
    panels = "\n".join(make_panel(c, m, destination.parent) for c, m in captures)
    if not panels:
        panels = '<div class="empty">No tee captures with <code>hole_spatial_model_v1.json</code> were found.</div>'

    doc = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Looper Spatial Model Calibration</title>
<style>
:root{{--bg:#0b130e;--card:#112019;--line:#2c4934;--text:#f5f7f4;--muted:#9daf9d;--gold:#d6b65d}}
*{{box-sizing:border-box}} body{{margin:0;background:linear-gradient(180deg,#0b130e,#102016);color:var(--text);font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}}
main{{max-width:1480px;margin:0 auto;padding:28px}} .page-head{{display:flex;justify-content:space-between;gap:24px;align-items:end;margin-bottom:22px}} h1{{font-size:28px;margin:0 0 6px}} .page-head p,p{{color:var(--muted);margin:0}} .badge{{border:1px solid #745f2e;background:#2a2415;color:#f0d98f;border-radius:999px;padding:8px 12px;white-space:nowrap}}
.hole-panel{{background:rgba(17,32,25,.94);border:1px solid var(--line);border-radius:18px;padding:18px;margin:0 0 22px;box-shadow:0 12px 32px rgba(0,0,0,.18)}} .hole-panel header{{display:flex;justify-content:space-between;gap:20px;align-items:start;margin-bottom:14px}} h2{{font-size:17px;margin:0 0 3px}} .metrics{{display:flex;gap:8px;flex-wrap:wrap;justify-content:end}} .metrics span{{background:#182b20;border:1px solid #2b4935;border-radius:10px;padding:7px 9px;color:var(--muted)}} .metrics b{{color:white}}
.compare-grid{{display:grid;grid-template-columns:1fr 1fr;gap:14px}} article{{min-width:0}} .pane-title{{display:flex;justify-content:space-between;align-items:center;margin:0 2px 7px;color:var(--muted)}} .pane-title strong{{color:white}} .canvas{{height:min(68vh,760px);min-height:500px;background:#0d1711;border:1px solid #294532;border-radius:14px;display:flex;align-items:center;justify-content:center;overflow:hidden;padding:10px}} .canvas.actual{{padding:0}} .canvas img{{width:100%;height:100%;object-fit:contain;background:#090d0a}} .model-svg{{height:100%;width:100%;display:block}} footer{{display:flex;gap:14px;flex-wrap:wrap;border-top:1px solid #294532;margin-top:14px;padding-top:11px;color:var(--muted);font-size:12px}} footer em{{color:#c7d3c5;font-style:normal}} .missing,.empty{{color:var(--muted);padding:28px;text-align:center}}
@media(max-width:900px){{main{{padding:14px}} .compare-grid{{grid-template-columns:1fr}} .hole-panel header,.page-head{{display:block}} .metrics{{justify-content:start;margin-top:10px}} .canvas{{height:58vh;min-height:420px}}}}
</style></head><body><main>
<div class="page-head"><div><h1>GSPro actual vs Looper 2-D render</h1><p>Hole-by-hole spatial-model calibration. Compare geometry first; recommendation logic stays frozen.</p></div><div class="badge">Strategy authority OFF</div></div>
{panels}
</main></body></html>'''
    destination.write_text(doc, encoding="utf-8")
    return len(captures), skipped


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-root", type=Path, default=Path(__file__).resolve().parent / "output")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()
    destination = args.out or (args.output_root / "hole_spatial_compare_v1.html")
    count, skipped = build_page(args.output_root.resolve(), destination.resolve())
    print(f"Wrote {destination.resolve()}")
    print(f"Comparison holes: {count}; captures skipped/no spatial model: {skipped}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
