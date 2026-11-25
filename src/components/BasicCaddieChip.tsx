import { useEffect, useRef, useState } from 'react'
import { BASIC_CADDIE_MISSING, BASIC_CADDIE_SUMMARY, BASIC_CADDIE_WORKS } from '../lib/basicCaddie'
import './BasicCaddieChip.css'

/** The bright chip with its details: Live Caddie's header. */
export function BasicCaddieChip({ fictional = false }: Readonly<{ fictional?: boolean }>) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return undefined
    const close = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  return (
    <div className="basic-caddie" ref={box}>
      <button type="button" className="basic-caddie__chip" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        Basic caddie · no map
      </button>
      {open ? (
        <div className="basic-caddie__panel" role="dialog" aria-label="Basic caddie">
          <p>
            {fictional ? "This course was designed for GSPro and doesn't exist in the real world. " : ''}
            {BASIC_CADDIE_SUMMARY}
          </p>
          <strong>What you get</strong>
          <ul>{BASIC_CADDIE_WORKS.map((line) => <li key={line}>{line}</li>)}</ul>
          <strong>What's missing</strong>
          <ul className="is-missing">{BASIC_CADDIE_MISSING.map((line) => <li key={line}>{line}</li>)}</ul>
          {fictional ? null : (
            <a href="/courses">Real course? Load its map on the Load page →</a>
          )}
        </div>
      ) : null}
    </div>
  )
}
