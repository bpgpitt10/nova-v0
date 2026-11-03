"""Read-only GSPro course-library access for the Looper web app.

Finds a course's layout files (<CourseKey>.GKD and its .GKDalt alternate
layouts) in the GSPro course library and returns their text to the browser on
this machine, so the web app no longer needs a folder grant. Nothing is
written, nothing leaves 127.0.0.1, and no paths are returned.

What a GSPro course folder looks like (FarmLinks, from the player's PC):
  farmlinks_al_2_7_gsp.GKD              main layout; file stem = live CourseKey
  Farmlinks Kids.GKDalt                 alternate layout; SceneFolderName = farmlinks_al_2_7_gsp
  farmlinks_al_2_7_gsp-<epoch>.GKD_BAK  old revisions (never read)
  farmlinks_al_2_7_gsp.unity3d, scorecards, splash images, ...

Library roots, first found wins per course:
  1. LOOPER_GSPRO_COURSES_DIR (explicit override; ';'-separated)
  2. a "Courses" folder beside or above the running GSPro executable
  3. the same, for where GSPro was last seen running (so Round Setup works
     with GSPro closed; remembered in the companion's own settings file,
     %LOCALAPPDATA%\\Looper\\Companion\\gspro-location.json, the only write)
  4. <SystemDrive>\\GSProV1\\Courses (the default install)
"""
from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from typing import Iterable

SCHEMA_VERSION = "looper-companion-course-layouts-v1"
MAX_LAYOUT_BYTES = 8 * 1024 * 1024
MAX_LAYOUT_FILES = 12
MAX_FOLDERS_VISITED = 1500
MAX_DEPTH = 2
# Course keys are file stems such as "farmlinks_al_2_7_gsp"; GKDalt stems can
# hold spaces ("Farmlinks Kids"). No separators, no "..", no drive letters.
COURSE_KEY = re.compile(r"[A-Za-z0-9][A-Za-z0-9 _.()'&+-]{0,119}")

_lock = threading.Lock()
_scene_dirs: dict[str, Path] = {}
_texts: dict[tuple[str, int, int], str] = {}


def valid_course_key(key: str | None) -> bool:
    return bool(key) and COURSE_KEY.fullmatch(key) is not None and ".." not in key


def _location_file(environ) -> Path | None:
    override = environ.get("LOOPER_COMPANION_SETTINGS_DIR")
    if override:
        return Path(override) / "gspro-location.json"
    base = environ.get("LOCALAPPDATA")
    return Path(base) / "Looper" / "Companion" / "gspro-location.json" if base else None


def remembered_image_path(environ) -> str | None:
    target = _location_file(environ)
    if target is None:
        return None
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    value = data.get("imagePath") if isinstance(data, dict) else None
    return value if isinstance(value, str) and value.lower().endswith(".exe") else None


def remember_image_path(image_path: str, environ) -> None:
    if remembered_image_path(environ) == image_path:
        return
    target = _location_file(environ)
    if target is None:
        return
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(".tmp")
        tmp.write_text(json.dumps({"imagePath": image_path}), encoding="utf-8")
        os.replace(tmp, target)
    except OSError:
        pass  # remembering is a convenience only


def library_roots(
    *,
    image_path: str | None = None,
    env: dict | None = None,
) -> list[tuple[str, Path]]:
    environ = os.environ if env is None else env
    roots: list[tuple[str, Path]] = []
    for part in (environ.get("LOOPER_GSPRO_COURSES_DIR") or "").split(";"):
        if part.strip():
            roots.append(("override", Path(part.strip())))
    if image_path:
        remember_image_path(image_path, environ)
    for label, exe in (("beside-gspro", image_path), ("last-gspro", remembered_image_path(environ))):
        if not exe:
            continue
        here = Path(exe).parent
        for ancestor in [here, *list(here.parents)[:4]]:
            roots.append((label, ancestor / "Courses"))
    drive = environ.get("SystemDrive") or "C:"
    roots.append(("default-install", Path(f"{drive}\\") / "GSProV1" / "Courses"))
    out, seen = [], set()
    for label, path in roots:
        key = os.path.normcase(os.path.abspath(str(path)))
        if key not in seen:
            seen.add(key)
            out.append((label, path))
    return out


def _entries(path: Path) -> tuple[list[str], list[Path]]:
    files, dirs = [], []
    try:
        with os.scandir(path) as it:
            for entry in it:
                try:
                    if entry.is_file():
                        files.append(entry.name)
                    elif entry.is_dir() and not entry.name.startswith((".", "$")):
                        dirs.append(Path(entry.path))
                except OSError:
                    continue
    except OSError:
        pass
    return files, dirs


def _holds(files: Iterable[str], key: str) -> bool:
    wanted = {f"{key.lower()}.gkd", f"{key.lower()}.gkdalt"}
    return any(name.lower() in wanted for name in files)


def find_scene_dir(roots: list[tuple[str, Path]], key: str, max_visited: int = MAX_FOLDERS_VISITED):
    """(label, folder) of the first course folder holding <key>.GKD/.GKDalt."""
    visited = 0
    for label, root in roots:
        if not root.is_dir():
            continue
        queue: list[tuple[Path, int]] = [(root, 0)]
        while queue and visited < max_visited:
            folder, depth = queue.pop(0)
            visited += 1
            files, dirs = _entries(folder)
            if _holds(files, key):
                return label, folder
            if depth >= MAX_DEPTH:
                continue
            named = [d for d in dirs if d.name.lower() == key.lower()]
            others = sorted((d for d in dirs if d not in named), key=lambda d: d.name.lower())
            queue[:0] = [(d, depth + 1) for d in named]
            queue.extend((d, depth + 1) for d in others)
    return None


