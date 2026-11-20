import { useEffect, type CSSProperties, type ReactNode } from 'react'
import looperLogo from '../assets/LooperLogo.webp'
import greensCard from '../assets/insights/insight-01-greens.webp'
import rangeCard from '../assets/insights/insight-02-range-vs-green.webp'
import InsightsReadQuiz from './InsightsReadQuiz'
import './InsightsPage.css'

/**
 * "GSPro physics, measured": the public home of the post series. No account
 * needed. Each part is a shareable card plus a short article, and every part
 * points at a free account. Parts that haven't been measured yet are shown as
 * open slots, so the whole series is visible from the first post.
 *
 * Posts link straight to a part: thelooper.golf/insights#greens
 */

const SIGN_IN_HREF = '/'
const SIGN_UP_HREF = '/?signup=1'

type Part = Readonly<{
  id: string
  number: string
  name: string
  /** The part's colour: its tab, its headings and its account button. */
  colour: string
  question: string
  card?: { src: string; alt: string }
  article?: ReactNode
  /** One line on what an unwritten part will cover. */
  coming?: string
  caddie?: string
}>

const PARTS: readonly Part[] = [
  {
    id: 'greens',
    number: '01',
    name: 'Greens',
    colour: '#eab308',
    question: 'You’re adjusting the wrong setting',
    card: {
      src: greensCard,
      alt: 'Release in yards for a wedge, 9 iron, 7 iron and 5 iron on Bentgrass, Bermuda and Links greens at soft, medium and firm, each compared with Bermuda soft, at stimp 11.',
    },
    caddie: 'Looper reads the grass type and firmness from GSPro and adds the release to every club it recommends.',
    article: (
      <>
        <p className="insights-lead">
          Ask a GSPro player how the greens are playing and they&rsquo;ll tell you the firmness. I tested all nine
          green settings, and firmness is the less important half. The grass type moves the ball two to three times
          as far.
        </p>
        <h3>How I think about it now</h3>
        <ul>
          <li>
            <strong>Grass type first, firmness second.</strong> Going from soft to firm on the same grass adds about
            3 yards of release to a 7 iron. Going from Bentgrass to Links at the same firmness adds about 7.
          </li>
          <li>
            <strong>Soft Links is not soft.</strong> It released more than firm Bermuda with every club I tested. If
            the course says Links, ignore the word &ldquo;soft&rdquo;.
          </li>
          <li>
            <strong>Bentgrass firm and Bermuda soft are the same green.</strong> They were within half a yard of each
            other from wedge to 5 iron.
          </li>
          <li>
            <strong>Your wedge is safe. Your long irons are not.</strong> A full wedge stopped within 2 yards on all
            nine settings. A 5 iron ran under a yard on soft Bentgrass and nearly 20 on firm Links.
          </li>
        </ul>
        <h3>What I do with it</h3>
        <p>
          On Bentgrass I fly it to the number. On Bermuda I take a few yards off mid irons and more off long irons. On
          Links I land anything longer than a 9 iron well short and let it run.
        </p>
        <h3>The catch</h3>
        <p>
          Spin changes all of this. A 7 iron that loses 30% of its spin, which is what rough does, releases like a 5
          iron. So the same shot from the rough needs a different number again.
        </p>
        <p className="insights-limits">
          Measured in GSPro 4.1.9 from 131 landings at stimp 11 on level greens. Stimp is part 03; the slope of your lie is part 06.
        </p>
      </>
    ),
  },
  {
    id: 'range-vs-green',
    number: '02',
    name: 'Range vs green',
    colour: '#76d39b',
    question: 'Stop trusting your range rollout',
    card: {
      src: rangeCard,
      alt: 'How many more yards the same shot rolls on the GSPro range than it releases on a green, for a wedge, 9 iron, 7 iron and 5 iron across nine settings.',
    },
    caddie: 'Looper works from your carry and adds the rollout for where the ball will land: fairway, green, rough or sand.',
    article: (
      <>
        <p className="insights-lead">
          The GSPro range rolls like a fairway. A green doesn&rsquo;t. I hit the same four shots onto both with
          identical settings, and the range showed up to 8 yards of rollout that never happens on a green.
        </p>
        <h3>How I think about it now</h3>
        <ul>
          <li>
            <strong>Carry is the only number that travels.</strong> The total you see on the range includes fairway
            roll. Into a green, most of that roll isn&rsquo;t coming with you.
          </li>
          <li>
            <strong>Short clubs lie the most.</strong> A wedge on Bermuda medium rolled 3.9 yards on the range and 0.1
            on the green.
          </li>
          <li>
            <strong>Long irons are closer to honest.</strong> A 5 iron on the same setting rolled 12.0 on the range
            and 9.1 on the green.
          </li>
          <li>
            <strong>Bentgrass is the exception.</strong> Its range and green numbers stay within a yard or three of
            each other.
          </li>
        </ul>
        <h3>What I do with it</h3>
        <p>
          I build my yardages from carry. Into a green I add the green&rsquo;s release, not the range&rsquo;s. Laying
          up to a fairway, I add the roll back.
        </p>
        <h3>The catch</h3>
        <p>
          This is the best case, with the range and the course on the same settings. Practise on one grass type and
          play another and the gap is bigger than anything on this card.
        </p>
        <p className="insights-limits">
          Measured in GSPro 4.1.9: range roll from 36 launches on all nine settings, green release from 131 landings
          at stimp 11 on level greens.
        </p>
      </>
    ),
  },
  {
    id: 'stimp',
    number: '03',
    name: 'Stimp',
    colour: '#8bb8ff',
    question: 'What does stimp do to release?',
    coming: 'The same approach shots at stimp 8, 10, 12 and 13.',
  },
  {
    id: 'putting',
    number: '04',
    name: 'Putting',
    colour: '#2ec4e6',
    question: 'How far does a putt really roll?',
    coming: 'Roll-out by stimp, uphill and downhill, and how much a side slope turns the ball.',
  },
  {
    id: 'chipping',
    number: '05',
    name: 'Chipping',
    colour: '#f97316',
    question: 'How do chips react on each green?',
    coming: 'Bump and run, chip, pitch and flop across the grass types.',
  },
  {
    id: 'lies',
    number: '06',
    name: 'Lies',
    colour: '#c9a46a',
    question: 'Your bag stops working in deep rough',
    caddie: 'Looper reads the lie and its slope from GSPro before every shot, and works out each club from there, not from your fairway numbers.',
    article: (
      <>
        <p className="insights-lead">
          From the fairway, more club means more distance. From GSPro&rsquo;s deep rough it mostly doesn&rsquo;t. Run what I
          measured through an 8 iron, a 5 iron and a hybrid and all three carry about 105 yards out of the same deep rough, from clean
          carries of 146, 182 and 198.
        </p>
        <h3>How GSPro handles the lie</h3>
        <p>
          GSPro doesn&rsquo;t take a flat percentage off. It takes away some of the ball&rsquo;s speed and some of its
          spin, and how much depends on how the ball comes off the face. The lower the launch, the more the grass
          grabs it. That is why the longest clubs suffer most.
        </p>
        <ul>
          <li>
            <strong>Deep rough is a launch-angle problem.</strong> A high-launching wedge keeps about 80% of its ball
            speed. A low-launching long iron keeps about 65%. Spin is cut roughly in half either way, so whatever does
            come out runs on landing.
          </li>
          <li>
            <strong>Rough is a flyer, not a penalty.</strong> It costs a few percent of speed but up to a third of the
            spin. A 5 iron from the rough carried 12 yards less than from the fairway and finished 2 yards further,
            because it ran out.
          </li>
          <li>
            <strong>Sand is gentler than you think on full swings.</strong> It takes about 7% of ball speed from a full
            iron and leaves the spin alone. Slower swings lose more of both.
          </li>
          <li>
            <strong>The first cut barely counts.</strong> About 1.5% of speed and 5% of spin.
          </li>
          <li>
            <strong>The cart path is free</strong>, unless you hit a driver-type shot off it, which loses about a
            quarter of its speed.
          </li>
        </ul>
        <h3>The slope matters too</h3>
        <p>
          A slope under the ball changes the launch, and GSPro shows it only in the flight. Up or down, the launch moves
          by roughly half to nine-tenths of the slope, more for low-launching clubs, which changes distance by a yard
          or two. Across, the ball starts toward the low side by a similar share, and that adds up fast: a 6&deg; side
          slope sends a 5 iron about 16 yards offline. On the sim, it&rsquo;s the side slope that catches people out.
        </p>
        <h3>What I do with it</h3>
        <p>
          In deep rough I take the club that launches highest and still gets there, not one more than normal: the
          longer club usually buys nothing. In the rough I plan for the ball to release. On a side slope I aim off
          before I worry about the distance.
        </p>
        <p className="insights-limits">
          Measured in GSPro 4.1.9 from about 330 shots fired from rough, deep rough, sand, first cut, cart path and
          sloped lies on four courses.
        </p>
      </>
    ),
  },
]

