# Club Detail Spec (Incremental Build)

This file defines the Club Detail page and the order it should be built.

Club Detail is a separate page/view from Dashboard.

Its role is to explain why a club is strong or weak.

This page must follow the voice and tone rules defined in:
- src/design/looperVoice.md

Use that file as the single source of truth for Looper messaging.

Club Detail applies that voice in a single-club diagnostic context:
- more diagnostic than Dashboard
- still plainspoken
- slightly cheeky when appropriate
- focused on what this club is actually doing

---

## Page Role

Dashboard = broad trust view  
Club Detail = single-club explanation view

This page should answer:
1. Why is this club scoring the way it is?
2. What is the miss pattern?
3. What is changing over time?
4. What should I do with this club?

This page should feel:
- focused
- premium
- dark green golf-native
- explanation-first
- more data-rich than Dashboard
- stable and safe to build incrementally

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

## Build Order (IMPORTANT)

Club Detail must be implemented in phases.

Do not attempt to build the full page in one pass.

### Phase 1
- separate page/view boundary
- shared shell
- club name
- Score
- Call
- simple placeholder text

### Phase 2
- Dispersion (main visual)

### Phase 3
- Looper’s Read

### Phase 4
- What’s Driving This
  - Performance Drivers
  - Ball Flight vs Ideal

### Phase 5
- Trends

Only build one phase at a time unless explicitly requested.

---

## Current Target Phase

For now, the active implementation target is:

## Phase 2 — Dispersion

This means the current Club Detail implementation should include:
- page shell
- club name
- Score
- Call
- a simple dispersion section

Do not implement later phases until explicitly requested.

---

## Current Layout Order

For the current phase, the page should render in this order:

1. Page header / club identity row
2. Score + Call
3. Dispersion (main visual)

That is all for now.

---

## 1. Page Header / Club Identity Row

Required:
- club name in headline form

Optional later:
- lightweight controls

Do not overbuild controls now.

---

## 2. Score + Call

Required:
- Score
- Call

Rules:
- Score remains visually dominant
- Call uses semantic pill styling
- keep this simple for now

Do not add narrative or extra insight here yet.
That comes later in Looper’s Read.

---

## 3. Dispersion (Main Visual)

This is the current implementation target.

Primary visual:
- shot dispersion chart

Axes:
- x = offline distance (yards)
- y = carry distance (yards)

Purpose:
- show miss pattern visually
- provide the first meaningful club-specific explanation surface

Rules:
- use all historical saved-session shots for the selected club
- plot individual shots as dots
- show a visible center line at 0 offline
- make the visual reasonably large and central
- keep it contained within the main content column
- no horizontal overflow
- no runtime crashes on empty/missing data

Empty state:
- if no valid shots exist, show:
  - "No shot data available for this club yet"

Do not add heatmap gradients yet unless explicitly requested.
Do not add trends yet.
Do not add component drivers yet.

---

## Future Phases (Do Not Implement Yet)

The following sections belong to future phases and should not be built now unless explicitly requested.

---

## Future Phase 3 — Looper’s Read

This will become the primary intelligence block.

It will combine:
- Score
- Call
- narrative
- key drivers

It will summarize what the club is doing and what it means.

Do not implement in the current phase.

---

## Future Phase 4 — What’s Driving This

This will explain WHY the Looper’s Read is true.

### Left column:
Performance Drivers
- Pattern Stability
- Direction Window
- Distance Window
- Flight Quality
- Data Confidence

### Right column:
Ball Flight vs Ideal
- Launch (VLA)
- Spin
- Descent Angle
- Carry

Do not implement in the current phase.

---

## Future Phase 5 — Trends

Future trends may include:
- carry trend
- dispersion / offline trend
- bias trend
- VLA trend
- spin trend

Do not implement in the current phase.

---

## Data Rules

Use:
- all historical saved-session shots for the selected club
- full shot.openGolfCoach payload where needed
- existing Score/Call engine unchanged
- persisted raw fields where useful

Handle missing data gracefully.

The page must never hard-crash because of incomplete data.

---

## Not Allowed (Current Phase)

- Looper’s Read block
- component drivers
- Ball Flight vs Ideal
- trends
- tabs
- shot list
- compare mode
- export tools
- debug UI
- alternate shell

---

## Goal

For the current phase, this page should make the user feel:

"I can see this club’s shot pattern clearly."

Later phases will expand that into:
"I understand this club — and I know how to use it."