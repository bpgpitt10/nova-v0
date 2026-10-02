#!/usr/bin/env python3
from __future__ import annotations
from dataclasses import dataclass
import math
import numpy as np

@dataclass(frozen=True)
class Point:
    x: float
    y: float


def _unit(dx: float, dy: float) -> tuple[float,float]:
    n=math.hypot(dx,dy)
    if n < 1e-9:
        raise ValueError('Cannot build frame from coincident points')
    return dx/n, dy/n


def transform_point(matrix_2x3, point: Point) -> Point:
    m=np.asarray(matrix_2x3,dtype=np.float64).reshape(2,3)
    out=m @ np.array([point.x, point.y, 1.0],dtype=np.float64)
    return Point(float(out[0]),float(out[1]))


def invert_affine(matrix_2x3):
    m=np.asarray(matrix_2x3,dtype=np.float64).reshape(2,3)
    linear=m[:,:2]
    det=float(np.linalg.det(linear))
    if abs(det) < 1e-9:
        raise ValueError('Affine transform is singular')
    inv_linear=np.linalg.inv(linear)
    inv_translation=-(inv_linear @ m[:,2])
    return np.column_stack([inv_linear,inv_translation]).tolist()


def canonical_to_current(matrix_current_to_canonical, canonical_point: Point) -> Point:
    return transform_point(invert_affine(matrix_current_to_canonical), canonical_point)


def current_to_canonical(matrix_current_to_canonical, current_point: Point) -> Point:
    return transform_point(matrix_current_to_canonical,current_point)


def course_point_to_canonical_pixel(*, tee_course: Point, pin_course: Point, target_course: Point,
                                    canonical_tee: Point, canonical_pin: Point,
                                    canonical_yards_per_pixel: float,
                                    max_anchor_error_yds: float = 10.0) -> Point:
    if canonical_yards_per_pixel <= 0:
        raise ValueError('canonical_yards_per_pixel must be > 0')
    cfx, cfy = _unit(pin_course.x-tee_course.x,pin_course.y-tee_course.y)
    crx, cry = cfy, -cfx
    pfx, pfy = _unit(canonical_pin.x-canonical_tee.x,canonical_pin.y-canonical_tee.y)
    prx, pry = -pfy, pfx
    course_pin_yds=math.hypot(pin_course.x-tee_course.x,pin_course.y-tee_course.y)
    pixel_pin_yds=math.hypot(canonical_pin.x-canonical_tee.x,canonical_pin.y-canonical_tee.y)*canonical_yards_per_pixel
    if abs(course_pin_yds-pixel_pin_yds)>max_anchor_error_yds:
        raise RuntimeError(f'Course tee->pin is {course_pin_yds:.1f} yd but calibrated minimap implies {pixel_pin_yds:.1f} yd; refusing ambiguous course registration.')
    dx=target_course.x-tee_course.x; dy=target_course.y-tee_course.y
    forward=dx*cfx+dy*cfy
    right=dx*crx+dy*cry
    return Point(canonical_tee.x+(forward/canonical_yards_per_pixel)*pfx+(right/canonical_yards_per_pixel)*prx,
                 canonical_tee.y+(forward/canonical_yards_per_pixel)*pfy+(right/canonical_yards_per_pixel)*pry)


def canonical_offset_target(*, current_ball_canonical: Point, canonical_tee: Point, canonical_pin: Point,
                            canonical_yards_per_pixel: float, forward_yds: float, right_yds: float) -> Point:
    pfx,pfy=_unit(canonical_pin.x-canonical_tee.x,canonical_pin.y-canonical_tee.y)
    prx,pry=-pfy,pfx
    return Point(current_ball_canonical.x+(forward_yds/canonical_yards_per_pixel)*pfx+(right_yds/canonical_yards_per_pixel)*prx,
                 current_ball_canonical.y+(forward_yds/canonical_yards_per_pixel)*pfy+(right_yds/canonical_yards_per_pixel)*pry)


def canonical_error_yards(a: Point,b: Point,canonical_yards_per_pixel:float)->float:
    return math.hypot(a.x-b.x,a.y-b.y)*canonical_yards_per_pixel
