from __future__ import annotations

import argparse, base64, bz2, datetime as dt, gzip, hashlib, io, json, lzma, math, os, re, sqlite3, traceback, zipfile, zlib
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "looper-gkd-archaeology-v0"
GKD_SUFFIXES = (".gkd", ".gkdalt", ".gkd_bak")
MAX_BYTES = 64 * 1024 * 1024
META_KEYS = {"gkversion", "coursename", "scenefoldername", "courseversion", "version"}
HOLE_KEYS = {"hole", "holenumber", "holeindex", "holeno", "holeid"}
COORD_KEYS = {"coords", "coordinates", "points", "vertices", "vertexes", "polygon", "polyline", "boundary", "outline", "path", "positions", "position", "pos", "center", "centre", "dropzone", "droppoint", "dz", "tee", "pin", "flag", "location", "locations"}
SEMANTICS = (
    ("bunker_or_sand", ("bunker", "sand", "tvgsand")),
    ("water", ("water", "pond", "lake", "creek", "stream", "river")),
    ("penalty_area", ("penalty", "redhazard", "yellowhazard")),
    ("out_of_bounds", ("outofbounds", "oob")),
    ("drop_zone", ("dropzone", "hasdz", "dzpoint")),
    ("green", ("green",)), ("tee", ("tee",)), ("pin", ("pin", "flag")),
    ("fairway", ("fairway",)), ("rough", ("rough",)), ("hazard_unspecified", ("hazard",)),
)


def now(): return dt.datetime.now(dt.timezone.utc).isoformat()
def nk(v): return re.sub(r"[^a-z0-9]+", "", str(v).lower())
def scalar(v): return v is None or isinstance(v, (str, int, float, bool))
def digest(b): return hashlib.sha256(b).hexdigest()


def looks_like_windows_gkd_path(value: str) -> bool:
    s = value.strip().strip('"').strip("'")
    return bool(s and len(s) < 2048 and s.lower().endswith(GKD_SUFFIXES) and (re.match(r"^[A-Za-z]:[\\/]", s) or s.startswith("\\\\") or "/" in s or "\\" in s))


def find_locallow(explicit=None):
    c = [Path(explicit).expanduser()] if explicit else []
    up, la = os.getenv("USERPROFILE"), os.getenv("LOCALAPPDATA")
    if up: c += [Path(up)/"AppData/LocalLow/GSPro/GSPro", Path(up)/"AppData/LocalLow/GSPro"]
    if la: c += [Path(la).parent/"LocalLow/GSPro/GSPro", Path(la).parent/"LocalLow/GSPro"]
    scored = []
    for p in c:
        try:
            if p.is_dir(): scored.append((sum((p/n).exists()*w for n,w in (("GSPro.db",5),("currentRound.dat",3),("output_log.txt",2))), p))
        except OSError: pass
    return max(scored, default=(-1,None), key=lambda x:x[0])[1]


def locate_db(root):
    if not root: return None
    if (root/"GSPro.db").exists(): return root/"GSPro.db"
    try: return next(root.rglob("GSPro.db"), None)
    except OSError: return None


def round_rows(db_path, limit=25):
    out = {"db_path": str(db_path) if db_path else None, "rows": [], "errors": []}
    if not db_path: out["errors"].append("GSPro.db not found"); return out
    try:
        con = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True, timeout=5); con.row_factory = sqlite3.Row
        cols = [r[1] for r in con.execute("PRAGMA table_info('Round')")]
        wanted = [c for c in ("ID","DateModified","CourseCode","CourseName","ActiveHole","RoundStatus","CourseGKD") if c in cols]
        out["columns"] = cols
        if wanted:
            q = f"SELECT {','.join('['+c+']' for c in wanted)} FROM [Round] ORDER BY {'ID' if 'ID' in cols else 'rowid'} DESC LIMIT ?"
            out["rows"] = [dict(r) for r in con.execute(q,(limit,))]
        con.close()
    except Exception as e: out["errors"].append(f"{type(e).__name__}: {e}")
    return out


