from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import re
import traceback
import zipfile
from collections import Counter, defaultdict, deque
from pathlib import Path
from typing import Any

import gkd_archaeology as gkd

SCHEMA_VERSION = "looper-course-asset-archaeology-v0"
STRATEGY_AUTHORITY = False

LOAD_EXTENSIONS = {".gspcrse", ".unity3d", ".bundle", ".assets", ""}
RESOURCE_EXTENSIONS = {".resource", ".ress"}
INTEREST_EXTENSIONS = LOAD_EXTENSIONS | RESOURCE_EXTENSIONS | {
    ".dat",
    ".bin",
    ".bytes",
    ".asset",
    ".sharedassets",
}
UNITY_MAGICS = (b"UnityFS", b"UnityWeb", b"UnityRaw")
SEMANTIC_GROUPS = {
    "bunker": ("bunker", "sand", "tvgsand", "greensidebunker", "fairwaybunker"),
    "water": ("water", "pond", "lake", "creek", "stream", "river", "ocean", "sea"),
    "penalty": ("penalty", "hazard", "redstake", "yellowstake", "lateralhazard"),
    "out_of_bounds": ("outofbounds", "out_of_bounds", "oob", "boundary"),
    "drop_zone": ("dropzone", "drop_zone", "droppoint", "hasdz"),
    "spline": ("spline", "controlpoint", "bezier", "curve"),
    "green": ("green", "puttinggreen"),
    "fairway": ("fairway",),
    "rough": ("rough",),
    "tee": ("tee", "teebox"),
    "terrain": ("terrain", "mesh", "surface"),
}
SEMANTIC_WEIGHTS = {
    "bunker": 9,
    "water": 9,
    "penalty": 7,
    "out_of_bounds": 7,
    "drop_zone": 6,
    "spline": 4,
    "green": 3,
    "fairway": 2,
    "rough": 2,
    "tee": 2,
    "terrain": 1,
}
GEOMETRY_FIELD_TOKENS = (
    "vertices",
    "vertex",
    "points",
    "point",
    "coords",
    "coordinates",
    "positions",
    "controlpoints",
    "control_points",
    "spline",
    "polygon",
    "polyline",
    "boundary",
    "outline",
    "path",
    "nodes",
    "knots",
    "localposition",
    "position",
    "center",
    "centre",
    "bounds",
    "aabb",
)


def iso_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def nk(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value).lower())


def safe_rel(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root)).replace("\\", "/")
    except Exception:
        return path.name


def read_head(path: Path, n: int = 128) -> bytes:
    try:
        with path.open("rb") as fh:
            return fh.read(n)
    except Exception:
        return b""


