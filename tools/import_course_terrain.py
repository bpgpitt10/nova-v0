#!/usr/bin/env python3
"""Build/cache generic per-hole LiDAR terrain from authoritative DEM products."""
from __future__ import annotations
import argparse, base64, hashlib, json, math, shutil, subprocess, sys, tempfile, time
import urllib.parse, urllib.request, zipfile, zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import numpy as np
import rasterio
from pyproj import Transformer
import build_osm_course_package as osm_base
import build_osm_course_package_v2 as osm_v2

SCHEMA="looper-course-terrain-v1"; CACHE_SCHEMA="looper-course-terrain-cache-v1"
VERSION="import_course_terrain_v1"; UA="LooperTerrainImporter/1.0 (+https://github.com/bpgpitt10/nova-v0)"
USGS_DATASET="Digital Elevation Model (DEM) 1 meter"
USGS_API="https://tnmaccess.nationalmap.gov/api/v1/products"
NRCAN_API="https://datacube.services.geo.ca/stac/api/search"
R=6_371_008.8; M_TO_YD=1.0936133; M_TO_FT=3.280839895; NODATA=65535

def now(): return datetime.now(timezone.utc).isoformat().replace("+00:00","Z")
def load(p:Path):
    x=json.loads(p.read_text());
    if not isinstance(x,dict): raise RuntimeError(f"{p}: expected object")
    return x
def write(p:Path,x): p.parent.mkdir(parents=True,exist_ok=True); p.write_text(json.dumps(x,indent=2,sort_keys=True)+"\n")
def sha(p:Path):
    h=hashlib.sha256()
    with p.open("rb") as f:
        for b in iter(lambda:f.read(1<<20),b""): h.update(b)
    return h.hexdigest()
def canonical_sha(x): return hashlib.sha256(json.dumps(x,sort_keys=True,separators=(",",":")).encode()).hexdigest()
def builder_sha(root:Path):
    h=hashlib.sha256()
    for rel in ["tools/import_course_terrain.py","tools/compose_course_package.py","tools/build_osm_course_package.py","tools/build_osm_course_package_v2.py"]:
        h.update(rel.encode()); h.update(b"\0"); h.update((root/rel).read_bytes()); h.update(b"\0")
    return h.hexdigest()
def slug(cfg,p): return cfg.get("slug") or p.stem.removesuffix("-v1")
def geom_sha(pkg):
    x=json.loads(json.dumps(pkg)); x.pop("terrainProvenance",None)
    for h in (x.get("holes") or {}).values():
        if isinstance(h,dict): h.pop("terrain",None); h.pop("contours",None)
    return canonical_sha(x)

def routes(osm):
    _,rs=osm_base.normalize_osm(osm); missing=sorted(set(range(1,19))-set(rs))
    if missing: raise RuntimeError(f"OSM missing hole routes {missing}")
    return rs

def bbox(rs,margin):
    pts=[p for r in rs.values() for p in r["geometry"]]; s=min(p[0] for p in pts); n=max(p[0] for p in pts); w=min(p[1] for p in pts); e=max(p[1] for p in pts)
    lat=(s+n)/2; dp=math.degrees(margin/R); dl=math.degrees(margin/(R*max(.2,math.cos(math.radians(lat)))))
    return (w-dl,s-dp,e+dl,n+dp)
def get_json(url):
    req=urllib.request.Request(url,headers={"User-Agent":UA,"Accept":"application/json"}); err=None
    for i in range(3):
        try:
            with urllib.request.urlopen(req,timeout=90) as r: x=json.load(r)
            if not isinstance(x,dict): raise ValueError("non-object JSON")
            return x
        except Exception as ex: err=ex; time.sleep(2**i)
    raise RuntimeError(f"GET failed {url}: {err}")
def download(url,dst):
    req=urllib.request.Request(url,headers={"User-Agent":UA}); err=None
    for i in range(3):
        try:
            with urllib.request.urlopen(req,timeout=240) as r, dst.open("wb") as f: shutil.copyfileobj(r,f,1<<20)
            if dst.stat().st_size: return
        except Exception as ex: err=ex; dst.unlink(missing_ok=True); time.sleep(2**i)
    raise RuntimeError(f"download failed {url}: {err}")

