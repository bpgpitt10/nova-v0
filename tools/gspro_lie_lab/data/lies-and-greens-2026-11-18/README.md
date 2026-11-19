# Lies and greens, GSPro 4.1.9 On Course practice, 18 Nov 2026

Shots fired with `roll_replay.py` (option 5), no swings. One csv and one `_log.txt`
(the lines GSPro wrote to Player.log for each shot) per sitting.

| File | Course | Settings (type / fairway / green) | What |
|---|---|---|---|
| 211134 | first course, then Tobacco Road from spot 7 | Bermuda soft/soft, then medium/medium | first lie spots; slopes typed from spot 7. No flight-path columns yet: `tools/fixtures` holds what was recovered from currentRound.dat |
| 215204 | Briarwood West | Bermuda soft/soft, stimp 11 | lies, slopes, first shots at greens |
| 220541 | Woodhaven (Glade Springs), 2,851 ft | Bentgrass medium/medium, stimp 12 | lies, slopes (17.8 up), altitude check |
| 221540 | Royal New Kent | Bermuda, soft fairways, firm greens | deep rough, 7.8 right sidehill |
| 222257 | Royal New Kent | same | first greens-only runs (176, 163, 94 yd) |
| 223256 | Briarwood West, one spot, 126 yd | Bermuda, greens soft / medium / firm, stimp 11 | the same six shots each run |
| 223805 | same spot | Bentgrass, soft / medium / firm | |
| 224306 | same spot | Links, soft / medium / firm | |
| 224851 | Briarwood West, one spot, 174 yd | Bentgrass, soft / medium / firm | |
| 225433 | same spot | Bermuda, soft / medium / firm | |
| 225919 | same spot | Links firm, soft, medium (spot 3 has no distance: ignore; spot 4 shot 1 hit the pin) | |

Codes in GSPro's log: Course Type 0 Bentgrass, 1 Bermuda, 2 Links; firmness 0 soft, 1 medium, 2 firm.
Surface codes: 1 rough, 2 fairway, 3 deep rough, 4 cart path, 5 green, 11 sand, 12 semi-rough, 18 tee.

Useful columns: `lie_surface`, `lie_speed_pct`, `lie_spin_pct` (GSPro's penalty line), `gspro_speed_mph` and
`gspro_spin_rpm` (after the lie), `flown_vla_deg`, `start_line_deg`, `offline_from_aim_yd`, `peak_height_ft`
(from the flight path: the slope of the lie shows here and nowhere else), `landing_surface`, `landing_speed`,
`landing_spin_rpm`, `descent_deg`, `roll_yd` (negative = spun back), `db_raw_carry_game_yd` (GSPro's carry for
the same shot from a clean, level lie at sea level).

Models built from this: `src/liveCaddie/greenReleaseModel.ts`, `surfaceResponse.ts` (rough, deep rough, sand,
semi-rough), `airAltitudeAdjustment.ts` (checked at 2,851 ft). Slope of the lie: measured, not yet built.
