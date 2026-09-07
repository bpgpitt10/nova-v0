from __future__ import annotations
from dataclasses import dataclass, asdict
from enum import Enum


class Phase(str, Enum):
    AWAITING_TEE = "awaiting-tee"
    HOLE_MODEL_READY = "hole-model-ready"
    SHOT_STATE_READY = "shot-state-ready"
    RECOMMENDATION_READY = "recommendation-ready"
    AIM_APPLIED = "aim-applied"


@dataclass
class LiveCaddieLifecycle:
    hole_token: str | None = None
    shot_number: int = 0
    phase: Phase = Phase.AWAITING_TEE
    hole_model_path: str | None = None
    shot_state_path: str | None = None
    recommendation_id: str | None = None
    aim_verified: bool | None = None

    def to_dict(self) -> dict:
        payload = asdict(self)
        payload["phase"] = self.phase.value
        return payload

    def start_hole(self, *, hole_token: str, hole_model_path: str) -> None:
        if not hole_token:
            raise ValueError("hole_token is required")
        self.hole_token = hole_token
        self.shot_number = 1
        self.hole_model_path = hole_model_path
        self.shot_state_path = None
        self.recommendation_id = None
        self.aim_verified = None
        self.phase = Phase.HOLE_MODEL_READY

    def set_shot_state(self, *, shot_state_path: str) -> None:
        if self.phase not in (Phase.HOLE_MODEL_READY, Phase.AIM_APPLIED):
            raise RuntimeError(f"cannot accept ShotState from phase {self.phase.value}")
        if self.hole_token is None or self.hole_model_path is None:
            raise RuntimeError("cannot accept ShotState without an active HoleModel")
        self.shot_state_path = shot_state_path
        self.recommendation_id = None
        self.aim_verified = None
        self.phase = Phase.SHOT_STATE_READY

    def set_recommendation(self, *, recommendation_id: str) -> None:
        if self.phase != Phase.SHOT_STATE_READY:
            raise RuntimeError(f"cannot accept recommendation from phase {self.phase.value}")
        self.recommendation_id = recommendation_id
        self.phase = Phase.RECOMMENDATION_READY

    def mark_aim_applied(self, *, verified: bool) -> None:
        if self.phase != Phase.RECOMMENDATION_READY:
            raise RuntimeError(f"cannot apply AIM from phase {self.phase.value}")
        self.aim_verified = bool(verified)
        self.phase = Phase.AIM_APPLIED

    def mark_shot_taken(self) -> None:
        if self.phase not in (Phase.RECOMMENDATION_READY, Phase.AIM_APPLIED):
            raise RuntimeError(f"cannot advance shot from phase {self.phase.value}")
        if self.hole_model_path is None:
            raise RuntimeError("active HoleModel was lost")
        self.shot_number += 1
        self.shot_state_path = None
        self.recommendation_id = None
        self.aim_verified = None
        self.phase = Phase.HOLE_MODEL_READY

    def end_hole(self) -> None:
        self.hole_token = None
        self.shot_number = 0
        self.hole_model_path = None
        self.shot_state_path = None
        self.recommendation_id = None
        self.aim_verified = None
        self.phase = Phase.AWAITING_TEE