def course_roots(explicit, rows):
    roots=[]
    if explicit:
        p=Path(explicit).expanduser(); roots += [p, p/"Core/GSP/Courses", p/"Courses"]
    for row in rows:
        raw=row.get("CourseGKD")
        if isinstance(raw,str) and looks_like_windows_gkd_path(raw):
            p=Path(raw.strip().strip('"').strip("'")); roots += [p.parent,p.parent.parent]
    roots += [Path(r"C:\GSProV1\Core\GSP\Courses"),Path(r"C:\GSPro\Core\GSP\Courses"),Path(r"C:\GSProV1\Courses"),Path(r"C:\GSPro\Courses")]
    seen=set(); out=[]
    for p in roots:
        k=str(p).lower().rstrip("\\/")
        if k not in seen: seen.add(k); out.append(p)
    return out


def course_hints(rows):
    vals=[]
    for r in rows:
        vals += [r[k].strip() for k in ("CourseName","CourseCode") if isinstance(r.get(k),str) and r[k].strip()]
        raw=r.get("CourseGKD")
        if isinstance(raw,str) and looks_like_windows_gkd_path(raw): vals.append(Path(raw).parent.name)
    return list(dict.fromkeys(vals))


def resolve_course(explicit, roots, hints):
    ev={"method":"not-found","hints":hints,"candidates":[]}
    if explicit:
        p=Path(explicit).expanduser()
        if p.exists(): ev["method"]="explicit"; return (p if p.is_dir() else p.parent),ev
    hn=[nk(x) for x in hints]; scored=[]
    for root in roots:
        try:
            if root.is_file(): folders=[root.parent]
            elif root.is_dir() and any(root.glob("*.gkd")): folders=[root]
            elif root.is_dir(): folders=[p for p in root.iterdir() if p.is_dir()]
            else: continue
        except OSError: continue
        for f in folders:
            n=nk(f.name); s=max([10 if n==h else 5 if n and h and (n in h or h in n) else 0 for h in hn] or [0])
            try: s += 1 if any(p.is_file() and p.name.lower().endswith(GKD_SUFFIXES) for p in f.iterdir()) else 0
            except OSError: pass
            if s: scored.append((s,f)); ev["candidates"].append({"path":str(f),"score":s})
    if scored:
        s,f=max(scored,key=lambda x:x[0]); ev.update(method="course-name-match",selected_score=s); return f,ev
    return None,ev


def discover_gkds(folder):
    if not folder: return []
    try: return sorted([p for p in folder.rglob("*") if p.is_file() and p.name.lower().endswith(GKD_SUFFIXES)],key=lambda p:str(p).lower())
    except OSError: return []


def json_from_text(text):
    s=text.strip().lstrip("\ufeff")
    try: return json.loads(s),"whole-text-json"
    except Exception: pass
    dec=json.JSONDecoder()
    for pos in [i for i,c in enumerate(text[:1024*1024]) if c in "{["][:256]:
        try: v,_=dec.raw_decode(text[pos:]); return v,f"embedded-json@{pos}"
        except Exception: pass
    return None,None


def b64(text):
    s=re.sub(r"\s+","",text)
    if len(s)<16 or not re.fullmatch(r"[A-Za-z0-9+/=_-]+",s): return None
    s += "="*((4-len(s)%4)%4)
    for alt in (None,b"-_"):
        try: return base64.b64decode(s,altchars=alt,validate=False)
        except Exception: pass
    return None


def decode_jsonish(data: bytes, label="raw"):
    seen=set(); attempts=[]
    def visit(blob,chain,depth):
        if depth>4 or not blob or len(blob)>MAX_BYTES or digest(blob) in seen: return None,None
        seen.add(digest(blob)); attempts.append({"chain":chain,"size_bytes":len(blob),"sha256":digest(blob)})
        texts=[]
        for enc in ("utf-8-sig","utf-16","utf-16-le","utf-16-be","utf-32","utf-32-le","utf-32-be"):
            try:
                t=blob.decode(enc)
                if t and ("\x00" not in t[:256] or "{" in t or "[" in t): texts.append((enc,t))
            except Exception: pass
        for enc,t in texts:
            v,mode=json_from_text(t)
            if v is not None:
                extra=[]
                for _ in range(3):
                    if not isinstance(v,str): break
                    nv,nm=json_from_text(v)
                    if nv is None: break
                    v=nv; extra.append(f"json-string:{nm}")
                return v,chain+[f"decode:{enc}",str(mode)]+extra
            bd=b64(t)
            if bd and bd!=blob:
                v,c=visit(bd,chain+[f"base64:{enc}"],depth+1)
                if v is not None:return v,c
        for name,fn in (("gzip",gzip.decompress),("zlib",zlib.decompress),("bz2",bz2.decompress),("lzma",lzma.decompress),("raw-deflate",lambda b:zlib.decompress(b,-zlib.MAX_WBITS))):
            try: out=fn(blob)
            except Exception: continue
            if out and out!=blob and len(out)<=MAX_BYTES:
                v,c=visit(out,chain+[name],depth+1)
                if v is not None:return v,c
        if blob.startswith(b"PK"):
            try:
                with zipfile.ZipFile(io.BytesIO(blob)) as zf:
                    for info in zf.infolist()[:100]:
                        if info.is_dir() or info.file_size>MAX_BYTES: continue
                        v,c=visit(zf.read(info),chain+[f"zip:{info.filename}"],depth+1)
                        if v is not None:return v,c
            except Exception: pass
        return None,None
    v,chain=visit(data,[label],0)
    return {"decoded":v is not None,"decode_chain":chain,"attempts":attempts,"value":v}


