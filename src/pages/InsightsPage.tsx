import { useEffect, type CSSProperties, type ReactNode } from 'react'
import looperLogo from '../assets/LooperLogo.webp'
import fairwaysCard from '../assets/insights/insight-01-fairways.webp'
import liesCard from '../assets/insights/insight-02-lies.webp'
import slopesCard from '../assets/insights/insight-03-slopes.webp'
import approachesCard from '../assets/insights/insight-04-approaches.webp'
import chippingCard from '../assets/insights/insight-05-chipping.webp'
import puttingCard from '../assets/insights/insight-06-putting.webp'
import InsightsMethod, { METHOD_HREF } from './InsightsMethod'
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
  /** Made by tools/insights_cards/cards.py; width and height are the image's own. */
  card?: { src: string; alt: string; width: number; height: number }
  article?: ReactNode
  /** One line on what an unwritten part will cover. */
  coming?: string
  caddie?: string
}>

const PARTS: readonly Part[] = [
  {
    id: 'fairways',
    number: '01',
    name: 'Fairways',
    colour: '#76d39b',
    question: 'Same drive, 5 to 36 yards of roll',
    card: {
      src: fairwaysCard,
      alt: 'Roll in yards for a driver, 3 hybrid, 7 iron and pitching wedge on Bentgrass, Bermuda and Links fairways at soft, medium and firm, each compared with Bermuda soft, where the GSPro range starts.',
      width: 1600,
      height: 1726,
    },
    caddie: 'Looper reads the course type and fairway firmness from GSPro and adds the roll for the course you\u2019re on, not the range.',
    article: (
      <>
        <p className="insights-lead">
          On a GSPro fairway, the course settings decide how far your ball rolls. My stock drive rolled 5 yards on a
          soft Bentgrass fairway and 36 on a firm Links one. The carry was the same every time. Only what happened
          after it landed changed.
        </p>
        <h3>How I think about it now</h3>
        <ul>
          <li>
            <strong>Your range is one setting, and you can change it.</strong> GSPro&rsquo;s range can be set to any
            grass and fairway firmness, and it starts on Bermuda soft. On a level course fairway set the same way, the
            ball rolled what the range showed, within about a yard. From that default, my drive rolls about 14 yards.
            On firm Links it rolls 36, and on soft Bentgrass 5.
          </li>
          <li>
            <strong>Grass type first, again.</strong> Bentgrass to Links at the same firmness added 20 yards of roll to
            the drive. Soft to firm on Bermuda added 14.
          </li>
          <li>
            <strong>Bentgrass stops irons.</strong> On a Bentgrass course a 7 iron rolled about 3 yards whether the
            fairway was soft or firm. The driver still went from 5 to 17.
          </li>
          <li>
            <strong>It isn&rsquo;t a flat percentage.</strong> Firm Links gave a driver 2.6 times the roll of Bermuda
            soft, and a pitching wedge 3.5 times. Short clubs change by the bigger multiple, long clubs by more
            yards.
          </li>
        </ul>
        <h3>What to do with it</h3>
        <p>
          Set the range to the course you&rsquo;re about to play before you warm up. If you don&rsquo;t, work from
          Bermuda soft: on Links a drive rolls 10 to 22 yards more, on firmer Bermuda 6 to 14 more, and on soft or
          medium Bentgrass 4 to 9 less. Laying up to a firm fairway, leave room for the ball to run.
        </p>
        <h3>The catch</h3>
        <p>
          All of this is on level ground. Slopes move roll more than any setting here: one drive picked up 46 extra
          yards running down a long slope, and an upslope took 6 off another. And the rough stops most of it (part
          02).
        </p>
        <p className="insights-limits">
          Measured in GSPro 4.1.9: each club&rsquo;s stock shot fired onto the range at all nine course type and
          fairway firmness settings, then checked against shots landing on course fairways. <a href={METHOD_HREF}>How I tested</a>
        </p>
      </>
    ),
  },
  {
    id: 'lies',
    number: '02',
    name: 'Lies',
    colour: '#c9a46a',
    question: 'Your bag stops working in deep rough',
    card: {
      src: liesCard,
      alt: 'Range of ball speed and spin GSPro leaves after each lie, deep rough speed by launch angle, and carries out of deep rough for a 3 hybrid, 5 iron, 7 iron and wedges against their clean carries.',
      width: 1600,
      height: 1630,
    },
    caddie: 'Looper reads the lie from GSPro before every shot, and works out each club from there, not from your fairway numbers.',
    article: (
      <>
        <p className="insights-lead">
          From the fairway, more club means more distance. From GSPro&rsquo;s deep rough it&rsquo;s the other way
          round. Out of deep rough a 7 iron carried about 93 yards, a 5 iron about 80 and a 3 hybrid about 70, from
          clean carries of about 159, 179 and 200.
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
            <strong>Rough is a flyer, not a penalty.</strong> It costs 3 to 7% of speed but 20 to 30% of the spin,
            depending on the shot. A 5 iron from the rough carried 12 yards less than from the fairway and finished 2 yards further,
            because it ran out.
          </li>
          <li>
            <strong>Sand is gentler than you think on full swings.</strong> It takes about 7% of ball speed from a full
            iron and leaves the spin alone. Slower swings lose more of both.
          </li>
          <li>
            <strong>The first cut barely counts.</strong> About 1% of speed and 5% of spin.
          </li>
          <li>
            <strong>The cart path is free</strong>, unless you hit a driver-type shot off it, which loses about a
            quarter of its speed.
          </li>
        </ul>
        <h3>What to do with it</h3>
        <p>
          In deep rough, take the club that launches highest and still gets there, not one more than normal: the
          longer club usually buys nothing. In the rough, plan for the ball to release. The slope under the ball is
          part 03.
        </p>
        <p className="insights-limits">
          Measured in GSPro 4.1.9 from rough, deep rough, sand, first cut and cart path lies on four courses. <a href={METHOD_HREF}>How I tested</a>
        </p>
      </>
    ),
  },
  {
    id: 'slopes',
    number: '03',
    name: 'Slopes',
    colour: '#8bb8ff',
    question: 'Side slopes hit your long clubs hardest',
    card: {
      src: slopesCard,
      alt: 'Yards offline from a 2 to 8 degree side slope for a 3 hybrid, 5 iron, 7 iron and wedges, and the share of a side or up-and-down slope GSPro turns into start line and launch for each club.',
      width: 1600,
      height: 1676,
    },
    caddie: 'Looper reads the slope under the ball from GSPro and turns it into a new launch and start line before it picks the club and the aim.',
    article: (
      <>
        <p className="insights-lead">
          A slope under the ball changes the shot before it leaves the ground, and in GSPro it hurts your longest
          clubs most. On a 4&deg; side slope, a 3 hybrid starts about 13 yards offline. A pitching wedge, about 5.
        </p>
        <h3>How I think about it now</h3>
        <ul>
          <li>
            <strong>GSPro tilts the launch, not your swing.</strong> Up or down the slope moves the launch angle.
            Across it moves the start line, toward the side GSPro&rsquo;s lie readout names. Nothing looks different
            at address. It only shows in the flight.
          </li>
          <li>
            <strong>Low launch feels it most.</strong> A 3 hybrid takes about nine-tenths of a side slope as start
            line, a 7 iron about three-quarters, a sand wedge about half. Hybrids and fairway woods launch lowest, so
            they feel it most. In real golf it runs the other way, because loft points the face off line. Don&rsquo;t
            bring that instinct to GSPro.
          </li>
          <li>
            <strong>Side slope is the one that costs you.</strong> About 3 yards offline per degree with a hybrid or
            wood, 2 with a 7 iron, 1 with a wedge.
          </li>
          <li>
            <strong>Up and down barely move your irons.</strong> Their carry changes by a few yards at most. Hybrids
            and woods are different off a downslope: 4&deg; took about 7 yards off a 3 hybrid and 8&deg; about 26, because
            a low launch has little to lose.
          </li>
        </ul>
        <h3>What to do with it</h3>
        <p>
          Check the side slope before every full shot and aim off first: about 3 yards per degree with a hybrid or
          wood, 2 with a mid iron, 1 with a wedge. Off a downslope, think twice about the hybrid. A more lofted club
          keeps its launch.
        </p>
        <h3>The catch</h3>
        <p>
          This is the slope under the ball. Where it lands is a separate question: an upslope where the ball comes
          down kills its roll, and a downslope adds to it (part 01).
        </p>
        <p className="insights-limits">
          Measured in GSPro 4.1.9: launch angle and start line from shots fired off sloped lies on several courses,
          read against GSPro&rsquo;s own lie readout. Carries for those launches from Looper&rsquo;s flight model.{' '}
          <a href={METHOD_HREF}>How I tested</a>
        </p>
      </>
    ),
  },
  {
    id: 'approaches',
    number: '04',
    name: 'Approaches',
    colour: '#eab308',
    question: 'Read the grass before the firmness',
    card: {
      src: approachesCard,
      alt: 'Release in yards for a wedge, 9 iron, 7 iron and 5 iron on Bentgrass, Bermuda and Links greens at soft, medium and firm, each compared with Bermuda soft, at stimp 11.',
      width: 1600,
      height: 1726,
    },
    caddie: 'Looper reads the grass type and firmness from GSPro, takes the stimp you set at the start of a round, and adds the release to every club it recommends.',
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
          <li>
            <strong>Stimp barely matters here.</strong> Going from stimp 8 to stimp 13 moved a full pitching wedge a
            tenth of a yard. Stimp only changes the roll after the bounce, and a full approach has little roll left.
            A low-spinning 9 iron felt it most: 5.3 yards of release at stimp 8, 7.1 at stimp 13.
          </li>
        </ul>
        <h3>What to do with it</h3>
        <p>
          On Bentgrass, fly it to the number. On Bermuda, take a few yards off mid irons and more off long irons. On
          Links, land anything longer than a 9 iron well short and let it run. And leave your range total at the
          range: it includes fairway roll a green won&rsquo;t give you.
        </p>
        <h3>The catch</h3>
        <p>
          Spin changes all of this. A 7 iron that loses 30% of its spin, which is what rough does, releases like a 5
          iron. So the same shot from the rough needs a different number again.
        </p>
        <p className="insights-limits">
          Measured in GSPro 4.1.9 on level greens at stimp 11, with stimp checked at 8, 11 and 13. Slopes are part 03. <a href={METHOD_HREF}>How I tested</a>
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
    card: {
      src: chippingCard,
      alt: 'Yards a bump and run, chip, pitch and flop run after landing on the green by grass and by stimp, and after landing short in the fairway by firmness and by grass.',
      width: 1600,
      height: 1964,
    },
    caddie: 'Looper reads the grass and both firmnesses from GSPro, and works out a chip’s release from where it will land.',
    article: (
      <>
        <p className="insights-lead">
          Land a chip on a GSPro fairway and the fairway decides how far it goes. I hit bump and runs, chips,
          pitches and flops across every grass type, firmness and stimp. The same chip landing short on a firm fairway ran
          about half again as far as on a soft one.
        </p>
        <h3>How I think about it now</h3>
        <ul>
          <li>
            <strong>A chip is a putt with a bounce.</strong> Almost all of its release is roll, and once it&rsquo;s
            rolling on the green it follows the same rules as a putt (part 06). That&rsquo;s why stimp hits chips
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
          Measured in GSPro 4.1.9 at Briarwood West: bump and run (12&deg; launch), chip (20&deg;),
          pitch (28&deg;) and flop (40&deg;), carrying 5 to 40 yards onto a gently uphill green or landing 2 to 8
          yards short of it, at stimp 8, 11 and 13. <a href={METHOD_HREF}>How I tested</a>
        </p>
      </>
    ),
  },
  {
    id: 'putting',
    number: '06',
    name: 'Putting',
    colour: '#2ec4e6',
    question: 'Only two settings move a putt',
    card: {
      src: puttingCard,
      alt: 'Feet a putt rolls at stimp 8, 11 and 13, on uphill and downhill slopes, the steepest downhill a putt can stop on at each stimp, and that grass and firmness change nothing.',
      width: 1600,
      height: 1664,
    },
    caddie: 'Looper’s putting review splits every putt you hit into read, line and pace, and shows which one is costing you strokes.',
    article: (
      <>
        <p className="insights-lead">
          On a GSPro green, the grass type and firmness don&rsquo;t change a putt at all. I rolled the same putts at
          every stimp from 8 to 13, flat, uphill and downhill. On five different grass and firmness settings, the same putt finished
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
            7.5% at stimp 8, 4.7% at stimp 11 and 3.6% at stimp 13. At stimp 13 on a 4.5% slope, not one putt
            stopped on the slope, at any speed. They rolled on until the green flattened out.
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
          Measured in GSPro 4.1.9 with putts from 2 to 8 mph on four practice greens, at stimp 8 to 13, flat and on
          slopes from 1.2% to 4.5%. One formula fits every putt that stopped to within 0.05 feet on average. <a href={METHOD_HREF}>How I tested</a>
        </p>
      </>
    ),
  },
]

