import { useMemo, useState } from 'react'
import {
  parseGsproReplayFixture,
  runGsproReplayFixture,
  type GsproReplayFixture,
} from '../liveCaddie/gsproReplayHarness'
import {
  GS_PRO_REPLAY_FIXTURES,
  GS_PRO_REPLAY_FIXTURE_JSON_EXAMPLE,
} from './gsproReplayFixtures'

const mono: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
}

function GsproReplayDevPage() {
  const [fixtureIndex, setFixtureIndex] = useState(0)
  const [customFixture, setCustomFixture] = useState<GsproReplayFixture | null>(null)
  const [customName, setCustomName] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  const fixture = customFixture ?? GS_PRO_REPLAY_FIXTURES[fixtureIndex]
  const run = useMemo(() => runGsproReplayFixture(fixture), [fixture])

  const importFile = async (file: File | null) => {
    if (!file) return
    setImportError(null)
    try {
      const parsed = parseGsproReplayFixture(await file.text())
      setCustomFixture(parsed)
      setCustomName(file.name)
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error))
    }
  }

  const downloadExample = () => {
    const blob = new Blob([GS_PRO_REPLAY_FIXTURE_JSON_EXAMPLE], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'gspro-replay-fixture-example.json'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <main style={{ maxWidth: 1500, margin: '0 auto', padding: '28px', color: '#17221b' }}>
      <header style={{ marginBottom: 20 }}>
        <p style={{ margin: 0, fontSize: 12, fontWeight: 800, letterSpacing: '0.14em' }}>LOOPER DEV · GSPro LIVE RELIABILITY</p>
        <h1 style={{ margin: '6px 0' }}>Replay harness</h1>
        <p style={{ margin: 0, maxWidth: 900 }}>
          Deterministic reliability checks only. No GSPro install, simulator, course geometry, or launch monitor is required.
          Fixtures are course-key agnostic so future course captures can use the same schema.
        </p>
      </header>

      <section style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 18 }}>
        <label>
          Built-in scenario{' '}
          <select
            value={customFixture ? -1 : fixtureIndex}
            onChange={(event) => {
              const next = Number(event.target.value)
              if (next >= 0) {
                setCustomFixture(null)
                setCustomName(null)
                setFixtureIndex(next)
              }
            }}
          >
            {customFixture && <option value={-1}>Imported: {customName ?? customFixture.name}</option>}
            {GS_PRO_REPLAY_FIXTURES.map((item, index) => (
              <option value={index} key={item.name}>{item.name}</option>
            ))}
          </select>
        </label>
        <label>
          Import fixture JSON{' '}
          <input type="file" accept="application/json,.json" onChange={(event) => void importFile(event.target.files?.[0] ?? null)} />
        </label>
        <button type="button" onClick={downloadExample}>Download fixture example</button>
        {customFixture && (
          <button type="button" onClick={() => { setCustomFixture(null); setCustomName(null); setImportError(null) }}>
            Clear import
          </button>
        )}
      </section>

      {importError && (
        <div style={{ padding: 12, marginBottom: 16, background: '#fee2e2', border: '1px solid #ef4444' }}>
          Import failed: {importError}
        </div>
      )}

      <section style={{ padding: 16, border: '1px solid #cbd5cf', borderRadius: 10, marginBottom: 18 }}>
        <div style={{ display: 'flex', gap: 20, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>{fixture.name}</h2>
          <strong style={{ color: run.pass ? '#166534' : '#b91c1c' }}>
            {run.pass ? 'PASS' : 'FAIL'} · {run.passedFrames}/{run.totalFrames} frames
          </strong>
          {fixture.courseHint && <span style={mono}>courseHint: {fixture.courseHint}</span>}
        </div>
        {fixture.description && <p style={{ marginBottom: 0 }}>{fixture.description}</p>}
      </section>

      <div style={{ overflowX: 'auto', border: '1px solid #cbd5cf', borderRadius: 10 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#eef3ef', textAlign: 'left' }}>
              {['Result', 'Frame', 'Connection', 'Course / Round', 'Round H', 'Log H', 'Effective H', 'Shot', 'Health', 'Epoch', 'Fallback', 'Reconnect', 'Failure'].map((heading) => (
                <th key={heading} style={{ padding: '10px 8px', borderBottom: '1px solid #cbd5cf', whiteSpace: 'nowrap' }}>{heading}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {run.results.map((result) => (
              <tr key={result.id} style={{ background: result.pass ? undefined : '#fff1f2' }}>
                <td style={{ padding: 8, fontWeight: 800, color: result.pass ? '#166534' : '#b91c1c' }}>{result.pass ? 'PASS' : 'FAIL'}</td>
                <td style={{ padding: 8, minWidth: 190 }}><strong>{result.id}</strong><br />{result.label}</td>
                <td style={{ padding: 8 }}>{result.connection}</td>
                <td style={{ padding: 8, ...mono }}>{result.courseKey ?? '—'} / {result.roundId ?? '—'}</td>
                <td style={{ padding: 8 }}>{result.roundHole ?? '—'}</td>
                <td style={{ padding: 8 }}>{result.logHole ?? '—'}</td>
                <td style={{ padding: 8, fontWeight: 700 }}>{result.effectiveHole ?? '—'}</td>
                <td style={{ padding: 8, ...mono }}>{result.latestShotId ?? '—'}</td>
                <td style={{ padding: 8 }}>{result.integrity}{result.quarantined ? ' · QUARANTINED' : ''}</td>
                <td style={{ padding: 8 }}>{result.epoch}<br /><small>{result.epochReason}</small></td>
                <td style={{ padding: 8 }}>{result.logFallbackActive ? 'grace' : result.logFallbackExpired ? 'expired' : 'no'}</td>
                <td style={{ padding: 8 }}>{result.recoveredMissedShot ? 'recovered' : result.duplicateSuppressed ? 'duplicate suppressed' : '—'}</td>
                <td style={{ padding: 8, minWidth: 220 }}>{result.failures.join('; ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section style={{ marginTop: 20, padding: 16, border: '1px solid #cbd5cf', borderRadius: 10 }}>
        <h2 style={{ marginTop: 0 }}>What this covers</h2>
        <p style={{ marginBottom: 0 }}>
          Duplicate shot suppression, missed-shot recovery after reconnect, partial/malformed currentRound writes,
          bounded output_log loss, restart/log truncation quarantine, round identity changes, and arbitrary course keys.
          It intentionally does not validate course geometry or shot-decision logic.
        </p>
      </section>
    </main>
  )
}

export default GsproReplayDevPage
