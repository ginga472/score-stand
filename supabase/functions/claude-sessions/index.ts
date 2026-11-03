// claude-sessions: the only door Claude has into your practice data.
//
// Claude sends its own key in the `x-claude-key` header. The key is a long random secret set with
// `supabase secrets set CLAUDE_SESSIONS_KEY=…`; change it to lock Claude out. It is never in the app.
// With a valid key this function can do exactly three things:
//   {"action": "list"}                                  recent sessions (summary only)
//   {"action": "get",   "name": "session-….json"}       one session file
//   {"action": "notes", "name": "session-….json", "notes": {…}}   save Claude's review
// Deploy with: supabase functions deploy claude-sessions --no-verify-jwt
// (the key check below replaces Supabase's JWT check; there's no user session here).

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const KEY = Deno.env.get("CLAUDE_SESSIONS_KEY") ?? "";
const NAME = /^session-\d{4}-\d{2}-\d{2}-\d{6}\.json$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function sha(s: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}
// Constant-time comparison, on digests so the lengths always match.
async function keyOk(given: string) {
  if (KEY.length < 32) return false;  // refuse to run with a missing or weak key
  const [a, b] = await Promise.all([sha(given), sha(KEY)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function db(path: string, init: RequestInit = {}) {
  return fetch(`${URL_}${path}`, {
    ...init,
    headers: {
      apikey: SERVICE, Authorization: `Bearer ${SERVICE}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
}

// Same rules as the app's parseNotes: plain strings, bounded sizes.
function cleanNotes(n: any, name: string) {
  if (!n || typeof n !== "object") return null;
  const str = (x: unknown, max: number) => (typeof x === "string" ? x.slice(0, max) : "");
  const strs = (a: unknown) => (Array.isArray(a) ? a.filter((x) => typeof x === "string").map((x) => x.slice(0, 400)).slice(0, 12) : []);
  return {
    woodshed: 1,
    session: name,
    by: str(n.by, 40).trim(),
    headline: str(n.headline, 300),
    breakdown: (Array.isArray(n.breakdown) ? n.breakdown : [])
      .filter((b: any) => b && typeof b.label === "string" && Number.isFinite(b.min) && b.min >= 0)
      .map((b: any) => ({ label: b.label.slice(0, 120), min: Math.round(b.min * 10) / 10 }))
      .slice(0, 12),
    findings: strs(n.findings),
    next: strs(n.next),
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!(await keyOk(req.headers.get("x-claude-key") ?? ""))) return json({ error: "unauthorized" }, 401);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  if (body.action === "list") {
    const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 100);
    const r = await db(`/rest/v1/practice_sessions?select=name,started_at,duration_ms,playing_ms,note_count,pieces,sprint_rounds,review_at&order=started_at.desc&limit=${limit}`);
    return json(await r.json(), r.status);
  }

  if (typeof body.name !== "string" || !NAME.test(body.name)) return json({ error: "bad session name" }, 400);
  const rows = await (await db(`/rest/v1/practice_sessions?select=owner&name=eq.${body.name}&limit=1`)).json();
  if (!Array.isArray(rows) || !rows.length) return json({ error: "no such session" }, 404);
  const owner = rows[0].owner;

  if (body.action === "get") {
    const r = await db(`/storage/v1/object/sessions/${owner}/${body.name}`);
    if (!r.ok) return json({ error: `download failed (${r.status})` }, 502);
    return new Response(await r.text(), { headers: { "Content-Type": "application/json" } });
  }

  if (body.action === "notes") {
    const notes = cleanNotes(body.notes, body.name);
    if (!notes || JSON.stringify(notes).length > 100_000) return json({ error: "bad notes" }, 400);
    const r = await db(`/rest/v1/practice_sessions?owner=eq.${owner}&name=eq.${body.name}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ review: notes, review_at: new Date().toISOString() }),
    });
    return r.ok ? json({ ok: true }) : json({ error: `save failed (${r.status})` }, 502);
  }

  return json({ error: "unknown action" }, 400);
});
