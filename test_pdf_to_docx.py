#!/usr/bin/env python3
"""Regression test for pdf_to_docx.py: builds a small PDF with PyMuPDF and checks the conversion.

    python3 test_pdf_to_docx.py
"""

import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import pymupdf

from pdf_to_docx import convert

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def paragraphs(docx_path: Path):
    body = ET.fromstring(zipfile.ZipFile(docx_path).read("word/document.xml")).find(W + "body")
    out = []
    for el in body:
        if el.tag == W + "p":
            text = "".join((x.text or "") if x.tag == W + "t" else ("\t" if x.tag == W + "tab" else "") for x in el.iter())
            has_img = el.find(".//{http://schemas.openxmlformats.org/drawingml/2006/main}blip") is not None
            out.append(("img" if has_img else "p", text))
        elif el.tag == W + "tbl":
            out.append(("table", len(el.findall(W + "tr"))))
    return out


def make_pdf(path: Path):
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    bold = "hebo"
    page.insert_text((150, 60), "VIDYA VIHAR CONVENT HIGH SCHOOL, CHANDRAPUR", fontname=bold, fontsize=14)
    page.insert_text((190, 80), "HALF-YEARLY EXAMINATION - 2026-2027", fontname=bold, fontsize=12)
    page.insert_text((40, 100), "Class: VII", fontname=bold, fontsize=11)
    page.insert_text((250, 100), "Subject: Science (086)", fontname=bold, fontsize=11)
    page.insert_text((450, 100), "Marks: 10 marks", fontname=bold, fontsize=11)
    page.insert_text((40, 130), "Section A (1x2 = 2 Marks)", fontname=bold, fontsize=12)
    # a question whose text wraps onto a second line at the same left edge
    page.insert_text((40, 160), "1. A very long question that keeps going on and on until it reaches the right margin of the", fontsize=11)
    page.insert_text((40, 175), "page and then continues here?", fontsize=11)
    page.insert_text((60, 195), "a) 1", fontsize=11)
    page.insert_text((200, 195), "b) 2", fontsize=11)
    page.insert_text((340, 195), "c) 3", fontsize=11)
    page.insert_text((480, 195), "d) 4", fontsize=11)
    # a stacked fraction: numerator above denominator, then text continues on the denominator line
    page.insert_text((40, 230), "2. Simplify", fontsize=11)
    page.insert_text((110, 224), "6", fontsize=9)
    page.insert_text((110, 236), "12", fontsize=9)
    page.insert_text((130, 236), "to its lowest form.", fontsize=11)
    page.insert_text((520, 236), "1M", fontsize=11)
    # an image
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 40, 30), False)
    pix.clear_with(200)
    page.insert_image(pymupdf.Rect(40, 260, 140, 335), pixmap=pix)
    page.insert_text((280, 820), "Page 1", fontsize=9)
    doc.save(str(path))


def main():
    with tempfile.TemporaryDirectory() as d:
        pdf = Path(d) / "Science_7th_HYE_2026-27.pdf"
        out = Path(d) / "out.docx"
        make_pdf(pdf)
        stats = convert(pdf, out)
        paras = paragraphs(out)
        texts = [t.strip() for k, t in paras if k == "p"]
        assert stats["images"] == 1 and any(k == "img" for k, _ in paras), "image carried"
        assert texts[0].startswith("VIDYA VIHAR"), texts[:3]
        assert texts[1].startswith("HALF-YEARLY"), "centred exam line stays on its own"
        assert texts[2].startswith("Class: VII") and "Subject: Science (086)" in texts[2] and "Marks: 10 marks" in texts[2], texts[2]
        assert "\t" in texts[2], "same-row pieces are tab separated"
        joined = [t for t in texts if t.startswith("1. A very long question")]
        assert joined and joined[0].endswith("continues here?"), "wrapped line rejoined: " + repr(joined)
        opts = [t for t in texts if t.startswith("a) 1")]
        assert opts and opts[0].split("\t") == ["a) 1", "b) 2", "c) 3", "d) 4"], opts
        frac = [t for t in texts if t.startswith("2. Simplify")]
        assert frac and "6/12" in frac[0] and "to its lowest form." in frac[0] and frac[0].rstrip().endswith("1M"), "fraction rejoined: " + repr(frac)
        assert not any(t.startswith("Page 1") for t in texts), "page number dropped"
    print("ok: pdf_to_docx test passed")


if __name__ == "__main__":
    main()
