#!/usr/bin/env python3
"""OSM tee points are preserved without manufacturing tee polygons or tee sets."""
from unittest.mock import patch
import io
import build_osm_course_package_v6 as v6
import fetch_osm_course_snapshot_core as core

def p(lat,lon):return {"lat":lat,"lon":lon}
def way(i,tags,coords):return {"type":"way","id":i,"tags":tags,"geometry":[p(a,b) for a,b in coords]}
payload={"elements":[
  way(1,{"golf":"hole","ref":"1","par":"4"},[(40.0,-75.0),(40.003,-75.0)]),
  way(2,{"golf":"green"},[(40.00295,-75.0001),(40.00305,-75.0001),(40.00305,-74.9999),(40.00295,-74.9999),(40.00295,-75.0001)]),
  way(3,{"golf":"fairway"},[(40.0002,-75.0002),(40.0028,-75.0002),(40.0028,-74.9998),(40.0002,-74.9998),(40.0002,-75.0002)]),
  {"type":"node","id":44,"tags":{"golf":"tee","name":"Back Tee"},"geometry":[p(40.0,-75.0)]},
]}
features,routes=v6.normalize_osm(payload)
assert any(f["kind"]=="tee-point" and f["osm_id"]==44 for f in features)
assert not any(f["kind"]=="tee" for f in features)
cfg={"courseId":"fixture","courseName":"Fixture","location":"Example",
     "selection":{"teeStartRadiusYards":220,"contextRouteDistanceYards":90,
                  "fairwayCorridorYards":70,"hazardCorridorYards":70}}
model,_=v6.model_for_hole(1,cfg,features,routes)
assert len(model.get("teePointEvidence",[]))==1
assert model["teePointEvidence"][0]["osmId"]==44
assert model["teePointEvidence"][0]["label"]=="Back Tee"
assert model["teeCandidates"]==[], "A point must not turn into a validated physical tee set"
assert not model["surfaces"].get("tee"), "A point must not turn into an imaginary polygon"
xml=b'''<osm version="0.6"><node id="44" lat="40" lon="-75"><tag k="golf" v="tee"/><tag k="name" v="Back Tee"/></node></osm>'''
class Response:
  def __enter__(self):return self
  def __exit__(self,*args):return False
  def read(self):return xml
with patch.object(core.urllib.request,'urlopen',return_value=Response()):
  result,_,_=core.fetch_core_map_features((-75.01,39.99,-74.99,40.01),5)
assert len(result["elements"])==1
assert result["elements"][0]["type"]=="node"
assert result["elements"][0]["geometry"]==[{"lat":40.0,"lon":-75.0}]
print("PASS OSM tee node source extraction, hole attachment, and no invented polygons/tee sets")
