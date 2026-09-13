import { useEffect, useMemo, useState } from 'react'

type OsmNode = { lat: number; lon: number }
type OsmMember = { type?: string; role?: string; geometry?: OsmNode[] }
type OsmElement = {
  type: 'node' | 'way' | 'relation'
  id: number
  tags?: Record<string, string>
  geometry?: OsmNode[]
  members?: OsmMember[]
}

type GolfFeature = {
  key: string
  osmType: OsmElement['type']
  osmId: number
  golf: string
  name?: string
  ref?: string
  geometry: OsmNode[]
}

type LocalPoint = { x: number; y: number }
type LocalFeature = GolfFeature & { local: LocalPoint[] }

type OverpassResponse = { elements?: OsmElement[] }

const GREYWOLF = {
  name: 'Greywolf Golf Course',
  lat: 50.452,
  lon: -116.244,
  south: 50.414,
  west: -116.295,
  north: 50.493,
  east: -116.194,
}

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter',
]

const YARDS_PER_METER = 1.0936133
const EARTH_RADIUS_M = 6_378_137

function geometryForElement(element: OsmElement): OsmNode[][] {
  if (element.geometry && element.geometry.length > 1) {
    return [element.geometry]
  }
  if (element.type === 'relation' && element.members) {
    return element.members
      .map((member) => member.geometry)
      .filter((geometry): geometry is OsmNode[] => Boolean(geometry && geometry.length > 1))
  }
  return []
}

function normalizeGolfFeatures(elements: OsmElement[]): GolfFeature[] {
  const features: GolfFeature[] = []
  for (const element of elements) {
    const golf = element.tags?.golf
    if (!golf) continue
    const parts = geometryForElement(element)
    parts.forEach((geometry, index) => {
      features.push({
        key: `${element.type}-${element.id}-${index}`,
        osmType: element.type,
        osmId: element.id,
        golf,
        name: element.tags?.name,
        ref: element.tags?.ref,
        geometry,
      })
    })
  }
  return features
}

function toLocalYards(point: OsmNode, origin: OsmNode): LocalPoint {
  const lat0 = (origin.lat * Math.PI) / 180
  const dLat = ((point.lat - origin.lat) * Math.PI) / 180
  const dLon = ((point.lon - origin.lon) * Math.PI) / 180
  return {
    x: dLon * Math.cos(lat0) * EARTH_RADIUS_M * YARDS_PER_METER,
    y: dLat * EARTH_RADIUS_M * YARDS_PER_METER,
  }
}

function featureColor(golf: string) {
  switch (golf) {
    case 'green': return '#77c36a'
    case 'fairway': return '#4e9653'
    case 'tee': return '#93c87c'
    case 'bunker': return '#d5b66a'
    case 'water_hazard': return '#4c9dcc'
    case 'lateral_water_hazard': return '#4c9dcc'
    case 'rough': return '#275a34'
    case 'hole': return '#f0e7c9'
    case 'driving_range': return '#537f4e'
    default: return '#87958a'
  }
}

function isLikelyClosed(points: LocalPoint[]) {
  if (points.length < 3) return false
  const a = points[0]
  const b = points[points.length - 1]
  return Math.hypot(a.x - b.x, a.y - b.y) < 3
}

function fmt(value: number) {
  return Math.round(value).toLocaleString()
}

