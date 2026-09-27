#!/usr/bin/env python3
"""Regression check for the formatter over a folder of real papers kept OUTSIDE this repository.

    python3 tools/regress.py run  <papers_dir> <out_dir>   # format every .docx in papers_dir
    python3 tools/regress.py diff <old_out> <new_out>      # what changed between two runs

Typical use: run once on main (the baseline), apply a change, run again, then diff. Only papers whose
status, marks, question count, review note or text changed are printed, so the output stays short.
Real exam papers must never be committed; point papers_dir at a local copy (e.g. downloaded from Drive).
"""
from __future__ import annotations

import difflib
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FORMATTER = ROOT / "formatter" / "src" / "index.js"


def doc_lines(docx: Path) -> list[str]:
    xml = zipfile.ZipFile(docx).read("word/document.xml").decode("utf-8")
    xml = re.sub(r"<w:tabs>.*?</w:tabs>", "", xml, flags=re.S)
    xml = re.sub(r"<w:tab/>", "\t", xml)
    xml = re.sub(r"</w:p>", "\n", xml)
    return [l.rstrip() for l in re.sub(r"<[^>]+>", "", xml).splitlines() if l.strip()]


def run(papers: Path, out: Path) -> int:
    out.mkdir(parents=True, exist_ok=True)
    failed = 0
    for src in sorted(papers.glob("*.docx")):
        dest = out / src.stem
        p = subprocess.run(["node", str(FORMATTER), str(src), "--out", str(dest), "--json"], capture_output=True, text=True)
        if p.returncode not in (0, 2) or not p.stdout.strip().startswith("{"):
            failed += 1
            print(f"!! {src.name}: exit {p.returncode} {p.stderr.strip()[:200]}")
            continue
        (out / f"{src.stem}.json").write_text(p.stdout)
        j = json.loads(p.stdout)
        print(f"{src.stem:40} {j['name']:36} {'blocking' if j['blocking'] else 'ok':8} {j['questions']:3} q {j['marks']:3} marks")
    return 1 if failed else 0


def changed(a: list[str], b: list[str]) -> list[str]:
    return [l for l in difflib.unified_diff(a, b, lineterm="", n=0) if l[:1] in "+-" and l[:3] not in ("+++", "---")]


def diff(old: Path, new: Path) -> int:
    shown = 0
    for jo in sorted(old.glob("*.json")):
        jn = new / jo.name
        if not jn.exists():
            print(f"=== {jo.stem}: missing from {new}")
            continue
        a, b = json.loads(jo.read_text()), json.loads(jn.read_text())
        # the review's first line carries the run date; ignore it
        ra = Path(a["review"]).read_text().splitlines()[2:]
        rb = Path(b["review"]).read_text().splitlines()[2:]
        rd, td = changed(ra, rb), changed(doc_lines(Path(a["docx"])), doc_lines(Path(b["docx"])))
        head = [(k, a[k], b[k]) for k in ("blocking", "marks", "questions") if a[k] != b[k]]
        if not (rd or td or head):
            continue
        shown += 1
        print(f"=== {jo.stem}" + "".join(f"  {k} {x}->{y}" for k, x, y in head))
        for l in rd[:10]:
            print("  R", l[:150])
        for l in td[:14]:
            print("  T", l[:150].replace("\t", "⇥"))
        if len(td) > 14:
            print(f"  T ... {len(td) - 14} more")
    print(f"{shown} paper(s) changed")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1] not in ("run", "diff"):
        sys.exit(__doc__)
    cmd, x, y = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    sys.exit(run(x, y) if cmd == "run" else diff(x, y))
