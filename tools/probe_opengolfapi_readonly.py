#!/usr/bin/env python3
"""Bounded source-comparison probe. Never writes course data, telemetry or keys.

Read-only on staging branch: 3 course searches + up to 3 detail/tees/holes
requests per verified match. Inspects physical tee coordinates separately
from tee names, yardages, and course-center coordinates. Does NOT license or
approve any source for release.
"""
import json
import re
import time
import urllib.parse
import urllib.request
import urllib.error

ROOT = "https://api.opengolfapi.org"
COURSES = [
    ("Valhalla Golf Club", "KY"),
    ("The Golf Club of New England", "NH"),
    ("FarmLinks Golf Course at Pursell Farms", "AL"),
]
HEADERS = {"User-Agent": "TheLooper-SourceAssessment/0.1 (read-only research)",
           "Accept": "application/json"}


def request(path):
    req = urllib.request.Request(ROOT + path, headers=HEADERS, method="GET")
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=13) as response:
            if response.status != 200:
                return {"http": response.status}
            body = response.read(2_000_001)
            if len(body) > 2_000_000:
                return {"http": 200, "error": "response_over_2MB"}
        return {"http": 200, "elapsedMs": round((time.monotonic()-started)*1000),
                "data": json.loads(body)}
    except urllib.error.HTTPError as exc:
        return {"http": exc.code, "error": exc.reason}
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
        return {"error": type(exc).__name__ + ":" + str(exc)[:130]}


def records(obj, field):
    if isinstance(obj, list):
        return obj
    if isinstance(obj, dict):
        for key in (field, "results", "data", "items"):
            if isinstance(obj.get(key), list):
                return obj[key]
            if isinstance(obj.get(key), dict):
                nested = records(obj[key], field)
                if nested:
                    return nested
    return []


def numeric(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def has_gps(value):
    if not isinstance(value, dict):
        return False
    if numeric(value.get("latitude")) and numeric(value.get("longitude")):
        return True
    if numeric(value.get("lat")) and numeric(value.get("lon", value.get("lng"))):
        return True
    if value.get("type") == "Point" and isinstance(value.get("coordinates"), list):
        return len(value["coordinates"]) >= 2 and all(map(numeric, value["coordinates"][:2]))
    for key in ("position", "point", "location", "coordinates", "geometry", "tee"):
        if isinstance(value.get(key), dict) and has_gps(value[key]):
            return True
    return False


def summary(obj, entity):
    entities = records(obj, entity)
    if not entities and isinstance(obj, dict) and obj:
        entities = [obj]
    key_counts = {}
    for row in entities:
        if isinstance(row, dict):
            for k in row:
                key_counts[k] = key_counts.get(k, 0) + 1
    return {
        "count": len(entities),
        "fieldKeys": sorted(key_counts),
        "coordinateEntities": sum(has_gps(x) for x in entities),
        "sampleScalarValues": [
            {k: v for k, v in x.items()
             if k.lower() in ("name", "tee_name", "color", "tee_color", "hole", "number",
                              "yardage", "total_yards", "yards", "rating", "slope", "par",
                              "hole_number") and (v is None or isinstance(v, (str, int, float)))}
            for x in entities[:3] if isinstance(x, dict)
        ],
        "nestedArrays": {k: max(len(x.get(k, [])) for x in entities if isinstance(x, dict))
                         for k in sorted(key_counts)
                         if any(isinstance(x, dict) and isinstance(x.get(k), list) for x in entities)},
    }


def compact(name):
    return re.sub(r"[^a-z0-9]", "", name.lower())


def collect():
    output = {"probe": "opengolfapi-three-course-readonly-v1",
              "commercialApproval": False, "geometryApproval": False,
              "courses": []}
    for name, state in COURSES:
        entry = {"query": name, "state": state, "requested": {}}
        result = request("/v1/courses/search?" + urllib.parse.urlencode(
            {"q": name, "state": state, "limit": 10}))
        entry["requested"]["search"] = {k: v for k, v in result.items() if k != "data"}
        matches = records(result.get("data"), "courses")
        entry["searchCount"] = len(matches)
        entry["searchResults"] = [
            {"name": m.get("course_name", m.get("name")),
             "state": m.get("state"), "idPresent": bool(m.get("id"))}
            for m in matches[:6] if isinstance(m, dict)
        ]
        exact = [
            m for m in matches if isinstance(m, dict)
            and compact(m.get("course_name", m.get("name", ""))) == compact(name)
            and (not m.get("state") or m["state"].upper() == state)
        ]
        if len(exact) != 1 or not exact[0].get("id"):
            entry["decision"] = "no_unique_exact_name_state"
            output["courses"].append(entry)
            continue
        course_id = urllib.parse.quote(str(exact[0]["id"]), safe="")
        entry["matchedName"] = exact[0].get("course_name", exact[0].get("name"))
        entry["courseId"] = course_id
        for part, path in {
            "detail": f"/api/v1/courses/{course_id}",
            "tees": f"/api/v1/courses/{course_id}/tees",
            "holes": f"/api/v1/courses/{course_id}/holes",
        }.items():
            result = request(path)
            # Legacy /v1 is also publicly documented, but retry only on 404.
            if result.get("http") == 404:
                result = request(path.replace("/api/v1/", "/v1/", 1))
            entry["requested"][part] = {k: v for k, v in result.items() if k != "data"}
            if "data" in result:
                entry[part] = summary(result["data"], "courses" if part == "detail" else part)
                if part == "detail" and isinstance(result["data"], dict):
                    entry["detail"]["topLevelKeys"] = sorted(result["data"])
                    if isinstance(result["data"].get("tees"), list):
                        entry["detail"]["teeArray"] = summary(result["data"]["tees"], "tees")
                    if isinstance(result["data"].get("holes"), list):
                        entry["detail"]["holeArray"] = summary(result["data"]["holes"], "holes")
        output["courses"].append(entry)
    return output


if __name__ == "__main__":
    print("OPENGOLF_AUDIT_START")
    print(json.dumps(collect(), sort_keys=True, indent=2))
    print("OPENGOLF_AUDIT_END")
