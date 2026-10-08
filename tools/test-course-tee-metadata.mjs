import assert from 'node:assert/strict'
import { applyCourseTeeMetadata } from '../src/courseGeometry/courseTeeMetadata.ts'

const courseId = 'farmlinks-pursell-farms-sylacauga-al'
const candidates = [
  { teeSet: 'Tee 5 (Front)', teeAliases: ['Tee 5 (Front)'], coursePoint: [0, 100] },
  { teeSet: 'Tee 4', teeAliases: ['Tee 4'], coursePoint: [0, 75] },
  { teeSet: 'Tee 3', teeAliases: ['Tee 3'], coursePoint: [0, 50] },
  { teeSet: 'Tee 2', teeAliases: ['Tee 2'], coursePoint: [0, 25] },
  { teeSet: 'Tee 1 (Back)', teeAliases: ['Tee 1 (Back)'], coursePoint: [0, 0] },
]

const enriched = applyCourseTeeMetadata(courseId, candidates)
assert.deepEqual(enriched.map((candidate) => candidate.teeSet), ['Red', 'Green', 'White', 'Gold', 'Black'])
assert.equal(enriched[4].color, 'Black')
assert.ok(enriched[4].teeAliases.includes('Longhorn'))
assert.ok(enriched[4].teeAliases.includes('Tee 1 (Back)'))
assert.ok(enriched[3].teeAliases.includes('Copperhead'))
assert.ok(enriched[3].teeAliases.includes('Yellow'))

const shared = applyCourseTeeMetadata(courseId, [{
  teeSet: 'Tee 4',
  teeAliases: ['Tee 4', 'Tee 3'],
  coursePoint: [0, 60],
}])[0]
assert.equal(shared.teeSet, 'Green')
assert.ok(shared.teeAliases.includes('White'))
assert.ok(shared.teeAliases.includes('Whitetail'))

const unassigned = applyCourseTeeMetadata(courseId, [{ coursePoint: [0, 0] }])[0]
assert.equal(unassigned.teeSet, undefined)

const otherCourse = applyCourseTeeMetadata('greywolf-panorama-bc', candidates)
assert.equal(otherCourse[4].teeSet, 'Tee 1 (Back)')

console.log('reviewed course tee metadata enrichment: ok')
