from pathlib import Path
import re


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, found {count}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


def regex_replace_once(path: str, pattern: str, replacement: str) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    new_text, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f'{path}: expected one regex match, found {count}: {pattern[:120]!r}')
    p.write_text(new_text, encoding='utf-8')


capture = 'src/adapters/browserGsproVisualCapture.ts'
page = 'src/pages/LiveCaddiePage.tsx'
conditions = 'src/pages/ConditionsMathPanel.tsx'

# The real Greywolf HUD test showed the broad wind crop contains large amounts of
# scenery and even the yardage marker. Read the two text labels independently.
replace_once(
    capture,
    """const WIND_CROP: CropSpec = {\n  x: 0.32,\n  y: 0,\n  width: 0.36,\n  height: 0.16,\n  scale: 2.5,\n}\n""",
    """// Tight top-center crops validated against the user's live GSPro layout.\n// Speed is left of the compass arrow; cardinal text is right of it. Keeping the\n// arrow/scenery out of each OCR pass is substantially more reliable than reading\n// the entire top-center strip.\nconst WIND_SPEED_CROP: CropSpec = {\n  x: 0.405,\n  y: 0,\n  width: 0.08,\n  height: 0.075,\n  scale: 4,\n}\n\nconst WIND_DIRECTION_CROP: CropSpec = {\n  x: 0.515,\n  y: 0,\n  width: 0.075,\n  height: 0.075,\n  scale: 4,\n}\n""",
)

regex_replace_once(
    capture,
    r"const parseWindText = \(rawText: string, confidence: number \| null\): GsproWindOcrPayload => \{.*?\n\}\n\ntype LieAxisParse",
    """const parseWindComponents = (\n  speedRawText: string,\n  speedConfidence: number | null,\n  directionRawText: string,\n  directionConfidence: number | null,\n): GsproWindOcrPayload => {\n  const normalizedSpeed = speedRawText.toUpperCase().replace(/\\s+/g, ' ').trim()\n  const normalizedDirection = directionRawText.toUpperCase().replace(/\\s+/g, '').trim()\n  const speedMatch = normalizedSpeed.match(/(\\d{1,2}(?:[\\.,]\\d+)?)/)\n  const parsedSpeed = speedMatch ? Number(speedMatch[1].replace(',', '.')) : null\n  const speedMph = parsedSpeed != null && Number.isFinite(parsedSpeed) && parsedSpeed >= 0 && parsedSpeed <= 50\n    ? parsedSpeed\n    : null\n  const cardinalMatch = normalizedDirection.match(/(NE|SE|SW|NW|N|E|S|W)/)\n  const cardinal = cardinalMatch?.[1] ?? null\n  const directionDegrees = cardinal ? WIND_CARDINAL_DEGREES[cardinal] ?? null : null\n  const confidenceValues = [speedConfidence, directionConfidence].filter(\n    (value): value is number => value != null && Number.isFinite(value),\n  )\n  const confidence = confidenceValues.length > 0 ? Math.min(...confidenceValues) : null\n  const missing: string[] = []\n  if (speedMph == null) missing.push('speed')\n  if (directionDegrees == null) missing.push('cardinal direction')\n\n  return {\n    status: missing.length === 0 ? 'READY' : 'UNKNOWN',\n    speedMph,\n    directionDegrees,\n    convention: 'toward',\n    referenceFrame: 'compass',\n    observedAt: new Date().toISOString(),\n    confidence,\n    rawText: `SPEED: ${speedRawText.trim()} | DIR: ${directionRawText.trim()}`,\n    note: missing.length === 0\n      ? 'Browser OCR read the split GSPro wind speed and cardinal HUD labels.'\n      : `Browser wind OCR was incomplete; missing ${missing.join(', ')}.`,\n  }\n}\n\ntype LieAxisParse""",
)

