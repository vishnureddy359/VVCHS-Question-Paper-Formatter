#!/usr/bin/env python3
"""
pipeline.py — run the VVCHS question-paper pipeline against the Drive folders.

For every .docx or .pdf in 1_Inbox:
  1. download it through the bridge (qp.py); a PDF is first converted to .docx with pdf_to_docx.py
  2. run the formatter (formatter/src/index.js) -> <Name>.docx + <Name>_REVIEW.md
  3. route the result:
       no blocking issues  -> <Name>.docx + <Name>_REVIEW.docx to 2_Formatted, original to 4_Archive as <Name>_ORIGINAL.docx
       blocking issues     -> <Name>_REVIEW.docx to 3_Needs-Fixes, original moved there unchanged
       PDF whose text cannot be read -> note asking for the Word file to 3_Needs-Fixes, original moved there
       formatter error     -> left in 1_Inbox, reported
       output already in the target folder (a move that stalled last run)
                           -> only the move of the original is redone, reported as "recovered"

Files that are neither .docx nor .pdf (notes, stale review files) are left alone and listed.
The inbox therefore only ever holds papers that still need processing, which makes
re-running safe.

Usage:
    python3 pipeline.py run [--dry-run] [--only NAME] [--work DIR] [--json]

    --dry-run   download and format, but do not upload or move anything in Drive
    --only      process just the inbox file with this exact name
    --work      working directory for downloads and output (default: ./work)
    --json      print a machine-readable summary at the end

Needs QP_BRIDGE_URL and QP_BRIDGE_TOKEN in the environment, node, and
`npm install` done inside formatter/.
"""

from __future__ import annotations

import argparse
import re
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import qp
from review_docx import md_to_docx

ROOT = Path(__file__).resolve().parent
FORMATTER = ROOT / "formatter" / "src" / "index.js"
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PDF_MIME = "application/pdf"
PDF_NOTE = ("## PDF source\n- The paper arrived as a PDF and was converted to Word before formatting. "
            "Line breaks, stacked fractions, tables and figure placement come from the conversion — check them "
            "against the PDF. Sending the original Word file gives a better result.\n")


def is_pdf(entry: dict) -> bool:
    return entry["name"].lower().endswith(".pdf") or entry["mimeType"] == PDF_MIME


def log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def run_formatter(src: Path, out_dir: Path) -> tuple[int, dict | None, str]:
    """Run the Node formatter. Returns (exit code, summary dict, stderr)."""
    if not (ROOT / "formatter" / "node_modules").is_dir():
        raise qp.BridgeError("formatter/node_modules missing — run `npm install` inside formatter/ first")
    proc = subprocess.run(
        ["node", str(FORMATTER), str(src), "--out", str(out_dir), "--json"],
        capture_output=True, text=True, cwd=str(ROOT),
    )
    summary = None
    if proc.stdout.strip():
        try:
            summary = json.loads(proc.stdout)
        except json.JSONDecodeError:
            pass
    return proc.returncode, summary, proc.stderr.strip()


def free_name(taken: set[str], base: str, ext: str) -> str:
    """First of base.ext, base_v2.ext, base_v3.ext … not already in the target folder."""
    name = f"{base}{ext}"
    n = 2
    while name in taken:
        name = f"{base}_v{n}{ext}"
        n += 1
    return name


def docx_text(path: Path) -> str:
    """Plain text of a .docx (paragraph per line), for comparing review notes."""
    import re, zipfile
    xml = zipfile.ZipFile(path).read("word/document.xml").decode("utf-8", "replace")
    paras = re.findall(r"<w:p[ >].*?</w:p>", xml, re.S)
    return "\n".join("".join(re.findall(r"<w:t[^>]*>(.*?)</w:t>", p, re.S)) for p in paras)


SOURCE_LINE = re.compile(r"Source(?: file)?:\s*`?([^`\n\u00b7(]+?)`?\s*(?:\u00b7|\(|$)", re.M)


