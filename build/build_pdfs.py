# /// script
# requires-python = ">=3.11"
# dependencies = ["pymupdf>=1.24", "pikepdf>=8,<10"]
# ///
"""Build the published light and dark editions of the Math Comprehensive Review from source/.

    uv run build/build_pdfs.py

Light edition (the original colours):
  * a blank page is inserted wherever a section would otherwise start on an even page, so every
    section starts on an odd (right-hand) page and a printed copy separates cleanly by section;
    the flashcard sheets then keep their front-on-odd, back-on-even pairing for duplex printing;
  * "© Ethan Gueck 2026" in the bottom-right margin of every page;
  * page labels that match the printed page numbers, so "go to page 131" lands on printed page 131.

Dark edition: the light edition with every colour mapped onto the portfolio's dark palette
(background #102a43, text #f0f4f8). The PDF is vector-only (pdfTeX, no raster images), so this
rewrites the colour operators (g, G, rg, RG) in every page and form XObject and the colour stops
of its shadings, keeping the text and figures sharp.
"""

from __future__ import annotations

import colorsys
from pathlib import Path

import pikepdf
import pymupdf

ROOT = Path(__file__).resolve().parents[1]
NAME = "Math_Comprehensive_Review_Study_Edition"
SOURCE = ROOT / "source" / f"{NAME}.pdf"
OUT = ROOT / "math-review"
LIGHT = OUT / f"{NAME}.pdf"
DARK = OUT / f"{NAME}_Dark.pdf"

COPYRIGHT = "© Ethan Gueck 2026"
BLANK_NOTE = "This page is intentionally left blank."
STAMP_SIZE = 6.5
STAMP_BASELINE = 784  # below the page numbers (y ≈ 765) and the flashcard cut lines (y ≤ 774)
STAMP_MARGIN = 54
GREY = (0.42, 0.45, 0.48)

# The portfolio's dark palette (portfolio assets/css/dark.css: --canvas and --ink).
DARK_BG = (0x10 / 255, 0x2A / 255, 0x43 / 255)
DARK_FG = (0xF0 / 255, 0xF4 / 255, 0xF8 / 255)


# ---- Light edition -------------------------------------------------------------


def insert_blank_pages(doc: pymupdf.Document) -> list[int]:
    """Insert a blank page before each top-level section that would start on an even page.

    Returns the 0-based indices of the inserted pages in the new document.
    """
    starts = sorted({page for level, _, page in doc.get_toc() if level == 1})
    blanks, offset = [], 0
    for page in starts:  # 1-based page numbers of the original
        physical = page + offset
        if physical % 2 == 0:
            rect = doc[physical - 1].rect
            doc.new_page(pno=physical - 1, width=rect.width, height=rect.height)
            blanks.append(physical - 1)
            offset += 1
    return blanks


def stamp(page: pymupdf.Page, blank: bool) -> None:
    """Copyright in the bottom-right margin; the blank-page note in the middle of a blank page."""
    width = pymupdf.get_text_length(COPYRIGHT, fontname="helv", fontsize=STAMP_SIZE)
    page.insert_text((page.rect.width - STAMP_MARGIN - width, STAMP_BASELINE), COPYRIGHT, fontname="helv", fontsize=STAMP_SIZE, color=GREY)
    if blank:
        size = 9
        width = pymupdf.get_text_length(BLANK_NOTE, fontname="Times-Italic", fontsize=size)
        page.insert_text(((page.rect.width - width) / 2, page.rect.height / 2), BLANK_NOTE, fontname="Times-Italic", fontsize=size, color=GREY)


def page_labels(count: int, blanks: list[int]) -> list[dict]:
    """Labels that follow the printed page numbers: original page n stays "n", inserted pages read "Blank"."""
    labels, original = [], 1
    for index in range(count):
        if index in blanks:
            labels.append({"startpage": index, "prefix": "Blank", "style": ""})
        elif index == 0 or index - 1 in blanks:
            labels.append({"startpage": index, "prefix": "", "style": "D", "firstpagenum": original})
        if index not in blanks:
            original += 1
    return labels


def build_light() -> list[int]:
    doc = pymupdf.open(SOURCE)
    blanks = insert_blank_pages(doc)
    for index, page in enumerate(doc):
        stamp(page, index in blanks)
    doc.set_page_labels(page_labels(doc.page_count, blanks))
    doc.save(LIGHT, garbage=3, deflate=True)
    return blanks


