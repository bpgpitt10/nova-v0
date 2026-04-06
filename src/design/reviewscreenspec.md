# Review Screen Pixel-Level Spec (Locked)

This file defines the exact layout and spacing for the review screen.
Do not improvise.
Do not rearrange.
Do not redesign.

This screen is the primary product surface for the current build.
It should reinforce the product hierarchy:
1. Caddie Score
2. Caddie Call
3. Insights
4. Club table
5. Supporting metrics

Use all tokens from `designSystem.md`.
Use all hierarchy rules from `productPrinciples.md`.
Use all section ordering from `reviewScreenLayout.md`.

---

## 1. Screen Shell

### Outer app frame
- Full width
- Max content width: 1440px
- Horizontal padding:
  - desktop: 24px
  - narrower laptop: 16px
- Top padding: 24px
- Bottom padding: 24px
- Content aligned center within page width

### Vertical section spacing
- Between major sections: 24px
- Between subsection header and content: 12px
- Between stacked items inside cards: 8px

---

## 2. Review Screen Layout Order

The screen must render in this exact order:

1. Review header
2. Caddie summary card
3. Key insights card
4. Club review table card
5. Supporting metrics / component breakdown card

Do not change this order.

---

## 3. Review Header

### Container
- Full content width
- Height: auto
- Bottom margin: 16px

### Layout
Two-column row:
- Left side: review title + session metadata
- Right side: controls/actions

#### Left side
Top line:
- Title: `Session Review`
- Font size: 20px
- Font weight: 600
- Color: Primary text

Second line:
- Session date/time
- Optional session name
- Shot count summary
- Font size: 13px
- Color: Secondary text

#### Right side
- Actions aligned right
- Horizontal gap: 8px
- Button height: 32px
- Button padding: 0 12px

Do not allow controls to overpower the screen.

---

## 4. Caddie Summary Card (Top Focal Surface)

This is the top visual anchor of the screen.

### Card container
- Full width
- Background: Surface
- Border: 1px solid Border
- Border radius: 8px
- Padding: 20px

### Internal layout
Three-column layout on desktop:

#### Left column (primary)
Width: 280px

Stack:
- Label: `Caddie Score`
  - 12px uppercase
  - Secondary text
- Score value
  - 40px
  - font-weight: 600
  - Primary text
- Caddie Call pill
  - Inline with or directly below score
  - Height: 28px
  - Horizontal padding: 10px
  - Border radius: 999px
  - Use exact label color from design system
- Included shots summary
  - 13px
  - Secondary text

#### Center column
Flexible width

Stack:
- 1 short explanation paragraph
- Max width: 520px
- Font size: 14px
- Line height: 1.4
- Primary text

This explanation should read like caddie guidance, not analytics commentary.

#### Right column
Width: 280px

Stack 5 component score rows:
- Distance Window
- Direction Window
- Flight Quality
- Pattern Stability
- Data Confidence

Each row:
- label on left
- numeric component score on right
- row height: 24px
- bottom border optional, subtle only
- label: 12px secondary text
- value: 13px primary text, medium weight

### Alignment rules
- Primary score block should dominate visually
- Component scores should feel secondary
- Explanation should bridge primary and secondary areas

---

## 5. Key Insights Card

### Card container
- Full width
- Background: Surface
- Border: 1px solid Border
- Border radius: 8px
- Padding: 16px

### Header
- Text: `Key Insights`
- 12px uppercase
- Secondary text
- Bottom margin: 12px

### Body
- 1 to 3 insight rows
- Each row height: auto
- Vertical gap: 8px

Each insight row:
- small leading accent dot or subtle left border allowed
- text size: 14px
- primary text
- line height: 1.4

Keep these scannable in under 3 seconds.

---

## 6. Club Review Table Card (Primary Working Surface)

This is the most important dense information area.

### Card container
- Full width
- Background: Surface
- Border: 1px solid Border
- Border radius: 8px
- Padding: 16px

### Header
- Text: `Club Review`
- 12px uppercase
- Secondary text
- Bottom margin: 12px

### Table behavior
- Horizontal scroll allowed if needed on smaller screens
- Dense but readable
- No oversized rows
- No excessive white space

### Table min width
- 1180px minimum

### Column spec

