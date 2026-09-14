const BBOX = '50.43,-116.28,50.47,-116.22'
const OSM_ATTRIBUTION = '© OpenStreetMap contributors'
const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright'
const ODBL_LICENSE_URL = 'https://opendatacommons.org/licenses/odbl/1-0/'
const LOOPER_SOURCE_URL = 'https://github.com/bpgpitt10/nova-v0'

function summarize(elements) {
  const golf = {}
  const other = {}
  for (const el of elements) {
    const tags = el.tags || {}
    if (tags.golf) golf[tags.golf] = (golf[tags.golf] || 0) + 1
    else if (tags.natural === 'water') other.water = (other.water || 0) + 1
    else if (tags.waterway) other.waterway = (other.waterway || 0) + 1
  }
  return { golf, other, total: elements.length }
}

export default async function handler(req, res) {
  const query = `[out:json][timeout:25];(
    node["golf"](${BBOX});
    way["golf"](${BBOX});
    relation["golf"](${BBOX});
    way["natural"="water"](${BBOX});
    relation["natural"="water"](${BBOX});
    way["waterway"](${BBOX});
    relation["waterway"](${BBOX});
  );out tags geom;`

  const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': `The-Looper-OSM-Proof/0.1 (+${LOOPER_SOURCE_URL})`
      }
    })
    const text = await response.text()
    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after')
      if (retryAfter) res.setHeader('Retry-After', retryAfter)
      res.status(response.status).json({ ok: false, status: response.status, body: text.slice(0, 2000) })
      return
    }
    const data = JSON.parse(text)
    const elements = data.elements || []
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800')
    res.status(200).json({
      ok: true,
      course: 'Greywolf Golf Course, Panorama, BC',
      bbox: BBOX,
      osm: {
        attribution: OSM_ATTRIBUTION,
        sourceUrl: OSM_COPYRIGHT_URL,
        license: 'ODbL 1.0',
        licenseUrl: ODBL_LICENSE_URL,
        upstreamNotice: data.osm3s?.copyright || null,
        baseTimestamp: data.osm3s?.timestamp_osm_base || null
      },
      osmTimestamp: data.osm3s?.timestamp_osm_base || null,
      summary: summarize(elements),
      elements: elements.map((el) => ({
        type: el.type,
        id: el.id,
        tags: el.tags || {},
        lat: el.lat,
        lon: el.lon,
        bounds: el.bounds,
        geometry: el.geometry,
        members: el.members
      }))
    })
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.stack || error) })
  }
}