def retire_superseded(base: str, stem: str, needsfixes: dict, archive: dict, work: Path, result: dict) -> None:
    """A paper that has just been formatted replaces an earlier attempt of the same paper that is still in
    3_Needs-Fixes (the teacher fixed it and re-uploaded): the old review note and the old original are
    parked in 4_Archive as *_superseded so the folder only shows papers that still need work."""
    for note in (f"{base}_REVIEW.docx", f"{base}_REVIEW.md"):
        if note not in needsfixes:
            continue
        tmp = work / "superseded" / note
        tmp.parent.mkdir(parents=True, exist_ok=True)
        try:
            qp.download(needsfixes[note], tmp)
            text = docx_text(tmp) if note.endswith(".docx") else tmp.read_text(encoding="utf-8", errors="replace")
        except (qp.BridgeError, OSError, KeyError) as e:
            result["notes"].append(f"could not read {note} in 3_Needs-Fixes: {e}")
            continue
        m = SOURCE_LINE.search(text)
        src = m.group(1).strip() if m else None
        if src and src in needsfixes:
            p = Path(src)
            new = free_name(archive, p.stem + "_superseded", p.suffix)
            mv = qp.move(needsfixes.pop(src), "archive", new)
            archive[mv["name"]] = mv["id"]
            result["notes"].append(f"earlier attempt {src} moved from 3_Needs-Fixes to 4_Archive as {mv['name']}")
            log(f"  -> superseded: {src} -> 4_Archive/{mv['name']}")
        new = free_name(archive, f"{stem}_REVIEW_superseded", Path(note).suffix)
        mv = qp.move(needsfixes.pop(note), "archive", new)
        archive[mv["name"]] = mv["id"]
        result["notes"].append(f"{note} moved from 3_Needs-Fixes to 4_Archive as {mv['name']}")
        log(f"  -> superseded: {note} -> 4_Archive/{mv['name']}")


def review_docx_for(review_md: Path) -> Path:
    out = review_md.with_suffix(".docx")
    md_to_docx(review_md, out)
    return out


def same_review(existing_id: str, ours_md: Path, work: Path) -> bool:
    """True when the review already in Drive is the one we just generated (date line aside)."""
    try:
        theirs = docx_text(qp.download(existing_id, work / "existing_review.docx"))
    except (qp.BridgeError, OSError, KeyError, ValueError):
        return False
    strip = lambda t: "\n".join(l.strip() for l in t.splitlines() if l.strip() and not l.startswith("Source:")).strip()
    return strip(theirs) == strip(docx_text(review_docx_for(ours_md)))


def route_unreadable(entry: dict, work: Path, needsfixes: dict, dry_run: bool, result: dict, why: str) -> dict:
    """A PDF whose text cannot be read goes to 3_Needs-Fixes with a note asking for the Word file."""
    name = entry["name"]
    base = Path(name).stem
    result["status"] = "unreadable"
    result["name"] = base
    review = work / "out" / base / f"{base}_REVIEW.md"
    review.parent.mkdir(parents=True, exist_ok=True)
    review.write_text(
        f"# Review — {base}\n"
        f"Source: {name} · Reviewed {time.strftime('%-d %b %Y')} · Status: NEEDS FIXES — moved to 3_Needs-Fixes\n\n"
        "## Blocking\n"
        f"- The text in this PDF cannot be read by software ({why}). **[blocking]**\n"
        "- Please upload the original Word (.docx) file of this paper to 1_Inbox instead. "
        "If the paper exists only as a PDF or a scan, tell the coordinator so it can be typed.\n",
        encoding="utf-8")
    log(f"UNREADABLE {name}: {why}")
    if dry_run:
        result["notes"].append("dry run: nothing uploaded or moved")
        return result
    review_name = free_name(needsfixes, base + "_REVIEW", ".docx")
    rid = qp.upload("needsfixes", review_docx_for(review), review_name, DOCX_MIME)
    needsfixes[review_name] = rid
    result["uploaded"].append({"folder": "needsfixes", "name": review_name, "id": rid})
    moved_name = free_name(needsfixes, base, Path(name).suffix)
    mv = qp.move(entry["id"], "needsfixes", moved_name if moved_name != name else None)
    needsfixes[mv["name"]] = mv["id"]
    result["moved"] = {"folder": "needsfixes", "name": mv["name"]}
    log(f"  -> 3_Needs-Fixes: {review_name}, original moved as {mv['name']}")
    return result