/**
 * The overview's cheat sheet: one rule of thumb per thing you can see before a shot, tee to cup. Rules, not
 * every number: typical launch numbers, Bermuda soft and stimp 11 as the base unless it says otherwise.
 */
const CHEAT_SHEET: readonly { stage: string; see: string; rule: ReactNode; part: string }[] = [
  { stage: 'Before you play', see: 'Your range numbers', rule: <>Trust the carries, not the totals. The range starts on Bermuda soft; set it to the course before you warm up.</>, part: 'fairways' },
  { stage: 'Off the tee', see: 'Fairway grass', rule: <>The biggest roll setting. A drive rolls 10 to 22 yards more on Links than Bermuda soft, 4 to 9 less on soft or medium Bentgrass.</>, part: 'fairways' },
  { stage: 'Off the tee', see: 'Fairway firmness', rule: <>Second. Soft to firm adds about 14 yards to a drive on Bermuda. On Bentgrass, irons stop where they land on any firmness.</>, part: 'fairways' },
  { stage: 'From the lie', see: 'Deep rough', rule: <>Take the club that launches highest and still gets there. A 7 iron carried 93; a 3 hybrid 70.</>, part: 'lies' },
  { stage: 'From the lie', see: 'Rough', rule: <>A flyer: about a dozen yards less carry on a 5 iron, then more run.</>, part: 'lies' },
  { stage: 'From the lie', see: 'Sand, first cut, cart path', rule: <>Barely count on a full swing. Sand takes 7% of the ball speed; the first cut about 1%.</>, part: 'lies' },
  { stage: 'From the lie', see: 'Side slope', rule: <>Aim off toward the side the lie readout names: about 3 yards per degree with a hybrid or wood, 2 with a mid iron, 1 with a wedge.</>, part: 'slopes' },
  { stage: 'From the lie', see: 'Up or down slope', rule: <>Irons: ignore it. A hybrid off a downslope loses about 7 yards at 4&deg;, so take loft.</>, part: 'slopes' },
  { stage: 'Into the green', see: 'Green grass', rule: <>Read it before the firmness. Wedges barely care; a 5 iron releases 6 to 13 yards more on Links than Bermuda soft.</>, part: 'approaches' },
  { stage: 'Into the green', see: 'Green firmness', rule: <>Half the grass effect or less. Firm Bentgrass plays like soft Bermuda.</>, part: 'approaches' },
  { stage: 'Into the green', see: 'Stimp, full shots', rule: <>Ignore it. Stimp 8 to 13 moved a full wedge a tenth of a yard.</>, part: 'approaches' },
  { stage: 'Around the green', see: 'Where the chip lands', rule: <>In the fairway, firm or Links adds about half again. Land it shorter.</>, part: 'chipping' },
  { stage: 'Around the green', see: 'Stimp, chips', rule: <>It counts here: stimp 8 to 13 adds about 45%. Green firmness adds a fifth; rough 5 to 10%.</>, part: 'chipping' },
  { stage: 'On the green', see: 'Stimp, putts', rule: <>Learn your pace at 11. Take a quarter off at 8; add a sixth at 13. Ignore the grass and firmness.</>, part: 'putting' },
  { stage: 'On the green', see: 'Slope, putts', rule: <>Counts about two-thirds. Down 2% turns a 10-foot putt into 14. Past 4.7% at stimp 11, or 3.6% at 13, it won&rsquo;t stop.</>, part: 'putting' },
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
  const onMethod = window.location.pathname.replace(/\/+$/, '') === METHOD_HREF
  useEffect(() => {
    const previous = document.title
    document.title = onMethod ? 'How I tested · GSPro physics, measured · The Looper' : 'GSPro physics, measured · The Looper'
    // A post links to one part (/insights#greens): go to it once the page is drawn.
    const id = decodeURIComponent(window.location.hash.replace(/^#/, ''))
    if (id) window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView())
    return () => {
      document.title = previous
    }
  }, [onMethod])

  return (
    <div className="insights-page" id="top">
      <header className="insights-top">
        <div className="insights-wrap insights-top__row">
          <a className="insights-top__logo" href={onMethod ? '/insights' : '#top'} aria-label={onMethod ? 'The series' : 'Back to the top'}>
            <img src={looperLogo} alt="The Looper" />
          </a>
          <nav className="insights-top__nav" aria-label="Account">
            <a href={SIGN_IN_HREF}>Sign in</a>
            <AccountButton />
          </nav>
        </div>
      </header>

      {onMethod ? <InsightsMethod /> : (
        <>
        <section className="insights-hero">
          <div className="insights-wrap">
            <h1>
              GSPro physics, <em>measured</em>
            </h1>
            <p className="insights-hero__lead">
              A lot of GSPro misses aren&rsquo;t swing misses. They&rsquo;re bad reads. I tested GSPro 4.1.9&rsquo;s
              physics one setting at a time and measured what the ball actually did.{' '}
              <a className="insights-hero__method" href={METHOD_HREF}>How I tested &rarr;</a>
            </p>
          </div>
        </section>

        <InsightsReadQuiz />

        <nav className="insights-tabs" aria-label="Parts of the series">
          <div className="insights-wrap insights-tabs__row">
            <a className="insights-tab is-ready" href="#overview" style={colourVar(OVERVIEW_COLOUR)}>
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

        <section className="insights-part" id="overview" style={colourVar(OVERVIEW_COLOUR)}>
          <div className="insights-wrap">
            <p className="insights-eyebrow">Overview</p>
            <h2>Every shot is a sum</h2>
            <div className="insights-entry__text insights-overview">
              <p className="insights-lead">
                Every part of this series changes one setting at a time. A real shot never does. The ball sits in the
                rough on a side slope, the green is firm Links and the stimp is 12. Each of those is worth a few yards.
                Added up, they decide whether you&rsquo;re putting for birdie or chipping for par.
              </p>
              <h3>How I think about it now</h3>
              <ul>
                <li>
                  <strong>Carry is the only number that travels.</strong> Everything after the ball lands depends on the
                  course: the grass, the firmness, the slope, the stimp.
                </li>
                <li>
                  <strong>Know which settings are big.</strong> Grass type, a bad lie and a side slope move the ball by
                  a club or more. Firmness moves it by yards. Stimp barely touches a full shot, then decides every chip
                  and putt.
                </li>
                <li>
                  <strong>None of it is random.</strong> GSPro does exactly the same thing every time. That&rsquo;s why
                  these rules hold, and why the ones you get wrong cost you the same way every round.
                </li>
              </ul>
              <h3>The cheat sheet</h3>
              <p className="insights-overview__note">
                Rules of thumb, not every number. Typical launch numbers, with Bermuda soft and stimp 11 as the base
                unless it says otherwise.
              </p>
              <div className="insights-cheat" role="table" aria-label="Rules of thumb, tee to cup">
                <div className="insights-cheat__row insights-cheat__head" role="row">
                  <span role="columnheader">When you see</span>
                  <span role="columnheader">Rule of thumb</span>
                  <span role="columnheader">Part</span>
                </div>
                {CHEAT_SHEET.map((row, index) => {
                  const part = PARTS.find((p) => p.id === row.part)
                  const firstOfStage = index === 0 || CHEAT_SHEET[index - 1].stage !== row.stage
                  return (
                    <div key={row.see}>
                      {firstOfStage ? <p className="insights-cheat__stage">{row.stage}</p> : null}
                      <div className="insights-cheat__row" role="row" style={part ? colourVar(part.colour) : undefined}>
                        <strong role="cell">{row.see}</strong>
                        <span role="cell">{row.rule}</span>
                        <a role="cell" href={`#${row.part}`}>{part ? `${part.number} ${part.name}` : ''}</a>
                      </div>
                    </div>
                  )
                })}
              </div>
              <h3>Why it can&rsquo;t be mental math</h3>
              <p>
                The quiz at the top is one shot with seven of these on it. Most people can hold one or two of them in their head
                and guess the rest. Doing the whole sum before every shot, for eighteen holes, is the job I built Looper to do: it
                reads the settings, the lie and the slope from GSPro and runs the sum with your own numbers, not these
                typical ones.
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
                    <img alt={part.card.alt} loading="lazy" src={part.card.src} width={part.card.width} height={part.card.height} />
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
        </>
      )}

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
