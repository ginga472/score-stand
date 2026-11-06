#!/usr/bin/env python3
"""Finds the bars in a piano score PDF, so a plan block can outline exactly the bars it names.

Renders each page (poppler's pdftoppm), finds the grand-staff systems from their staff lines, and
the barlines as the columns that are dark from the top treble line to the bottom bass line
(stems and slurs never cross the gap between the staves). Bars are numbered in reading order
from --first (default 1; use 0 when the piece opens with a pickup bar).

  python3 -I score_bars.py map PDF [--first N]          every bar, page by page
  python3 -I score_bars.py box PDF 15-18 [--first N]    boxes for a plan block's "boxes" field
  python3 -I score_bars.py check PDF PAGE OUT.png       draws the numbered bars on a page, to eyeball
  --from-page P   start numbering on page P (a later movement); earlier pages are skipped

Boxes are [page, x, y, w, h] as fractions of the page (a passage that wraps gives one per system).
Needs numpy and Pillow.
"""
import json, os, subprocess, sys, tempfile

import numpy as np
from PIL import Image, ImageDraw

DPI = 150


def pages(pdf):
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["pdftoppm", "-r", str(DPI), "-gray", "-png", pdf, os.path.join(tmp, "p")], check=True)
        names = sorted(os.listdir(tmp), key=lambda n: int(n.split("-")[-1].split(".")[0]))
        return [np.array(Image.open(os.path.join(tmp, n)).convert("L")) < 128 for n in names]


def runs(mask):
    """[start, end) of consecutive True stretches."""
    out, start = [], None
    for i, v in enumerate(list(mask) + [False]):
        if v and start is None:
            start = i
        elif not v and start is not None:
            out.append((start, i))
            start = None
    return out


def staff_lines(ink):
    """Rows that run across most of the page. Two rows are checked together, since a staff line on
    a slightly tilted scan can sit half in one pixel row and half in the next."""
    h, w = ink.shape
    rows = (ink | np.roll(ink, 1, axis=0)).sum(axis=1) / w
    lines = []
    for a, b in runs(rows > 0.35):
        y = (a + b - 1) / 2
        if lines and y - lines[-1] <= 3:
            lines[-1] = (lines[-1] + y) / 2
        else:
            lines.append(y)
    return lines


def staves(lines):
    """Groups of five evenly spaced lines. Beams that look like lines are skipped, and one faint
    line may be missing (it's filled in)."""
    out, used, i = [], set(), 0
    while i < len(lines) - 3:
        found = None
        for j in range(i + 1, min(i + 4, len(lines))):
            space = lines[j] - lines[i]
            if not 6 <= space <= 30:
                continue
            chain, y, missing = [lines[i]], lines[i], 0
            while len(chain) < 5:
                want = y + space
                near = min((l for l in lines if l > y), key=lambda l: abs(l - want), default=None)
                if near is not None and abs(near - want) <= max(2, 0.25 * space):
                    y = near
                elif missing == 0:
                    y, missing = want, 1
                else:
                    break
                chain.append(y)
            if len(chain) == 5:
                found = (chain[0], chain[-1], (chain[-1] - chain[0]) / 4)
                break
        if found:
            out.append(found)
            i = next((k for k, l in enumerate(lines) if l > found[1] + 1), len(lines))
        else:
            i += 1
    return out


def staff_ends(ink, top, space):
    """Left and right end of a staff: the outermost columns where most of its five lines are dark
    (one line can be broken near the start on a scan)."""
    rows = [int(round(top + i * space)) for i in range(5)]
    dark = sum(ink[max(0, r - 1):r + 2].any(axis=0).astype(int) for r in rows)
    cols = np.flatnonzero(dark >= 3)
    return (float(cols[0]), float(cols[-1])) if cols.size else None


def joined(ink, top, bottom, space):
    """True when a vertical line at the left end ties the two staves into one system."""
    ends = staff_ends(ink, top, space)
    if not ends:
        return False
    left = int(ends[0])
    span = ink[int(top):int(bottom) + 1, max(0, left - int(space)):left + int(3 * space)]
    span = span | np.roll(span, 1, axis=1)
    return bool((span.mean(axis=0) > 0.8).any())


def systems(ink):
    """Grand staves: a staff and the one below it, joined by the system line at the left.
    Checking the join (not just pairing staves in order) keeps one missed staff from
    shifting every later pair."""
    st, out, k = staves(staff_lines(ink)), [], 0
    while k + 1 < len(st):
        top, nxt = st[k], st[k + 1]
        space = (top[2] + nxt[2]) / 2
        if nxt[0] - top[1] < 12 * top[2] and joined(ink, top[0], nxt[1], space):
            out.append((top[0], nxt[1], space))
            k += 2
        else:
            k += 1
    return out


