import { useEffect, useMemo, useState } from 'react'

type Point = [number, number]
type Hole = {
  hole: number
  par?: number
  referenceYards?: number
  surfaces?: Record<string, Point[][]>
  context?: Record<string, Point[][]>
  teeCandidates?: { coursePoint: Point; teeSet?: string; label?: string; selectedAnchor?: boolean }[]
  teePointEvidence?: { coursePoint: Point; label?: string; source?: string }[]
  mapFeatures?: { cartpath?: { lines?: Point[][] } }
  coordinateFrame?: { origin?: string; teeAnchorMethod?: string }
  viewBounds?: { minX: number; maxX: number; minY: number; maxY: number }
  terrain?: { source?: string; sourceResolutionMeters?: number; width?: number; height?: number; valuesBase64?: string }
}
type Package = { courseName: string; holes: Record<string, Hole> }
type ReviewEntry = {
  id: string; name: string; location: string; slug: string; packageUrl: string
  greenDetailUrl: string; mapReady: boolean; liveReady: boolean
  teeMappedHoles: number; teePointEvidence: number
}

const palettes = {
  rough: '#486044', 'deep-rough': '#284338', fairway: '#6da765',
  green: '#a4d8a0', bunker: '#e5d9a8', water: '#4d88b4',
  penalty: '#b46d65', tee: '#d4e8bc',
} as const
const layers = ['rough', 'deep-rough', 'fairway', 'tee', 'bunker', 'water', 'penalty', 'green'] as const
const backgroundLayers: { kind: string; fill: string }[] = [
  {kind:'landcover-grass',fill:'#3c5240'},
  {kind:'landcover-woods',fill:'#243c31'},
  {kind:'woods',fill:'#1d352a'},
  {kind:'scrub',fill:'#354c34'},
]
const poly = (points: Point[]) => points.map(point=>point.join(',')).join(' ')
const count = (hole: Hole, kind: string) => hole.surfaces?.[kind]?.length ?? 0

