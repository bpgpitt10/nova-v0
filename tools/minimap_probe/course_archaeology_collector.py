from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import re
import shutil
import sqlite3
import string
import sys
import traceback
import zipfile
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

SCHEMA_VERSION = "looper-course-archaeology-v0"

# Small files worth preserving verbatim for later remote archaeology.
COPY_EXTENSIONS = {
    ".gkd",
    ".gkdalt",
    ".gkd_bak",
    ".lrs",
    ".lrsv2",
    ".lrsv35",
    ".csv",
    ".json",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
    ".ini",
    ".cfg",
    ".biome",
    ".dat",
}

TEXT_EXTENSIONS = {
    ".csv",
    ".json",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
    ".ini",
    ".cfg",
    ".log",
}

OPAQUE_INTEREST_EXTENSIONS = {
    ".unity3d",
    ".gspcrse",
    ".bundle",
    ".assets",
    ".resource",
    ".resS".lower(),
    ".dat",
    "",
}

COURSE_SIGNAL_RE = re.compile(
    rb"(?i)(bunker|sand|water|hazard|penalty|out.?of.?bounds|\bob\b|green|fairway|rough|spline|terrain|tvg[a-z0-9_]+)"
)

PRINTABLE = set(bytes(string.printable, "ascii"))


def iso_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def safe_stat(path: Path) -> dict[str, Any]:
    try:
        st = path.stat()
        return {
            "size_bytes": st.st_size,
            "modified_utc": dt.datetime.fromtimestamp(st.st_mtime, dt.timezone.utc).isoformat(),
        }
    except Exception as exc:
        return {"stat_error": f"{type(exc).__name__}: {exc}"}


