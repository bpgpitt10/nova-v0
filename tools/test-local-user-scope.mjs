// One browser, two accounts: the second must never see or save the first one's local data (23 Nov 2026).
// Run: node tools/test-local-user-scope.mjs
import assert from 'node:assert/strict'
import { createServer } from 'vite'

// A browser store with a size limit, like the real 5 MB one.
let quota = Infinity
const sizeOf = (store) => Object.entries(store).reduce((n, [k, v]) => n + k.length + v.length, 0)
const makeWindow = (store) => {
  const listeners = {}
  return {
    reloads: 0,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        const next = sizeOf(store) - (k in store ? k.length + store[k].length : 0) + k.length + String(v).length
        if (next > quota) throw new Error(`Setting the value of '${k}' exceeded the quota.`)
        store[k] = String(v)
      },
      removeItem: (k) => { delete store[k] },
      key: (i) => Object.keys(store)[i] ?? null,
      get length() { return Object.keys(store).length },
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

// A full store (23 Nov 2026: two accounts' round archives filled it; sign-in and sign-out both failed).
const ARCHIVE = 'looper-live-gspro-round-archive-v1'
const full = {}
const big = 'x'.repeat(400)
const c = await tab(full)
c.scope.activateLocalUserScope('A')
c.window.localStorage.setItem(ARCHIVE, big); c.scope.persistWorkingCacheValueForActiveUser(ARCHIVE, big)
c.window.localStorage.setItem(SESSIONS, 'A-sessions'); c.scope.persistWorkingCacheValueForActiveUser(SESSIONS, 'A-sessions')
full[`${ARCHIVE}:user:GONE`] = big                                   // a deleted account's copy
full[`looper-unscoped-legacy-backup-v1:${ARCHIVE}`] = big            // an old backup
quota = sizeOf(full) + 40                                            // no room for another archive
c.scope.deactivateLocalUserScope()                                   // signing out must not throw
assert.equal(full[ARCHIVE], undefined)
assert.equal(full[`${SESSIONS}:user:A`], 'A-sessions', 'the player’s own data is kept')
c.scope.activateLocalUserScope('B')                                  // nor signing in as someone else
c.window.localStorage.removeItem(ARCHIVE)
c.scope.persistWorkingCacheValueForActiveUser(ARCHIVE, big)          // B's archive needs the room
assert.equal(full[`${ARCHIVE}:user:B`], big, 'room was made for the signed-in account')
assert.equal(full[`${ARCHIVE}:user:GONE`], undefined, 'by dropping other accounts’ rebuildable copies')
assert.equal(full[`looper-unscoped-legacy-backup-v1:${ARCHIVE}`], undefined)
assert.equal(full[`${SESSIONS}:user:A`], 'A-sessions', 'never anyone’s sessions')
quota = Infinity

await Promise.all([a.close(), b.close(), b2.close(), c.close()])
console.log('local user scope ok')
