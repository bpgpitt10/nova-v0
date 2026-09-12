#!/usr/bin/env python3
"""Watcher v3.3 policy delta: simplified post-shot live capture.

All validated v3.2 lifecycle/source policy remains unchanged. Post-shot capture uses
ShotState v1.5: structured currentRound world position plus PIN/elevation, lie, wind,
and AIM-card distance/elevation. AIM is passive-first with one bounded reversible
LEFT/RIGHT summon when needed; post-shot minimap registration remains retired.
"""
from __future__ import annotations

import copy

import round_watch_v3 as core
import round_watch_v32 as v32

_BASE_V32_CFG = v32._cfg


def _cfg():
    cfg = copy.deepcopy(_BASE_V32_CFG())
    cfg.setdefault("watcher", {})["posttee_capture_command"] = "run_approach_probe_v14_windows.ps1"
    return cfg


# v3.2 installs all validated lifecycle/source monkey patches at import time.
# Override only the configuration function that selects the post-shot field probe.
v32._cfg = _cfg
core._cfg = _cfg


if __name__ == "__main__":
    print(
        "Looper watcher policy v3.3 active over v3.2/v3.1: "
        "world position + PIN/aim elevation + lie + wind; AIM passive-first with bounded summon; "
        "post-shot registration retired."
    )
    raise SystemExit(core.main())
