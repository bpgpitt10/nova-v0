from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import json
import os
from pathlib import Path
from typing import Any

PROFILE_FILENAME = "looper-live-caddie-profiles.json"
PROFILE_ENV = "LOOPER_LIVE_CADDIE_PROFILES"


@dataclass(frozen=True)
class ProfileStoreSelection:
    path: str | None
    method: str
    available: bool
    schema_version: str | None = None
    generated_at: str | None = None
    club_count: int = 0
    shot_count: int | None = None
    owner_email: str | None = None
    age_hours: float | None = None
    warning: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def default_profile_path() -> Path:
    user_home = Path(os.environ.get("USERPROFILE") or Path.home())
    return user_home / "AppData" / "LocalLow" / "GSPro" / "GSPro" / PROFILE_FILENAME


def _payload_rows(payload: Any) -> list[dict]:
    rows = payload.get("clubs") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise ValueError("profiles JSON must be an array or an object with a clubs array")
    valid_rows = [row for row in rows if isinstance(row, dict)]
    if not valid_rows:
        raise ValueError("profiles JSON contains no club profile rows")
    return valid_rows


def _age_hours(generated_at: str | None) -> float | None:
    if not generated_at:
        return None
    try:
        parsed = datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        delta = datetime.now(timezone.utc) - parsed.astimezone(timezone.utc)
        return max(0.0, delta.total_seconds() / 3600.0)
    except Exception:
        return None


def inspect_profile_file(path: str | Path, *, method: str) -> ProfileStoreSelection:
    profile_path = Path(path)
    payload = json.loads(profile_path.read_text(encoding="utf-8"))
    rows = _payload_rows(payload)

    schema_version = payload.get("schema_version") if isinstance(payload, dict) else None
    generated_at = payload.get("generated_at") if isinstance(payload, dict) else None
    shot_count = payload.get("shot_count") if isinstance(payload, dict) else None
    owner = payload.get("owner") if isinstance(payload, dict) else None
    owner_email = owner.get("email") if isinstance(owner, dict) else None

    warning = None
    if isinstance(payload, dict) and schema_version not in (
        None,
        "looper-live-caddie-player-profiles-v1",
    ):
        warning = f"unrecognized profile schema {schema_version!r}; compatible clubs payload will still be used"

    return ProfileStoreSelection(
        path=str(profile_path),
        method=method,
        available=True,
        schema_version=str(schema_version) if schema_version is not None else None,
        generated_at=str(generated_at) if generated_at is not None else None,
        club_count=len(rows),
        shot_count=int(shot_count) if isinstance(shot_count, (int, float)) else None,
        owner_email=str(owner_email) if owner_email else None,
        age_hours=_age_hours(str(generated_at) if generated_at else None),
        warning=warning,
    )


def resolve_profile_store(explicit_path: str | None = None) -> ProfileStoreSelection:
    """Resolve the local player-model materialization without contacting Supabase.

    Precedence is explicit CLI override, environment override, then the profile file
    that authenticated Looper writes into the standard GSPro folder. Explicit/env
    paths are operator intent and therefore fail loudly when invalid. The normal
    auto path is optional so screen-state capture can still run without a profile.
    """
    if explicit_path:
        path = Path(explicit_path).expanduser()
        if not path.exists():
            raise FileNotFoundError(f"explicit live-caddie profiles file does not exist: {path}")
        return inspect_profile_file(path, method="explicit")

    env_path = os.environ.get(PROFILE_ENV, "").strip()
    if env_path:
        path = Path(env_path).expanduser()
        if not path.exists():
            raise FileNotFoundError(f"{PROFILE_ENV} points to a missing file: {path}")
        return inspect_profile_file(path, method="environment")

    path = default_profile_path()
    if not path.exists():
        return ProfileStoreSelection(
            path=str(path),
            method="standard-gspro-folder",
            available=False,
            warning=(
                "Looper player profile file has not been published yet. Open the authenticated "
                "web app on the sim PC with GSPro folder access to materialize it."
            ),
        )
    return inspect_profile_file(path, method="standard-gspro-folder")
