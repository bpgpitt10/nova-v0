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

export const FAQ_SECTIONS: readonly FaqSection[] = [
  {
    id: 'start',
    title: 'Getting started',
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
        link: { href: '/rounds/putting', label: 'Putting' },
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
          'For now, Read is worked out from where the ball finished, with the start-line error taken out. It becomes exact once enough putts carry your aim and roll path, which Looper records from here on. Break size (minor, medium, big) arrives at the same point.',
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
