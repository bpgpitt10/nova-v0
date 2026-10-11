#!/usr/bin/env python3
"""Resolve a *user-entered name* into an exact OSM course boundary.

No course-specific assumptions; ambiguous or missing OSM matches fail closed.
Uses only one name-search request to the official Nominatim endpoint, with
attribution and a descriptive User-Agent. Not a bulk discovery crawler.
"""
import argparse
import json
import re
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


API = "https://nominatim.openstreetmap.org/search"
UA = "TheLooperCoursePilot/1.0 (single user course lookup; thelooper.golf)"
def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00","Z")
def norm(s):
    return " ".join(re.sub(r"[^a-z0-9]+"," ",str(s).casefold()).split())
def norm_course(s):
    return " ".join(token for token in norm(s).split() if token not in {"golf","course","club","at","the"})
def slugify(s):
    raw = "-".join(norm(s).split())
    return raw[:70].strip("-")
def is_golf_boundary(x):
    osm_type=str(x.get("osm_type") or "").lower()
    tags=x.get("extratags") or {}
    return osm_type in {"way","relation"} and bool(x.get("osm_id")) and (
        (x.get("category")=="leisure" and x.get("type")=="golf_course")
        or x.get("type")=="golf_course"
        or tags.get("leisure")=="golf_course"
        or tags.get("golf")=="course"
    )

def name_matches(requested, candidate):
    source=norm_course(requested).split()
    target=norm_course(candidate).split()
    # A shortened product name can be a prefix of the full official golf-club
    # name, but a location or irrelevant suffix cannot be silently dropped.
    return bool(source) and (target==source or (len(source)>=2 and target[:len(source)]==source))

def get_candidates(name, timeout=25):
    queries=[name, f"{name} golf course", f"{name} golf club"]
    seen=set()
    candidates=[]
    for i, query in enumerate(queries):
        if i:
            time.sleep(1.2) # OSMF's public Nominatim max 1 request/sec.
        params=urllib.parse.urlencode({"q":query,"format":"jsonv2","addressdetails":1,"namedetails":1,"extratags":1,"limit":10})
        request=urllib.request.Request(API+"?"+params, headers={"User-Agent":UA,"Accept":"application/json"})
        with urllib.request.urlopen(request,timeout=timeout) as resp:
            returned=json.load(resp)
        print("Nominatim query:",json.dumps({"text":query,"results":len(returned)}),flush=True)
        for item in returned:
            key=(item.get("osm_type"),item.get("osm_id"))
            if key not in seen:
                seen.add(key)
                candidates.append(item)
        if any(is_golf_boundary(x) and name_matches(
            name,(x.get("namedetails") or {}).get("name") or str(x.get("display_name","")).split(",")[0]
        ) for x in candidates):
            break
    return candidates

PHOTON_API = "https://photon.komoot.io/api/"
OSM_CORE_MAP = "https://api.openstreetmap.org/api/0.6/map"

def location_candidates(name, timeout=25):
    """One bounded Photon place lookup; reject generic non-golf POIs."""
    query = name if "golf" in norm(name).split() else name + " golf club"
    params = urllib.parse.urlencode({"q": query, "limit": 10, "lang": "en"})
    request = urllib.request.Request(PHOTON_API + "?" + params, headers={
        "User-Agent": UA, "Accept": "application/json"
    })
    with urllib.request.urlopen(request, timeout=timeout) as resp:
        data = json.load(resp)
    found = []
    for item in data.get("features", []):
        props = item.get("properties") or {}
        coordinate = (item.get("geometry") or {}).get("coordinates") or []
        if len(coordinate) < 2:
            continue
        label = str(props.get("name") or "")
        # Accept golf-related place features, but never trust them as source geometry.
        if not name_matches(name, label):
            continue
        golf = (props.get("osm_key") == "leisure" and props.get("osm_value") == "golf_course")
        if not golf and not ("golf" in norm(label).split() and props.get("osm_key") in {"leisure", "sport"}):
            continue
        try:
            lon, lat = float(coordinate[0]), float(coordinate[1])
        except (ValueError, TypeError):
            continue
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            continue
        found.append({"label": label, "lat": lat, "lon": lon, "city": props.get("city") or props.get("county"),
                      "state": props.get("state") or props.get("country"), "osm_id": props.get("osm_id")})
    print("Photon geographic candidates:", json.dumps(found), flush=True)
    return found

