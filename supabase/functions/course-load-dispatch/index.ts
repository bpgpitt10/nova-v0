// Starts the GitHub Actions course loader right after a player queues a
// course (instead of waiting for the 6-hourly backstop). Requires a signed-in
// Looper user (verify_jwt) and the GITHUB_DISPATCH_TOKEN secret: a
// fine-grained token with Actions read/write on bpgpitt10/nova-v0 only.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ALLOWED_ORIGIN = /^(https:\/\/(www\.)?thelooper\.golf|https:\/\/(looper|looper-web)[a-z0-9-]*-wqk25hkxcg-3591\.vercel\.app|http:\/\/(localhost|127\.0\.0\.1):5173)$/;
const WORKFLOW = "https://api.github.com/repos/bpgpitt10/nova-v0/actions/workflows/course-load-worker.yml/dispatches";

const cors = (origin: string | null) => ({
  ...(origin && ALLOWED_ORIGIN.test(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
});

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");
  const headers = { ...cors(origin), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "method" }), { status: 405, headers });
  const token = Deno.env.get("GITHUB_DISPATCH_TOKEN");
  if (!token) {
    return new Response(JSON.stringify({ dispatched: false, reason: "no-dispatch-token" }), { status: 200, headers });
  }
  const response = await fetch(WORKFLOW, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "looper-course-loader",
    },
    body: JSON.stringify({ ref: "web-alpha-mishits" }),
  });
  return new Response(
    JSON.stringify({ dispatched: response.status === 204, status: response.status }),
    { status: 200, headers },
  );
});
