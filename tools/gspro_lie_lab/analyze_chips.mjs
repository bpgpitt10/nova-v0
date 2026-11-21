// Chip sets from the shot tool (`chip stimp 11` in the lie test): how far each chip type carries and
// releases, by green firmness and stimp, against the engine's own flight and green-release models.
//
// Run from the repo root:
//   node tools/gspro_lie_lab/analyze_chips.mjs <lab csv or folder>... [--out folder]
// Writes chip_summary.md and chip_shots.csv (to --out, else next to the first input).
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createServer } from 'vite'

const args = process.argv.slice(2)
const outAt = args.indexOf('--out')
const outDir = outAt >= 0 ? args[outAt + 1] : null
const inputs = args.filter((a, i) => a !== '--out' && i !== outAt + 1)
if (inputs.length === 0) {
  console.error('usage: node tools/gspro_lie_lab/analyze_chips.mjs <lab csv or folder>... [--out folder]')
  process.exit(1)
}

const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
const { simulateFlight } = await server.ssrLoadModule('/src/liveCaddie/flightPhysics.ts')
const release = await server.ssrLoadModule('/src/liveCaddie/greenReleaseModel.ts')
const NAME = ['soft', 'medium', 'firm']
const TYPE = ['Bentgrass', 'Bermuda', 'Links']
const KINDS = ['bump', 'chip', 'pitch', 'flop']

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
const files = inputs.flatMap((p) => (statSync(p).isDirectory()
  ? readdirSync(p).filter((f) => /^looper_lab_.*\.csv$/.test(f) && !f.endsWith('_gspro_shots.csv')).map((f) => join(p, f))
  : [p]))

const chips = []
const seen = new Set()
for (const file of files) {
  for (const r of parseCsv(readFileSync(file, 'utf8'))) {
    if (r.test !== 'chip') continue
    const key = r.db_id || `${file}:${r.sent_at}:${r.club}`
    if (seen.has(key)) continue
    seen.add(key)
    const named = String(r.club ?? '').match(/^(\w+)\s+(\d+(?:\.\d+)?)\s*yd/i)
    const kind = named ? named[1].toLowerCase() : 'unknown'
    const carry = num(r.carry_yd) ?? num(r.db_carry_yd)
    const total = num(r.total_yd) ?? num(r.db_total_yd)
    const type = num(r.log_course_type), firm = num(r.log_green_firmness)
    chips.push({
      file, kind, target: named ? Number(named[2]) : null, carry, total,
      roll: num(r.roll_yd) ?? (carry != null && total != null ? total - carry : null),
      stimp: num(r.stimp), type, firm,
      setting: type in NAME && firm in NAME ? `${TYPE[type]} ${NAME[firm]}` : 'unknown',
      landedGreen: r.landing_surface === '5', finishedGreen: r.finish_surface === '5',
      speed: num(r.sent_speed_mph), vla: num(r.sent_vla_deg), spin: num(r.sent_spin_rpm),
      landingSpeed: num(r.landing_speed), descent: num(r.descent_deg) ?? num(r.db_descent_deg), landingSpin: num(r.landing_spin_rpm),
      rise: num(r.roll_height_change_in), status: r.status ?? '',
    })
  }
}

