#!/usr/bin/env python3
"""Isolated GSPro Auto Aim proof runner.

Two stages:
1. --calibrate-tee: capture/cache one authoritative tee minimap and its waypoint/par-3 scale.
2. preview/click: register the current minimap back to the tee frame, map a desired
   canonical/course/offset target into the current minimap, optionally click once,
   then verify the accepted magenta GSPro target back in calibrated tee yards.

This never changes Live Caddie behavior. Mouse input is impossible unless --click is supplied.
"""
from __future__ import annotations
import argparse, json, time
from pathlib import Path
import cv2

import aim_actuator
import auto_aim_transform as xform
import click_lab
import click_lab_runner
import minimap_registration
import probe as base
import probe_v2 as v2
import waypoint_scale_cv

MAX_CURRENT_ROUND_AGE_SECONDS = 10 * 60


def parse_pair(text: str, label: str) -> xform.Point:
    parts=[p.strip() for p in text.split(',')]
    if len(parts)!=2:
        raise ValueError(f'{label} must be x,y')
    return xform.Point(float(parts[0]),float(parts[1]))


def read_safe_pin_distance(screen, explicit, tesseract, debug_dir: Path):
    if explicit is not None:
        if explicit <= 0: raise ValueError('--distance must be > 0')
        return float(explicit), 'CLI override'
    current=base.find_current_round()
    if current is not None:
        try:
            age=max(0.0,time.time()-current.stat().st_mtime)
            if age <= MAX_CURRENT_ROUND_AGE_SECONDS:
                value=float(base.distance_from_current_round(current))
                if value>0: return value, f'currentRound.dat age={age:.0f}s'
        except Exception:
            pass
    value,source,_warnings=click_lab.read_pin_distance(screen,None,tesseract,debug_dir)
    return float(value),source


def box_crop(image, box):
    x,y,w,h=[int(v) for v in box]
    return image[y:y+h,x:x+w].copy()


def state_paths(root: Path):
    return root/'tee_calibration.json', root/'tee_canonical_minimap.png'


def calibrate_tee(args) -> int:
    out=Path(args.output_dir); out.mkdir(parents=True,exist_ok=True)
    state_path,image_path=state_paths(out)
    frame=click_lab.capture_monitor(args.monitor)
    roi,box=base.crop_minimap(frame.image,args.roi)
    ball=click_lab_runner.detect_actual_ball_marker(roi)
    pin=v2.detect_pin_marker(roi)
    pin_distance=None; distance_source=None
    try:
        pin_distance,distance_source=read_safe_pin_distance(frame.image,args.distance,args.tesseract,out)
    except Exception:
        if args.par == 3:
            raise
    result,waypoints=waypoint_scale_cv.resolve_scale_from_image(
        roi,
        ball=xform.Point(ball.x,ball.y),
        pin=xform.Point(pin.x,pin.y),
        pin_distance_yds=pin_distance,
        par=args.par,
        tesseract_path=args.tesseract or 'tesseract',
    )
    cv2.imwrite(str(image_path),roi)
    payload={
        'schema_version':'auto-aim-tee-calibration-v1',
        'created_unix':time.time(),
        'monitor':args.monitor,
        'roi_box':list(box),
        'par':args.par,
        'canonical_ball_pixel':{'x':ball.x,'y':ball.y},
        'canonical_pin_pixel':{'x':pin.x,'y':pin.y},
        'canonical_yards_per_pixel':result.yards_per_pixel,
        'scale_source':result.source,
        'waypoint_count':result.waypoint_count,
        'waypoint_spread_pct':result.waypoint_spread_pct,
        'pin_distance_yds':pin_distance,
        'pin_distance_source':distance_source,
        'waypoints':[{'yards':w.yards,'x':w.pixel.x,'y':w.pixel.y,'ocr':w.ocr_text} for w in waypoints],
        'canonical_minimap':image_path.name,
    }
    state_path.write_text(json.dumps(payload,indent=2),encoding='utf-8')
    print(f'TEE CALIBRATION PASS: {result.yards_per_pixel:.6f} yd/px via {result.source}')
    print(f'Saved {state_path}')
    return 0