# ---- Dark edition --------------------------------------------------------------

_DARK_L = colorsys.rgb_to_hls(*DARK_BG)[1]
_LIGHT_L = colorsys.rgb_to_hls(*DARK_FG)[1]


def to_dark(r: float, g: float, b: float) -> tuple[float, float, float]:
    """Map a light-edition colour onto the dark palette.

    Greys blend from the dark background (white) to the light text colour (black). Colours keep
    their hue and saturation and invert their lightness into the same range, so pale fills become
    deep panels and dark accents become light ones.
    """
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    if max(r, g, b) - min(r, g, b) < 0.04:
        t = 1 - l
        return tuple(bg + (fg - bg) * t for bg, fg in zip(DARK_BG, DARK_FG))
    return colorsys.hls_to_rgb(h, _DARK_L + 0.04 + (_LIGHT_L - _DARK_L - 0.04) * (1 - l), s)


def _rgb(values) -> list[float]:
    return [round(v, 4) for v in values]


def recolor_content(stream_owner) -> bytes:
    """The content stream with every grey and RGB colour operator mapped by to_dark."""
    out = []
    for operands, operator in pikepdf.parse_content_stream(stream_owner):
        op = str(operator)
        if op in ("g", "G"):
            v = float(operands[0])
            out.append((_rgb(to_dark(v, v, v)), pikepdf.Operator("rg" if op == "g" else "RG")))
        elif op in ("rg", "RG"):
            out.append((_rgb(to_dark(*(float(x) for x in operands))), operator))
        else:
            out.append((operands, operator))
    return pikepdf.unparse_content_stream(out)


def recolor_function(fn) -> None:
    """Shading functions: type 2 (C0 → C1) and type 3 (stitched type 2s)."""
    if fn.get("/FunctionType") == 2:
        for key in ("/C0", "/C1"):
            if key in fn:
                values = [float(v) for v in fn[key]]
                rgb = values * 3 if len(values) == 1 else values
                fn[key] = pikepdf.Array(_rgb(to_dark(*rgb)))
    elif fn.get("/FunctionType") == 3:
        for part in fn["/Functions"]:
            recolor_function(part)


def recolor_resources(pdf: pikepdf.Pdf, resources, seen: set) -> None:
    """Recolour the form XObjects and shadings a page or form uses, each once."""
    if resources is None:
        return
    for _, xobject in (resources.get("/XObject") or {}).items():
        if xobject.objgen in seen or xobject.get("/Subtype") != "/Form":
            continue
        seen.add(xobject.objgen)
        xobject.write(recolor_content(xobject))
        recolor_resources(pdf, xobject.get("/Resources"), seen)
    shadings = [s for _, s in (resources.get("/Shading") or {}).items()]
    shadings += [p["/Shading"] for _, p in (resources.get("/Pattern") or {}).items() if "/Shading" in p]
    for shading in shadings:
        if shading.objgen in seen and shading.objgen != (0, 0):
            continue
        seen.add(shading.objgen)
        if shading.get("/ColorSpace") == "/DeviceGray":
            shading["/ColorSpace"] = pikepdf.Name("/DeviceRGB")
        if "/Function" in shading:
            recolor_function(shading["/Function"])


def build_dark() -> None:
    pdf = pikepdf.open(LIGHT)
    seen: set = set()
    bg, fg = " ".join(map(str, _rgb(DARK_BG))), " ".join(map(str, _rgb(DARK_FG)))
    for page in pdf.pages:
        x0, y0, x1, y1 = (float(v) for v in page.mediabox)
        body = recolor_content(page)
        # Paint the dark page first, then start in the light text colour (PDF's default is black).
        prefix = f"q {bg} rg {x0} {y0} {x1 - x0} {y1 - y0} re f Q {fg} rg {fg} RG\n".encode()
        page.Contents = pdf.make_stream(prefix + body)
        recolor_resources(pdf, page.get("/Resources"), seen)
    pdf.docinfo["/Title"] = "Mathematics: A Comprehensive Review (Study Edition, Dark)"
    pdf.save(DARK)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    blanks = build_light()
    build_dark()
    print(f"{LIGHT.name}: {len(blanks)} blank pages inserted at {[i + 1 for i in blanks]}")
    print(f"{DARK.name}: written")