def discover(provider,b):
    if provider=="usgs-3dep-1m":
        q=urllib.parse.urlencode({"datasets":USGS_DATASET,"bbox":",".join(f"{v:.7f}" for v in b),"prodFormats":"GeoTIFF","max":100,"outputFormat":"JSON"}); url=f"{USGS_API}?{q}"; cat=get_json(url); items=cat.get("items") or []
        ps=[]
        for x in items:
            if not isinstance(x,dict): continue
            href=x.get("downloadURL") or x.get("downloadUrl")
            if isinstance(href,str) and href.startswith("http"): ps.append({"id":str(x.get("sourceId") or x.get("id") or x.get("title") or href),"url":href,"title":x.get("title")})
        meta={"provider":provider,"dataset":USGS_DATASET,"lidarDerived":True,"license":"U.S. public domain","catalogQueryUrl":url}
    elif provider=="nrcan-hrdem-lidar":
        q=urllib.parse.urlencode({"collections":"hrdem-lidar","bbox":",".join(f"{v:.7f}" for v in b),"limit":100}); url=f"{NRCAN_API}?{q}"; cat=get_json(url); preferred=[]; fallback=[]
        for feat in cat.get("features") or []:
            if not isinstance(feat,dict): continue
            for key,a in (feat.get("assets") or {}).items():
                if not isinstance(a,dict): continue
                href=a.get("href"); text=f"{key} {a.get('title','')} {a.get('description','')} {href}".lower()
                if not isinstance(href,str) or not href.startswith("http") or not any(t in text for t in [".tif",".tiff",".zip"]): continue
                if any(t in text for t in ["dsm","mns","surface model"]): continue
                rec={"id":f"{feat.get('id')}:{key}","url":href,"title":a.get("title")}
                (preferred if any(t in text for t in ["dtm","mnt","bare earth","bare-earth"]) else fallback).append(rec)
        ps=preferred or fallback; meta={"provider":provider,"dataset":"NRCan HRDEM LiDAR DTM","lidarDerived":True,"license":"Open Government Licence - Canada","catalogQueryUrl":url}
    else: raise RuntimeError(f"unsupported provider {provider}")
    seen=set(); ps=[p for p in ps if not (p["url"] in seen or seen.add(p["url"]))]
    if not ps: raise RuntimeError(f"{provider} returned no downloadable bare-earth raster products")
    return meta,ps

def acquire(provider,b,tmp):
    meta,products=discover(provider,b); rasters=[]; records=[]
    for i,p in enumerate(products):
        path=tmp/f"source-{i:03d}{Path(urllib.parse.urlparse(p['url']).path).suffix or '.bin'}"; download(p["url"],path); rec={**p,"downloadSha256":sha(path),"downloadBytes":path.stat().st_size}; records.append(rec)
        if zipfile.is_zipfile(path):
            d=tmp/f"unzipped-{i:03d}"; d.mkdir();
            with zipfile.ZipFile(path) as z:
                for name in z.namelist():
                    if Path(name).suffix.lower() in {".tif",".tiff"}: z.extract(name,d); rasters.append(d/name)
        else: rasters.append(path)
    if not rasters: raise RuntimeError("no GeoTIFFs found in elevation products")
    return rasters,{"schemaVersion":"looper-course-terrain-source-v1",**meta,"sourceBoundsWgs84":[round(v,7) for v in b],"products":records,"retrievedAt":now()}

