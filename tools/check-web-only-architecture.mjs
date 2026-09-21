import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const violations = []

const fail = (message) => violations.push(message)
const rel = (p) => path.relative(root, p).replaceAll('\\', '/')

// Hard path bans: these are desktop-shell/bundling artifacts, not web-app infrastructure.
const forbiddenPaths = [
  'src-tauri',
  'helpers/.venv-open-golf-coach-sidecar-mac',
  'helpers/build_beta_windows_release.ps1',
  'helpers/build_open_golf_coach_sidecar_windows.ps1',
  'helpers/build_open_golf_coach_sidecar_macos.sh',
  'helpers/build_open_golf_coach_sidecar_mac.sh',
  'helpers/build_open_golf_coach_sidecar_mac_universal.sh',
  'helpers/build_open_golf_coach_sidecar_mac_cross.sh',
  'helpers/prepare_open_golf_coach_resources.ps1',
  'helpers/prepare_simread_resources_windows.ps1',
]

for (const forbidden of forbiddenPaths) {
  if (fs.existsSync(path.join(root, forbidden))) {
    fail(`forbidden native-shell path exists: ${forbidden}`)
  }
}

const packagePath = path.join(root, 'package.json')
if (fs.existsSync(packagePath)) {
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
  }

  for (const name of Object.keys(deps)) {
    if (name.startsWith('@tauri-apps/') || name === 'electron' || name.startsWith('electron-')) {
      fail(`forbidden native-shell dependency in package.json: ${name}`)
    }
  }

  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    const text = String(command).toLowerCase()
    if (text.includes('tauri') || /(^|\s)electron(\s|$)/.test(text)) {
      fail(`forbidden native-shell npm script: ${name}`)
    }
  }
}

const rootsToScan = ['src', 'api', 'helpers', '.github']
const configFiles = [
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mts',
  'vite.config.mjs',
]
const textExtensions = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.yml', '.yaml',
  '.py', '.ps1', '.sh', '.toml', '.rs', '.html', '.css', '.scss',
])
const forbiddenContent = [
  { label: '@tauri-apps import/package', re: /@tauri-apps\//i },
  { label: 'Tauri global/runtime', re: /__TAURI__|isTauri|tauri::|tauri_plugin/i },
  { label: 'Tauri source path', re: /src-tauri/i },
  { label: 'Tauri CLI/runtime reference', re: /\btauri:(?:dev|build)\b|\btauri\s+(?:dev|build)\b/i },
  { label: 'Electron runtime', re: /(?:from\s+['"]electron['"]|require\(['"]electron['"]\)|electron\.app|electron\.ipc)/i },
]

function scanFile(file) {
  const relative = rel(file)
  // Policy and guard files necessarily name forbidden technologies.
  if (relative === 'AGENTS.md' || relative === 'tools/check-web-only-architecture.mjs') return
  const ext = path.extname(file).toLowerCase()
  if (!textExtensions.has(ext)) return

  const text = fs.readFileSync(file, 'utf8')
  for (const rule of forbiddenContent) {
    if (rule.re.test(text)) fail(`${rule.label} found in ${relative}`)
  }
}

function walk(dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else scanFile(full)
  }
}

for (const dir of rootsToScan) walk(path.join(root, dir))
for (const file of configFiles) {
  const full = path.join(root, file)
  if (fs.existsSync(full)) scanFile(full)
}

if (violations.length > 0) {
  console.error('\nWEB-ONLY ARCHITECTURE CHECK FAILED\n')
  for (const violation of [...new Set(violations)].sort()) console.error(`- ${violation}`)
  console.error('\nLooper is a browser web app. Use a separately-run localhost HTTP/WebSocket/SSE service for Windows/GSPro integration; do not add a native desktop shell.\n')
  process.exit(1)
}

console.log('WEB-ONLY ARCHITECTURE CHECK PASSED')