def semantic(path,support):
    hay=nk(path+" "+" ".join(f"{k}={v}" for k,v in support.items() if scalar(v)))
    found=[]
    for name,needles in SEMANTICS:
        if any(nk(n) in hay for n in needles): found.append(name)
    if "hazard_unspecified" in found and any(x in found for x in ("water","penalty_area","out_of_bounds","bunker_or_sand")): found.remove("hazard_unspecified")
    return found or ["coordinate_structure_unknown"]


def num(v): return float(v) if not isinstance(v,bool) and isinstance(v,(int,float)) and math.isfinite(float(v)) else None

def point(v,allow_tuple=False):
    if isinstance(v,dict):
        d={nk(k):x for k,x in v.items()}; x,z,y=num(d.get("x")),num(d.get("z")),num(d.get("y"))
        if x is not None and z is not None: return {**{"x":x,"z":z},**({"y":y} if y is not None else {})}
        if allow_tuple and x is not None and y is not None:return {"x":x,"z":y,"source_axes":"x/y"}
    if allow_tuple and isinstance(v,(list,tuple)) and 2<=len(v)<=4:
        ns=[num(x) for x in v]
        if all(x is not None for x in ns): return {"x":ns[0],"z":ns[1],"source_axes":"tuple-2d"} if len(ns)==2 else {"x":ns[0],"y":ns[1],"z":ns[2]}
    return None


def points(v,key):
    allow=nk(key) in {nk(x) for x in COORD_KEYS}
    if isinstance(v,list):
        out=[]
        for x in v:
            p=point(x,allow)
            if p is None:return []
            out.append(p)
        return out
    p=point(v,allow); return [p] if p else []


def geom(ps):
    xs=[p["x"] for p in ps]; zs=[p["z"] for p in ps]; out={"point_count":len(ps),"bounds_xz":{"min_x":min(xs),"max_x":max(xs),"min_z":min(zs),"max_z":max(zs)},"centroid_xz":{"x":sum(xs)/len(xs),"z":sum(zs)/len(zs)},"polygon_candidate":len(ps)>=3,"explicitly_closed":False}
    if len(ps)>=3:
        out["explicitly_closed"]=math.hypot(ps[0]["x"]-ps[-1]["x"],ps[0]["z"]-ps[-1]["z"])<1e-6
        area=sum(a["x"]*b["z"]-b["x"]*a["z"] for a,b in zip(ps,ps[1:]+ps[:1]))/2; out.update(signed_area_xz=area,area_abs_xz=abs(area))
    return out


def features(root,source):
    out=[]
    def visit(node,path,anc,parent,key):
        ps=points(node,key)
        if ps:
            sup={str(k):v for k,v in (parent or {}).items() if scalar(v)}; hh=None
            for obj in [sup]+list(reversed(anc)):
                for k,v in obj.items():
                    if nk(k) in HOLE_KEYS and scalar(v): hh={"source":f"field:{k}","value":v}; break
                if hh: break
            if not hh:
                m=re.search(r"(?i)\.holes?\[(\d+)\]",path)
                if m: hh={"source":"holes-array-index","value":int(m.group(1)),"index_base":"unknown"}
            fid=hashlib.sha1(json.dumps([path,ps],sort_keys=True,default=str).encode()).hexdigest()[:16]
            out.append({"feature_id":fid,"source":source,"json_path":path,"container_key":key,"semantic_candidates":semantic(path,sup),"hole_hint":hh,"supporting_fields":sup,"points_xyz":ps,**geom(ps),"strategy_authority":False}); return
        if isinstance(node,dict):
            a=anc+[{str(k):v for k,v in node.items() if scalar(v)}]
            for k,v in node.items():visit(v,f"{path}.{k}",a,node,str(k))
        elif isinstance(node,list):
            for i,v in enumerate(node):visit(v,f"{path}[{i}]",anc,parent,key)
    visit(root,"$",[],None,"root"); return out


