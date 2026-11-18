import { FAQ_SECTIONS } from '../lib/faqContent'
import looperLogoWhite from '../assets/LooperLogo.webp'
import './FaqPage.css'

export default function FaqPage() {
  return (
    <main className="faq-page">
      <div className="faq-shell">
        <header className="faq-header">
          <a aria-label="Go to Looper home" href="/looper"><img alt="The Looper" src={looperLogoWhite} /></a>
          <div>
            <h1>Questions and answers</h1>
            <p>How The Looper works, and what to do when something does not.</p>
          </div>
        </header>
        <nav className="faq-jump" aria-label="FAQ topics">
          {FAQ_SECTIONS.map((section) => <a key={section.id} href={`#${section.id}`}>{section.title}</a>)}
        </nav>
        {FAQ_SECTIONS.map((section) => (
          <section key={section.id} id={section.id} className="faq-section">
            <h2>{section.title}</h2>
            {section.note ? <p className="faq-note">{section.note}</p> : null}
            {section.items.map((item) => (
              <details key={item.q}>
                <summary>{item.q}</summary>
                <div className="faq-answer">
                  {item.a.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                  {item.steps ? <ol>{item.steps.map((step) => <li key={step}>{step}</li>)}</ol> : null}
                  {item.table ? (
                    <table>
                      <thead><tr><th>{item.table.head[0]}</th><th>{item.table.head[1]}</th></tr></thead>
                      <tbody>
                        {item.table.rows.map((row) => <tr key={row[0]}><td>{row[0]}</td><td>{row[1]}</td></tr>)}
                      </tbody>
                    </table>
                  ) : null}
                  {item.link ? <a className="faq-link" href={item.link.href}>{item.link.label} →</a> : null}
                </div>
              </details>
            ))}
          </section>
        ))}
      </div>
    </main>
  )
}

/** One quiet line at the bottom of every page. */
export function LooperFooter() {
  return (
    <footer className="looper-footer">
      <a href="/faq">FAQ and Help</a>
    </footer>
  )
}
