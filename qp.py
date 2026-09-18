#!/usr/bin/env python3
"""
qp.py — command-line client for the VVCHS Question Paper bridge.

The bridge is a Google Apps Script web app that exposes the "Question Papers"
Drive pipeline folders (and nothing else). It accepts a JSON POST body:

    {"token": "<secret>", "action": "list|download|upload|move", ...}

and answers with JSON. Errors come back as {"error": "<message>"}.

Folder keys understood by the bridge:

    inbox        1_Inbox         (writable)
    formatted    2_Formatted     (writable)
    needsfixes   3_Needs-Fixes   (writable)
    archive      4_Archive       (writable)
    template     _Template       (read only)

Configuration comes from the environment:

    QP_BRIDGE_URL    the web-app /exec URL
    QP_BRIDGE_TOKEN  the shared secret stored in the script's TOKEN property

Usage:

    python3 qp.py list <folder> [--json]
    python3 qp.py download <file-id> [--out PATH]
    python3 qp.py upload <folder> <local-file> [--name NAME] [--mime TYPE]
    python3 qp.py move <file-id> <folder> [--name NEW_NAME]

Only the Python standard library is used.
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

FOLDERS = ("inbox", "formatted", "needsfixes", "archive", "template")
WRITABLE = ("inbox", "formatted", "needsfixes", "archive")
TIMEOUT_SECONDS = 120


class BridgeError(Exception):
    """Raised when the bridge returns {"error": ...} or cannot be reached."""


def _config() -> tuple[str, str]:
    url = os.environ.get("QP_BRIDGE_URL", "").strip()
    token = os.environ.get("QP_BRIDGE_TOKEN", "").strip()
    missing = [n for n, v in (("QP_BRIDGE_URL", url), ("QP_BRIDGE_TOKEN", token)) if not v]
    if missing:
        raise BridgeError("missing environment variable(s): " + ", ".join(missing))
    return url, token


def _ssl_context() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    for var in ("SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"):
        bundle = os.environ.get(var)
        if bundle and Path(bundle).is_file():
            ctx.load_verify_locations(cafile=bundle)
    return ctx


RETRIES = 3  # Apps Script occasionally answers with an HTML error page or times out; retry those


def _post_once(url: str, body: bytes) -> bytes:
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    # Apps Script answers a POST with a 302 to script.googleusercontent.com;
    # urllib follows it with a GET, which is exactly what the bridge expects.
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS, context=_ssl_context()) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        raise BridgeError(f"HTTP {e.code} from bridge: {e.read()[:300].decode('utf-8', 'replace')}") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise BridgeError(f"cannot reach bridge: {getattr(e, 'reason', e)}") from e


def call(action: str, **fields) -> dict:
    """POST one action to the bridge and return the decoded JSON reply.

    Transient failures (network errors, or Google's HTML error page instead of
    JSON) are retried with backoff. Writes are retried too: 'upload' fails
    cleanly on a duplicate name, and 'move' is idempotent.
    """
    url, token = _config()
    body = json.dumps({"token": token, "action": action, **fields}).encode("utf-8")
    last: Exception | None = None
    for attempt in range(1, RETRIES + 1):
        try:
            raw = _post_once(url, body)
            try:
                data = json.loads(raw)
            except json.JSONDecodeError as e:
                snippet = raw[:200].decode("utf-8", "replace")
                raise BridgeError(f"bridge did not return JSON (is the deployment URL right?): {snippet}") from e
            if isinstance(data, dict) and "error" in data:
                raise BridgeError(data["error"])  # a real answer from the bridge: do not retry
            return data
        except BridgeError as e:
            msg = str(e)
            # Apps Script's redirect target answers 404/5xx now and then for a file it serves fine a moment later
            transient = msg.startswith("cannot reach bridge") or msg.startswith("bridge did not return JSON") or msg.startswith("HTTP 5") or msg.startswith("HTTP 404")
            if not transient or attempt == RETRIES:
                raise
            last = e
            time.sleep(2 ** attempt)
    raise BridgeError(str(last))


# ---------------------------------------------------------------- actions

def list_files(folder: str) -> list[dict]:
    return call("list", folder=folder).get("files", [])


def download(file_id: str, out: Path | None = None) -> Path:
    data = call("download", id=file_id)
    dest = out or Path(data["name"])
    if dest.is_dir():
        dest = dest / data["name"]
    dest.write_bytes(base64.b64decode(data["base64"]))
    return dest


def upload(folder: str, path: Path, name: str | None = None, mime: str | None = None) -> str:
    if folder not in WRITABLE:
        raise BridgeError(f"folder '{folder}' is not writable (choose one of {', '.join(WRITABLE)})")
    name = name or path.name
    mime = mime or mimetypes.guess_type(name)[0] or "application/octet-stream"
    b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    return call("upload", folder=folder, name=name, mimeType=mime, base64=b64)["id"]


def move(file_id: str, folder: str, name: str | None = None) -> dict:
    if folder not in WRITABLE:
        raise BridgeError(f"folder '{folder}' is not writable (choose one of {', '.join(WRITABLE)})")
    fields = {"id": file_id, "folder": folder}
    if name:
        fields["name"] = name
    return call("move", **fields)


# ---------------------------------------------------------------- CLI

def _fmt_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n} B"


def _print_table(files: list[dict]) -> None:
    if not files:
        print("(empty)")
        return
    width = max(len(f["name"]) for f in files)
    for f in sorted(files, key=lambda f: f["modified"], reverse=True):
        print(f"{f['id']}  {f['modified'][:19]}  {_fmt_size(f['size']):>9}  {f['name']:<{width}}")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="qp.py", description="VVCHS Question Paper bridge client")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("list", help="list files in a pipeline folder")
    s.add_argument("folder", choices=FOLDERS)
    s.add_argument("--json", action="store_true", help="print raw JSON")

    s = sub.add_parser("download", help="download a file by id")
    s.add_argument("id")
    s.add_argument("--out", type=Path, help="destination file or directory (default: original name in cwd)")

    s = sub.add_parser("upload", help="upload a local file into a writable folder")
    s.add_argument("folder", choices=WRITABLE)
    s.add_argument("file", type=Path)
    s.add_argument("--name", help="name to give the file in Drive (default: local file name)")
    s.add_argument("--mime", help="MIME type (default: guessed from the name)")

    s = sub.add_parser("move", help="move (and optionally rename) a file to a writable folder")
    s.add_argument("id")
    s.add_argument("folder", choices=WRITABLE)
    s.add_argument("--name", help="new name for the file")

    a = p.parse_args(argv)
    try:
        if a.cmd == "list":
            files = list_files(a.folder)
            if a.json:
                print(json.dumps(files, indent=2))
            else:
                _print_table(files)
        elif a.cmd == "download":
            dest = download(a.id, a.out)
            print(f"saved {dest} ({_fmt_size(dest.stat().st_size)})")
        elif a.cmd == "upload":
            if not a.file.is_file():
                raise BridgeError(f"no such file: {a.file}")
            print(upload(a.folder, a.file, a.name, a.mime))
        elif a.cmd == "move":
            r = move(a.id, a.folder, a.name)
            print(f"moved {r['id']} -> {a.folder}/{r['name']}")
    except BridgeError as e:
        print(f"qp.py: error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