def metadata(root):
    out=[]
    def walk(n,path):
        if isinstance(n,dict):
            for k,v in n.items():
                p=f"{path}.{k}"
                if nk(k) in {nk(x) for x in META_KEYS} and scalar(v):out.append({"json_path":p,"key":k,"value":v})
                walk(v,p)
        elif isinstance(n,list):
            for i,v in enumerate(n):walk(v,f"{path}[{i}]")
    walk(root,"$"); return out


def schema_inventory(root):
    inv=defaultdict(Counter)
    def walk(n,path):
        inv[path][type(n).__name__]+=1
        if isinstance(n,dict):
            for k,v in n.items():walk(v,f"{path}.{k}")
        elif isinstance(n,list):
            for v in n:walk(v,f"{path}[]")
    walk(root,"$"); return [{"json_path":p,"types":dict(c)} for p,c in sorted(inv.items())]


def analyze(data,source):
    d=decode_jsonish(data,source); r={"source":source,"size_bytes":len(data),"sha256":digest(data),"magic_hex":data[:64].hex(),"decoded":d["decoded"],"decode_chain":d["decode_chain"],"decode_attempts":d["attempts"],"strategy_authority":False}
    if d["decoded"]:
        fs=features(d["value"],source); counts=Counter(s for f in fs for s in f["semantic_candidates"])
        r["analysis"]={"root_type":type(d["value"]).__name__,"metadata_candidates":metadata(d["value"]),"feature_count":len(fs),"semantic_feature_counts":dict(counts),"features":fs,"schema_inventory":schema_inventory(d["value"]),"cautions":["GKD Hazards is not assumed to mean bunker geometry.","Semantic labels are archaeology hints, not authority."],"strategy_authority":False}; r["decoded_value"]=d["value"]
    return r


def payloads(rows):
    out=[]; seen=set()
    for r in rows:
        raw=r.get("CourseGKD")
        if not isinstance(raw,str) or not raw.strip() or looks_like_windows_gkd_path(raw):continue
        h=digest(raw.encode())
        if h in seen:continue
        seen.add(h); out.append((f"db.CourseGKD.round-{r.get('ID','unknown')}",raw.encode(),{k:r.get(k) for k in ("ID","CourseName","CourseCode","DateModified")}))
    return out


def save_report(r,out):
    name=re.sub(r"[^A-Za-z0-9._-]+","_",r["source"]).strip("._") or "gkd"; clean={k:v for k,v in r.items() if k!="decoded_value"}
    (out/f"{name}.report.json").write_text(json.dumps(clean,indent=2,default=str),encoding="utf-8")
    if "decoded_value" in r:
        b=json.dumps(r["decoded_value"],indent=2,ensure_ascii=False,default=str).encode()
        if len(b)<=8*1024*1024:(out/f"{name}.decoded.json").write_bytes(b)


# Public names used by tests and future field-lab orchestration.
analyze_gkd_bytes = analyze
payloads_from_round_rows = payloads


def parse_args():
    p=argparse.ArgumentParser(description="Read-only GSPro GKD archaeology parser")
    p.add_argument("--locallow");p.add_argument("--gspro-root");p.add_argument("--course-folder");p.add_argument("--gkd-file",action="append",default=[]);p.add_argument("--output-root",default=str(Path(__file__).resolve().parent/"output"));p.add_argument("--recent-rounds",type=int,default=25);return p.parse_args()