def nearby_osm_course_boundaries(lat, lon, timeout=45):
    """Read a single bounded OSM map tile near the geocoded golf venue."""
    import xml.etree.ElementTree as ET
    import math
    lat_delta = 2.5 / 111.2
    lon_delta = 2.5 / (111.2 * max(0.3, math.cos(math.radians(lat))))
    bounds = [lon-lon_delta, lat-lat_delta, lon+lon_delta, lat+lat_delta]
    url = OSM_CORE_MAP + "?" + urllib.parse.urlencode({
        "bbox": ",".join(f"{v:.6f}" for v in bounds)
    })
    request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/xml"})
    with urllib.request.urlopen(request, timeout=timeout) as resp:
        root = ET.fromstring(resp.read())
    output = []
    for element in root:
        if element.tag not in {"way", "relation"}:
            continue
        tags = {x.get("k"): x.get("v") for x in element.findall("tag")}
        if tags.get("leisure") != "golf_course":
            continue
        if not tags.get("name"):
            continue
        output.append({"osm_type": element.tag, "osm_id": int(element.attrib["id"]),
                       "category": "leisure", "type": "golf_course",
                       "namedetails": {"name": tags["name"]},
                       "display_name": tags["name"],
                       "extratags": {"leisure": "golf_course"},
                       "lat": lat, "lon": lon})
    return output

def geographically_resolve(name, timeout=25):
    """Only unambiguous geocoded venues and exact named OSM boundaries qualify."""
    sites = location_candidates(name, timeout)
    unique_sites = list({(round(site["lat"], 4), round(site["lon"], 4)): site for site in sites}.values())
    if len(unique_sites) != 1:
        raise ValueError(f"Geographic fallback located {len(unique_sites)} plausible golf venues for {name!r}; refusing an ambiguous or unlocated import")
    site = unique_sites[0]
    boundaries = nearby_osm_course_boundaries(site["lat"], site["lon"], timeout=max(timeout, 45))
    matching = [b for b in boundaries if name_matches(name, b["namedetails"]["name"])]
    if len(matching) != 1:
        raise ValueError(f"Golf venue located at {site['lat']:.5f},{site['lon']:.5f}, "
                         f"but {len(matching)} matching OSM course boundaries found; cannot import without geometry")
    candidate = matching[0]
    # Use independent place service for location only, core OSM for the authoritative boundary.
    candidate["address"] = {"city": site["city"], "state": site["state"]}
    print("Spatial boundary confirmed:", json.dumps({"name": candidate["namedetails"]["name"],
        "type":candidate["osm_type"],"id":candidate["osm_id"],"location":site}), flush=True)
    return [candidate]