// The engine on each chip: carry from the launch, release from GSPro's own landing numbers.
for (const c of chips) {
  if (c.speed && c.vla != null && c.spin != null) {
    const flight = simulateFlight({ ballSpeedMph: c.speed, vlaDeg: c.vla, totalSpinRpm: c.spin })
    c.engineCarry = flight.ok ? flight.carryYds : null
  }
  if (c.landedGreen && c.type in NAME && c.firm in NAME && c.landingSpeed != null && c.descent != null && c.landingSpin != null) {
    const conditions = { courseType: NAME[c.type], greenFirmness: NAME[c.firm], stimp: c.stimp }
    const grade = c.rise != null && c.roll != null && Math.abs(c.roll) > 0.5 ? (c.rise / 36) / Math.abs(c.roll) * Math.sign(c.roll) : 0
    const level = release.greenReleaseFromLanding({ speedMph: c.landingSpeed, descentDeg: c.descent, spinRpm: c.landingSpin }, conditions)
    const shape = release.greenReleaseShape({ speedMph: c.landingSpeed, descentDeg: c.descent, spinRpm: c.landingSpin }, conditions)
    c.engineRelease = release.greenReleaseOnSlope(level, grade, c.stimp, shape)
  }
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null }
const f1 = (v) => (v == null ? '–' : v.toFixed(1))
const pct = (v) => (v == null ? '–' : `${Math.round(100 * v)}%`)
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`), '']
const kindRank = (k) => (KINDS.includes(k) ? KINDS.indexOf(k) : KINDS.length)
const group = (list, keyOf) => {
  const m = new Map()
  for (const c of list) { const k = keyOf(c); m.set(k, [...(m.get(k) ?? []), c]) }
  return m
}

const used = chips.filter((c) => c.carry != null && c.landedGreen)
const lines = ['# Chip sets', '',
  `${chips.length} chips from ${files.length} file(s); ${used.length} landed on the green and are used below.`,
  `Off the green or not recorded: ${chips.length - used.length}.`, '']
const settings = [...new Set(used.map((c) => `${c.setting}, stimp ${c.stimp ?? '?'}`))].sort()
lines.push(`Settings seen: ${settings.join('; ') || 'none'}.`, '')

lines.push('## 1. Carry: did each chip land where it was sent?', '',
  'The tool scales each type\'s speed to the carry asked for and corrects from that type\'s first chip.', '')
lines.push(...table(['Type', 'Asked', 'Chips', 'Carried (median)', 'Engine carry from the launch'],
  [...group(used, (c) => `${c.kind}|${c.target}`).entries()]
    .sort(([a], [b]) => kindRank(a.split('|')[0]) - kindRank(b.split('|')[0]) || Number(a.split('|')[1]) - Number(b.split('|')[1]))
    .map(([k, g]) => [k.split('|')[0], `${k.split('|')[1]} yd`, String(g.length), f1(median(g.map((c) => c.carry))),
      f1(median(g.map((c) => c.engineCarry).filter((v) => v != null)))])))

lines.push('## 2. Release: how far each type rolls after landing', '',
  'Release as yards and as a share of carry, by type, green setting and stimp.', '')
lines.push(...table(['Type', 'Green', 'Stimp', 'Chips', 'Release (median)', 'Release / carry', 'Engine release', 'Engine miss (mean)'],
  [...group(used, (c) => `${c.kind}|${c.setting}|${c.stimp ?? '?'}`).entries()]
    .sort(([a], [b]) => {
      const [ka, sa, ta] = a.split('|'), [kb, sb, tb] = b.split('|')
      return kindRank(ka) - kindRank(kb) || sa.localeCompare(sb) || Number(ta) - Number(tb)
    })
    .map(([k, g]) => {
      const [kind, setting, stimp] = k.split('|')
      const withEngine = g.filter((c) => c.engineRelease != null && c.roll != null)
      return [kind, setting, stimp, String(g.length), f1(median(g.map((c) => c.roll).filter((v) => v != null))),
        pct(median(g.filter((c) => c.roll != null && c.carry > 0).map((c) => c.roll / c.carry))),
        f1(median(withEngine.map((c) => c.engineRelease))),
        f1(mean(withEngine.map((c) => Math.abs(c.roll - c.engineRelease))))]
    })))

// What stimp and firmness do to each type's release, holding the rest (median release per cell).
const effect = (label, keyOf, order) => {
  const rows = []
  for (const kind of KINDS) {
    const g = used.filter((c) => c.kind === kind && c.roll != null)
    if (!g.length) continue
    const cells = group(g, keyOf)
    rows.push([kind, ...order.map((o) => f1(median((cells.get(o) ?? []).map((c) => c.roll))))])
  }
  return rows.length ? [`### Release by ${label}`, '', ...table(['Type', ...order.map(String)], rows)] : []
}
const stimps = [...new Set(used.map((c) => c.stimp).filter((v) => v != null))].sort((a, b) => a - b)
lines.push(...effect('stimp (all green settings)', (c) => c.stimp, stimps))
lines.push(...effect('green firmness (all stimps)', (c) => (c.firm in NAME ? NAME[c.firm] : '?'), NAME))

const all = used.filter((c) => c.engineRelease != null && c.roll != null)
lines.push('## 3. The engine', '',
  all.length
    ? `The green-release model (fit on full shots, 35+ mph off the face) misses chips by ${f1(mean(all.map((c) => Math.abs(c.roll - c.engineRelease))))} yd on average (${all.length} chips; median signed miss ${f1(median(all.map((c) => c.roll - c.engineRelease))) } yd, + means chips roll further than it says). Under about 1 yd: Looper can use it for chips as is. More: chips need their own fit.`
    : 'No chips with landing numbers yet.', '')

const out = outDir ?? dirname(files[0])
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'chip_summary.md'), lines.join('\n') + '\n')
const cols = ['file', 'kind', 'target', 'carry', 'roll', 'total', 'setting', 'stimp', 'landedGreen', 'finishedGreen', 'speed', 'vla', 'spin',
  'landingSpeed', 'descent', 'landingSpin', 'engineCarry', 'engineRelease']
writeFileSync(join(out, 'chip_shots.csv'), [cols.join(','), ...chips.map((c) => cols.map((k) => {
  const v = c[k]
  return v == null ? '' : typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : `"${String(v).replace(/"/g, '""')}"`
}).join(','))].join('\n') + '\n')
console.log(`wrote ${join(out, 'chip_summary.md')} and chip_shots.csv (${chips.length} chips)`)
await server.close()