const OVERVIEW_COLOUR = '#f2e2b8'

const colourVar = (colour: string) => ({ '--insight-colour': colour }) as CSSProperties

function AccountButton({ colour, children = 'Create a free account' }: { colour?: string; children?: ReactNode }) {
  return (
    <a className="insights-button" href={SIGN_UP_HREF} style={colour ? colourVar(colour) : undefined}>
      {children}
    </a>
  )
}

export default function InsightsPage() {
  useEffect(() => {
    const previous = document.title
    document.title = 'GSPro physics, measured · The Looper'
    // A post links to one part (/insights#greens): go to it once the page is drawn.
    const id = decodeURIComponent(window.location.hash.replace(/^#/, ''))
    if (id) window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView())
    return () => {
      document.title = previous
    }
  }, [])

  return (
    <div className="insights-page" id="top">
      <header className="insights-top">
        <div className="insights-wrap insights-top__row">
          <a className="insights-top__logo" href="#top" aria-label="Back to the top">
            <img src={looperLogo} alt="The Looper" />
          </a>
          <nav className="insights-top__nav" aria-label="Account">
            <a href={SIGN_IN_HREF}>Sign in</a>
            <AccountButton />
          </nav>
        </div>
      </header>

      <section className="insights-hero">
        <div className="insights-wrap">
          <p className="insights-eyebrow">Insights from The Looper</p>
          <h1>
            GSPro physics, <em>measured</em>
          </h1>
          <p className="insights-hero__lead">
            A lot of GSPro misses aren&rsquo;t swing misses. They&rsquo;re bad reads. I test GSPro&rsquo;s physics one
            setting at a time and measure what the ball actually does.
          </p>
        </div>
      </section>

      <InsightsReadQuiz />

      <nav className="insights-tabs" aria-label="Parts of the series">
        <div className="insights-wrap insights-tabs__row">
          <a className="insights-tab is-open" href="#overview" style={colourVar(OVERVIEW_COLOUR)}>
            <span>Overview</span>
            The whole picture
          </a>
          {PARTS.map((part) => (
            <a
              className={`insights-tab ${part.article ? 'is-ready' : 'is-open'}`}
              href={`#${part.id}`}
              key={part.id}
              style={colourVar(part.colour)}
            >
              <span>{part.article ? part.number : `${part.number} · testing`}</span>
              {part.name}
            </a>
          ))}
        </div>
      </nav>

      <section className="insights-part insights-part--open" id="overview" style={colourVar(OVERVIEW_COLOUR)}>
        <div className="insights-wrap">
          <p className="insights-eyebrow">Overview</p>
          <h2>The whole picture</h2>
          <div className="insights-open-slot">
            <strong>Written once every part is measured.</strong>
            <p>
              Grass type, firmness, stimp, slope, lie and spin each move the number, and they all move it at once.
              This piece will add them up and show why it can&rsquo;t be done as mental math.
            </p>
          </div>
        </div>
      </section>

      {PARTS.map((part) => (
        <section
          className={`insights-part ${part.article ? '' : 'insights-part--open'}`}
          id={part.id}
          key={part.id}
          style={colourVar(part.colour)}
        >
          <div className="insights-wrap">
            {part.article && part.card ? (
              /* The card floats right from the very top, beside the heading too. */
              <figure className="insights-entry__card">
                <a href={part.card.src} rel="noreferrer" target="_blank">
                  <img alt={part.card.alt} loading="lazy" src={part.card.src} width={1600} height={1723} />
                </a>
                <figcaption>Open the card full size to save or share it.</figcaption>
              </figure>
            ) : null}
            <p className="insights-eyebrow">
              {part.number} · {part.name}
            </p>
            <h2>{part.question}</h2>
            {part.article && part.card ? (
              <div className="insights-entry">
                <article className="insights-entry__text">
                  {part.article}
                  <aside className="insights-caddie">
                    <p>
                      <strong>In the live caddie:</strong> {part.caddie}
                    </p>
                    <AccountButton colour={part.colour} />
                  </aside>
                </article>
              </div>
            ) : part.article ? (
              <article className="insights-entry__text insights-entry__text--wide">
                {part.article}
                <aside className="insights-caddie">
                  <p>
                    <strong>In the live caddie:</strong> {part.caddie}
                  </p>
                  <AccountButton colour={part.colour} />
                </aside>
              </article>
            ) : (
              <div className="insights-open-slot">
                <strong>In testing.</strong>
                <p>{part.coming}</p>
              </div>
            )}
          </div>
        </section>
      ))}

      <section className="insights-close">
        <div className="insights-wrap">
          <h2>You don&rsquo;t have to remember any of this</h2>
          <p>
            The Looper sits beside GSPro and tells you what to hit. It knows the lie, the slope, the wind, the green
            you&rsquo;re landing on and how far your clubs carry.
          </p>
          <AccountButton />
          <p className="insights-close__signin">
            Free, always. Already playing with The Looper? <a href={SIGN_IN_HREF}>Sign in</a>
          </p>
        </div>
      </section>

      <footer className="insights-footer">
        <div className="insights-wrap insights-footer__row">
          <span>The Looper · thelooper.golf</span>
          <span>Measured in GSPro 4.1.9. The Looper is not affiliated with GSPro.</span>
        </div>
      </footer>
    </div>
  )
}