def sanitize_name(text: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", text.strip())
    return cleaned.strip("._") or "unnamed"


def sha256_file(path: Path, max_full_bytes: int) -> tuple[str | None, str]:
    """Return a SHA-256 plus mode. Very large files use deterministic head/middle/tail sampling."""
    try:
        size = path.stat().st_size
        h = hashlib.sha256()
        if size <= max_full_bytes:
            with path.open("rb") as fh:
                for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                    h.update(chunk)
            return h.hexdigest(), "full"

        sample = 1024 * 1024
        with path.open("rb") as fh:
            h.update(f"SIZE:{size}|".encode("ascii"))
            h.update(fh.read(sample))
            middle = max(0, size // 2 - sample // 2)
            fh.seek(middle)
            h.update(fh.read(sample))
            fh.seek(max(0, size - sample))
            h.update(fh.read(sample))
        return h.hexdigest(), "sampled-head-middle-tail"
    except Exception as exc:
        return None, f"error:{type(exc).__name__}:{exc}"


def read_sample(path: Path, sample_bytes: int = 1024 * 1024) -> bytes:
    try:
        size = path.stat().st_size
        if size <= sample_bytes:
            return path.read_bytes()
        piece = max(4096, sample_bytes // 3)
        with path.open("rb") as fh:
            chunks = [fh.read(piece)]
            fh.seek(max(0, size // 2 - piece // 2))
            chunks.append(fh.read(piece))
            fh.seek(max(0, size - piece))
            chunks.append(fh.read(piece))
        return b"\n<<LOOPER_SAMPLE_BREAK>>\n".join(chunks)
    except Exception:
        return b""


def shannon_entropy(data: bytes) -> float | None:
    if not data:
        return None
    counts = Counter(data)
    n = len(data)
    return -sum((count / n) * math.log2(count / n) for count in counts.values())


def extract_strings(data: bytes, min_len: int = 5, max_strings: int = 500) -> list[str]:
    results: list[str] = []
    buf = bytearray()
    for byte in data:
        if byte in PRINTABLE and byte not in (10, 13, 9, 11, 12):
            buf.append(byte)
        else:
            if len(buf) >= min_len:
                results.append(buf.decode("ascii", errors="ignore"))
                if len(results) >= max_strings:
                    return results
            buf.clear()
    if len(buf) >= min_len and len(results) < max_strings:
        results.append(buf.decode("ascii", errors="ignore"))
    return results


def text_preview(path: Path, max_bytes: int = 256 * 1024) -> dict[str, Any]:
    try:
        raw = path.read_bytes()[:max_bytes]
        text = raw.decode("utf-8", errors="replace")
        return {
            "truncated": path.stat().st_size > max_bytes,
            "text": text,
        }
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}


def looks_text_like(path: Path, sample: bytes) -> bool:
    if path.suffix.lower() in TEXT_EXTENSIONS:
        return True
    if not sample:
        return False
    probe = sample[:8192]
    if b"\x00" in probe:
        return False
    printable = sum(1 for b in probe if b in PRINTABLE)
    return printable / max(1, len(probe)) > 0.88


def find_locallow_candidates(explicit: str | None) -> list[Path]:
    out: list[Path] = []
    if explicit:
        out.append(Path(explicit).expanduser())

    userprofile = os.environ.get("USERPROFILE")
    localappdata = os.environ.get("LOCALAPPDATA")
    if userprofile:
        out.extend(
            [
                Path(userprofile) / "AppData" / "LocalLow" / "GSPro" / "GSPro",
                Path(userprofile) / "AppData" / "LocalLow" / "GSPro",
            ]
        )
    if localappdata:
        # LOCALAPPDATA normally points to Local, not LocalLow, but parent traversal is reliable.
        local = Path(localappdata)
        out.append(local.parent / "LocalLow" / "GSPro" / "GSPro")
        out.append(local.parent / "LocalLow" / "GSPro")

    seen: set[str] = set()
    unique: list[Path] = []
    for p in out:
        key = str(p).lower()
        if key not in seen:
            seen.add(key)
            unique.append(p)
    return unique


def score_locallow(path: Path) -> int:
    if not path.exists() or not path.is_dir():
        return -1
    score = 0
    for name, pts in [
        ("GSPro.db", 6),
        ("currentRound.dat", 5),
        ("output_log.txt", 4),
        ("Settings.vgs", 2),
    ]:
        if (path / name).exists():
            score += pts
    return score


def choose_locallow(explicit: str | None) -> tuple[Path | None, list[dict[str, Any]]]:
    candidates = find_locallow_candidates(explicit)
    scored = [{"path": str(p), "score": score_locallow(p)} for p in candidates]
    best = max(scored, key=lambda x: x["score"], default=None)
    if best and best["score"] >= 0:
        return Path(best["path"]), scored
    return None, scored


def locate_db(locallow: Path | None) -> Path | None:
    if not locallow:
        return None
    direct = locallow / "GSPro.db"
    if direct.exists():
        return direct
    try:
        matches = list(locallow.glob("**/GSPro.db"))
        return matches[0] if matches else None
    except Exception:
        return None


def sqlite_snapshot(db_path: Path, out_dir: Path, recent_rows: int = 25) -> dict[str, Any]:
    result: dict[str, Any] = {
        "db_path": str(db_path),
        "captured_utc": iso_now(),
        "tables": {},
        "recent_round_rows": [],
        "errors": [],
    }
    try:
        uri = f"file:{db_path.as_posix()}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=5)
        conn.row_factory = sqlite3.Row
    except Exception as exc:
        result["errors"].append(f"open: {type(exc).__name__}: {exc}")
        return result

    try:
        tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        for table in tables:
            try:
                escaped = table.replace("'", "''")
                cols = [dict(r) for r in conn.execute(f"PRAGMA table_info('{escaped}')")]
                result["tables"][table] = {"columns": cols}
            except Exception as exc:
                result["tables"][table] = {"error": f"{type(exc).__name__}: {exc}"}

        if "Round" in tables:
            col_names = [r[1] for r in conn.execute("PRAGMA table_info('Round')")]
            preferred = [
                "ID",
                "PlayerName",
                "DateCreated",
                "DateModified",
                "CourseCode",
                "CourseName",
                "ActiveHole",
                "RoundStatus",
                "RoundType",
                "NumberOfPlayers",
                "CourseGKD",
            ]
            selected = [c for c in preferred if c in col_names]
            if selected:
                order = "ID DESC" if "ID" in col_names else "rowid DESC"
                sql = f"SELECT {', '.join('[' + c + ']' for c in selected)} FROM [Round] ORDER BY {order} LIMIT ?"
                result["recent_round_rows"] = [dict(r) for r in conn.execute(sql, (recent_rows,))]
    except Exception as exc:
        result["errors"].append(f"query: {type(exc).__name__}: {exc}")
    finally:
        conn.close()

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "gspro_db_snapshot.json").write_text(json.dumps(result, indent=2, default=str), encoding="utf-8")
    return result


def candidate_course_paths_from_db(db_snapshot: dict[str, Any]) -> list[Path]:
    paths: list[Path] = []
    for row in db_snapshot.get("recent_round_rows", []):
        raw = row.get("CourseGKD")
        if isinstance(raw, str) and raw.strip():
            p = Path(raw.strip().strip('"'))
            if p.suffix.lower().startswith(".gkd") or p.name.lower().endswith((".gkd", ".gkdalt", ".gkd_bak")):
                paths.append(p)
            else:
                paths.append(p)
    return paths


def infer_gspro_roots(explicit: str | None, course_paths: list[Path]) -> list[Path]:
    roots: list[Path] = []
    if explicit:
        roots.append(Path(explicit).expanduser())

    for cp in course_paths:
        parts_lower = [x.lower() for x in cp.parts]
        if "core" in parts_lower:
            idx = parts_lower.index("core")
            if idx > 0:
                roots.append(Path(*cp.parts[:idx]))

    roots.extend([Path(r"C:\GSProV1"), Path(r"C:\GSPro")])

    seen: set[str] = set()
    unique: list[Path] = []
    for p in roots:
        key = str(p).lower().rstrip("\\/")
        if key not in seen:
            seen.add(key)
            unique.append(p)
    return unique


def find_courses_dirs(roots: Iterable[Path]) -> list[Path]:
    dirs: list[Path] = []
    for root in roots:
        for rel in [Path("Core") / "GSP" / "Courses", Path("Courses")]:
            p = root / rel
            if p.exists() and p.is_dir():
                dirs.append(p)
    seen: set[str] = set()
    out: list[Path] = []
    for p in dirs:
        key = str(p).lower()
        if key not in seen:
            seen.add(key)
            out.append(p)
    return out


def choose_course_folder(
    explicit: str | None,
    db_snapshot: dict[str, Any],
    course_paths: list[Path],
    courses_dirs: list[Path],
) -> tuple[Path | None, dict[str, Any]]:
    evidence: dict[str, Any] = {"method": None, "candidates": []}

    if explicit:
        p = Path(explicit).expanduser()
        evidence["candidates"].append({"path": str(p), "source": "explicit"})
        if p.exists():
            evidence["method"] = "explicit"
            return p if p.is_dir() else p.parent, evidence

    for p in course_paths:
        evidence["candidates"].append({"path": str(p), "source": "Round.CourseGKD"})
        if p.exists():
            evidence["method"] = "round-coursegkd-existing"
            return p if p.is_dir() else p.parent, evidence

    # Windows DB paths may have been captured on a different drive mapping or be stale.
    # Match the newest row's CourseName against installed course folder names.
    rows = db_snapshot.get("recent_round_rows", [])
    names: list[str] = []
    for row in rows:
        for key in ("CourseName", "CourseCode"):
            raw = row.get(key)
            if isinstance(raw, str) and raw.strip():
                names.append(raw.strip())
        raw_gkd = row.get("CourseGKD")
        if isinstance(raw_gkd, str) and raw_gkd.strip():
            names.append(Path(raw_gkd).parent.name)

    normalized_names = [sanitize_name(n).lower() for n in names]
    for base in courses_dirs:
        try:
            children = [p for p in base.iterdir() if p.is_dir()]
        except Exception:
            continue
        for child in children:
            norm = sanitize_name(child.name).lower()
            score = max((1 if norm == n else 0.5 if n and (n in norm or norm in n) else 0 for n in normalized_names), default=0)
            if score:
                evidence["candidates"].append({"path": str(child), "source": "course-name-match", "score": score})
                if score >= 1:
                    evidence["method"] = "course-name-match"
                    return child, evidence

    evidence["method"] = "not-found"
    return None, evidence


def copy_relevant_file(path: Path, course_root: Path, copy_root: Path, max_copy_bytes: int) -> str | None:
    try:
        if path.stat().st_size > max_copy_bytes:
            return "over-copy-threshold"
        if path.suffix.lower() not in COPY_EXTENSIONS:
            return "extension-not-selected"
        rel = path.relative_to(course_root)
        dest = copy_root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, dest)
        return "copied"
    except Exception as exc:
        return f"copy-error:{type(exc).__name__}:{exc}"


def analyze_course_folder(
    course_root: Path,
    out_dir: Path,
    max_copy_bytes: int,
    max_full_hash_bytes: int,
    max_files: int,
) -> dict[str, Any]:
    inventory: list[dict[str, Any]] = []
    copy_root = out_dir / "course_files_small"
    forensic_root = out_dir / "opaque_forensics"
    forensic_root.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []

    try:
        paths = [p for p in course_root.rglob("*") if p.is_file()]
    except Exception as exc:
        return {"course_root": str(course_root), "files": [], "errors": [f"rglob: {type(exc).__name__}: {exc}"]}

    paths.sort(key=lambda p: str(p).lower())
    if len(paths) > max_files:
        errors.append(f"inventory-truncated: {len(paths)} files > max_files={max_files}")
        paths = paths[:max_files]

    for idx, path in enumerate(paths):
        try:
            rel = str(path.relative_to(course_root)).replace("\\", "/")
        except Exception:
            rel = path.name
        row: dict[str, Any] = {
            "relative_path": rel,
            "extension": path.suffix.lower(),
            **safe_stat(path),
        }
        try:
            with path.open("rb") as fh:
                head = fh.read(64)
            row["magic_hex"] = head.hex()
            row["magic_ascii"] = "".join(chr(b) if 32 <= b < 127 else "." for b in head)
        except Exception as exc:
            row["magic_error"] = f"{type(exc).__name__}: {exc}"

        digest, hash_mode = sha256_file(path, max_full_hash_bytes)
        row["sha256"] = digest
        row["hash_mode"] = hash_mode

        sample = read_sample(path)
        row["sample_bytes"] = len(sample)
        row["sample_entropy_bits_per_byte"] = shannon_entropy(sample)
        strings = extract_strings(sample)
        row["sample_string_count"] = len(strings)
        signals = [s for s in strings if COURSE_SIGNAL_RE.search(s.encode("ascii", errors="ignore"))]
        row["signal_string_count"] = len(signals)
        row["signal_strings_preview"] = signals[:100]

        is_text = looks_text_like(path, sample)
        row["looks_text_like"] = is_text
        if is_text:
            preview = text_preview(path)
            preview_name = sanitize_name(rel.replace("/", "__")) + ".preview.txt"
            text = preview.get("text")
            if isinstance(text, str):
                (forensic_root / preview_name).write_text(text, encoding="utf-8", errors="replace")
                row["text_preview_file"] = f"opaque_forensics/{preview_name}"
                row["text_preview_truncated"] = preview.get("truncated", False)
            elif preview.get("error"):
                row["text_preview_error"] = preview["error"]
        elif path.suffix.lower() in OPAQUE_INTEREST_EXTENSIONS or signals:
            forensic_name = sanitize_name(rel.replace("/", "__")) + ".strings.json"
            forensic_payload = {
                "source_relative_path": rel,
                "sample_strategy": "full if <=1MiB else head-middle-tail totaling ~1MiB",
                "strings": strings,
                "signal_strings": signals,
            }
            (forensic_root / forensic_name).write_text(json.dumps(forensic_payload, indent=2), encoding="utf-8")
            row["forensic_strings_file"] = f"opaque_forensics/{forensic_name}"

        row["copy_status"] = copy_relevant_file(path, course_root, copy_root, max_copy_bytes)
        inventory.append(row)

    ext_counts = Counter(row.get("extension") or "<none>" for row in inventory)
    result = {
        "course_root": str(course_root),
        "captured_utc": iso_now(),
        "file_count": len(inventory),
        "extension_counts": dict(sorted(ext_counts.items())),
        "files": inventory,
        "errors": errors,
    }
    (out_dir / "course_inventory.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def snapshot_runtime_files(locallow: Path | None, out_dir: Path) -> dict[str, Any]:
    result: dict[str, Any] = {"files": [], "errors": []}
    if not locallow:
        return result
    runtime_dir = out_dir / "runtime_snapshot"
    runtime_dir.mkdir(parents=True, exist_ok=True)

    names = ["currentRound.dat", "Settings.vgs", "output_log.txt"]
    for name in names:
        path = locallow / name
        if not path.exists():
            result["files"].append({"name": name, "status": "missing", "path": str(path)})
            continue
        try:
            size = path.stat().st_size
            dest = runtime_dir / name
            # Preserve currentRound and settings whole when modest. Logs are tail-captured to avoid giant ZIPs.
            if name == "output_log.txt" or size > 8 * 1024 * 1024:
                tail_bytes = min(size, 2 * 1024 * 1024)
                with path.open("rb") as fh:
                    fh.seek(max(0, size - tail_bytes))
                    data = fh.read(tail_bytes)
                dest.write_bytes(data)
                mode = f"tail-{tail_bytes}-bytes"
            else:
                shutil.copy2(path, dest)
                mode = "full"
            result["files"].append({"name": name, "status": "captured", "path": str(path), "mode": mode, "size_bytes": size})
        except Exception as exc:
            result["errors"].append(f"{name}: {type(exc).__name__}: {exc}")
    return result


def make_zip(source_dir: Path, zip_path: Path) -> None:
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for path in sorted(source_dir.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(source_dir.parent))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Collect GSPro course archaeology evidence without modifying GSPro.")
    parser.add_argument("--locallow", help="Override GSPro LocalLow data directory")
    parser.add_argument("--gspro-root", help="Override GSPro install root, e.g. C:\\GSProV1")
    parser.add_argument("--course-folder", help="Override active course directory or GKD path")
    parser.add_argument("--output-root", default=str(Path(__file__).resolve().parent / "output"))
    parser.add_argument("--max-copy-mb", type=float, default=16.0)
    parser.add_argument("--max-full-hash-mb", type=float, default=256.0)
    parser.add_argument("--max-files", type=int, default=10000)
    parser.add_argument("--no-zip", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    output_root = Path(args.output_root).expanduser().resolve()
    run_dir = output_root / f"course_archaeology_{stamp}"
    run_dir.mkdir(parents=True, exist_ok=True)

    manifest: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "started_utc": iso_now(),
        "collector": str(Path(__file__).resolve()),
        "read_only_intent": True,
        "arguments": {
            "locallow_override_present": bool(args.locallow),
            "gspro_root_override_present": bool(args.gspro_root),
            "course_folder_override_present": bool(args.course_folder),
            "max_copy_mb": args.max_copy_mb,
            "max_full_hash_mb": args.max_full_hash_mb,
            "max_files": args.max_files,
        },
        "warnings": [],
        "errors": [],
    }

    try:
        locallow, locallow_candidates = choose_locallow(args.locallow)
        manifest["locallow_discovery"] = {
            "selected": str(locallow) if locallow else None,
            "candidates": locallow_candidates,
        }
        if not locallow:
            manifest["warnings"].append("GSPro LocalLow directory was not found automatically.")

        db_path = locate_db(locallow)
        manifest["gspro_db_path"] = str(db_path) if db_path else None
        if db_path:
            db_snapshot = sqlite_snapshot(db_path, run_dir)
        else:
            db_snapshot = {"recent_round_rows": [], "tables": {}, "errors": ["GSPro.db not found"]}
            (run_dir / "gspro_db_snapshot.json").write_text(json.dumps(db_snapshot, indent=2), encoding="utf-8")
            manifest["warnings"].append("GSPro.db was not found; course discovery will rely on overrides/install folders.")

        course_gkd_paths = candidate_course_paths_from_db(db_snapshot)
        gspro_roots = infer_gspro_roots(args.gspro_root, course_gkd_paths)
        courses_dirs = find_courses_dirs(gspro_roots)
        manifest["install_discovery"] = {
            "candidate_roots": [str(p) for p in gspro_roots],
            "courses_dirs": [str(p) for p in courses_dirs],
            "coursegkd_candidates": [str(p) for p in course_gkd_paths],
        }

        course_root, course_evidence = choose_course_folder(args.course_folder, db_snapshot, course_gkd_paths, courses_dirs)
        manifest["course_discovery"] = {
            "selected": str(course_root) if course_root else None,
            **course_evidence,
        }

        manifest["runtime_snapshot"] = snapshot_runtime_files(locallow, run_dir)

        if course_root and course_root.exists():
            manifest["course_inventory_summary"] = analyze_course_folder(
                course_root=course_root,
                out_dir=run_dir,
                max_copy_bytes=int(args.max_copy_mb * 1024 * 1024),
                max_full_hash_bytes=int(args.max_full_hash_mb * 1024 * 1024),
                max_files=args.max_files,
            )
            # Do not duplicate the full per-file inventory inside the manifest.
            manifest["course_inventory_summary"] = {
                k: v for k, v in manifest["course_inventory_summary"].items() if k != "files"
            }
        else:
            manifest["warnings"].append("No active/recent installed course folder was resolved.")
            empty = {"course_root": None, "captured_utc": iso_now(), "file_count": 0, "extension_counts": {}, "files": [], "errors": []}
            (run_dir / "course_inventory.json").write_text(json.dumps(empty, indent=2), encoding="utf-8")

    except Exception as exc:
        manifest["errors"].append(f"fatal-but-packaged: {type(exc).__name__}: {exc}")
        (run_dir / "collector_exception.txt").write_text(traceback.format_exc(), encoding="utf-8")

    manifest["finished_utc"] = iso_now()
    manifest_path = run_dir / "collector_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, default=str), encoding="utf-8")

    zip_path = output_root / f"course_archaeology_review_{stamp}.zip"
    if not args.no_zip:
        try:
            make_zip(run_dir, zip_path)
        except Exception as exc:
            print(f"WARNING: ZIP packaging failed: {type(exc).__name__}: {exc}", file=sys.stderr)
            print(f"Raw output: {run_dir}")
            return 2

    print("GSPro Course Archaeology Collector v0")
    print(f"Output: {run_dir}")
    if args.no_zip:
        print("Review ZIP: skipped (--no-zip)")
    else:
        print(f"Review ZIP: {zip_path}")
    if manifest.get("course_discovery", {}).get("selected"):
        print(f"Course: {manifest['course_discovery']['selected']}")
    else:
        print("Course: NOT RESOLVED (see collector_manifest.json)")
    if manifest["warnings"]:
        print(f"Warnings: {len(manifest['warnings'])}")
    if manifest["errors"]:
        print(f"Errors: {len(manifest['errors'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
