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
    question: 'Read the grass before the firmness',
    card: {
      src: greensCard,
      alt: 'Release in yards for a wedge, 9 iron, 7 iron and 5 iron on Bentgrass, Bermuda and Links greens at soft, medium and firm, each compared with Bermuda soft, at stimp 11.',
    },
    caddie: 'Looper reads the grass type and firmness from GSPro and adds the release to every club it recommends.',
    article: (
      <>
        <p className="insights-lead">
          On a GSPro green, the grass type moves your ball more than the firmness does. I tested all nine green
          settings, three grasses at three firmnesses, and changing the grass moved the release two to three times as
          far as changing the firmness.
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
        <h3>What to do with it</h3>
        <p>
          On Bentgrass, fly it to the number. On Bermuda, take a few yards off mid irons and more off long irons. On
          Links, land anything longer than a 9 iron well short and let it run.
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
        <h3>What to do with it</h3>
        <p>
          Build your yardages from carry. Into a green, add the green&rsquo;s release, not the range&rsquo;s. Laying
          up to a fairway, add the roll back.
        </p>
        <h3>The catch</h3>
        <p>
          This is the best case, with the range and the course on the same settings. Practice on one grass type and
          play another and the gap is bigger than anything on this card.
        </p>
        <p className="insights-limits">
          Measured in GSPro 4.1.9. Range roll: each club&rsquo;s stock shot fired onto the range once on each of the
          nine settings (GSPro rolls the same shot the same distance every time, to a hundredth of a yard). Green
          release: 131 landings at stimp 11 on level greens.
        </p>
      </>
    ),
  },
  {
    id: 'stimp',
    number: '03',
    name: 'Stimp',
    colour: '#8bb8ff',
    question: 'Stimp barely touches your approaches',
    caddie: 'Looper takes the stimp you set when you start a round and applies it to the roll after the bounce, not to the bounce itself.',
    article: (
      <>
        <p className="insights-lead">
          Going from stimp 8 to stimp 13 moved my full pitching wedge a tenth of a yard. I hit the same six approach
          shots at stimp 8, 11 and 13, a pitching wedge and a 9 iron at three spins each, and the green&rsquo;s speed
          barely showed up.
        </p>
        <h3>How I think about it now</h3>
        <ul>
          <li>
            <strong>Stimp changes the roll, not the bounce.</strong> Every shot split the same way: a hop and skid that
            didn&rsquo;t change at all, then a roll that grew with the green&rsquo;s speed. A wedge that lands with
            spin has almost no roll left for the stimp to work on.
          </li>
          <li>
            <strong>Low spin is where it shows.</strong> A 9 iron at 5,500 rpm released 5.3 yards at stimp 8 and 7.1
            at stimp 13. The same club at 7,800 rpm went from 2.2 to 2.5.
          </li>
          <li>
            <strong>Fast greens spin it back further.</strong> A wedge at 10,800 rpm backed up 0.2 yards at stimp 8
            and 1.9 at stimp 13. Stimp makes whatever the ball is doing bigger, forward or backward.
          </li>
          <li>
            <strong>A ball that stops dead stays dead.</strong> A 9 iron at 9,800 rpm finished 0.8 yards past its
            landing spot at all three speeds.
          </li>
        </ul>
        <h3>What to do with it</h3>
        <p>
          On full approaches, ignore the stimp and read the grass instead (part 01). Change your number only for a
          shot that comes in with little spin, or one you know spins back: on a fast green, land it a yard further
          past the pin than you normally would.
        </p>
        <h3>The catch</h3>
        <p>
          Stimp barely matters in the air and matters a lot on the ground. The slower the ball arrives, the more of
          its release is roll, so chips and putts feel the stimp far more. A putt hit to roll 20 feet at stimp 11
          rolls 15 at stimp 8 and 23 at stimp 13. That&rsquo;s parts 04 and 05.
        </p>
        <p className="insights-limits">
          Measured in GSPro 4.1.9 from 18 shots: a pitching wedge and a 9 iron at three spins each, carried about 125
          yards onto Briarwood West&rsquo;s Bermuda medium green at stimp 8, 11 and 13.
        </p>
      </>
    ),
  },
  {
    id: 'putting',
    number: '04',
    name: 'Putting',
    colour: '#2ec4e6',
    question: 'Only two settings move a putt',
    caddie: 'Looper’s putting review splits every putt you hit into read, line and pace, and shows which one is costing you strokes.',
    article: (
      <>
        <p className="insights-lead">
          On a GSPro green, the grass type and firmness don&rsquo;t change a putt at all. I rolled 174 putts at stimp
          8 to 13, flat, uphill and downhill. On five different grass and firmness settings, the same putt finished
          within a hundredth of a foot. Only the stimp and the slope move it.
        </p>
        <h3>How I think about it now</h3>
        <ul>
          <li>
            <strong>GSPro&rsquo;s stimp is a real stimp.</strong> Run a stimpmeter&rsquo;s release speed through
            what I measured and the ball rolls 11.0 feet at stimp 11 and 13.0 at stimp 13. The number on the menu is
            the green you get.
          </li>
          <li>
            <strong>Stimp is worth more than a few feet.</strong> A putt hit to roll 20 feet at stimp 11 rolls 15 at
            stimp 8 and 23 at stimp 13.
          </li>
          <li>
            <strong>Slopes count for about two-thirds.</strong> GSPro applies about 68% of real gravity along a
            slope. A 10-foot putt hit for flat runs 14 feet down a 2% slope and dies at 8 feet up one.
          </li>
          <li>
            <strong>Some putts never stop.</strong> Past a certain downhill grade the ball can&rsquo;t stop: about
            7.5% at stimp 8, 4.7% at stimp 11 and 3.6% at stimp 13. At stimp 13 on a 4.5% slope, every putt I hit
            from 2 to 7 mph ran about 75 feet.
          </li>
        </ul>
        <h3>What to do with it</h3>
        <p>
          Ignore the grass and firmness once you&rsquo;re on the green. Learn your pace at stimp 11, then take about
          a quarter off at stimp 8 and add a sixth at stimp 13. On a fast green with the pin below you, read the
          slope before the line.
        </p>
        <h3>The catch</h3>
        <p>
          These are straight putts. How far a side slope turns the ball is the next thing I&rsquo;m measuring.
        </p>
        <p className="insights-limits">
          Measured in GSPro 4.1.9 from 174 putts at 2 to 8 mph on four practice greens, at stimp 8 to 13, flat and
          on slopes from 1.2% to 4.5%. One formula fits every putt that stopped to within 0.05 feet on average.
        </p>
      </>
    ),
  },
  {
    id: 'chipping',
    number: '05',
    name: 'Chipping',
    colour: '#f97316',
    question: 'Read the fairway before the green',
    caddie: 'Looper reads the grass and both firmnesses from GSPro, and works out a chip’s release from where it will land.',
    article: (
      <>
        <p className="insights-lead">
          Land a chip on a GSPro fairway and the fairway decides how far it goes. I hit 152 chips, from bump and runs
          to flops, across the grass types, firmnesses and stimps. The same chip landing short on a firm fairway ran
          about half again as far as on a soft one.
        </p>
        <h3>How I think about it now</h3>
        <ul>
          <li>
            <strong>A chip is a putt with a bounce.</strong> Almost all of its release is roll, and once it&rsquo;s
            rolling on the green it follows the same rules as a putt (part 04). That&rsquo;s why stimp hits chips
            hard: going from stimp 8 to 13 added about 45% to short chips that landed on the green.
          </li>
          <li>
            <strong>Land short and the fairway takes over.</strong> A firm fairway added about 50% over a soft one. A
            Links fairway added 30&ndash;50% over Bermuda. Bentgrass ran a little less than Bermuda.
          </li>
          <li>
            <strong>The green&rsquo;s firmness matters less.</strong> Soft to firm on the green added a fifth to a
            quarter, more for a flop, and nothing at all to a chip that stopped short of the green.
          </li>
          <li>
            <strong>Rough barely matters.</strong> GSPro took about a third of the spin off chips from the rough,
            and they released only 5&ndash;10% further. A chip doesn&rsquo;t have much spin to lose.
          </li>
          <li>
            <strong>Longer pitches stop.</strong> Spin grows with the swing. A pitch that carried 5 yards released
            1.3 times its carry. At 30 and 40 yards it released about 7 yards either way.
          </li>
        </ul>
        <h3>What to do with it</h3>
        <p>
          Before a chip, check where it lands, not just the green. Landing on a firm fairway or on Links, fly it
          shorter than you think. Landing on the green, check the stimp. From the rough, play it like the fairway.
        </p>
        <h3>The catch</h3>
        <p>
          Chip spin is where launch monitors disagree the most. I used typical numbers, about 2,000 rpm for a
          10-yard chip. If yours reads less spin, your chips will run further than mine.
        </p>
        <p className="insights-limits">
          Measured in GSPro 4.1.9 from 152 chips at Briarwood West: bump and run (12&deg; launch), chip (20&deg;),
          pitch (28&deg;) and flop (40&deg;), carrying 5 to 40 yards onto a gently uphill green or landing 2 to 8
          yards short of it, at stimp 8, 11 and 13.
        </p>
      </>
    ),
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
        <h3>What to do with it</h3>
        <p>
          In deep rough, take the club that launches highest and still gets there, not one more than normal: the
          longer club usually buys nothing. In the rough, plan for the ball to release. On a side slope, aim off
          before you worry about the distance.
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
