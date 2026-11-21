// Engine elevation handling vs Wander's calm, clean-lie shots. Run from the repo root:
//   node tools/gspro_lie_lab/elevation_check.mjs <wander_shots.csv from analyze_wander.py>
import fs from 'node:fs'
import { createServer } from 'vite'
const [csvPath] = process.argv.slice(2)
const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
const { simulateFlight } = await server.ssrLoadModule('/src/liveCaddie/flightPhysics.ts')
const { gsproAltitudeCarryFraction } = await server.ssrLoadModule('/src/liveCaddie/airAltitudeAdjustment.ts')
const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n')
const head = lines[0].split(',')
const rows = lines.slice(1).map((l) => Object.fromEntries(l.split(',').map((v, i) => [head[i], v])))
const n = (v) => (v === '' || v == null ? null : Number(v))
const out = []
for (const r of rows) {
  if (r.left_out || r.windy === 'True' || !['fairway', 'tee'].includes(r.lie) || r.speed_kept) continue
  const carry = n(r.carry), ratio = n(r.carry_vs_flat), drop = n(r.drop_ft), alt = n(r.altitude_ft) ?? 0
  const launch = { ballSpeedMph: n(r.sent_speed_mph), vlaDeg: n(r.sent_vla_deg), totalSpinRpm: n(r.sent_spin_rpm) }
  if (!carry || carry < 40 || ratio == null || drop == null || !launch.ballSpeedMph) continue
  const level = simulateFlight(launch, { airAltitudeFt: alt })
  const atDrop = simulateFlight(launch, { airAltitudeFt: alt, landingElevationDeltaFt: drop })
  if (!level.ok || !atDrop.ok) continue
  const measured = 100 * (ratio / (1 + gsproAltitudeCarryFraction(launch, alt)) - 1)
  const engine = 100 * (atDrop.carryYds / level.carryYds - 1)
  out.push({ drop, measured, engine, carry, alt, course: r.course_key })
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null }
const fit = (xs, ys) => { const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length
  let sxx = 0, sxy = 0; xs.forEach((x, i) => { sxx += (x - mx) ** 2; sxy += (x - mx) * (ys[i] - my) }); return sxy / sxx }
console.log(`shots ${out.length}`)
console.log(`slope %/10 ft: measured ${(10 * fit(out.map((o) => o.drop), out.map((o) => o.measured))).toFixed(2)}, engine ${(10 * fit(out.map((o) => o.drop), out.map((o) => o.engine))).toFixed(2)}`)
const bands = [[-999, -20], [-20, -5], [-5, 5], [5, 20], [20, 999]]
for (const [lo, hi] of bands) {
  const g = out.filter((o) => o.drop >= lo && o.drop < hi)
  if (!g.length) continue
  console.log(`${String(lo).padStart(4)}..${String(hi).padEnd(4)} ft  n=${String(g.length).padStart(3)}  measured ${med(g.map((o) => o.measured)).toFixed(1)}%  engine ${med(g.map((o) => o.engine)).toFixed(1)}%  diff(yd) ${med(g.map((o) => (o.measured - o.engine) * o.carry / 100)).toFixed(1)}`)
}
const off = out.filter((o) => Math.abs(o.drop) >= 5)
console.log(`|drop|>=5 ft: n=${off.length}, median miss ${med(off.map((o) => (o.measured - o.engine) * o.carry / 100)).toFixed(2)} yd, median |miss| ${med(off.map((o) => Math.abs(o.measured - o.engine) * o.carry / 100)).toFixed(2)} yd`)
await server.close()