#### Column 1: Club
- Width: 72px
- Alignment: left
- Text: 13px medium

#### Column 2: Caddie Score
- Width: 96px
- Alignment: left
- Show numeric score prominently
- Score text: 15px semi-bold

#### Column 3: Caddie Call
- Width: 110px
- Alignment: left
- Show as pill
- Pill height: 24px
- Pill padding: 0 8px
- Border radius: 999px

#### Column 4: Insights
- Width: 320px
- Alignment: left
- Max 2 short lines
- Text: 13px
- Line height: 1.35

#### Column 5: Included Shots
- Width: 84px
- Alignment: center
- Text: 13px

#### Column 6: Carry Avg / Std Dev
- Width: 140px
- Alignment: left
- Use stacked format:
  - top line avg
  - bottom line std dev
- Avg: 13px primary text
- Std dev: 12px secondary text

#### Column 7: Offline Avg / Std Dev
- Width: 140px
- Same format as carry

#### Column 8: Shot Rank Summary
- Width: 130px
- Alignment: left
- Compact text summary
- 12px to 13px

#### Column 9: Component Snapshot (optional if already shown above)
- Width: 180px
- Only include if current implementation already has it cleanly
- Otherwise omit from table and keep in supporting card below

### Header row
- Height: 36px
- Background: slightly darker than surface if needed
- Text: 11px uppercase
- Secondary text
- Bottom border: 1px solid Border

### Body rows
- Height: 56px target
- Vertical padding: 8px
- Bottom border: 1px solid Border
- Alternate row shading optional, extremely subtle only

### Row emphasis rules
- Do not use large color fills
- Use label pill color as primary semantic indicator
- Numeric score remains white/primary text
- This follows the white-first hierarchy from the design artifact :contentReference[oaicite:0]{index=0}

---

## 7. Supporting Metrics / Breakdown Card

This section is lower priority.

### Card container
- Full width
- Background: Surface
- Border: 1px solid Border
- Border radius: 8px
- Padding: 16px

### Header
- Text: `Supporting Metrics`
- 12px uppercase
- Secondary text
- Bottom margin: 12px

### Body
Grid layout:
- 2 columns on desktop
- gap: 16px

Each sub-block:
- compact metric list or explanation block
- 12px labels
- 13px values

This section may include:
- penalty/modifier breakdown
- raw input notes
- debug/calibration details
- explanation drivers

Keep this secondary. It must not outrank the club table.

---

## 8. Color Rules

Use exact tokens from `designSystem.md`.

### Caddie Call pill colors
- Attack: #22C55E
- Play: #84CC16
- Manage: #EAB308
- Careful: #F97316
- Liability: #EF4444
- Insufficient Data: #6B7280

### Score color
- Always primary text / white-like token
- Do not tint score number by call
- This follows the prior product rule that the number stays primary and the label carries semantic meaning :contentReference[oaicite:1]{index=1}

---

## 9. Typography Rules

Use only the system stack from `designSystem.md`.

### Exact usage
- Page title: 20px / 600
- Section labels: 12px uppercase / medium
- Caddie Score: 40px / 600
- Caddie Call pill text: 12px / 600
- Table body text: 13px
- Secondary metrics: 12px
- Explanation / insights: 14px

---

## 10. Responsive Rules

### Desktop-first
This screen is designed for laptop/desktop first, consistent with the product direction :contentReference[oaicite:2]{index=2}

### On narrower widths
- Keep section order unchanged
- Allow horizontal table scroll
- Collapse Caddie Summary card from 3 columns to vertical stack only if necessary
- Do not convert the club table into mobile cards yet
- Do not redesign for mobile at this stage

---

## 11. Implementation Rules

- Do not change scoring math
- Do not change data flow
- Do not change Nova integration
- Do not change OpenGolfCoach integration
- Do not change session history logic
- Only refactor UI structure and styling to match this spec

---

## 12. Goal

The review screen should feel like:
- a premium decision surface
- laptop-first
- information dense but readable
- guided by score and insight first
- clearly aligned to the product vision of showing what changed, what is trustworthy, and where the smart golf is :contentReference[oaicite:3]{index=3}

It should not feel like:
- a generic admin table
- a raw debug dashboard
- an exploratory analytics toy