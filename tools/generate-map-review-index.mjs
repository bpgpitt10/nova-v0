#!/usr/bin/env node
// Review-only manifest. Map-ready courses MUST NOT enter the playable catalog.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
const root = path.resolve(import.meta.dirname, '..')
const base = path.join(root,'artifacts/course-geometry')
const courses = []
if (fs.existsSync(base)) for (const entry of fs.readdirSync(base,{withFileTypes:true})) {
  if (!entry.isDirectory()) continue
  const slug=entry.name
  const receiptFile=path.join(base,slug,'map-ready-v1.json')
  if (!fs.existsSync(receiptFile)) continue
  const rec=JSON.parse(fs.readFileSync(receiptFile,'utf8'))
  if (rec.schemaVersion!=='looper-course-map-ready-v1' || rec.mapReady!==true || rec.slug!==slug) continue
  const file=path.join(root,'public/course-geometry',slug,'course-v1.json')
  if (!fs.existsSync(file)) throw Error('Missing map package: '+slug)
  const hash=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  if (hash!==rec.packageSha256) throw Error('Map receipt hash mismatch: '+slug)
  const runtimeFile=path.join(base,slug,'runtime-ready-v1.json')
  const liveReady=fs.existsSync(runtimeFile) && JSON.parse(fs.readFileSync(runtimeFile,'utf8')).runtimeReady===true
  courses.push({
    id:rec.courseId,name:rec.courseName,location:rec.location,slug,
    packageUrl:'/course-geometry/'+slug+'/course-v1.json',
    greenDetailUrl:'/course-geometry/'+slug+'/green-detail-v1.json',
    mapReady:true,liveReady,teeMappedHoles:rec.teeMappedHoles,
    teePointEvidence:rec.teePointEvidence??0,
  })
}
courses.sort((a,b)=>a.name.localeCompare(b.name))
const output=path.join(root,'public/course-review/index-v1.json')
fs.mkdirSync(path.dirname(output),{recursive:true})
fs.writeFileSync(output,JSON.stringify({schemaVersion:'looper-map-review-index-v1',courses},null,2)+'\n')
console.log('[course-review] review-only courses:',courses.length)
