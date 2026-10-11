#!/usr/bin/env python3
"""Read-only GSPro-list OSM coverage study, first frozen batch of ten.
Two bounded Overpass requests, no Nominatim bulk search, no DEM, no import.
Only a genuine scorecard verification may promote a course to A; this probe
deliberately never claims A or runtime readiness.
"""
from __future__ import annotations
import collections
import datetime as dt
import gzip
import hashlib
import json
import math
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
import build_osm_course_package_v6 as v6

ROSTER=ROOT/'research/course-coverage/gspro-osm-50-2026-10.json'
RESULTS=ROOT/'research/course-coverage/results/batch-01.json'
CACHE=ROOT/'research/course-coverage/source-cache/batch-01-osm.json.gz'
ENDPOINT='https://overpass-api.de/api/interpreter'
UA='TheLooper/0.1 (research course-coverage one-off; attribution https://www.openstreetmap.org/copyright)'
NAME_REGEX=r'En-Joie|Essex Fells|Liberty National|Hiawatha|Locust Valley|Longue Vue|Running Deer|Samoset|Sky Meadow|Golf Club of New England'
BOUNDS=(39.0,-81.0,47.0,-66.0)
MAX_BYTES=14000000

def timestamp():
    return dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00','Z')

def overpass(query):
    payload=urllib.parse.urlencode({'data':query}).encode()
    request=urllib.request.Request(ENDPOINT,data=payload,headers={
        'User-Agent':UA,'Accept':'application/json',
        'Content-Type':'application/x-www-form-urlencoded'},method='POST')
    with urllib.request.urlopen(request,timeout=175) as response:
        if response.status!=200: raise RuntimeError('Overpass HTTP '+str(response.status))
        raw=response.read(MAX_BYTES+1)
        if len(raw)>MAX_BYTES: raise RuntimeError('Overpass response exceeded limit')
    obj=json.loads(raw)
    if not isinstance(obj.get('elements'),list):raise RuntimeError('Overpass returned no element list')
    return obj

def normalized(name):
    return re.sub(r'[^a-z0-9]+',' ',name.lower()).strip()
def token_set(name):
    return set(normalized(name).split())-{'the','at','of','club','golf','course','gc','resort','links','country','landing'}
def coords(element):
    output=[]
    for node in element.get('geometry') or []:
        if 'lat' in node and 'lon' in node:output.append((float(node['lat']),float(node['lon'])))
    for member in element.get('members') or []:
        for node in member.get('geometry') or []:
            if 'lat' in node and 'lon' in node:output.append((float(node['lat']),float(node['lon'])))
    return output
def bbox(element,margin=.006):
    cs=coords(element)
    if not cs and element.get('center'):cs=[(element['center']['lat'],element['center']['lon'])]
    if not cs:return None
    return (min(x[0] for x in cs)-margin,min(x[1] for x in cs)-margin,max(x[0] for x in cs)+margin,max(x[1] for x in cs)+margin)
def within(pt,b):
    return b[0]<=pt[0]<=b[2] and b[1]<=pt[1]<=b[3]
def osm_payload(elements):
    return {'version':0.6,'generator':'Overpass API (bounded study snapshot)','elements':elements}
def tagcounts(elements):
    out=collections.Counter()
    for e in elements:
        t=e.get('tags') or {}
        if t.get('golf'):out['golf='+t['golf']]+=1
        if t.get('leisure')=='golf_course':out['leisure=golf_course']+=1
    return dict(sorted(out.items()))

def missing_record(course,reason,code,source_status):
    return {'number':course['number'],'gsproListingName':course['gsproListingName'],
        'city':course['city'],'state':course['state'],
        'osmCourseMatch':source_status,'osmCourseId':None,
        'holeRouteRefsFound':[],'missingHoleRefs':[],'duplicateHoleRefs':[],
        'holeTeePolygons':{},'holeTeeNodes':{},'teeOwnershipFailures':[],
        'teeSetsNamedFromOSM':[],'teeSetsVerifiedAgainstScorecard':[],
        'scorecardSource':None,'perTeeSet18HoleCoverage':{},
        'existingStrictValidatorPass':None,'strictTeeCandidateContractPass':None,
        'mapOnlyReady':None,'classification':'U_unverified' if code=='OSM_SOURCE_ERROR' else 'D_no_usable_osm',
        'failureCodes':[code], 'sourceObservedAt':timestamp(),'auditNotes':reason}

