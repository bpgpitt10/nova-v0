#!/usr/bin/env python3
"""Compose static OSM geometry and a generic LiDAR terrain sidecar."""
from __future__ import annotations
import argparse, copy, json
from pathlib import Path
STATIC_SCHEMA="looper-static-course-package-v1"; TERRAIN_SCHEMA="looper-course-terrain-v1"; LEGACY_SCHEMA="looper-greywolf-terrain-v1"
def finite(v): return isinstance(v,(int,float)) and not isinstance(v,bool)
def positive_int(v): return isinstance(v,int) and not isinstance(v,bool) and v>0
def coordinate_origin(h):
    for key in ("coordinateSystem","coordinateFrame"):
        value=h.get(key)
        if isinstance(value,dict) and isinstance(value.get("origin"),str): return value["origin"]
    return None
def contours(value,hole):
    if value is None:return []
    if not isinstance(value,list):raise ValueError(f"Hole {hole} terrain contours must be a list")
    out=[]
    for i,c in enumerate(value,1):
        if not isinstance(c,dict) or not finite(c.get("elevationFt")):raise ValueError(f"Hole {hole} contour {i} has invalid elevationFt")
        pts=c.get("points")
        if not isinstance(pts,list) or len(pts)<2 or any(not isinstance(p,list) or len(p)<2 or not finite(p[0]) or not finite(p[1]) for p in pts):raise ValueError(f"Hole {hole} contour {i} points are invalid")
        out.append(copy.deepcopy(c))
    return out
def embedded(pkg,h,hole):
    g=h.get("grid"); src=pkg.get("source"); run=pkg.get("runtimeTerrain")
    if not all(isinstance(v,dict) for v in (g,src,run)):raise ValueError(f"Hole {hole} terrain package is missing grid/source/runtimeTerrain")
    vals={"sourceResolutionMeters":src.get("sourceResolutionMeters"),"runtimeSpacingYds":g.get("spacingYds"),"minX":g.get("minX"),"minY":g.get("minY"),"elevationOffsetFt":g.get("elevationOffsetFt"),"nodata":run.get("nodata")}
    if any(not finite(v) for v in vals.values()) or vals["sourceResolutionMeters"]<=0 or vals["runtimeSpacingYds"]<=0:raise ValueError(f"Hole {hole} terrain numeric metadata is invalid")
    if run.get("interpolation")!="bilinear" or not positive_int(g.get("width")) or not positive_int(g.get("height")) or g.get("compression")!="deflate" or not isinstance(g.get("valuesBase64"),str) or not g.get("valuesBase64"):raise ValueError(f"Hole {hole} terrain encoding is invalid")
    return {"source":"lidar-dem","sourceResolutionMeters":vals["sourceResolutionMeters"],"runtimeSpacingYds":vals["runtimeSpacingYds"],"interpolation":"bilinear","minX":g["minX"],"minY":g["minY"],"width":g["width"],"height":g["height"],"elevationOffsetFt":g["elevationOffsetFt"],"nodata":vals["nodata"],"compression":"deflate","valuesBase64":g["valuesBase64"],**({"note":run["note"]} if isinstance(run.get("note"),str) else {})}
def compose(geometry,terrain):
    if geometry.get("schemaVersion")!=STATIC_SCHEMA:raise ValueError(f"Geometry package must use {STATIC_SCHEMA}")
    cid=geometry.get("courseId"); holes=geometry.get("holes")
    if not isinstance(cid,str) or not isinstance(holes,dict):raise ValueError("Geometry package is missing courseId/holes")
    schema=terrain.get("schemaVersion"); legacy=schema==LEGACY_SCHEMA
    if schema not in {TERRAIN_SCHEMA,LEGACY_SCHEMA}:raise ValueError(f"Terrain package must use {TERRAIN_SCHEMA} (or legacy {LEGACY_SCHEMA})")
    if not legacy and terrain.get("courseId")!=cid:raise ValueError("Terrain package courseId does not match geometry")
    th=terrain.get("holes")
    if not isinstance(th,dict):raise ValueError("Terrain package has no holes object")
    out=copy.deepcopy(geometry); merged=[]
    for num in range(1,19):
        key=str(num); gh=out["holes"].get(key); raw=th.get(key)
        if not isinstance(gh,dict) or not isinstance(raw,dict):raise ValueError(f"Hole {num} is missing from geometry/terrain")
        if not legacy:
            go=coordinate_origin(gh); to=coordinate_origin(raw)
            if not isinstance(go,str) or to!=go:raise ValueError(f"Hole {num} terrain origin {to!r} does not match geometry origin {go!r}")
        gh["terrain"]=embedded(terrain,raw,num); cs=contours(raw.get("contours"),num)
        if cs:gh["contours"]=cs
        merged.append(num)
    out["terrainProvenance"]={"schemaVersion":schema,"source":copy.deepcopy(terrain.get("source")),"runtimeTerrain":copy.deepcopy(terrain.get("runtimeTerrain")),**({"courseCoordinateSystem":copy.deepcopy(terrain.get("courseCoordinateSystem"))} if terrain.get("courseCoordinateSystem") is not None else {})}
    return out,{"schemaVersion":"looper-course-package-compose-report-v1","courseId":cid,"terrainInputSchema":schema,"terrainHoleCount":len(merged),"terrainHoles":merged,"complete":len(merged)==18}
def main():
    p=argparse.ArgumentParser();p.add_argument("--geometry",required=True,type=Path);p.add_argument("--terrain",required=True,type=Path);p.add_argument("--output",required=True,type=Path);p.add_argument("--report",type=Path);a=p.parse_args();g=json.loads(a.geometry.read_text());t=json.loads(a.terrain.read_text());out,report=compose(g,t);a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(out,indent=2,sort_keys=True)+"\n")
    if a.report:a.report.parent.mkdir(parents=True,exist_ok=True);a.report.write_text(json.dumps(report,indent=2,sort_keys=True)+"\n")
    print(json.dumps(report,indent=2,sort_keys=True));return 0
if __name__=="__main__":raise SystemExit(main())