def resolve_target(args,state,registration,current_ball):
    ypp=float(state['canonical_yards_per_pixel'])
    tee=xform.Point(**state['canonical_ball_pixel'])
    pin=xform.Point(**state['canonical_pin_pixel'])
    current_ball_can=xform.current_to_canonical(registration.matrix_2x3,xform.Point(current_ball.x,current_ball.y))
    if args.target_canonical:
        return parse_pair(args.target_canonical,'--target-canonical'),'canonical-pixel',current_ball_can
    course_values=[args.tee_course,args.pin_course,args.target_course]
    if any(course_values):
        if not all(course_values):
            raise ValueError('Course mode requires --tee-course, --pin-course, and --target-course together')
        target=xform.course_point_to_canonical_pixel(
            tee_course=parse_pair(args.tee_course,'--tee-course'),
            pin_course=parse_pair(args.pin_course,'--pin-course'),
            target_course=parse_pair(args.target_course,'--target-course'),
            canonical_tee=tee,canonical_pin=pin,canonical_yards_per_pixel=ypp,
        )
        return target,'course-point',current_ball_can
    if args.forward is None or args.right is None:
        raise ValueError('Supply --forward and --right, --target-canonical, or course target coordinates')
    target=xform.canonical_offset_target(
        current_ball_canonical=current_ball_can,
        canonical_tee=tee,canonical_pin=pin,canonical_yards_per_pixel=ypp,
        forward_yds=float(args.forward),right_yds=float(args.right),
    )
    return target,'current-offset',current_ball_can


def annotate(screen,box,ball,pin,target,reg,pin_error,ypp):
    canvas=screen.copy(); x,y,w,h=box
    cv2.rectangle(canvas,(x,y),(x+w,y+h),(255,255,0),2)
    def pt(p): return int(round(x+p.x)),int(round(y+p.y))
    b=pt(ball); p=pt(pin); t=pt(target)
    cv2.circle(canvas,b,8,(255,255,255),2); cv2.putText(canvas,'BALL',(b[0]+10,b[1]),cv2.FONT_HERSHEY_SIMPLEX,.5,(255,255,255),2)
    cv2.circle(canvas,p,8,(255,255,255),2); cv2.putText(canvas,'PIN',(p[0]+10,p[1]),cv2.FONT_HERSHEY_SIMPLEX,.5,(255,255,255),2)
    cv2.drawMarker(canvas,t,(0,255,255),cv2.MARKER_CROSS,28,3)
    label=f'AUTO AIM scale {reg.scale:.3f} rot {reg.rotation_deg:+.1f} pinerr {pin_error:.1f}px teeYPP {ypp:.3f}'
    cv2.putText(canvas,label,(max(10,x-20),max(30,y-18)),cv2.FONT_HERSHEY_SIMPLEX,.52,(0,255,255),2,cv2.LINE_AA)
    return canvas


