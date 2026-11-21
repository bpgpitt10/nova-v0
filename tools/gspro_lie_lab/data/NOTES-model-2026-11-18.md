# Roll model: where the fitting stands (18 Nov 2026, evening)

Data: the two csv files in this folder (324 fairway shots, 36 launches x 9 settings).

## Inputs that work
From GSPro's own record of each shot (no flight model needed):
- `vy` = sqrt(2 * 32.17 * peak_height_ft): how fast the ball is coming down (ft/s, drag ignored)
- `vx` = vy / tan(descent): how fast it is moving along the ground
- spin (launch rpm)
Roll per unit of ground speed (`roll / vx`) is close to a function of spin and
descent angle alone: for steep shots it depends almost only on spin; shallow
shots add a bounce-forward part.

## Models tried (fit on the 25 designed shots, tested on the 11 stock shots, all 9 settings)
| Model | Stock mean miss | Stock worst | Note |
|---|---|---|---|
| log roll ~ landing speeds + spin (plain regression) | 0.7-0.9 yd | 3-5 yd | rounds off the Soft-type threshold |
| polynomials in spin and descent | 0.8 yd | 4-8 yd | unstable away from the data (leave-one-out blows up) |
| physical: ground speed kept after impact, then roll-out | 0.6 yd | 4.7 yd | 6 parameters per setting, fits Soft types best |
| **smooth interpolation: linear trend in descent and spin + RBF on (descent/15, spin/2.5k, ln vx/0.6)** | **0.5 yd** | **3.5 yd** | leave-one-out over all 36: mean 0.4 yd, 95% within 1.5 yd |

The interpolating model is the one to build: it cannot blow up outside the
data (it falls back to the linear trend), and it is exact where we measured.
Its one large leave-one-out miss is the 70 mph / 9 deg / 2,200 rpm shot (11 deg
descent, 40-55 yd of roll), which nothing else in the set resembles; with that
shot in the model it is covered.

## How it joins Looper's engine (decided with Brian, 18 Nov)
Merge, do not replace:
1. **Landing state** comes from the player's own range shots (GSPro's measured
   descent and peak height per shot), as carry already does.
2. **Wind, elevation and air** come from the existing flight model
   (`flightPhysics.ts`) as *changes* to that landing state (steeper and slower
   into the wind, flatter downwind), the way it already supplies carry deltas.
3. **This model** turns landing state + the round's Course Type and Fairway
   Firmness into base roll, replacing the fixed range rollout.
4. **Existing modifiers stay on top:** surface (rough 0.35, bunker 0.1, ...),
   slope along the roll, and the descent-meets-terrain touchdown (`rollModel.ts`).

## Side finding: Looper's flight model vs GSPro, no wind
Running `simulateFlight` on the same 36 launches: carry is off by a median
7.9 yd (irons 5i-9i fly 10-14 yd too far; the high-spin designed shots up to
54 yd too far), descent by a median 3.2 deg. It is used for deltas, not
absolutes, so this has not shown up in play, but these 36 launches are a clean
set to calibrate it against.
