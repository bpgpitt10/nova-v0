# Club Detail Spec (Overview Only)

This page explains why a club is strong or weak.

It is more data-heavy than Dashboard, but it is still a product surface, not a raw debug page.

This page should answer:
1. Why is this club scoring the way it is?
2. What is the miss pattern?
3. How are carry, direction, launch, and spin behaving?
4. What is changing over time?

---

## Page Role

Dashboard = broad trust view  
Club Detail = single-club explanation view

This page should feel:
- focused
- premium
- dark green golf-native
- explanation-first
- visual
- richer in metrics than Dashboard

---

## Shared App Shell

Club Detail uses the same app shell as Dashboard.

Required:
- persistent left rail
- product name / brand area
- page navigation
- club list in bag order
- active club highlighted in the left rail
- same premium green environment and page background

Do not invent a different shell for Club Detail.

---

## Layout Order

1. Page header / controls row
2. Club summary + main visual row
3. Key numbers / comparison side panel
4. Trends row
5. Insights row

---

## 1. Page Header / Controls Row

Required:
- club name in headline form
- lightweight top controls if needed
- keep this cleaner than the main content

Allowed examples later:
- compare to baseline
- shot range selector

Do not overbuild controls in v1.

---

## 2. Club Summary + Main Visual Row

This is the dominant section of the page.

### Left summary block
Required:
- club name
- Score
- Call
- short narrative summary
- supporting delta line if useful

Rules:
- Score remains white and visually dominant
- Call uses semantic pill styling
- narrative should sound like The Looper, not a stats report

### Center main visual
Primary visual:
- dispersion plot / heatmap style view

Axes:
- x = offline distance
- y = carry distance

Purpose:
- show miss shape and carry window together
- this is the dominant visual on the page

Rules:
- make it large and integrated
- do not make it a tiny support widget

### Right side panel
Required:
- Score over time / confidence over time chart
- key numbers block
- baseline comparison block if practical

This right side is a dense supporting analysis zone.

---

## 3. Key Numbers / Comparison Panel

This page should be more data-heavy than Dashboard.

Required key metrics:
- carry average
- total distance average
- offline average
- offline standard deviation / dispersion
- vertical launch angle average
- total spin average
- descent angle average if available
- shot rank summary

If available from persisted OpenGolfCoach or raw shot data, also support:
- launch / VLA trend context
- spin trend context
- bias / direction context

Use the fullest available stored data.

Formatting:
- no long decimals
- use existing formatting rules

---

## 4. Trends Row

This page should include more trend detail than Dashboard.

Minimum required trends:
- carry trend over time
- offline / dispersion trend over time
- bias trend over time
- vertical launch angle trend over time
- total spin trend over time

Optional if supported cleanly:
- descent angle trend
- score trend over time

Rules:
- simple, readable trend cards
- do not overbuild chart controls yet
- trends should support diagnosis, not overwhelm the page

---

## 5. Insights Row

Show 2–3 concise club-specific insights.

Tone:
- direct
- useful
- slightly cheeky if appropriate
- not robotic

Good insights should connect:
- score / call
- dispersion
- carry
- launch / spin behavior
- trend movement

---

## Data Rules

Use:
- all historical saved-session shots for the selected club
- full shot.openGolfCoach payload
- existing Score/Call engine unchanged
- raw persisted Nova fields where useful

Handle older sessions gracefully if some fields are missing.

This page should use the fullest available persisted data, not only the currently mirrored convenience fields.

---

## Not Allowed

- tabs in v1
- shot list in v1
- compare mode in v1
- export tools in v1
- debug UI
- a totally different shell from Dashboard

---

## Goal

This page should make the user feel:
“I understand this club now.”

It should feel more analytical than Dashboard, but still premium and opinionated.