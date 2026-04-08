# Looper Voice System

This file is the single source of truth for all Looper messaging voice and tone.

All hero copy, club-detail narratives, and Looper insight text must follow this spec.

---

## Voice Identity

The Looper voice should sound like:
- an experienced Irish caddie
- direct
- calm
- slightly cheeky
- observant
- honest without being harsh

Core feeling:
- knowledgeable playing partner
- trusted course-side read
- clear and grounded, never performative

---

## Tone Rules

Write in:
- short sentences
- plain golf language
- practical decision-first phrasing

Do not use:
- corporate language
- analytical/reporting language
- abstract product jargon

Important:
- do not repeat numbers already shown in the UI
- use the message to interpret the numbers, not restate them

---

## Personality Layer

Allowed personality:
- subtle dry humor
- light ragging when appropriate
- warm bluntness

Not allowed:
- sarcasm
- comedy voice
- mocking tone
- exaggerated hype

Standard:
- sound like a smart playing partner who has seen this pattern before

---

## Standard Looper Message Structure

Use this order:

1. Primary read (what it means)
2. Supporting explanation (why)
3. Optional implication (what to do)

Rules:
- max 3 sentences total
- each sentence must earn its place
- always connect to a playing decision

---

## Vocabulary Guidance

Prefer:
- stable
- loose
- drifting
- holding
- sharp
- soft
- tightening
- widening
- leaking
- climbing
- flattening
- trustworthy
- streaky

Avoid:
- statistically significant
- variance profile
- distribution anomaly
- model confidence interval
- percentile framing
- optimization language

---

## Component Translation Mapping

Translate internal components into golfer language:

- Pattern Stability:
  - "how repeatable this club looks right now"
  - "how often it shows the same shape"

- Direction Window:
  - "how wide your left-right miss is"
  - "whether start lines are holding or leaking"

- Distance Window:
  - "how tight your carry window is"
  - "whether yardage is steady or jumpy"

- Flight Quality:
  - "how playable the flight is"
  - "whether launch and spin are working together"

- Data Confidence:
  - "how much evidence we have"
  - "how much trust to place in this read today"

Never surface raw component names to the golfer if plain language works better.

---

## Hard Constraints

- max 3 sentences
- no numeric repetition from nearby UI
- always tie to decision-making
- no tone redefinition in other specs

If another file defines Looper tone differently, this file wins.
