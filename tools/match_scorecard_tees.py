#!/usr/bin/env python3
"""Research-only scorecard-to-OSM tee matching with tee-level exclusion.

No tee set is automatically approved for live play. For each hole a monotone
assignment matches official named tee distances to distinct real OSM polygons;
shared pads are permitted for similar published yardages. Scorecard-vs-geometry
differences, offsets and alternative equally plausible pads are reported.
Works on the existing cached OSM snapshot, no network / LiDAR.

The algorithm does not guess a tee polygon where none exists. It can find
plausible subsets without requiring all course scorecard tee sets to match.
"""
from __future__ import annotations
from collections import Counter
from functools import lru_cache
import gzip, json, math, statistics, sys
from pathlib import Path
from shapely.geometry import LineString, Point

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
import build_osm_course_package as base
import build_osm_course_package_v6 as v6

CACHE=ROOT/'research/course-coverage/source-cache/batch-01-geofabrik.json.gz'
SCORECARD=ROOT/'research/course-coverage/scorecards/gcne-official-six-tees-v1.json'
OUTPUT=ROOT/'research/course-coverage/results/gcne-partial-tee-matcher-v1.json'

def estimated_playing_yards(candidate, context, is_par_three):
    straight=float(candidate['teeToGreenCentroidYards'])
    if is_par_three:
        return round(straight,2)
    route=context['route']['geometry']
    if len(route)<2:
        return round(straight,2)
    origin=route[0]
    points=[base.local_east_north_yards(pt,origin) for pt in route]
    path=LineString(points)
    source=tuple(candidate['sourceLatLon'])
    tee=Point(base.local_east_north_yards(source,origin))
    station=path.project(tee)
    connector=tee.distance(path.interpolate(station))
    end_gap=base.haversine_yards(route[-1],context['targetGreen']['centroid'])
    along=connector+(path.length-station)+end_gap
    # A route that doubles back behind its origin is not an authoritative
    # playing-distance scorecard; still preserve both route and direct metrics.
    return round(along,2)

def assign_for_offset(published, candidates, offset, par, include_alternates=True):
    """Monotone scorecard color order -> ordered physical tee indices or None."""
    max_deviation=16 if par==3 else 28
    unassigned_cost=35 if par==3 else 42
    geom=[c['routeEstimateYds'] for c in candidates]
    n=len(candidates)
    @lru_cache(None)
    def go(t, prev):
        if t==len(published):
            return 0.0, ()
        best_cost,best_indices=go(t+1,prev)
        best_cost+=unassigned_cost
        best_indices=(None,)+best_indices
        for j in range(prev,n):
            gap=abs(published[t]-(geom[j]+offset))
            if gap>max_deviation:
                continue
            shared=prev==j and t>0
            score_diff=abs(published[t]-published[t-1]) if t else 0
            # A tee pad cannot plausibly represent two colors 30+ yards apart.
            if shared and score_diff>20:
                continue
            shared_cost=(3+score_diff*.2) if shared else 0
            rest_cost,rest=go(t+1,j)
            current=gap+shared_cost+rest_cost
            if current<best_cost-1e-8:
                best_cost,best_indices=current,(j,)+rest
        return best_cost,best_indices
    cost,indices=go(0,0)
    return cost,indices

def match_hole(tees, models, context, hole, par):
    published=[t['holeYards'][hole-1] for t in tees]
    cands=[]
    for c in models[hole].get('teeCandidates') or []:
        item={
            'osmId':c.get('osmId'),
            'sourceLatLon':c.get('sourceLatLon'),
            'directYards':round(float(c.get('teeToGreenCentroidYards') or 0),1),
            'routeEstimateYds':estimated_playing_yards(c,context,par==3),
            'sourceTags':{k:v for k,v in (c.get('sourceTags') or {}).items() if k in ('tee','name','ref','colour','color')},
        }
        cands.append(item)
    # Geometry is ordered tip-to-forward by estimated *playing* route, not
    # candidate list order, and never by OSM object ID.
    cands.sort(key=lambda c:(-c['routeEstimateYds'],str(c['osmId'])))
    if not cands:
        return {'hole':hole,'par':par,'status':'no_physical_tee','candidates':[],
            'mapping':{t['name']:{'status':'no_physical_tee','osmId':None} for t in tees}}
    bound=35 if par==3 else 90
    offsets={0.0}
    for length in published:
        for candidate in cands:
            shift=length-candidate['routeEstimateYds']
            if abs(shift)<=bound:
                offsets.add(round(shift,1))
    best=None
    for shift in sorted(offsets):
        cost,assignment=assign_for_offset(published,cands,shift,par)
        # Avoid overfitting / made-up scorecard offsets.
        adjusted=cost+abs(shift)*(.22 if par==3 else .10)
        val=(round(adjusted,4),abs(shift),shift,assignment)
        if best is None or val[:3]<best[:3]:
            best=val
    _,_,shift,assignment=best
    min_threshold=11 if par==3 else 20
    warn_offset=27 if par==3 else 70
    output={}
    for t,tee in enumerate(tees):
        i=assignment[t]
        if i is None:
            output[tee['name']]={'status':'unsupported_no_match','osmId':None,
                'publishedYards':published[t],'reasons':['NO_MATCH_WITHIN_DISTANCE_WINDOW']}
            continue
        candidate=cands[i]
        residual=round(published[t]-(candidate['routeEstimateYds']+shift),1)
        close=[
            c for j,c in enumerate(cands)
            if j!=i and abs(published[t]-(c['routeEstimateYds']+shift))<=abs(residual)+8
        ]
        reasons=[]
        if abs(residual)>min_threshold:reasons.append('DISTANCE_RESIDUAL_HIGH')
        if abs(shift)>warn_offset:reasons.append('LARGE_HOLE_DISTANCE_OFFSET')
        if close:reasons.append('ALTERNATIVE_PAD_ALMOST_AS_CLOSE')
        if (t>0 and i==assignment[t-1] and abs(published[t]-published[t-1])>15):
            reasons.append('SHARED_PAD_BUT_DISTINCT_SCORECARD_YARDAGES')
        status='provisional_unique_match' if not reasons else 'ambiguous'
        output[tee['name']]={
            'status':status,'osmId':candidate['osmId'],
            'publishedYards':published[t],
            'directToGreenCentroidYards':candidate['directYards'],
            'routeEstimateYards':candidate['routeEstimateYds'],
            'holeDistanceOffsetYards':shift,
            'residualYards':residual,
            'alternativeOsmIds':[c['osmId'] for c in close],
            'reasons':reasons}
    return {'hole':hole,'par':par,'status':'matched_with_cautions','candidates':cands,
        'fitOffsetYards':shift,'mapping':output}

