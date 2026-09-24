from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, found {count}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


capture_path = 'src/adapters/browserGsproVisualCapture.ts'

# Keep window capture preferred, but do not remove the full-display fallback.
replace_once(
    capture_path,
    "  monitorTypeSurfaces?: 'exclude'\n",
    "  monitorTypeSurfaces?: 'include' | 'exclude'\n",
)
replace_once(
    capture_path,
    "    monitorTypeSurfaces: 'exclude',\n",
    "    monitorTypeSurfaces: 'include',\n",
)

# A failed CDN load can leave a dead script tag behind. Remove it on retry rather
# than waiting forever for a load event that has already fired.
replace_once(
    capture_path,
    "    if (existingScript) {\n      existingScript.addEventListener('load', finish, { once: true })\n      existingScript.addEventListener(\n        'error',\n        () => reject(new Error('Could not load browser OCR.')),\n        { once: true },\n      )\n      return\n    }\n\n",
    "    if (existingScript) existingScript.remove()\n\n",
)

# Replace whole-footer lie OCR with the same overlapping two-component geometry
# that was proven by the Windows reader. Also preserve flat 0.0 lies even when
# OCR drops the UP/RIGHT direction label.
p = Path(capture_path)
text = p.read_text(encoding='utf-8')
old = """const liePayloadFromText = (\n  rawText: string,\n  confidence: number | null,\n  side: 'right' | 'left',\n): GsproLieOcrPayload => {\n  const parsed = parseGsproLieRawText(rawText)\n  const ready = parsed.upDownDegrees != null && parsed.leftRightDegrees != null\n  return {\n    status: ready ? 'READY' : 'UNKNOWN',\n    surface: parsed.surface,\n    upDownDegrees: parsed.upDownDegrees,\n    leftRightDegrees: parsed.leftRightDegrees,\n    observedAt: new Date().toISOString(),\n    confidence,\n    rawText,\n    note: ready\n      ? `Browser OCR read the ${side}-side GSPro minimap lie footer.`\n      : `Browser OCR did not find both lie axes in the ${side}-side minimap footer.`,\n  }\n}\n"""
new = """type LieAxisParse = {\n  value: number | null\n  canonical: string | null\n}\n\nconst parseLieAxisComponent = (\n  rawText: string,\n  positive: 'UP' | 'RIGHT',\n  negative: 'DOWN' | 'LEFT',\n): LieAxisParse => {\n  const compact = rawText.toUpperCase().replace(/\\s+/g, '').replace(',', '.')\n  const decimalMatch = compact.match(/(\\d{1,2})\\.(\\d)/)\n  let value = decimalMatch ? Number(`${decimalMatch[1]}.${decimalMatch[2]}`) : null\n\n  // The proven Windows reader deliberately accepts a flat lie even when OCR\n  // loses the direction word. Do the same here, but never interpret a dropped\n  // decimal on a non-zero number (e.g. 3.9 -> 39) as a valid angle.\n  if (value == null) {\n    const withoutLabels = compact\n      .replaceAll(positive, '')\n      .replaceAll(negative, '')\n      .replace(/[°ºO-]/g, '')\n    if (withoutLabels === '0' || withoutLabels === '00' || withoutLabels === '0.') value = 0\n  }\n  if (value == null || !Number.isFinite(value) || value < 0 || value > 60) {\n    return { value: null, canonical: null }\n  }\n\n  let direction: string | null = compact.includes(positive)\n    ? positive\n    : compact.includes(negative)\n      ? negative\n      : null\n  if (value === 0 && direction == null) direction = positive\n  if (!direction) return { value: null, canonical: null }\n\n  const signed = direction === positive ? value : -value\n  return {\n    value: Math.round(signed * 10) / 10,\n    canonical: `${value.toFixed(1)} ${direction}`,\n  }\n}\n\nconst axisCrop = (footer: CropSpec, offset: number, width: number): CropSpec => ({\n  ...footer,\n  x: footer.x + footer.width * offset,\n  width: footer.width * width,\n})\n\nconst liePayloadFromComponents = (\n  longitudinalText: string,\n  longitudinalConfidence: number | null,\n  lateralText: string,\n  lateralConfidence: number | null,\n  side: 'right' | 'left',\n): GsproLieOcrPayload => {\n  const longitudinal = parseLieAxisComponent(longitudinalText, 'UP', 'DOWN')\n  const lateral = parseLieAxisComponent(lateralText, 'RIGHT', 'LEFT')\n  const confidenceValues = [longitudinalConfidence, lateralConfidence].filter(\n    (value): value is number => value != null && Number.isFinite(value),\n  )\n  const confidence = confidenceValues.length > 0 ? Math.min(...confidenceValues) : null\n  const canonicalParts = [longitudinal.canonical, lateral.canonical].filter(Boolean)\n  const rawText = canonicalParts.length > 0\n    ? canonicalParts.join(' ')\n    : `LONG: ${longitudinalText} LAT: ${lateralText}`\n  const ready = longitudinal.value != null && lateral.value != null\n\n  return {\n    status: ready ? 'READY' : 'UNKNOWN',\n    surface: null,\n    upDownDegrees: longitudinal.value,\n    leftRightDegrees: lateral.value,\n    observedAt: new Date().toISOString(),\n    confidence,\n    rawText,\n    note: ready\n      ? `Browser OCR read the ${side}-side GSPro minimap lie footer using split axis crops.`\n      : `Browser OCR did not find both lie axes in the ${side}-side split minimap footer.`,\n  }\n}\n"""
if old not in text:
    raise SystemExit('browserGsproVisualCapture.ts: old lie payload function not found')
