#!/usr/bin/env python3
"""Fall back from an overloaded public Overpass to official regional OSM PBF extracts.
Five per-state files, downloaded once each, parsed locally. No Nominatim/Overpass.
Study is source-driven and strict: never count unknown tee identities as usable.
"""
from __future__ import annotations
import collections
import datetime as dt
import gzip
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import urllib.error
import urllib.request
import osmium

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
import audit_gspro_osm_batch01 as prior

STATE_SLUGS={'NY':'new-york','NJ':'new-jersey','PA':'pennsylvania','ME':'maine','NH':'new-hampshire'}
SOURCE='https://download.geofabrik.de/north-america/us/{slug}-latest.osm.pbf'
UA='TheLooper Research / GSPro OSM coverage audit (one-off regional OSM extract)'
RESULT=ROOT/'research/course-coverage/results/batch-01.json'
CACHE=ROOT/'research/course-coverage/source-cache/batch-01-geofabrik.json.gz'

class OSMGeometry(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.elements=[]
        self.ways_by_id={}
        self.course_area_ids=set()
    @staticmethod
    def tags(osm):
        return {str(t.k):str(t.v) for t in osm.tags}
    def node(self,n):
        t=self.tags(n)
        if t.get('golf')!='tee':return
        if not n.location.valid():return
        self.elements.append({'type':'node','id':int(n.id),'tags':t,
            'geometry':[{'lat':float(n.location.lat),'lon':float(n.location.lon)}]})
    def way(self,w):
        t=self.tags(w)
        if t.get('leisure')!='golf_course' and t.get('golf') not in {
            'hole','tee','green','fairway','bunker','rough','water_hazard','lateral_water_hazard'}:
            return
        nodes=[]
        for n in w.nodes:
            if not n.location.valid():continue
            nodes.append({'lat':float(n.location.lat),'lon':float(n.location.lon)})
        if len(nodes)<2:return
        e={'type':'way','id':int(w.id),'tags':t,'geometry':nodes}
        self.elements.append(e)
        self.ways_by_id[int(w.id)]=e
    def area(self,a):
        # For multipolygon course boundaries, derive geometry from assembled
        # area rings. No per-course hand edits or guessed bounding boxes.
        t=self.tags(a)
        if t.get('leisure')!='golf_course' or a.from_way():return
        try:
            factory=osmium.geom.GeoJSONFactory()
            gj=json.loads(factory.create_multipolygon(a))
            polygons=gj.get('coordinates') or []
            pairs=[]
            def walk(arr):
                if isinstance(arr,list):
                    if len(arr)>=2 and all(isinstance(x,(int,float)) for x in arr[:2]):
                        pairs.append({'lat':float(arr[1]),'lon':float(arr[0])})
                    else:
                        for v in arr:walk(v)
            walk(polygons)
            if len(pairs)>3:
                self.elements.append({'type':'relation','id':int(a.orig_id()),'tags':t,
                    'geometry':pairs})
        except Exception:
            pass

def download(slug,target):
    url=SOURCE.format(slug=slug)
    req=urllib.request.Request(url,headers={'User-Agent':UA})
    with urllib.request.urlopen(req,timeout=140) as response:
        length=int(response.headers.get('Content-Length') or '0')
        if length>750_000_000:raise RuntimeError('Source exceeds bounded 750MB per-state limit')
        total=0
        with open(target,'wb') as fp:
            while chunk:=response.read(1024*1024):
                total+=len(chunk)
                if total>750_000_000:raise RuntimeError('Source exceeded 750MB safety cap')
                fp.write(chunk)
    return {'source':url,'downloadBytes':total,'sha256':hashlib.sha256(Path(target).read_bytes()).hexdigest()}

def main():
    roster=json.loads(prior.ROSTER.read_text())
    courses=roster['courses'][:10]
    if [c['number'] for c in courses]!=list(range(1,11)):raise RuntimeError('Frozen roster changed')
    collected={}
    evidence={'provenance':'Geofabrik state OSM extracts, OpenStreetMap ODbL 1.0; https://www.openstreetmap.org/copyright',
        'observedAt':prior.timestamp(),'states':{},'snapshots':{}}
    for state in STATE_SLUGS:
        group=[c for c in courses if c['state']==state]
        if not group:continue
        try:
            print('State',state,'download and local PBF scan:',[x['gsproListingName'] for x in group],flush=True)
            with tempfile.TemporaryDirectory(prefix='looper-osm-') as directory:
                source=os.path.join(directory,STATE_SLUGS[state]+'.osm.pbf')
                info=download(STATE_SLUGS[state],source)
                handler=OSMGeometry()
                handler.apply_file(source,locations=True,idx='flex_mem')
                elements=handler.elements
            venues=[e for e in elements if (e.get('tags') or {}).get('leisure')=='golf_course']
            info['golfTaggedFeatures']=len(elements)
            info['courseBoundaries']=len(venues)
            evidence['states'][state]=info
            for c in group:
                venue,reason=prior.nearest_venue(c,venues)
                if venue is None:
                    code='GSPro_NAME_AMBIGUOUS' if reason and reason.startswith('Ambiguous') else 'OSM_COURSE_NOT_FOUND'
                    collected[c['number']]=prior.missing_record(c,reason or '',code,'ambiguous' if code=='GSPro_NAME_AMBIGUOUS' else 'not_found')
                else:
                    region=prior.bbox(venue)
                    scoped=[e for e in elements if (positions:=prior.coords(e)) and any(prior.within(pos,region) for pos in positions)]
                    evidence['snapshots'][str(c['number'])]={
                        'course':c['gsproListingName'],'venue':venue,
                        'elements':scoped,'stateExtract':info['source']}
                    collected[c['number']]=prior.survey(c,venue,scoped,prior.timestamp())
        except Exception as error:
            reason=type(error).__name__+': '+str(error)[:450]
            evidence['states'][state]={'status':'source_error','error':reason}
            for c in group:
                collected[c['number']]=prior.missing_record(c,reason,'OSM_SOURCE_ERROR','source_error')
        print('Finished state',state,flush=True)
    results=[collected[c['number']] for c in courses]
    for r in results:
        r['geometrySource']='geofabrik-state-extract'
    CACHE.parent.mkdir(parents=True,exist_ok=True)
    with gzip.open(CACHE,'wt',encoding='utf-8') as f:json.dump(evidence,f,separators=(',',':'))
    summary={'studyId':roster['studyId'],'batch':1,'size':10,
        'sourceStatus':'regional_extract_attempted',
        'regionalSourceErrors':sum('error' in x for x in evidence['states'].values()),
        'sourceProvenance':'Geofabrik OpenStreetMap state extracts (ODbL)',
        'observedAt':prior.timestamp(),'geofabrikStates':evidence['states'],
        'previousOverpassAttempt':'HTTP 504 recorded in predecessor GitHub job 38159674910',
        'classificationCounts':dict(collections.Counter(r['classification'] for r in results)),
        'multiLabelBlockerCounts':dict(collections.Counter(code for r in results for code in set(r['failureCodes']))),
        'verifiedPlayableCount':0,'scorecardsVerifiedCount':0,
        'sourceCachePath':str(CACHE.relative_to(ROOT)),
        'sourceCacheSha256':hashlib.sha256(CACHE.read_bytes()).hexdigest(),
        'notes':'Geometry-only offline audit; no LiDAR or full imports, no official scorecards verified; success cannot be claimed yet.'}
    RESULT.write_text(json.dumps({'schemaVersion':'looper-gspro-osm-batch-results-v1','summary':summary,
        'results':results},indent=2,sort_keys=True)+'\n')
    print(json.dumps({'summary':summary,'courses':[{'n':r['number'],'name':r['gsproListingName'],
        'class':r['classification'],'routes':len(r['holeRouteRefsFound']),
        'teeHoles':sum(v>0 for v in r['holeTeePolygons'].values()),
        'failures':r['failureCodes']} for r in results]},indent=2),flush=True)
    return 0

if __name__=='__main__':
    raise SystemExit(main())
