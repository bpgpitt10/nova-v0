// Quick Bag: three carries and a handicap become a full starting bag; range shots blend it out.
import assert from 'node:assert/strict'

let server = null
const load = globalThis.__looperTestLoad ?? (async (path) => {
  if (!server) {
    const { createServer } = await import('vite')
    server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  }
  return server.ssrLoadModule(path)
})
try {
  const qb = await load('/src/lib/quickBag.ts')
  const { applyQuickBagToProfileSet, applyQuickBagToPlayers, syntheticPriorSamples, PRIOR_SUPPORT_SHOTS } =
    await load('/src/liveCaddie/quickBagProfiles.ts')

  const clubs = ['Driver', '3W', '3H', '5i', '6i', '7i', '8i', '9i', 'PW', 'GW', 'SW', 'LW']
  const input = {
    version: 1, handicap: 14,
    anchors: { Driver: { carryYds: 235, shape: 'fade' }, '7i': { carryYds: 155, shape: 'neutral' }, PW: { carryYds: 118, shape: 'neutral' } },
    clubs, handed: 'right', savedAt: '2026-11-06T13:00:00Z',
  }

  // --- gapping: anchors exact, strictly decreasing, sensible neighbours
  const prior = qb.buildQuickBagPrior(input)
  const carry = Object.fromEntries(prior.clubs.map((c) => [c.club, c.carryYds]))
  assert.equal(carry.Driver, 235); assert.equal(carry['7i'], 155); assert.equal(carry.PW, 118)
  const ordered = prior.clubs.map((c) => c.carryYds)
  for (let i = 1; i < ordered.length; i += 1) assert.ok(ordered[i] <= ordered[i - 1] - 4, `gap ${prior.clubs[i].club}`)
  assert.ok(carry['8i'] > carry['9i'] && carry['9i'] > carry.PW && carry['8i'] < carry['7i'])
  assert.ok(Math.abs((carry['7i'] - carry['8i']) - (carry['8i'] - carry['9i'])) <= 2, 'even iron gaps between 7i and PW')
  assert.ok(carry['3W'] >= 205 && carry['3W'] <= 222, `3W ${carry['3W']}`)
  assert.ok(carry.SW >= 85 && carry.SW <= 100, `SW ${carry.SW}`)

  // --- handicap drives width and the short-swing rate; shape drives bias with the right sign and club
  const scratch = qb.buildQuickBagPrior({ ...input, handicap: 0 })
  const twenty = qb.buildQuickBagPrior({ ...input, handicap: 20 })
  const seven = (p) => p.clubs.find((c) => c.club === '7i')
  const driver = (p) => p.clubs.find((c) => c.club === 'Driver')
  assert.ok(seven(scratch).lateralSigmaYds < seven(prior).lateralSigmaYds && seven(prior).lateralSigmaYds < seven(twenty).lateralSigmaYds)
  assert.ok(Math.abs(seven(scratch).lateralSigmaYds - 6.2) < 0.5, `scratch 7i ±${seven(scratch).lateralSigmaYds}`)
  assert.ok(Math.abs(seven(twenty).lateralSigmaYds - 11.5) < 0.6, `20 hcp 7i ±${seven(twenty).lateralSigmaYds}`)
  assert.ok(driver(prior).lateralSigmaYds > seven(prior).lateralSigmaYds * 1.8, 'driver sprays far more than a 7i')
  assert.ok(scratch.clubs[0].mishitRate < 0.07 && twenty.clubs[0].mishitRate > 0.2)
  assert.ok(driver(prior).lateralBiasYds > 10, `sliced driver finishes right: ${driver(prior).lateralBiasYds}`)
  assert.equal(seven(prior).lateralBiasYds, 0, 'straight irons stay straight')
  assert.ok(prior.clubs.find((c) => c.club === '3W').lateralBiasYds > 0, 'woods follow the driver shape')
  const lefty = qb.buildQuickBagPrior({ ...input, handed: 'left' })
  assert.ok(driver(lefty).lateralBiasYds < 0, "a left-hander's fade finishes left")

  // --- typed carry overrides win and are not pushed into order
  const typed = qb.buildQuickBagPrior({ ...input, carryOverrides: { '5i': 182 } })
  assert.equal(typed.clubs.find((c) => c.club === '5i').carryYds, 182)

  // --- launch scales with carry
  assert.ok(driver(prior).launch.ballSpeedMph > 140 && driver(prior).launch.ballSpeedMph < 155)
  assert.ok(seven(prior).launch.totalSpinRpm > 6000)

  // --- blending by shot count
  assert.equal(qb.rangeWeight(0, qb.BLEND_RULES.carry), 0)
  assert.ok(Math.abs(qb.rangeWeight(1, qb.BLEND_RULES.carry) - 1 / 3) < 1e-9)
  assert.equal(qb.rangeWeight(5, qb.BLEND_RULES.carry), 1)
  assert.ok(Math.abs(qb.rangeWeight(3, qb.BLEND_RULES.sigma) - 1 / 3) < 1e-9)
  assert.equal(qb.rangeWeight(12, qb.BLEND_RULES.sigma), 1)
  assert.equal(qb.blendValue(150, 165, 1, qb.BLEND_RULES.carry), 155, 'one shot moves the carry a third of the way')
  assert.equal(qb.blendValue(150, null, 3, qb.BLEND_RULES.carry), 150)
  assert.deepEqual(qb.clubModelLabel(0, true), { kind: 'starting-bag' })
  assert.deepEqual(qb.clubModelLabel(3, true), { kind: 'learning', shots: 3, fullAt: 5 })
  assert.deepEqual(qb.clubModelLabel(5, true), { kind: 'measured' })
  assert.equal(qb.modelBasisFromCarryWeight(0), 'starting-bag')
  assert.equal(qb.modelBasisFromCarryWeight(0.6), 'learning')
  assert.equal(qb.modelBasisFromCarryWeight(1), 'measured')

  // --- plus handicaps: +2 is kept as −2 and is tighter than scratch; clamped at +10
  assert.equal(qb.normalizeHandicap(-2), -2)
  assert.equal(qb.normalizeHandicap(-14), qb.MIN_HANDICAP)
  const plus2 = qb.buildQuickBagPrior({ ...input, handicap: -2 })
  assert.ok(seven(plus2).lateralSigmaYds < seven(scratch).lateralSigmaYds)
  assert.ok(plus2.clubs[0].mishitRate >= 0.04)

  // --- validation
  assert.equal(qb.quickBagInputProblem(input.anchors), null)
  assert.match(qb.quickBagInputProblem({ ...input.anchors, Driver: { carryYds: 200, shape: 'fade' }, '7i': { carryYds: 190, shape: 'neutral' } }), /driver should carry/i)
  assert.match(qb.quickBagInputProblem({ ...input.anchors, PW: { carryYds: NaN } }), /Enter a PW carry/)

  // --- profile set: empty range → every club from the prior, marked, with phantom support
  const empty = { schema_version: 'x', generated_at: '', source: '', historical_model_now: '', session_count: 0, shot_count: 0, clubs: [], club_support: [] }
  const set0 = applyQuickBagToProfileSet(empty, prior)
  assert.equal(set0.clubs.length, clubs.length)
  assert.equal(set0.starting_bag['7i'].carryWeight, 0)
  assert.equal(set0.club_support.find((s) => s.club === '7i').included_stock_shots, PRIOR_SUPPORT_SHOTS)
  const p7 = set0.clubs.find((c) => c.club === '7i')
  assert.equal(p7.stock_carry_yds, 155); assert.equal(p7.lateral_sigma_yds, seven(prior).lateralSigmaYds)
  assert.ok(p7.launch_profile.total_spin_rpm > 6000)

  // --- profile set: two 7i shots at 165 → carry blended halfway, sigma mostly prior
  const measured = { ...empty,
    clubs: [{ club: '7i', stock_carry_yds: 165, stock_total_yds: 172, carry_sigma_yds: 3, lateral_bias_yds: 4, lateral_sigma_yds: 2, launch_profile: { ball_speed_mph: 120 } }],
    club_support: [{ club: '7i', included_stock_shots: 2, sessions: 1, pure_tagged_shots: 0 }] }
  const set2 = applyQuickBagToProfileSet(measured, prior)
  const b7 = set2.clubs.find((c) => c.club === '7i')
  assert.equal(b7.stock_carry_yds, 160, 'two shots: halfway between prior 155 and measured 165')
  const sigmaW = qb.rangeWeight(2, qb.BLEND_RULES.sigma)
  assert.ok(Math.abs(b7.lateral_sigma_yds - (sigmaW * 2 + (1 - sigmaW) * seven(prior).lateralSigmaYds)) < 1e-9)
  assert.equal(set2.club_support.find((s) => s.club === '7i').included_stock_shots, 2 + PRIOR_SUPPORT_SHOTS)
  assert.ok(Math.abs(set2.starting_bag['7i'].carryWeight - 0.5) < 1e-9)
  assert.equal(set2.clubs.length, clubs.length, 'other clubs still come from the prior')

  // --- profile set: 20 shots → untouched, no mark, no phantom support
  const full = { ...measured, club_support: [{ club: '7i', included_stock_shots: 20, sessions: 3, pure_tagged_shots: 2 }] }
  const set20 = applyQuickBagToProfileSet(full, prior)
  assert.equal(set20.clubs.find((c) => c.club === '7i').stock_carry_yds, 165)
  assert.equal(set20.starting_bag['7i'], undefined)
  assert.equal(set20.club_support.find((s) => s.club === '7i').included_stock_shots, 20)
  // 12 shots: carry and sigma are the player's, no phantom support, but the tail is still blended (mark kept)
  const set12 = applyQuickBagToProfileSet({ ...measured, club_support: [{ club: '7i', included_stock_shots: 12, sessions: 2, pure_tagged_shots: 0 }] }, prior)
  assert.equal(set12.clubs.find((c) => c.club === '7i').lateral_sigma_yds, 2)
  assert.equal(set12.club_support.find((s) => s.club === '7i').included_stock_shots, 12)
  assert.equal(set12.starting_bag['7i'].carryWeight, 1)

  // --- synthetic population: tail share equals the mishit rate; fades out by 20 shots
  const synth = syntheticPriorSamples(seven(prior), 0, 0, '2026-11-06T13:00:00Z')
  const total = synth.reduce((s, x) => s + x.weight, 0)
  const tail = synth.filter((x) => !x.planningEligible).reduce((s, x) => s + x.weight, 0)
  assert.ok(Math.abs(total - 1) < 1e-9, 'no real shots: prior weight 1')
  assert.ok(Math.abs(tail / total - seven(prior).mishitRate) < 1e-9, 'tail share = mishit rate')
  assert.ok(synth.filter((x) => x.quality === 'severe_mishit').length >= 1)
  const synth10 = syntheticPriorSamples(seven(prior), 10, 5, '2026-11-06T13:00:00Z')
  const w10 = synth10.reduce((s, x) => s + x.weight, 0)
  assert.ok(Math.abs(w10 / (w10 + 5) - 0.5) < 1e-9, 'ten real shots: prior and range split evenly')
  assert.equal(syntheticPriorSamples(seven(prior), 20, 5, '2026-11-06T13:00:00Z').length, 0)

  // --- players: every bag club gets a population; an existing club keeps its real samples and adds the prior's
  const players = applyQuickBagToPlayers(
    [{ club: '7i', variantId: 'stock', variantLabel: 'Stock', stockCarryYds: 165, carrySigmaYds: 3, lateralBiasYds: 4, lateralSigmaYds: 2,
       supportShots: 2, supportingSessions: 1, samples: [{ shotId: 'a', capturedAt: '', carryYds: 164, offlineYds: 3, weight: 0.5, quality: 'normal', planningEligible: true, classificationConfidence: null },
       { shotId: 'b', capturedAt: '', carryYds: 166, offlineYds: 5, weight: 0.5, quality: 'normal', planningEligible: true, classificationConfidence: null }],
       representativeLaunch: { ballSpeedMph: 120, vlaDeg: 17, hlaDeg: 0, totalSpinRpm: 6500, spinAxisDeg: 0, peakHeightYds: 28, descentAngleDeg: 47 },
       representativeClub: { clubPathDeg: null, angleOfAttackDeg: null } }],
    set2, prior, Date.parse('2026-11-06T13:00:00Z'))
  assert.equal(players.length, clubs.length)
  const p7m = players.find((p) => p.club === '7i')
  assert.equal(p7m.stockCarryYds, 160, 'player model follows the blended profile')
  assert.ok(p7m.samples.filter((s) => s.shotId === 'a' || s.shotId === 'b').length === 2, 'real samples kept')
  const realW = 1, priorW = p7m.samples.filter((s) => s.shotId.startsWith('quick-bag')).reduce((s, x) => s + x.weight, 0)
  assert.ok(Math.abs(priorW / (priorW + realW) - (1 - qb.rangeWeight(2, qb.BLEND_RULES.mishit))) < 1e-9)
  assert.ok(players.find((p) => p.club === 'LW').samples.length > 20)

  // --- no prior: nothing changes
  const untouched = applyQuickBagToProfileSet(measured, null)
  assert.equal(untouched.clubs.length, 1)
  assert.deepEqual(untouched.starting_bag, {})

  // --- who gets the step: a bag with fewer than half its clubs measured on the range
  const store = new Map()
  globalThis.window = {
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    dispatchEvent() {}, addEventListener() {}, removeEventListener() {},
  }
  globalThis.localStorage = globalThis.window.localStorage
  const { needsQuickBagStep, measuredClubs, rangeSwingsByClub, skipQuickBag } = await load('/src/lib/quickBagStore.ts')
  const { saveBagConfig } = await load('/src/lib/bagConfig.ts')
  saveBagConfig(clubs)
  const session = (club, n) => ({ id: `s-${club}`, shots: Array.from({ length: n }, (_, i) => ({ id: `${club}${i}`, club, included: true, carryYards: 150, offlineYards: 0 })), metadata: {} })
  assert.equal(needsQuickBagStep([]), true, 'no range data: the step')
  // Dave: 16 swings on two clubs; Nathan: 10 over three. Neither bag is ready.
  assert.equal(needsQuickBagStep([session('7i', 10), session('PW', 6)]), true)
  assert.deepEqual(measuredClubs([session('7i', 10), session('PW', 6)], clubs), ['7i', 'PW'])
  assert.equal(rangeSwingsByClub([session('7i', 10)]).get('7i'), 10)
  // Brian: most of the bag measured → no step.
  assert.equal(needsQuickBagStep(clubs.slice(0, 7).map((c) => session(c, 8))), false)
  skipQuickBag()
  assert.equal(needsQuickBagStep([]), false, 'skipped: not asked again')

  console.log('quick bag: ok')
} finally {
  if (server) await server.close()
}