text = text.replace(old, new, 1)
p.write_text(text, encoding='utf-8')

# Let component crops use single-line segmentation while preserving the broader
# wind crop's block segmentation.
replace_once(
    capture_path,
    "    const recognize = async (\n      crop: CropSpec,\n      whitelist: string,\n    ) => {\n",
    "    const recognize = async (\n      crop: CropSpec,\n      whitelist: string,\n      pageSegMode = '6',\n    ) => {\n",
)
replace_once(
    capture_path,
    "        tessedit_pageseg_mode: '6',\n",
    "        tessedit_pageseg_mode: pageSegMode,\n",
)

old_run = """        const rightLieResult = await recognize(\n          RIGHT_LIE_CROP,\n          '0123456789.,°ºUPDOWNRIGHTLEFT- ',\n        )\n        let liePayload = liePayloadFromText(\n          rightLieResult.data.text ?? '',\n          normalizedConfidence(rightLieResult.data.confidence),\n          'right',\n        )\n\n        if (liePayload.status !== 'READY') {\n          const leftLieResult = await recognize(\n            LEFT_LIE_CROP,\n            '0123456789.,°ºUPDOWNRIGHTLEFT- ',\n          )\n          const leftPayload = liePayloadFromText(\n            leftLieResult.data.text ?? '',\n            normalizedConfidence(leftLieResult.data.confidence),\n            'left',\n          )\n          if (leftPayload.status === 'READY') liePayload = leftPayload\n          else {\n            liePayload = {\n              ...liePayload,\n              rawText: [\n                `RIGHT: ${rightLieResult.data.text ?? ''}`,\n                `LEFT: ${leftLieResult.data.text ?? ''}`,\n              ].join('\\n'),\n              note: 'Browser OCR did not find both lie axes in either minimap footer.',\n            }\n          }\n        }\n        dispatchGsproLieOcrObservation(liePayload)\n"""
new_run = """        const readLieCandidate = async (footer: CropSpec, side: 'right' | 'left') => {\n          // Same overlapping 56% / 44% split as the proven Windows reader.\n          const longitudinalResult = await recognize(\n            axisCrop(footer, 0, 0.56),\n            '0123456789.,°ºUPDOWNO- ',\n            '7',\n          )\n          const lateralResult = await recognize(\n            axisCrop(footer, 0.44, 0.56),\n            '0123456789.,°ºRIGHTLEFTO- ',\n            '7',\n          )\n          return liePayloadFromComponents(\n            longitudinalResult.data.text ?? '',\n            normalizedConfidence(longitudinalResult.data.confidence),\n            lateralResult.data.text ?? '',\n            normalizedConfidence(lateralResult.data.confidence),\n            side,\n          )\n        }\n\n        let liePayload = await readLieCandidate(RIGHT_LIE_CROP, 'right')\n        if (liePayload.status !== 'READY') {\n          const leftPayload = await readLieCandidate(LEFT_LIE_CROP, 'left')\n          if (leftPayload.status === 'READY') liePayload = leftPayload\n          else {\n            liePayload = {\n              ...liePayload,\n              rawText: `RIGHT: ${liePayload.rawText ?? ''} | LEFT: ${leftPayload.rawText ?? ''}`,\n              note: 'Browser OCR did not find both lie axes in either split minimap footer.',\n            }\n          }\n        }\n        dispatchGsproLieOcrObservation(liePayload)\n"""
replace_once(capture_path, old_run, new_run)

