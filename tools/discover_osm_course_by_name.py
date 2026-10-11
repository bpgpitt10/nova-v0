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
def get_candidates(name, timeout=25):
    query = urllib.parse.urlencode({"q":name,"format":"jsonv2","addressdetails":1,"namedetails":1,"extratags":1,"limit":10})
    request = urllib.request.Request(API+"?"+query, headers={"User-Agent":UA,"Accept":"application/json"})
    with urllib.request.urlopen(request,timeout=timeout) as resp:
        return json.load(resp)

def resolve(name, candidates):
    valid=[]
    for x in candidates:
        if str(x.get("osm_type") or "").lower() not in {"way","relation"}: continue
        if x.get("type") not in {"golf_course","golf"} and not (x.get("extratags") or {}).get("golf")=="course": continue
        if not x.get("osm_id"): continue
        named=(x.get("namedetails") or {}).get("name") or str(x.get("display_name","")).split(",")[0]
        valid.append((x,named))
    hits=[item for item in valid if norm_course(item[1])==norm_course(name)]
    if len(hits)!=1:
        hints=[{"name":label,"osmType":x.get("osm_type"),"osmId":x.get("osm_id"),"place":x.get("display_name")} for x,label in (hits or valid)]
        raise ValueError(f"Expected exactly one exact-match mapped golf course for {name!r}; found {len(hits)}. Candidates: {json.dumps(hints)[:2500]}")
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
           "requestedAt":args.requested_at or None,"source":"OpenStreetMap Nominatim single lookup"}
    try:
        if len(name)<3 or len(name)>120:
            raise ValueError("Course name must contain 3-120 characters")
        candidates=json.loads(args.fixture.read_text()) if args.fixture else get_candidates(name)
        audit["candidateCount"]=len(candidates)
        config=resolve(name,candidates)
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
