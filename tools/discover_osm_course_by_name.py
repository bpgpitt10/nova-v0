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
