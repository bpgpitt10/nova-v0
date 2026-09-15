import { useEffect, useMemo, useState } from 'react'
import { loadSavedSessionsFromCloud } from '../cloud/cloudPersistence'
import {
  AIM_DECISION_RANKING_PROOFS,
  AIM_DECISION_RANKING_PROOFS_PASS,
} from '../liveCaddie/aimDecisionRankingProof'
import {
  buildGreywolfHole08AimDecisionProof,
  type GreywolfAimDecisionProof,
} from '../liveCaddie/greywolfAimDecisionProof'

const pct = (value: number | null | undefined) =>
  typeof value === 'number' ? `${(value * 100).toFixed(value < 0.05 ? 1 : 0)}%` : '—'

const signed = (value: number | null | undefined, unit = ' yd') =>
  typeof value === 'number' ? `${value >= 0 ? '+' : ''}${value.toFixed(1)}${unit}` : '—'

const mono: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
}

function DecisionReplayDevPage() {
  const [proof, setProof] = useState<GreywolfAimDecisionProof | null>(null)
  const [sessionCount, setSessionCount] = useState<number | null>(null)
  const [shotCount, setShotCount] = useState<number | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [runVersion, setRunVersion] = useState(0)

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setError(null)
    void loadSavedSessionsFromCloud()
      .then(async (sessions) => {
        if (cancelled) return
        setSessionCount(sessions.length)
        setShotCount(sessions.reduce((sum, session) => sum + session.shots.length, 0))
        const result = await buildGreywolfHole08AimDecisionProof(sessions)
        if (cancelled) return
        setProof(result)
        setStatus('ready')
      })
      .catch((cause) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : String(cause))
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [runVersion])

  const recommendation = proof?.recommendation ?? null
  const policyPassCount = useMemo(
    () => AIM_DECISION_RANKING_PROOFS.filter((item) => item.passed).length,
    [],
  )

  return (
    <main style={{ maxWidth: 1500, margin: '0 auto', padding: 28, color: '#e8eee6', background: '#0e1710', minHeight: '100vh' }}>
      <header style={{ marginBottom: 20 }}>
        <p style={{ margin: 0, fontSize: 12, fontWeight: 800, letterSpacing: '0.14em', color: '#d4b15a' }}>
          LOOPER DEV · AIM & DECISION ENGINE
        </p>
        <h1 style={{ margin: '6px 0', color: '#fff' }}>Off-sim decision replay</h1>
        <p style={{ margin: 0, maxWidth: 920, color: '#9fb09f' }}>
          Runs the same full-risk club + aim policy used by Aim Lab against synced player history and canonical course geometry.
          No GSPro install, launch monitor, or simulator session is required.
        </p>
      </header>

      <section style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 18 }}>
        <button
          type="button"
          onClick={() => setRunVersion((value) => value + 1)}
          disabled={status === 'loading'}
          style={{ padding: '9px 13px', borderRadius: 8, border: '1px solid #d4b15a', background: '#172419', color: '#fff' }}
        >
          {status === 'loading' ? 'Running…' : 'Run again'}
        </button>
        <span style={{ color: '#9fb09f' }}>
          Cloud history: {sessionCount ?? '—'} sessions · {shotCount ?? '—'} shots
        </span>
      </section>

      {error && (
        <section style={{ padding: 14, border: '1px solid #c85a4a', background: '#2a1714', borderRadius: 10, marginBottom: 18 }}>
          <strong>Replay failed.</strong> {error}
        </section>
      )}

      <section style={{ padding: 16, border: '1px solid #314233', borderRadius: 12, background: '#142118', marginBottom: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <p style={{ margin: 0, color: '#9fb09f', fontSize: 12 }}>POLICY INVARIANTS</p>
            <h2 style={{ margin: '5px 0', color: '#fff' }}>
              {AIM_DECISION_RANKING_PROOFS_PASS ? 'PASS' : 'FAIL'} · {policyPassCount}/{AIM_DECISION_RANKING_PROOFS.length}
            </h2>
          </div>
          <span style={{ color: AIM_DECISION_RANKING_PROOFS_PASS ? '#76d39b' : '#c85a4a', fontWeight: 800 }}>
            {AIM_DECISION_RANKING_PROOFS_PASS ? 'Ranking guardrails behave as designed' : 'Ranking policy regression detected'}
          </span>
        </div>
        <div style={{ overflowX: 'auto', marginTop: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#9fb09f' }}>
                {['Result', 'Proof', 'Expected', 'Actual', 'Why'].map((heading) => (
                  <th key={heading} style={{ padding: '8px 7px', borderBottom: '1px solid #314233' }}>{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {AIM_DECISION_RANKING_PROOFS.map((item) => (
                <tr key={item.id}>
                  <td style={{ padding: 7, color: item.passed ? '#76d39b' : '#c85a4a', fontWeight: 800 }}>{item.passed ? 'PASS' : 'FAIL'}</td>
                  <td style={{ padding: 7, ...mono }}>{item.id}</td>
                  <td style={{ padding: 7 }}>{item.expectedWinner}</td>
                  <td style={{ padding: 7 }}>{item.actualWinner ?? '—'}</td>
                  <td style={{ padding: 7, color: '#cfd8cd' }}>{item.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section style={{ padding: 16, border: '1px solid #314233', borderRadius: 12, background: '#142118', marginBottom: 18 }}>
        <p style={{ margin: 0, color: '#9fb09f', fontSize: 12 }}>REAL COURSE × PLAYER REPLAY</p>
        <h2 style={{ margin: '5px 0 12px', color: '#fff' }}>Greywolf Hole 8</h2>
        {status === 'loading' && <p style={{ color: '#9fb09f' }}>Loading cloud history and canonical geometry…</p>}
        {status === 'ready' && proof && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10, marginBottom: 14 }}>
              {[
                ['Target', `${proof.scenario.targetDistanceYds.toFixed(1)} yd`],
                ['Club', recommendation?.club ?? '—'],
                ['Modeled carry', recommendation ? `${recommendation.modeledCarryYds.toFixed(1)} yd` : '—'],
                ['Carry gap', signed(recommendation?.carryGapYds)],
                ['Aim', signed(recommendation?.aimOffsetYds)],
                ['Success', pct(recommendation?.fullRiskSuccess)],
                ['Serious trouble', pct(recommendation?.fullRiskSeriousTrouble)],
                ['Catastrophe', pct(recommendation?.fullRiskCatastrophe)],
                ['Mishit tail', pct(recommendation?.tailProbability)],
              ].map(([label, value]) => (
                <div key={label} style={{ padding: 11, border: '1px solid #314233', borderRadius: 9, background: '#172419' }}>
                  <div style={{ color: '#9fb09f', fontSize: 11 }}>{label}</div>
                  <strong style={{ color: '#fff', fontSize: 18 }}>{value}</strong>
                </div>
              ))}
            </div>
            <p style={{ color: '#cfd8cd', margin: '8px 0' }}><strong>Club:</strong> {recommendation?.clubDecisionReason ?? '—'}</p>
            <p style={{ color: '#cfd8cd', margin: '8px 0 14px' }}><strong>Aim:</strong> {recommendation?.aimDecisionReason ?? '—'}</p>

            <h3 style={{ color: '#fff', marginBottom: 8 }}>Club ranking</h3>
            <div style={{ overflowX: 'auto', marginBottom: 18 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: '#9fb09f' }}>
                    {['Rank', 'Club', 'Carry', 'Gap', 'Aim', 'Target fit', 'Safe set', 'Success', 'Serious', 'Catastrophe'].map((heading) => (
                      <th key={heading} style={{ padding: '8px 7px', borderBottom: '1px solid #314233' }}>{heading}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {proof.clubRanking.map((row) => (
                    <tr key={row.club} style={{ background: row.rank === 1 ? 'rgba(212,177,90,.08)' : undefined }}>
                      <td style={{ padding: 7 }}>{row.rank ?? '—'}</td>
                      <td style={{ padding: 7, color: '#fff', fontWeight: 700 }}>{row.club}</td>
                      <td style={{ padding: 7 }}>{row.modeledCarryYds.toFixed(1)}</td>
                      <td style={{ padding: 7 }}>{signed(row.carryGapYds)}</td>
                      <td style={{ padding: 7 }}>{signed(row.bestAimOffsetYds)}</td>
                      <td style={{ padding: 7 }}>{row.targetFit === null ? '—' : row.targetFit ? 'yes' : 'no'}</td>
                      <td style={{ padding: 7 }}>{row.catastropheGuardrail === null ? '—' : row.catastropheGuardrail ? 'yes' : 'no'}</td>
                      <td style={{ padding: 7 }}>{pct(row.success)}</td>
                      <td style={{ padding: 7 }}>{pct(row.seriousTrouble)}</td>
                      <td style={{ padding: 7 }}>{pct(row.catastrophe)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 style={{ color: '#fff', marginBottom: 8 }}>Aim sweep · selected club</h3>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: '#9fb09f' }}>
                    {['Rank', 'Aim', 'Safe set', 'Core preferred', 'Full success', 'Manageable', 'Serious', 'Catastrophe', 'Unknown', 'Severity'].map((heading) => (
                      <th key={heading} style={{ padding: '8px 7px', borderBottom: '1px solid #314233' }}>{heading}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {proof.aimSweep.map((row) => (
                    <tr key={row.aimOffsetYds} style={{ background: row.rank === 1 ? 'rgba(212,177,90,.08)' : undefined }}>
                      <td style={{ padding: 7 }}>{row.rank ?? '—'}</td>
                      <td style={{ padding: 7 }}>{signed(row.aimOffsetYds)}</td>
                      <td style={{ padding: 7 }}>{row.catastropheGuardrail === null ? '—' : row.catastropheGuardrail ? 'yes' : 'no'}</td>
                      <td style={{ padding: 7 }}>{pct(row.corePreferred)}</td>
                      <td style={{ padding: 7 }}>{pct(row.success)}</td>
                      <td style={{ padding: 7 }}>{pct(row.manageable)}</td>
                      <td style={{ padding: 7 }}>{pct(row.seriousTrouble)}</td>
                      <td style={{ padding: 7 }}>{pct(row.catastrophe)}</td>
                      <td style={{ padding: 7 }}>{pct(row.unknown)}</td>
                      <td style={{ padding: 7 }}>{row.expectedSeverity?.toFixed(2) ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {proof.notes.map((note) => <p key={note} style={{ color: '#9fb09f', fontSize: 12 }}>{note}</p>)}
          </>
        )}
      </section>

      <footer style={{ color: '#9fb09f', fontSize: 12 }}>
        This page deliberately uses neutral wind/elevation/lie for the Greywolf replay. Environmental transforms are validated separately after the Course × Player baseline is trusted.
      </footer>
    </main>
  )
}

export default DecisionReplayDevPage