class Sampler:
    def __init__(self,paths,max_res):
        self.ds=[]; self.tx=[]; self.res=[]
        for p in paths:
            d=rasterio.open(p)
            if not d.crs or d.crs.is_geographic: d.close(); raise RuntimeError(f"source must have projected CRS: {p}")
            try: factor=float(d.crs.linear_units_factor[1])
            except Exception: factor=1.0 if str(d.crs.linear_units).lower() in {"metre","meter","m"} else math.nan
            r=max(abs(d.res[0]),abs(d.res[1]))*factor
            if not math.isfinite(r) or r<=0 or r>max_res+.05: d.close(); raise RuntimeError(f"source resolution {r:.3f}m exceeds {max_res:.3f}m: {p}")
            self.ds.append(d); self.tx.append(Transformer.from_crs("EPSG:4326",d.crs,always_xy=True)); self.res.append(r)
        if not self.ds: raise RuntimeError("no elevation rasters opened")
    def close(self):
        for d in self.ds:d.close()
    def sample(self,lon,lat):
        shape=np.shape(lon); lo=np.asarray(lon,float).ravel(); la=np.asarray(lat,float).ravel(); out=np.full(lo.shape,np.nan); missing=np.ones(lo.shape,bool)
        for d,t in zip(self.ds,self.tx):
            idx=np.flatnonzero(missing)
            if not len(idx): break
            x,y=t.transform(lo[idx],la[idx]); x=np.asarray(x); y=np.asarray(y); inside=(x>=d.bounds.left)&(x<=d.bounds.right)&(y>=d.bounds.bottom)&(y<=d.bounds.top)
            if not np.any(inside): continue
            ii=idx[inside]; vals=[]
            for a in d.sample(zip(x[inside].tolist(),y[inside].tolist()),indexes=1,masked=True): vals.append(np.nan if np.ma.is_masked(a[0]) else float(a[0]))
            vals=np.asarray(vals);
            if d.nodata is not None: vals[np.isclose(vals,float(d.nodata),equal_nan=False)]=np.nan
            ok=np.isfinite(vals); out[ii[ok]]=vals[ok]; missing[ii[ok]]=False
        return out.reshape(shape)

def xy_to_ll(x,y,origin,fwd,right):
    east=(right[0]*x+fwd[0]*y)/M_TO_YD; north=(right[1]*x+fwd[1]*y)/M_TO_YD; lat0,lon0=origin
    lat=lat0+np.degrees(north/R); lon=lon0+np.degrees(east/(R*math.cos(math.radians(lat0)))); return lon,lat
def hole_grid(s,bounds,spacing,pad,origin,fwd,right):
    minx=math.floor((float(bounds["minX"])-pad)/spacing)*spacing; maxx=math.ceil((float(bounds["maxX"])+pad)/spacing)*spacing; miny=math.floor((float(bounds["minY"])-pad)/spacing)*spacing; maxy=math.ceil((float(bounds["maxY"])+pad)/spacing)*spacing
    xs=np.arange(minx,maxx+spacing*.25,spacing); ys=np.arange(miny,maxy+spacing*.25,spacing); xx,yy=np.meshgrid(xs,ys); lon,lat=xy_to_ll(xx,yy,origin,fwd,right); return xs,ys,s.sample(lon,lat)*M_TO_FT,minx,miny
def encode(grid):
    finite=np.isfinite(grid)
    if not np.any(finite): raise RuntimeError("terrain grid has no finite samples")
    vals=grid[finite]; offset=math.floor(float(vals.min())*10)/10; q=np.rint((grid-offset)*10); out=np.full(grid.shape,NODATA,dtype="<u2"); good=finite&(q>=0)&(q<NODATA); out[good]=q[good].astype("<u2")
    return offset,base64.b64encode(zlib.compress(out.tobytes(),9)).decode(),float(vals.min()),float(vals.max()),1-float(np.count_nonzero(good))/good.size
def origin_name(h):
    for k in ["coordinateSystem","coordinateFrame"]:
        if isinstance(h.get(k),dict) and isinstance(h[k].get("origin"),str): return h[k]["origin"]
    return None

