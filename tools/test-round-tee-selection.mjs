import assert from 'node:assert/strict'

const normalizeWhitespace = (value) => value.trim().replace(/\s+/g, ' ')
const normalizeTeeSet = (value) => normalizeWhitespace(value).toLowerCase()

assert.equal(normalizeTeeSet(' Blue '), 'blue')
assert.equal(normalizeTeeSet('Blue / White'), 'blue / white')
assert.equal(normalizeTeeSet('  Championship   Black  '), 'championship black')
assert.equal(normalizeTeeSet(''), '')

console.log('round tee selection normalization: ok')
