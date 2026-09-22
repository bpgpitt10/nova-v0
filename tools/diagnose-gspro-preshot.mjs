import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const DIAGNOSTIC_VERSION = '1.0.0'
const OUTPUT_LOG_TAIL_BYTES = 160_000
const READ_RETRIES = 6
const READ_RETRY_MS = 150

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const asFiniteNumber = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const asText = (value) => typeof value === 'string' && value.trim() ? value.trim() : null

const vec3 = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const x = asFiniteNumber(value.x ?? value.X)
  const y = asFiniteNumber(value.y ?? value.Y)
  const z = asFiniteNumber(value.z ?? value.Z)
  return x == null || y == null || z == null ? null : { x, y, z }
}

const normalizedHole = (value) => {
  const raw = asFiniteNumber(value)
  if (raw == null) return null
  const hole = Math.round(raw) + 1
  return hole >= 1 && hole <= 18 ? hole : null
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex')

const git = (args) => {
  const result = spawnSync('git', args, { encoding: 'utf8', windowsHide: true })
  return result.status === 0 ? result.stdout.trim() : null
}

const statSummary = (filePath, stat, now = Date.now()) => ({
  path: filePath,
  sizeBytes: stat.size,
  modifiedAt: new Date(stat.mtimeMs).toISOString(),
  modifiedAgeMs: Math.max(0, Math.round(now - stat.mtimeMs)),
})

const candidateRoots = () => {
  const profile = process.env.USERPROFILE || os.homedir()
  return [
    path.join(profile, 'AppData', 'LocalLow', 'GSPro', 'GSPro'),
    path.join(profile, 'AppData', 'LocalLow', 'GSPro'),
  ]
}

const walkForFile = (root, fileName, maxDepth = 3) => {
  const found = []
  const visit = (dir, depth) => {
    if (depth > maxDepth) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
        try {
          found.push({ path: full, stat: fs.statSync(full) })
        } catch {
          // Ignore races while GSPro updates files.
        }
      } else if (entry.isDirectory()) {
        visit(full, depth + 1)
      }
    }
  }
  visit(root, 0)
  return found
}

export const locateGsproFile = (fileName) => {
  const seen = new Set()
  const found = []
  for (const root of candidateRoots()) {
    if (!fs.existsSync(root)) continue
    const direct = path.join(root, fileName)
    if (fs.existsSync(direct)) {
      try {
        const stat = fs.statSync(direct)
        const key = path.resolve(direct).toLowerCase()
        if (!seen.has(key)) {
          seen.add(key)
          found.push({ path: direct, stat })
        }
      } catch {
        // Continue to bounded search.
      }
    }
    for (const match of walkForFile(root, fileName)) {
      const key = path.resolve(match.path).toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        found.push(match)
      }
    }
  }
  found.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
  return {
    selected: found[0] ?? null,
    alternatives: found.slice(1),
  }
}

