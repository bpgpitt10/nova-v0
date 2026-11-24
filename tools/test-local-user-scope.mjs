// One browser, two accounts: the second must never see or save the first one's local data (23 Nov 2026).
// Run: node tools/test-local-user-scope.mjs
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const makeWindow = (store) => {
  const listeners = {}
  return {
    reloads: 0,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v) },
      removeItem: (k) => { delete store[k] },
    },
    addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn) },
    removeEventListener: () => {},
    dispatchEvent: () => true,
    location: { reload() { globalThis.window.reloads += 1 } },
    fire: (type, event) => (listeners[type] ?? []).forEach((fn) => fn(event)),
  }
}
globalThis.Event = globalThis.Event ?? class { constructor(type) { this.type = type } }

// A fresh copy of the module is a fresh tab; the store is the browser.
const tab = async (store) => {
  globalThis.window = makeWindow(store)
  const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  const scope = await server.ssrLoadModule('/src/lib/localUserScope.ts')
  return { scope, window: globalThis.window, close: () => server.close() }
}
const SESSIONS = 'nova-validation-sessions'
const ACTIVE = 'looper-active-local-user-v1'

const browser = {}
// Account A uses this browser.
const a = await tab(browser)
assert.deepEqual(a.scope.activateLocalUserScope('A'), { replacedAnotherAccount: false })
a.window.localStorage.setItem(SESSIONS, 'A-sessions')
a.scope.persistWorkingCacheValueForActiveUser(SESSIONS, 'A-sessions')
assert.deepEqual(a.scope.activateLocalUserScope('A'), { replacedAnotherAccount: false }, 'a reload as the same account')

// A new tab opens as account B (a verification link) while the browser still belongs to A.
const b = await tab(browser)
assert.equal(b.window.localStorage.getItem(SESSIONS), 'A-sessions', 'what the page would read as it loads')
assert.deepEqual(b.scope.activateLocalUserScope('B'), { replacedAnotherAccount: true }, 'B must reload: the page loaded A’s data')
assert.equal(browser[SESSIONS], undefined, 'B’s working cache starts empty')
assert.equal(browser[`${SESSIONS}:user:A`], 'A-sessions', 'A’s copy is kept under A')
assert.equal(browser[ACTIVE], 'B')
// After the reload the cache is already B’s: no second reload.
const b2 = await tab(browser)
assert.deepEqual(b2.scope.activateLocalUserScope('B'), { replacedAnotherAccount: false })

// A's old tab is still open with A's data in memory. It must not save it under B, and it reloads.
globalThis.window = a.window
assert.equal(a.scope.workingCacheBelongsToThisTab(), false)
a.scope.persistWorkingCacheValueForActiveUser(SESSIONS, 'A-sessions-from-memory')
assert.equal(browser[SESSIONS], undefined, 'nothing of A’s written into B’s cache')
assert.equal(browser[`${SESSIONS}:user:B`], undefined)
a.window.fire('storage', { key: ACTIVE, newValue: 'B' })
assert.equal(a.window.reloads, 1, 'the old tab reloads when another tab switches the account')

// Sign out, then a different account signs in, in the same tab.
globalThis.window = b2.window
b2.scope.deactivateLocalUserScope()
assert.deepEqual(b2.scope.activateLocalUserScope('B'), { replacedAnotherAccount: false }, 'the same account back in')
b2.scope.deactivateLocalUserScope()
assert.deepEqual(b2.scope.activateLocalUserScope('A'), { replacedAnotherAccount: true }, 'a different account in the same tab')
assert.equal(browser[SESSIONS], 'A-sessions', 'A gets A’s own data back')

await Promise.all([a.close(), b.close(), b2.close()])
console.log('local user scope ok')
