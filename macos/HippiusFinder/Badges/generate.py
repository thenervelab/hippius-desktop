#!/usr/bin/env python3
"""Emit the four Finder Sync badge PDFs.

Apple asks for artwork that fills a frame drawable at up to 320x320, edge to
edge, with no padding — SF Symbols carry optical insets, so stretching one
into that frame still leaves a small glyph in the well. These PDFs are
template images: black vector on an unpainted (transparent) page. Finder
tints them. Re-run this file to regenerate; the committed PDFs are the
shipped source of truth.
"""

from __future__ import annotations

from pathlib import Path

SIZE = 320.0
# Stroke thick enough to read at Apple's 8x8 non-retina floor, still inside
# the MediaBox once round caps are added (half-width inset).
STROKE = 52.0
INSET = STROKE / 2.0 + 4.0


def pdf(content: str) -> bytes:
    stream = content.encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 320] "
            b"/Contents 4 0 R /Resources << >> >>"
        ),
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for i, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i
        out += obj
        out += b"\nendobj\n"
    xref_at = len(out)
    out += b"xref\n0 %d\n" % (len(objects) + 1)
    out += b"0000000000 65535 f \n"
    for off in offsets[1:]:
        out += b"%010d 00000 n \n" % off
    out += (
        b"trailer << /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"
        % (len(objects) + 1, xref_at)
    )
    return bytes(out)


def stroke_setup() -> str:
    return f"{STROKE:.1f} w 1 J 1 j 0 G 0 g\n"


def circle(cx: float, cy: float, r: float) -> str:
    k = 0.5522847498307936 * r
    return (
        f"{cx + r:.2f} {cy:.2f} m\n"
        f"{cx + r:.2f} {cy + k:.2f} {cx + k:.2f} {cy + r:.2f} {cx:.2f} {cy + r:.2f} c\n"
        f"{cx - k:.2f} {cy + r:.2f} {cx - r:.2f} {cy + k:.2f} {cx - r:.2f} {cy:.2f} c\n"
        f"{cx - r:.2f} {cy - k:.2f} {cx - k:.2f} {cy - r:.2f} {cx:.2f} {cy - r:.2f} c\n"
        f"{cx + k:.2f} {cy - r:.2f} {cx + r:.2f} {cy - k:.2f} {cx + r:.2f} {cy:.2f} c\n"
    )


def arc_90(cx: float, cy: float, r: float, quadrant: int, start: bool) -> str:
    """One 90-degree cubic. Quadrant 0 = 0°→90° (CCW from +x), PDF y-up."""
    k = 0.5522847498307936 * r
    pts = [
        (cx + r, cy, cx + r, cy + k, cx + k, cy + r, cx, cy + r),
        (cx, cy + r, cx - k, cy + r, cx - r, cy + k, cx - r, cy),
        (cx - r, cy, cx - r, cy - k, cx - k, cy - r, cx, cy - r),
        (cx, cy - r, cx + k, cy - r, cx + r, cy - k, cx + r, cy),
    ]
    x0, y0, x1, y1, x2, y2, x3, y3 = pts[quadrant % 4]
    prefix = f"{x0:.2f} {y0:.2f} m\n" if start else ""
    return prefix + f"{x1:.2f} {y1:.2f} {x2:.2f} {y2:.2f} {x3:.2f} {y3:.2f} c\n"


def synced() -> str:
    # Check spanning the frame. Coordinates chosen so a 52pt round-cap stroke
    # kisses the MediaBox on the left, bottom, and top-right.
    return (
        stroke_setup()
        + f"{INSET:.1f} {SIZE * 0.48:.1f} m\n"
        + f"{SIZE * 0.38:.1f} {INSET:.1f} l\n"
        + f"{SIZE - INSET:.1f} {SIZE * 0.82:.1f} l\n"
        + "S\n"
    )


def error() -> str:
    lo = INSET
    hi = SIZE - INSET
    return (
        stroke_setup()
        + f"{lo:.1f} {lo:.1f} m {hi:.1f} {hi:.1f} l S\n"
        + f"{hi:.1f} {lo:.1f} m {lo:.1f} {hi:.1f} l S\n"
    )


def shared() -> str:
    # Two rings along the diagonal so a square frame stays filled. Horizontal
    # placement with a radius that also hits the top/bottom collapses into
    # one circle (the bug the first cut shipped).
    r = SIZE * 0.34
    c1 = (INSET + r, SIZE - INSET - r)
    c2 = (SIZE - INSET - r, INSET + r)
    return (
        stroke_setup()
        + circle(c1[0], c1[1], r)
        + "S\n"
        + circle(c2[0], c2[1], r)
        + "S\n"
    )


def syncing() -> str:
    # Open ring (a C). An arrowhead on the stroke end blobs into the cap at
    # 8–12px — the size Finder actually paints — and reads as damage. The
    # gap is the "in progress" tell; round caps keep it a C, not a slice.
    cx = cy = SIZE / 2.0
    r = (SIZE / 2.0) - INSET
    return (
        stroke_setup()
        + "".join(arc_90(cx, cy, r, q, start=(q == 1)) for q in (1, 2, 3))
        + "S\n"
    )


BADGES = {
    "synced": synced,
    "syncing": syncing,
    "shared": shared,
    "error": error,
}


def main() -> None:
    out_dir = Path(__file__).resolve().parent
    for name, build in BADGES.items():
        path = out_dir / f"{name}.pdf"
        path.write_bytes(pdf(build()))
        print(path.name, path.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