const readStable = async (filePath, { parseJson = false, tailBytes = null } = {}) => {
  let lastError = null
  for (let attempt = 1; attempt <= READ_RETRIES; attempt += 1) {
    try {
      const before = fs.statSync(filePath)
      const start = tailBytes == null ? 0 : Math.max(0, before.size - tailBytes)
      const fd = fs.openSync(filePath, 'r')
      let text
      try {
        if (start === 0) {
          text = fs.readFileSync(fd, 'utf8')
        } else {
          const length = before.size - start
          const buffer = Buffer.alloc(length)
          fs.readSync(fd, buffer, 0, length, start)
          text = buffer.toString('utf8')
        }
      } finally {
        fs.closeSync(fd)
      }
      const after = fs.statSync(filePath)
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error('file changed during read')
      }
      const parsed = parseJson ? JSON.parse(text) : null
      return { text, parsed, stat: after, attempts: attempt }
    } catch (error) {
      lastError = error
      if (attempt < READ_RETRIES) await sleep(READ_RETRY_MS)
    }
  }
  throw new Error(`Could not get a stable read of ${filePath}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

const summarizeRecord = (record, sourcePath, authoritativeCurrentShot) => {
  const start = vec3(record?.StartingPOS)
  const end = vec3(record?.EndingPOS)
  return {
    sourcePath,
    authoritativeCurrentShot,
    holeRaw: asFiniteNumber(record?.Hole),
    holeNumber: normalizedHole(record?.Hole),
    holeShotRaw: asFiniteNumber(record?.HoleShot),
    globalShotNumber: asFiniteNumber(record?.GlobalShotNumber),
    shotId: asText(record?.ShotID),
    roundId: asFiniteNumber(record?.RoundID),
    courseKey: asText(record?.CourseKey),
    startingPos: start,
    endingPos: end,
    startingSurfaceRaw: asFiniteNumber(record?.StartingSurface),
    endingSurfaceRaw: asFiniteNumber(record?.EndingSurface),
    distanceToPinRaw: asFiniteNumber(record?.DistanceToPin),
    ballSpeed: asFiniteNumber(record?.BallSpeed),
    totalDistance: asFiniteNumber(record?.TotalDistance),
    hasStartingPos: start != null,
    hasEndingPos: end != null,
  }
}

const discoverStartingPosRecords = (value, sourcePath = '$', depth = 0, seen = new Set()) => {
  if (depth > 8 || value == null || typeof value !== 'object') return []
  if (seen.has(value)) return []
  seen.add(value)

  const records = []
  if (!Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'StartingPOS')) {
    records.push(summarizeRecord(value, sourcePath, false))
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      records.push(...discoverStartingPosRecords(item, `${sourcePath}[${index}]`, depth + 1, seen))
    })
  } else {
    for (const [key, child] of Object.entries(value)) {
      records.push(...discoverStartingPosRecords(child, `${sourcePath}.${key}`, depth + 1, seen))
    }
  }
  return records
}

export const inspectRoundObject = (parsed) => {
  const rootType = Array.isArray(parsed) ? 'array' : parsed && typeof parsed === 'object' ? 'object' : typeof parsed
  const rootKeys = rootType === 'object' ? Object.keys(parsed) : []
  const explicitKey = rootType === 'object'
    ? Object.prototype.hasOwnProperty.call(parsed, 'CurrentShot')
      ? 'CurrentShot'
      : Object.prototype.hasOwnProperty.call(parsed, 'currentShot')
        ? 'currentShot'
        : null
    : null
  const explicitValue = explicitKey ? parsed[explicitKey] : null
  const explicitRecord = explicitValue && typeof explicitValue === 'object' && !Array.isArray(explicitValue)
    ? summarizeRecord(explicitValue, `$.${explicitKey}`, true)
    : null

  const discovered = discoverStartingPosRecords(parsed)
  const deduped = []
  const seenKeys = new Set()
  for (const record of discovered) {
    const key = `${record.sourcePath}:${JSON.stringify(record.startingPos)}`
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    deduped.push(record)
  }

  let verdict
  if (explicitKey && !explicitRecord) verdict = 'EXPLICIT_CURRENT_SHOT_NOT_OBJECT'
  else if (explicitRecord?.hasStartingPos) verdict = 'EXPLICIT_CURRENT_SHOT_WITH_STARTINGPOS'
  else if (explicitRecord) verdict = 'EXPLICIT_CURRENT_SHOT_WITHOUT_STARTINGPOS'
  else verdict = 'NO_EXPLICIT_CURRENT_SHOT'

  return {
    rootType,
    rootKeys,
    explicitCurrentShotKey: explicitKey,
    explicitCurrentShot: explicitRecord,
    discoveredStartingPosRecordCount: deduped.length,
    discoveredStartingPosRecords: deduped,
    verdict,
    authoritativePreShotStartingPos: explicitRecord?.hasStartingPos ? explicitRecord.startingPos : null,
  }
}

const parseOutputLog = (text) => {
  const matches = [...text.matchAll(/currentHole\s*:\s*(-?\d+)/gi)]
  const valid = matches
    .map((match) => Number(match[1]))
    .filter((raw) => Number.isFinite(raw) && raw >= 0 && raw < 18)
  const raw = valid.length ? valid[valid.length - 1] : null
  return {
    currentHoleRaw: raw,
    currentHoleNumber: raw == null ? null : raw + 1,
    currentHoleMarkerCount: valid.length,
  }
}

export const runDiagnostic = async () => {
  const now = Date.now()
  const currentRoundSearch = locateGsproFile('currentRound.dat')
  if (!currentRoundSearch.selected) {
    throw new Error('Could not find currentRound.dat under %USERPROFILE%\\AppData\\LocalLow\\GSPro.')
  }

  const currentRoundPath = currentRoundSearch.selected.path
  const currentRound = await readStable(currentRoundPath, { parseJson: true })
  const roundInspection = inspectRoundObject(currentRound.parsed)

  const outputLogSearch = locateGsproFile('output_log.txt')
  let outputLog = null
  if (outputLogSearch.selected) {
    const stableLog = await readStable(outputLogSearch.selected.path, { tailBytes: OUTPUT_LOG_TAIL_BYTES })
    outputLog = {
      ...statSummary(outputLogSearch.selected.path, stableLog.stat, now),
      readAttempts: stableLog.attempts,
      sha256Tail: sha256(stableLog.text),
      ...parseOutputLog(stableLog.text),
    }
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const commit = git(['rev-parse', 'HEAD'])
  const status = git(['status', '--porcelain'])

  const report = {
    diagnosticVersion: DIAGNOSTIC_VERSION,
    capturedAt: new Date(now).toISOString(),
    environment: {
      platform: process.platform,
      nodeVersion: process.version,
      cwd: process.cwd(),
      userProfile: process.env.USERPROFILE || null,
    },
    repository: {
      branch,
      commit,
      dirty: Boolean(status),
      statusPorcelain: status || '',
    },
    currentRound: {
      ...statSummary(currentRoundPath, currentRound.stat, now),
      readAttempts: currentRound.attempts,
      sha256: sha256(currentRound.text),
      alternatives: currentRoundSearch.alternatives.map(({ path: p, stat }) => statSummary(p, stat, now)),
      inspection: roundInspection,
    },
    outputLog,
  }

  const outDir = path.join(os.tmpdir(), `looper-live-shot-${new Date(now).toISOString().replace(/[:.]/g, '-')}`)
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(outDir, 'currentRound.snapshot.dat'), currentRound.text, 'utf8')
  if (outputLogSearch.selected) {
    const stableLog = await readStable(outputLogSearch.selected.path, { tailBytes: OUTPUT_LOG_TAIL_BYTES })
    fs.writeFileSync(path.join(outDir, 'output_log.tail.txt'), stableLog.text, 'utf8')
  }

  return { report, outDir }
}

const printSummary = ({ report, outDir }) => {
  const inspection = report.currentRound.inspection
  console.log('')
  console.log('LOOPER GSPro PRE-SHOT DIAGNOSTIC')
  console.log('================================')
  console.log(`Diagnostic: ${report.diagnosticVersion}`)
  console.log(`Repo:       ${report.repository.branch ?? 'unknown'} @ ${(report.repository.commit ?? 'unknown').slice(0, 12)}`)
  console.log(`GSPro file: ${report.currentRound.path}`)
  console.log(`Modified:   ${report.currentRound.modifiedAt} (${report.currentRound.modifiedAgeMs} ms old at capture)`)
  console.log(`Root:       ${inspection.rootType}; keys=${inspection.rootKeys.join(', ') || '(none)'}`)
  console.log(`Verdict:    ${inspection.verdict}`)
  console.log(`Log hole:   ${report.outputLog?.currentHoleNumber ?? 'unknown'}`)
  if (inspection.explicitCurrentShot) {
    const shot = inspection.explicitCurrentShot
    console.log('')
    console.log('Explicit current shot:')
    console.log(`  source:       ${shot.sourcePath}`)
    console.log(`  hole:         ${shot.holeNumber ?? 'unknown'} (raw ${shot.holeRaw ?? 'unknown'})`)
    console.log(`  holeShot raw: ${shot.holeShotRaw ?? 'unknown'}`)
    console.log(`  shotId:       ${shot.shotId ?? 'unassigned'}`)
    console.log(`  roundId:      ${shot.roundId ?? 'unknown'}`)
    console.log(`  courseKey:    ${shot.courseKey ?? 'unknown'}`)
    console.log(`  StartingPOS:  ${shot.startingPos ? JSON.stringify(shot.startingPos) : 'MISSING'}`)
    console.log(`  surface raw:  ${shot.startingSurfaceRaw ?? 'unknown'}`)
    console.log(`  distToPin:    ${shot.distanceToPinRaw ?? 'unknown'}`)
  }
  console.log('')
  console.log(`Other StartingPOS records discovered: ${inspection.discoveredStartingPosRecordCount}`)
  console.log(`Saved diagnostic bundle: ${outDir}`)
  console.log('')
  if (inspection.verdict === 'EXPLICIT_CURRENT_SHOT_WITH_STARTINGPOS') {
    console.log('RESULT: GSPro exposes an explicit pre-shot CurrentShot.StartingPOS in this captured state.')
  } else {
    console.log('RESULT: Do NOT treat any historical StartingPOS as authoritative pre-shot state from this capture.')
  }
}

const main = async () => {
  try {
    const result = await runDiagnostic()
    printSummary(result)
  } catch (error) {
    console.error('')
    console.error('LOOPER GSPro PRE-SHOT DIAGNOSTIC FAILED')
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  await main()
}
