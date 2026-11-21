// Does stimp change how far an approach releases on the green, and is it the way the model says?
//
// The model (src/liveCaddie/greenReleaseModel.ts) takes the bounce to be the same at every stimp and
// only the roll after it to change, as 1/friction: release x stimp / 11. This takes the lab CSVs' shots
// that landed on a green (the lie test's `gg` shots), works out the model's release from GSPro's own
// landing numbers at stimp 11, and compares what GSPro did at each stimp with:
//   - no stimp effect (the release at stimp 11), and
//   - the model (stimp / 11 times it).
// Run from the repo root:  node tools/gspro_lie_lab/check_stimp_release.mjs <lab csv or folder>...
// (Wander's own green shots are left out: they come from slopes all over and, at Greywolf, in wind.)
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'vite'

const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
const { greenReleaseFromLanding, greenReleaseOnSlope, REFERENCE_STIMP } = await server.ssrLoadModule('/src/liveCaddie/greenReleaseModel.ts')
const NAME = ['soft', 'medium', 'firm']
const TYPE = ['Bentgrass', 'Bermuda', 'Links']

// A small CSV reader (quoted fields with commas).
const parseCsv = (text) => {
  const rows = []
  let row = [], field = '', quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1 } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(field); field = '' } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      row.push(field); rows.push(row); row = []; field = ''
    } else field += ch
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  const [head, ...body] = rows.filter((r) => r.length > 1)
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.replace(/^﻿/, ''), r[i] ?? ''])))
}
const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v))

const files = process.argv.slice(2).flatMap((p) => (statSync(p).isDirectory()
  ? readdirSync(p).filter((f) => /^looper_lab_.*\.csv$/.test(f) && !f.endsWith('_gspro_shots.csv')).map((f) => join(p, f))
  : [p]))
const shots = []
const seen = new Set()
for (const file of files) {
  for (const r of parseCsv(readFileSync(file, 'utf8'))) {
    // The lie test's shots at the green (`gg`), which landed and stayed on it: controlled, from one spot.
    if (r.test !== 'lie' || !/to green/.test(r.club ?? '')) continue
    if (r.landing_surface !== '5' || r.finish_surface !== '5') continue
    const key = r.db_id || `${file}:${r.sent_at}:${r.club}`
    if (seen.has(key)) continue
    seen.add(key)
    const type = num(r.log_course_type), firm = num(r.log_green_firmness)
    const speed = num(r.landing_speed), descent = num(r.descent_deg) ?? num(r.db_descent_deg), spin = num(r.landing_spin_rpm)
    const release = num(r.roll_yd), rise = num(r.roll_height_change_in)
    if ([type, firm, speed, descent, spin, release].some((v) => v == null) || !(type in NAME) || !(firm in NAME)) continue
    // Rise over run along the shot's line: a ball spinning back up a slope is going downhill along the line.
    const grade = rise != null && Math.abs(release) > 0.5 ? (rise / 36) / Math.abs(release) * Math.sign(release) : 0
    shots.push({ stimp: num(r.stimp) ?? REFERENCE_STIMP, stimpTyped: num(r.stimp) != null, type, firm, speed, descent, spin, release, grade, file })
  }
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null }
const f1 = (v) => (v == null ? '–' : v.toFixed(1))
const f2 = (v) => (v == null ? '–' : v.toFixed(2))

const byStimp = new Map()
for (const s of shots) {
  const conditions = { courseType: NAME[s.type], greenFirmness: NAME[s.firm] }
  const at11 = greenReleaseOnSlope(greenReleaseFromLanding({ speedMph: s.speed, descentDeg: s.descent, spinRpm: s.spin }, conditions), s.grade, REFERENCE_STIMP)
  const model = greenReleaseOnSlope(greenReleaseFromLanding({ speedMph: s.speed, descentDeg: s.descent, spinRpm: s.spin }, { ...conditions, stimp: s.stimp }), s.grade, s.stimp)
  const g = byStimp.get(s.stimp) ?? []
  g.push({ ...s, at11, model })
  byStimp.set(s.stimp, g)
}

console.log(`${shots.length} green landings from ${files.length} files (stimp ${REFERENCE_STIMP} where the CSV has none).\n`)
console.log('stimp  shots  settings                         miss: no stimp effect   miss: model (stimp/11)   measured / at-11 (median, |at-11| > 2 yd)   model says')
let verdicts = []
for (const stimp of [...byStimp.keys()].sort((a, b) => a - b)) {
  const g = byStimp.get(stimp)
  const settings = [...new Set(g.map((s) => `${TYPE[s.type]} ${NAME[s.firm]}`))].join(', ')
  const noEffect = mean(g.map((s) => Math.abs(s.release - s.at11)))
  const modelMiss = mean(g.map((s) => Math.abs(s.release - s.model)))
  const ratios = g.filter((s) => Math.abs(s.at11) > 2).map((s) => s.release / s.at11)
  const ratio = median(ratios)
  console.log(`${String(stimp).padStart(5)}  ${String(g.length).padStart(5)}  ${settings.slice(0, 32).padEnd(32)} ${f1(noEffect).padStart(10)} yd mean      ${f1(modelMiss).padStart(10)} yd mean        ${f2(ratio).padStart(10)} (${ratios.length} shots)                    ${f2(stimp / REFERENCE_STIMP)}`)
  if (stimp !== REFERENCE_STIMP && ratio != null) verdicts.push({ stimp, ratio, modelMiss, noEffect })
}
if (verdicts.length) {
  console.log('')
  for (const v of verdicts) {
    const expected = v.stimp / REFERENCE_STIMP
    const ok = Math.abs(v.ratio - expected) <= Math.max(0.12, 0.25 * Math.abs(expected - 1)) && v.modelMiss <= 1.2
    console.log(`stimp ${v.stimp}: GSPro released ${f2(v.ratio)}x the stimp-11 release; the model says ${f2(expected)}x. `
      + (ok ? 'PASS: stimp only changes the roll after the bounce.'
        : v.noEffect < v.modelMiss ? 'FAIL: GSPro shows less stimp effect than the model; fit stimp properly (run the 10 and 12 sets).'
          : 'FAIL: stimp changes the release, but not as the model says; fit stimp properly (run the 10 and 12 sets).'))
  }
}
await server.close()
