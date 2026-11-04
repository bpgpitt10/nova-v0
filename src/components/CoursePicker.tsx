import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CourseCatalogEntry } from '../courseGeometry/courseCatalog'
import { courseSearchScore } from '../courseGeometry/courseSearch'

/**
 * Course search box for Start a Round: type a few letters and pick from the
 * matches (name, location or GSPro name). Replaces a dropdown that grows with
 * every loaded course. Keyboard: arrows move, Enter picks, Escape closes.
 */

const MAX_SHOWN = 8

export function CoursePicker({
  courses,
  value,
  onChange,
}: Readonly<{
  courses: readonly CourseCatalogEntry[]
  value: string
  onChange: (courseId: string) => void
}>) {
  const listId = useId()
  const selected = courses.find((entry) => entry.id === value) ?? null
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  const matches = useMemo(() => {
    const ready = courses.filter((entry) => entry.packageStatus === 'ready')
    return ready
      .map((entry) => ({ entry, score: courseSearchScore(entry, query) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
      .map((item) => item.entry)
  }, [courses, query])
  const shown = query ? matches.slice(0, MAX_SHOWN) : matches

  useEffect(() => { setActive(0) }, [query])
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const pick = (entry: CourseCatalogEntry) => {
    onChange(entry.id)
    setQuery('')
    setOpen(false)
    inputRef.current?.blur()
  }

  return (
    <div className="course-picker" ref={boxRef}>
      <input
        aria-activedescendant={open && shown[active] ? `${listId}-${active}` : undefined}
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={open}
        aria-label="Course"
        autoComplete="off"
        onChange={(event) => {
          setQuery(event.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
            setActive((i) => Math.min(i + 1, Math.max(0, shown.length - 1)))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActive((i) => Math.max(i - 1, 0))
          } else if (event.key === 'Enter') {
            if (open && shown[active]) {
              event.preventDefault()
              pick(shown[active])
            }
          } else if (event.key === 'Escape') {
            setOpen(false)
            setQuery('')
          }
        }}
        // The chosen course shows as the placeholder, so typing always starts a fresh search.
        className={!open && selected ? 'has-selection' : undefined}
        placeholder={open ? 'Type a course name…' : selected?.name ?? 'Search your courses'}
        ref={inputRef}
        role="combobox"
        type="text"
        value={query}
      />
      {open ? (
        <ul className="course-picker-list" id={listId} role="listbox">
          {shown.length === 0 ? (
            <li className="course-picker-empty" role="presentation">
              No loaded course matches “{query}”. <a href="/courses">Load it →</a>
            </li>
          ) : shown.map((entry, index) => (
            <li
              aria-selected={entry.id === value}
              className={`course-picker-option${index === active ? ' is-active' : ''}${entry.id === value ? ' is-selected' : ''}`}
              id={`${listId}-${index}`}
              key={entry.id}
              onMouseDown={(event) => {
                event.preventDefault()
                pick(entry)
              }}
              onMouseEnter={() => setActive(index)}
              role="option"
            >
              <span className="course-picker-name">{entry.name}</span>
              {entry.location ? <span className="course-picker-location">{entry.location}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
