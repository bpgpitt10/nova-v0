#!/usr/bin/env python3
"""Single-lookup parser smoke test; zero network, zero new course research."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from discover_osm_course_by_name import resolve
def item(name,id):
    return {"osm_type":"way","osm_id":id,"type":"golf_course","lat":"35","lon":"-82",
            "display_name":name+", Somewhere","namedetails":{"name":name},
            "address":{"city":"Somewhere","state":"NC"}}
value=resolve("Example Golf Course",[item("Example Golf Course",12345)])
assert value["osmCourseElement"]=={"type":"way","id":12345}
assert value["gsproAliases"]==["Example Golf Course"]
for source in [[],[item("Example Golf Course",1),item("Example Golf Course",2)]]:
    try:resolve("Example Golf Course",source)
    except ValueError:pass
    else:raise AssertionError("Name resolver did not fail closed")
print("PASS course-name identity: one exact match; zero/ambiguous are rejected")
