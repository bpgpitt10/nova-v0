# Dashboard Page Spec (Locked)

This is the primary product surface.
It is NOT a generic review page.
It is NOT a debug screen.
It is NOT a raw session output table.

This page should answer:

1. Where does my game stand right now?
2. What should I trust?
3. What is changing?

It should feel like a premium golf decision surface.

Use all constraints from:
- productPrinciples.md
- designSystem.md
- caddieCallSystem.md
- implementationRules.md

---

## 1. Page Role

This is the main page users should come back to.
It is card-first, not table-first.

Hierarchy:
1. Spotlight / key takeaways
2. Club grid
3. Supporting insights/trend visuals
4. Secondary controls

This page should feel:
- visual
- premium
- scannable
- confidence-led
- insight-forward

Not:
- admin dashboard
- debug table
- spreadsheet UI
- plain black prototype

---

## 2. Overall Layout

### Shell
- Desktop / laptop first
- Full page dark golf-native background
- Max content width: 1440px
- Horizontal padding: 24px
- Vertical padding: 24px
- Left rail navigation remains visible
- Main content uses wide landscape layout

### Structure
Main content order:
1. Page header
2. Hero summary / headline block
3. Spotlight cards
4. Club card grid
5. Insights / supporting trend cards

---

## 3. Background / Visual Surface

This page must NOT use a plain black or white page background.

### Required background treatment
- Base background: deep forest green
- Layered dark green gradient
- Subtle golf-native texture / atmosphere
- Slight tonal variation across sections
- Optional soft gold accent glow in isolated spots only

The page should feel like:
- turf
- shadow
- premium clubhouse materials
- tournament signage

Not:
- black monitor UI
- generic SaaS dark mode

---

## 4. Page Header

### Left side
- Page title: `Dashboard`
- Subtitle: short line explaining this is your current game view

### Right side
- comparison/session range control
- export action
- overflow menu if needed

Rules:
- controls should stay secondary
- title area should not be visually weak

---

## 5. Hero Summary Block

Defined in:
- src/design/dashboardHeroSpec.md

Summary:
- Primary full-width `The Looper's Read` block
- Secondary supporting row:
  - `Spotlight on Your Game`
  - `Trend to Watch`

This is the primary visual and editorial anchor of the Dashboard.

Do not define hero behavior, structure, tone, or content rules here.
Use `dashboardHeroSpec.md` as the single source of truth for the full hero area.

---

## 6. Spotlight Cards

Defined in:
- src/design/dashboardHeroSpec.md

This supporting spotlight row is part of the Dashboard hero area.

Do not define spotlight structure or content here.
Use `dashboardHeroSpec.md` as the single source of truth.

---

## 7. Club Grid (Primary Surface)

This is the main working area of the page.

### Purpose
Let the user scan the whole bag and understand current trust quickly.

### Layout
Responsive card grid
- desktop target: 5–6 cards across depending on width
- equal card sizing
- bag order preserved

### Club card required content
Each club card shows:
- Club name
- Score
- Call pill
- 1 short supporting descriptor or trend line
- small delta/trend signal
- optional subtle visual/background treatment

### Rules
- numeric score must be visually dominant
- Call pill carries semantic color
- card itself may carry subtle tonal tint, but not overpower the score
- do not use giant paragraphs inside cards
- cards should feel premium, not boxy/plain

### Card visual treatment
- dark green surface
- subtle border
- soft gradient or atmosphere allowed
- optional ghosted club image / texture later
- no plain flat black tiles

---

## 8. Supporting Insights Section

### Purpose
Support the grid with broader takeaways and light trends.

### Layout
2 wide cards side-by-side

### Content examples
- success zone by club group
- confidence gap between strong and weak clubs
- wedges vs long clubs
- trend movement over recent sessions

Rules:
- keep these secondary to spotlight + club grid
- charts can be simple for now
- visuals should be clean and restrained

---

## 9. Caddie Score / Caddie Call Rules

Keep the current scoring math unchanged.

Display rules:
- Score = large white numeric value
- Call = semantic pill
- Never tint the score number by label
- Use label color for pill, accent lines, subtle highlights

Calls:
- Attack
- Play
- Manage
- Careful
- Liability
- Insufficient Data

---

## 10. What does NOT belong on this page

Do not make this page:
- a shot-by-shot review table
- a debug monitor
- a dense metrics sheet
- a club deep-dive page

Those belong elsewhere.

---

## 11. What this page is called

Internal name:
- Dashboard

Product meaning:
- the main game-status surface

This page should become the main surface users land on after enough session data exists.