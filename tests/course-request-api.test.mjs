import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import handler from '../api/course-request.js'

const realFetch = globalThis.fetch
const originalEnv = {
  VERCEL_GIT_COMMIT_REF: process.env.VERCEL_GIT_COMMIT_REF,
  LOOPER_GITHUB_DISPATCH_TOKEN: process.env.LOOPER_GITHUB_DISPATCH_TOKEN,
}

function response(code, value) {
  return { ok: code >= 200 && code < 300, status: code, async json() { return value } }
}
function res() {
  const state = { headers: {}, status: 0, payload: null }
  return {
    state,
    setHeader(key, value) { state.headers[key] = value; return this },
    status(code) { state.status = code; return this },
    json(payload) { state.payload = payload; return this },
  }
}
function req(name = 'Offline Fixture GC', token = 'test-session-token') {
  return { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: { name } }
}
function goodFetch({ existing = null, mutateStatus = 201, userAdmin = true, events = [] } = {}) {
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url)
    events.push({ url: u, method: options.method ?? 'GET', headers: options.headers, body: options.body })
    if (u.endsWith('/auth/v1/user')) {
      assert.equal(options.headers.authorization, 'Bearer test-session-token')
      return response(200, { id: 'uid-123', email: 'admin@example.net' })
    }
    if (u.includes('/rest/v1/allowed_users?')) {
      return response(200, [{ enabled: true, is_admin: userAdmin }])
    }
    if (u.includes('api.github.com') && (options.method ?? 'GET') === 'GET') {
      return existing ? response(200, existing) : response(404, { message: 'Not Found' })
    }
    if (u.includes('api.github.com') && options.method === 'PUT') {
      return response(mutateStatus, { commit: { sha: 'commit-fixture' } })
    }
    throw Error('Unexpected external request ' + u)
  }
  return events
}
beforeEach(() => {
  process.env.VERCEL_GIT_COMMIT_REF = 'web-course-e2e-preflight-v1'
  process.env.LOOPER_GITHUB_DISPATCH_TOKEN = 'fixture-only-token'
})
afterEach(() => {
  globalThis.fetch = realFetch
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})
test('rejects non-POST requests and production domain invocation before networking', async () => {
  const events = goodFetch()
  const x = res()
  await handler({ ...req(), method: 'GET' }, x)
  assert.equal(x.state.status, 405)
  process.env.VERCEL_GIT_COMMIT_REF = 'web-alpha-mishits'
  const y = res()
  await handler(req(), y)
  assert.equal(y.state.status, 403)
  assert.equal(events.length, 0)
})
test('rejects invalid names, missing session and missing server token without network calls', async () => {
  const events = goodFetch()
  for (const name of ['X', 'A'.repeat(121), 'bad\u0000name']) {
    const x = res()
    await handler(req(name), x)
    assert.equal(x.state.status, 400)
  }
  const y = res()
  await handler({ method: 'POST', headers: {}, body: { name: 'Offline Fixture GC' } }, y)
  assert.equal(y.state.status, 401)
  delete process.env.LOOPER_GITHUB_DISPATCH_TOKEN
  const z = res()
  await handler(req(), z)
  assert.equal(z.state.status, 503)
  assert.equal(events.length, 0)
})
test('non-admin cannot create GitHub content', async () => {
  const events = goodFetch({ userAdmin: false })
  const x = res()
  await handler(req(), x)
  assert.equal(x.state.status, 403)
  assert.equal(events.filter(e => e.url.includes('api.github.com')).length, 0)
})
test('authorised request writes only fixed branch and fixed file, with UTC requestedAt', async () => {
  const events = goodFetch()
  const x = res()
  await handler(req(), x)
  assert.equal(x.state.status, 202)
  assert.equal(x.state.payload.accepted, true)
  const put = events.find(e => e.method === 'PUT')
  assert.ok(put.url.endsWith('/contents/config/course-name-request.json'))
  const body = JSON.parse(put.body)
  assert.equal(body.branch, 'web-course-e2e-preflight-v1')
  const request = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'))
  assert.equal(request.name, 'Offline Fixture GC')
  assert.equal(request.schemaVersion, 'looper-course-name-request-v1')
  assert.ok(!body.sha)
  assert.ok(events.every(e => !e.url.includes('Offline%20Fixture') && !e.url.includes('fixture-only-token')))
})
test('recent request blocks another import for 45 minutes, with Retry-After', async () => {
  const existing = { sha: 'old-blob', content: Buffer.from(JSON.stringify({
    requestedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  })).toString('base64') }
  const events = goodFetch({ existing })
  const x = res()
  await handler(req('Different GC'), x)
  assert.equal(x.state.status, 429)
  assert.ok(Number(x.state.headers['Retry-After']) > 1800)
  assert.equal(events.filter(e => e.method === 'PUT').length, 0)
})
test('GitHub concurrent content conflict remains non-successful', async () => {
  const events = goodFetch({ mutateStatus: 409 })
  const x = res()
  await handler(req(), x)
  assert.equal(x.state.status, 409)
  assert.equal(x.state.payload.accepted, undefined)
  assert.equal(events.filter(e => e.method === 'PUT').length, 1)
})
