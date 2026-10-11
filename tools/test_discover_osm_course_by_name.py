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

# Geographic fallback is offline-tested; it must not turn a random nearby POI
# into a source course boundary.
from discover_osm_course_by_name import geographically_resolve
import discover_osm_course_by_name as discovery
old_sites,old_near=discovery.location_candidates,discovery.nearby_osm_course_boundaries
try:
    discovery.location_candidates=lambda name,timeout=25:[{"label":"Valhalla Golf Club","lat":38.24,"lon":-85.47,"city":"Louisville","state":"Kentucky","osm_id":22}]
    discovery.nearby_osm_course_boundaries=lambda lat,lon,timeout=45:[{"osm_type":"way","osm_id":99888,"category":"leisure","type":"golf_course","namedetails":{"name":"Valhalla Golf Club"},"display_name":"Valhalla Golf Club","extratags":{"leisure":"golf_course"},"lat":lat,"lon":lon}]
    geo=geographically_resolve("Valhalla")
    assert geo[0]["osm_id"]==99888 and geo[0]["address"]["city"]=="Louisville"
    discovery.nearby_osm_course_boundaries=lambda lat,lon,timeout=45:[]
    try:geographically_resolve("Valhalla")
    except ValueError as exc:assert "without geometry" in str(exc)
    else:raise AssertionError("Missing OSM boundary incorrectly accepted")
    discovery.location_candidates=lambda name,timeout=25:[{"lat":38,"lon":-85},{"lat":39,"lon":-85}]
    try:geographically_resolve("Valhalla")
    except ValueError as exc:assert "ambiguous" in str(exc)
    else:raise AssertionError("Ambiguous geocoded golf location incorrectly accepted")
finally:
    discovery.location_candidates,discovery.nearby_osm_course_boundaries=old_sites,old_near
print("PASS geographic fallback: source boundary and ambiguity fail-closed")
