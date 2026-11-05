// "Refresh wind" (src/adapters/gsproWindObservation.ts) and the scene turn for wind (windProjection.ts).
import assert from 'node:assert/strict'

let server = null
const load = globalThis.__looperTestLoad ?? (async (path) => {
  if (!server) {
    const { createServer } = await import('vite')
    server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  }
  return server.ssrLoadModule(path)
})

// A tiny window: listeners and dispatch.
const listeners = new Map()
globalThis.window = {
  addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
  removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)),
  dispatchEvent: (event) => { for (const fn of listeners.get(event.type) ?? []) fn(event); return true },
  setInterval: () => 0, clearInterval: () => undefined,
}
globalThis.CustomEvent = class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail } }

try {
  const wind = await load('/src/adapters/gsproWindObservation.ts')
  const seen = []
  const connection = wind.connectToGsproWindObservation({ onObservation: (o) => seen.push(o) })
  const read = (mph, deg) => ({ status: 'READY', speedMph: mph, directionDegrees: deg, convention: 'from',
    referenceFrame: 'compass', observedAt: new Date().toISOString(), rawText: `${mph} MPH` })

  wind.dispatchGsproWindOcrObservation(read(15, 315))
  assert.equal(connection.getLatest().speedMph, 15)
  // Within a shot the wind is frozen: another passive read doesn't change it...
  wind.dispatchGsproWindOcrObservation(read(25, 300))
  assert.equal(connection.getLatest().speedMph, 15)
  // ...but Refresh does (a gusty day swirls).
  wind.requestGsproWindRefresh(read(25, 300))
  assert.equal(connection.getLatest().speedMph, 25)
  assert.equal(connection.getLatest().directionDegrees, 300)
  // A failed read keeps the wind Looper had.
  wind.requestGsproWindRefresh({ status: 'UNKNOWN', observedAt: new Date().toISOString() })
  assert.equal(connection.getLatest().speedMph, 25)
  connection.disconnect()

  // GSPro's compass is the scene's: Kiawah's scene is turned ~179.4 deg, so
  // "NW" (315) in GSPro is from the south-east in the real world.
  const { windInTrueCompass } = await load('/src/liveState/windProjection.ts')
  const turned = windInTrueCompass({ ...read(19, 315), status: 'READY' }, 179.4, false)
  assert.ok(Math.abs(turned.directionDegrees - 135.6) < 0.01, `true from ${turned.directionDegrees}`)
  console.log('wind refresh: frozen per shot, Refresh replaces it with a good read only; scene turn applied to GSPro compass.')
} finally {
  await server?.close()
}
