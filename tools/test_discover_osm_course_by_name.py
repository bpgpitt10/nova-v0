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

# Course name can be shortened, but a valid course boundary is still mandatory.
official={"osm_type":"way","osm_id":7,"category":"leisure","type":"golf_course",
          "lat":"33.1","lon":"-79.0","display_name":"Example Glen Golf and Fish Club, Somewhere",
          "namedetails":{"name":"Example Glen Golf and Fish Club"}}
from discover_osm_course_by_name import is_golf_boundary, name_matches
assert is_golf_boundary(official)
assert name_matches("Example Glen Golf",official["namedetails"]["name"])
assert not name_matches("Totally Other",official["namedetails"]["name"])
assert not is_golf_boundary({"osm_type":"node","osm_id":1,"category":"railway","type":"tram_stop"})
assert resolve("Example Glen Golf",[official])["osmCourseElement"]["id"]==7
