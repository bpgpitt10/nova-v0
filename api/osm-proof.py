from http.server import BaseHTTPRequestHandler
import json
import time
import urllib.parse
import urllib.request

BBOX = (50.414, -116.295, 50.493, -116.194)
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.nchc.org.tw/api/interpreter",
]


def query_text():
    south, west, north, east = BBOX
    return f'''[out:json][timeout:30];
(
  way["golf"]({south},{west},{north},{east});
  relation["golf"]({south},{west},{north},{east});
);
out tags geom;'''


def geometry_parts(element):
    geometry = element.get("geometry")
    if geometry and len(geometry) > 1:
        return [geometry]
    if element.get("type") == "relation":
        parts = []
        for member in element.get("members", []):
            member_geometry = member.get("geometry")
            if member_geometry and len(member_geometry) > 1:
                parts.append(member_geometry)
        return parts
    return []


def fetch_overpass():
    body = urllib.parse.urlencode({"data": query_text()}).encode("utf-8")
    last_error = None
    for endpoint in ENDPOINTS:
        try:
            request = urllib.request.Request(
                endpoint,
                data=body,
                method="POST",
                headers={
                    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                    "User-Agent": "Looper-OSM-Geometry-Proof/0.1",
                },
            )
            with urllib.request.urlopen(request, timeout=35) as response:
                return endpoint, json.loads(response.read().decode("utf-8"))
        except Exception as exc:
            last_error = exc
    raise RuntimeError(str(last_error) if last_error else "No Overpass endpoint responded")


def normalize(payload):
    features = []
    counts = {}
    unique_elements = {}
    for element in payload.get("elements", []):
        tags = element.get("tags") or {}
        golf = tags.get("golf")
        if not golf:
            continue
        unique_key = f'{element.get("type")}-{element.get("id")}'
        unique_elements[unique_key] = golf
        counts[golf] = counts.get(golf, 0) + 1
        for index, geometry in enumerate(geometry_parts(element)):
            features.append({
                "key": f'{unique_key}-{index}',
                "osmType": element.get("type"),
                "osmId": element.get("id"),
                "golf": golf,
                "name": tags.get("name"),
                "ref": tags.get("ref"),
                "geometry": geometry,
            })
    return features, counts, len(unique_elements)


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        started = time.time()
        try:
            endpoint, payload = fetch_overpass()
            features, counts, unique_count = normalize(payload)
            result = {
                "ok": True,
                "course": "Greywolf Golf Course",
                "bbox": {
                    "south": BBOX[0], "west": BBOX[1],
                    "north": BBOX[2], "east": BBOX[3],
                },
                "source": endpoint,
                "elapsedMs": round((time.time() - started) * 1000),
                "rawElementCount": len(payload.get("elements", [])),
                "uniqueGolfElementCount": unique_count,
                "geometryPartCount": len(features),
                "counts": counts,
                "features": features,
            }
            body = json.dumps(result).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
        except Exception as exc:
            body = json.dumps({
                "ok": False,
                "error": str(exc),
                "elapsedMs": round((time.time() - started) * 1000),
            }).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
