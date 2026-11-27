// Named shot variants by voice: each variant's name as the words a player says (Brian, 27 Nov).
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
  const { spokenVariantPhrase, numberWords } = await load('/src/lib/voiceVariants.ts')
  assert.equal(numberWords(7), 'seven')
  assert.equal(numberWords(52), 'fifty two')
  assert.equal(numberWords(60), 'sixty')
  assert.equal(numberWords(120), null)

  // The one Brian named.
  assert.equal(spokenVariantPhrase('1 inch choke down', '7i'), 'one inch choke down')
  assert.equal(spokenVariantPhrase('1in choke down', '7i'), 'one inch choke down')
  assert.equal(spokenVariantPhrase('1 in choke down', '7i'), 'one inch choke down')
  assert.equal(spokenVariantPhrase('Choke down 1"', '7i'), 'choke down one inch')
  // A name that repeats its own club drops it: the club is said already.
  assert.equal(spokenVariantPhrase('7i 1 inch choke down', '7i'), 'one inch choke down')
  assert.equal(spokenVariantPhrase('Seven iron knockdown', '7i'), 'knockdown')
  assert.equal(spokenVariantPhrase('PW 3/4', 'PW'), 'three quarter')
  assert.equal(spokenVariantPhrase('Pitching wedge half', 'PW'), 'half')
  // Another club's name stays ("7i" inside a 6i variant is part of the name).
  assert.equal(spokenVariantPhrase('Knockdown', undefined), 'knockdown')
  assert.equal(spokenVariantPhrase('3/4 swing'), 'three quarter swing')
  assert.equal(spokenVariantPhrase('Low-spin punch'), 'low spin punch')
  // "in" is inches only after a number.
  assert.equal(spokenVariantPhrase('Ball back in stance'), 'ball back in stance')
  // Nothing sayable, or too long for one breath.
  assert.equal(spokenVariantPhrase('!!!'), null)
  assert.equal(spokenVariantPhrase('7i', '7i'), null)
  assert.equal(spokenVariantPhrase('a very long name nobody would ever say out loud'), null)
  console.log('voice variants: ok')
} finally {
  await server?.close()
}
