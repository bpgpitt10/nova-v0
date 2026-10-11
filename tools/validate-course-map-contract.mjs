#!/usr/bin/env node
// Map quality gate; tee colors and mapped tee polygons are NOT requirements.
import fs from 'node:fs'
const arg = (key) => process.argv[process.argv.indexOf(key) + 1]
const pkg = JSON.parse(fs.readFileSync(arg('--package'),'utf8'))
const config = JSON.parse(fs.readFileSync(arg('--config'),'utf8'))
const check = (ok,msg) => { if (!ok) throw Error('[course-map-contract] '+msg) }
check(pkg.schemaVersion === 'looper-static-course-package-v1' && pkg.courseId === config.courseId,'course identity')
const holes = pkg.holes ?? {}
check(Object.keys(holes).length===18 && Array.from({length:18},(_,i)=>i+1).every(n=>holes[String(n)]),'18 numbered holes required')
const inventory=[]
for(let n=1;n<=18;n++){
  const h=holes[String(n)], s=h.surfaces??{}, terrain=h.terrain??{}, bounds=h.viewBounds??{}
  const count=(kind)=>(s[kind]??[]).filter(p=>Array.isArray(p)&&p.length>=3&&p.every(pt=>Array.isArray(pt)&&pt.length>=2&&pt.every(Number.isFinite))).length
  const greens=count('green'), fairways=count('fairway'), tees=count('tee')
  check(greens>0,'H'+n+' missing green geometry')
  check(h.par===3 || fairways>0,'H'+n+' missing non-par-three fairway')
  check([bounds.minX,bounds.maxX,bounds.minY,bounds.maxY].every(Number.isFinite),'H'+n+' missing map bounds')
  check(terrain.width>1 && terrain.height>1 && typeof terrain.valuesBase64==='string' && terrain.valuesBase64.length>50,'H'+n+' missing LiDAR terrain grid')
  check(['selected-tee','osm-hole-route-start'].includes(h.coordinateFrame?.origin),'H'+n+' missing geographic anchor')
  inventory.push({hole:n,greens,fairways,tees,teeCandidates:h.teeCandidates?.length??0,origin:h.coordinateFrame.origin})
}
console.log('[course-map-contract] PASS all 18 hole maps with terrain, fairways and greens')
console.log('[course-map-contract] tee evidence',JSON.stringify(inventory))
