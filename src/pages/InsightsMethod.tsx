/**
 * How the series is measured: thelooper.golf/insights/method. Linked from the
 * top of the insights page and from each part's "measured in" line. Written as
 * Brian, first person. No shot counts: GSPro repeats a shot exactly, so the
 * count isn't what makes a result solid.
 */
export const METHOD_HREF = '/insights/method'

export default function InsightsMethod() {
  return (
    <section className="insights-method" id="method">
      <div className="insights-wrap">
        <p className="insights-eyebrow">Method</p>
        <h1>How I test</h1>
        <p className="insights-hero__lead">
          Every number in this series comes from GSPro itself. I don&rsquo;t swing at it. I send it a shot, change one
          setting, and send the exact same shot again.
        </p>

        <div className="insights-method__body">
          <h2>GSPro gives the same answer every time</h2>
          <p>
            Send GSPro the same ball speed, launch angle, spin and direction twice and the ball lands, bounces and stops
            in the same place, to a hundredth of a yard. There&rsquo;s no gust, no bad bounce and no swing to go wrong.
          </p>
          <p>
            That changes what a test needs. Outdoors you hit hundreds of balls to average out the swing, the wind and
            the turf. In GSPro there&rsquo;s nothing to average: a hundred copies of the same shot are one shot. So
            instead of hitting a lot, I choose each shot on purpose, and I don&rsquo;t count them. The count isn&rsquo;t
            what makes a result solid. The design is.
          </p>

          <h2>Shots without a swing</h2>
          <p>
            The Looper&rsquo;s shot tool sends launch numbers straight into GSPro, the way a launch monitor does, from a
            spot I pick on the course. With no swing there are no mishits. The only thing that changes between two shots
            is the thing I changed.
          </p>

          <h2>One thing at a time</h2>
          <p>
            Same spot, same shot, one setting changed: the grass type, the green or fairway firmness, the stimp, or the
            lie. Then the same shot again. Any difference is that setting.
          </p>
          <p>
            Some settings work together. Firmness matters more to a low-spinning shot than to a wedge, and stimp matters
            more to a slow ball than a fast one. So each setting is tested with several shots that come in differently:
            high and low spin, steep and shallow, fast and slow.
          </p>

          <h2>Where the numbers come from</h2>
          <p>
            GSPro records what happened. Where the ball landed and where it stopped. How fast and how steeply it came
            in, and the spin it landed with. The surface it touched, the course settings in force, and the rise and fall
            of the ground it rolled over. I read all of that from GSPro&rsquo;s own files, not from screenshots or by
            eye.
          </p>
          <p>
            Every run is checked before it&rsquo;s used. If GSPro&rsquo;s log shows a different setting from the one I
            meant to test, or a straight shot curving because the wind was on, that run is left out.
          </p>

          <h2>Realistic shots</h2>
          <p>
            The launch numbers are typical launch monitor numbers for each club, and each card shows the spin I used.
            Chips use typical short-game numbers: about 2,000 rpm for a 10-yard chip, rising as the swing gets longer.
            Your own numbers will differ, and so will your ball. That&rsquo;s the point of the live caddie.
          </p>

          <h2>From shots to a rule</h2>
          <p>
            A table of results only covers the shots I hit. So I fit a simple formula to what GSPro did, then check it
            on shots that weren&rsquo;t used to build it.
          </p>
          <ul>
            <li>
              <strong>Putting:</strong> one formula, using only the stimp and the slope, lands every putt that stopped
              within 0.05 feet on average, flat, uphill and downhill.
            </li>
            <li>
              <strong>Stimp on approaches:</strong> from a shot at stimp 11, the formula puts the same shot at stimp 8
              and 13 within a tenth of a yard on average.
            </li>
            <li>
              <strong>Chipping:</strong> chips from the rough, and chips landing short in the fairway, weren&rsquo;t
              used to build the chip formula. It still lands them within about half a yard and a yard.
            </li>
          </ul>
          <p>When a formula doesn&rsquo;t hold, I say so and go back to the sim.</p>

          <h2>The limits</h2>
          <ul>
            <li>
              Everything was measured in <strong>GSPro 4.1.9</strong>. A GSPro update can change the physics.
            </li>
            <li>
              Most of it was measured on a handful of courses, mostly Briarwood West. Slopes are the slopes where the ball
              actually rolled.
            </li>
            <li>
              Launch monitors don&rsquo;t all read spin the same way, chips most of all. If yours reads differently,
              GSPro will fly and roll your ball differently too.
            </li>
          </ul>
        </div>

        <p className="insights-method__back">
          <a href="/insights">Back to the series</a>
        </p>
      </div>
    </section>
  )
}
