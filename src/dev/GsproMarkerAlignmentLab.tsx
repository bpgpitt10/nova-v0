import { useEffect, useMemo, useState } from 'react'
import { GREYWOLF_COURSE_ID, courseRegistry, resolveCourseIdFromGsproName, type CourseId } from '../courseGeometry/courseCatalog'
import { loadCourseHoleGeometry } from '../courseGeometry/courseProvider'
import type { CourseHoleGeometry } from '../courseGeometry/types'
import { evaluateMarkerOnlyCourseAlignment, type MarkerOnlyAlignment } from '../courseGeometry/gsproMarkerOnlyAlignment'
import { readLooperCompanionObservations, type LooperCompanionLiveObservations } from '../adapters/looperCompanion'
import './gsproCourseAlignmentLab.css'

const colors: Record<string,string> = {
  rough:'#476f3b', 'deep-rough':'#2b402e',
  fairway:'#72a452', green:'#b5d487', tee:'#92bd64',
  bunker:'#ddc99f', water:'#458cb1', penalty:'#458cb1',
}
const downloadReport = (result: unknown, filename: string) => {
  const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}))
  const a=document.createElement('a');a.href=url;a.download=filename;a.click()
  window.setTimeout(()=>URL.revokeObjectURL(url),1000)
}
const textNumber = (n: number | null | undefined, suffix='') =>
  n == null ? '—' : String(n)+suffix

