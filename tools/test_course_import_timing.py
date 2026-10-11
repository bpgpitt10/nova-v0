#!/usr/bin/env python3
"""Validate failed-step receipts including Node subprocesses with no real course import."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parent))
from course_import_timing import ImportTiming

with tempfile.TemporaryDirectory() as root:
    path=Path(root)
    receipt=ImportTiming(path,"fixture-course","fixture.json","unit-test")
    receipt.execute([sys.executable,"-c","print('ok')"],path)
    try:
        receipt.execute([sys.executable,"-c","raise SystemExit(6)"],path)
    except subprocess.CalledProcessError:
        pass
    else:
        raise AssertionError("Failed command did not raise")
    stored=json.loads(receipt.path.read_text())
    assert stored["status"]=="running"
    assert stored["failedSteps"]==1
    assert [s["status"] for s in stored["steps"]]==["passed","failed"]
    assert stored["elapsedWallSeconds"]>=0
    assert stored["phaseDurationsSeconds"]["other"]>=0
    receipt.finish("failed","fixture failure")
    final=json.loads(receipt.path.read_text())
    assert final["status"]=="failed" and final["runtimeReady"] is False

print("PASS timing: durable success + failure receipts; nonzero subprocess captured")