export default function OsmGeometryProofPage() {
  const [features, setFeatures] = useState<GolfFeature[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [endpoint, setEndpoint] = useState<string>('')
  const [elapsedMs, setElapsedMs] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false

    async function run() {
      setStatus('loading')
      setError(null)
      const query = `[out:json][timeout:30];\n(\n  way[\"golf\"](${GREYWOLF.south},${GREYWOLF.west},${GREYWOLF.north},${GREYWOLF.east});\n  relation[\"golf\"](${GREYWOLF.south},${GREYWOLF.west},${GREYWOLF.north},${GREYWOLF.east});\n);\nout tags geom;`
      const started = performance.now()
      let lastError: unknown = null

      for (const candidate of OVERPASS_ENDPOINTS) {
        try {
          const body = new URLSearchParams({ data: query })
          const response = await fetch(candidate, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body,
          })
          if (!response.ok) throw new Error(`Overpass ${response.status} ${response.statusText}`)
          const json = (await response.json()) as OverpassResponse
          const normalized = normalizeGolfFeatures(json.elements ?? [])
          if (!cancelled) {
            setFeatures(normalized)
            setEndpoint(candidate)
            setElapsedMs(performance.now() - started)
            setStatus('ready')
          }
          return
        } catch (caught) {
          lastError = caught
        }
      }

      if (!cancelled) {
        setError(lastError instanceof Error ? lastError.message : 'Unable to reach Overpass.')
        setElapsedMs(performance.now() - started)
        setStatus('error')
      }
    }

    void run()
    return () => { cancelled = true }
  }, [])

  const counts = useMemo(() => {
    const next = new Map<string, number>()
    features.forEach((feature) => next.set(feature.golf, (next.get(feature.golf) ?? 0) + 1))
    return [...next.entries()].sort((a, b) => b[1] - a[1])
  }, [features])

  const localFeatures = useMemo<LocalFeature[]>(() => {
    const origin = { lat: GREYWOLF.lat, lon: GREYWOLF.lon }
    return features.map((feature) => ({
      ...feature,
      local: feature.geometry.map((point) => toLocalYards(point, origin)),
    }))
  }, [features])

  const bounds = useMemo(() => {
    const points = localFeatures.flatMap((feature) => feature.local)
    if (!points.length) return { minX: -500, maxX: 500, minY: -500, maxY: 500 }
    return points.reduce((acc, point) => ({
      minX: Math.min(acc.minX, point.x),
      maxX: Math.max(acc.maxX, point.x),
      minY: Math.min(acc.minY, point.y),
      maxY: Math.max(acc.maxY, point.y),
    }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity })
  }, [localFeatures])

  const map = useMemo(() => {
    const width = 980
    const height = 720
    const pad = 30
    const spanX = Math.max(1, bounds.maxX - bounds.minX)
    const spanY = Math.max(1, bounds.maxY - bounds.minY)
    const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY)
    const contentW = spanX * scale
    const contentH = spanY * scale
    const left = (width - contentW) / 2
    const top = (height - contentH) / 2
    const project = (p: LocalPoint) => ({
      x: left + (p.x - bounds.minX) * scale,
      y: top + (bounds.maxY - p.y) * scale,
    })
    return { width, height, project }
  }, [bounds])

  const count = (golf: string) => counts.find(([key]) => key === golf)?.[1] ?? 0
  const coreSignals = [
    { label: 'Greens', value: count('green'), target: 18 },
    { label: 'Fairways', value: count('fairway'), target: 18 },
    { label: 'Hole lines', value: count('hole'), target: 18 },
    { label: 'Bunkers', value: count('bunker'), target: 1 },
  ]
  const strongCore = coreSignals.filter((signal) => signal.value >= signal.target).length
  const verdict = status !== 'ready'
    ? 'Waiting for live OSM data'
    : strongCore >= 3 && count('green') >= 15 && count('fairway') >= 15
      ? 'OSM-first geometry looks viable'
      : strongCore >= 2
        ? 'OSM looks useful, but needs GSPro/CV gap filling'
        : 'OSM is too incomplete here to be the primary geometry source'

  const widthYards = bounds.maxX - bounds.minX
  const heightYards = bounds.maxY - bounds.minY

  return (
    <main style={{ minHeight: '100vh', background: '#0e1710', color: '#fff', fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', padding: '28px' }}>
      <div style={{ maxWidth: 1380, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20, marginBottom: 22 }}>
          <div>
            <div style={{ color: '#d4b15a', fontSize: 12, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase' }}>Strategy lab · OSM proof</div>
            <h1 style={{ margin: '7px 0 6px', fontSize: 32 }}>Greywolf semantic geometry</h1>
            <div style={{ color: '#9fb09f', maxWidth: 760, lineHeight: 1.5 }}>
              Live OpenStreetMap golf polygons converted from latitude/longitude into a local yard coordinate system. This is intentionally independent of the GSPro minimap extractor.
            </div>
          </div>
          <a href="/" style={{ color: '#cfd8cd', textDecoration: 'none', border: '1px solid #314233', borderRadius: 9, padding: '9px 12px' }}>Back to Looper</a>
        </div>

        <section style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.7fr) minmax(300px, .7fr)', gap: 18 }}>
          <div style={{ background: '#142118', border: '1px solid #314233', borderRadius: 16, overflow: 'hidden' }}>
            <div style={{ padding: '14px 17px', borderBottom: '1px solid #314233', display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <strong>Raw OSM vector map</strong>
              <span style={{ color: '#9fb09f', fontSize: 13 }}>{status === 'loading' ? 'Loading Overpass…' : `${features.length} geometry parts`}</span>
            </div>
            <div style={{ padding: 12, background: '#101b13' }}>
              {status === 'error' ? (
                <div style={{ minHeight: 560, display: 'grid', placeItems: 'center', padding: 40, color: '#c85a4a', textAlign: 'center' }}>
                  <div><strong>Overpass request failed.</strong><br /><span style={{ color: '#cfd8cd' }}>{error}</span></div>
                </div>
              ) : (
                <svg viewBox={`0 0 ${map.width} ${map.height}`} style={{ width: '100%', maxHeight: '72vh', display: 'block', background: '#0b120d', borderRadius: 10 }} aria-label="Greywolf OpenStreetMap golf geometry">
                  {localFeatures
                    .slice()
                    .sort((a, b) => {
                      const order: Record<string, number> = { rough: 0, fairway: 1, water_hazard: 2, lateral_water_hazard: 2, bunker: 3, green: 4, tee: 5, hole: 6 }
                      return (order[a.golf] ?? 3) - (order[b.golf] ?? 3)
                    })
                    .map((feature) => {
                      const projected = feature.local.map(map.project)
                      const points = projected.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')
                      const closed = feature.golf !== 'hole' && isLikelyClosed(feature.local)
                      if (closed) {
                        return <polygon key={feature.key} points={points} fill={featureColor(feature.golf)} fillOpacity={feature.golf === 'rough' ? 0.33 : 0.76} stroke={featureColor(feature.golf)} strokeWidth={1.1} />
                      }
                      return <polyline key={feature.key} points={points} fill="none" stroke={featureColor(feature.golf)} strokeWidth={feature.golf === 'hole' ? 2.2 : 1.4} strokeOpacity={feature.golf === 'hole' ? 0.84 : 0.65} />
                    })}
                </svg>
              )}
            </div>
          </div>

          <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
            <div style={{ background: '#142118', border: '1px solid #314233', borderRadius: 14, padding: 17 }}>
              <div style={{ color: '#9fb09f', fontSize: 12, textTransform: 'uppercase', letterSpacing: '.1em' }}>Proof verdict</div>
              <div style={{ fontSize: 21, fontWeight: 800, marginTop: 7 }}>{verdict}</div>
              <div style={{ color: '#9fb09f', marginTop: 8, fontSize: 13, lineHeight: 1.45 }}>
                Green/fairway/hole counts are the coverage test. Bunkers test whether risk polygons are semantically useful.
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {coreSignals.map((signal) => (
                <div key={signal.label} style={{ background: '#172419', border: '1px solid #314233', borderRadius: 12, padding: 14 }}>
                  <div style={{ color: '#9fb09f', fontSize: 12 }}>{signal.label}</div>
                  <div style={{ fontSize: 26, fontWeight: 800, marginTop: 3 }}>{status === 'ready' ? signal.value : '—'}</div>
                  <div style={{ marginTop: 3, color: status === 'ready' && signal.value >= signal.target ? '#76d39b' : '#d18a3b', fontSize: 11 }}>
                    target {signal.target}{signal.label === 'Bunkers' ? '+' : ''}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ background: '#142118', border: '1px solid #314233', borderRadius: 14, padding: 17 }}>
              <div style={{ fontWeight: 750, marginBottom: 10 }}>All mapped golf tags</div>
              <div style={{ display: 'grid', gap: 7 }}>
                {counts.length ? counts.map(([tag, value]) => (
                  <div key={tag} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 }}>
                    <span style={{ color: '#cfd8cd' }}>golf={tag}</span><strong>{value}</strong>
                  </div>
                )) : <span style={{ color: '#9fb09f', fontSize: 13 }}>Waiting for data…</span>}
              </div>
            </div>

            <div style={{ background: '#142118', border: '1px solid #314233', borderRadius: 14, padding: 17, fontSize: 13, lineHeight: 1.5 }}>
              <div style={{ fontWeight: 750, marginBottom: 8 }}>Geometry diagnostics</div>
              <div style={{ color: '#cfd8cd' }}>Extent: {status === 'ready' ? `${fmt(widthYards)} × ${fmt(heightYards)} yd` : '—'}</div>
              <div style={{ color: '#cfd8cd' }}>Origin: {GREYWOLF.lat.toFixed(3)}, {GREYWOLF.lon.toFixed(3)}</div>
              <div style={{ color: '#cfd8cd' }}>Fetch: {elapsedMs == null ? '—' : `${Math.round(elapsedMs)} ms`}</div>
              <div style={{ color: '#9fb09f', marginTop: 8, overflowWrap: 'anywhere' }}>{endpoint || 'Trying public Overpass mirrors…'}</div>
            </div>
          </div>
        </section>

        <section style={{ marginTop: 18, background: '#142118', border: '1px solid #314233', borderRadius: 14, padding: 17 }}>
          <div style={{ fontWeight: 800, marginBottom: 8 }}>What this proves — and what it does not</div>
          <div style={{ color: '#cfd8cd', lineHeight: 1.55, fontSize: 14 }}>
            If the semantic coverage is strong, OSM can become the base fairway/green/bunker geometry and we only need to register this yard-space model to GSPro. It does <strong>not</strong> make GSPro extraction obsolete: red penalty lines, OB, simulator-specific edits, unmapped features, and fictional courses remain GSPro/CV overrides or fallbacks.
          </div>
        </section>
      </div>
    </main>
  )
}
