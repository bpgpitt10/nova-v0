from __future__ import annotations

import re
from typing import Any


def normalize_course_name(value: Any) -> str:
    """Normalize OCR course names for lifecycle identity comparisons.

    GSPro header OCR can vary harmless spacing/punctuation between adjacent frames
    (for example ``Canyon Run - Par 3`` vs ``Canyon Run -Par 3``). Lifecycle logic
    must treat those as the same course while still preserving the original display
    text elsewhere.
    """
    if value is None:
        return ""
    return " ".join(re.findall(r"[a-z0-9]+", str(value).lower().replace("&", " and ")))


def canonical_identity_key(identity: dict[str, Any] | None) -> str | None:
    if not identity:
        return None
    course = normalize_course_name(identity.get("course_name"))
    hole = identity.get("hole_number")
    if not course or hole is None:
        return None
    try:
        hole_number = int(hole)
    except (TypeError, ValueError):
        return None
    if not 1 <= hole_number <= 18:
        return None
    return f"{course}::hole-{hole_number:02d}"
