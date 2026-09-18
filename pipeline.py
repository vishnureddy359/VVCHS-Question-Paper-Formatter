#!/usr/bin/env python3
"""
pipeline.py — run the VVCHS question-paper pipeline against the Drive folders.

For every .docx in 1_Inbox:
  1. download it through the bridge (qp.py)
  2. run the formatter (formatter/src/index.js) -> <Name>.docx + <Name>_REVIEW.md
  3. route the result:
       no blocking issues  -> <Name>.docx + REVIEW to 2_Formatted, original to 4_Archive as <Name>_ORIGINAL.docx
       blocking issues     -> REVIEW to 3_Needs-Fixes, original moved there unchanged
       formatter error     -> left in 1_Inbox, reported

Files that are not .docx (notes, PDFs, stale review files) are left alone and listed.
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
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import qp

ROOT = Path(__file__).resolve().parent
FORMATTER = ROOT / "formatter" / "src" / "index.js"
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


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


def process(entry: dict, work: Path, formatted_names: set[str], needsfixes_names: set[str], archive_names: set[str], dry_run: bool) -> dict:
    name = entry["name"]
    result = {"file": name, "id": entry["id"], "status": None, "name": None, "uploaded": [], "moved": None, "notes": []}
    src_dir = work / "inbox"
    src_dir.mkdir(parents=True, exist_ok=True)
    src = qp.download(entry["id"], src_dir / name)
    log(f"downloaded {name} ({src.stat().st_size} bytes)")

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
    result["name"] = base
    result["status"] = "needs-fixes" if blocking else "formatted"
    result["marks"] = summary.get("marks")
    result["headerMarks"] = summary.get("headerMarks")
    log(f"formatted {name} -> {base} ({'NEEDS FIXES' if blocking else 'OK'}, {summary['questions']} questions, {summary['marks']} marks)")

    if dry_run:
        result["notes"].append("dry run: nothing uploaded or moved")
        return result

    if blocking:
        review_name = free_name(needsfixes_names, base + "_REVIEW", ".md")
        rid = qp.upload("needsfixes", review_path, review_name, "text/markdown")
        needsfixes_names.add(review_name)
        result["uploaded"].append({"folder": "needsfixes", "name": review_name, "id": rid})
        moved_name = free_name(needsfixes_names, Path(name).stem, Path(name).suffix)
        mv = qp.move(entry["id"], "needsfixes", moved_name if moved_name != name else None)
        needsfixes_names.add(mv["name"])
        result["moved"] = {"folder": "needsfixes", "name": mv["name"]}
        log(f"  -> 3_Needs-Fixes: {review_name}, original moved as {mv['name']}")
    else:
        docx_name = free_name(formatted_names, base, ".docx")
        stem = docx_name[:-5]
        review_name = f"{stem}_REVIEW.md"
        did = qp.upload("formatted", docx_path, docx_name, DOCX_MIME)
        formatted_names.add(docx_name)
        rid = qp.upload("formatted", review_path, review_name, "text/markdown")
        formatted_names.add(review_name)
        result["uploaded"].append({"folder": "formatted", "name": docx_name, "id": did})
        result["uploaded"].append({"folder": "formatted", "name": review_name, "id": rid})
        archived = free_name(archive_names, stem + "_ORIGINAL", Path(name).suffix)
        mv = qp.move(entry["id"], "archive", archived)
        archive_names.add(mv["name"])
        result["moved"] = {"folder": "archive", "name": mv["name"]}
        log(f"  -> 2_Formatted: {docx_name} + {review_name}; original archived as {mv['name']}")
    return result


def cmd_run(args: argparse.Namespace) -> int:
    work = Path(args.work)
    work.mkdir(parents=True, exist_ok=True)
    inbox = qp.list_files("inbox")
    papers = [f for f in inbox if f["name"].lower().endswith(".docx") or f["mimeType"] == DOCX_MIME]
    others = [f["name"] for f in inbox if f not in papers]
    if args.only:
        papers = [f for f in papers if f["name"] == args.only]
        if not papers:
            print(f"pipeline: no inbox file named {args.only!r}", file=sys.stderr)
            return 1
    log(f"inbox: {len(papers)} paper(s) to process" + (f", {len(others)} other file(s) left alone" if others else ""))
    for o in others:
        log(f"  skipping non-docx: {o}")

    formatted_names = {f["name"] for f in qp.list_files("formatted")} if not args.dry_run else set()
    needsfixes_names = {f["name"] for f in qp.list_files("needsfixes")} if not args.dry_run else set()
    archive_names = {f["name"] for f in qp.list_files("archive")} if not args.dry_run else set()

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
        "errors": sum(1 for r in results if r["status"] == "error"),
        "skipped": others,
        "results": results,
    }
    (work / "last_run.json").write_text(json.dumps(summary, indent=2))
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        log(f"done: {summary['formatted']} formatted, {summary['needs_fixes']} need fixes, {summary['errors']} errors" + (" (dry run)" if args.dry_run else ""))
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
