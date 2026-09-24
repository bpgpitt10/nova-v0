from pathlib import Path

path = Path('src/pages/LiveCaddiePage.tsx')
text = path.read_text(encoding='utf-8')


def replace_once(old: str, new: str, label: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    text = text.replace(old, new, 1)


replace_once(
    "} from '../adapters/browserGsproCourseState'\nimport { connectToGsproLieObservation } from '../adapters/gsproLieObservation'",
    "} from '../adapters/browserGsproCourseState'\nimport {\n  connectToBrowserGsproVisualCapture,\n  type BrowserGsproVisualCaptureConnection,\n  type BrowserGsproVisualCaptureStatus,\n} from '../adapters/browserGsproVisualCapture'\nimport { connectToGsproLieObservation } from '../adapters/gsproLieObservation'",
    'visual capture import',
)

replace_once(
    "  const [windObservation, setWindObservation] = useState<WindObservation | null>(null)\n  const [lieObservation, setLieObservation] = useState<GsproLieObservation | null>(null)\n  const [holeHeadingDegreesTrue, setHoleHeadingDegreesTrue] = useState<number | null>(null)",
    "  const [windObservation, setWindObservation] = useState<WindObservation | null>(null)\n  const [lieObservation, setLieObservation] = useState<GsproLieObservation | null>(null)\n  const [visualCaptureStatus, setVisualCaptureStatus] = useState<BrowserGsproVisualCaptureStatus>('idle')\n  const [visualCaptureError, setVisualCaptureError] = useState<string | null>(null)\n  const [visualCaptureSource, setVisualCaptureSource] = useState<string | null>(null)\n  const [holeHeadingDegreesTrue, setHoleHeadingDegreesTrue] = useState<number | null>(null)",
    'visual capture state',
)

replace_once(
    "  const lastShotKeyRef = useRef<string | null>(null)\n\n  const selectedCourse",
    "  const lastShotKeyRef = useRef<string | null>(null)\n  const visualCaptureRef = useRef<BrowserGsproVisualCaptureConnection | null>(null)\n\n  const selectedCourse",
    'visual capture ref',
)

replace_once(
    "  useEffect(() => {\n    const windConnection = connectToGsproWindObservation({\n      onObservation: setWindObservation,\n      onError: () => setWindObservation(null),\n    })\n    const lieConnection = connectToGsproLieObservation({\n      onObservation: setLieObservation,\n      onError: () => setLieObservation(null),\n    })\n    return () => {\n      windConnection.disconnect()\n      lieConnection.disconnect()\n    }\n  }, [])\n\n  useEffect(() => {\n    let active = true\n    setHoleHeadingDegreesTrue(null)",
    "  useEffect(() => {\n    const windConnection = connectToGsproWindObservation({\n      onObservation: setWindObservation,\n      onError: () => setWindObservation(null),\n    })\n    const lieConnection = connectToGsproLieObservation({\n      onObservation: setLieObservation,\n      onError: () => setLieObservation(null),\n    })\n    return () => {\n      windConnection.disconnect()\n      lieConnection.disconnect()\n    }\n  }, [])\n\n  useEffect(() => () => {\n    visualCaptureRef.current?.disconnect()\n    visualCaptureRef.current = null\n  }, [])\n\n  useEffect(() => {\n    let active = true\n    setHoleHeadingDegreesTrue(null)",
    'visual capture cleanup',
)

replace_once(
    "  const connectGspro = async () => {\n    setLiveError(null)\n    try {\n      await connectBrowserGsproCourseStateFolder()\n      setLivePrepared(true)\n      setConnectionVersion((value) => value + 1)\n    } catch (error) {\n      setLiveError(error instanceof Error ? error.message : String(error))\n    }\n  }\n\n  const selectCourse",
    "  const connectGspro = async () => {\n    setLiveError(null)\n    try {\n      await connectBrowserGsproCourseStateFolder()\n      setLivePrepared(true)\n      setConnectionVersion((value) => value + 1)\n    } catch (error) {\n      setLiveError(error instanceof Error ? error.message : String(error))\n    }\n  }\n\n  const connectGsproVisuals = async () => {\n    setVisualCaptureError(null)\n    setVisualCaptureSource(null)\n    visualCaptureRef.current?.disconnect()\n    visualCaptureRef.current = null\n    try {\n      const connection = await connectToBrowserGsproVisualCapture({\n        onStatusChange: setVisualCaptureStatus,\n        onError: (error) => setVisualCaptureError(\n          error instanceof Error ? error.message : String(error),\n        ),\n      })\n      visualCaptureRef.current = connection\n      setVisualCaptureSource(connection.sourceLabel ?? connection.displaySurface)\n    } catch (error) {\n      setVisualCaptureError(error instanceof Error ? error.message : String(error))\n    }\n  }\n\n  const selectCourse",
    'connect visuals handler',
)

replace_once(
    "          {!livePrepared ? <button type=\"button\" onClick={() => void connectGspro()}>Connect GSPro</button> : null}\n          {liveStatus === 'error' ? <button type=\"button\" onClick={() => void connectGspro()}>Reconnect</button> : null}\n          <div className=\"live-caddie-secondary-context\">",
    "          {!livePrepared ? <button type=\"button\" onClick={() => void connectGspro()}>Connect GSPro</button> : null}\n          {liveStatus === 'error' ? <button type=\"button\" onClick={() => void connectGspro()}>Reconnect</button> : null}\n          <button\n            type=\"button\"\n            onClick={() => void connectGsproVisuals()}\n            disabled={visualCaptureStatus === 'requesting' || visualCaptureStatus === 'loading-ocr'}\n            title=\"Share the GSPro application window so Looper can read wind and lie locally in this browser.\"\n          >\n            {visualCaptureStatus === 'connected'\n              ? 'Reconnect GSPro Visuals'\n              : visualCaptureStatus === 'requesting'\n                ? 'Choose GSPro Window…'\n                : visualCaptureStatus === 'loading-ocr'\n                  ? 'Loading Visual OCR…'\n                  : 'Connect GSPro Visuals'}\n          </button>\n          <div className=\"live-caddie-secondary-context\">",
    'visual capture button',
)

replace_once(
    "            {airAltitudeFt != null && Math.abs(airAltitudeFt) >= 500\n              ? <span>{Math.round(airAltitudeFt).toLocaleString()} ft ASL</span>\n              : null}\n          </div>",
    "            {airAltitudeFt != null && Math.abs(airAltitudeFt) >= 500\n              ? <span>{Math.round(airAltitudeFt).toLocaleString()} ft ASL</span>\n              : null}\n            {visualCaptureStatus === 'connected'\n              ? <span>Visual OCR connected{visualCaptureSource ? ` · ${visualCaptureSource}` : ''}</span>\n              : null}\n          </div>",
    'visual capture context',
)

replace_once(
    "        {liveError ? <div className=\"live-caddie-alert bad\">GSPro: {liveError}</div> : null}\n        {loadError ? <div className=\"live-caddie-alert bad\">Course geometry: {loadError}</div> : null}",
    "        {liveError ? <div className=\"live-caddie-alert bad\">GSPro: {liveError}</div> : null}\n        {visualCaptureError ? (\n          <div className=\"live-caddie-alert bad\">GSPro visuals: {visualCaptureError}</div>\n        ) : null}\n        {visualCaptureStatus === 'stopped' && !visualCaptureError ? (\n          <div className=\"live-caddie-alert\">GSPro visual capture stopped. Reconnect visuals for live wind and lie.</div>\n        ) : null}\n        {loadError ? <div className=\"live-caddie-alert bad\">Course geometry: {loadError}</div> : null}",
    'visual capture alerts',
)

path.write_text(text, encoding='utf-8')
print('Patched LiveCaddiePage.tsx for browser-native GSPro visual capture.')
