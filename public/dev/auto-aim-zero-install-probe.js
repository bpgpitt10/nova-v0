const HANDLE_DATABASE_NAME = 'looper-browser-gspro'
const HANDLE_STORE_NAME = 'handles'
const HANDLE_KEY = 'gspro-directory'
const CURRENT_ROUND_FILE = 'currentRound.dat'
const PROBE_DELTA_DEGREES = 3

const folderButton = document.querySelector('#folderButton')
const shareButton = document.querySelector('#shareButton')
const inspectButton = document.querySelector('#inspectButton')
const probeButton = document.querySelector('#probeButton')
const folderStatus = document.querySelector('#folderStatus')
const captureStatus = document.querySelector('#captureStatus')
const aimStatus = document.querySelector('#aimStatus')
const resultStatus = document.querySelector('#resultStatus')
const logElement = document.querySelector('#log')
const video = document.querySelector('#captureVideo')
const canvas = document.querySelector('#captureCanvas')

let directoryHandle = null
let captureStream = null
let probeRunning = false

const log = (message) => {
  const stamp = new Date().toLocaleTimeString()
  logElement.textContent += `[${stamp}] ${message}\n`
  logElement.scrollTop = logElement.scrollHeight
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const setResult = (text, tone = 'neutral') => {
  resultStatus.textContent = text
  resultStatus.className = `value ${tone}`
}

const updateButtons = () => {
  inspectButton.disabled = !directoryHandle || probeRunning
  probeButton.disabled = !directoryHandle || !captureStream || probeRunning
  folderButton.disabled = probeRunning
  shareButton.disabled = probeRunning
}

const openHandleDatabase = () => new Promise((resolve, reject) => {
  const request = indexedDB.open(HANDLE_DATABASE_NAME, 1)
  request.onupgradeneeded = () => {
    const database = request.result
    if (!database.objectStoreNames.contains(HANDLE_STORE_NAME)) {
      database.createObjectStore(HANDLE_STORE_NAME)
    }
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error ?? new Error('Could not open saved folder handle storage.'))
})

const loadSavedDirectoryHandle = async () => {
  const database = await openHandleDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(HANDLE_STORE_NAME, 'readonly')
      const request = transaction.objectStore(HANDLE_STORE_NAME).get(HANDLE_KEY)
      request.onsuccess = () => resolve(request.result ?? null)
      request.onerror = () => reject(request.error ?? new Error('Could not load saved folder handle.'))
    })
  } finally {
    database.close()
  }
}

const saveDirectoryHandle = async (handle) => {
  const database = await openHandleDatabase()
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(HANDLE_STORE_NAME, 'readwrite')
      const request = transaction.objectStore(HANDLE_STORE_NAME).put(handle, HANDLE_KEY)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error ?? new Error('Could not save folder handle.'))
    })
  } finally {
    database.close()
  }
}

const ensureReadWritePermission = async (handle, mayPrompt) => {
  if (!handle) return false
  const descriptor = { mode: 'readwrite' }
  const current = typeof handle.queryPermission === 'function'
    ? await handle.queryPermission(descriptor)
    : 'prompt'
  if (current === 'granted') return true
  if (!mayPrompt || typeof handle.requestPermission !== 'function') return false
  return (await handle.requestPermission(descriptor)) === 'granted'
}

