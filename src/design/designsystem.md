# Design System (Locked v2)

This defines exact visual tokens and formatting rules.
Do not improvise.

## 1. Page Background

- App/page background: #0E1710
- Main content background should never be white
- The overall page should feel dark, premium, and golf-native

## 2. Surface Colors

- Primary card/surface: #142118
- Elevated surface: #1E3123
- Selected/tinted surface: #2A4330
- Inset panel/chip surface: #172419
- Borders/dividers: #314233

Rules:
- Main page uses dark background
- Major cards sit on darker green surfaces
- Avoid generic black/white contrast
- No white panels

## 3. Text Colors

- Primary text / hero numbers: #FFFFFF
- Secondary text: #CFD8CD
- Supportive text: #9FB09F

Rules:
- Hero score values must stay white
- Supporting copy must use muted green-gray text
- Do not let secondary text overpower the score

## 4. Caddie Call Colors

- Attack: #22C55E
- Play: #84CC16
- Manage: #EAB308
- Careful: #F97316
- Liability: #EF4444
- Insufficient Data: #6B7280

Rules:
- Use these colors primarily for pills, accents, subtle borders, and markers
- Do not tint the main score number by label
- Semantic color should support, not dominate

## 5. Typography

### Font Stack

Primary (UI):
- Inter
- -apple-system
- BlinkMacSystemFont
- "Segoe UI"
- sans-serif

Accent (select usage only):
- Fraunces

Logo:
- Custom script (The Looper mark)
- Never used as a font in UI

---

### Sizing (LOCKED)

These sizes are working well and should remain consistent across the product.

- Page title: 20px / 600
- Score label: 12px uppercase
- Score number: 40px / 600
- Call pill text: 12px / 600
- Section header: 12px uppercase
- Body text: 13px
- Explanation / insight text: 14px

---

### Font Usage Rules

#### Primary UI (Inter)
Used for:
- Buttons (Choose Club, Start, Open Data)
- Navigation
- Score + Call system
- Tables / shot data
- All functional UI

Weights:
- 400 → body
- 500 → labels
- 600 → buttons / key UI
- 700 → emphasis (sparingly)

---

#### Accent / Voice (Fraunces)
Used sparingly for:
- Tagline: “Every club holds a truth.”
- Select headers or callouts
- Marketing / landing surfaces

Rules:
- Never used in dense UI
- Never used for data
- Use with restraint

---

#### Logo (Script)
- The Looper logo is a custom script style
- Inspired by vintage sign painting (e.g., Lobster, Sign Painter)
- Always treated as a graphic, not a font

---

### Typography Principles

- Prioritize clarity over style
- Keep UI clean and highly readable
- Let the data stand out
- Use accent typography only where it adds meaning

Tone should feel:
- Calm
- Confident
- Experienced
- Understated

---

### What NOT to do

- Do not use script fonts in UI
- Do not introduce additional font families
- Do not overuse Fraunces
- Do not restyle UI text to mimic the logo

## 6. Spacing

Scale:
- xs: 4px
- sm: 8px
- md: 12px
- lg: 16px
- xl: 24px

Use only these spacing values.

## 7. Cards

Card style:
- Background: #142118
- Border: 1px solid #314233
- Border radius: 10px
- Padding: 16px or 20px depending on priority
- No heavy shadows
- Very subtle shadow only if needed

Rules:
- Cards should feel premium and quiet
- No bright outlines
- No white fill

## 8. Table Styling

- Header row background: #172419
- Table body on #142118
- Row borders: #314233
- Compact row height
- Dense but readable
- Alternate shading optional, very subtle only

## 9. Number Formatting Rules

All displayed numbers must be formatted for readability.

### Distances
- Show 1 decimal max for averages if needed
- Prefer whole numbers when precision adds no value
- Example:
  - 157
  - 157.4
- Never show long decimals

### Standard deviations
- Show 1 decimal max
- Example:
  - 8.2

### Scores
- Whole numbers only
- Example:
  - 82

### Percentages / ratios
- 0 or 1 decimal max

### Raw metrics
- Ball speed: 1 decimal max
- Launch angles: 1 decimal max
- Spin: whole number
- Spin axis: 1 decimal max

Rule:
- Never show raw JS floating-point style values

## 10. Surface Feel

The UI should feel:
- dark
- premium
- golf-native
- information-dense
- restrained
- laptop-first

It should not feel:
- white-page prototype
- admin dashboard
- debug tool
- generic spreadsheet app

## 11. Do NOT

- Use white page background
- Use black-only flat panels
- Show raw unformatted decimals
- Add gradients unless explicitly specified later
- Add flashy effects
- Add visual clutter