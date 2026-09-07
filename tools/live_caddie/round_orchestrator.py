from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from .assumptions import Assumptions
from .round_tracker import RoundTracker
from .shot_progression import ShotProgressionInputs, infer_shot_progression
from .source_resolution import resolve_distance_to_pin


@dataclass(frozen=True)
class RoundObservation:
    identity: dict[str, Any] | None
    minimap_surface_label: str | None = None
    minimap_surface_is_tee: bool | None = None
    minimap_surface_confidence: float | None = None
    upper_left_shot_number: int | None = None
    upper_left_distance_to_pin_yds: float | None = None
    pin_card_distance_to_pin_yds: float | None = None
    canonical_distance_to_pin_yds: float | None = None
    canonical_registration_confidence: float | None = None
    flat_lie: bool | None = None
    full_hole_minimap: bool | None = None


@dataclass(frozen=True)
class PlannedAction:
    action: str
    execute_allowed: bool
    reason: str
    identity_key: str | None
    payload: dict[str, Any]

    def to_dict(self) -> dict:
        return asdict(self)


class RoundOrchestrator:
    """Pure-ish round action planner with safe execution gates.

    It does not capture screens or press keys. It combines screen facts into actions
    such as `capture-tee` or `capture-posttee`. A separate runtime adapter may execute
    those actions only when the user explicitly enables actions.
    """

    def __init__(self, *, assumptions: Assumptions | None = None, actions_enabled: bool | None = None):
        self.assumptions = assumptions or Assumptions.load()
        cfg = self.assumptions.get("round_orchestrator")
        self.actions_enabled = bool(cfg["actions_enabled_by_default"] if actions_enabled is None else actions_enabled)
        self.tracker = RoundTracker()
        self.previous_observation: RoundObservation | None = None
        self.last_action_key: str | None = None
        self.last_action: str | None = None

    @staticmethod
    def _identity_key(identity: dict[str, Any] | None) -> str | None:
        if not identity:
            return None
        course = " ".join(str(identity.get("course_name") or "").strip().lower().split())
        hole = identity.get("hole_number")
        if not course or hole is None:
            return None
        return f"{course}::hole-{int(hole):02d}"

    def _action(self, action: str, observation: RoundObservation, reason: str, **payload) -> PlannedAction:
        return PlannedAction(
            action=action,
            execute_allowed=self.actions_enabled,
            reason=reason,
            identity_key=self._identity_key(observation.identity),
            payload=payload,
        )

    def observe(self, observation: RoundObservation) -> PlannedAction:
        resolved_distance = resolve_distance_to_pin(
            upper_left_yds=observation.upper_left_distance_to_pin_yds,
            pin_card_yds=observation.pin_card_distance_to_pin_yds,
            canonical_yds=observation.canonical_distance_to_pin_yds,
            canonical_registration_confidence=observation.canonical_registration_confidence,
            assumptions=self.assumptions,
        )

        # Preserve the previous counter before observe_pre_shot records the current
        # screen counter. This matters immediately after accept_tee(), where there is
        # intentionally no previous RoundObservation but tracker.last_screen_shot_number
        # is the authoritative prior value (1).
        prior_tracker_shot_number = self.tracker.last_screen_shot_number

        # Tee inference receives each independent source as what it actually is.
        # The central source resolver is still recorded for downstream state use, but
        # we never relabel canonical DTP as a PIN-card observation or double-count it.
        tee_decision = self.tracker.observe_pre_shot(
            current_identity=observation.identity,
            minimap_surface_is_tee=observation.minimap_surface_is_tee,
            minimap_surface_label=observation.minimap_surface_label,
            screen_shot_number=observation.upper_left_shot_number,
            screen_distance_to_pin_yds=observation.upper_left_distance_to_pin_yds,
            pin_card_distance_to_pin_yds=observation.pin_card_distance_to_pin_yds,
            flat_lie=observation.flat_lie,
            full_hole_minimap=observation.full_hole_minimap,
            assumptions=self.assumptions,
        )

        if tee_decision.should_capture_tee:
            action = self._action(
                "capture-tee",
                observation,
                "tee-state calculation confirmed a new-hole tee",
                tee_state=tee_decision.to_dict(),
                resolved_distance=resolved_distance.to_dict(),
            )
            self.previous_observation = observation
            self.last_action_key = action.identity_key
            self.last_action = action.action
            return action

        previous = self.previous_observation
        progression = infer_shot_progression(ShotProgressionInputs(
            previous_identity=(previous.identity if previous else self.tracker.active_identity),
            current_identity=observation.identity,
            previous_screen_shot_number=(previous.upper_left_shot_number if previous else prior_tracker_shot_number),
            current_screen_shot_number=observation.upper_left_shot_number,
            previous_distance_to_pin_yds=(previous.upper_left_distance_to_pin_yds if previous else None),
            current_distance_to_pin_yds=observation.upper_left_distance_to_pin_yds,
        ))

        if progression.shot_advanced:
            if self.tracker.active_identity is not None:
                self.tracker.mark_shot_recorded()
            action = self._action(
                "capture-posttee",
                observation,
                "GSPro shot counter advanced; refresh live ShotState and recommendation",
                shot_progression=progression.to_dict(),
                resolved_distance=resolved_distance.to_dict(),
            )
        elif progression.event in ("counter-reset-or-mulligan", "counter-jump"):
            action = self._action(
                "reconcile-round-state",
                observation,
                progression.detail,
                shot_progression=progression.to_dict(),
                resolved_distance=resolved_distance.to_dict(),
            )
        elif observation.minimap_surface_is_tee is False and self.tracker.active_identity is None:
            action = self._action(
                "await-active-hole",
                observation,
                "non-tee state seen before Looper has accepted a tee HoleModel",
                resolved_distance=resolved_distance.to_dict(),
            )
        else:
            action = self._action(
                "none",
                observation,
                "no new tee or shot transition requires action",
                shot_progression=progression.to_dict(),
                resolved_distance=resolved_distance.to_dict(),
            )

        self.previous_observation = observation
        self.last_action_key = action.identity_key if action.action != "none" else self.last_action_key
        self.last_action = action.action if action.action != "none" else self.last_action
        return action

    def accept_tee_capture(self, *, identity: dict[str, Any] | None = None) -> None:
        self.tracker.accept_tee(identity=identity)
        self.previous_observation = None

    def mark_terminal(self) -> None:
        if self.tracker.active_identity is not None:
            self.tracker.mark_hole_terminal(True)

    def state(self) -> dict[str, Any]:
        return {
            "actions_enabled": self.actions_enabled,
            "tracker": self.tracker.to_dict(),
            "last_action": self.last_action,
            "last_action_key": self.last_action_key,
            "assumption_version": self.assumptions.version,
        }
