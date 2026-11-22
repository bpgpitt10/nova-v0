import './LooperTagline.css'
import { LooperHelpLinks } from '../pages/FaqPage'

/** The sign-off at the foot of every page (Brian, 11/6: it lived on the Bag page; now everywhere). */
export function LooperTagline() {
  return (
    <>
      <p className="looper-tagline">Every club holds a truth.</p>
      {/* The help link sits right under the tagline; the page-bottom footer steps aside when this is on the page. */}
      <p className="looper-tagline-help"><LooperHelpLinks /></p>
    </>
  )
}
