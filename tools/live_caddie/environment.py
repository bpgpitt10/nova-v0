from __future__ import annotations
import math
from .assumptions import Assumptions
from .models import LiveShotState


def geometric_target_distance(state: LiveShotState) -> float:
    """Return the screen-authoritative base target distance for the shot mode.

    Strategic shots target GSPro's AIM card/vector, not the hole's PIN distance.
    Approaches target the PIN. This distinction is critical on par 5 tee shots and
    layups where the PIN can be hundreds of yards beyond the intended landing area.
    """
    if state.mode == "strategic":
        if state.gspro_aim_distance_yds is not None and state.gspro_aim_distance_yds > 0:
            return float(state.gspro_aim_distance_yds)
        if state.gspro_aim_forward_yds is not None and state.gspro_aim_right_yds is not None:
            distance = math.hypot(float(state.gspro_aim_forward_yds), float(state.gspro_aim_right_yds))
            if distance > 0:
                return distance
    return max(0.0, float(state.pin_distance_yds))


def target_elevation_delta_yds(state: LiveShotState) -> float:
    if state.mode == "strategic":
        return float(state.gspro_aim_elevation_delta_yds)
    return float(state.pin_elevation_delta_yds)


def effective_target_distance(state: LiveShotState, assumptions: Assumptions) -> float:
    """Translate visible target state into the carry number used for club fit.

    The elevation coefficient is explicit/configurable because it is golf-model
    math, not capture logic. Wind remains owned by Looper's existing wind path and
    enters here only as the external adjustment supplied to this engine.
    """
    target = geometric_target_distance(state)
    if assumptions.get("environment.use_target_elevation"):
        factor = float(assumptions.get("environment.elevation_effective_distance_factor"))
        target += target_elevation_delta_yds(state) * factor
    target += float(state.external_carry_adjustment_yds)
    return max(0.0, target)
