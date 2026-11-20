import { ROUND_WINDOWS, type RoundWindow } from '../lib/roundWindow'

/** Last 6 months / Last 5 / Last 15 / All: the same choice on every stats page. */
export function RoundWindowPills({ value, onChange }: { value: RoundWindow; onChange: (next: RoundWindow) => void }) {
  return (
    <div aria-label="Rounds included" className="round-window-pills" role="group">
      {ROUND_WINDOWS.map(([id, label]) => (
        <button key={id} aria-pressed={value === id} className={value === id ? 'active' : ''} onClick={() => onChange(id)} type="button">
          {label}
        </button>
      ))}
    </div>
  )
}