def build(cfg,tcfg,osm,geometry,s,source):
    rs=routes(osm); holes=geometry.get("holes") or {}; spacing=float(tcfg.get("runtimeSpacingYards",10)); pad=float(tcfg.get("gridPaddingYards",0)); max_missing=float(tcfg.get("maxGridNoDataFraction",.35)); probe_step=float(tcfg.get("routeProbeSpacingYards",10)); out={"schemaVersion":SCHEMA,"courseId":cfg["courseId"],"source":{"provider":source["provider"],"dataset":source["dataset"],"sourceResolutionMeters":round(max(s.res),3),"lidarDerived":True,"license":source.get("license")},"courseCoordinateSystem":{"projection":"per-hole-osm-route-frame-v1","units":"yards"},"runtimeTerrain":{"spacingYds":spacing,"interpolation":"bilinear","encoding":"uint16 deci-feet above per-hole offset","nodata":NODATA,"note":"Compact runtime grid derived from verified high-resolution bare-earth elevation."},"holes":{}}; diags=[]
    for num in range(1,19):
        h=holes.get(str(num)); name=origin_name(h or {})
        if not isinstance(h,dict) or name!="osm-hole-route-start": raise RuntimeError(f"Hole {num}: unsupported/missing OSM coordinate frame")
        bounds=h.get("viewBounds") or h.get("bounds")
        if not isinstance(bounds,dict): raise RuntimeError(f"Hole {num}: no view bounds")
        route=rs[num]["geometry"]; origin,fwd,right,_=osm_v2.route_basis(route); xs,ys,g,minx,miny=hole_grid(s,bounds,spacing,pad,origin,fwd,right); offset,blob,lo,hi,missing=encode(g)
        if missing>max_missing: raise RuntimeError(f"Hole {num}: rectangular terrain no-data {missing:.1%} > {max_missing:.1%}")
        local=[osm_base.local_east_north_yards(p,origin) for p in route]; xy=[(right[0]*e+right[1]*n,fwd[0]*e+fwd[1]*n) for e,n in local]; probes=[]
        for a,b in zip(xy,xy[1:]):
            dx,dy=b[0]-a[0],b[1]-a[1]; steps=max(1,math.ceil(math.hypot(dx,dy)/probe_step)); probes += [(a[0]+dx*i/steps,a[1]+dy*i/steps) for i in range(steps)]
        probes.append(xy[-1]); px=np.array([p[0] for p in probes]); py=np.array([p[1] for p in probes]); plon,plat=xy_to_ll(px,py,origin,fwd,right); route_missing=1-float(np.count_nonzero(np.isfinite(s.sample(plon,plat))))/len(probes)
        if route_missing>0: raise RuntimeError(f"Hole {num}: route terrain no-data {route_missing:.1%}")
        out["holes"][str(num)]={"coordinateSystem":{"origin":name},"grid":{"minX":round(minx,3),"minY":round(miny,3),"spacingYds":spacing,"width":len(xs),"height":len(ys),"elevationOffsetFt":round(offset,1),"compression":"deflate","valuesBase64":blob},"elevationRangeFt":[round(lo,1),round(hi,1)]}; diags.append({"hole":num,"ready":True,"gridNoDataFraction":round(missing,5),"routeNoDataFraction":round(route_missing,5),"elevationRangeFt":[round(lo,1),round(hi,1)]})
    val={"schemaVersion":"looper-course-terrain-validation-v1","courseId":cfg["courseId"],"provider":source["provider"],"dataset":source["dataset"],"lidarDerived":True,"sourceResolutionMeters":round(max(s.res),3),"terrainHoleCount":18,"readyHoleCount":18,"allHolesTerrainReady":True,"holes":diags,"generatedAt":now()}; return out,val

