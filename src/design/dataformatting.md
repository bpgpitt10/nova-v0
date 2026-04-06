# Data Formatting Rules

These rules are mandatory for all displayed values.

## Core Rule
- All numeric values must display exactly **1 decimal place**
- Exception: spin values must be **whole numbers (no decimals)**

---

## Score Formatting
- Caddie Score: whole number only (no decimals)

---

## Distance Formatting
- Carry average: 1 decimal (e.g., 157.4)
- Carry std dev: 1 decimal (e.g., 8.2)
- Offline average: 1 decimal (e.g., 6.5)
- Offline std dev: 1 decimal (e.g., 4.1)
- Total distance: 1 decimal (e.g., 165.8)

---

## Raw Metrics

- Ball speed: 1 decimal (e.g., 67.3)
- Vertical launch angle (VLA): 1 decimal (e.g., 18.2)
- Horizontal launch angle (HLA): 1 decimal (e.g., -1.4)
- Spin: whole number only (e.g., 5420)
- Spin axis: 1 decimal (e.g., -3.7)

---

## General Rules

- Never show long decimals (e.g., 157.428392)
- Never show inconsistent precision across similar values
- Always round to 1 decimal place (except spin)
- Always display trailing decimals (e.g., show 157.0, not 157)
- Formatting must be consistent across:
  - tables
  - summary cards
  - insights
  - debug/supporting sections

---

## Implementation Guidance

- Apply formatting at render time (not in core data objects)
- Use consistent formatting helpers (e.g., toFixed(1) for decimals)
- Ensure negative values preserve sign and precision (e.g., -2.3)

---

## Goal

All numbers should feel:
- clean
- consistent
- intentional
- easy to scan quickly

Never raw, noisy, or overly precise.