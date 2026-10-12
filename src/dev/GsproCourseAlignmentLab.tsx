import { useEffect, useMemo, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { GREYWOLF_COURSE_ID, courseRegistry, resolveCourseIdFromGsproName, type CourseId } from '../courseGeometry/courseCatalog'
import { loadCourseHoleGeometry } from '../courseGeometry/courseProvider'
import { evaluateGsproToCourseLandmarkRegistration, type CrossFrameLandmark } from '../courseGeometry/gsproCourseLandmarkRegistration'
import type { CourseHoleGeometry, CoursePointYds } from '../courseGeometry/types'
import { readLooperCompanionObservations, type LooperCompanionLiveObservations } from '../adapters/looperCompanion'
import './gsproCourseAlignmentLab.css'

/** Manual physical feature correspondence, no upload, no screen sharing, no native input. */
type XY = readonly [number, number]
type Crop = Readonly<{ x: number; y: number; w: number; h: number }>
type Pair = {
  name: string; role: 'fit' | 'holdout'; kind: CrossFrameLandmark['kind']
  screenshotPoint: XY | null; coursePoint: CoursePointYds | null
}
const freshPairs = (): Pair[] => [
  { name: 'A', role: 'fit', kind: 'bunker-edge', screenshotPoint: null, coursePoint: null },
  { name: 'B', role: 'fit', kind: 'green-edge', screenshotPoint: null, coursePoint: null },
  { name: 'C', role: 'holdout', kind: 'fairway-edge', screenshotPoint: null, coursePoint: null },
  { name: 'D', role: 'holdout', kind: 'water-edge', screenshotPoint: null, coursePoint: null },
]
const kinds: Pair['kind'][] = [
  'bunker-edge', 'green-edge', 'fairway-edge', 'water-edge', 'cartpath-corner', 'pin',
]
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const svgPoint = (e: ReactMouseEvent<SVGSVGElement>): XY | null => {
  const svg = e.currentTarget
  const matrix = svg.getScreenCTM()
  if (!matrix) return null
  const p = svg.createSVGPoint()
  p.x = e.clientX
  p.y = e.clientY
  const q = p.matrixTransform(matrix.inverse())
  return finite(q.x) && finite(q.y) ? [q.x, q.y] : null
}
const transform = (m: readonly (readonly number[])[], p: XY): XY | null => {
  if (m.length !== 2 || m.some(row => row.length !== 3 || !row.every(finite))) return null
  return [
    m[0][0] * p[0] + m[0][1] * p[1] + m[0][2],
    m[1][0] * p[0] + m[1][1] * p[1] + m[1][2],
  ]
}
const canonicalPixel = (obs: LooperCompanionLiveObservations, p: XY, crop: Crop): XY | null => {
  const roi = obs.minimap?.minimapRoiWindowPixels
  const matrix = obs.minimap?.registration?.currentToCanonicalMatrix
  if (!roi || roi.length !== 4 || !roi.every(finite) || roi[2] <= 0 || roi[3] <= 0 || !matrix) return null
  return transform(matrix, [(p[0]-crop.x) / crop.w * roi[2], (p[1]-crop.y) / crop.h * roi[3]])
}
const surfaceColors: Record<string, string> = {
  rough:'#456d39', 'deep-rough':'#293e2a', fairway:'#689b4b',
  green:'#aecb80', bunker:'#d3c19b', water:'#488caf', penalty:'#488caf', tee:'#a5c17d',
}
const exportJson = (name: string, value: unknown) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url; link.download = name; link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function GsproCourseAlignmentLab() {
  const courses = useMemo(() => courseRegistry.filter(c =>
    c.id === GREYWOLF_COURSE_ID || c.packageStatus === 'ready'), [])
  const [courseId, setCourseId] = useState<CourseId>(GREYWOLF_COURSE_ID)
  const [hole, setHole] = useState(8)
  const [geometry, setGeometry] = useState<CourseHoleGeometry | null>(null)
  const [geometryError, setGeometryError] = useState('')
  const [obs, setObs] = useState<LooperCompanionLiveObservations | null>(null)
  const [lastChecked, setLastChecked] = useState<LooperCompanionLiveObservations | null>(null)
  const [nativeError, setNativeError] = useState('')
  const [busy, setBusy] = useState(false)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [imageSize, setImageSize] = useState<XY | null>(null)
  const [cropStart, setCropStart] = useState<XY | null>(null)
  const [crop, setCrop] = useState<Crop | null>(null)
  const [pairs, setPairs] = useState<Pair[]>(freshPairs)
  const [active, setActive] = useState(0)
  const [confirmed, setConfirmed] = useState(false)
  const [result, setResult] = useState<ReturnType<typeof evaluateGsproToCourseLandmarkRegistration> | null>(null)
  const [imageError, setImageError] = useState('')

  useEffect(() => {
    let cancelled = false
    setGeometry(null); setGeometryError(''); setPairs(freshPairs()); setResult(null); setConfirmed(false)
    loadCourseHoleGeometry(courseId, hole)
      .then(data => { if (!cancelled) setGeometry(data) })
      .catch(error => { if (!cancelled) setGeometryError(String(error)) })
    return () => { cancelled = true }
  }, [courseId, hole])
  useEffect(() => () => { if (imageUrl) URL.revokeObjectURL(imageUrl) }, [imageUrl])

  const loadScreenshot = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    if (!file) return
    setImageError('')
    if (!file.type.startsWith('image/') || file.size > 30000000) {
      setImageError('Use a PNG/JPEG/WebP under 30 MB.'); return
    }
    const url = URL.createObjectURL(file), image = new Image()
    image.onload = () => {
      if (image.naturalWidth < 300 || image.naturalHeight < 300) {
        URL.revokeObjectURL(url); setImageError('Screenshot resolution is too small.'); return
      }
      setImageUrl(url); setImageSize([image.naturalWidth, image.naturalHeight])
      setCrop(null); setCropStart(null); setPairs(freshPairs()); setResult(null); setConfirmed(false)
    }
    image.onerror = () => { URL.revokeObjectURL(url); setImageError('Could not decode screenshot.') }
    image.src = url
  }
  const readNative = async () => {
    setBusy(true); setNativeError(''); setResult(null)
    try {
      const value = await readLooperCompanionObservations(45000)
      setObs(value)
      return value
    } catch (error) {
      setNativeError(error instanceof Error ? error.message : String(error))
      return null
    } finally { setBusy(false) }
  }
  const clickImage = (event: ReactMouseEvent<SVGSVGElement>) => {
    const point = svgPoint(event)
    if (!point || !imageSize) return
    setResult(null)
    if (!crop) {
      if (!cropStart) { setCropStart(point); return }
      const next = {
        x: Math.min(point[0], cropStart[0]), y: Math.min(point[1], cropStart[1]),
        w: Math.abs(point[0]-cropStart[0]), h: Math.abs(point[1]-cropStart[1]),
      }
      setCropStart(null)
      if (next.w < 80 || next.h < 80) {
        setImageError('Crop was too small. Start again.'); return
      }
      setCrop(next); setImageError(''); return
    }
    if (point[0] < crop.x || point[0] > crop.x+crop.w ||
      point[1] < crop.y || point[1] > crop.y+crop.h) return
    setPairs(old => old.map((pair,i) => i===active ? {...pair,screenshotPoint:point} : pair))
  }
  const clickMap = (event: ReactMouseEvent<SVGSVGElement>) => {
    const point = svgPoint(event)
    if (!point) return
    setResult(null)
    setPairs(old => old.map((pair,i) => i===active ?
      {...pair,coursePoint:[point[0],-point[1]]} : pair))
  }
  const roi = obs?.minimap?.minimapRoiWindowPixels
  const ratioError = crop && roi && finite(roi[2]) && finite(roi[3])
    ? Math.abs(crop.w/crop.h/(roi[2]/roi[3])-1) : null
  const activeCourseKey = obs?.structured?.shot?.courseKey
  const activeCourseId = activeCourseKey ? resolveCourseIdFromGsproName(activeCourseKey) : null
  const canEvaluate = Boolean(geometry && crop && ratioError !== null && ratioError <= .12 && confirmed
    && obs && obs.status === 'ready' && obs.gspro?.status === 'connected'
    && pairs.slice(0,3).every(pair=>pair.screenshotPoint && pair.coursePoint))
  const evaluate = async () => {
    if (!canEvaluate || !crop) return
    // The user may spend minutes marking points; refresh the native frame at
    // the moment of evaluation rather than accepting stale telemetry.
    const updated = await readNative()
    if (!updated) return
    setLastChecked(updated)
    const shot = updated.structured?.shot
    const matchedCourse = shot?.courseKey ? resolveCourseIdFromGsproName(shot.courseKey) : null
    if (matchedCourse !== courseId || shot?.holeNumber !== hole ||
      shot.kind !== 'pre_shot' || shot.status !== 'ready' ||
      !finite(shot.roundId) || updated.gspro?.status !== 'connected' ||
      updated.gspro.window?.minimized !== false ||
      updated.gspro.window.dpiAwareness !== 'per-monitor') {
      setNativeError('No confirmed live PRE-SHOT for this course and hole. A last-completed shot may be from the previous hole; export evidence and retry on an active pre-shot.')
      return
    }
    const landmarks: CrossFrameLandmark[] = []
    for (let i=0;i<pairs.length;i++) {
      const pair=pairs[i]
      if (!pair.screenshotPoint || !pair.coursePoint) continue
      const pixel=canonicalPixel(updated,pair.screenshotPoint,crop)
      if (!pixel) {
        setNativeError('Current-to-tee minimap registration matrix is missing. Start on the tee first.')
        return
      }
      landmarks.push({
        featureId:'osm-'+pair.kind+'-'+i, nativeFeatureId:'manual-native-'+pair.kind+'-'+i,
        kind:pair.kind, role:pair.role, gsproCanonicalPixel:pixel,
        courseLocalYds:pair.coursePoint, evidence:'independently-reviewed', spatialAccuracy:'exact',
      })
    }
    setResult(evaluateGsproToCourseLandmarkRegistration({
      expected:{courseId,gsproCourseKey:shot.courseKey!,roundId:shot.roundId,holeNumber:hole},
      native:{
        courseId:matchedCourse!,gsproCourseKey:shot.courseKey!,roundId:shot.roundId,holeNumber:hole,
        observedAt:updated.observedAt || '', frame:'canonical-tee-minimap-roi',
        minimapStatus:updated.minimap?.status || 'unknown',
        registrationStatus:updated.minimap?.registration?.status || 'unavailable',
        teeScaleYardsPerPixel: updated.minimap?.registration?.teeScaleYardsPerPixel ??
          updated.minimap?.scale?.yardsPerPixel ?? null,
        whitePinErrorPixels:updated.minimap?.registration?.pinErrorPixels ?? null,
      },landmarks,
    },Date.now()))
  }
  const save = () => exportJson('looper-osm-registration-'+courseId+'-h'+hole+'.json',{
    schemaVersion:'looper-manual-osm-alignment-research-v1',
    note:'Screenshot stays in browser. This is NOT a verified course, tee, playable ball or AutoAim calibration.',
    courseId,hole,imageSize,crop,ratioError,
    native: (lastChecked||obs) ? {
      observedAt:(lastChecked||obs)?.observedAt,
      courseKey:(lastChecked||obs)?.structured?.shot?.courseKey,
      shot:(lastChecked||obs)?.structured?.shot,
      minimap:(lastChecked||obs)?.minimap,
      timingMs:(lastChecked||obs)?.timingMs,
    }:null,
    pairs:pairs.map((p,i)=>({
      index:i,kind:p.kind,role:p.role,courseLocalYds:p.coursePoint,
      screenshotPixel:p.screenshotPoint,
      nativeRoiPixel:crop && roi && p.screenshotPoint ? [
        (p.screenshotPoint[0]-crop.x)/crop.w*roi[2],
        (p.screenshotPoint[1]-crop.y)/crop.h*roi[3],
      ]:null,
    })),
    result,
  })
  const mapBounds=geometry?.viewBounds||geometry?.bounds
  const box=mapBounds?{
    minX:mapBounds.minX-25,maxX:mapBounds.maxX+25,
    minY:mapBounds.minY-25,maxY:mapBounds.maxY+25,
  }:null
  const circleR=crop?Math.max(crop.w,crop.h)*.012:12
  return <main className="gspro-align-lab">
    <header><div className="eyebrow">The Looper · OSM ↔ GSPro · read-only research</div>
      <h1>Course alignment workbench</h1>
      <p>Match exact physical landmarks on a local GSPro screenshot to Looper's existing course map.
        No new hazard model, no Chrome screen share, no image upload and no mouse/AutoAim commands.
        A numerical candidate is <strong>not permission to play or publish a course</strong>.</p>
      <a href="/dev/companion-observations.html">Companion diagnostics</a>
      {' · '}<a href="/live-caddie">Live Caddie</a>
    </header>
    <section className="align-controls">
      <label>Course <select value={courseId} onChange={e=>setCourseId(e.target.value as CourseId)}>
        {courses.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label>Hole <select value={hole} onChange={e=>setHole(Number(e.target.value))}>
        {Array.from({length:18},(_,i)=>i+1).map(n=><option key={n} value={n}>{n}</option>)}
      </select></label>
      <button type="button" disabled={busy} onClick={()=>void readNative()}>
        {busy?'Reading…':'Read companion snapshot'}</button>
      <label>GSPro screenshot (local file) <input type="file" accept="image/png,image/jpeg,image/webp"
        onChange={loadScreenshot}/></label>
    </section>
    <section className="align-status">
      <strong>Course geometry:</strong> {geometry?
        geometry.courseName+' H'+hole+'; '+geometry.surfaces.length+' loaded source surface groups':
        geometryError||'Loading…'}
      <br/><strong>Native:</strong> {nativeError || (obs?
        (obs.gspro?.status||'?')+' / '+(obs.minimap?.status||'?')+' / '+(obs.minimap?.registration?.status||'?')+
          ' / shot '+(obs.structured?.shot?.kind||'?')+' H'+(obs.structured?.shot?.holeNumber??'?'):
        'Not read')}
      <br/><strong>Course identity:</strong> {activeCourseKey ? activeCourseKey+' → '+
        (activeCourseId||'unknown')+(activeCourseId===courseId?' ✓':' — mismatch'):'Not observed'}
      <br/><strong>GSPro minimap ROI:</strong> {roi?.length===4?roi.join(', '):'Not measured'}
      {ratioError!==null?' · crop aspect difference '+(ratioError*100).toFixed(1)+'% (must be ≤12%)':''}
      {imageError?<p className="align-danger">{imageError}</p>:null}
    </section>
    <p><strong>Instructions:</strong> Keep GSPro on a recognizable hole. Screenshot its full window.
      Click the screenshot minimap's top-left and bottom-right corners to crop it.
      For each pair A/B/C, select the landmark type, click its exact physical corner or edge
      on the enlarged GSPro minimap, then click <strong>that same point</strong> on the imported map.
      C must be a distinct off-axis point, not a reused feature. D is optional.
      Don't mark estimated green centroid as a real pin. Leave the hole/zoom unchanged.</p>
    <div className="align-pairs">{pairs.map((p,i)=><section key={p.name}
      className={'align-pair'+(i===active?' active':'')}>
      <button type="button" onClick={()=>setActive(i)}>{p.name} · {p.role}</button>
      <select aria-label={p.name+' feature kind'} value={p.kind} onChange={e=>{
        setPairs(old=>old.map((x,j)=>i===j?{...x,kind:e.target.value as Pair['kind']}:x))
        setResult(null)
      }}>{kinds.map(k=><option key={k} value={k}>{k}</option>)}</select>
      <small>GSPro {p.screenshotPoint?'✓':'—'} · Course {p.coursePoint?'✓':'—'}</small>
    </section>)}</div>
    <div className="align-maps">
      <section className="align-panel"><h2>1. GSPro screenshot (never uploaded)</h2>
        {imageUrl&&imageSize?<><button type="button" onClick={()=>{
          setCrop(null);setCropStart(null);setPairs(freshPairs());setResult(null)
        }}>Re-crop minimap</button>
        <small>{crop?'Crop ready: choose A/B/C above, click each landmark':
          cropStart?'Click lower-right minimap corner':'Click upper-left minimap corner'}</small>
        <svg className="align-image" role="img" aria-label="Local screenshot — click minimap landmarks"
          viewBox={crop?crop.x+' '+crop.y+' '+crop.w+' '+crop.h:
            '0 0 '+imageSize[0]+' '+imageSize[1]} onClick={clickImage}>
          <image href={imageUrl} x={0} y={0} width={imageSize[0]} height={imageSize[1]}/>
          {cropStart&&!crop?<circle cx={cropStart[0]} cy={cropStart[1]} r={15} fill="#e4f590"/>:null}
          {crop?pairs.map(p=>p.screenshotPoint?<g key={p.name}>
            <circle cx={p.screenshotPoint[0]} cy={p.screenshotPoint[1]} r={circleR}
              fill="#ffffbb" stroke="#163225" strokeWidth={2}/>
            <text x={p.screenshotPoint[0]+circleR*1.2} y={p.screenshotPoint[1]}
              fontSize={circleR*2.5} fill="white" stroke="#163225"
              strokeWidth={1} paintOrder="stroke">{p.name}</text>
          </g>:null):null}
        </svg></>:<p>Choose an original-resolution screenshot from the sim PC.</p>}
      </section>
      <section className="align-panel"><h2>2. Imported course polygons</h2>
        {geometry&&box?<svg className="align-course" role="img" onClick={clickMap}
          aria-label="Click matching imported course landmarks"
          viewBox={box.minX+' '+(-box.maxY)+' '+(box.maxX-box.minX)+' '+(box.maxY-box.minY)}>
          <rect x={box.minX} y={-box.maxY} width={box.maxX-box.minX}
            height={box.maxY-box.minY} fill="#203528"/>
          {geometry.contextLayers?.filter(x=>x.kind==='woods'||x.kind==='scrub').flatMap(x=>
            x.polygons.map((poly,i)=><polygon key={x.id+i}
              points={poly.map(p=>p[0]+','+(-p[1])).join(' ')}
              fill="#29432e" opacity={.75}/>))}
          {geometry.surfaces.filter(x=>x.kind!=='tee').flatMap(surface=>
            surface.polygons.map((poly,i)=><polygon key={surface.id+i}
              points={poly.map(p=>p[0]+','+(-p[1])).join(' ')}
              fill={surfaceColors[surface.kind]||'#527644'}
              stroke="#d7e0b8" strokeOpacity={.3} strokeWidth={.7}/>))}
          {pairs.map(p=>p.coursePoint?<g key={p.name}>
            <circle cx={p.coursePoint[0]} cy={-p.coursePoint[1]} r={4.5}
              stroke="#16271b" fill="#fff5b1" strokeWidth={2}/>
            <text x={p.coursePoint[0]+6} y={-p.coursePoint[1]-4}
              fontSize={13} fill="white" stroke="#16271b"
              strokeWidth={2} paintOrder="stroke">{p.name}</text>
          </g>:null)}
        </svg>:<p>{geometryError||'Loading existing imported hole…'}</p>}
        <small>Uses Looper's existing surfaces and hazard coordinates—no reclassification.</small>
      </section>
    </div>
    <section className="align-evaluate">
      <label><input type="checkbox" checked={confirmed} onChange={e=>{
        setConfirmed(e.target.checked);setResult(null)
      }}/> I independently confirmed every marked pair describes the <strong>same physical
      landmark</strong>—not an assumed centroid or nearby hole.</label>
      <div className="align-actions">
        <button type="button" disabled={!canEvaluate||busy} onClick={()=>void evaluate()}>
          Refresh live native &amp; evaluate (no clicks)</button>
        <button type="button" onClick={save}>Export evidence JSON (no screenshot)</button>
      </div>
      {!canEvaluate?<p>To evaluate: read the Companion, crop screenshot within 12% of native
        minimap ratio, mark A/B/C on both maps, and confirm the matches.</p>:null}
      {result?<div className={result.status==='research-candidate'?'align-good':'align-danger'}>
        <h3>{result.status==='research-candidate'?'Research candidate — not approved':
          'Blocked — alignment not established'}</h3>
        <p>{result.reason}</p>
        <dl><dt>Fit RMS</dt><dd>{result.fitRmsYds??'—'} yd</dd>
          <dt>Holdout max error</dt><dd>{result.holdoutMaxErrorYds??'—'} yd</dd>
          <dt>Scale mismatch</dt><dd>{result.scaleDifferencePercent??'—'}%</dd>
          <dt>Off-axis separation</dt><dd>{result.holdoutOffAxisYds??'—'} yd</dd>
        </dl>
      </div>:null}
      <small>Passing points do not certify unmapped hazards, tee location, green slopes,
        playable course or AutoAim input. A completed-shot record from a previous hole
        is deliberately insufficient to validate the current pre-shot.</small>
    </section>
  </main>
}
