import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

const read = path => readFileSync(path,'utf8')
const page = read('src/pages/LiveCaddiePage.tsx')
const main = read('src/main.tsx')
const auth = read('src/components/LooperAuthGate.tsx')
const gsproGate = read('src/components/BrowserGsproSetupGate.tsx')
const land = read('src/pages/LooperLandingPage.tsx')
const tune = read('src/pages/LiveCaddieDesignTune.css')
const polish = read('src/pages/LiveCaddieMapPolish.css')
const course = read('src/courseGeometry/liveSupportedTee.ts')

const requiredPage = [
  'loadCourseGreenDetail', 'sampleCourseGreenElevation',
  'buildCourseGreenApproachTarget', 'exactPinLocalYds: trustedLivePin',
  "greenDetail: trustedLivePin", "shotOrigin,",
  'publishOneShotCompanionHud', 'measuredPreShotTee',
  'clubEligibleForShot', 'surfaceOverride',
]
for(const part of requiredPage) assert.ok(page.includes(part), 'Required Live Caddie functionality lost: '+part)
assert.ok(main.includes('RoundSetupPage'), 'new round setup must route')
assert.ok(main.includes("pathname === '/round-setup'"), 'missing new round URL')
assert.ok(main.includes('LiveCaddieRoundBootstrap'), 'existing round lifecycle startup is required')
assert.ok(auth.includes('signUpLooperWithPassword'), 'preserve production open signup')
assert.ok(gsproGate.includes('publishLiveCaddieProfilesToGsproFolder'), 'preserve browser GSPro profile bridge')
assert.ok(land.includes('LooperLandingPage') || land.includes('export default'), 'production landing page lost')
assert.ok(tune.includes('--live-map-card-width'), 'FarmLinks review header/map alignment omitted')
assert.ok(polish.includes('probability-50'), 'reviewed dispersion contours lost')
assert.ok(course.includes('matchProvisionalOsmTeeByDistance'), 'first-use tee resolver lost')
assert.ok(existsSync('src/adapters/looperCompanion.ts'), 'companion required for read-only OCR')
assert.ok(existsSync('src/liveCaddie/clubShotEligibility.ts'), 'hard driver rule must ship')
assert.ok(existsSync('public/course-geometry/farmlinks/course-v1.json'), 'FarmLinks package missing')
console.log('PASS: production auth/setup/landing and green LiDAR preserved, FarmLinks first-use/Driver/surface paths integrated, reviewed Live Caddie visual changes present.')
