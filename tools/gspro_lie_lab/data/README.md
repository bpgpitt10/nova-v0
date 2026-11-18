# Roll measurements (GSPro 4.1.9, Brian's sim, 18 Nov 2026)

Both files were written by `../roll_replay.py` on the Practice Range: no wind,
0 ft elevation, shots dead straight. GSPro's roll repeats exactly, so each
shot appears once per setting.

- `fairway_stock_shots_2026-11-18.csv`: the bag's 11 stock shots in all nine
  combinations of Course Type and Fairway Firmness (110 rows; Medium/Medium
  was hit twice).
- `fairway_designed_shots_2026-11-18.csv`: 25 designed shots (five ball speeds,
  five launch angles, five spin rates, every pair once) in all nine
  combinations (225 rows), plus 7 putt rows from a first putt test (only the
  first recorded; fixed since).

Carry is identical across settings; only the roll changes. A first model
fitted on the designed shots alone (log roll on landing speed across the
ground, landing speed downward, and spin, per setting) predicts the stock
shots to 0.7 yd on average, worst 4.6 yd (driver, Soft type with Firm
fairways). Findings: project doc `claude/roll-by-course-settings-2026-11-18.md`.
