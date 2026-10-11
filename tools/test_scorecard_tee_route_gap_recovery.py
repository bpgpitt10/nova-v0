#!/usr/bin/env python3
"""Compare current tee ownership against evidence-only near-route recovery.
Never writes playable course geometry. Recovered tees are UNVERIFIED evidence.
"""
import gzip,json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
import build_osm_course_package as base
import build_osm_course_package_v5 as v5
import build_osm_course_package_v6 as v6
from match_scorecard_tees import CACHE,SCORECARD,match_hole

OUTPUT=ROOT/'research/course-coverage/results/gcne-evidence-only-tee-recovery-v1.json'

def main():
    with gzip.open(CACHE,'rt',encoding='utf8') as f:source=json.load(f)['snapshots']['10']['elements']
    score=json.loads(SCORECARD.read_text())
    feat,routes=v6.normalize_osm({'elements':source})
    tees=[f for f in feat if f['kind']=='tee']
    greens=[f for f in feat if f['kind']=='green']
    cfg={'courseId':'gcne-recovery-research','courseName':'GCNE','location':'NH',
      'selection':{'teeStartRadiusYards':220,'contextRouteDistanceYards':90,
        'fairwayCorridorYards':70,'hazardCorridorYards':70,
        'geometrySimplifyYards':.25}}
    contexts={}
    base_models={}
    research_models={}
    restored={}
    for h in range(1,19):
        context=v6._owned_tee_context(h,cfg,feat,routes)
        model,_=v6.model_for_hole(h,cfg,feat,routes)
        route=context['route']
        _,near=v5.tee_anchor_for_hole(h,route,tees,routes,220)
        original_ids={c['osmId'] for c in model.get('teeCandidates') or []}
        candidates=list(model.get('teeCandidates') or [])
        added=[]
        for entry in near:
            if entry['ownedByCurrentHole'] or entry['osmId'] in original_ids:continue
            if entry['nearestRouteHole']!=h or entry['currentRouteGapYards']>65:continue
            f=entry['feature']
            c={
                'osmId':f['osm_id'],'sourceLatLon':[float(n) for n in f['centroid']],
                'teeToGreenCentroidYards':round(base.haversine_yards(f['centroid'],context['targetGreen']['centroid']),2),
                'sourceTags':f.get('source_tags') or {},
                'notApprovedForRuntime':True,
                'researchEvidenceReason':'same-nearest-hole but more than original 35yd route-gap threshold',
            }
            added.append({'osmId':entry['osmId'],'currentRouteGapYards':round(entry['currentRouteGapYards'],1),
                'teeToGreenCentroidYards':c['teeToGreenCentroidYards']})
            candidates.append(c)
        contexts[h]=context
        base_models[h]=model
        research_models[h]={**model,'teeCandidates':candidates}
        if added:restored[str(h)]=added
    subsetnames=[['Green','Blue'],['Blue','Red','White'],['Green','Blue','Red','White']]
    studies=[]
    for names in subsetnames:
        subset=[t for t in score['teeSets'] if t['name'] in names]
        a=[match_hole(subset,base_models,contexts[h],h,score['pars'][h-1]) for h in range(1,19)]
        b=[match_hole(subset,research_models,contexts[h],h,score['pars'][h-1]) for h in range(1,19)]
        counts={}
        for t in subset:
            name=t['name']
            before=sum(r['mapping'][name]['status']=='provisional_unique_match' for r in a)
            after=sum(r['mapping'][name]['status']=='provisional_unique_match' for r in b)
            restored_ids={p['osmId'] for rows in restored.values() for p in rows}
            used_restored=[r['hole'] for r in b if r['mapping'][name].get('osmId') in restored_ids]
            counts[name]={'baseUnambiguous':before,'researchUnambiguous':after,
                'holesUsingUnverifiedRecoveredTee':used_restored,
                'all18Verified':False}
        studies.append({'evaluatedNames':names,'teeCoverage':counts})
    data={'schemaVersion':'looper-tee-ownership-expansion-evidence-v1',
         'source':'cached OSM; no source/terrain requests',
         'currentOwnershipRouteGapYds':35,'researchMaxSameHoleRouteGapYds':65,
         'recoveredUnverifiedPolygons':restored,'studies':studies,
         'crossHoleReassignmentAllowed':False,'liveReady':False,
         'policy':'Recovered tee polygons remain evidence only; review hole association, scorecard differences, and competing-route proximity before approval.'}
    OUTPUT.write_text(json.dumps(data,indent=2,sort_keys=True)+'\n')
    print('Recovery evidence by hole:',restored)
    for study in studies:
        print(study['evaluatedNames'],study['teeCoverage'])
    print('Saved',OUTPUT)

if __name__=='__main__':main()
