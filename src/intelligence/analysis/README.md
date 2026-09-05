# Looper Analysis Policies

Performance-driver algorithms should not decide which real golf shots count as plannable evidence. Shot-set policy is an upstream concern.

## Legacy policy: `legacy-manual-cleanup`

The current Looper performance drivers were designed around an implicit user behavior: a user manually removes true mishits / catastrophic outcomes that should not describe normal plannable club performance.

Under this policy:

- included shots are treated as the user's intended planning dataset
- the five performance drivers evaluate that already-cleaned dataset
- mishit frequency is not itself a performance-driver input
- this policy exists primarily to reproduce current Looper behavior for parity

This assumption is important. The legacy driver formulas should not be interpreted as having been designed to absorb a large population of catastrophic mishits.

## Future policy: `planning-auto-mishit`

The first automated mishit integration should aim to remove the manual cleanup step, not redefine the meaning of every driver.

The target behavior is:

> raw real shots -> automated mishit classification -> planning-eligible shots that approximate what a careful user should have manually kept -> existing driver semantics

The same real mishits remain stored as execution truth and can support separate analytics such as mishit rate and catastrophic miss patterns.

## Why policy is separate from model version

Two independent things can change a score:

1. **analysis policy change** — the algorithm is unchanged, but the set of shots it receives changes
2. **algorithm change** — the same input set is processed by different math

Looper should be able to distinguish these explicitly.

Example comparison:

- `legacy-manual-cleanup` + Distance Window `legacy-v1`
- `planning-auto-mishit` + Distance Window `legacy-v1`
- `planning-auto-mishit` + Distance Window `v2`

The first comparison isolates automated shot selection. The second isolates an algorithm redesign.

## Mishit risk as a future scoring input

Mishit frequency may ultimately be valuable to Club Confidence / Club Score because execution risk matters in real golf. That is a separate model-design decision.

Do not quietly add mishits back into legacy driver formulas or the aggregate score while also introducing automated filtering. First validate that automated classification recreates the planning dataset the legacy system expected. Then evaluate whether execution-risk metrics should become a new component of a later score version.
