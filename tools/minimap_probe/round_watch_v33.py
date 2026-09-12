#!/usr/bin/env python3
"""Watcher v3.3 policy delta: passive post-tee AIM before bounded fallback.

All validated v3.2 lifecycle/source policy remains unchanged. The only capture-command
change is post-tee ShotState v1.3, whose AIM sensor first reads the untouched minimap
marker and falls back to the exact prior bounded LEFT/RIGHT card path when absent.
"""
from __future__ import annotations

import copy

import round_watch_v3 as core
import round_watch_v32 as v32

_BASE_V32_CFG = v32._cfg


def _cfg():
    cfg = copy.deepcopy(_BASE_V32_CFG())
    cfg.setdefault("watcher", {})["posttee_capture_command"] = "run_approach_probe_v13_windows.ps1"
    return cfg


# v3.2 installs all of its validated monkey patches at import time. Override only
# the configuration function that selects the post-tee field probe.
v32._cfg = _cfg
core._cfg = _cfg


if __name__ == "__main__":
    print(
        "Looper watcher policy v3.3 active over v3.2/v3.1: "
        "post-tee AIM passive-minimap first; bounded card fallback retained."
    )
    raise SystemExit(core.main())