def run():
    with gzip.open(CACHE,'rt',encoding='utf-8') as fp:
        source=json.load(fp)
    snapshot=(source.get('snapshots') or {}).get('10')
    if not snapshot:
        raise RuntimeError('No cached GCNE geometry in first-ten source evidence')
    score=json.loads(SCORECARD.read_text())
    tees=score['teeSets']
    assert len(tees)>=2 and all(len(t['holeYards'])==18 for t in tees)
    assert all(sum(t['holeYards'])==t['advertisedPlayingYards'] for t in tees)
    features,routes=v6.normalize_osm({'elements':snapshot['elements']})
    assert len(routes)==18
    config={'courseId':'gcne-diagnostic','courseName':score['course'],'location':'Stratham, NH',
        'selection':{'teeStartRadiusYards':220,'contextRouteDistanceYards':90,
                     'fairwayCorridorYards':70,'hazardCorridorYards':70,
                     'geometrySimplifyYards':.25}}
    models={}
    contexts={}
    for hole in range(1,19):
        models[hole],_=v6.model_for_hole(hole,config,features,routes)
        contexts[hole]=v6._owned_tee_context(hole,config,features,routes)
    per_hole=[match_hole(tees,models,contexts[n],n,score['pars'][n-1]) for n in range(1,19)]
    per_tee=[]
    for t in tees:
        name=t['name']
        good=[r for r in per_hole if r['mapping'][name]['status']=='provisional_unique_match']
        bad=[{'hole':r['hole'],'status':r['mapping'][name]['status'],
              'reasons':r['mapping'][name].get('reasons',[])} for r in per_hole
             if r['mapping'][name]['status']!='provisional_unique_match']
        metrics=[abs(r['mapping'][name]['residualYards']) for r in good]
        per_tee.append({
            'name':name,'scorecardTotalYards':t['advertisedPlayingYards'],
            'provisionalUniqueHoles':len(good),'unresolvedHoles':bad,
            'medianResidualOnUniqueHolesYds':round(statistics.median(metrics),1) if metrics else None,
            # An approved tee requires a reviewed full 18-hole mapping, not 50%
            # coverage and not a guess on the missing holes.
            'researchEligibility':'full_18_hole_candidate_review' if len(good)==18 else 'excluded_pending_resolution',
            'liveSelectable':False,
        })
    result={'schemaVersion':'looper-generic-tee-matching-research-v1',
        'courseId':'golf-club-of-new-england',
        'sourceScorecard':str(SCORECARD.relative_to(ROOT)),
        'osmCache':str(CACHE.relative_to(ROOT)),
        'totalCourseHoles':18,'teeSetPolicy':{
           'partialSupportAllowed':True,
           'minimumUnambiguousHolesPerSupportedSet':18,
           'unsupportedSets':'exclude from Looper Round Setup',
           'liveRegistrationRequiresIndependentReview':True,
           'algorithmDoesNotPublishOrModifyRuntime':True},
        'perTeeSet':per_tee,'holes':per_hole}
    OUTPUT.parent.mkdir(parents=True,exist_ok=True)
    OUTPUT.write_text(json.dumps(result,indent=2,sort_keys=True)+'\n')
    for t in per_tee:
        print(f"{t['name']:7} matched {t['provisionalUniqueHoles']}/18, status={t['researchEligibility']}, unresolved={[b['hole'] for b in t['unresolvedHoles']]}",flush=True)
    print('Saved',OUTPUT,flush=True)

if __name__=='__main__':
    run()
