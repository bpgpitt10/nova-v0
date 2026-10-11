#!/usr/bin/env python3
"""Find maximal independently supportable named tee subsets.

Do not force a missing Gold/Black physical box into a shared course fit.
Every proposed supported set must have its own physical OSM candidate
for all 18 holes, with each ambiguity reported. This stage remains a
research diagnostic, not permission to publish playable choices.
"""
from __future__ import annotations
from collections import Counter
from itertools import combinations
import gzip,json,statistics,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
import build_osm_course_package_v6 as v6
from match_scorecard_tees import match_hole,CACHE,SCORECARD

OUTPUT=ROOT/'research/course-coverage/results/gcne-independent-tee-subsets-v1.json'
def main():
    source=json.loads(gzip.open(CACHE,'rt',encoding='utf8').read())
    snapshot=source['snapshots']['10']
    score=json.loads(SCORECARD.read_text())
    features,routes=v6.normalize_osm({'elements':snapshot['elements']})
    cfg={'courseId':'gcne-diagnostic','courseName':score['course'],'location':'NH',
         'selection':{'teeStartRadiusYards':220,'contextRouteDistanceYards':90,
                      'fairwayCorridorYards':70,'hazardCorridorYards':70,'geometrySimplifyYards':.25}}
    models={}
    contexts={}
    for n in range(1,19):
        models[n],_=v6.model_for_hole(n,cfg,features,routes)
        contexts[n]=v6._owned_tee_context(n,cfg,features,routes)
    results=[]
    tees=score['teeSets']
    for size in range(2,len(tees)+1):
        for combo in combinations(tees,size):
            match=[match_hole(combo,models,contexts[n],n,score['pars'][n-1]) for n in range(1,19)]
            by_tee=[]
            for tee in combo:
                name=tee['name']
                accepted={str(x['hole']):x['mapping'][name]['osmId'] for x in match if x['mapping'][name]['status']=='provisional_unique_match'}
                unresolved=[{'hole':x['hole'],'reasons':x['mapping'][name].get('reasons',[])}
                            for x in match if x['mapping'][name]['status']!='provisional_unique_match']
                by_tee.append({'name':name,'unambiguousCount':len(accepted),
                               'coveredHoleIds':accepted,'unresolved':unresolved})
            full=[x['name'] for x in by_tee if x['unambiguousCount']==18]
            results.append({
                'evaluatedTeeSets':[x['name'] for x in combo],
                'all18SupportedSubset':len(full)==len(combo),
                'full18ProvisionalTees':full,
                'minimumCoverage':min(x['unambiguousCount'] for x in by_tee),
                'totalUnambiguousAssignments':sum(x['unambiguousCount'] for x in by_tee),
                'perTeeSet':by_tee,
            })
    results.sort(key=lambda x:(-len(x['full18ProvisionalTees']),-x['minimumCoverage'],
                             -x['totalUnambiguousAssignments'],-len(x['evaluatedTeeSets']),
                             ','.join(x['evaluatedTeeSets'])))
    full=[r for r in results if r['all18SupportedSubset']]
    output={'schemaVersion':'looper-independent-tee-subset-test-v1',
        'course':'The Golf Club of New England',
        'scorecardSource':score['sourceUrl'],'testedSubsetCount':len(results),
        'candidatePairsOrMore':len(full),
        'maxSimultaneouslySupportableProvisionalSets':max((len(r['evaluatedTeeSets']) for r in full),default=0),
        'bestCandidateSubsets':results[:10],
        'allFullSubsetCombinations':[r['evaluatedTeeSets'] for r in full],
        'notes':'Subsets are selected for diagnostic ranking, not approved or held-out verified. Needs review against actual tee-pad imagery or GSPro positions before exposure.',
        'liveSelectable':[],
        'unavailableSetsRemainHidden':True,
        'unsupportedSetDoesNotBlockOtherSubsets':True,
        }
    OUTPUT.write_text(json.dumps(output,indent=2,sort_keys=True)+'\n')
    print('Subsets checked:',len(results),'full 18-hole combinations:',len(full),
          'max tee sets per full provisional combo:',output['maxSimultaneouslySupportableProvisionalSets'])
    for r in results[:10]:
        print(','.join(r['evaluatedTeeSets']), 'min supported holes=',r['minimumCoverage'],
              'full individual colors=',r['full18ProvisionalTees'],
              'counts=',[(x['name'],x['unambiguousCount']) for x in r['perTeeSet']])
    print('wrote',OUTPUT)

if __name__=='__main__':main()