def nearest_venue(course,candidates):
    target=token_set(course['gsproListingName'])
    scored=[]
    for e in candidates:
        names=[(e.get('tags') or {}).get(k,'') for k in ['name','alt_name','short_name']]
        similarity=max((len(target & token_set(x))/max(1,len(target|token_set(x))) for x in names if x),default=0)
        if similarity>=.5:scored.append((similarity,e))
    scored.sort(key=lambda x:-x[0])
    if not scored:return None,'No matching OSM course boundary found under venue-name query'
    if len(scored)>1 and scored[0][0]-scored[1][0]<.09:
        return None,'Ambiguous OSM golf-course boundary matches: '+','.join(str(v[1].get('id')) for v in scored[:4])
    return scored[0][1],None

def survey(course,venue,features,source_at):
    rid={1:'dummy'} # prevent empty class from masquerading as success
    rec=missing_record(course,'', 'SCORECARD_UNVERIFIED','matched')
    rec['classification']='U_unverified'
    rec['failureCodes']=[]
    rec['osmCourseId']=str(venue['type'])+'/'+str(venue['id'])
    rec['osmCourseName']=(venue.get('tags') or {}).get('name')
    rec['sourceObservedAt']=source_at
    b=bbox(venue)
    rec['osmBbox']=list(b)
    scoped=[]
    for e in features:
        cs=coords(e)
        if cs and any(within(c,b) for c in cs):
            scoped.append(e)
    rec['rawNearbyGolfTags']=tagcounts(scoped)
    route_counter=collections.Counter()
    for e in scoped:
        t=e.get('tags') or {}
        if t.get('golf')=='hole' and str(t.get('ref','')).isdigit():
            route_counter[int(t['ref'])]+=1
    refs=sorted(n for n in route_counter if 1<=n<=18)
    rec['holeRouteRefsFound']=refs
    rec['missingHoleRefs']=[n for n in range(1,19) if n not in refs]
    rec['duplicateHoleRefs']=[n for n,c in route_counter.items() if c>1 and 1<=n<=18]
    if rec['missingHoleRefs']:rec['failureCodes'].append('HOLE_MISSING')
    if rec['duplicateHoleRefs']:rec['failureCodes'].append('HOLE_DUPLICATE')
    # Normalize via the existing Looper code, not a new parallel tee estimator.
    norm,routes=v6.normalize_osm(osm_payload(scoped))
    rec['rawTeePolygons']=sum(f['kind']=='tee' for f in norm)
    rec['rawTeeNodes']=sum(f['kind']=='tee-point' for f in norm)
    rec['mappedGreens']=sum(f['kind']=='green' for f in norm)
    rec['mappedFairways']=sum(f['kind']=='fairway' for f in norm)
    rec['holeTeePolygons']={str(n):0 for n in range(1,19)}
    rec['holeTeeNodes']={str(n):0 for n in range(1,19)}
    rec['holeTeeCandidates']={str(n):0 for n in range(1,19)}
    rec['teeAnchorMethods']={}
    rec['teeOwnershipFailures']=[]
    rec['teeSetsNamedFromOSM']=[]
    rec['teeSetsVerifiedAgainstScorecard']=[]
    rec['perTeeSet18HoleCoverage']={}
    rec['scorecardSource']=None
    rec['existingStrictValidatorPass']=None
    rec['mapOnlyReady']=None
    rec['missingGreenHoles']=[]
    rec['missingFairwayHoles']=[]
    rec['modelErrors']={}
    rec['holeModelPass']=False

    if len(refs)==18 and not rec['duplicateHoleRefs']:
        # Same generic geometric defaults used by the canonical importer.
        config={'courseId':'audit-only','courseName':course['gsproListingName'],
            'location':course['city']+', '+course['state'],
            'selection':{'teeStartRadiusYards':220,'contextRouteDistanceYards':90,
                         'fairwayCorridorYards':70,'hazardCorridorYards':70,
                         'geometrySimplifyYards':.25}}
        models={}
        for n in range(1,19):
            try:
                model,diag=v6.model_for_hole(n,config,norm,routes)
                models[n]=model
                rec['holeTeePolygons'][str(n)]=len((model.get('surfaces') or {}).get('tee') or [])
                rec['holeTeeNodes'][str(n)]=len(model.get('teePointEvidence') or [])
                rec['holeTeeCandidates'][str(n)]=len(model.get('teeCandidates') or [])
                rec['teeAnchorMethods'][str(n)]=(model.get('coordinateFrame') or {}).get('teeAnchorMethod')
                if not (model.get('surfaces') or {}).get('green'):rec['missingGreenHoles'].append(n)
                if model.get('par')!=3 and not (model.get('surfaces') or {}).get('fairway'):rec['missingFairwayHoles'].append(n)
            except Exception as error:
                rec['modelErrors'][str(n)]=type(error).__name__+': '+str(error)[:200]
        rec['holeModelPass']=len(models)==18
        if rec['holeModelPass']:
            tee_sets=models[1].get('teeSetContract',{}).get('teeSets',[])
            rec['modelInferredTeeSets']=tee_sets
            for tee in tee_sets:
                covered=sum(1 for m in models.values() if sum(1 for x in m.get('teeCandidates',[]) if tee in ([x.get('teeSet')]+(x.get('teeAliases') or [])))==1)
                rec['perTeeSet18HoleCoverage'][tee]=covered
            rec['strictTeeCandidateContractPass']=(all(rec['holeTeePolygons'][str(n)]>0 for n in range(1,19)) and
                len(tee_sets)>0 and all(c==18 for c in rec['perTeeSet18HoleCoverage'].values()))
            tagged=set()
            for f in norm:
                if f['kind']=='tee':
                    tags=f.get('source_tags') or {}
                    label=next((tags.get(k) for k in ('tee','name','ref','colour','color') if tags.get(k)),None)
                    if label:tagged.add(label)
            rec['teeSetsNamedFromOSM']=sorted(tagged)
        else:rec['strictTeeCandidateContractPass']=False
    else:
        rec['strictTeeCandidateContractPass']=False
    if any(v==0 for v in rec['holeTeePolygons'].values()):
        rec['failureCodes'].append('TEE_POLYGON_MISSING')
    if rec['rawTeeNodes'] and not rec['rawTeePolygons']:rec['failureCodes'].append('TEE_NODE_ONLY')
    if rec['rawTeePolygons'] and sum(rec['holeTeeCandidates'].values()) < rec['rawTeePolygons']:
        rec['failureCodes'].append('TEE_OWNERSHIP_REJECTED')
        rec['teeOwnershipFailures'].append('Some nearby OSM tee polygons were not accepted as per-hole candidates; see per-hole inventories')
    if not rec['teeSetsNamedFromOSM']:rec['failureCodes'].append('TEE_IDENTITY_MISSING')
    if rec['missingGreenHoles']:rec['failureCodes'].append('GREEN_MISSING')
    if rec['missingFairwayHoles']:rec['failureCodes'].append('FAIRWAY_MISSING')
    if rec['modelErrors']:rec['failureCodes'].append('RUNTIME_CONTRACT_ERROR')
    rec['failureCodes'].append('SCORECARD_UNVERIFIED')
    if rec['holeModelPass'] and not rec['missingGreenHoles'] and sum(v>0 for v in rec['holeTeePolygons'].values())>=15:
        rec['classification']='B_near_usable'
    elif rec['holeModelPass']:
        rec['classification']='C_incomplete'
    else:
        rec['classification']='C_incomplete' if refs else 'D_no_usable_osm'
    rec['auditNotes']='Geometry-only, read-only preflight; scorecard and full runtime/terrain NOT validated.'
    return rec

