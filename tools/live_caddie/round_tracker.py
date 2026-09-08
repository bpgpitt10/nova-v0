from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from .assumptions import Assumptions
from .identity import canonical_identity_key
from .tee_state import TeeStateDecision, TeeStateInputs, infer_tee_state


@dataclass
class RoundTracker:
    """Small mutable shell around the pure tee-state calculation.

    The tracker deliberately keeps the *active* hole identity until a new tee is
    accepted. That means a very fast made/gimme -> next-tee transition cannot be
    missed just because the intermediate screen disappeared: every frame on the new
    hole continues to compare against the previous active hole until tee capture is
    successfully started.
    """

    active_identity: dict[str, Any] | None = None
    shots_recorded_on_active_hole: int = 0
    active_hole_terminal: bool | None = None
    last_screen_shot_number: int | None = None
    pending_identity: dict[str, Any] | None = None

    def to_dict(self) -> dict:
        return asdict(self)

    def observe_pre_shot(
        self,
        *,
        current_identity: dict[str, Any] | None,
        minimap_surface_is_tee: bool | None = None,
        minimap_surface_label: str | None = None,
        screen_shot_number: int | None = None,
        screen_distance_to_pin_yds: float | None = None,
        pin_card_distance_to_pin_yds: float | None = None,
        flat_lie: bool | None = None,
        full_hole_minimap: bool | None = None,
        assumptions: Assumptions | None = None,
    ) -> TeeStateDecision:
        # If the header is different from the active hole, this is a candidate new
        # hole and therefore has zero Looper-recorded shots until accepted.
        probe = TeeStateInputs(
            current_identity=current_identity,
            previous_identity=self.active_identity,
            minimap_surface_is_tee=minimap_surface_is_tee,
            minimap_surface_label=minimap_surface_label,
            screen_shot_number=screen_shot_number,
            screen_distance_to_pin_yds=screen_distance_to_pin_yds,
            pin_card_distance_to_pin_yds=pin_card_distance_to_pin_yds,
            shots_recorded_on_current_hole=(
                0 if self._is_new_identity(current_identity) else self.shots_recorded_on_active_hole
            ),
            previous_hole_terminal=self.active_hole_terminal,
            flat_lie=flat_lie,
            full_hole_minimap=full_hole_minimap,
        )
        decision = infer_tee_state(probe, assumptions=assumptions)
        self.last_screen_shot_number = screen_shot_number
        if decision.hole_changed or self.active_identity is None:
            self.pending_identity = dict(current_identity) if current_identity else None
        return decision

    def accept_tee(self, *, identity: dict[str, Any] | None = None) -> None:
        selected = identity or self.pending_identity
        if not selected:
            raise ValueError("cannot accept tee without a course/hole identity")
        self.active_identity = dict(selected)
        self.pending_identity = None
        self.shots_recorded_on_active_hole = 0
        self.active_hole_terminal = False
        self.last_screen_shot_number = 1

    def mark_shot_recorded(self) -> None:
        if self.active_identity is None:
            raise RuntimeError("cannot record a shot without an active hole")
        self.shots_recorded_on_active_hole += 1

    def mark_hole_terminal(self, terminal: bool = True) -> None:
        if self.active_identity is None:
            raise RuntimeError("cannot mark terminal state without an active hole")
        self.active_hole_terminal = bool(terminal)

    def reset(self) -> None:
        self.active_identity = None
        self.shots_recorded_on_active_hole = 0
        self.active_hole_terminal = None
        self.last_screen_shot_number = None
        self.pending_identity = None

    def _is_new_identity(self, current: dict[str, Any] | None) -> bool:
        if self.active_identity is None or current is None:
            return self.active_identity is not current
        active_key = canonical_identity_key(self.active_identity)
        current_key = canonical_identity_key(current)
        if active_key is None or current_key is None:
            return False
        return current_key != active_key
