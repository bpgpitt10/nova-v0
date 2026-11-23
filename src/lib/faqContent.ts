/**
 * The FAQ, as data. Add a question by adding an item; add a topic by adding a
 * section. Answers are short paragraphs; `steps` renders a numbered list and
 * `table` a two-column table under the answer.
 */
export type FaqItem = Readonly<{
  q: string
  a: readonly string[]
  steps?: readonly string[]
  table?: Readonly<{ head: readonly [string, string]; rows: readonly (readonly [string, string])[] }>
  link?: Readonly<{ href: string; label: string }>
}>

export type FaqSection = Readonly<{ id: string; title: string; note?: string; items: readonly FaqItem[] }>

export type StartStep = Readonly<{
  title: string
  /** When in the player's first weeks this step belongs. */
  when: string
  body: readonly string[]
  link?: Readonly<{ href: string; label: string }>
}>

export type WhatsNewItem = Readonly<{
  title: string
  body: string
  /** What the player needs for it, when it isn't just the site: "Companion 1.2.1". */
  needs?: string
  link?: Readonly<{ href: string; label: string }>
}>

/**
 * The latest enhancements, first thing on the FAQ (Brian, 23 Nov). The companion's update box
 * links here, so this is where "what else changed" lives. Newest first; keep it to about six,
 * dropping the oldest as new ones go in, and move the date.
 */
export const WHATS_NEW: Readonly<{ updated: string; items: readonly WhatsNewItem[] }> = {
  updated: 'November 23, 2026',
  items: [
    {
      title: 'Talk to your caddie',
      body: 'Say “Looper, three wood” and the club is armed and GSPro is aimed for you. Around the green say “Looper, pitch” or “arm the flop”; on a part wedge say “standard”, “flighted”, “runner” or “high”. “Looper, retry” aims again.',
      needs: 'Companion 1.2.1',
      link: { href: '#voice', label: 'Everything you can say' },
    },
    {
      title: 'Wedge Lab: 40 yards to your shortest club',
      body: 'The awkward distance now has its own card. Four ways to play it (Runner, Flighted, Standard, High), each with how far to fly it and how far it runs on today’s greens. Looper picks one and says why the others are not needed or should be avoided.',
    },
    {
      title: 'Chipping Lab: inside 40 yards',
      body: 'Bump and run, chip, pitch and flop, each sized to finish at the hole. The card leads with the carry to fly it, reads the slope from where the ball lands, and when nothing stops at the hole it shows the shot that finishes nearest.',
    },
    {
      title: 'Auto Aim on more courses',
      body: 'Auto Aim finds your ball and the pin by where they sit on GSPro’s minimap, not by exact colors, so it works on dull or shaded courses where it used to say aim by hand.',
      needs: 'Companion 1.2.1',
    },
    {
      title: 'Trees on a wedge',
      body: 'Each wedge flight is checked against the trees Looper has on its map. One that would fly into them is marked Avoid and a higher flight takes its place. In the trees, the card says so and leaves the line out to you.',
    },
    {
      title: 'A two-minute tour',
      body: 'Five cards on what Looper does and how it learns your game.',
      link: { href: '/tour', label: 'Take the tour' },
    },
  ],
}

/**
 * The path a new player follows, shown open at the top of the FAQ (Brian,
 * 18 Nov: "this is how you get going"). Assumes they have signed in.
 */
export const GETTING_STARTED: readonly StartStep[] = [
  {
    title: 'Check you are connected',
    when: 'First',
    body: [
      'On the PC that runs GSPro, open thelooper.golf in Chrome or Edge. Two things should be true: the Companion chip at the top right is green, and the home page says GSPro connected.',
      'If the chip says Get the companion, click it and run the installer. It takes a minute and you only do it once.',
    ],
    link: { href: '/looper', label: 'Home page' },
  },
  {
    title: 'Try Live Caddie with your starting bag',
    when: 'Today',
    body: [
      'You do not need any practice data first. Your starting bag (three carries and your handicap) is enough for Looper to caddie a round.',
      'Pick a course that is already loaded, match the tees and pins to GSPro, and play a few holes. Looper follows each shot and tells you the club and the line. This is the quickest way to get a feel for it.',
    ],
    link: { href: '/round-setup', label: 'Start a Round' },
  },
  {
    title: 'Build your real numbers on the range',
    when: 'This week',
    body: [
      'Open the Practice Range in GSPro and choose Practice Range on the Looper home page. Every swing is captured: carry, total, spin, and how the ball moves.',
      'This is the foundation of The Looper. Each club replaces its starting guess with your own numbers after about five good swings, and the caddie gets sharper with every session.',
    ],
    link: { href: '/bag', label: 'Your bag' },
  },
  {
    title: 'Look back at your rounds',
    when: 'After each round',
    body: [
      'Every round you play in GSPro is recorded while the Companion is running, whether Live Caddie was on or not.',
      'The Rounds page shows the score, strokes gained by part of the game, a map of each hole, and your best and worst shots.',
    ],
    link: { href: '/rounds', label: 'Rounds' },
  },
  {
    title: 'Find where you lose strokes',
    when: 'After a few rounds',
    body: [
      'Your game adds your rounds together and ranks what costs you the most: tee shots, each approach distance, the rough, the sand and putting.',
      'The Putting page goes further and splits your putting into read, start line and pace. Play with auto putt off so your own putts count.',
    ],
    link: { href: '/game', label: 'Your game' },
  },
]