def barlines(ink, top, bottom, space):
    h, w = ink.shape
    span = ink[int(top):int(bottom) + 1]
    # Neighbouring columns count together (a barline on a slightly tilted scan wanders a pixel),
    # and small breaks are allowed: 80% of the height must be dark.
    span = span | np.roll(span, 1, axis=1) | np.roll(span, -1, axis=1)
    full = span.mean(axis=0) > 0.8
    xs = [(a + b) / 2 for a, b in runs(full)]
    # The staves' own ends count as the first and last barline even when none is printed there.
    ends = staff_ends(ink, top, space)
    if ends:
        left, right = ends
        if not xs or xs[0] - left > 1.6 * space:
            xs.insert(0, left)
        if xs[-1] < right - 4 * space:
            xs.append(right)
    merged = []
    for x in xs:
        # Double, final and repeat barlines are several lines close together: one barline.
        if merged and x - merged[-1][-1] < 1.6 * space:
            merged[-1].append(x)
        else:
            merged.append([x])
    return [(g[0], g[-1]) for g in merged]


def split(ink, a, b):
    """The emptiest row between two systems (rows a..b), so each system keeps what's written near it."""
    a, b = int(a), int(b)
    if b <= a:
        return (a + b) / 2
    rows = ink[a:b].sum(axis=1)
    best = rows.min()
    quiet = np.flatnonzero(rows <= best)
    return a + quiet[len(quiet) // 2]


def reach(cols, top, bottom, upper, lower, space):
    """How far the bar's ink goes above and below its staves. Walks outward row by row and stops at
    a blank band nearly two staff spaces tall, so a title, tempo text or page number nearby isn't taken in."""
    used = cols.any(axis=1)
    gap = int(1.8 * space)

    def walk(start, stop, step):
        edge, blank, y = start, 0, start
        while (y > stop) if step < 0 else (y < stop):
            y += step
            if used[int(y)]:
                edge, blank = y, 0
            else:
                blank += 1
                if blank > gap:
                    break
        return edge

    return walk(int(top), int(upper), -1), walk(int(bottom), int(lower) - 1, 1)


def find(pdf, first=1, from_page=1):
    """Each bar gets the vertical extent of the ink actually in it (high notes, ledger lines,
    fingerings, dynamics), not just the staves; the room between systems is shared at the emptiest row."""
    out, n = [], first
    for p, ink in enumerate(pages(pdf), start=1):
        if p < from_page:
            out.append({"page": p, "systems": []})
            continue
        h, w = ink.shape
        page = {"page": p, "systems": []}
        found = systems(ink)
        for k, (top, bottom, space) in enumerate(found):
            upper = split(ink, found[k - 1][1], top) if k else max(0, top - 7 * space)
            lower = split(ink, bottom, found[k + 1][0]) if k + 1 < len(found) else min(h, bottom + 7 * space)
            lines = barlines(ink, top, bottom, space)
            bars = []
            for (_, a), (b, _) in zip(lines, lines[1:]):
                if b - a < 6 * space:  # a start repeat after the clef, not a bar
                    continue
                # A little to each side too: a note or slur can start right at the barline.
                c0, c1 = int(max(0, a - space)), int(min(w, b + space))
                y0, y1 = reach(ink[:, c0:c1], top, bottom, upper, lower, space)
                pad = 0.6 * space
                bars.append({"n": n, "x0": round(a / w, 4), "x1": round(b / w, 4),
                             "y0": round(max(upper, y0 - pad) / h, 4), "y1": round(min(lower, y1 + pad) / h, 4)})
                n += 1
            page["systems"].append({"y0": round(upper / h, 4), "y1": round(lower / h, 4), "bars": bars})
        out.append(page)
    return out


def boxes(layout, lo, hi):
    out = []
    for page in layout:
        for s in page["systems"]:
            sel = [b for b in s["bars"] if lo <= b["n"] <= hi]
            if sel:
                x0, x1 = sel[0]["x0"], sel[-1]["x1"]
                y0, y1 = min(b["y0"] for b in sel), max(b["y1"] for b in sel)
                out.append([page["page"], x0, y0, round(x1 - x0, 4), round(y1 - y0, 4)])
    return out


def main(argv):
    opts = {"--first": 1, "--from-page": 1}
    for flag in opts:
        if flag in argv:
            i = argv.index(flag)
            opts[flag] = int(argv[i + 1])
            argv = argv[:i] + argv[i + 2:]
    first, start = opts["--first"], opts["--from-page"]
    if len(argv) >= 2 and argv[0] == "map":
        for page in find(argv[1], first, start):
            for k, s in enumerate(page["systems"], start=1):
                nums = [b["n"] for b in s["bars"]]
                print(f"page {page['page']} system {k}: bars {nums[0]}-{nums[-1]}" if nums else f"page {page['page']} system {k}: none")
    elif len(argv) == 3 and argv[0] == "box":
        lo, _, hi = argv[2].partition("-")
        print(json.dumps(boxes(find(argv[1], first, start), int(lo), int(hi or lo))))
    elif len(argv) == 4 and argv[0] == "check":
        layout, p = find(argv[1], first, start), int(argv[2])
        img = Image.fromarray((~pages(argv[1])[p - 1] * 255).astype("uint8")).convert("RGB")
        d, (w, h) = ImageDraw.Draw(img), img.size
        for s in layout[p - 1]["systems"]:
            for b in s["bars"]:
                d.rectangle([b["x0"] * w, b["y0"] * h, b["x1"] * w, b["y1"] * h], outline=(230, 140, 0), width=3)
                d.text((b["x0"] * w + 4, b["y0"] * h + 2), str(b["n"]), fill=(200, 0, 0))
        img.save(argv[3])
        print(f"saved {argv[3]}")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