def process(entry: dict, work: Path, formatted: dict, needsfixes: dict, archive: dict, dry_run: bool) -> dict:
    """formatted / needsfixes / archive map file name -> id for the current folder contents."""
    formatted_names, needsfixes_names, archive_names = formatted, needsfixes, archive
    name = entry["name"]
    result = {"file": name, "id": entry["id"], "status": None, "name": None, "uploaded": [], "moved": None, "notes": []}
    src_dir = work / "inbox"
    src_dir.mkdir(parents=True, exist_ok=True)
    src = qp.download(entry["id"], src_dir / name)
    log(f"downloaded {name} ({src.stat().st_size} bytes)")
    from_pdf = is_pdf(entry)
    if from_pdf:
        from pdf_to_docx import convert, UnreadablePdfError  # imported here so the docx-only path needs no PyMuPDF
        converted = src_dir / (Path(name).stem + ".docx")
        try:
            stats = convert(src, converted)
        except UnreadablePdfError as e:
            return route_unreadable(entry, work, needsfixes_names, dry_run, result, str(e))
        log(f"converted PDF -> docx ({stats['pages']} pages, {stats['paragraphs']} paragraphs, {stats['images']} images, {stats['tables']} tables)")
        src = converted
        result["converted_from_pdf"] = stats

    out_dir = work / "out" / Path(name).stem
    if out_dir.exists():
        shutil.rmtree(out_dir)
    code, summary, err = run_formatter(src, out_dir)
    if code == 1 or summary is None:
        result["status"] = "error"
        result["notes"].append(err or "formatter produced no summary")
        log(f"ERROR formatting {name}: {err.splitlines()[-1] if err else 'no output'}")
        return result

    base = summary["name"]
    docx_path = Path(summary["docx"])
    review_path = Path(summary["review"])
    blocking = bool(summary["blocking"])
    if from_pdf:
        review_path.write_text(review_path.read_text(encoding="utf-8").rstrip("\n") + "\n\n" + PDF_NOTE, encoding="utf-8")
    result["name"] = base
    result["status"] = "needs-fixes" if blocking else "formatted"
    result["marks"] = summary.get("marks")
    result["headerMarks"] = summary.get("headerMarks")
    log(f"formatted {name} -> {base} ({'NEEDS FIXES' if blocking else 'OK'}, {summary['questions']} questions, {summary['marks']} marks)")

    if dry_run:
        result["notes"].append("dry run: nothing uploaded or moved")
        return result

    # Guard against a stalled move from an earlier run: our own output is already in the target
    # folder but the original never left the inbox. Retry only what is missing; never upload twice.
    # A review note with the same name but different content is someone else's file and is left alone.
    if blocking and f"{base}_REVIEW.docx" in needsfixes_names and same_review(needsfixes_names[f"{base}_REVIEW.docx"], review_path, work):
        mv = qp.move(entry["id"], "needsfixes", None)
        needsfixes_names[mv["name"]] = mv["id"]
        result["status"] = "recovered"
        result["moved"] = {"folder": "needsfixes", "name": mv["name"]}
        result["notes"].append(f"{base}_REVIEW.docx was already in 3_Needs-Fixes; only the stalled move of the original was redone")
        log(f"  -> recovered: review already in 3_Needs-Fixes, original moved as {mv['name']}")
        return result
    if not blocking and f"{base}.docx" in formatted_names and (f"{base}_REVIEW.docx" not in formatted_names or same_review(formatted_names[f"{base}_REVIEW.docx"], review_path, work)):
        if f"{base}_REVIEW.docx" not in formatted_names:
            rid = qp.upload("formatted", review_docx_for(review_path), f"{base}_REVIEW.docx", DOCX_MIME)
            formatted_names[f"{base}_REVIEW.docx"] = rid
            result["uploaded"].append({"folder": "formatted", "name": f"{base}_REVIEW.docx", "id": rid})
        archived = free_name(archive_names, base + "_ORIGINAL", Path(name).suffix)
        mv = qp.move(entry["id"], "archive", archived)
        archive_names[mv["name"]] = mv["id"]
        result["status"] = "recovered"
        result["moved"] = {"folder": "archive", "name": mv["name"]}
        result["notes"].append(f"{base}.docx was already in 2_Formatted; only the stalled move of the original was redone")
        log(f"  -> recovered: {base}.docx already in 2_Formatted, original archived as {mv['name']}")
        return result

    if blocking:
        review_name = free_name(needsfixes_names, base + "_REVIEW", ".docx")
        rid = qp.upload("needsfixes", review_docx_for(review_path), review_name, DOCX_MIME)
        needsfixes_names[review_name] = rid
        result["uploaded"].append({"folder": "needsfixes", "name": review_name, "id": rid})
        moved_name = free_name(needsfixes_names, Path(name).stem, Path(name).suffix)
        mv = qp.move(entry["id"], "needsfixes", moved_name if moved_name != name else None)
        needsfixes_names[mv["name"]] = mv["id"]
        result["moved"] = {"folder": "needsfixes", "name": mv["name"]}
        log(f"  -> 3_Needs-Fixes: {review_name}, original moved as {mv['name']}")
    else:
        stem, n = base, 2
        while f"{stem}.docx" in formatted_names or f"{stem}_REVIEW.docx" in formatted_names:
            stem = f"{base}_v{n}"; n += 1
        docx_name, review_name = f"{stem}.docx", f"{stem}_REVIEW.docx"
        did = qp.upload("formatted", docx_path, docx_name, DOCX_MIME)
        formatted_names[docx_name] = did
        rid = qp.upload("formatted", review_docx_for(review_path), review_name, DOCX_MIME)
        formatted_names[review_name] = rid
        result["uploaded"].append({"folder": "formatted", "name": docx_name, "id": did})
        result["uploaded"].append({"folder": "formatted", "name": review_name, "id": rid})
        archived = free_name(archive_names, stem + "_ORIGINAL", Path(name).suffix)
        mv = qp.move(entry["id"], "archive", archived)
        archive_names[mv["name"]] = mv["id"]
        result["moved"] = {"folder": "archive", "name": mv["name"]}
        log(f"  -> 2_Formatted: {docx_name} + {review_name}; original archived as {mv['name']}")
        retire_superseded(base, stem, needsfixes_names, archive_names, work, result)
    return result


