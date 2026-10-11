#!/usr/bin/env python3
"""Diagnose owned vs nearby rejected OSM tee polygons on GCNE focus holes.
Does not create or accept any new coordinates. No provider calls.
"""
import gzip,json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
import build_osm_course_package as base
import build_osm_course_package_v5 as v5
import build_osm_course_package_v6 as v6
from match_scorecard_tees import CACHE,SCORECARD
OUT=ROOT/'research/course-coverage/results/gcne-tee-ownership-diagnostic-v1.json'
def main():
    source=json.loads(gzip.open(CACHE,'rt',encoding='utf8').read())['snapshots']['10']['elements']
    features,routes=v6.normalize_osm({'elements':source})
    score=json.loads(SCORECARD.read_text())
    greens=[f for f in features if f['kind']=='green']
    tees=[f for f in features if f['kind']=='tee']
    results=[]
    for hole in [5,11,12,14,16,17,18]:
        route,target,*_=v5.orient_route_to_green(routes[hole],greens)
        selected, all220=v5.tee_anchor_for_hole(hole,route,tees,routes,220)
        _,all400=v5.tee_anchor_for_hole(hole,route,tees,routes,400)
        owned=[x for x in all220 if x['ownedByCurrentHole']]
        rejected=[x for x in all400 if not x['ownedByCurrentHole']]
        rejected.sort(key=lambda x:(x['currentRouteGapYards'],x['startPolygonGapYards']))
        data={
            'hole':hole,'par':score['pars'][hole-1],
            'officialPublishedYards':{x['name']:x['holeYards'][hole-1] for x in score['teeSets']},
            'ownedMappedTees':len(owned),
            'nearbyRejected220':len([x for x in all220 if not x['ownedByCurrentHole']]),
            'nearbyRejected400':len(rejected),
            'selectedOsmId':selected['osm_id'] if selected else None,
            'acceptedTeePoints':[{
                'osmId':x['osmId'],
                'startGapYards':round(x['startPolygonGapYards'],1),
                'routeGapYards':round(x['currentRouteGapYards'],1),
                'straightGreenYards':round(base.haversine_yards(x['feature']['centroid'],target['centroid']),1),
                'sourceTags':{k:v for k,v in (x['feature'].get('source_tags') or {}).items() if k in ('tee','name','ref','colour','color')},
                } for x in owned],
            'nearbyRejectedEvidence':[{
                'osmId':x['osmId'],
                'startGapYards':round(x['startPolygonGapYards'],1),
                'currentRouteGapYards':round(x['currentRouteGapYards'],1),
                'nearestRouteHole':x['nearestRouteHole'],
                'nearestRouteGapYards':round(x['nearestRouteGapYards'],1),
                'straightGreenYards':round(base.haversine_yards(x['feature']['centroid'],target['centroid']),1),
                } for x in rejected[:20]],
        }
        results.append(data)
        print('H',hole,'owned',len(owned),'rejected within 220',data['nearbyRejected220'],
              'rejected within 400',len(rejected),flush=True)
        for x in data['nearbyRejectedEvidence'][:8]:
            print('  excluded',x['osmId'],'route gap',x['currentRouteGapYards'],
                  'nearest route hole',x['nearestRouteHole'],'green',x['straightGreenYards'],flush=True)
    OUT.write_text(json.dumps({'schemaVersion':'looper-gcne-tee-ownership-research-v1',
        'source':'cached OSM Geofabrik extract; route ownership per existing v5 code',
        'holes':results,'noImportedOrAlteredTeePolygons':True},indent=2,sort_keys=True)+'\n')
if __name__=='__main__':main()