def resolve(name, candidates):
    valid=[]
    raw_summaries=[{"name":(x.get("namedetails") or {}).get("name"),"display":str(x.get("display_name") or "")[:160],"category":x.get("category"),"type":x.get("type"),"osm_type":x.get("osm_type"),"osm_id":x.get("osm_id"),"extratags":{k:v for k,v in (x.get("extratags") or {}).items() if k in {"golf","leisure"}}} for x in candidates]
    print("Nominatim candidate classifications:",json.dumps(raw_summaries,ensure_ascii=True),flush=True)
    for x in candidates:
        if not is_golf_boundary(x): continue
        named=(x.get("namedetails") or {}).get("name") or str(x.get("display_name","")).split(",")[0]
        valid.append((x,named))
    hits=[item for item in valid if name_matches(name,item[1])]
    if len(hits)!=1:
        hints=[{"name":label,"osmType":x.get("osm_type"),"osmId":x.get("osm_id"),"place":x.get("display_name")} for x,label in (hits or valid)]
        raise ValueError(f"Expected exactly one exact-match mapped golf course for {name!r}; found {len(hits)}. Accepted: {json.dumps(hints)[:2000]}; raw: {json.dumps(raw_summaries)[:2500]}")
    x,named=hits[0]
    addr=x.get("address") or {}
    place=addr.get("city") or addr.get("town") or addr.get("village") or addr.get("county") or ""
    region=addr.get("state") or addr.get("region") or addr.get("country") or ""
    location=", ".join(str(part) for part in [place,region] if part) or str(x.get("display_name","")).split(",",1)[-1].strip()
    slug=slugify(named)
    if not slug: raise ValueError("Resolved course name has no safe slug")
    config={
       "schemaVersion":"looper-course-build-config-v1",
       "courseId":slug+"-"+slugify(location)[:35].strip("-"),
       "courseName":named,
       "location":location,
       "slug":slug,
       "gsproAliases":list(dict.fromkeys([name.strip(),named.strip()])),
       "osmCourseElement":{"type":str(x["osm_type"]).lower(),"id":int(x["osm_id"])},
       "osmCenter":[float(x["lat"]),float(x["lon"])],
       "terrain":{"provider":"auto"},
       "landcoverContext":{"enabled":True,"provider":"ESA WorldCover 2021 v200"},
       "greenTerrain":{"enabled":True}
    }
    return config

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--name",required=True)
    parser.add_argument("--requested-at",default="")
    parser.add_argument("--config-directory",type=Path,default=Path("config/course-geometry"))
    parser.add_argument("--rebuild-request",type=Path,default=Path("config/course-rebuild-request.json"))
    parser.add_argument("--discovery-audit",type=Path,default=Path("artifacts/course-discovery-v1.json"))
    parser.add_argument("--fixture",type=Path,help="Only for offline tests; never use in live workflow")
    args=parser.parse_args()
    name=args.name.strip()
    started=time.monotonic()
    audit={"schemaVersion":"looper-course-discovery-v1","requestedName":name,
           "requestedAt":args.requested_at or None,"source":"OSM Nominatim name search; Photon place fallback; exact OSM core spatial boundary"}
    try:
        if len(name)<3 or len(name)>120:
            raise ValueError("Course name must contain 3-120 characters")
        candidates=json.loads(args.fixture.read_text()) if args.fixture else get_candidates(name)
        audit["candidateCount"]=len(candidates)
        try:
            config=resolve(name,candidates)
            audit["discoveryMethod"]="osm-name"
        except ValueError as name_error:
            # Fixture tests are deterministic, and ambiguity is not authority
            # to select a different course via fuzzy geography.
            if args.fixture:
                raise
            raw_matches=[
                x for x in candidates
                if is_golf_boundary(x) and name_matches(name,(x.get("namedetails") or {}).get("name") or str(x.get("display_name","")).split(",")[0])
            ]
            if raw_matches:
                raise
            print("OSM name search found no matching golf boundary; trying one location-first fallback.",flush=True)
            try:
                geo_candidates=geographically_resolve(name)
                config=resolve(name,geo_candidates)
                audit["discoveryMethod"]="photon-place-plus-osm-spatial"
                audit["candidateCount"]+=len(geo_candidates)
            except Exception as geo_error:
                raise ValueError(f"OSM name lookup failed ({name_error}); geographic fallback: {geo_error}") from geo_error
        p=args.config_directory/(config["slug"]+"-v1.json")
        if p.exists():
            raise ValueError(f"Refusing to overwrite existing course config: {p}")
        request={"courseSlug":config["slug"],"configPath":str(p),"reason":"user-name-cold-import"}
        audit.update({"courseSlug":config["slug"],"acceptedOsm":config["osmCourseElement"],
                      "configPath":str(p),"status":"resolved"})
        p.parent.mkdir(parents=True,exist_ok=True)
        p.write_text(json.dumps(config,indent=2)+"\n",encoding="utf-8")
        args.rebuild_request.parent.mkdir(parents=True,exist_ok=True)
        args.rebuild_request.write_text(json.dumps(request,indent=2)+"\n",encoding="utf-8")
    except Exception as exc:
        audit.update({"status":"failed","errorType":type(exc).__name__,"error":str(exc)[:1200]})
        raise
    finally:
        audit["resolvedAt"]=now()
        audit["discoveryWallSeconds"]=round(time.monotonic()-started,3)
        args.discovery_audit.parent.mkdir(parents=True,exist_ok=True)
        args.discovery_audit.write_text(json.dumps(audit,indent=2)+"\n",encoding="utf-8")
        print(json.dumps(audit,indent=2))


if __name__=="__main__":
    main()
