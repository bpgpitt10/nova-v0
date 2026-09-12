#!/usr/bin/env python3
"""Offline Looper 2-D geometry reconstruction review.

This tool is deliberately strategy-free. It consumes existing tee capture artifacts and
builds self-contained Actual / Reconstruction / Overlay HTML pages so extracted geometry
can be judged against the GSPro minimap without hitting new shots or manipulating GSPro.

When hole_spatial_model_v1.json is available, hazard geometry is reconstructed from
hole_local_yards back into minimap pixels through the stored tee/pin basis. The original
stored minimap points remain available as a direct-reference layer, allowing the complete
minimap -> local yards -> minimap round trip to be measured independently from visual CV
accuracy.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import html
import json
import math
import shutil
import zipfile
from collections import Counter
from pathlib import Path
from typing import Any

import cv2

SCHEMA_VERSION = "looper-geometry-review-v1"
STRATEGY_AUTHORITY = False

CLASS_STYLE = {
    "green": {"fill": "#62a85c", "stroke": "#b7ed9f", "dash": ""},
    "bunker": {"fill": "#d9c58f", "stroke": "#fff0c0", "dash": ""},
    "water": {"fill": "#3c8db8", "stroke": "#9bd8f3", "dash": ""},
    "penalty_area": {"fill": "none", "stroke": "#ef5350", "dash": "7 4"},
    "out_of_bounds": {"fill": "none", "stroke": "#f7f7f7", "dash": "5 4"},
    "generic_hazard": {"fill": "#8f7899", "stroke": "#d4b9df", "dash": "4 3"},
    "uncertain": {"fill": "#8f7899", "stroke": "#d4b9df", "dash": "4 3"},
}


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    tmp.replace(path)


def image_data_uri(path: Path) -> str:
    suffix = path.suffix.lower()
    mime = "image/png" if suffix == ".png" else "image/jpeg"
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def image_size(path: Path) -> tuple[int, int]:
    img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise RuntimeError(f"Could not read image: {path}")
    h, w = img.shape[:2]
    return int(w), int(h)


def finite(value: Any) -> float | None:
    try:
        out = float(value)
    except Exception:
        return None
    return out if math.isfinite(out) else None


def point_xy(value: Any) -> tuple[float, float] | None:
    if isinstance(value, dict):
        x, y = finite(value.get("x")), finite(value.get("y"))
    elif isinstance(value, (list, tuple)) and len(value) >= 2:
        x, y = finite(value[0]), finite(value[1])
    else:
        return None
    return (x, y) if x is not None and y is not None else None


def local_to_pixel(transform: dict[str, Any], lateral: float, forward: float) -> tuple[float, float]:
    tee = transform.get("tee_pixel") or {}
    tx, ty = float(tee["x"]), float(tee["y"])
    pfx, pfy = [float(v) for v in transform["pixel_forward_unit"]]
    prx, pry = [float(v) for v in transform["pixel_right_unit"]]
    ypp = float(transform["yards_per_pixel"])
    if ypp <= 0:
        raise ValueError("yards_per_pixel must be > 0")
    px_per_yd = 1.0 / ypp
    return (
        tx + px_per_yd * (forward * pfx + lateral * prx),
        ty + px_per_yd * (forward * pfy + lateral * pry),
    )


def roundtrip_metrics(direct: list[tuple[float, float]], reconstructed: list[tuple[float, float]]) -> dict[str, Any]:
    if not direct or len(direct) != len(reconstructed):
        return {"available": False, "vertex_count": min(len(direct), len(reconstructed))}
    errors = [math.hypot(a[0] - b[0], a[1] - b[1]) for a, b in zip(direct, reconstructed)]
    return {
        "available": True,
        "vertex_count": len(errors),
        "rms_px": math.sqrt(sum(x * x for x in errors) / len(errors)),
        "max_px": max(errors),
        "mean_px": sum(errors) / len(errors),
    }


def bbox_to_points(bbox: Any, width: int, height: int, normalized: bool) -> list[tuple[float, float]]:
    if not isinstance(bbox, (list, tuple)) or len(bbox) < 4:
        return []
    vals = [finite(v) for v in bbox[:4]]
    if any(v is None for v in vals):
        return []
    x0, y0, x1, y1 = [float(v) for v in vals]
    # Geometry contract bboxes historically appear as x0,y0,x1,y1. If an adapter
    # ever emits x,y,w,h with x1/y1 not beyond the origin, retain a sane rectangle.
    if x1 <= x0:
        x1 = x0 + max(0.0, x1)
    if y1 <= y0:
        y1 = y0 + max(0.0, y1)
    if normalized:
        x0, x1 = x0 * width, x1 * width
        y0, y1 = y0 * height, y1 * height
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def representation_points(rep: dict[str, Any], width: int, height: int) -> tuple[list[tuple[float, float]], str]:
    space = str(rep.get("coordinate_space") or "")
    geometry_type = str(rep.get("geometry_type") or "polygon")
    if geometry_type == "bbox":
        pts = bbox_to_points(rep.get("bbox"), width, height, space == "minimap_normalized")
        return pts, "polygon"
    pts = []
    for raw in rep.get("points") or []:
        p = point_xy(raw)
        if p is None:
            continue
        x, y = p
        if space == "minimap_normalized":
            x, y = x * width, y * height
        elif space != "minimap_pixel":
            return [], geometry_type
        pts.append((x, y))
    return pts, geometry_type


def green_contours(capture: Path, hole_model: dict[str, Any]) -> tuple[list[list[tuple[float, float]]], dict[str, Any]]:
    green = hole_model.get("green_surface") or {}
    mask_name = green.get("target_green_mask")
    if not mask_name:
        return [], {"available": False, "warning": "HoleModel has no target green mask reference."}
    mask_path = capture / str(mask_name)
    if not mask_path.is_file():
        return [], {"available": False, "warning": f"Green mask missing: {mask_name}"}
    mask = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
    if mask is None:
        return [], {"available": False, "warning": f"Green mask unreadable: {mask_name}"}
    _, binary = cv2.threshold(mask, 1, 255, cv2.THRESH_BINARY)
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    rows: list[list[tuple[float, float]]] = []
    for contour in contours:
        if cv2.contourArea(contour) < 4:
            continue
        epsilon = max(0.75, 0.004 * cv2.arcLength(contour, True))
        approx = cv2.approxPolyDP(contour, epsilon, True)
        rows.append([(float(p[0][0]), float(p[0][1])) for p in approx])
    rows.sort(key=lambda pts: abs(cv2.contourArea(_cv_contour(pts))), reverse=True)
    return rows, {
        "available": bool(rows),
        "mask_file": str(mask_name),
        "contour_count": len(rows),
        "heatmap_confidence": green.get("heatmap_confidence"),
        "target_green_area_px": green.get("target_green_area_px"),
    }


def _cv_contour(points: list[tuple[float, float]]):
    import numpy as np
    return np.asarray(points, dtype=np.float32).reshape((-1, 1, 2))


def identity_for(capture: Path, spatial: dict[str, Any] | None, hazard_map: dict[str, Any] | None) -> dict[str, Any]:
    if spatial:
        out = dict(spatial.get("identity") or {})
    else:
        out = dict((hazard_map or {}).get("identity") or {})
    context_path = capture / "capture_context.json"
    if context_path.is_file():
        try:
            context = read_json(context_path)
            nested = context.get("identity") if isinstance(context.get("identity"), dict) else {}
            out.setdefault("course_name", context.get("course_name") or nested.get("course_name"))
            out.setdefault("course_key", context.get("course_key") or nested.get("course_key"))
            out.setdefault("round_id", context.get("round_id") or nested.get("round_id"))
            out.setdefault("hole_display", context.get("hole_number") or nested.get("hole_number"))
            out.setdefault("par", context.get("par") or nested.get("par"))
        except Exception:
            pass
    out["capture_id"] = capture.name
    return {k: v for k, v in out.items() if v is not None}


def hazard_layers_from_spatial(spatial: dict[str, Any]) -> list[dict[str, Any]]:
    transform = spatial.get("transform") or {}
    rows: list[dict[str, Any]] = []
    for index, hazard in enumerate(spatial.get("hazards") or []):
        direct = [p for raw in hazard.get("minimap_points_pixel") or [] if (p := point_xy(raw)) is not None]
        local = []
        for raw in hazard.get("hole_local_yards") or []:
            if not isinstance(raw, dict):
                continue
            lat, fwd = finite(raw.get("lateral_yds")), finite(raw.get("forward_yds"))
            if lat is not None and fwd is not None:
                local.append((lat, fwd))
        reconstructed: list[tuple[float, float]] = []
        if transform and local:
            try:
                reconstructed = [local_to_pixel(transform, lat, fwd) for lat, fwd in local]
            except Exception:
                reconstructed = []
        cls = str(hazard.get("hazard_class") or "generic_hazard")
        rows.append({
            "id": str(hazard.get("hazard_key") or f"hazard-{index+1}"),
            "class": cls,
            "geometry_type": str(hazard.get("geometry_type") or "polygon"),
            "source": hazard.get("source"),
            "confidence": hazard.get("confidence"),
            "validation": hazard.get("validation"),
            "direct_points": direct,
            "roundtrip_points": reconstructed,
            "render_points": reconstructed or direct,
            "render_mode": "hole-local-roundtrip" if reconstructed else "direct-minimap",
            "roundtrip": roundtrip_metrics(direct, reconstructed),
        })
    return rows


def hazard_layers_from_shadow(hazard_map: dict[str, Any], width: int, height: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for index, hazard in enumerate(hazard_map.get("hazards") or []):
        primary = hazard.get("primary") or {}
        rep = primary.get("representation") or {}
        points, geometry_type = representation_points(rep, width, height)
        if not points:
            continue
        rows.append({
            "id": str(hazard.get("hazard_key") or f"hazard-{index+1}"),
            "class": str(hazard.get("hazard_class") or "generic_hazard"),
            "geometry_type": geometry_type,
            "source": primary.get("source"),
            "confidence": primary.get("confidence"),
            "validation": primary.get("validation"),
            "direct_points": points,
            "roundtrip_points": [],
            "render_points": points,
            "render_mode": "direct-minimap",
            "roundtrip": {"available": False, "vertex_count": 0},
        })
    return rows


def svg_points(points: list[tuple[float, float]]) -> str:
    return " ".join(f"{x:.2f},{y:.2f}" for x, y in points)


def svg_shape(layer: dict[str, Any], points: list[tuple[float, float]], *, extra_class: str = "") -> str:
    if len(points) < 2:
        return ""
    cls = str(layer.get("class") or "generic_hazard")
    style = CLASS_STYLE.get(cls, CLASS_STYLE["generic_hazard"])
    geom = str(layer.get("geometry_type") or "polygon")
    fill = "none" if geom == "polyline" else style["fill"]
    opacity = "0.54" if fill != "none" else "1"
    common = (
        f'class="geo-layer layer-{html.escape(cls)} {extra_class}" '
        f'data-layer="{html.escape(cls)}" data-object="{html.escape(str(layer.get("id") or ""))}" '
        f'fill="{fill}" fill-opacity="{opacity}" stroke="{style["stroke"]}" stroke-width="2" '
        f'stroke-dasharray="{style["dash"]}" vector-effect="non-scaling-stroke"'
    )
    tag = "polyline" if geom == "polyline" else "polygon"
    return f'<{tag} {common} points="{svg_points(points)}" />'


def anchor_shapes(tee: tuple[float, float] | None, pin: tuple[float, float] | None) -> str:
    bits = []
    if tee:
        bits.append(f'<circle class="geo-layer layer-anchors" data-layer="anchors" cx="{tee[0]:.2f}" cy="{tee[1]:.2f}" r="5" fill="#ffffff" stroke="#111" stroke-width="2" vector-effect="non-scaling-stroke"/>')
    if pin:
        x, y = pin
        bits.append(f'<line class="geo-layer layer-anchors" data-layer="anchors" x1="{x:.2f}" y1="{y+8:.2f}" x2="{x:.2f}" y2="{y-8:.2f}" stroke="#ffffff" stroke-width="2" vector-effect="non-scaling-stroke"/>')
        bits.append(f'<path class="geo-layer layer-anchors" data-layer="anchors" d="M {x:.2f} {y-8:.2f} l 9 4 l -9 4 z" fill="#ffdf55" stroke="#111" stroke-width="1" vector-effect="non-scaling-stroke"/>')
    return "".join(bits)


def render_svg_layers(layers: list[dict[str, Any]], greens: list[list[tuple[float, float]]], tee, pin, mode: str) -> str:
    parts = []
    for idx, pts in enumerate(greens):
        green_layer = {"id": f"green-{idx+1}", "class": "green", "geometry_type": "polygon"}
        parts.append(svg_shape(green_layer, pts))
    for layer in layers:
        pts = layer.get("roundtrip_points") if mode == "roundtrip" and layer.get("roundtrip_points") else layer.get("direct_points")
        parts.append(svg_shape(layer, pts or []))
    parts.append(anchor_shapes(tee, pin))
    return "".join(parts)


def source_label(source: Any) -> str:
    if isinstance(source, dict):
        return str(source.get("kind") or source.get("name") or source.get("source_name") or "unknown")
    return str(source or "unknown")


def confidence_label(confidence: Any) -> str:
    if not isinstance(confidence, dict):
        return "—"
    sem = finite(confidence.get("semantic"))
    geo = finite(confidence.get("geometry"))
    bits = []
    if sem is not None:
        bits.append(f"sem {sem:.2f}")
    if geo is not None:
        bits.append(f"geo {geo:.2f}")
    return ", ".join(bits) or "—"


def render_hole_html(manifest: dict[str, Any], actual_uri: str, greens, layers, tee, pin) -> str:
    w, h = manifest["image"]["width"], manifest["image"]["height"]
    ident = manifest.get("identity") or {}
    hole = ident.get("hole_display", "?")
    course = ident.get("course_name") or ident.get("course_key") or "Unknown course"
    direct_svg = render_svg_layers(layers, greens, tee, pin, "direct")
    roundtrip_svg = render_svg_layers(layers, greens, tee, pin, "roundtrip")
    classes = ["green", *sorted(set(str(x.get("class")) for x in layers)), "anchors"]
    toggles = "".join(
        f'<label><input type="checkbox" data-toggle-layer="{html.escape(cls)}" checked> {html.escape(cls.replace("_", " ").title())}</label>'
        for cls in dict.fromkeys(classes)
    )
    rows = []
    for layer in layers:
        rt = layer.get("roundtrip") or {}
        rt_text = "—"
        if rt.get("available"):
            rt_text = f"{rt.get('rms_px', 0):.3f} RMS / {rt.get('max_px', 0):.3f} max px"
        rows.append(
            "<tr>"
            f"<td>{html.escape(str(layer.get('class')))}</td>"
            f"<td>{html.escape(source_label(layer.get('source')))}</td>"
            f"<td>{html.escape(str(layer.get('geometry_type')))}</td>"
            f"<td>{html.escape(confidence_label(layer.get('confidence')))}</td>"
            f"<td>{html.escape(rt_text)}</td>"
            "</tr>"
        )
    warning_html = "".join(f"<li>{html.escape(str(x))}</li>" for x in manifest.get("warnings") or []) or "<li>None</li>"
    page_key = html.escape(str(manifest.get("capture_id")))
    return f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Looper Geometry Review — {html.escape(str(course))} H{html.escape(str(hole))}</title>
<style>
:root{{--bg:#0d1310;--panel:#151d18;--line:#2a3930;--text:#edf5ef;--muted:#9fb1a6;--accent:#9bd7ad}}
*{{box-sizing:border-box}} body{{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}}
header{{padding:18px 22px;border-bottom:1px solid var(--line);display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}} h1{{font-size:20px;margin:0}} .muted{{color:var(--muted)}}
main{{padding:18px;max-width:1500px;margin:auto}} .toolbar,.card{{background:var(--panel);border:1px solid var(--line);border-radius:12px}}
.toolbar{{padding:12px 14px;margin-bottom:14px;display:flex;gap:18px;align-items:center;flex-wrap:wrap}} .toolbar label{{white-space:nowrap}} input[type=range]{{width:150px}}
.grid{{display:grid;grid-template-columns:repeat(3,minmax(260px,1fr));gap:14px}} .card{{padding:12px}} .card h2{{font-size:15px;margin:0 0 8px}}
.map{{position:relative;width:100%;aspect-ratio:{w}/{h};overflow:hidden;border-radius:8px;background:#17251c;border:1px solid #314339}}
.map img,.map svg{{position:absolute;inset:0;width:100%;height:100%;display:block}} .recon{{background:linear-gradient(#203528,#16261c)}}
.overlay-geometry{{opacity:.72}} .direct-geometry{{display:none}} .map[data-mode="direct"] .direct-geometry{{display:block}} .map[data-mode="direct"] .roundtrip-geometry{{display:none}}
details{{margin-top:14px}} table{{width:100%;border-collapse:collapse}} th,td{{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}} th{{color:var(--muted);font-weight:600}}
.review{{display:grid;grid-template-columns:repeat(3,minmax(180px,1fr));gap:10px;margin-top:10px}} .review label{{display:flex;flex-direction:column;gap:4px;color:var(--muted)}} select,textarea,button{{background:#0f1712;color:var(--text);border:1px solid #3b4b41;border-radius:7px;padding:8px}} textarea{{min-height:78px;grid-column:1/-1}} button{{cursor:pointer}} .status{{color:var(--accent)}}
@media(max-width:900px){{.grid{{grid-template-columns:1fr}} .review{{grid-template-columns:1fr}}}}
</style></head><body>
<header><h1>Looper 2-D Geometry Review</h1><span>{html.escape(str(course))} · Hole {html.escape(str(hole))}</span><span class="muted">strategy authority OFF</span></header>
<main>
<div class="toolbar"><strong>Geometry</strong><label>Mode <select id="mode"><option value="roundtrip">Local-yards round trip</option><option value="direct">Direct extracted pixels</option></select></label><label>Overlay opacity <input id="opacity" type="range" min="0" max="100" value="72"><span id="opacityValue">72%</span></label>{toggles}</div>
<div class="grid">
<section class="card"><h2>1 · GSPro Actual</h2><div class="map"><img src="{actual_uri}" alt="Original GSPro tee minimap"></div></section>
<section class="card"><h2>2 · Looper Reconstruction</h2><div class="map recon mode-map" data-mode="roundtrip"><svg viewBox="0 0 {w} {h}" preserveAspectRatio="none"><g class="direct-geometry">{direct_svg}</g><g class="roundtrip-geometry">{roundtrip_svg}</g></svg></div></section>
<section class="card"><h2>3 · Overlay / Difference</h2><div class="map mode-map" data-mode="roundtrip"><img src="{actual_uri}" alt="Original GSPro tee minimap"><svg class="overlay-geometry" viewBox="0 0 {w} {h}" preserveAspectRatio="none"><g class="direct-geometry">{direct_svg}</g><g class="roundtrip-geometry">{roundtrip_svg}</g></svg></div></section>
</div>
<details open><summary><strong>Geometry inventory</strong> · {len(layers)} hazard objects · {len(greens)} green contour(s)</summary><table><thead><tr><th>Class</th><th>Source</th><th>Geometry</th><th>Confidence</th><th>Round-trip error</th></tr></thead><tbody>{''.join(rows) or '<tr><td colspan="5">No canonical hazard objects available.</td></tr>'}</tbody></table></details>
<details><summary><strong>Warnings</strong></summary><ul>{warning_html}</ul></details>
<section class="card" style="margin-top:14px"><h2>Manual strategic-fidelity review</h2><p class="muted">Judge whether the reconstruction preserves geometry a golfer would care about. Cosmetic differences do not matter.</p>
<div class="review">
<label>Objects / coverage<select data-review="coverage"><option>unreviewed</option><option>pass</option><option>mixed</option><option>fail</option></select></label>
<label>Tee-to-pin orientation<select data-review="orientation"><option>unreviewed</option><option>pass</option><option>uncertain</option><option>fail</option></select></label>
<label>Gross hole shape<select data-review="gross_shape"><option>unreviewed</option><option>pass</option><option>uncertain</option><option>fail</option></select></label>
<label>Hazard position<select data-review="position"><option>unreviewed</option><option>pass</option><option>mixed</option><option>fail</option></select></label>
<label>Hazard size<select data-review="size"><option>unreviewed</option><option>pass</option><option>mixed</option><option>fail</option></select></label>
<label>Hazard shape<select data-review="shape"><option>unreviewed</option><option>pass</option><option>mixed</option><option>fail</option></select></label>
<textarea data-review="notes" placeholder="Missed objects, false objects, major boundary displacement, or anything strategically meaningful..."></textarea>
</div><div style="margin-top:10px;display:flex;gap:10px;align-items:center"><button id="copyReview">Copy review JSON</button><span id="saveStatus" class="status">Saved locally in this browser</span></div></section>
</main>
<script>
const key='looper-geometry-review:{page_key}';
function setMode(v){{document.querySelectorAll('.mode-map').forEach(x=>x.dataset.mode=v)}}
document.getElementById('mode').addEventListener('change',e=>setMode(e.target.value));
const opacity=document.getElementById('opacity'); opacity.addEventListener('input',e=>{{document.querySelectorAll('.overlay-geometry').forEach(x=>x.style.opacity=e.target.value/100);document.getElementById('opacityValue').textContent=e.target.value+'%'}});
document.querySelectorAll('[data-toggle-layer]').forEach(cb=>cb.addEventListener('change',e=>{{const c=e.target.dataset.toggleLayer;document.querySelectorAll('.layer-'+CSS.escape(c)).forEach(x=>x.style.display=e.target.checked?'':'none')}}));
function loadReview(){{try{{const v=JSON.parse(localStorage.getItem(key)||'{{}}');document.querySelectorAll('[data-review]').forEach(x=>{{if(v[x.dataset.review]!==undefined)x.value=v[x.dataset.review]}})}}catch(e){{}}}}
function review(){{const v={{capture_id:{json.dumps(str(manifest.get('capture_id')))},hole:{json.dumps(hole)},course:{json.dumps(str(course))},strategy_authority:false}};document.querySelectorAll('[data-review]').forEach(x=>v[x.dataset.review]=x.value);return v}}
function saveReview(){{localStorage.setItem(key,JSON.stringify(review()));document.getElementById('saveStatus').textContent='Saved locally in this browser'}}
document.querySelectorAll('[data-review]').forEach(x=>x.addEventListener('change',saveReview));document.querySelector('[data-review="notes"]').addEventListener('input',saveReview);
document.getElementById('copyReview').addEventListener('click',async()=>{{const text=JSON.stringify(review(),null,2);try{{await navigator.clipboard.writeText(text);document.getElementById('saveStatus').textContent='Review JSON copied'}}catch(e){{prompt('Copy review JSON',text)}}}});loadReview();
</script></body></html>'''


def build_capture_review(capture: Path, hole_out: Path) -> dict[str, Any]:
    warnings: list[str] = []
    hole_model_path = capture / "hole_model.json"
    if not hole_model_path.is_file():
        raise RuntimeError(f"HoleModel missing: {capture}")
    hole_model = read_json(hole_model_path)
    canonical_name = str(hole_model.get("canonical_minimap") or "tee_heatmap_minimap.png")
    canonical = capture / canonical_name
    if not canonical.is_file():
        raise RuntimeError(f"Canonical minimap missing: {canonical}")
    width, height = image_size(canonical)

    spatial_path = capture / "hole_spatial_model_v1.json"
    shadow_path = capture / "hazard_map_shadow_v0.json"
    spatial = read_json(spatial_path) if spatial_path.is_file() else None
    hazard_map = read_json(shadow_path) if shadow_path.is_file() else None
    if spatial and spatial.get("strategy_authority") is not False:
        warnings.append("Spatial model did not explicitly declare strategy_authority=false; review remains non-authoritative.")
    if spatial:
        layers = hazard_layers_from_spatial(spatial)
        reconstruction_mode = "hole-local-roundtrip"
    elif hazard_map:
        layers = hazard_layers_from_shadow(hazard_map, width, height)
        reconstruction_mode = "direct-minimap-only"
        warnings.append("hole_spatial_model_v1.json missing; showing direct minimap geometry only.")
    else:
        layers = []
        reconstruction_mode = "anchors-and-green-only"
        warnings.append("No spatial model or shadow hazard map; hazard reconstruction unavailable.")

    greens, green_meta = green_contours(capture, hole_model)
    if not green_meta.get("available") and green_meta.get("warning"):
        warnings.append(str(green_meta["warning"]))

    mm = hole_model.get("minimap") or {}
    tee = point_xy(mm.get("ball_pixel"))
    pin = point_xy(mm.get("pin_pixel"))
    if tee is None or pin is None:
        warnings.append("Tee or pin minimap anchor missing.")

    rt_rows = [x.get("roundtrip") or {} for x in layers if (x.get("roundtrip") or {}).get("available")]
    max_rt = max((finite(x.get("max_px")) or 0.0 for x in rt_rows), default=None)
    rms_rt = None
    if rt_rows:
        vals = [float(x["rms_px"]) for x in rt_rows if finite(x.get("rms_px")) is not None]
        rms_rt = math.sqrt(sum(v * v for v in vals) / len(vals)) if vals else None

    manifest = {
        "schema_version": SCHEMA_VERSION,
        "strategy_authority": False,
        "promotion_decision": "none",
        "capture_id": capture.name,
        "identity": identity_for(capture, spatial, hazard_map),
        "image": {"canonical_minimap": canonical_name, "width": width, "height": height},
        "sources": {
            "hole_model": str(hole_model_path),
            "hole_spatial_model": str(spatial_path) if spatial_path.is_file() else None,
            "hazard_map_shadow": str(shadow_path) if shadow_path.is_file() else None,
            "green_mask": green_meta.get("mask_file"),
        },
        "anchors": {"tee_pixel": list(tee) if tee else None, "pin_pixel": list(pin) if pin else None},
        "transform": (spatial or {}).get("transform"),
        "reconstruction_mode": reconstruction_mode,
        "green": green_meta,
        "hazard_count": len(layers),
        "hazard_class_counts": dict(Counter(str(x.get("class")) for x in layers)),
        "roundtrip_summary": {
            "available_hazard_count": len(rt_rows),
            "combined_rms_of_hazard_rms_px": rms_rt,
            "max_vertex_error_px": max_rt,
            "meaning": "transform consistency only; not CV correctness against the GSPro image",
        },
        "layers": [{k: v for k, v in row.items() if k not in {"direct_points", "roundtrip_points", "render_points"}} | {
            "direct_points": [[x, y] for x, y in row.get("direct_points") or []],
            "roundtrip_points": [[x, y] for x, y in row.get("roundtrip_points") or []],
        } for row in layers],
        "warnings": warnings,
        "created_local": dt.datetime.now().isoformat(timespec="seconds"),
    }
    hole_out.mkdir(parents=True, exist_ok=True)
    write_json(hole_out / "manifest.json", manifest)
    actual_uri = image_data_uri(canonical)
    (hole_out / "review.html").write_text(render_hole_html(manifest, actual_uri, greens, layers, tee, pin), encoding="utf-8")
    return manifest


def discover_captures(values: list[str], roots: list[str]) -> list[Path]:
    found: dict[str, Path] = {}
    for raw in values:
        p = Path(raw).expanduser().resolve()
        if p.is_file() and p.name == "hole_model.json":
            p = p.parent
        if (p / "hole_model.json").is_file():
            found[str(p)] = p
    for raw in roots:
        root = Path(raw).expanduser().resolve()
        if not root.exists():
            continue
        for model in root.rglob("hole_model.json"):
            capture = model.parent
            if capture.name.startswith("tee_capture_") or (capture / "tee_capture_meta.json").is_file():
                found[str(capture)] = capture
    return sorted(found.values(), key=lambda p: p.name)


def hole_number(manifest: dict[str, Any]) -> int | None:
    value = (manifest.get("identity") or {}).get("hole_display")
    try:
        return int(value)
    except Exception:
        return None


def render_index(manifests: list[dict[str, Any]], folder_names: dict[str, str]) -> str:
    cards = []
    ordered = sorted(manifests, key=lambda m: (hole_number(m) is None, hole_number(m) or 999, str(m.get("capture_id"))))
    for m in ordered:
        ident = m.get("identity") or {}
        hole = ident.get("hole_display", "?")
        counts = ", ".join(f"{k}:{v}" for k, v in sorted((m.get("hazard_class_counts") or {}).items())) or "no hazards"
        rt = m.get("roundtrip_summary") or {}
        rt_text = "round trip unavailable"
        if rt.get("available_hazard_count"):
            rt_text = f"round-trip max {float(rt.get('max_vertex_error_px') or 0):.3f}px"
        folder = folder_names[str(m.get("capture_id"))]
        cards.append(f'<a class="card" href="{html.escape(folder)}/review.html"><strong>Hole {html.escape(str(hole))}</strong><span>{html.escape(counts)}</span><span>{html.escape(rt_text)}</span><span>{html.escape(str(m.get("reconstruction_mode")))}</span></a>')
    return f'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Looper Geometry Review</title><style>body{{font:15px/1.45 system-ui;background:#0d1310;color:#edf5ef;margin:0}}main{{max-width:1000px;margin:auto;padding:24px}}h1{{margin-bottom:4px}}p{{color:#a7b8ad}}.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}}.card{{background:#151d18;border:1px solid #2a3930;border-radius:12px;padding:14px;color:inherit;text-decoration:none;display:flex;flex-direction:column;gap:4px}}.card:hover{{border-color:#78b78b}}.card span{{color:#9fb1a6;font-size:13px}}</style></head><body><main><h1>Looper 2-D Geometry Review</h1><p>Offline evidence only · Actual vs reconstruction vs overlay · strategy authority OFF</p><div class="grid">{''.join(cards) or '<p>No usable captures.</p>'}</div></main></body></html>'''


def make_zip(run_dir: Path, zip_path: Path) -> None:
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for path in sorted(run_dir.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(run_dir.parent))


def parse_holes(value: str | None) -> set[int] | None:
    if not value:
        return None
    out = set()
    for part in value.split(","):
        part = part.strip()
        if not part:
            continue
        out.add(int(part))
    return out or None


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Build offline Actual / Reconstruction / Overlay reviews from tee captures")
    p.add_argument("--capture-dir", action="append", default=[], help="Exact tee capture directory; repeatable")
    p.add_argument("--capture-root", action="append", default=[], help="Root to search recursively for tee captures; repeatable")
    p.add_argument("--holes", help="Optional comma-separated displayed hole numbers")
    p.add_argument("--output-root", default=str(Path(__file__).resolve().parent / "output"))
    p.add_argument("--no-zip", action="store_true")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    output_root = Path(args.output_root).expanduser().resolve()
    roots = list(args.capture_root) or [str(output_root)]
    captures = discover_captures(args.capture_dir, roots)
    selected_holes = parse_holes(args.holes)
    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    run_dir = output_root / f"geometry_review_{stamp}"
    run_dir.mkdir(parents=True, exist_ok=False)
    manifests: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    folder_names: dict[str, str] = {}

    for capture in captures:
        try:
            # Read identity cheaply before selection when possible.
            spatial_path = capture / "hole_spatial_model_v1.json"
            spatial = read_json(spatial_path) if spatial_path.is_file() else None
            provisional = identity_for(capture, spatial, None)
            h = provisional.get("hole_display")
            if selected_holes is not None:
                try:
                    if int(h) not in selected_holes:
                        continue
                except Exception:
                    continue
            label = f"hole_{int(h):02d}" if h is not None and str(h).isdigit() else capture.name
            if label in folder_names.values():
                label = f"{label}_{len(manifests)+1:02d}"
            manifest = build_capture_review(capture, run_dir / label)
            manifests.append(manifest)
            folder_names[str(manifest["capture_id"])] = label
            print(f"H{(manifest.get('identity') or {}).get('hole_display','?')}: {manifest['reconstruction_mode']} | hazards={manifest['hazard_count']} | warnings={len(manifest['warnings'])}")
        except Exception as exc:
            errors.append({"capture": str(capture), "error": f"{type(exc).__name__}: {exc}"})
            print(f"SKIP {capture.name}: {type(exc).__name__}: {exc}")

    aggregate = {
        "schema_version": SCHEMA_VERSION,
        "strategy_authority": False,
        "promotion_decision": "none",
        "created_local": dt.datetime.now().isoformat(timespec="seconds"),
        "capture_roots": roots,
        "capture_count_discovered": len(captures),
        "review_count": len(manifests),
        "selected_holes": sorted(selected_holes) if selected_holes else None,
        "reviews": manifests,
        "errors": errors,
    }
    write_json(run_dir / "geometry_review_manifest.json", aggregate)
    (run_dir / "index.html").write_text(render_index(manifests, folder_names), encoding="utf-8")

    zip_path = output_root / f"geometry_review_{stamp}.zip"
    if not args.no_zip:
        make_zip(run_dir, zip_path)

    print("\nLooper Geometry Review v1")
    print(f"Review pages: {len(manifests)}")
    print(f"Output: {run_dir}")
    if not args.no_zip:
        print(f"Review ZIP: {zip_path}")
    print("Strategy authority: OFF | Recommendations/clubs: NOT USED")
    if not manifests:
        print("No usable tee captures were found. Point --capture-root at the saved Greywolf tee-capture output.")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
