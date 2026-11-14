#!/usr/bin/env python3
"""Reviewer side of Woodshed session sync (used by Claude).

Signs in to Supabase as the reviewer account, which the database only lets read your
practice sessions and save notes on them (see supabase/sessions.sql). No admin key.
Needs WOODSHED_REVIEWER_EMAIL and WOODSHED_REVIEWER_PASSWORD in the environment.
  python3 -I woodshed_sessions.py list [N]               recent sessions, newest first
  python3 -I woodshed_sessions.py get NAME [OUT.json]     download one session file
  python3 -I woodshed_sessions.py notes NAME NOTES.json   save notes (the woodshed block's JSON)
  python3 -I woodshed_sessions.py clicks FILE.json        metronome and plan-block summary of a downloaded session
  python3 -I woodshed_sessions.py add-score FILE.pdf "Title" [tag ...]
                                                          add a new PDF to the library (score inbox, add-only;
                                                          see supabase/score-inbox.sql). Needs pypdf for the page count.
  python3 -I woodshed_sessions.py my-scores              scores this account added that are still in the library
  python3 -I woodshed_sessions.py remove-score ID        remove one of those (never any other score)
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
            "findings": strs(n.get("findings")), "next": strs(n.get("next")), **plan(n.get("plan"))}


def boxes(a):
    """[page, x, y, w, h] fractions from scripts/score_bars.py box; same checks as parseBoxes."""
    ok = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and 0 <= v <= 1
    rows = [r for r in a if isinstance(r, list) and len(r) == 5 and isinstance(r[0], int) and 1 <= r[0] <= 999
            and all(ok(v) for v in r[1:]) and r[3] > 0.01 and r[4] > 0.01] if isinstance(a, list) else []
    return [[r[0]] + [round(v, 4) for v in r[1:]] for r in rows][:6]


def plan(p):
    """Optional next-session plan, same limits as parsePlan in js/sessions.js."""
    if not isinstance(p, dict) or not isinstance(p.get("blocks"), list):
        return {}
    s = lambda x, m: x.strip()[:m] if isinstance(x, str) else ""
    num = lambda x, lo, hi: round(x) if isinstance(x, (int, float)) and not isinstance(x, bool) and lo <= x <= hi else None
    blocks = [{"label": s(b["label"], 120), "score": s(b.get("score"), 120), "page": num(b.get("page"), 1, 999),
               "bars": s(b.get("bars"), 40), "min": num(b.get("min"), 1, 30) or 10, "bpm": num(b.get("bpm"), 20, 240),
               "goal": s(b.get("goal"), 200), "boxes": boxes(b.get("boxes"))}
              for b in p["blocks"] if isinstance(b, dict) and s(b.get("label"), 120)][:4]
    return {"plan": {"note": s(p.get("note"), 200), "blocks": blocks}} if blocks else {}


def clicks(path, tol=60):
    """How closely the playing followed the built-in metronome, plus the plan blocks that were started
    and any pauses (Alan paused recording; that time isn't practice or idle).
    Note onsets (chords grouped within 60 ms) are compared with the eighth-note grid of the clicks as
    heard (downbeatMs + latencyMs). "with click" = within ±tol ms; chance = what random playing would get."""
    import statistics as st
    d = json.load(open(path))
    marks = sorted(d.get("markers", []), key=lambda m: m.get("ms", 0))
    end = d.get("durationMs", 0)
    onsets = []
    for e in d.get("events", []):
        if e[1] & 0xF0 == 0x90 and e[3] > 0 and (not onsets or e[0] - onsets[-1] > 60):
            onsets.append(e[0])
    clock = lambda ms: f"{ms // 60000}:{ms // 1000 % 60:02d}"
    runs = [m for m in marks if m.get("k") == "metronome"]
    if not runs:
        print("metronome: not used")
    for i, m in enumerate(runs):
        if not m.get("on"):
            continue
        stop = next((r["ms"] for r in runs[i + 1:]), end)
        bpm, lat = m["bpm"], m.get("latencyMs", 0)
        period = 60000 / bpm / 2
        heard = m["downbeatMs"] + lat
        on = [t for t in onsets if m["ms"] <= t < stop]
        off = lambda t: (t - heard + period / 2) % period - period / 2  # signed: negative = ahead of the click
        chance = min(1, 2 * tol / period)
        print(f"metronome {clock(m['ms'])}-{clock(stop)} at {bpm} bpm (accent {m.get('beats')}, clicks/beat {m.get('sub')}), "
              f"{len(on)} onsets, chance {chance:.0%}")
        if not on:
            continue
        offs = [off(t) for t in on]
        print(f"  overall: {sum(abs(o) <= tol for o in offs) / len(offs):.0%} with click, median {st.median(offs):+.0f} ms")
        w = 20000
        for a in range(m["ms"], stop, w):
            win = [off(t) for t in on if a <= t < a + w]
            if len(win) >= 4:
                print(f"  {clock(a)}  {len(win):3} onsets  {sum(abs(o) <= tol for o in win) / len(win):4.0%} with click  "
                      f"median {st.median(win):+5.0f} ms")
    for m in marks:
        k = m.get("k", "")
        if k in ("pause", "resume"):
            print(f"{k} {clock(m['ms'])}")
        if k.startswith("plan_"):
            extra = {x: m[x] for x in ("label", "bars", "min", "bpm", "reason", "playedMin") if x in m}
            print(f"{k} {clock(m['ms'])} {m.get('id', '')} {json.dumps(extra, ensure_ascii=False)}")


def pages(path):
    try:
        from pypdf import PdfReader
    except ImportError:
        sys.exit("pip install pypdf (used to count pages)")
    return len(PdfReader(path).pages)


def add_score(path, title, tags):
    import uuid
    with open(path, "rb") as f:
        data = f.read()
    if not data.startswith(b"%PDF-") or len(data) > 80 * 1024 * 1024:
        sys.exit("not a PDF, or over 80 MB")
    n = pages(path)
    sid = str(uuid.uuid4())
    # The owner's id is the folder name; the reviewer learns it from its readable session rows.
    rows = http("GET", "/rest/v1/practice_sessions?select=owner&limit=1")
    if not rows:
        sys.exit("can't find the owner account (no readable sessions)")
    owner = rows[0]["owner"]
    req = urllib.request.Request(f"{URL}/storage/v1/object/scores/{owner}/{sid}.pdf", data=data, method="POST",
                                 headers={"apikey": KEY, "Authorization": f"Bearer {token()}", "Content-Type": "application/pdf"})
    try:
        urllib.request.urlopen(req, context=CTX, timeout=120).read()
    except urllib.error.HTTPError as e:
        sys.exit(f"upload refused {e.code}: {e.read().decode()[:300]}")
    ok = http("POST", "/rest/v1/rpc/add_score", {"p_id": sid, "p_title": title, "p_page_count": n, "p_tags": tags[:8]})
    print(f"added '{title}' ({n} pages, id {sid})" if ok else "not added")


def remove_score(sid):
    rows = [r for r in http("POST", "/rest/v1/rpc/reviewer_scores_list", {}) if r["id"] == sid]
    if not rows:
        sys.exit("not one of the scores this account added")
    owner = http("GET", "/rest/v1/practice_sessions?select=owner&limit=1")[0]["owner"]
    http("DELETE", f"/storage/v1/object/scores/{owner}/{sid}.pdf")
    ok = http("POST", "/rest/v1/rpc/remove_score", {"p_id": sid})
    print(f"removed '{rows[0]['title']}'" if ok else "not removed")


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
    elif cmd == "add-score" and len(argv) >= 3:
        add_score(argv[1], argv[2], argv[3:])
    elif cmd == "my-scores":
        for r in http("POST", "/rest/v1/rpc/reviewer_scores_list", {}):
            print(f"{r['id']}  {r['added_at'][:10]}  {r['page_count']:3} pp  {r['title']}")
    elif cmd == "remove-score" and len(argv) == 2:
        remove_score(argv[1])
    elif cmd == "clicks" and len(argv) == 2:
        clicks(argv[1])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
