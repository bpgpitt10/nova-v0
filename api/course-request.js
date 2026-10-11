// Staging-only, authenticated admin request -> one GitHub Actions branch push.
// The token is server-side and never included in client assets.
const REPO = 'bpgpitt10/nova-v0'
const BRANCH = 'web-course-e2e-preflight-v1'
const REQUEST_FILE = 'config/course-name-request.json'
const SUPABASE_URL = 'https://kdjfdchzfemjpmaqpobn.supabase.co'
// Supabase publishable key, not a service-role credential.
const PUBLIC_KEY = 'sb_publishable_Lu_EV3L6mSIzQzcB0fESsA_4bJcnT4T'

async function supabaseGet(path, token) {
  const response = await fetch(SUPABASE_URL + path, { headers: {
    apikey: PUBLIC_KEY, authorization: 'Bearer ' + token
  } })
  if (!response.ok) throw Object.assign(new Error('Authorization failed'), { status: 403 })
  return response.json()
}
async function githubRequest(path, token, options = {}) {
  const response = await fetch('https://api.github.com/repos/' + REPO + '/' + path, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: 'Bearer ' + token,
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      ...(options.headers || {})
    },
  })
  if (!response.ok && response.status !== 404) {
    throw Object.assign(new Error('GitHub request failed (' + response.status + ')'), { status: 502 })
  }
  return { response, body: response.status === 404 ? null : await response.json() }
}
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (process.env.VERCEL_GIT_COMMIT_REF !== BRANCH) return res.status(403).json({ error: 'Staging only' })
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
  if (name.length < 3 || name.length > 120 || /[\x00-\x1F\x7F]/.test(name)) {
    return res.status(400).json({ error: 'Enter a course name of 3–120 characters.' })
  }
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')
  if (!bearer) return res.status(401).json({ error: 'Sign in before requesting a course.' })
  const githubToken = process.env.LOOPER_GITHUB_DISPATCH_TOKEN
  if (!githubToken) return res.status(503).json({ error: 'Staging course dispatcher is not configured yet.' })
  try {
    const user = await supabaseGet('/auth/v1/user', bearer[1])
    if (!user.email) return res.status(403).json({ error: 'Admin access required' })
    const users = await supabaseGet(
      '/rest/v1/allowed_users?select=enabled,is_admin&email=eq.' + encodeURIComponent(user.email.toLowerCase()) + '&limit=1',
      bearer[1]
    )
    if (!Array.isArray(users) || users.length !== 1 || users[0].enabled !== true || users[0].is_admin !== true) {
      return res.status(403).json({ error: 'Admin access required' })
    }
    const existing = await githubRequest('contents/' + REQUEST_FILE + '?ref=' + BRANCH, githubToken)
    if (existing.body?.content) {
      const raw = Buffer.from(existing.body.content, 'base64').toString('utf8')
      const prev = JSON.parse(raw)
      const last = Date.parse(prev.requestedAt || '')
      if (Number.isFinite(last) && Date.now() - last < 60_000) return res.status(429).json({ error: 'An import was just requested. Retry later.' })
    }
    const accepted = new Date().toISOString()
    const request = { schemaVersion: 'looper-course-name-request-v1', name, requestedAt: accepted }
    const body = {
      message: 'request(course): name-only staged import',
      branch: BRANCH,
      content: Buffer.from(JSON.stringify(request, null, 2) + '\n').toString('base64'),
      ...(existing.body?.sha ? { sha: existing.body.sha } : {})
    }
    const result = await githubRequest('contents/' + REQUEST_FILE, githubToken, {
      method: 'PUT', body: JSON.stringify(body),
    })
    if (!result.body?.commit?.sha) throw Object.assign(new Error('Import request was not committed'), { status: 502 })
    return res.status(202).json({ accepted: true, requestedAt: accepted, requestCommit: result.body.commit.sha,
      status: 'queued', note: 'Monitor GitHub Actions Rebuild Course Canonical; course is not ready yet.' })
  } catch (e) {
    return res.status(e?.status || 502).json({ error: e?.message || 'Unable to queue course request.' })
  }
}