const connectFolder = async () => {
  try {
    let handle = await loadSavedDirectoryHandle().catch(() => null)
    if (handle && !(await ensureReadWritePermission(handle, true))) {
      handle = null
    }
    if (!handle) {
      if (typeof window.showDirectoryPicker !== 'function') {
        throw new Error('Desktop Chrome/Edge File System Access API is unavailable.')
      }
      handle = await window.showDirectoryPicker({ id: 'looper-gspro-directory', mode: 'readwrite' })
      if (!(await ensureReadWritePermission(handle, true))) {
        throw new Error('Read/write permission was not granted.')
      }
      await saveDirectoryHandle(handle)
    }
    directoryHandle = handle
    folderStatus.textContent = handle.name
    log(`GSPro folder connected read/write: ${handle.name}`)
    await inspectCurrentRound()
  } catch (error) {
    folderStatus.textContent = 'Connection failed'
    log(`Folder error: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    updateButtons()
  }
}

const getCurrentRoundHandle = async () => {
  if (!directoryHandle) throw new Error('GSPro folder is not connected.')
  return directoryHandle.getFileHandle(CURRENT_ROUND_FILE)
}

const readCurrentRound = async () => {
  const handle = await getCurrentRoundHandle()
  const file = await handle.getFile()
  return { handle, text: await file.text(), lastModified: file.lastModified, size: file.size }
}

const findLastTargetDirection = (text) => {
  const pattern = /("TargetDirection"\s*:\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g
  let match = null
  let candidate
  while ((candidate = pattern.exec(text)) !== null) match = candidate
  if (!match) return null
  const value = Number(match[2])
  if (!Number.isFinite(value)) return null
  return {
    value,
    valueStart: match.index + match[1].length,
    valueEnd: match.index + match[0].length,
  }
}

const findLastTdpoint = (text) => {
  const pattern = /"tdpoint"\s*:\s*\{\s*"x"\s*:\s*(-?\d+(?:\.\d+)?),\s*"y"\s*:\s*(-?\d+(?:\.\d+)?),\s*"z"\s*:\s*(-?\d+(?:\.\d+)?)/g
  let match = null
  let candidate
  while ((candidate = pattern.exec(text)) !== null) match = candidate
  if (!match) return null
  return { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) }
}

const inspectCurrentRound = async () => {
  try {
    const { text, lastModified, size } = await readCurrentRound()
    const target = findLastTargetDirection(text)
    const tdpoint = findLastTdpoint(text)
    if (!target) {
      aimStatus.textContent = 'TargetDirection not found'
      log(`Read ${CURRENT_ROUND_FILE} (${size.toLocaleString()} bytes) but found no TargetDirection.`)
      return null
    }
    aimStatus.textContent = `${target.value.toFixed(3)}°`
    log(`currentRound.dat: TargetDirection=${target.value.toFixed(6)}°, modified=${new Date(lastModified).toLocaleTimeString()}`)
    if (tdpoint) {
      log(`tdpoint observed at (${tdpoint.x.toFixed(3)}, ${tdpoint.y.toFixed(3)}, ${tdpoint.z.toFixed(3)}); not mutated by this probe.`)
    }
    return target
  } catch (error) {
    aimStatus.textContent = 'Read failed'
    log(`Inspect error: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

const shareGspro = async () => {
  try {
    captureStream?.getTracks().forEach((track) => track.stop())
    captureStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 8, max: 12 } },
      audio: false,
    })
    video.srcObject = captureStream
    await video.play()
    const track = captureStream.getVideoTracks()[0]
    captureStatus.textContent = track?.label || 'Shared window'
    track?.addEventListener('ended', () => {
      captureStream = null
      captureStatus.textContent = 'Share ended'
      updateButtons()
    }, { once: true })
    log(`Capture connected: ${track?.label || 'shared surface'}`)
  } catch (error) {
    captureStream = null
    captureStatus.textContent = 'Share failed'
    log(`Capture error: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    updateButtons()
  }
}

const magentaMarkerCentroid = () => {
  if (!video.videoWidth || !video.videoHeight) return null
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null
  context.drawImage(video, 0, 0, canvas.width, canvas.height)

  // GSPro's accepted aim marker lives on the right-side map. Restricting the
  // scan keeps unrelated UI colors from dominating the marker detector.
  const minX = Math.floor(canvas.width * 0.52)
  const minY = Math.floor(canvas.height * 0.28)
  const width = canvas.width - minX
  const height = canvas.height - minY
  const data = context.getImageData(minX, minY, width, height).data
  const binSize = Math.max(5, Math.round(Math.min(canvas.width, canvas.height) / 150))
  const bins = new Map()

  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const offset = (y * width + x) * 4
      const r = data[offset]
      const g = data[offset + 1]
      const b = data[offset + 2]
      const a = data[offset + 3]
      const isMagenta = a > 180 && r > 145 && b > 130 && r - g > 45 && b - g > 35
      if (!isMagenta) continue
      const absoluteX = minX + x
      const absoluteY = minY + y
      const key = `${Math.floor(absoluteX / binSize)}:${Math.floor(absoluteY / binSize)}`
      const bin = bins.get(key) ?? { count: 0, sumX: 0, sumY: 0 }
      bin.count += 1
      bin.sumX += absoluteX
      bin.sumY += absoluteY
      bins.set(key, bin)
    }
  }

  let winner = null
  for (const bin of bins.values()) {
    if (!winner || bin.count > winner.count) winner = bin
  }
  if (!winner || winner.count < 3) return null
  return { x: winner.sumX / winner.count, y: winner.sumY / winner.count, samples: winner.count }
}

const sampleMarker = async (attempts = 4, intervalMs = 90) => {
  const samples = []
  for (let index = 0; index < attempts; index += 1) {
    const marker = magentaMarkerCentroid()
    if (marker) samples.push(marker)
    if (index < attempts - 1) await sleep(intervalMs)
  }
  if (samples.length === 0) return null
  return {
    x: samples.reduce((sum, value) => sum + value.x, 0) / samples.length,
    y: samples.reduce((sum, value) => sum + value.y, 0) / samples.length,
    samples: samples.reduce((sum, value) => sum + value.samples, 0),
  }
}

const writeText = async (fileHandle, text) => {
  if (typeof fileHandle.createWritable !== 'function') {
    throw new Error('The selected browser/file handle does not expose createWritable().')
  }
  const writable = await fileHandle.createWritable()
  try {
    await writable.write(text)
  } finally {
    await writable.close()
  }
}

const replaceTargetDirection = (text, target, nextValue) =>
  `${text.slice(0, target.valueStart)}${nextValue}${text.slice(target.valueEnd)}`

const runProbe = async () => {
  if (probeRunning) return
  probeRunning = true
  updateButtons()
  setResult('RUNNING…', 'neutral')
  let originalText = null
  let fileHandle = null

  try {
    const snapshot = await readCurrentRound()
    originalText = snapshot.text
    fileHandle = snapshot.handle
    const target = findLastTargetDirection(originalText)
    if (!target) throw new Error('No TargetDirection exists in currentRound.dat yet. Hit one normal shot first, then return to a pre-shot screen.')

    const baselineMarker = await sampleMarker()
    if (baselineMarker) {
      log(`Baseline magenta marker: (${baselineMarker.x.toFixed(1)}, ${baselineMarker.y.toFixed(1)}) px.`)
    } else {
      log('Baseline magenta marker was not confidently detected; the file-write portion will still run.')
    }

    const temporaryDirection = target.value + PROBE_DELTA_DEGREES
    const mutatedText = replaceTargetDirection(originalText, target, temporaryDirection.toFixed(6))
    log(`Writing temporary TargetDirection ${target.value.toFixed(6)}° → ${temporaryDirection.toFixed(6)}°.`)
    await writeText(fileHandle, mutatedText)

    const observations = []
    for (const delay of [180, 350, 550]) {
      await sleep(delay)
      const marker = await sampleMarker(2, 55)
      if (marker) observations.push(marker)
    }

    const during = await readCurrentRound()
    const duringTarget = findLastTargetDirection(during.text)
    const mutationStillPresent = duringTarget
      ? Math.abs(duringTarget.value - temporaryDirection) < 0.001
      : false
    log(mutationStillPresent
      ? 'Temporary file mutation was still present during the observation window.'
      : `GSPro or another writer replaced the temporary value during the observation window${duringTarget ? ` (now ${duringTarget.value.toFixed(6)}°)` : ''}.`)

    let maxMovement = 0
    let furthestMarker = null
    if (baselineMarker) {
      for (const marker of observations) {
        const movement = Math.hypot(marker.x - baselineMarker.x, marker.y - baselineMarker.y)
        if (movement > maxMovement) {
          maxMovement = movement
          furthestMarker = marker
        }
      }
    }

    if (baselineMarker && furthestMarker && maxMovement >= 3) {
      setResult(`VISUAL MOVEMENT · ${maxMovement.toFixed(1)} px`, 'pass')
      log(`PASS candidate: captured magenta marker moved ${maxMovement.toFixed(1)} px while the temporary value was active.`)
      log('This is evidence of a browser-only actuation seam; repeat once before integrating it into Auto Aim.')
    } else if (baselineMarker && observations.length > 0) {
      setResult(`NO MARKER MOVEMENT · ${maxMovement.toFixed(1)} px`, 'fail')
      log(`FAIL: marker movement stayed at ${maxMovement.toFixed(1)} px. currentRound.dat TargetDirection does not appear to actuate live GSPro aim.`)
    } else {
      setResult('INCONCLUSIVE · marker not detected', 'neutral')
      log('INCONCLUSIVE visually: the magenta marker detector did not get enough samples.')
    }
  } catch (error) {
    setResult('PROBE ERROR', 'fail')
    log(`Probe error: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (fileHandle && originalText != null) {
      try {
        await writeText(fileHandle, originalText)
        log('Restored original currentRound.dat byte-for-byte.')
        await inspectCurrentRound()
      } catch (restoreError) {
        setResult('RESTORE FAILED', 'fail')
        log(`CRITICAL restore error: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`)
      }
    }
    probeRunning = false
    updateButtons()
  }
}

folderButton.addEventListener('click', connectFolder)
shareButton.addEventListener('click', shareGspro)
inspectButton.addEventListener('click', inspectCurrentRound)
probeButton.addEventListener('click', runProbe)

void (async () => {
  const saved = await loadSavedDirectoryHandle().catch(() => null)
  if (saved && await ensureReadWritePermission(saved, false)) {
    directoryHandle = saved
    folderStatus.textContent = saved.name
    log(`Restored previously approved GSPro folder: ${saved.name}`)
    await inspectCurrentRound()
  } else {
    log('Connect the GSPro folder, then share the GSPro window.')
  }
  updateButtons()
})()