replace_once(
    capture,
    """        const windResult = await recognize(WIND_CROP, '0123456789.,MPHNSEW ')\n        dispatchGsproWindOcrObservation(parseWindText(\n          windResult.data.text ?? '',\n          normalizedConfidence(windResult.data.confidence),\n        ))\n""",
    """        const windSpeedResult = await recognize(\n          WIND_SPEED_CROP,\n          '0123456789.,MPH ',\n          '7',\n        )\n        const windDirectionResult = await recognize(\n          WIND_DIRECTION_CROP,\n          'NSEW ',\n          '7',\n        )\n        dispatchGsproWindOcrObservation(parseWindComponents(\n          windSpeedResult.data.text ?? '',\n          normalizedConfidence(windSpeedResult.data.confidence),\n          windDirectionResult.data.text ?? '',\n          normalizedConfidence(windDirectionResult.data.confidence),\n        ))\n""",
)

# Tee is an invariant in GSPro: physical lie is always 0.0 / 0.0. Do not spend
# OCR reliability budget on a value the game state already proves.
regex_replace_once(
    page,
    r"  const hasLiveLie = lieObservation\?\.status === 'READY' && \(.*?  const lieSource = hasLiveLie \? lieObservation\?\.source \?\? 'GSPro lie OCR' : undefined\n",
    """  const authoritativeGsproSurface = liveMatchesHole ? liveSnapshot?.surface ?? null : null\n  const isTeeSurface = typeof authoritativeGsproSurface === 'string'\n    && authoritativeGsproSurface.trim().toLowerCase() === 'tee'\n  const hasOcrLie = lieObservation?.status === 'READY' && (\n    (typeof lieObservation.upDownDegrees === 'number' && Number.isFinite(lieObservation.upDownDegrees))\n    || (typeof lieObservation.leftRightDegrees === 'number' && Number.isFinite(lieObservation.leftRightDegrees))\n  )\n  const hasLiveLie = isTeeSurface || hasOcrLie\n  const lieUpDownDeg = isTeeSurface\n    ? 0\n    : hasOcrLie\n      && typeof lieObservation?.upDownDegrees === 'number'\n      && Number.isFinite(lieObservation.upDownDegrees)\n      ? lieObservation.upDownDegrees\n      : null\n  const lieLeftRightDeg = isTeeSurface\n    ? 0\n    : hasOcrLie\n      && typeof lieObservation?.leftRightDegrees === 'number'\n      && Number.isFinite(lieObservation.leftRightDegrees)\n      // Helper convention is +RIGHT / -LEFT. The existing sidehill model uses\n      // +LEFT / -RIGHT, so invert once here at the LIVE Caddie integration seam.\n      ? -lieObservation.leftRightDegrees\n      : null\n  const lieSource = isTeeSurface\n    ? 'GSPro tee invariant (0.0° / 0.0°)'\n    : hasOcrLie\n      ? lieObservation?.source ?? 'GSPro lie OCR'\n      : undefined\n""",
)

replace_once(
    page,
    """                <span>Wind OCR {windObservation?.status ?? 'WAITING'} · Lie OCR {lieObservation?.status ?? 'WAITING'}</span>\n""",
    """                <span>\n                  Wind OCR {windObservation?.status ?? 'WAITING'} · {isTeeSurface\n                    ? 'Lie 0/0 (TEE)'\n                    : `Lie OCR ${lieObservation?.status ?? 'WAITING'}`}\n                </span>\n""",
)

# Give a flat known lie a useful explanation instead of a blank detail string.
replace_once(
    conditions,
    """  const lieDetail = hasLie\n    ? [\n        sidehillLabel,\n        upDownLabel,\n        sidehillLabel ? '50% loft-aware V0 sidehill prior' : null,\n        upDownLabel ? '25% VLA V0 prior · ±3° VLA / ±3% carry caps' : null,\n      ].filter(Boolean).join(' · ')\n    : 'Lie angle not captured yet'\n""",
    """  const lieDetail = hasLie\n    ? sidehillLabel || upDownLabel\n      ? [\n          sidehillLabel,\n          upDownLabel,\n          sidehillLabel ? '50% loft-aware V0 sidehill prior' : null,\n          upDownLabel ? '25% VLA V0 prior · ±3° VLA / ±3% carry caps' : null,\n        ].filter(Boolean).join(' · ')\n      : 'Flat lie · 0.0° up/down · 0.0° left/right'\n    : 'Lie angle not captured yet'\n""",
)

print('Applied live visual test fixes: split wind OCR + tee lie invariant.')
