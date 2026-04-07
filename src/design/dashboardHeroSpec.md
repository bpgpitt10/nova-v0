# Dashboard Hero Spec (Locked)

This file defines the top hero area of the Dashboard.

This is the most premium section of the page.
It must feel more editorial and atmospheric than the club grid below.

This section is the first meaningful content on the Dashboard.

This file is the single source of truth for the full Dashboard hero area, including:
- The Looper's Read
- Spotlight on Your Game
- Trend to Watch

Other design files may reference this hero area, but should not redefine its structure, tone, or content rules.

---

## Structure

The hero area contains:

1. A primary `The Looper's Read` block
2. A secondary two-card row beneath it:
   - `Spotlight on Your Game`
   - `Trend to Watch`

### Layout
- `The Looper's Read` spans the full hero width
- Below it sits a two-card row on desktop
- The two supporting cards appear side-by-side
- The whole hero area should feel like one unified editorial section

### Placement rules
- This section must be the first real content on the page
- No content-heavy blocks above it
- No duplicate hero sections elsewhere on the page

---

## Primary Block: The Looper's Read

### Required content
- eyebrow: `The Looper's Read`
- main narrative paragraph (2–5 sentences)
- optional short supporting line or stat strip
- subtle course / flag / green texture atmosphere
- optional supporting icon or visual accent

### Purpose
This is the top-level read on the player’s game.

It should:
- summarize the overall state of the bag
- call out what is going well
- identify what is dragging
- feel like a caddie giving the big-picture truth

### Tone
- direct
- confident
- cheeky when appropriate
- conversational
- not robotic
- not bullet-driven

### Examples of tone
- “Your scoring clubs are carrying the bag right now, and the long end knows it.”
- “There’s a clear top tier forming, but a few clubs are still making you work too hard.”
- “You’ve got more trust at the bottom of the bag than the top, and the gap is getting obvious.”

### Not allowed
- bullets as the main content format
- generic KPI language
- stat-dump writing
- utility/admin controls in this block

---

## Supporting Card 1: Spotlight on Your Game

### Required content
- eyebrow: `Spotlight on Your Game`
- short headline or short narrative
- 1–2 supporting bullets or short lines
- supporting icon
- subtle course / flag / green texture atmosphere

### Purpose
This card isolates the strongest current takeaway from the overall status.

### Tone
- concise
- confident
- caddie-like
- more focused than Game Status

---

## Supporting Card 2: Trend to Watch

### Required content
- eyebrow: `Trend to Watch`
- short headline or short narrative
- 1–2 supporting bullets or short lines
- supporting icon
- subtle gold flourish or differentiated atmosphere

### Purpose
This card isolates the most important movement or trend across the bag.

### Tone
- observational
- directional
- concise
- still caddie-like

---

## Visual Rules

### Game Status block
- should be the strongest visual anchor
- dark green layered surface
- white-first text hierarchy
- premium atmosphere
- subtle golf imagery allowed
- gold accent restrained

### Supporting cards
- visually related to the main block
- slightly lighter in emphasis
- still premium
- still atmospheric
- must not overpower Game Status

### Imagery
Allowed:
- low-contrast golf course imagery
- subtle flag / hole visual
- blurred fairway / turf texture

Rules:
- imagery must be darkened and blended
- imagery must sit behind content
- imagery must not reduce readability
- imagery should feel atmospheric, not illustrative

---

## Implementation Constraints

- Do not introduce additional hero cards
- Do not convert this into a row of generic widgets
- Do not place Undo / Export / admin-style controls here
- Do not overload with raw metrics
- Do not duplicate this hero area elsewhere

---

## Goal

The user should land on the Dashboard and immediately get:

1. the big-picture state of the game from `The Looper's Read`
2. one strong supporting takeaway from `Spotlight on Your Game`
3. one key movement from `Trend to Watch`

This section should feel like a caddie speaking—not a dashboard reporting.