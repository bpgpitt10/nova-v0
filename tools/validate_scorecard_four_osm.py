#!/usr/bin/env python3
"""Scorecard-versus-OSM evidence on four preselected strong batch-01 courses.

Read-only; works entirely from committed cached OSM features. Published tee
names/lengths are reference facts, NOT permission to relabel source polygons.
Green-centroid aerial distances are diagnostics, never a scorecard substitute.
"""
from __future__ import annotations
import datetime as dt
import gzip, json, statistics, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
import build_osm_course_package_v6 as v6

CACHE=ROOT/'research/course-coverage/source-cache/batch-01-geofabrik.json.gz'
OUT=ROOT/'research/course-coverage/results/tee-scorecard-four-v1.json'
REFERENCE={
  '4':{
    'name':'Links at Hiawatha Landing',
    'source':'https://www.hiawathalinks.com/golf-course/course-information/layout-scorecard',
    'sourceType':'official_scorecard_image',
    'tees':{'Championship':7104,'Back':6586,'Middle':6195,'Forward':5801,'Front':5101},
    'par':72,
    'perHoleYards':{},
    'notes':'Five named distances confirmed on official front/back nine images. Some handwritten numbers on card have corrections; do not assume unsourced per-hole rows.',
  },
  '7':{
    'name':'Running Deer Golf Club',
    'source':'https://runningdeergolfclub.com/course-details/',
    'sourceType':'official_course_website',
    'tees':{'Black':7024,'Blue':6601,'White':6270,'Gold':5681,'Red':4833},
    'par':72,
    'perHoleYards':{'Black':{'1':394,'2':490,'3':380,'4':520,'13':243}},
    'notes':'Official web page provides the five named totals and approximate selected-hole tip distances. Official scorecard card image has additional combo/split tees and rates; numbers cannot be treated as exact per-hole geometry.',
  },
  '8':{
    'name':'Samoset Golf Resort',
    'source':'https://www.opalcollection.com/samoset/golf/',
    'sourceType':'official_course_website',
    'tees':{'Gold':None},
    'par':None,
    'perHoleYards':{'Gold':{'14':545}},
    'conflictSources':[
      'https://gcr.foretee.com/golf-course-scorecard/maine/rockport/usa/samoset-resort-golf-course/6545/',
      'https://zommagolf.com/courses/me/samoset-resort',
    ],
    'notes':'Official resort calls H14 a 545-yard Gold par 5. Unaffiliated scorecard sources materially disagree on hole pars and totals; do not ingest those as canonical.',
  },
  '10':{
    'name':'The Golf Club of New England',
    'source':'https://golfclubne.com/getmedia/9090d63e-a9b9-40fb-806e-b2f8adea8aef/Scorecard_Outside.aspx',
    'sourceType':'official_scorecard_pdf',
    'tees':{'Black':7673,'USGA JR AM':7178,'Green':7024,'Blue':6561,
            'Red':6139,'White':5797,'Gold/White':5313,'Gold':4802},
    'par':72,
    'perHoleYards':{
      'Black': [469,386,549,480,600,223,447,250,457,574,377,437,394,216,609,475,221,509],
      'Green': [429,362,513,427,572,206,412,214,419,523,350,428,385,175,582,418,168,441],
      'Blue': [400,337,491,393,546,176,384,202,380,480,332,413,376,151,554,380,159,407],
      'Red': [379,312,491,393,530,160,340,178,342,480,294,380,318,140,514,370,148,370],
      'White': [355,285,461,355,517,156,334,178,296,439,274,343,318,130,504,334,148,370],
      'Gold': [272,197,404,295,423,131,262,120,217,374,239,322,270,101,460,303,76,336],
    },
    'par3Holes':[6,8,14,17],
    'notes':'Official PDF includes eight separately named lines, some using shared physical tees or split tee combinations. Our OSM compiler infers six generic course-wide tee slots, so simple rank-based label mapping is incomplete.',
  },
}