def main():
    a=parse_args(); stamp=dt.datetime.now().strftime("%Y%m%d_%H%M%S"); run=Path(a.output_root).expanduser().resolve()/f"gkd_archaeology_{stamp}"; repdir=run/"reports"; repdir.mkdir(parents=True,exist_ok=True)
    m={"schema_version":SCHEMA_VERSION,"started_utc":now(),"read_only_intent":True,"strategy_authority":False,"cautions":["GKD Hazards is not assumed to mean bunker geometry."],"warnings":[],"errors":[]}; reports=[]
    try:
        ll=find_locallow(a.locallow); db=locate_db(ll); ctx=round_rows(db,a.recent_rounds); (run/"round_course_context.json").write_text(json.dumps(ctx,indent=2,default=str),encoding="utf-8"); rows=ctx["rows"]
        folder,ev=resolve_course(a.course_folder,course_roots(a.gspro_root,rows),course_hints(rows)); m.update(locallow=str(ll) if ll else None,gspro_db=str(db) if db else None,course_discovery={"selected":str(folder) if folder else None,**ev})
        paths=[Path(x).expanduser() for x in a.gkd_file]
        if a.course_folder and Path(a.course_folder).expanduser().is_file():paths.append(Path(a.course_folder).expanduser())
        paths+=discover_gkds(folder); uniq=[]; seen=set()
        for p in paths:
            k=str(p).lower()
            if k not in seen and p.exists() and p.is_file():seen.add(k);uniq.append(p)
        for p in uniq:
            try:r=analyze(p.read_bytes(),f"file:{p.name}");r["path"]=str(p);reports.append(r);save_report(r,repdir)
            except Exception as e:m["errors"].append(f"{p}: {type(e).__name__}: {e}")
        for src,data,meta in payloads(rows):
            try:r=analyze(data,src);r["round_metadata"]=meta;reports.append(r);save_report(r,repdir)
            except Exception as e:m["errors"].append(f"{src}: {type(e).__name__}: {e}")
        decoded=[r for r in reports if r["decoded"]]; fs=[f for r in decoded for f in r["analysis"]["features"]]; counts=Counter(s for f in fs for s in f["semantic_candidates"])
        (run/"features.json").write_text(json.dumps({"feature_count":len(fs),"semantic_feature_counts":dict(counts),"features":fs,"strategy_authority":False},indent=2,default=str),encoding="utf-8")
        merged=defaultdict(Counter)
        for r in decoded:
            for row in r["analysis"]["schema_inventory"]:
                for t,c in row["types"].items():merged[row["json_path"]][t]+=c
        (run/"schema_inventory.json").write_text(json.dumps({"paths":[{"json_path":p,"types":dict(c)} for p,c in sorted(merged.items())]},indent=2),encoding="utf-8")
        variants=[{"source":r["source"],"sha256":r["sha256"],"decoded":r["decoded"],"decode_chain":r["decode_chain"],"feature_count":r.get("analysis",{}).get("feature_count",0),"semantic_feature_counts":r.get("analysis",{}).get("semantic_feature_counts",{}),"metadata_candidates":r.get("analysis",{}).get("metadata_candidates",[])} for r in reports]
        (run/"variant_comparison.json").write_text(json.dumps({"variant_count":len(variants),"decoded_count":len(decoded),"variants":variants,"strategy_authority":False},indent=2,default=str),encoding="utf-8")
        summary={"schema_version":SCHEMA_VERSION,"course_folder":str(folder) if folder else None,"report_count":len(reports),"decoded_count":len(decoded),"coordinate_feature_count":len(fs),"semantic_feature_counts":dict(counts),"installed_gkd_count":len(uniq),"db_coursegkd_payload_count":len(payloads(rows)),"cautions":m["cautions"],"strategy_authority":False};(run/"summary.json").write_text(json.dumps(summary,indent=2),encoding="utf-8");m["summary"]=summary
        if not uniq:m["warnings"].append("No installed GKD-family files resolved; DB CourseGKD payloads were still attempted.")
    except Exception as e:m["errors"].append(f"fatal-but-preserved: {type(e).__name__}: {e}");(run/"exception.txt").write_text(traceback.format_exc(),encoding="utf-8")
    m["finished_utc"]=now();(run/"manifest.json").write_text(json.dumps(m,indent=2,default=str),encoding="utf-8");s=m.get("summary",{});print("GSPro GKD Archaeology v0");print(f"Output: {run}");print(f"Decoded payloads: {s.get('decoded_count',0)}/{s.get('report_count',0)}");print(f"Coordinate features: {s.get('coordinate_feature_count',0)}");return 0 if not m["errors"] else 1

if __name__=="__main__": raise SystemExit(main())
