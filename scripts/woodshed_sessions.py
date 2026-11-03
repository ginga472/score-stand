#!/usr/bin/env python3
"""Reviewer side of Woodshed session sync (used by Claude).

Signs in to Supabase as the reviewer account, which the database only lets read your
practice sessions and save notes on them (see supabase/sessions.sql). No admin key.
Needs WOODSHED_REVIEWER_EMAIL and WOODSHED_REVIEWER_PASSWORD in the environment.
  python3 -I woodshed_sessions.py list [N]               recent sessions, newest first
  python3 -I woodshed_sessions.py get NAME [OUT.json]     download one session file
  python3 -I woodshed_sessions.py notes NAME NOTES.json   save notes (the woodshed block's JSON)
Uses only the standard library; HTTPS_PROXY and SSL_CERT_FILE are honored.
"""
import json, os, re, ssl, sys, urllib.parse, urllib.request

# Public by design (same values as js/config.js): they identify the project, they grant nothing.
URL = os.environ.get("WOODSHED_SUPABASE_URL", "https://wmaofvonemfhqsyfesof.supabase.co")
KEY = os.environ.get("WOODSHED_SUPABASE_KEY", "sb_publishable_e17Lps_hlM_JxYHQ5GXmJw_fC6tQUQC")
NAME = re.compile(r"^session-\d{4}-\d{2}-\d{2}-\d{6}\.json$")
CTX = ssl.create_default_context(cafile=os.environ.get("SSL_CERT_FILE") or None)
_token = None


def http(method, path, body=None, auth=True, raw=False):
    headers = {"apikey": KEY, "Content-Type": "application/json"}
    if auth:
        headers["Authorization"] = f"Bearer {token()}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, context=CTX, timeout=60) as r:
            text = r.read().decode()
    except urllib.error.HTTPError as e:
        sys.exit(f"{e.code}: {e.read().decode()[:300]}")
    return text if raw else json.loads(text or "null")


def token():
    global _token
    if not _token:
        email, pw = os.environ.get("WOODSHED_REVIEWER_EMAIL"), os.environ.get("WOODSHED_REVIEWER_PASSWORD")
        if not email or not pw:
            sys.exit("WOODSHED_REVIEWER_EMAIL and WOODSHED_REVIEWER_PASSWORD aren't set in this environment.")
        _token = http("POST", "/auth/v1/token?grant_type=password", {"email": email, "password": pw}, auth=False)["access_token"]
    return _token


def row(name):
    if not NAME.match(name):
        sys.exit(f"not a session file name: {name}")
    rows = http("GET", f"/rest/v1/practice_sessions?select=owner,name&name=eq.{urllib.parse.quote(name)}")
    if not rows:
        sys.exit(f"no session called {name}")
    return rows[0]


def clean(n, name):
    """Same shape and limits as the app's parseNotes."""
    s = lambda x, m: x[:m] if isinstance(x, str) else ""
    strs = lambda a: [x[:400] for x in a if isinstance(x, str)][:12] if isinstance(a, list) else []
    bd = [b for b in (n.get("breakdown") or []) if isinstance(b, dict) and isinstance(b.get("label"), str)
          and isinstance(b.get("min"), (int, float)) and b["min"] >= 0]
    return {"woodshed": 1, "session": name, "by": s(n.get("by", "Claude"), 40).strip(),
            "headline": s(n.get("headline"), 300),
            "breakdown": [{"label": b["label"][:120], "min": round(b["min"], 1)} for b in bd][:12],
            "findings": strs(n.get("findings")), "next": strs(n.get("next"))}


def main(argv):
    if not argv:
        sys.exit(__doc__)
    cmd = argv[0]
    if cmd == "list":
        limit = max(1, min(int(argv[1]) if len(argv) > 1 else 20, 100))
        rows = http("GET", "/rest/v1/practice_sessions?select=name,started_at,duration_ms,playing_ms,note_count,pieces,"
                           f"sprint_rounds,review_at&order=started_at.desc&limit={limit}")
        mins = lambda ms: f"{round(ms / 60000)} min"
        for s in rows:
            print(f"{s['name']}  {s['started_at'][:16]}  {mins(s['duration_ms'])} long, {mins(s['playing_ms'])} playing"
                  f"  {', '.join(s['pieces']) or '-'}  sprint×{s['sprint_rounds']}  {'has notes' if s['review_at'] else 'no notes'}")
    elif cmd == "get" and len(argv) >= 2:
        r = row(argv[1])
        text = http("GET", f"/storage/v1/object/authenticated/sessions/{r['owner']}/{r['name']}", raw=True)
        out = argv[2] if len(argv) > 2 else argv[1]
        with open(out, "w") as f:
            f.write(text)
        print(f"saved {out}")
    elif cmd == "notes" and len(argv) == 3:
        r = row(argv[1])
        with open(argv[2]) as f:
            notes = clean(json.load(f), r["name"])
        ok = http("POST", "/rest/v1/rpc/save_session_notes", {"p_name": r["name"], "p_notes": notes})
        print("saved" if ok else "not saved (no access to that session)")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
