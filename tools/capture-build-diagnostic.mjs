import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const steps = [
  ['course promotions', 'node', ['tools/check-course-promotions.mjs']],
  ['course registration', 'node', ['tools/generate-course-registration-index.mjs']],
  ['typescript', 'npx', ['tsc', '-b']],
  ['vite', 'npx', ['vite', 'build']],
]

const esc = (s) => String(s ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
let report = ''
for (const [label, cmd, args] of steps) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' })
  report += `\n===== ${label} =====\nexit=${result.status}\nSTDOUT:\n${result.stdout ?? ''}\nSTDERR:\n${result.stderr ?? ''}\n`
  if (result.status !== 0) {
    mkdirSync('dist', { recursive: true })
    writeFileSync('dist/build-diagnostic.txt', report)
    writeFileSync('dist/index.html', `<!doctype html><meta charset="utf-8"><title>Build diagnostic</title><pre>${esc(report)}</pre>`)
    console.log(report)
    process.exit(0)
  }
}
console.log(report)
