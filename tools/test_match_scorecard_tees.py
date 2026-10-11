#!/usr/bin/env python3
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from match_scorecard_tees import assign_for_offset,match_hole

candidates=[{'routeEstimateYds':225},{'routeEstimateYds':195},{'routeEstimateYds':155}]
cost,identities=assign_for_offset([225,195,155],candidates,0,3)
assert identities==(0,1,2),identities
# When one official tee has no legitimate physical pad, omit ONLY that tee.
_,identities=assign_for_offset([225,195,115],candidates,0,3)
assert identities[0]==0 and identities[1]==1 and identities[2] is None,identities
# Multiple named tee sets can share a pad when published distances are similar.
_,identities=assign_for_offset([225,197,195,155],candidates,0,3)
assert identities[0]==0 and identities[1]==1 and identities[2]==1 and identities[3]==2,identities
print('PASS subset matching, unsupported tee exclusion, legitimate physical pad sharing')