# Make simultaneous fore/aft + sidehill lies internally consistent: compute the
# fore/aft carry delta first, then convert the sidehill angle at that final carry.
shot_path = 'src/liveCaddie/shotContextModel.ts'
old_shot = """  // Apply sidehill at the already-conditioned carry distance so the angular\n  // tendency becomes the correct lateral-center shift for this particular shot.\n  // Up/down lie does not modify carry in V0.\n  const preLieCarryYds = stockCarry == null\n    ? null\n    : stockCarry + combinedAirborneCarryYds + surfaceCarryYds\n  const sidehillLieResponse = buildSidehillLieResponse({\n    club: baseline.club,\n    lieLeftRightDeg: context.lieLeftRightDeg,\n    carryYds: preLieCarryYds,\n  })\n  const upDownLieResponse = buildUpDownLieResponse({\n    launch: surfaceLaunch ?? launch,\n    environment: flightEnvironment,\n    lieUpDownDeg: context.lieUpDownDeg,\n    stockCarryYds: stockCarry,\n  })\n"""
new_shot = """  const preLieCarryYds = stockCarry == null\n    ? null\n    : stockCarry + combinedAirborneCarryYds + surfaceCarryYds\n  const upDownLieResponse = buildUpDownLieResponse({\n    launch: surfaceLaunch ?? launch,\n    environment: flightEnvironment,\n    lieUpDownDeg: context.lieUpDownDeg,\n    stockCarryYds: stockCarry,\n  })\n  const physicalLieCarryYds = preLieCarryYds == null\n    ? null\n    : preLieCarryYds + (upDownLieResponse.status === 'ready' ? upDownLieResponse.carryDeltaYds : 0)\n  // Convert sidehill angle to yards at the final carry after wind, elevation,\n  // surface and the conservative fore/aft lie prior have all been applied.\n  const sidehillLieResponse = buildSidehillLieResponse({\n    club: baseline.club,\n    lieLeftRightDeg: context.lieLeftRightDeg,\n    carryYds: physicalLieCarryYds,\n  })\n"""
replace_once(shot_path, old_shot, new_shot)

# Remove stale documentation that still said up/down was measurement-only.
replace_once(
    'src/liveCaddie/lieResponse.ts',
    " * Up/down lie is intentionally excluded here. It remains measurement-only until\n * we validate its carry/VLA response separately.\n",
    " * Fore/aft lie is modeled separately below so the sidehill geometry remains\n * isolated and independently calibratable.\n",
)

# Make tonight's test self-diagnosing: capture connected is not the same thing as
# OCR READY. Expose both observation statuses in the normal setup row.
page_path = 'src/pages/LiveCaddiePage.tsx'
replace_once(
    page_path,
    "            title=\"Share the GSPro application window so Looper can read wind and lie locally in this browser.\"\n",
    "            title=\"Share the GSPro application window. If window capture is blank, reconnect and share the full GSPro display instead.\"\n",
)
replace_once(
    page_path,
    "            {visualCaptureStatus === 'connected'\n              ? <span>Visual OCR connected{visualCaptureSource ? ` · ${visualCaptureSource}` : ''}</span>\n              : null}\n",
    "            {visualCaptureStatus === 'connected' ? (\n              <>\n                <span>Visual capture connected{visualCaptureSource ? ` · ${visualCaptureSource}` : ''}</span>\n                <span>Wind OCR {windObservation?.status ?? 'WAITING'} · Lie OCR {lieObservation?.status ?? 'WAITING'}</span>\n              </>\n            ) : null}\n",
)

print('Applied browser visuals readiness audit fixes.')