def _read_text(path: Path, stat: os.stat_result) -> str:
    cache_key = (os.path.normcase(str(path)), stat.st_mtime_ns, stat.st_size)
    with _lock:
        cached = _texts.get(cache_key)
    if cached is not None:
        return cached
    text = path.read_bytes().decode("utf-8-sig")
    with _lock:
        _texts[cache_key] = text
    return text


def read_scene_layouts(folder: Path, scene_key: str) -> list[dict]:
    """The scene's main GKD and every GKDalt naming that scene (no GKD_BAK)."""
    files, _ = _entries(folder)
    out = []
    for name in sorted(files, key=lambda n: (not n.lower().endswith(".gkd"), n.lower())):
        lower = name.lower()
        kind = "main" if lower.endswith(".gkd") else "alt" if lower.endswith(".gkdalt") else None
        if kind is None:
            continue
        stem = name.rsplit(".", 1)[0]
        if kind == "main" and stem.lower() != scene_key.lower():
            continue
        path = folder / name
        try:
            stat = path.stat()
            if stat.st_size > MAX_LAYOUT_BYTES:
                continue
            text = _read_text(path, stat)
        except (OSError, UnicodeDecodeError):
            continue
        if kind == "alt":
            try:
                scene = json.loads(text).get("SceneFolderName")
            except (ValueError, AttributeError):
                continue
            if scene and str(scene).lower() != scene_key.lower():
                continue
        out.append({
            "fileName": name,
            "kind": kind,
            "size": stat.st_size,
            "lastModified": stat.st_mtime_ns // 1_000_000,
            "text": text,
        })
        if len(out) >= MAX_LAYOUT_FILES:
            break
    return out


def course_layouts(course_key: str | None, *, image_path: str | None = None, env: dict | None = None) -> dict:
    """Browser payload: layout files for one course. No paths."""
    base = {"service": "looper-companion", "schemaVersion": SCHEMA_VERSION, "courseKey": course_key}
    if not valid_course_key(course_key):
        return {**base, "status": "invalid-request", "layouts": []}
    key = course_key.lower()
    with _lock:
        known = _scene_dirs.get(key)
    found = None
    if known is not None and _holds(_entries(known)[0], course_key):
        found = ("cached", known)
    if found is None:
        roots = library_roots(image_path=image_path, env=env)
        found = find_scene_dir(roots, course_key)
        if found is None:
            searched = sorted({label for label, path in roots if path.is_dir()})
            return {**base, "status": "not-found", "searchedRoots": searched, "layouts": []}
        with _lock:
            _scene_dirs[key] = found[1]
    label, folder = found
    layouts = read_scene_layouts(folder, course_key)
    if not layouts:
        return {**base, "status": "not-found", "searchedRoots": [label], "layouts": []}
    return {**base, "status": "ready", "source": label, "layouts": layouts}


def clear_caches() -> None:
    with _lock:
        _scene_dirs.clear()
        _texts.clear()


LIBRARY_SCHEMA_VERSION = "looper-companion-course-library-v1"
MAX_LIBRARY_COURSES = 2000


def _header(path: Path) -> dict | None:
    """CourseName / Location / hole count from a GKD or GKDalt (cached by mtime/size)."""
    try:
        stat = path.stat()
        if stat.st_size > MAX_LAYOUT_BYTES:
            return None
        raw = json.loads(_read_text(path, stat))
    except (OSError, UnicodeDecodeError, ValueError):
        return None
    if not isinstance(raw, dict) or not isinstance(raw.get("Holes"), list):
        return None
    return {
        "courseName": str(raw.get("CourseName") or "")[:120],
        "location": str(raw.get("Location") or "")[:120],
        "designer": str(raw.get("Designer") or "")[:80],
        "holes": len(raw["Holes"]),
        "sceneFolderName": raw.get("SceneFolderName"),
    }


def list_installed_courses(*, image_path: str | None = None, env: dict | None = None) -> dict:
    """Every course in the GSPro library: key (main GKD stem), name, location,
    hole count and alternate layout names. No paths, no geometry."""
    roots = library_roots(image_path=image_path, env=env)
    courses: dict[str, dict] = {}
    alternates: list[tuple[str, str]] = []
    searched = []
    for label, root in roots:
        if not root.is_dir():
            continue
        searched.append(label)
        queue: list[tuple[Path, int]] = [(root, 0)]
        visited = 0
        while queue and visited < MAX_FOLDERS_VISITED * 4 and len(courses) < MAX_LIBRARY_COURSES:
            folder, depth = queue.pop(0)
            visited += 1
            files, dirs = _entries(folder)
            for name in files:
                lower = name.lower()
                if lower.endswith(".gkd"):
                    key = name[:-4]
                    if key.lower() in courses:
                        continue
                    header = _header(folder / name)
                    if header:
                        courses[key.lower()] = {"courseKey": key, **{k: v for k, v in header.items() if k != "sceneFolderName"},
                                                "alternateLayouts": []}
                elif lower.endswith(".gkdalt"):
                    header = _header(folder / name)
                    if header and header.get("sceneFolderName"):
                        alternates.append((str(header["sceneFolderName"]).lower(), name[:-7]))
            if depth < MAX_DEPTH:
                queue.extend((d, depth + 1) for d in sorted(dirs, key=lambda d: d.name.lower()))
        if courses:
            break  # first library root that has courses wins
    for scene, alt in alternates:
        if scene in courses and alt not in courses[scene]["alternateLayouts"]:
            courses[scene]["alternateLayouts"].append(alt)
    listed = sorted(courses.values(), key=lambda c: (c["courseName"] or c["courseKey"]).lower())
    return {"service": "looper-companion", "schemaVersion": LIBRARY_SCHEMA_VERSION,
            "status": "ready" if listed else "not-found", "searchedRoots": searched,
            "courses": listed}