def cmd_run(args: argparse.Namespace) -> int:
    work = Path(args.work)
    work.mkdir(parents=True, exist_ok=True)
    inbox = qp.list_files("inbox")
    papers = [f for f in inbox if f["name"].lower().endswith(".docx") or f["mimeType"] == DOCX_MIME or is_pdf(f)]
    others = [f["name"] for f in inbox if f not in papers]
    if args.only:
        papers = [f for f in papers if f["name"] == args.only]
        if not papers:
            print(f"pipeline: no inbox file named {args.only!r}", file=sys.stderr)
            return 1
    log(f"inbox: {len(papers)} paper(s) to process" + (f", {len(others)} other file(s) left alone" if others else ""))
    for o in others:
        log(f"  skipping (not .docx/.pdf): {o}")

    listing = lambda key: {f["name"]: f["id"] for f in qp.list_files(key)} if not args.dry_run else {}
    formatted_names, needsfixes_names, archive_names = listing("formatted"), listing("needsfixes"), listing("archive")

    results = []
    for entry in sorted(papers, key=lambda f: f["modified"]):
        try:
            results.append(process(entry, work, formatted_names, needsfixes_names, archive_names, args.dry_run))
        except qp.BridgeError as e:
            results.append({"file": entry["name"], "id": entry["id"], "status": "error", "notes": [str(e)]})
            log(f"ERROR {entry['name']}: {e}")

    summary = {
        "dry_run": args.dry_run,
        "processed": len(results),
        "formatted": sum(1 for r in results if r["status"] == "formatted"),
        "needs_fixes": sum(1 for r in results if r["status"] == "needs-fixes"),
        "recovered": sum(1 for r in results if r["status"] == "recovered"),
        "unreadable": sum(1 for r in results if r["status"] == "unreadable"),
        "errors": sum(1 for r in results if r["status"] == "error"),
        "skipped": others,
        "results": results,
    }
    (work / "last_run.json").write_text(json.dumps(summary, indent=2))
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        log(f"done: {summary['formatted']} formatted, {summary['needs_fixes']} need fixes, {summary['unreadable']} unreadable, {summary['recovered']} recovered, {summary['errors']} errors" + (" (dry run)" if args.dry_run else ""))
    return 1 if summary["errors"] else 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="pipeline.py", description="VVCHS question-paper pipeline")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="process every .docx in 1_Inbox")
    r.add_argument("--dry-run", action="store_true", help="format only; do not upload or move anything")
    r.add_argument("--only", help="process just this inbox file name")
    r.add_argument("--work", default="work", help="working directory (default: ./work)")
    r.add_argument("--json", action="store_true", help="print a JSON summary")
    a = p.parse_args(argv)
    try:
        if a.cmd == "run":
            return cmd_run(a)
    except qp.BridgeError as e:
        print(f"pipeline: error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