def sha256_file(path: Path, sample_limit: int = 512 * 1024 * 1024) -> tuple[str | None, str]:
    try:
        size = path.stat().st_size
        h = hashlib.sha256()
        if size <= sample_limit:
            with path.open("rb") as fh:
                for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                    h.update(chunk)
            return h.hexdigest(), "full"
        sample = 2 * 1024 * 1024
        with path.open("rb") as fh:
            h.update(f"SIZE:{size}|".encode("ascii"))
            h.update(fh.read(sample))
            fh.seek(max(0, size // 2 - sample // 2))
            h.update(fh.read(sample))
            fh.seek(max(0, size - sample))
            h.update(fh.read(sample))
        return h.hexdigest(), "sampled-head-middle-tail"
    except Exception as exc:
        return None, f"error:{type(exc).__name__}:{exc}"


def semantic_hits(text: str) -> dict[str, list[str]]:
    low = text.lower()
    normalized = nk(text)
    hits: dict[str, list[str]] = {}
    for group, tokens in SEMANTIC_GROUPS.items():
        matched = []
        for token in tokens:
            if token.lower() in low or nk(token) in normalized:
                matched.append(token)
        if matched:
            hits[group] = sorted(set(matched))
    return hits


def semantic_score(hits: dict[str, list[str]]) -> int:
    return sum(SEMANTIC_WEIGHTS.get(group, 0) for group in hits)


def extract_printable_strings(data: bytes, min_len: int = 5, limit: int = 1000) -> list[str]:
    out: list[str] = []
    for match in re.finditer(rb"[\x20-\x7e]{%d,}" % min_len, data):
        out.append(match.group(0).decode("ascii", errors="ignore"))
        if len(out) >= limit:
            return out
    if len(out) < limit:
        pattern = rb"(?:[\x20-\x7e]\x00){%d,}" % min_len
        for match in re.finditer(pattern, data):
            try:
                out.append(match.group(0).decode("utf-16-le", errors="ignore"))
            except Exception:
                continue
            if len(out) >= limit:
                break
    return out


def file_inventory(course_root: Path, max_files: int = 50000) -> tuple[list[dict[str, Any]], list[Path]]:
    rows: list[dict[str, Any]] = []
    load_candidates: list[Path] = []
    try:
        paths = sorted((p for p in course_root.rglob("*") if p.is_file()), key=lambda p: str(p).lower())
    except Exception:
        return [], []

    for path in paths[:max_files]:
        ext = path.suffix.lower()
        head = read_head(path)
        magic = next((m.decode("ascii") for m in UNITY_MAGICS if head.startswith(m)), None)
        likely_serialized = magic is not None or ext in LOAD_EXTENSIONS
        resource = ext in RESOURCE_EXTENSIONS
        row: dict[str, Any] = {
            "relative_path": safe_rel(path, course_root),
            "path": str(path),
            "extension": ext,
            "size_bytes": path.stat().st_size,
            "magic_ascii": "".join(chr(b) if 32 <= b < 127 else "." for b in head[:64]),
            "magic_hex": head[:64].hex(),
            "unity_magic": magic,
            "likely_unity_load_target": likely_serialized,
            "resource_sidecar": resource,
        }
        if likely_serialized or resource or ext in INTEREST_EXTENSIONS:
            digest, mode = sha256_file(path)
            row["sha256"] = digest
            row["hash_mode"] = mode
            sample = b""
            try:
                with path.open("rb") as fh:
                    sample = fh.read(min(path.stat().st_size, 2 * 1024 * 1024))
            except Exception:
                pass
            strings = extract_printable_strings(sample, limit=400)
            interesting = [s for s in strings if semantic_score(semantic_hits(s)) > 0]
            row["semantic_strings_preview"] = interesting[:100]
            row["semantic_string_count"] = len(interesting)
        rows.append(row)
        if likely_serialized:
            load_candidates.append(path)
    return rows, load_candidates


def get_attr(obj: Any, *names: str) -> Any:
    for name in names:
        if isinstance(obj, dict) and name in obj:
            return obj[name]
        try:
            if hasattr(obj, name):
                return getattr(obj, name)
        except Exception:
            continue
    return None


def pptr_signature(value: Any) -> dict[str, int] | None:
    file_id = get_attr(value, "m_FileID", "file_id")
    path_id = get_attr(value, "m_PathID", "path_id")
    if isinstance(file_id, int) and isinstance(path_id, int):
        return {"file_id": int(file_id), "path_id": int(path_id)}
    if isinstance(value, dict):
        keys = {nk(k): k for k in value}
        fk = keys.get("mfileid") or keys.get("fileid")
        pk = keys.get("mpathid") or keys.get("pathid")
        if fk and pk and isinstance(value[fk], int) and isinstance(value[pk], int):
            return {"file_id": int(value[fk]), "path_id": int(value[pk])}
    return None


def json_safe(value: Any, depth: int = 0, max_depth: int = 7, item_limit: int = 500) -> Any:
    if depth > max_depth:
        return "<max-depth>"
    if value is None or isinstance(value, (str, int, float, bool)):
        if isinstance(value, str) and len(value) > 10000:
            return value[:10000] + "...<truncated>"
        if isinstance(value, float) and not math.isfinite(value):
            return str(value)
        return value
    ref = pptr_signature(value)
    if ref is not None:
        return {"__pptr__": ref}
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for i, (key, item) in enumerate(value.items()):
            if i >= item_limit:
                out["__truncated_items__"] = len(value) - item_limit
                break
            out[str(key)] = json_safe(item, depth + 1, max_depth, item_limit)
        return out
    if isinstance(value, (list, tuple)):
        out = [json_safe(item, depth + 1, max_depth, item_limit) for item in value[:item_limit]]
        if len(value) > item_limit:
            out.append({"__truncated_items__": len(value) - item_limit})
        return out
    if hasattr(value, "__dict__"):
        try:
            return json_safe(
                {k: v for k, v in vars(value).items() if not str(k).startswith("__") and not callable(v)},
                depth + 1,
                max_depth,
                item_limit,
            )
        except Exception:
            pass
    return repr(value)[:1000]


def collect_refs(value: Any, path: str = "$", max_depth: int = 10, limit: int = 5000) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []

    def walk(item: Any, item_path: str, depth: int) -> None:
        if len(out) >= limit or depth > max_depth:
            return
        sig = pptr_signature(item)
        if sig is not None:
            if sig["path_id"]:
                out.append({"json_path": item_path, **sig})
            return
        if isinstance(item, dict):
            for key, value in item.items():
                walk(value, f"{item_path}.{key}", depth + 1)
        elif isinstance(item, (list, tuple)):
            for i, value in enumerate(item[:2000]):
                walk(value, f"{item_path}[{i}]", depth + 1)
        elif hasattr(item, "__dict__"):
            try:
                walk(vars(item), item_path, depth + 1)
            except Exception:
                return

    walk(value, path, 0)
    seen = set()
    deduped = []
    for ref in out:
        key = (ref["json_path"], ref["file_id"], ref["path_id"])
        if key not in seen:
            seen.add(key)
            deduped.append(ref)
    return deduped


def vector_point(value: Any) -> dict[str, float] | None:
    if not isinstance(value, dict):
        return None
    keys = {nk(k): k for k in value.keys()}
    xk, yk, zk = keys.get("x"), keys.get("y"), keys.get("z")

    def number(key: str | None) -> float | None:
        if not key:
            return None
        raw = value[key]
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            return None
        val = float(raw)
        return val if math.isfinite(val) else None

    x, y, z = number(xk), number(yk), number(zk)
    if x is not None and z is not None:
        result = {"x": x, "z": z}
        if y is not None:
            result["y"] = y
        return result
    return None


def numeric_tuple_point(value: Any) -> dict[str, float] | None:
    if not isinstance(value, (list, tuple)) or not 2 <= len(value) <= 4:
        return None
    nums = []
    for raw in value:
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            return None
        val = float(raw)
        if not math.isfinite(val):
            return None
        nums.append(val)
    if len(nums) == 2:
        return {"x": nums[0], "z": nums[1], "source_axes": "tuple-2d"}
    return {"x": nums[0], "y": nums[1], "z": nums[2]}


def coordinate_sequences(value: Any, object_path_id: int, limit: int = 500) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []

    def walk(item: Any, path: str, key_hint: str, depth: int) -> None:
        if len(found) >= limit or depth > 9:
            return
        key_norm = nk(key_hint)
        geometry_key = any(nk(token) in key_norm for token in GEOMETRY_FIELD_TOKENS)

        if isinstance(item, list) and item and geometry_key:
            points = []
            for entry in item[:100000]:
                point = vector_point(entry) or numeric_tuple_point(entry)
                if point is None:
                    points = []
                    break
                points.append(point)
            if points:
                xs = [p["x"] for p in points]
                zs = [p["z"] for p in points]
                ys = [p["y"] for p in points if "y" in p]
                record: dict[str, Any] = {
                    "object_path_id": object_path_id,
                    "json_path": path,
                    "field": key_hint,
                    "point_count": len(points),
                    "points": points[:5000],
                    "points_truncated": len(points) > 5000,
                    "bounds_xz": {
                        "min_x": min(xs),
                        "max_x": max(xs),
                        "min_z": min(zs),
                        "max_z": max(zs),
                    },
                    "centroid_xz": {"x": sum(xs) / len(xs), "z": sum(zs) / len(zs)},
                    "polygon_candidate": len(points) >= 3,
                    "strategy_authority": False,
                }
                if ys:
                    record["bounds_y"] = {"min_y": min(ys), "max_y": max(ys)}
                found.append(record)
                return

        if isinstance(item, dict):
            point = vector_point(item)
            if point is not None and geometry_key:
                found.append(
                    {
                        "object_path_id": object_path_id,
                        "json_path": path,
                        "field": key_hint,
                        "point_count": 1,
                        "points": [point],
                        "bounds_xz": {
                            "min_x": point["x"],
                            "max_x": point["x"],
                            "min_z": point["z"],
                            "max_z": point["z"],
                        },
                        "centroid_xz": {"x": point["x"], "z": point["z"]},
                        "polygon_candidate": False,
                        "strategy_authority": False,
                    }
                )
                return
            for key, child in item.items():
                walk(child, f"{path}.{key}", str(key), depth + 1)
        elif isinstance(item, list):
            for i, child in enumerate(item[:3000]):
                walk(child, f"{path}[{i}]", key_hint, depth + 1)

    walk(value, "$", "root", 0)
    return found


def materialize_object(obj: Any) -> tuple[Any | None, str | None, list[str]]:
    errors: list[str] = []
    for name in ("parse_as_dict", "read_typetree"):
        fn = getattr(obj, name, None)
        if callable(fn):
            try:
                return fn(), name, errors
            except Exception as exc:
                errors.append(f"{name}:{type(exc).__name__}:{exc}")
    for name in ("parse_as_object", "read"):
        fn = getattr(obj, name, None)
        if callable(fn):
            try:
                return fn(), name, errors
            except Exception as exc:
                errors.append(f"{name}:{type(exc).__name__}:{exc}")
    return None, None, errors


def raw_object_strings(obj: Any, limit_bytes: int = 2 * 1024 * 1024) -> list[str]:
    fn = getattr(obj, "get_raw_data", None)
    if not callable(fn):
        return []
    try:
        raw = bytes(fn())
        if len(raw) > limit_bytes:
            raw = raw[:limit_bytes]
        return extract_printable_strings(raw, limit=500)
    except Exception:
        return []


def name_from_data(data: Any) -> str | None:
    for key in ("m_Name", "name", "Name"):
        value = get_attr(data, key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def object_type_name(obj: Any) -> str:
    typ = getattr(obj, "type", None)
    if typ is None:
        return "Unknown"
    return str(getattr(typ, "name", None) or typ)


def object_path_id(obj: Any) -> int:
    for key in ("path_id", "m_PathID"):
        value = getattr(obj, key, None)
        if isinstance(value, int):
            return int(value)
    return 0


def flatten_strings(value: Any, depth: int = 0) -> list[str]:
    if depth > 6:
        return []
    if isinstance(value, str):
        return [value[:1000]]
    if isinstance(value, dict):
        out = list(map(str, value.keys()))
        for item in list(value.values())[:300]:
            out += flatten_strings(item, depth + 1)
        return out
    if isinstance(value, list):
        out = []
        for item in value[:300]:
            out += flatten_strings(item, depth + 1)
        return out
    return []


def container_labels(env: Any) -> tuple[dict[int, list[str]], list[str]]:
    by_path_id: dict[int, list[str]] = defaultdict(list)
    all_labels: list[str] = []
    container = getattr(env, "container", None)
    if not container:
        return by_path_id, all_labels
    try:
        items = list(container.items())
    except Exception:
        return by_path_id, all_labels
    for label, ref in items[:20000]:
        label = str(label)
        all_labels.append(label)
        sig = pptr_signature(ref)
        if sig and sig["file_id"] == 0 and sig["path_id"]:
            by_path_id[sig["path_id"]].append(label)
    return by_path_id, all_labels


def summarize_unity_file(path: Path, course_root: Path, max_objects: int = 100000) -> dict[str, Any]:
    report: dict[str, Any] = {
        "file": safe_rel(path, course_root),
        "path": str(path),
        "strategy_authority": False,
        "load_ok": False,
        "objects": [],
        "errors": [],
    }
    try:
        import UnityPy  # type: ignore
    except Exception as exc:
        report["errors"].append(f"UnityPy unavailable: {type(exc).__name__}: {exc}")
        return report

    try:
        env = UnityPy.load(str(path))
        report["unitypy_version"] = getattr(UnityPy, "__version__", None)
    except Exception as exc:
        report["errors"].append(f"UnityPy.load: {type(exc).__name__}: {exc}")
        return report

    report["load_ok"] = True
    labels_by_pid, labels = container_labels(env)
    report["container_path_count"] = len(labels)
    report["container_semantic_paths"] = [label for label in labels if semantic_score(semantic_hits(label)) > 0][:1000]

    objects = list(getattr(env, "objects", []))
    if len(objects) > max_objects:
        report["errors"].append(f"object inventory truncated {len(objects)}->{max_objects}")
        objects = objects[:max_objects]

    rows = []
    for obj in objects:
        pid = object_path_id(obj)
        typ = object_type_name(obj)
        data, parse_method, parse_errors = materialize_object(obj)
        raw_strings = raw_object_strings(obj)
        name = name_from_data(data)
        safe = json_safe(data) if data is not None else None
        refs = collect_refs(data) if data is not None else []
        coords = coordinate_sequences(safe, pid) if safe is not None else []
        labels_for_object = labels_by_pid.get(pid, [])
        text_fragments = [typ, name or "", *labels_for_object]
        if safe is not None:
            text_fragments += flatten_strings(safe)
        text_fragments += raw_strings[:200]
        hit_map = semantic_hits(" ".join(text_fragments))
        row: dict[str, Any] = {
            "path_id": pid,
            "type": typ,
            "name": name,
            "container_paths": labels_for_object,
            "parse_method": parse_method,
            "parse_errors": parse_errors,
            "semantic_hits": hit_map,
            "semantic_score_direct": semantic_score(hit_map),
            "references": refs,
            "coordinate_structures": coords,
            "raw_semantic_strings": [s for s in raw_strings if semantic_score(semantic_hits(s)) > 0][:100],
            "strategy_authority": False,
        }
        if safe is not None and (
            row["semantic_score_direct"] > 0
            or typ in {"GameObject", "Material", "Mesh", "MeshFilter", "MeshRenderer", "MonoBehaviour", "MonoScript", "Terrain", "TerrainData", "TextAsset", "Transform"}
        ):
            row["data_preview"] = safe
        rows.append(row)

    report["objects"] = rows
    report["object_count"] = len(rows)
    report["type_counts"] = dict(Counter(row["type"] for row in rows))
    return report


def composite_id(asset_file: str, path_id: int) -> int:
    return int(hashlib.sha1(f"{asset_file}|{path_id}".encode()).hexdigest()[:15], 16)


def build_graph(reports: list[dict[str, Any]]) -> tuple[dict[int, set[int]], dict[int, dict[str, Any]]]:
    graph: dict[int, set[int]] = defaultdict(set)
    by_id: dict[int, dict[str, Any]] = {}
    for report in reports:
        file_key = report.get("file")
        for row in report.get("objects", []):
            pid = row.get("path_id")
            if not isinstance(pid, int) or not pid:
                continue
            cid = composite_id(str(file_key), pid)
            copy = dict(row)
            copy["_composite_id"] = cid
            copy["_asset_file"] = file_key
            by_id[cid] = copy

    index = {(row["_asset_file"], row["path_id"]): cid for cid, row in by_id.items()}
    for cid, row in by_id.items():
        for ref in row.get("references", []):
            if ref.get("file_id") != 0:
                continue
            target = index.get((row["_asset_file"], ref.get("path_id")))
            if target:
                graph[cid].add(target)
                graph[target].add(cid)
    return graph, by_id


def propagate_semantics(reports: list[dict[str, Any]], max_hops: int = 2) -> list[dict[str, Any]]:
    graph, by_id = build_graph(reports)
    seeds = [cid for cid, row in by_id.items() if row.get("semantic_score_direct", 0) >= 4]
    best: dict[int, dict[str, Any]] = {}
    for seed in seeds:
        seed_row = by_id[seed]
        queue = deque([(seed, 0)])
        visited = {seed}
        while queue:
            cid, hops = queue.popleft()
            row = by_id[cid]
            effective = max(1, int(seed_row["semantic_score_direct"]) - hops * 2)
            previous = best.get(cid)
            if previous is None or effective > previous["semantic_score_effective"]:
                best[cid] = {
                    "composite_id": cid,
                    "asset_file": row["_asset_file"],
                    "path_id": row["path_id"],
                    "type": row["type"],
                    "name": row.get("name"),
                    "semantic_score_direct": row.get("semantic_score_direct", 0),
                    "semantic_score_effective": effective,
                    "semantic_hits_direct": row.get("semantic_hits", {}),
                    "seed_asset_file": seed_row["_asset_file"],
                    "seed_path_id": seed_row["path_id"],
                    "seed_type": seed_row["type"],
                    "seed_name": seed_row.get("name"),
                    "seed_semantic_hits": seed_row.get("semantic_hits", {}),
                    "graph_hops": hops,
                    "coordinate_structures": row.get("coordinate_structures", []),
                    "strategy_authority": False,
                }
            if hops >= max_hops:
                continue
            for nxt in graph.get(cid, set()):
                if nxt not in visited:
                    visited.add(nxt)
                    queue.append((nxt, hops + 1))
    return sorted(best.values(), key=lambda item: (-item["semantic_score_effective"], item["asset_file"], item["path_id"]))


def export_candidate_meshes(
    load_paths: list[Path],
    course_root: Path,
    candidates: list[dict[str, Any]],
    out_dir: Path,
    max_exports: int = 200,
    max_obj_mb: float = 20.0,
) -> list[dict[str, Any]]:
    wanted: dict[tuple[str, int], dict[str, Any]] = {}
    for candidate in candidates:
        if str(candidate.get("type")).lower() == "mesh" and candidate.get("semantic_score_effective", 0) >= 4:
            wanted[(candidate["asset_file"], int(candidate["path_id"]))] = candidate
    if not wanted:
        return []

    try:
        import UnityPy  # type: ignore
    except Exception:
        return [{"status": "UnityPy unavailable"}]

    out_dir.mkdir(parents=True, exist_ok=True)
    results: list[dict[str, Any]] = []
    exported = 0
    for path in load_paths:
        rel = safe_rel(path, course_root)
        if not any(asset_file == rel for asset_file, _ in wanted):
            continue
        try:
            env = UnityPy.load(str(path))
        except Exception as exc:
            results.append({"asset_file": rel, "status": f"load-error:{type(exc).__name__}:{exc}"})
            continue
        for obj in getattr(env, "objects", []):
            if exported >= max_exports:
                break
            pid = object_path_id(obj)
            candidate = wanted.get((rel, pid))
            if not candidate:
                continue
            data = None
            for method in ("parse_as_object", "read"):
                fn = getattr(obj, method, None)
                if callable(fn):
                    try:
                        data = fn()
                        break
                    except Exception:
                        pass
            if data is None or not callable(getattr(data, "export", None)):
                results.append({"asset_file": rel, "path_id": pid, "status": "mesh-export-api-unavailable"})
                continue
            try:
                text = data.export()
                raw = text if isinstance(text, bytes) else str(text).encode("utf-8", errors="replace")
                if len(raw) > max_obj_mb * 1024 * 1024:
                    results.append({"asset_file": rel, "path_id": pid, "status": "over-size-cap", "bytes": len(raw)})
                    continue
                name = re.sub(r"[^A-Za-z0-9._-]+", "_", str(candidate.get("name") or "mesh")).strip("._") or "mesh"
                asset_name = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(rel).name)
                file_name = f"{asset_name}__{pid}__{name}.obj"
                dest = out_dir / file_name
                dest.write_bytes(raw)
                exported += 1
                results.append(
                    {
                        "asset_file": rel,
                        "path_id": pid,
                        "name": candidate.get("name"),
                        "status": "exported",
                        "bytes": len(raw),
                        "output": f"candidate_meshes/{file_name}",
                        "seed_semantic_hits": candidate.get("seed_semantic_hits", {}),
                        "strategy_authority": False,
                    }
                )
            except Exception as exc:
                results.append({"asset_file": rel, "path_id": pid, "status": f"export-error:{type(exc).__name__}:{exc}"})
    return results


def make_zip(source_dir: Path, zip_path: Path) -> None:
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for path in sorted(source_dir.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(source_dir.parent))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Read-only GSPro Unity/course-asset archaeology probe")
    parser.add_argument("--locallow")
    parser.add_argument("--gspro-root")
    parser.add_argument("--course-folder")
    parser.add_argument("--asset-file", action="append", default=[])
    parser.add_argument("--output-root", default=str(Path(__file__).resolve().parent / "output"))
    parser.add_argument("--recent-rounds", type=int, default=25)
    parser.add_argument("--max-files", type=int, default=50000)
    parser.add_argument("--max-objects", type=int, default=100000)
    parser.add_argument("--max-mesh-exports", type=int, default=200)
    parser.add_argument("--max-obj-mb", type=float, default=20.0)
    parser.add_argument("--no-mesh-export", action="store_true")
    parser.add_argument("--no-zip", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    output_root = Path(args.output_root).expanduser().resolve()
    run_dir = output_root / f"course_asset_archaeology_{stamp}"
    run_dir.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "started_utc": iso_now(),
        "read_only_intent": True,
        "strategy_authority": False,
        "warnings": [],
        "errors": [],
        "boundaries": [
            "No GSPro keypresses or screen capture.",
            "No VLM/Gemini/SAM calls.",
            "No writes into the GSPro course folder.",
            "Semantic hits are archaeology candidates, not strategy authority.",
        ],
    }

    try:
        locallow = gkd.find_locallow(args.locallow)
        db = gkd.locate_db(locallow)
        ctx = gkd.round_rows(db, args.recent_rounds)
        (run_dir / "round_course_context.json").write_text(json.dumps(ctx, indent=2, default=str), encoding="utf-8")
        rows = ctx.get("rows", [])
        roots = gkd.course_roots(args.gspro_root, rows)
        hints = gkd.course_hints(rows)
        course_root, evidence = gkd.resolve_course(args.course_folder, roots, hints)
        manifest["course_discovery"] = {"selected": str(course_root) if course_root else None, **evidence}
        manifest["locallow"] = str(locallow) if locallow else None
        manifest["gspro_db"] = str(db) if db else None

        if not course_root or not course_root.exists():
            manifest["errors"].append("Course folder could not be resolved.")
            inventory, load_paths = [], []
        else:
            inventory, load_paths = file_inventory(course_root, args.max_files)

        for raw_path in args.asset_file:
            path = Path(raw_path).expanduser()
            if path.exists() and path.is_file() and path not in load_paths:
                load_paths.append(path)

        (run_dir / "asset_inventory.json").write_text(
            json.dumps({"course_root": str(course_root) if course_root else None, "files": inventory}, indent=2, default=str),
            encoding="utf-8",
        )

        reports = []
        if course_root:
            for path in load_paths:
                reports.append(summarize_unity_file(path, course_root, args.max_objects))
        (run_dir / "unity_objects.json").write_text(
            json.dumps({"files": reports, "strategy_authority": False}, indent=2, default=str),
            encoding="utf-8",
        )

        candidates = propagate_semantics(reports)
        (run_dir / "semantic_candidates.json").write_text(
            json.dumps({"candidate_count": len(candidates), "candidates": candidates, "strategy_authority": False}, indent=2, default=str),
            encoding="utf-8",
        )

        geometry = []
        for candidate in candidates:
            for geometry_item in candidate.get("coordinate_structures", []):
                geometry.append(
                    {
                        "asset_file": candidate["asset_file"],
                        "path_id": candidate["path_id"],
                        "type": candidate["type"],
                        "name": candidate.get("name"),
                        "semantic_score_effective": candidate["semantic_score_effective"],
                        "seed_semantic_hits": candidate.get("seed_semantic_hits", {}),
                        **geometry_item,
                        "strategy_authority": False,
                    }
                )
        (run_dir / "geometry_candidates.json").write_text(
            json.dumps({"candidate_count": len(geometry), "geometry": geometry, "strategy_authority": False}, indent=2, default=str),
            encoding="utf-8",
        )

        graph, by_id = build_graph(reports)
        graph_out = [
            {
                "composite_id": cid,
                "asset_file": by_id[cid]["_asset_file"],
                "path_id": by_id[cid]["path_id"],
                "type": by_id[cid]["type"],
                "name": by_id[cid].get("name"),
                "neighbors": sorted(graph.get(cid, set())),
            }
            for cid in sorted(by_id)
        ]
        (run_dir / "reference_graph.json").write_text(
            json.dumps({"objects": graph_out, "strategy_authority": False}, indent=2, default=str),
            encoding="utf-8",
        )

        mesh_exports = []
        if course_root and not args.no_mesh_export:
            mesh_exports = export_candidate_meshes(
                load_paths,
                course_root,
                candidates,
                run_dir / "candidate_meshes",
                args.max_mesh_exports,
                args.max_obj_mb,
            )
        (run_dir / "mesh_exports.json").write_text(json.dumps(mesh_exports, indent=2, default=str), encoding="utf-8")

        summary = {
            "schema_version": SCHEMA_VERSION,
            "course_root": str(course_root) if course_root else None,
            "inventoried_files": len(inventory),
            "unity_load_targets": len(load_paths),
            "unity_load_successes": sum(1 for report in reports if report.get("load_ok")),
            "unity_load_failures": sum(1 for report in reports if not report.get("load_ok")),
            "unity_object_count": sum(int(report.get("object_count", 0)) for report in reports),
            "semantic_candidate_count": len(candidates),
            "geometry_candidate_count": len(geometry),
            "candidate_mesh_exports": sum(1 for item in mesh_exports if item.get("status") == "exported"),
            "top_candidate_classes": dict(Counter(group for candidate in candidates for group in candidate.get("seed_semantic_hits", {}))),
            "strategy_authority": False,
        }
        (run_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
        manifest["summary"] = summary
    except Exception as exc:
        manifest["errors"].append(f"fatal-but-packaged:{type(exc).__name__}:{exc}")
        (run_dir / "exception.txt").write_text(traceback.format_exc(), encoding="utf-8")

    manifest["finished_utc"] = iso_now()
    (run_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, default=str), encoding="utf-8")

    zip_path = output_root / f"course_asset_archaeology_review_{stamp}.zip"
    if not args.no_zip:
        try:
            make_zip(run_dir, zip_path)
        except Exception as exc:
            manifest["errors"].append(f"zip:{type(exc).__name__}:{exc}")

    summary = manifest.get("summary", {})
    print("GSPro Course Asset Archaeology v0")
    print(f"Output: {run_dir}")
    if not args.no_zip:
        print(f"Review ZIP: {zip_path}")
    print(f"Unity load: {summary.get('unity_load_successes', 0)}/{summary.get('unity_load_targets', 0)}")
    print(f"Unity objects: {summary.get('unity_object_count', 0)}")
    print(f"Semantic candidates: {summary.get('semantic_candidate_count', 0)}")
    print(f"Geometry candidates: {summary.get('geometry_candidate_count', 0)}")
    print(f"Candidate mesh exports: {summary.get('candidate_mesh_exports', 0)}")
    if manifest["errors"]:
        print(f"Errors: {len(manifest['errors'])}")
    return 0 if not manifest["errors"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