export default function GsproMarkerAlignmentLab() {
  const courses=useMemo(()=>courseRegistry.filter(x=>
    x.id===GREYWOLF_COURSE_ID || x.packageStatus==='ready'),[])
  const [courseId,setCourseId]=useState<CourseId>(GREYWOLF_COURSE_ID)
  const [hole,setHole]=useState(8)
  const [geometry,setGeometry]=useState<CourseHoleGeometry|null>(null)
  const [mapError,setMapError]=useState('')
  const [native,setNative]=useState<LooperCompanionLiveObservations|null>(null)
  const [output,setOutput]=useState<MarkerOnlyAlignment|null>(null)
  const [loading,setLoading]=useState(false)
  const [error,setError]=useState('')
  const [confirmed,setConfirmed]=useState(false)
  useEffect(()=>{
    let stopped=false
    setOutput(null);setNative(null);setGeometry(null);setMapError('');setConfirmed(false)
    loadCourseHoleGeometry(courseId,hole)
      .then(value=>{if(!stopped)setGeometry(value)})
      .catch(e=>{if(!stopped)setMapError(e instanceof Error?e.message:String(e))})
    return()=>{stopped=true}
  },[courseId,hole])

  const read=async()=>{
    setLoading(true);setError('');setOutput(null);setNative(null)
    try {
      const obs=await readLooperCompanionObservations(45000)
      setNative(obs)
      const key=obs.structured?.shot?.courseKey
      const actual=key?resolveCourseIdFromGsproName(key):null
      // Last completed record may refer to the prior HOLE, but it cannot
      // substitute for the user's current-ball source. This is research only.
      if (!geometry) throw new Error('The imported map for this hole is not loaded.')
      const value=evaluateMarkerOnlyCourseAlignment(geometry,obs,{
        selectedCourseKeyMatches: actual===courseId,
        visuallyConfirmedCourseAndHole:confirmed,
      })
      setOutput(value)
    } catch(e) {setError(e instanceof Error?e.message:String(e))}
    finally{setLoading(false)}
  }
  const save=()=>{
    if(!output)return
    downloadReport({
      schemaVersion:'looper-gspro-osm-marker-only-diagnostic-v1',
      exportNote:'Image-free, read-only numerical research. Not exact tee or pin OSM anchors; no safe native aim or course publication.',
      importedCourseId:courseId,holeNumber:hole,
      nativeObservedAt:native?.observedAt,
      gsproCourseKey:native?.structured?.shot?.courseKey,
      nativeShotEvidence:{
        kind:native?.structured?.shot?.kind,
        holeNumber:native?.structured?.shot?.holeNumber,
        shotNumber:native?.structured?.shot?.shotNumber,
        roundId:native?.structured?.shot?.roundId,
        fileAgeMs:native?.structured?.fileAgeMs,
      },
      nativeMinimapEvidence:native?.minimap?{
        status:native.minimap.status,
        side:native.minimap.minimapSide,
        ballPixel:native.minimap.ballPixel,
        pinPixel:native.minimap.pinPixel,
        scale:native.minimap.scale,
        waypointRuler:native.minimap.waypointRuler,
        registration:native.minimap.registration,
      }:null,
      timingMs:native?.timingMs,
      registeredMapEvidence:{
        teeOrigin:geometry?.coordinateSystem.origin,
        teeMarker:geometry?.markers.tee,
        greenPolygonCentroid:geometry?.markers.pin,
        numberOfFairwaySurfaces:geometry?.surfaces.filter(x=>x.kind==='fairway').length,
      },output,
    },'looper-gspro-marker-alignment-h'+hole+'-'+Date.now()+'.json')
  }
  const bounds=geometry?.viewBounds||geometry?.bounds
  const b=bounds?{
    minX:bounds.minX-24,maxX:bounds.maxX+24,
    minY:bounds.minY-24,maxY:bounds.maxY+24,
  }:null
  const scale= b ? Math.max(b.maxX-b.minX,b.maxY-b.minY) : 150
  const tee=geometry?.markers.tee
  const green=geometry?.markers.pin
  return <main className="gspro-align-lab">
    <header>
      <div className="eyebrow">The Looper · GSPro + OSM · Marker-only diagnostic</div>
      <h1>Ball → fairway waypoint → pin</h1>
      <p><strong>No hazard tagging.</strong> The existing Windows Companion observes the
        ball, gray default-aim waypoint with its yardage, and pin. We use its existing
        pixel scale and compare that triangle with Looper's imported route/green/fairway.
        This is an <strong>approximate geometry experiment</strong>, not a verified tee,
        pinned flag location or playable AutoAim alignment.</p>
      <a href="/dev/companion-observations.html">Detailed native observations</a>
      {' · '}<a href="/live-caddie">Live Caddie</a>
    </header>
    <section className="align-controls">
      <label>Course <select value={courseId} onChange={e=>setCourseId(e.target.value as CourseId)}>
        {courses.map(x=><option value={x.id} key={x.id}>{x.name}</option>)}
      </select></label>
      <label>Hole <select value={hole} onChange={e=>setHole(Number(e.target.value))}>
        {Array.from({length:18},(_,i)=>i+1).map(n=><option key={n} value={n}>{n}</option>)}
      </select></label>
    </section>
    <section className="align-evaluate">
      <label><input type="checkbox" checked={confirmed} onChange={e=>{
        setConfirmed(e.target.checked);setOutput(null)
      }}/> I can SEE this selected course and hole in GSPro, and the ball is
      currently on the <strong>tee</strong> (not a later fairway shot).</label>
      <div className="align-actions">
        <button type="button" disabled={loading||!geometry||!confirmed}
          onClick={()=>void read()}>{loading?'Reading native minimap…':'Read ball, waypoint and pin'}</button>
        <button type="button" disabled={!output} onClick={save}>Export diagnostic JSON</button>
      </div>
      <p>At the tee, leave the GSPro minimap visible. No screenshot upload or manual
        feature matching is required. The Companion may spend several seconds
        processing waypoint OCR. <strong>Do not hit a shot until it finishes.</strong></p>
      {mapError?<p className="align-danger">{mapError}</p>:null}
      {error?<p className="align-danger">{error}</p>:null}
      {output?<div className={output.status==='blocked'?'align-danger':'align-good'}>
        <h3>{output.status==='blocked'?'Observation blocked':
          'Provisional geometry comparison — NOT verified for play'}</h3>
        <p>{output.reason}</p>
        <dl>
          <dt>GSPro current shot evidence</dt><dd>{output.identityStatus}</dd>
          <dt>Native waypoint OCR yards</dt><dd>{textNumber(output.waypointDistanceOcrYds,' yd')}</dd>
          <dt>Native waypoint pixels × scale</dt><dd>{textNumber(output.waypointDistancePixelYds,' yd')}</dd>
          <dt>Scale internal consistency</dt><dd>{textNumber(output.waypointRulerErrorPercent,'%')}</dd>
          <dt>GSPro ball–pin (straight)</dt><dd>{textNumber(output.ballToGsproPinYds,' yd')}</dd>
          <dt>OSM route-start–green-center (approx.)</dt><dd>{textNumber(output.teeToGreenCentroidYds,' yd')}</dd>
          <dt>Length difference (approx. anchors)</dt><dd>{textNumber(output.teePinLengthDifferenceYds,' yd')}</dd>
          <dt>Waypoint bend away from ball–pin line</dt><dd>{textNumber(output.waypointLateralFromTeePinYds,' yd')}</dd>
        </dl>
        <small>The gray waypoint yardage is also used to derive native scale.
          Their agreement is an <strong>internal consistency check, not independent validation</strong>.
          OSM start ≠ guaranteed tee; green centroid ≠ actual GSPro flag.</small>
      </div>:null}
    </section>
    <div className="align-maps">
      <section className="align-panel">
        <h2>Existing imported OSM hole — provisional overlay</h2>
        {geometry&&b?<svg role="img" aria-label="Imported OSM polygons, approximate route start and green center and two projected waypoint possibilities"
          className="align-course" viewBox={[b.minX,-b.maxY,b.maxX-b.minX,b.maxY-b.minY].join(' ')}>
          <rect x={b.minX} y={-b.maxY} width={b.maxX-b.minX}
            height={b.maxY-b.minY} fill="#183225"/>
          {geometry.contextLayers?.filter(x=>x.kind==='woods'||x.kind==='scrub').flatMap(x=>
            x.polygons.map((p,i)=><polygon key={x.id+i} points={p.map(q=>q[0]+','+(-q[1])).join(' ')}
              fill="#26472d" opacity={.55}/>))}
          {geometry.surfaces.flatMap(s=>
            s.polygons.map((p,i)=><polygon key={s.id+i}
              points={p.map(q=>q[0]+','+(-q[1])).join(' ')}
              fill={colors[s.kind]||'#55794f'}
              stroke="#c0dba9" strokeWidth=".75" strokeOpacity={.3}/>))}
          {tee?<g><circle cx={tee[0]} cy={-tee[1]} r={Math.max(4,scale*.008)}
            fill="#f2edc6" stroke="#29472d" strokeWidth={2}/>
            <text x={tee[0]+6} y={-tee[1]-6} fontSize={12} fill="white">OSM route start</text></g>:null}
          {green?<g><circle cx={green[0]} cy={-green[1]} r={Math.max(4,scale*.008)}
            fill="#f6ffff" stroke="#29472d" strokeWidth={2}/>
            <text x={green[0]+6} y={-green[1]-6} fontSize={12} fill="white">Green centroid</text></g>:null}
          {output?.alternatives.map((alt,i)=><g key={alt.handedness}>
            <circle cx={alt.mapPoint[0]} cy={-alt.mapPoint[1]} r={Math.max(5,scale*.009)}
              fill={i===0?'#fff48c':'#ffa58f'} stroke="#1e3224" strokeWidth={2}/>
            <text x={alt.mapPoint[0]+7} y={-alt.mapPoint[1]+15} fontSize={13}
              fill="white" stroke="#1e3224" paintOrder="stroke" strokeWidth={2}>
              {i===0?'W1':'W2'}</text>
          </g>)}
        </svg>:<p>{mapError||'Loading geometry…'}</p>}
        {output?.alternatives.length?<div className="align-result">
          <strong>Where the GSPro gray waypoint might land on this OSM map:</strong>
          {output.alternatives.map((alt,i)=><p key={alt.handedness}>
            <strong>{i===0?'W1':'W2'} ({alt.handedness})</strong> at
            {' '}[{alt.mapPoint.map(n=>n.toFixed(1)).join(', ')}] yd;
            distance from <em>mapped OSM fairway polygon</em>:
            {' '}{textNumber(alt.fairwayDistanceYds,' yd')}.
          </p>)}
          <small>We deliberately retain both mirrored orientations. A waypoint
            near an OSM fairway is encouraging, but never independently proves
            the course frame, hazard locations, actual tee or pin.</small>
        </div>:null}
      </section>
      <section className="align-panel">
        <h2>GSPro measurements already extracted</h2>
        {native?<dl>
          <dt>GSPro course identity</dt><dd>{native.structured?.shot?.courseKey??'unknown'}</dd>
          <dt>Completed/current shot record</dt><dd>{native.structured?.shot?.kind??'unknown'},
            {' '}hole {native.structured?.shot?.holeNumber??'?'}</dd>
          <dt>Actual ball</dt><dd>{JSON.stringify(native.minimap?.ballPixel??null)}</dd>
          <dt>Pin</dt><dd>{JSON.stringify(native.minimap?.pinPixel??null)}</dd>
          <dt>Gray waypoint candidates</dt><dd>{native.minimap?.waypointRuler?.candidates?.length??0}</dd>
          <dt>Native scale status</dt><dd>{native.minimap?.scale?.status??'unavailable'}</dd>
          <dt>Waypoint OCR processing</dt><dd>{textNumber(native.timingMs?.waypointOcr,' ms')}</dd>
          <dt>Native elapsed time</dt><dd>{textNumber(native.timingMs?.total,' ms')}</dd>
        </dl>:<p>Press Read ball, waypoint and pin to collect the latest observation from the existing Windows Companion.</p>}
        <small>Manual-only evidence is expected if currentRound.dat still shows a
          previously completed shot. This cannot be used to authorize live
          shot targeting, registration or native mouse input.</small>
      </section>
    </div>
    <section className="align-status">
      <strong>What this experiment can answer:</strong> Does the observed GSPro
      waypoint bend in a direction compatible with the imported fairway? Does
      the approximate tee–green distance look plausible? Are the read-only
      native measurements present and fresh?
      <br/><strong>What it cannot answer yet:</strong> Whether the route start is
      the actual tee; whether GSPro's flag is at the OSM green centroid;
      whether an OSM hazard is positioned accurately. Never promote a course
      or enable auto aim based on these markers alone.
    </section>
  </main>
}