export const FAQ_SECTIONS: readonly FaqSection[] = [
  {
    id: 'start',
    title: 'The basics',
    items: [
      {
        q: 'What is The Looper?',
        a: [
          'A caddie for GSPro. It sits beside GSPro, follows your round, and tells you which club to hit and where to aim.',
          'The advice is built from your own shots, so it knows how far and how straight you really hit each club.',
        ],
      },
      {
        q: 'What do I need?',
        a: ['Three things, all on the PC that runs GSPro:'],
        steps: [
          'GSPro (the regular release).',
          'Chrome or Microsoft Edge, with thelooper.golf open.',
          'The Looper Companion, a small free Windows app.',
        ],
      },
      {
        q: 'Can I use it on a Mac, phone or tablet?',
        a: [
          'You can sign in anywhere to look at your bag and past rounds.',
          'Live Caddie has to run on the GSPro PC, because that is where the round is happening.',
        ],
      },
      {
        q: 'Does it work with the GSPro beta?',
        a: ['Not yet. The beta stores shots differently, so Live Caddie only follows the regular GSPro release for now.'],
      },
    ],
  },
  {
    id: 'companion',
    title: 'The Looper Companion',
    items: [
      {
        q: 'What is the Companion and why do I need it?',
        a: [
          'A small Windows app that lets this site see your GSPro round and set the aim in GSPro for you.',
          'It runs quietly in the background and starts with Windows. It only talks to thelooper.golf.',
        ],
      },
      {
        q: 'How do I install it?',
        a: ['On the GSPro PC:'],
        steps: [
          'Download LooperCompanionSetup.exe from the Looper home page and run it.',
          'If your browser asks, choose Keep.',
          'If Windows shows a blue “Windows protected your PC” box, click More info, then Run anyway.',
          'When the browser asks to allow local network access for thelooper.golf, click Allow.',
        ],
      },
      {
        q: 'Why does Windows warn me about it?',
        a: ['The Companion is new and not yet signed with a paid Microsoft certificate, so Windows shows its standard warning for unfamiliar apps. More info, then Run anyway, installs it.'],
      },
      {
        q: 'How do I know it is working?',
        a: ['Look for the green dot and version number in the upper right of the site. No green dot means the Companion is not running or the browser was not allowed to reach it.'],
      },
      {
        q: 'Does Looper upload my GSPro course files?',
        a: ['No. GSPro course files stay on your PC and are never uploaded.'],
      },
    ],
  },
  {
    id: 'live',
    title: 'Live Caddie',
    items: [
      {
        q: 'How do I start a round?',
        a: ['Open the course in GSPro, then on the site choose Start a Round, pick the same course and tees, and press Start Round. Live Caddie follows along from the first tee.'],
        link: { href: '/round-setup', label: 'Start a Round' },
      },
      {
        q: 'What does arming a club do?',
        a: [
          'Arming tells Looper which club you are about to hit. With the Companion running, Looper then moves the aim in GSPro to the line shown on the map.',
          'Press Clear to disarm.',
        ],
      },
      {
        q: 'What are the Aim line buttons on the map?',
        a: ['Three lines for the club you are looking at. Tap one to see its numbers and aim there; tap Best to go back to Looper’s line.'],
        table: {
          head: ['Button', 'What it is'],
          rows: [
            ['Best', 'The line with the lowest expected score.'],
            ['2nd best', 'The next-best line that is at least 6 yards away from Best.'],
            ['Safest', 'The line with the least water and out of bounds, then the least serious trouble. Shown only when it is clearly safer than Best.'],
          ],
        },
      },
      {
        q: 'Live Caddie is not following my round. What do I do?',
        a: [
          'Refresh the page first. If it still sits on the wrong hole, press Start Round again for the course you are playing.',
          'If it keeps happening, open Details on the Live Caddie page and send us a screenshot.',
        ],
      },
    ],
  },
  {
    id: 'voice',
    title: 'Voice commands',
    note: 'Experimental. Turn on Voice at the top of Live Caddie, then say a wake word followed by a command. You can also say the wake word, pause, and give the command within five seconds.',
    items: [
      {
        q: 'What are the wake words?',
        a: ['Every command starts with one of these. They all do the same thing.'],
        table: { head: ['Say', 'Also works'], rows: [['Looper', 'Caddie']] },
      },
      {
        q: 'What can I say?',
        a: ['The first column is the plain way to say it. The second shows other wordings that do the same thing. Small words like “give me the” or “please” are ignored.'],
        table: {
          head: ['Say', 'Also works'],
          rows: [
            ['Looper, three wood', 'arm three wood · give me the three wood · switch to three wood. Any club in your bag; also pitching wedge, sand wedge, lob wedge, gap wedge.'],
            ['Looper, arm it', 'arm that · lock it in · send it. Arms the club and line on screen.'],
            ['Looper, your call', 'your pick · the play. Arms Looper\u2019s recommended club.'],
            ['Looper, clear', 'cancel · disarm · never mind · stop'],
            ['Looper, retry', 'try again · aim again. Aims GSPro again for what is on screen.'],
            ['Looper, pitch', 'bump and run · chip · flop · show me the pitch shot. Inside 40 yards: shows that chip. “Arm the pitch” aims it.'],
            ['Looper, standard', 'runner · flighted · high · the stock shot. From 40 yards to your shortest club: shows that wedge flight. “Arm the standard” aims it. Needs Companion 1.2.1.'],
            ['Looper, arm second best', 'arm best · arm safest · arm the safe line. Arms that aim line for the club on screen.'],
            ['Looper, second best', 'best · safest · safe line. Shows that line without arming it.'],
            ['Looper, aim left five', 'five left · left five yards · move it left five. Moves from the current line, to the nearest line Looper has numbers for.'],
            ['Looper, a little right', 'right · aim right. Moves 3 yards.'],
            ['Looper, reset aim', 'center it · aim center. Back to Looper\u2019s line.'],
            ['Looper, club up', 'more club · one more club · up a club'],
            ['Looper, club down', 'less club · down a club'],
            ['Looper, refresh wind', 'update wind · new wind · fix the wind · check the wind'],
            ['Looper, details', 'show details · hide details'],
          ],
        },
      },
      {
        q: 'Which GSPro screens can I open by voice?',
        a: ['GSPro has to be the window in front. These press GSPro\u2019s own hotkeys.'],
        table: {
          head: ['Say', 'Also works'],
          rows: [
            ['Looper, flyover', 'overview · hole overview'],
            ['Looper, end flyover', 'cancel · stop · kill · escape · skip flyover'],
            ['Looper, scorecard', 'card · score'],
            ['Looper, green grid', 'grid'],
            ['Looper, heat map', ''],
            ['Looper, shot cam', 'shot camera'],
            ['Looper, pin', 'flag · pin indicator'],
            ['Looper, putt mode', 'putting mode'],
            ['Looper, hide', 'hide screen'],
            ['Looper, mulligan', 'Then say “Looper, confirm” (or yes · do it).'],
          ],
        },
      },
      {
        q: 'It did not hear me, or heard the wrong thing.',
        a: [
          'The Voice button flashes red when it heard a wake word but could not make out a command. Open Details to see what it heard.',
          'It only listens for clubs that are in your bag, so a club you do not carry will never be picked.',
        ],
      },
    ],
  },
  {
    id: 'putting',
    title: 'Putting',
    items: [
      {
        q: 'Which putts does the Putting page count?',
        a: [
          'Putts of 5 ft and longer that you stroked yourself. Gimmes are left out, and so are rounds played with auto putt on.',
          'Sim gimme circles are usually 5 or 6 ft, so there is nothing to study inside that.',
        ],
        link: { href: '/game/putting', label: 'Putting' },
      },
      {
        q: 'What are Read, Pace and Line?',
        a: ['Every putt is split into three skills.'],
        table: {
          head: ['Skill', 'What it means'],
          rows: [
            ['Read', 'Where you placed your aim. Did you play the right amount of break?'],
            ['Line', 'Whether the ball started where you aimed, from the launch monitor\u2019s start direction.'],
            ['Pace', 'Distance. Right pace would finish about 1 ft past the hole.'],
          ],
        },
      },
      {
        q: 'How does it decide what a miss cost?',
        a: [
          'Each missed putt is replayed with one thing put right: the read, the pace, or the start line. Each skill is credited with the strokes its fix would have saved, and the three add up to your strokes gained putting against the tour benchmark.',
          'Each skill also shows a typical miss and a lean: which way it goes, when it clearly goes one way. Averages are not used, because a putt left short and a putt run past would cancel out and look fine.',
        ],
      },
      {
        q: 'Why does it say the numbers are early?',
        a: [
          'Read is judged at the right pace, about a foot past the hole. A putt hit too hard breaks less and one left short breaks more, so that part of a miss counts as Pace, not Read. This needs your aim and the roll of the ball, which Looper records from 18 November on; older putts use where the ball finished, with the start-line error taken out. Break size (minor, medium, big) arrives once enough putts carry them.',
          'A round has only 20 to 30 real putts, so numbers from one or two rounds move a lot.',
        ],
      },
      {
        q: 'What do holed, left a gimme and missed mean?',
        a: ['Holed went in. Left a gimme missed, but finished close enough that the next putt was given. Missed left another putt you had to hit.'],
      },
    ],
  },
  {
    id: 'courses',
    title: 'Courses',
    items: [
      {
        q: 'My course is not in the list.',
        a: ['Ask for it on the Load a course page, and it is added to the list once it has loaded.'],
        link: { href: '/courses', label: 'Load a course' },
      },
    ],
  },
  {
    id: 'account',
    title: 'Account',
    items: [
      {
        q: 'I never got the email to confirm my account.',
        a: ['Check your spam folder, then use Resend on the “Check your email” screen. If it still does not arrive, get in touch and we will turn the account on for you.'],
      },
    ],
  },
]