def main():
    roster=json.loads(ROSTER.read_text())
    courses=roster['courses'][:10]
    if [c['number'] for c in courses]!=list(range(1,11)):raise SystemExit('Frozen roster mismatch')
    RESULTS.parent.mkdir(parents=True,exist_ok=True)
    CACHE.parent.mkdir(parents=True,exist_ok=True)
    started=timestamp()
    evidence={}
    try:
        query='[out:json][timeout:155];nwr["leisure"="golf_course"]["name"~"'+NAME_REGEX+'",i](39,-81,47,-66);out geom center;'
        discovered=overpass(query)
        evidence['discovery']=discovered
        venues=[x for x in discovered['elements'] if (x.get('tags') or {}).get('leisure')=='golf_course']
        choices={}
        for c in courses:
            venue,reason=nearest_venue(c,venues)
            choices[c['number']]=(venue,reason)
        bounds=[bbox(v) for v,_ in choices.values() if v is not None and bbox(v)]
        if bounds:
            # Union of individual course-sized boxes; NOT a broad Northeast extract.
            pieces=['nwr["golf"~"^(hole|tee|green|fairway|rough|bunker|water_hazard|lateral_water_hazard)$"]('+','.join(str(round(x,6)) for x in b)+');' for b in bounds]
            feature_query='[out:json][timeout:155];('+''.join(pieces)+');out geom center;'
            observed=overpass(feature_query)
            evidence['features']=observed
            features=observed['elements']
        else:features=[]
        taken=timestamp()
        results=[]
        for c in courses:
            venue,reason=choices[c['number']]
            if venue is None:
                code='GSPro_NAME_AMBIGUOUS' if reason and reason.startswith('Ambiguous') else 'OSM_COURSE_NOT_FOUND'
                results.append(missing_record(c,reason or '',code,'ambiguous' if code=='GSPro_NAME_AMBIGUOUS' else 'not_found'))
            else:results.append(survey(c,venue,features,taken))
        status='source_ok'
    except Exception as ex:
        # Fail closed: provider errors are NOT missing OSM data.
        status='source_error'
        description=type(ex).__name__+': '+str(ex)[:450]
        results=[missing_record(c,description,'OSM_SOURCE_ERROR','source_error') for c in courses]
        evidence['sourceError']=description
    failure_counts=collections.Counter(code for r in results for code in set(r['failureCodes']))
    classifications=collections.Counter(r['classification'] for r in results)
    summary={'studyId':roster['studyId'],'batch':1,'sourceStatus':status,
        'size':10,'observedAt':timestamp(),'startedAt':started,
        'classificationCounts':dict(classifications),
        'multiLabelBlockerCounts':dict(failure_counts),
        'verifiedPlayableCount':sum(r['classification']=='A_verified_usable' for r in results),
        'scorecardsVerifiedCount':sum(bool(r['teeSetsVerifiedAgainstScorecard']) for r in results),
        'notes':'No LiDAR fetch or full course import. Do not infer national coverage from this sample.'}
    with gzip.open(CACHE,'wt',encoding='utf-8') as fp:json.dump(evidence,fp,separators=(',',':'))
    summary['sourceCacheSha256']=hashlib.sha256(CACHE.read_bytes()).hexdigest()
    summary['sourceCachePath']=str(CACHE.relative_to(ROOT))
    output={'schemaVersion':'looper-gspro-osm-batch-results-v1','summary':summary,'results':results}
    RESULTS.write_text(json.dumps(output,indent=2,sort_keys=True)+'\n')
    print(json.dumps(summary,indent=2,sort_keys=True))
    for r in results:
        print('{:02d} {:38s} {:16s} {:3d}/18 tee holes; {:3d} hole lines; {}'.format(
            r['number'],r['gsproListingName'],r['classification'],
            sum(v>0 for v in r.get('holeTeePolygons',{}).values()),
            len(r['holeRouteRefsFound']),','.join(r['failureCodes'])))
    # Gracefully checkpoint provider errors; no retries, no false absent records.
    return 0

if __name__=='__main__':
    raise SystemExit(main())
