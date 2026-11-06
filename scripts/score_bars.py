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


def systems(ink):
    """Grand staves: a treble staff with the bass staff close below it."""
    st, out, k = staves(staff_lines(ink)), [], 0
    while k + 1 < len(st):
        top, nxt = st[k], st[k + 1]
        if nxt[0] - top[1] < 12 * top[2]:
            out.append((top[0], nxt[1], (top[2] + nxt[2]) / 2))
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
    row = ink[int(round(top)) - 1:int(round(top)) + 2].any(axis=0)
    dark = np.flatnonzero(row)
    if dark.size:
        left, right = float(dark[0]), float(dark[-1])
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


def find(pdf, first=1, from_page=1):
    out, n = [], first
    for p, ink in enumerate(pages(pdf), start=1):
        if p < from_page:
            out.append({"page": p, "systems": []})
            continue
        h, w = ink.shape
        page = {"page": p, "systems": []}
        for top, bottom, space in systems(ink):
            lines = barlines(ink, top, bottom, space)
            bars = []
            for (_, a), (b, _) in zip(lines, lines[1:]):
                if b - a < 6 * space:  # a start repeat after the clef, not a bar
                    continue
                bars.append({"n": n, "x0": round(a / w, 4), "x1": round(b / w, 4)})
                n += 1
            pad = 2.2 * space  # room for notes above and below the staves
            page["systems"].append({"y0": round(max(0, top - pad) / h, 4), "y1": round(min(h, bottom + pad) / h, 4),
                                    "bars": bars})
        out.append(page)
    return out


def boxes(layout, lo, hi):
    out = []
    for page in layout:
        for s in page["systems"]:
            sel = [b for b in s["bars"] if lo <= b["n"] <= hi]
            if sel:
                x0, x1 = sel[0]["x0"], sel[-1]["x1"]
                out.append([page["page"], x0, s["y0"], round(x1 - x0, 4), round(s["y1"] - s["y0"], 4)])
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
                d.rectangle([b["x0"] * w, s["y0"] * h, b["x1"] * w, s["y1"] * h], outline=(230, 140, 0), width=3)
                d.text((b["x0"] * w + 4, s["y0"] * h + 2), str(b["n"]), fill=(200, 0, 0))
        img.save(argv[3])
        print(f"saved {argv[3]}")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