def run_target(args) -> int:
    out=Path(args.output_dir); out.mkdir(parents=True,exist_ok=True)
    state_path,image_path=state_paths(out)
    state=json.loads(state_path.read_text(encoding='utf-8'))
    canonical=cv2.imread(str(image_path),cv2.IMREAD_COLOR)
    if canonical is None: raise RuntimeError(f'Could not read {image_path}')
    before=click_lab.capture_monitor(args.monitor)
    current,box=base.crop_minimap(before.image,args.roi)
    ball=click_lab_runner.detect_actual_ball_marker(current)
    pin=v2.detect_pin_marker(current)
    can_pin=state['canonical_pin_pixel']
    registration,pin_error=minimap_registration.register_current_to_canonical_verified(
        current,canonical,
        current_pin_xy=(pin.x,pin.y),
        canonical_pin_xy=(float(can_pin['x']),float(can_pin['y'])),
        max_pin_error_px=float(args.max_pin_error_px),
    )
    target_can,mode,current_ball_can=resolve_target(args,state,registration,ball)
    target_cur=xform.canonical_to_current(registration.matrix_2x3,target_can)
    margin=float(args.edge_margin); H,W=current.shape[:2]
    if not (margin <= target_cur.x <= W-1-margin and margin <= target_cur.y <= H-1-margin):
        raise RuntimeError(f'Predicted current minimap target ({target_cur.x:.1f},{target_cur.y:.1f}) is outside safe {W}x{H} ROI')
    ypp=float(state['canonical_yards_per_pixel'])
    preview=annotate(before.image,box,ball,pin,target_cur,registration,pin_error,ypp)
    cv2.imwrite(str(out/'latest_auto_aim_preview.png'),preview)
    result={
        'mode':mode,'clicked':False,'verification':'PREVIEW_ONLY',
        'registration':registration.to_dict(),'pin_error_px':pin_error,
        'canonical_yards_per_pixel':ypp,
        'current_ball_pixel':{'x':ball.x,'y':ball.y},
        'current_ball_canonical':{'x':current_ball_can.x,'y':current_ball_can.y},
        'target_canonical':{'x':target_can.x,'y':target_can.y},
        'target_current_pixel':{'x':target_cur.x,'y':target_cur.y},
    }
    if args.click:
        roi_x,roi_y,_,_=box
        screen_x=roi_x+target_cur.x; screen_y=roi_y+target_cur.y
        desktop_x=before.monitor_left+screen_x; desktop_y=before.monitor_top+screen_y
        found=aim_actuator.find_gspro_window()
        if found is None: raise RuntimeError('Could not find visible GSPro window; no mouse input sent')
        hwnd,title=found
        left,top,right,bottom=click_lab.get_window_rect(hwnd)
        if not (left <= desktop_x < right and top <= desktop_y < bottom):
            raise RuntimeError('Predicted click is outside GSPro window; refusing input')
        click_lab.click_once_and_restore(hwnd,int(round(desktop_x)),int(round(desktop_y)))
        time.sleep(max(0.0,float(args.settle_ms))/1000.0)
        after=click_lab.capture_monitor(args.monitor)
        cv2.imwrite(str(out/'latest_auto_aim_after.png'),after.image)
        after_roi=box_crop(after.image,box)
        accepted=click_lab_runner.detect_magenta_aim_marker(after_roi,base.Point(target_cur.x,target_cur.y))
        accepted_can=xform.current_to_canonical(registration.matrix_2x3,xform.Point(accepted.x,accepted.y))
        error_yds=xform.canonical_error_yards(accepted_can,target_can,ypp)
        status='PASS' if error_yds <= float(args.verify_tolerance) else 'FAIL'
        verify=after.image.copy(); ax,ay=int(round(box[0]+accepted.x)),int(round(box[1]+accepted.y))
        cv2.drawMarker(verify,(ax,ay),(255,0,255),cv2.MARKER_CROSS,30,3)
        cv2.putText(verify,f'AUTO AIM {status} err {error_yds:.2f} yd',(max(12,ax-220),max(30,ay-22)),cv2.FONT_HERSHEY_SIMPLEX,.6,(255,0,255),2)
        cv2.imwrite(str(out/'latest_auto_aim_verify.png'),verify)
        result.update({
            'clicked':True,'gspro_window_title':title,'verification':status,
            'accepted_current_pixel':{'x':accepted.x,'y':accepted.y},
            'accepted_canonical':{'x':accepted_can.x,'y':accepted_can.y},
            'vector_error_yds':error_yds,
        })
    (out/'latest_auto_aim_result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(f"AUTO AIM {result['verification']}: target current pixel ({target_cur.x:.1f},{target_cur.y:.1f}), pin check {pin_error:.2f}px")
    if result.get('clicked'):
        print(f"Accepted-target error: {result['vector_error_yds']:.2f} yd")
        return 0 if result['verification']=='PASS' else 3
    return 0


def main():
    p=argparse.ArgumentParser(description='Isolated verified GSPro Auto Aim proof runner')
    p.add_argument('--monitor',type=int,default=1); p.add_argument('--roi'); p.add_argument('--tesseract',default='tesseract')
    p.add_argument('--output-dir',default=str(Path(__file__).with_name('output')/'auto_aim'))
    p.add_argument('--calibrate-tee',action='store_true'); p.add_argument('--par',type=int); p.add_argument('--distance',type=float)
    p.add_argument('--target-canonical'); p.add_argument('--tee-course'); p.add_argument('--pin-course'); p.add_argument('--target-course')
    p.add_argument('--forward',type=float); p.add_argument('--right',type=float)
    p.add_argument('--click',action='store_true'); p.add_argument('--settle-ms',type=float,default=400.0)
    p.add_argument('--verify-tolerance',type=float,default=3.0); p.add_argument('--max-pin-error-px',type=float,default=5.0); p.add_argument('--edge-margin',type=float,default=5.0)
    args=p.parse_args()
    if args.calibrate_tee:
        if args.par is None: raise ValueError('--calibrate-tee requires --par')
        if args.click: raise ValueError('--calibrate-tee never clicks; remove --click')
        return calibrate_tee(args)
    return run_target(args)

if __name__=='__main__':
    raise SystemExit(main())
