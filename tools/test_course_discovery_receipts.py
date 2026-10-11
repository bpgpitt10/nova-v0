#!/usr/bin/env python3
"""Offline request-to-config and failure-audit tests; no internet or real golf courses."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).with_name("discover_osm_course_by_name.py")


def exercise(items, success):
    with tempfile.TemporaryDirectory() as root:
        folder=Path(root)
        fixture=folder/"fixture.json"
        cfg=folder/"configs"
        request=folder/"rebuild.json"
        audit=folder/"audit.json"
        fixture.write_text(json.dumps(items))
        cmd=[sys.executable,str(SCRIPT),"--name","Example Fixture Golf Club",
             "--requested-at","2026-10-10T10:00:00Z","--fixture",str(fixture),
             "--config-directory",str(cfg),"--rebuild-request",str(request),
             "--discovery-audit",str(audit)]
        completed=subprocess.run(cmd,capture_output=True,text=True,check=False)
        assert (completed.returncode==0)==success,completed.stdout+completed.stderr
        receipt=json.loads(audit.read_text())
        assert receipt["status"]==("resolved" if success else "failed")
        assert isinstance(receipt["discoveryWallSeconds"],float)
        assert receipt["requestedAt"]=="2026-10-10T10:00:00Z"
        if success:
            built=json.loads(next(cfg.glob("*.json")).read_text())
            assert built["osmCourseElement"]=={"type":"way","id":12345}
            assert receipt["courseSlug"]==built["slug"]
            assert json.loads(request.read_text())["reason"]=="user-name-cold-import"
        else:
            assert receipt.get("errorType")=="ValueError"
            assert not request.exists()


def example(i=12345):
    return {"osm_type":"way","osm_id":i,"type":"golf_course",
            "lat":"35","lon":"-82","namedetails":{"name":"Example Fixture Golf Club"},
            "address":{"city":"Anywhere","state":"NC"}}

exercise([example()],True)
exercise([],False)
exercise([example(123),example(456)],False)
print("PASS offline discovery: success config + elapsed receipt; no/ambiguous-match failure receipts")