export default function CourseMapReviewPage() {
  const [courses, setCourses] = useState<ReviewEntry[]>([])
  const [selectedSlug, setSelectedSlug] = useState(new URLSearchParams(window.location.search).get('course') ?? '')
  const [pkg, setPkg] = useState<Package | null>(null)
  const [holeNo, setHoleNo] = useState(1)
  const [showContext, setShowContext] = useState(true)
  const [showTees, setShowTees] = useState(true)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    const controller = new AbortController()
    fetch('/course-review/index-v1.json', {signal:controller.signal})
      .then(async res=>{ if (!res.ok) throw Error('No published staging map-review manifest'); return res.json() })
      .then(data=>{
        const list: ReviewEntry[] = Array.isArray(data.courses) ? data.courses : []
        setCourses(list)
        setSelectedSlug(current=>list.some(x=>x.slug===current) ? current : list[0]?.slug ?? '')
      })
      .catch(e=>{ if(!controller.signal.aborted) setError(String(e)) })
      .finally(()=>{ if(!controller.signal.aborted) setLoading(false) })
    return ()=>controller.abort()
  },[])
  const entry=useMemo(()=>courses.find(x=>x.slug===selectedSlug),[courses,selectedSlug])
  useEffect(()=>{
    if(!entry){setPkg(null);return}
    const controller=new AbortController()
    setError('')
    setPkg(null)
    fetch(entry.packageUrl,{signal:controller.signal})
      .then(async res=>{if(!res.ok) throw Error('Map package unavailable ('+res.status+')');return res.json()})
      .then(data=>{if(!controller.signal.aborted)setPkg(data)})
      .catch(e=>{if(!controller.signal.aborted)setError(String(e))})
    return ()=>controller.abort()
  },[entry])
  const hole=pkg?.holes?.[String(holeNo)]
  const b=hole?.viewBounds
  const validBounds=Boolean(b && [b.minX,b.maxX,b.minY,b.maxY].every(Number.isFinite) && b.maxX>b.minX && b.maxY>b.minY)
  const width=b ? b.maxX-b.minX : 200, height=b ? b.maxY-b.minY : 500
  const pad= Math.max(width,height)*.035
  const panel={background:'#142219',border:'1px solid #304737',borderRadius:14,padding:18} as const
  return <main style={{minHeight:'100vh',background:'#0b150f',color:'#edf4eb',fontFamily:'Inter,system-ui,sans-serif',padding:'clamp(16px,3vw,36px)'}}>
    <div style={{maxWidth:1420,margin:'0 auto'}}>
      <header style={{display:'flex',justifyContent:'space-between',gap:14,flexWrap:'wrap',alignItems:'center',marginBottom:22}}>
        <div>
          <div style={{fontSize:12,letterSpacing:2.8,textTransform:'uppercase',color:'#9bbb9d'}}>The Looper · Geometry QA</div>
          <h1 style={{fontSize:28,margin:'8px 0'}}>Course map review</h1>
          <p style={{color:'#a7b7a7',maxWidth:670,margin:0}}>Read-only 2D preview. Map and terrain validation are separate from tee calibration. Not a playable course or a GSPro tee registration.</p>
        </div>
        <a style={{color:'#b0dca6'}} href="/round-setup">Return to Round Setup</a>
      </header>
      {loading && <p>Loading staging map catalog…</p>}
      {error && <p role="alert" style={{color:'#f4b6a6'}}>Map review error: {error}</p>}
      {!loading && courses.length===0 && <div style={panel}>No map-ready packages have been published to this preview yet.</div>}
      {courses.length>0 && <div style={{...panel,display:'flex',alignItems:'center',gap:14,flexWrap:'wrap',marginBottom:18}}>
        <label htmlFor="review-course" style={{color:'#c1d4bc'}}>Course</label>
        <select id="review-course" value={selectedSlug} onChange={e=>{setSelectedSlug(e.target.value);setHoleNo(1)}} style={{background:'#23372a',color:'#fff',border:'1px solid #44634d',padding:10,borderRadius:8,minWidth:260}}>
          {courses.map(c=><option key={c.slug} value={c.slug}>{c.name} — {c.location}</option>)}
        </select>
        <span style={{color:'#b4d5a7'}}>Map-ready</span>
        <span style={{color:entry?.liveReady ? '#b4d5a7' : '#edc78d'}}>{entry?.liveReady?'Live-validated':'Tee calibration pending · NOT live-ready'}</span>
        <span style={{color:'#a9bcaa'}}>Mapped tee surfaces: {entry?.teeMappedHoles ?? 0}/18 holes</span>
      </div>}
      {pkg && <div style={{display:'grid',gridTemplateColumns:'minmax(260px,1fr) minmax(300px,2.4fr)',gap:18}}>
        <aside style={{...panel,alignSelf:'start'}}>
          <h2 style={{fontSize:17,margin:'0 0 14px'}}>Select a hole</h2>
          <div style={{display:'grid',gridTemplateColumns:'repeat(6,minmax(0,1fr))',gap:6}}>
            {Array.from({length:18},(_,i)=>i+1).map(n=>{
              const h=pkg.holes[String(n)]
              return <button key={n} type="button" onClick={()=>setHoleNo(n)} aria-pressed={holeNo===n} title={'Hole '+n+': '+((h?.surfaces?.tee?.length??0)>0?'mapped tee area':'estimated route start')} style={{
                padding:'12px 3px',fontWeight:700,borderRadius:7,cursor:'pointer',
                border:holeNo===n?'1px solid #c6e5a9':'1px solid #3d5943',
                color:holeNo===n?'#132919':'#e9f4e9',
                background:holeNo===n?'#a8d39a':'#23392a'}}>{n}</button>
            })}
          </div>
          <div style={{marginTop:22,color:'#afc7ae',fontSize:13,lineHeight:1.8}}>
            <div>Hole {holeNo} · Par {hole?.par ?? '—'} · OSM route {Math.round(hole?.referenceYards ?? 0)} yd</div>
            <div>Fairway polygons: {hole?count(hole,'fairway'):0}</div>
            <div>Bunkers: {hole?count(hole,'bunker'):0} · Water: {hole?count(hole,'water'):0}</div>
            <div>Green polygons: {hole?count(hole,'green'):0}</div>
            <div>Mapped tee polygons: {hole?count(hole,'tee'):0}</div>
            <div>Named tee points: {hole?.teePointEvidence?.length ?? 0}</div>
            <div>Terrain: {hole?.terrain?.source ?? 'not shown'} ({hole?.terrain?.sourceResolutionMeters ?? '?'} m source)</div>
          </div>
          <label style={{display:'block',marginTop:16,fontSize:14}}><input type="checkbox" checked={showContext} onChange={e=>setShowContext(e.target.checked)}/> Vegetation and surrounding context</label>
          <label style={{display:'block',marginTop:10,fontSize:14}}><input type="checkbox" checked={showTees} onChange={e=>setShowTees(e.target.checked)}/> Tee-area evidence</label>
          <p style={{fontSize:12,lineHeight:1.6,color:'#d9bd88',marginTop:20}}>Dashed circle marks the mapped OSM hole-route start, not a verified set of tees. A real tee polygon is shown only if OSM supplies it. Scorecard tee colors are not inferred.</p>
        </aside>
        <section style={{...panel,padding:12,minWidth:0}}>
          {hole && validBounds && b ? <svg role="img" aria-label={'2D OpenStreetMap geometry for '+pkg.courseName+' hole '+holeNo} viewBox={[b.minX-pad,b.minY-pad,width+2*pad,height+2*pad].join(' ')} preserveAspectRatio="xMidYMid meet" style={{width:'100%',height:'min(75vh,850px)',background:'#1c3127',borderRadius:9}}>
            <g transform={`translate(0 ${b.minY+b.maxY}) scale(1 -1)`}>
              {showContext && backgroundLayers.map(({kind,fill})=>(hole.context?.[kind]??[]).map((points,i)=><polygon key={kind+i} points={poly(points)} fill={fill} opacity=".7"/>))}
              {layers.map(kind=>(hole.surfaces?.[kind]??[]).map((points,i)=><polygon key={kind+i} points={poly(points)} fill={palettes[kind]} opacity={kind==='deep-rough'?.7:.92} stroke={kind==='green'?'#d6edcc':'none'} strokeWidth={kind==='green'?1:0}/>))}
              {showContext && (hole.mapFeatures?.cartpath?.lines??[]).map((points:Point[],i:number)=><polyline key={'cart'+i} points={poly(points)} fill="none" stroke="#8b927e" strokeWidth="1.2" opacity=".65"/>)}
              {showTees && (hole.teeCandidates??[]).map((p,i)=><circle key={'tee'+i} cx={p.coursePoint[0]} cy={p.coursePoint[1]} r="3.5" fill="#e5f2bf" stroke="#253626" strokeWidth=".9"/>)}
              {showTees && (hole.teePointEvidence??[]).map((p,i)=><circle key={'pt'+i} cx={p.coursePoint[0]} cy={p.coursePoint[1]} r="3.5" fill="#e1a966" stroke="#28311e" strokeWidth=".9"/>)}
              {hole.coordinateFrame?.origin==='osm-hole-route-start' && <circle cx={0} cy={0} r="6" fill="none" stroke="#f3e2af" strokeWidth="1.6" strokeDasharray="3 2"/>}
            </g>
          </svg> : <p>Hole map unavailable.</p>}
          <div style={{display:'flex',flexWrap:'wrap',gap:14,justifyContent:'center',marginTop:12,fontSize:12}}>
            {(['fairway','green','bunker','water','deep-rough','tee'] as const).map(kind=><span key={kind}><i style={{background:palettes[kind],width:11,height:11,display:'inline-block',marginRight:6,borderRadius:3}}/>{kind}</span>)}
          </div>
        </section>
      </div>}
    </div>
  </main>
}