def main():
    with gzip.open(CACHE,'rt',encoding='utf8') as f:cache=json.load(f)
    snapshots=cache.get('snapshots') or {}
    report={'schemaVersion':'looper-osm-official-scorecard-spotcheck-v1','observedAt':'2026-10-11',
        'method':'Cached OSM geometry v6 tee candidates compared with separately published official tee names/yardages; no edits and no external API calls',
        'courseChecks':[]}
    for n,source in REFERENCE.items():
        snapshot=snapshots.get(n)
        if not snapshot:raise RuntimeError('Missing OSM source cache for study roster item '+n)
        features,routes=v6.normalize_osm({'elements':snapshot['elements']})
        models={}
        failures={}
        config={'courseId':'audit-'+n,'courseName':source['name'],'location':'cached',
            'selection':{'teeStartRadiusYards':220,'contextRouteDistanceYards':90,
                         'fairwayCorridorYards':70,'hazardCorridorYards':70,
                         'geometrySimplifyYards':.25}}
        for hole in range(1,19):
            try:models[hole]=v6.model_for_hole(hole,config,features,routes)[0]
            except Exception as e:failures[str(hole)]=type(e).__name__+': '+str(e)[:220]
        reference={k:v for k,v in source.items() if k not in {'perHoleYards'}}
        comp={'rosterNumber':int(n),'course':source['name'],'officialReference':reference,
            'sourceGeometryHoleCount':len(routes),'modeledHoleCount':len(models),
            'modelErrors':failures,'validRealTeeSetMatched':False,
            'publishedNamedTeeCount':len(source['tees']),
            'modelGenericSlots':models.get(1,{}).get('teeSetContract',{}).get('teeSets',[]),
            'holeTeeCandidateCount':{str(h):len(m.get('teeCandidates',[])) for h,m in models.items()},
            'holeTeePhysicalPolygons':{str(h):len((m.get('surfaces') or {}).get('tee') or []) for h,m in models.items()},
            'scorecardComparisonType':'reference comparison only; no coordinates verified against named real tee sets'}
        comp['genericSlotCount']=len(comp['modelGenericSlots'])
        comp['namedTeeCountDifference']=len(source['tees'])-comp['genericSlotCount']
        comp['holesWithTees']=sum(v>0 for v in comp['holeTeeCandidateCount'].values())
        comp['holeCandidates']= {}
        par3s=set(source.get('par3Holes') or [])
        for hole in range(1,19):
            m=models.get(hole)
            if not m:continue
            candidates=m.get('teeCandidates') or []
            # Show distances for a few par-3s and anchor H1/H18.
            if hole in par3s or hole in {1,18}:
                comp['holeCandidates'][str(hole)]=[
                    {'osmId':c.get('osmId'),'distanceToGreenCentroidYds':c.get('teeToGreenCentroidYards'),
                     'genericTeeSet':c.get('teeSet'),'genericTeeAliases':c.get('teeAliases'),
                     'rawTags':{key:value for key,value in (c.get('sourceTags') or {}).items() if key in ('tee','name','ref','color','colour')}}
                    for c in candidates]
        # On par-3s a straight-line tee-to-green-centroid comparison is meaningful,
        # but still cannot prove club yardages or assigned tee colors.
        if par3s:
            comparisons={}
            for tee,vals in source.get('perHoleYards',{}).items():
                if not isinstance(vals,list):continue
                observations=[]
                for hole in sorted(par3s):
                    cands=models.get(hole,{}).get('teeCandidates') or []
                    closest=min((abs(float(c['teeToGreenCentroidYards'])-vals[hole-1]),c)
                                for c in cands if c.get('teeToGreenCentroidYards') is not None) if cands else None
                    if closest:
                        observations.append({'hole':hole,'publishedYards':vals[hole-1],
                             'closestPhysicalTeeOsmId':closest[1].get('osmId'),
                             'closestDistanceToGreenCentroidYds':closest[1].get('teeToGreenCentroidYards'),
                             'absoluteDifferenceYds':round(closest[0],1)})
                comparisons[tee]={'sample':observations,'sampleCount':len(observations),
                    'medianMinAbsoluteDifferenceYds':round(statistics.median(v['absoluteDifferenceYds'] for v in observations),1) if observations else None}
            comp['par3NearestAnyTeeDiagnostic']=comparisons
        if n=='8':
            hole14=models.get(14,{})
            comp['officialHole14GoldVsAnyOSMTee']={
                'publishedGoldYards':545,
                'candidateGreenCentroidYards':[c.get('teeToGreenCentroidYards') for c in hole14.get('teeCandidates',[])],
                'caveat':'Par-5 dogleg published yardage is NOT interchangeable with tee-to-green straight line'}
        if n=='7':
            comp['officialTotalsVsGenericSlots']='Five published single-color tee sets, but OSM product model has six inferred generic tee slots; no evidence of one-to-one equivalence.'
        comp['decision']='NOT_VERIFIED: named tee-to-position matching remains unproven.'
        report['courseChecks'].append(comp)
    OUT.parent.mkdir(parents=True,exist_ok=True)
    OUT.write_text(json.dumps(report,indent=2,sort_keys=True)+'\n',encoding='utf-8')
    for c in report['courseChecks']:
        print(c['course'],'published tee identities',c['publishedNamedTeeCount'],
              'generic inferred slots',c['genericSlotCount'],
              'mapped physical tee holes',c['holesWithTees'],'=>',c['decision'])
        for tee,diagnostic in c.get('par3NearestAnyTeeDiagnostic',{}).items():
            print(' ',tee,'par3 sample',diagnostic['sampleCount'],'median closest OSM tee delta',diagnostic['medianMinAbsoluteDifferenceYds'])
    print('Wrote',OUT)
if __name__=='__main__':main()
