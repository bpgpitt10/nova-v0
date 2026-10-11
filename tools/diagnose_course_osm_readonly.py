#!/usr/bin/env python3
"""Read-only golf course geometry discovery diagnosis using location grounded by course website.

Never imports a course and never trusts a matching name as an OSM boundary.
Used only in staging diagnostic workflow, with verbose source provenance.
"""
from __future__ import annotations
import collections
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

USER_AGENT = "TheLooperCourseDiagnosis/1.0 (single diagnostic from shaftesburyglen.com address; thelooper.golf)"
LAT, LON = 33.88958, -78.90363
BOUND = (-78.923, 33.876, -78.884, 33.908)


def get(url, *, data=None, timeout=35):
    request = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT,
        "Accept": "application/json" if "overpass" in url or "nominatim" in url else "application/xml"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def summary(e):
    tags=e.get("tags",{})
    return {"type":e.get("type"),"id":e.get("id"),"name":tags.get("name"),
        "leisure":tags.get("leisure"),"golf":tags.get("golf"),"ref":tags.get("ref"),
        "course":tags.get("golf:course"),"lat":e.get("lat",e.get("center",{}).get("lat")),
        "lon":e.get("lon",e.get("center",{}).get("lon"))}


def execute():
    endpoint = "https://overpass.kumi.systems/api/interpreter"
    code = (f'[out:json][timeout:45];('
        f'nwr(around:2000,{LAT},{LON})["leisure"="golf_course"];'
        f'nwr(around:2000,{LAT},{LON})["golf"~"^(hole|tee|green|fairway|bunker)$"];'
        f');out center;')
    servers=["https://overpass.kumi.systems/api/interpreter",
             "https://overpass-api.de/api/interpreter",
             "https://overpass.private.coffee/api/interpreter"]
    for base in servers:
        try:
            print("QUERY",base,flush=True)
            data=get(base,data=urllib.parse.urlencode({"data":code}).encode(),timeout=55)
            rows=json.loads(data).get("elements",[])
            count=collections.Counter((e.get("tags") or {}).get("golf","other") for e in rows)
            courses=[summary(e) for e in rows if (e.get("tags") or {}).get("leisure")=="golf_course"]
            holes=[summary(e) for e in rows if (e.get("tags") or {}).get("golf")=="hole"]
            print("OVERPASS RESULT",json.dumps({"server":base,"count":len(rows),"tags":count,
                "courses":courses[:20],"holes":holes[:30]},default=list),flush=True)
            return
        except Exception as e:
            print("OVERPASS ERROR",type(e).__name__,str(e)[:300],flush=True)

    print("All Overpass endpoints unavailable: inspect OSM core map API.",flush=True)
    bbox=",".join(str(x) for x in BOUND)
    try:
        data=get("https://api.openstreetmap.org/api/0.6/map?bbox="+bbox,timeout=60)
        root=ET.fromstring(data)
        courses,holes,counts=[],[],collections.Counter()
        for el in root:
            if el.tag not in {"node","way","relation"}:continue
            tags={t.get("k"):t.get("v") for t in el.findall("tag")}
            if not tags:continue
            counts[tags.get("golf","other")]+=1
            row={"type":el.tag,"id":el.get("id"),"name":tags.get("name"),"leisure":tags.get("leisure"),"golf":tags.get("golf")}
            if tags.get("leisure")=="golf_course":courses.append(row)
            if tags.get("golf")=="hole": holes.append(row)
        print("OSM CORE RESULT",json.dumps({"elements":len(root),"tagCounts":counts,
            "courses":courses[:30],"holeCount":len(holes),"holes":holes[:30]}),flush=True)
    except Exception as e:
        print("OSM CORE ERROR",type(e).__name__,str(e)[:400],flush=True)


if __name__ == "__main__":
    execute()