def update_course_cache(cache_path,pkg_path,terrain_path,tcache_path,source_path,val_path,bsha,root):
    c=load(cache_path); c.setdefault("package",{})["sha256"]=sha(pkg_path); c["package"]["terrainComposerVersion"]="compose_course_package_v1"; c["terrain"]={"status":"cached","builderVersion":VERSION,"builderFingerprintSha256":bsha,"terrainPackagePath":str(terrain_path.relative_to(root)),"terrainPackageSha256":sha(terrain_path),"terrainCachePath":str(tcache_path.relative_to(root)),"sourceManifestPath":str(source_path.relative_to(root)),"validationPath":str(val_path.relative_to(root)),"composedAt":now()}; write(cache_path,c)

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--config",type=Path,required=True); ap.add_argument("--repo-root",type=Path,default=Path(__file__).resolve().parents[1]); ap.add_argument("--refresh-source",action="store_true"); ap.add_argument("--rebuild",action="store_true"); a=ap.parse_args(); root=a.repo_root.resolve(); cp=a.config.resolve(); cfg=load(cp); tcfg=cfg.get("terrain")
    if cfg.get("schemaVersion")!="looper-course-build-config-v1" or not isinstance(tcfg,dict): raise SystemExit("course config/schema/terrain config invalid")
    provider=tcfg.get("provider");
    if provider not in {"usgs-3dep-1m","nrcan-hrdem-lidar"}: raise SystemExit(f"unsupported terrain provider {provider}")
    sl=slug(cfg,cp); ad=root/"artifacts/course-geometry"/sl; pd=root/"public/course-geometry"/sl; op=ad/"osm-snapshot.json"; gp=pd/"course-v1.json"; cpkg=ad/"cache-v1.json"; tp=ad/"terrain-v1.json"; vp=ad/"terrain-validation-v1.json"; sp=ad/"terrain-source-v1.json"; tcp=ad/"terrain-cache-v1.json"; rp=ad/"terrain-compose-v1.json"
    for p in [op,gp,cpkg]:
        if not p.exists(): raise SystemExit(f"required cached geometry input missing: {p}")
    osm=load(op); rs=routes(osm); geom=load(gp); bsha=builder_sha(root); osha=sha(op); gsha=geom_sha(geom); prev=load(tcp) if tcp.exists() else {}; reusable=not a.refresh_source and not a.rebuild and all(p.exists() for p in [tp,vp,sp]) and prev.get("builderFingerprintSha256")==bsha and prev.get("osmSnapshotSha256")==osha and prev.get("geometrySourceSha256")==gsha and prev.get("allHolesTerrainReady") is True; network=False
    if reusable: val=load(vp); print(f"Reusing cached terrain: {cfg['courseId']}")
    else:
        b=bbox(rs,float(tcfg.get("sourceMarginMeters",300))); maxres=float(tcfg.get("maxSourceResolutionMeters",2.1))
        with tempfile.TemporaryDirectory(prefix=f"looper-terrain-{sl}-") as td:
            paths,source=acquire(provider,b,Path(td)); network=True; s=Sampler(paths,maxres)
            try: source["sourceResolutionMeters"]=round(max(s.res),3); terrain,val=build(cfg,tcfg,osm,geom,s,source)
            finally: s.close()
        write(sp,source); terrain["source"]["sourceManifestSha256"]=sha(sp); write(tp,terrain); write(vp,val)
    if val.get("allHolesTerrainReady") is not True: raise SystemExit("terrain validation failed")
    with tempfile.NamedTemporaryFile(suffix=".json",delete=False) as f: composed=Path(f.name)
    try:
        subprocess.run([sys.executable,str(root/"tools/compose_course_package.py"),"--geometry",str(gp),"--terrain",str(tp),"--output",str(composed),"--report",str(rp)],cwd=root,check=True); shutil.move(str(composed),gp)
    finally: composed.unlink(missing_ok=True)
    tc={"schemaVersion":CACHE_SCHEMA,"courseId":cfg["courseId"],"builderVersion":VERSION,"builderFingerprintSha256":bsha,"osmSnapshotSha256":osha,"geometrySourceSha256":gsha,"terrainPackageSha256":sha(tp),"sourceManifestSha256":sha(sp),"sourceProvider":provider,"sourceResolutionMeters":val.get("sourceResolutionMeters"),"allHolesTerrainReady":True,"usedNetworkForTerrainSource":network,"builtAt":now(),"refreshPolicy":{"serveDerivedTerrainRegardlessOfAge":True,"implicitRefresh":False,"refreshTriggers":["explicit-refresh","reported-terrain-error","known-new-elevation-survey"],"localRebuildTriggers":["terrain-builder-fingerprint-change","osm-registration-change","geometry-package-change"]}}; write(tcp,tc); update_course_cache(cpkg,gp,tp,tcp,sp,vp,bsha,root); print(json.dumps({"courseId":cfg["courseId"],"provider":provider,"sourceResolutionMeters":val.get("sourceResolutionMeters"),"readyHoleCount":18,"allHolesTerrainReady":True,"usedNetworkForTerrainSource":network},indent=2)); return 0
if __name__=="__main__": raise SystemExit(main())
