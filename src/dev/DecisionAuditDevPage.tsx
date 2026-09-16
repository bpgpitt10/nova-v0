import { useEffect, useMemo, useState } from 'react'
import {
  loadSavedSessionsFromCloud,
  writeDiagnosticEventToCloud,
} from '../cloud/cloudPersistence'
import {
  buildGreywolfCourseDecisionAudit,
  type GreywolfDecisionAudit,
  type GreywolfDecisionAuditScenario,
} from '../liveCaddie/greywolfDecisionAudit'

const pct = (value: number | null | undefined) =>
  typeof value === 'number' ? `${(value * 100).toFixed(value < 0.05 ? 1 : 0)}%` : '—'

const signed = (value: number | null | undefined, unit = ' yd') =>
  typeof value === 'number' ? `${value >= 0 ? '+' : ''}${value.toFixed(1)}${unit}` : '—'

const fixed = (value: number | null | undefined, digits = 3) =>
  typeof value === 'number' ? value.toFixed(digits) : '—'

const statusColor = (status: GreywolfDecisionAuditScenario['status']) =>
  status === 'clear' ? '#76d39b' : status === 'review' ? '#d18a3b' : '#c85a4a'

function DecisionAuditDevPage() {
  const [audit, setAudit] = useState<GreywolfDecisionAudit | null>(null)
  const [sessionCount, setSessionCount] = useState<number | null>(null)
  const [shotCount, setShotCount] = useState<number | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [cloudSaveStatus, setCloudSaveStatus] = useState<string>('not run')
  const [runVersion, setRunVersion] = useState(0)
  const [filter, setFilter] = useState<'all' | 'review' | 'missing'>('all')

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setError(null)
    setCloudSaveStatus('pending')
    void loadSavedSessionsFromCloud()
      .then(async (sessions) => {
        if (cancelled) return
        const totalShots = sessions.reduce((sum, session) => sum + session.shots.length, 0)
        setSessionCount(sessions.length)
        setShotCount(totalShots)
        const result = await buildGreywolfCourseDecisionAudit(sessions)
        if (cancelled) return
        setAudit(result)
        setStatus('ready')

        const persisted = await writeDiagnosticEventToCloud({
          courseKey: 'greywolf-panorama-bc',
          component: 'decision-course-audit',
          modelVersion: 'broadie-2012-next-state-v1',
          result: result.summary.missingCount > 0 ? 'completed-with-missing' : 'completed',
          reason: `${result.summary.clearCount} clear · ${result.summary.reviewCount} review · ${result.summary.missingCount} missing`,
          metadata: {
            generatedAt: new Date().toISOString(),
            sessionCount: sessions.length,
            shotCount: totalShots,
            summary: result.summary,
            scenarios: result.scenarios,
          },
        })
        if (cancelled) return
        setCloudSaveStatus(
          persisted.status === 'synced'
            ? 'saved to diagnostics'
            : persisted.status === 'failed'
              ? `save failed: ${persisted.error}`
              : `not saved: ${persisted.reason}`,
        )
      })
      .catch((cause) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : String(cause))
        setStatus('error')
        setCloudSaveStatus('not saved')
      })
    return () => {
      cancelled = true
    }
  }, [runVersion])

  const scenarios = useMemo(() => {
    if (!audit) return []
    if (filter === 'all') return audit.scenarios
    return audit.scenarios.filter((scenario) => scenario.status === filter)
  }, [audit, filter])

  return (
    <main style={{ maxWidth: 1850, margin: '0 auto', padding: 28, color: '#e8eee6', background: '#0e1710', minHeight: '100vh' }}>
      <header style={{ marginBottom: 20 }}>
        <p style={{ margin: 0, fontSize: 12, fontWeight: 800, letterSpacing: '0.14em', color: '#d4b15a' }}>
          LOOPER DEV · AIM & DECISION ENGINE
        </p>
        <h1 style={{ margin: '6px 0', color: '#fff' }}>Greywolf next-state decision audit</h1>
        <p style={{ margin: 0, maxWidth: 1120, color: '#9fb09f' }}>
          Neutral-condition behavior sweep across all 18 holes. The tee ~220 yd point is only an aim-direction reference;
          club selection now minimizes expected future strokes inside the catastrophe guardrail. Future EV includes the modeled core cloud and empirical mishit tail.
        </p>
      </header>

      <section style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 18 }}>
        <button
          type="button"
          onClick={() => setRunVersion((value) => value + 1)}
          disabled={status === 'loading'}
          style={{ padding: '9px 13px', borderRadius: 8, border: '1px solid #d4b15a', background: '#172419', color: '#fff' }}
        >
          {status === 'loading' ? 'Running course audit…' : 'Run again'}
        </button>
        <span style={{ color: '#9fb09f' }}>Cloud history: {sessionCount ?? '—'} sessions · {shotCount ?? '—'} shots</span>
        <span style={{ color: cloudSaveStatus.startsWith('save failed') ? '#c85a4a' : '#9fb09f' }}>Audit record: {cloudSaveStatus}</span>
        <label style={{ marginLeft: 'auto', color: '#9fb09f' }}>
          Show{' '}
          <select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
            <option value="all">all scenarios</option>
            <option value="review">review only</option>
            <option value="missing">missing only</option>
          </select>
        </label>
      </section>

      {error && (
        <section style={{ padding: 14, border: '1px solid #c85a4a', background: '#2a1714', borderRadius: 10, marginBottom: 18 }}>
          <strong>Audit failed.</strong> {error}
        </section>
      )}

      {status === 'loading' && (
        <section style={{ padding: 16, border: '1px solid #314233', borderRadius: 12, background: '#142118' }}>
          Loading synced player history, 18 canonical hole packages, deterministic outcome distributions, and next-state values…
        </section>
      )}

      {audit && (
        <>
          <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10, marginBottom: 18 }}>
            {[
              ['Holes', `${audit.summary.holesCovered}/18`],
              ['Scenarios', audit.summary.scenarioCount],
              ['Clear', audit.summary.clearCount],
              ['Review', audit.summary.reviewCount],
              ['Missing', audit.summary.missingCount],
              ['Missing EV', audit.summary.missingValueCount],
              ['Provisional EV', audit.summary.provisionalValueCount],
              ['Aim boundary', audit.summary.boundaryAimCount],
              ['Catastrophe >8%', audit.summary.elevatedCatastropheCount],
              ['Unknown >8%', audit.summary.highUnknownCount],
              ['Thin support', audit.summary.thinSupportCount],
            ].map(([label, value]) => (
              <div key={label} style={{ padding: 12, border: '1px solid #314233', borderRadius: 10, background: '#142118' }}>
                <div style={{ color: '#9fb09f', fontSize: 11 }}>{label}</div>
                <strong style={{ color: '#fff', fontSize: 22 }}>{value}</strong>
              </div>
            ))}
          </section>

          <section style={{ border: '1px solid #314233', borderRadius: 12, background: '#142118', overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: '#9fb09f', background: '#172419' }}>
                    {[
                      'Status', 'Hole', 'Scenario', 'Reference dist', 'Ball → target', 'Club', 'Future EV', 'Mean leave',
                      'Valued', 'Provisional', 'Carry gap', 'Aim', 'Success', 'Serious', 'Catastrophe', 'Unknown', 'Support',
                      'Fairway width', 'Penalty dist', 'Safe side', 'Review',
                    ].map((heading) => (
                      <th key={heading} style={{ padding: '9px 7px', borderBottom: '1px solid #314233', whiteSpace: 'nowrap' }}>{heading}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {scenarios.map((scenario) => {
                    const recommendation = scenario.recommendation
                    return (
                      <tr key={scenario.id} style={{ background: scenario.status === 'clear' ? undefined : 'rgba(209,138,59,.055)' }}>
                        <td style={{ padding: 7, color: statusColor(scenario.status), fontWeight: 800 }}>{scenario.status.toUpperCase()}</td>
                        <td style={{ padding: 7, color: '#fff', fontWeight: 700 }}>H{scenario.holeNumber}{scenario.par ? ` · P${scenario.par}` : ''}</td>
                        <td style={{ padding: 7, minWidth: 150 }}>{scenario.label}</td>
                        <td style={{ padding: 7 }}>{scenario.targetDistanceYds.toFixed(1)} yd</td>
                        <td style={{ padding: 7 }}>{scenario.ballSurface} → {scenario.targetSurface}</td>
                        <td style={{ padding: 7, color: '#fff', fontWeight: 700 }}>{recommendation?.club ?? '—'}</td>
                        <td style={{ padding: 7, color: '#fff', fontWeight: 800 }}>{fixed(recommendation?.expectedFutureStrokes)}</td>
                        <td style={{ padding: 7 }}>{recommendation?.meanDistanceToPinYds == null ? '—' : `${recommendation.meanDistanceToPinYds.toFixed(1)} yd`}</td>
                        <td style={{ padding: 7 }}>{pct(recommendation?.valuedProbability)}</td>
                        <td style={{ padding: 7 }}>{pct(recommendation?.provisionalProbability)}</td>
                        <td style={{ padding: 7 }}>{signed(recommendation?.carryGapYds)}</td>
                        <td style={{ padding: 7 }}>{signed(recommendation?.aimOffsetYds)}</td>
                        <td style={{ padding: 7 }}>{pct(recommendation?.success)}</td>
                        <td style={{ padding: 7 }}>{pct(recommendation?.seriousTrouble)}</td>
                        <td style={{ padding: 7 }}>{pct(recommendation?.catastrophe)}</td>
                        <td style={{ padding: 7 }}>{pct(recommendation?.unknown)}</td>
                        <td style={{ padding: 7 }}>{recommendation?.supportShots ?? '—'}</td>
                        <td style={{ padding: 7 }}>{scenario.tactical?.fairwayWidthYds == null ? '—' : `${scenario.tactical.fairwayWidthYds.toFixed(1)} yd`}</td>
                        <td style={{ padding: 7 }}>{scenario.tactical?.nearestPenaltyYds == null ? '—' : `${scenario.tactical.nearestPenaltyYds.toFixed(1)} yd`}</td>
                        <td style={{ padding: 7 }}>{scenario.tactical?.safeSide ?? '—'}</td>
                        <td style={{ padding: 7, minWidth: 280, color: '#cfd8cd' }}>{scenario.reviewReasons.join(' · ') || '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <footer style={{ color: '#9fb09f', fontSize: 12, marginTop: 16 }}>
            Authoritative ranking = lowest Future EV inside the catastrophe guardrail. Carry gap is diagnostic only. Review flags cover missing value,
            aim-search boundaries, &gt;8% catastrophe, &gt;8% unknown geometry, or &lt;5 Stock support. “Provisional” means the EV used an explicit V1 assumption such as unknown-as-rough or approximate penalty relief.
          </footer>
        </>
      )}
    </main>
  )
}

export default DecisionAuditDevPage
