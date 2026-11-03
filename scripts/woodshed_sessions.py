#!/usr/bin/env python3
"""Claude's side of Woodshed session sync: talks to the claude-sessions edge function.

Needs CLAUDE_SESSIONS_KEY in the environment (the same secret set on the function).
  python3 -I woodshed_sessions.py list [N]               recent sessions, newest first
  python3 -I woodshed_sessions.py get NAME [OUT.json]     download one session file
  python3 -I woodshed_sessions.py notes NAME NOTES.json   save a review (the woodshed block's JSON)
Uses only the standard library; HTTPS_PROXY and SSL_CERT_FILE are honored.
"""
import json, os, ssl, sys, urllib.request

ENDPOINT = os.environ.get("WOODSHED_ENDPOINT", "https://wmaofvonemfhqsyfesof.supabase.co/functions/v1/claude-sessions")


def call(payload, raw=False):
    key = os.environ.get("CLAUDE_SESSIONS_KEY")
    if not key:
        sys.exit("CLAUDE_SESSIONS_KEY isn't set in this environment.")
    req = urllib.request.Request(ENDPOINT, data=json.dumps(payload).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "x-claude-key": key})
    ctx = ssl.create_default_context(cafile=os.environ.get("SSL_CERT_FILE") or None)
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=60) as r:
            body = r.read().decode()
    except urllib.error.HTTPError as e:
        sys.exit(f"{e.code}: {e.read().decode()[:300]}")
    return body if raw else json.loads(body)


def main(argv):
    if not argv:
        sys.exit(__doc__)
    cmd = argv[0]
    if cmd == "list":
        for s in call({"action": "list", "limit": int(argv[1]) if len(argv) > 1 else 20}):
            mins = lambda ms: f"{round(ms / 60000)} min"
            print(f"{s['name']}  {s['started_at'][:16]}  {mins(s['duration_ms'])} long, {mins(s['playing_ms'])} playing"
                  f"  {', '.join(s['pieces']) or '-'}  sprint×{s['sprint_rounds']}  {'reviewed' if s['review_at'] else 'not reviewed'}")
    elif cmd == "get" and len(argv) >= 2:
        text = call({"action": "get", "name": argv[1]}, raw=True)
        out = argv[2] if len(argv) > 2 else argv[1]
        with open(out, "w") as f:
            f.write(text)
        print(f"saved {out}")
    elif cmd == "notes" and len(argv) == 3:
        with open(argv[2]) as f:
            notes = json.load(f)
        print(call({"action": "notes", "name": argv[1], "notes": notes}))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
