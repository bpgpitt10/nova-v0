#!/usr/bin/env python3
from __future__ import annotations
import auto_aim_transform as a

CASES=[
    dict(name='Greywolf H8 shot 2', matrix=[[0.353548471,-0.157713020,210.251806],[0.157713020,0.353548471,68.2961123]], current_ball=a.Point(277.6226784,852.1339198), tee=a.Point(275.9562842,851.1857923), pin=a.Point(281.0500183,174.3500061), ypp=0.5756693119, expected=a.Point(183.9537,525.7971)),
    dict(name='Greywolf H13 shot 2', matrix=[[0.291182836,-0.187250734,230.715324],[0.187250734,0.291182836,71.2393193]], current_ball=a.Point(279.1972387,852.6272189), tee=a.Point(278.2912088,852.5274725), pin=a.Point(279.9500122,173.25), ypp=0.4788347688, expected=a.Point(86.2310,438.9844)),
]

def main():
    for c in CASES:
        ball_can=a.current_to_canonical(c['matrix'],c['current_ball'])
        target_can=a.canonical_offset_target(current_ball_canonical=ball_can,canonical_tee=c['tee'],canonical_pin=c['pin'],canonical_yards_per_pixel=c['ypp'],forward_yds=75.0,right_yds=10.0)
        target_cur=a.canonical_to_current(c['matrix'],target_can)
        if abs(target_cur.x-c['expected'].x)>0.02 or abs(target_cur.y-c['expected'].y)>0.02:
            raise AssertionError(f"{c['name']} inverse target drifted: {target_cur}")
        roundtrip=a.current_to_canonical(c['matrix'],target_cur)
        err=a.canonical_error_yards(roundtrip,target_can,c['ypp'])
        if err>1e-6: raise AssertionError(f"{c['name']} roundtrip error {err}")
        if not (5 <= target_cur.x <= 558 and 5 <= target_cur.y <= 944):
            raise AssertionError(f"{c['name']} target left minimap: {target_cur}")
        print(f"{c['name']}: current target ({target_cur.x:.2f},{target_cur.y:.2f}); roundtrip {err:.8f} yd")
    print('AUTO AIM TRANSFORM PROOF PASS')
    return 0
if __name__=='__main__': raise SystemExit(main())
