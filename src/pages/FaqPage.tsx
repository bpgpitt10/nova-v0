import { FAQ_SECTIONS, GETTING_STARTED } from '../lib/faqContent'
import looperLogoWhite from '../assets/LooperLogo.webp'
import './FaqPage.css'

/** Where players write for help (Brian, 21 Nov). */
export const SUPPORT_EMAIL = 'thelooper.golf.admin@gmail.com'

export default function FaqPage() {
  return (
    <main className="faq-page">
      <div className="faq-shell">
        <header className="faq-header">
          <a aria-label="Go to Looper home" href="/looper"><img alt="The Looper" src={looperLogoWhite} /></a>
          <div>
            <h1>Questions and answers</h1>
            <p>How The Looper works, and what to do when something does not.</p>
            <p className="faq-support">Still stuck? Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. Copy the support code from Live Caddie&rsquo;s Details if you have one.</p>
          </div>
        </header>
        <section aria-labelledby="faq-start-title" className="faq-start" id="start-here">
          <h2 id="faq-start-title">How to get going</h2>
          <p className="faq-start-lead">You have signed in. Here is the path from there, in the order that works best.</p>
          <ol>
            {GETTING_STARTED.map((step, index) => (
              <li key={step.title}>
                <span aria-hidden="true" className="faq-start-number">{index + 1}</span>
                <div>
                  <h3>{step.title} <span className="faq-start-when">{step.when}</span></h3>
                  {step.body.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                  {step.link ? <a className="faq-link" href={step.link.href}>{step.link.label} →</a> : null}
                </div>
              </li>
            ))}
          </ol>
        </section>
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
        <section className="faq-section faq-contact" id="contact">
          <h2>Contact</h2>
          <p>Questions, bugs or a course that isn&rsquo;t loading right: email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. A screenshot and the support code from Live Caddie&rsquo;s Details help a lot.</p>
        </section>
      </div>
    </main>
  )
}

/** Help, Insights and support: the same links under the tagline and in the page-bottom footer. */
export function LooperHelpLinks() {
  return (
    <>
      <a href="/faq">FAQ and Help</a>
      <span aria-hidden="true"> · </span>
      <a href="/insights">GSPro 4.1.9 Insights</a>
      <span aria-hidden="true"> · </span>
      <a href={`mailto:${SUPPORT_EMAIL}`}>Email support</a>
    </>
  )
}

/** One quiet line at the bottom of every page. */
export function LooperFooter() {
  return (
    <footer className="looper-footer">
      <LooperHelpLinks />
    </footer>
  )
}
