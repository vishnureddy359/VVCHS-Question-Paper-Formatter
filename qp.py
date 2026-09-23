#!/usr/bin/env python3
"""
qp.py — command-line client for the VVCHS Question Paper bridge.

The bridge is a Google Apps Script web app that exposes the "Question Papers"
Drive pipeline folders (and nothing else). It accepts a JSON POST body:

    {"token": "<secret>", "action": "list|download|upload|move|track|notify|ping", ...}

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
    python3 qp.py ping
    python3 qp.py track '{"Original file": "...", "Result": "..."}'
    python3 qp.py notify <file-id> --subject S --body TEXT

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
CLASS_AWARE = ("formatted", "needsfixes", "archive")  # may carry a "/Class-<Roman>" sub-folder
ROMAN = ("I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII")


def folder_key(spec: str) -> str:
    """Validate "formatted" or "formatted/Class-VII" and return the folder key."""
    key, _, sub = spec.partition("/")
    if key not in FOLDERS:
        raise BridgeError(f"unknown folder '{spec}' (choose one of {', '.join(FOLDERS)})")
    if sub:
        if key not in CLASS_AWARE:
            raise BridgeError(f"folder '{key}' has no sub-folders")
        if not (sub.startswith("Class-") and sub[6:] in ROMAN):
            raise BridgeError(f"sub-folder must be Class-<Roman numeral>, got '{sub}'")
    return key


def class_folder(key: str, cls: str | None) -> str:
    """'formatted' + 'VII' -> 'formatted/Class-VII'; falls back to the flat folder for unknown classes."""
    return f"{key}/Class-{cls}" if key in CLASS_AWARE and cls in ROMAN else key
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


def call(action: str, retries: int = RETRIES, **fields) -> dict:
    """POST one action to the bridge and return the decoded JSON reply.

    Transient failures (network errors, or Google's HTML error page instead of
    JSON) are retried with backoff. 'move' is idempotent so it is retried too;
    'upload' passes retries=1 and checks the folder itself, because a lost
    answer does not mean the upload did not happen.
    """
    url, token = _config()
    body = json.dumps({"token": token, "action": action, **fields}).encode("utf-8")
    last: Exception | None = None
    for attempt in range(1, retries + 1):
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
            # "POST a JSON body" is the bridge's doGet answer: Google's redirect occasionally drops the POST body
            transient = msg.startswith("cannot reach bridge") or msg.startswith("bridge did not return JSON") or msg.startswith("HTTP 5") or msg.startswith("HTTP 404") or msg == "POST a JSON body"
            if not transient or attempt == retries:
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
    if folder_key(folder) not in WRITABLE:
        raise BridgeError(f"folder '{folder}' is not writable (choose one of {', '.join(WRITABLE)})")
    name = name or path.name
    mime = mime or mimetypes.guess_type(name)[0] or "application/octet-stream"
    b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    for attempt in range(1, RETRIES + 1):
        try:
            return call("upload", retries=1, folder=folder, name=name, mimeType=mime, base64=b64)["id"]
        except BridgeError as e:
            msg = str(e)
            lost = msg.startswith("cannot reach bridge") or msg.startswith("bridge did not return JSON") or msg.startswith("HTTP 5") or msg.startswith("HTTP 404") or msg == "POST a JSON body"
            if not lost or attempt == RETRIES:
                raise
            # the answer was lost, not necessarily the upload: if the file is there now, that is our upload
            time.sleep(2 ** attempt)
            found = [f for f in list_files(folder) if f["name"] == name and not (f.get("sub") and "/" not in folder)]
            if found:
                return found[0]["id"]
    raise BridgeError("upload failed")


def move(file_id: str, folder: str, name: str | None = None) -> dict:
    if folder_key(folder) not in WRITABLE:
        raise BridgeError(f"folder '{folder}' is not writable (choose one of {', '.join(WRITABLE)})")
    fields = {"id": file_id, "folder": folder}
    if name:
        fields["name"] = name
    return call("move", **fields)


def ping() -> dict:
    """Bridge health: folders, whether class folders / tracker / email are available."""
    return call("ping")


def track(row: dict) -> dict:
    """Append one row to the tracker sheet. Keys are the sheet's column headings; unknown keys are ignored."""
    return call("track", row=row)


def notify(file_id: str, subject: str, body: str, html: str | None = None) -> dict:
    """Email the uploader of a pipeline file. The bridge chooses the recipient (the file's owner);
    returns {"sent": True, "to": ...} or {"sent": False, "reason": ...}."""
    fields = {"id": file_id, "subject": subject, "body": body}
    if html:
        fields["html"] = html
    return call("notify", **fields)


def file_url(file_id: str) -> str:
    """Drive's viewer link for a file id (the same link the Drive UI shows)."""
    return f"https://drive.google.com/file/d/{file_id}/view"


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
    subs = any(f.get("sub") for f in files)
    for f in sorted(files, key=lambda f: f["modified"], reverse=True):
        where = f"  {f.get('sub') or '':<10}" if subs else ""
        print(f"{f['id']}  {f['modified'][:19]}  {_fmt_size(f['size']):>9}{where}  {f['name']:<{width}}")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="qp.py", description="VVCHS Question Paper bridge client")
    sub = p.add_subparsers(dest="cmd", required=True)

    def folder_arg(spec: str) -> str:
        try:
            folder_key(spec)
        except BridgeError as e:
            raise argparse.ArgumentTypeError(str(e))
        return spec

    s = sub.add_parser("list", help="list files in a pipeline folder (or folder/Class-VII)")
    s.add_argument("folder", type=folder_arg)
    s.add_argument("--json", action="store_true", help="print raw JSON")

    s = sub.add_parser("download", help="download a file by id")
    s.add_argument("id")
    s.add_argument("--out", type=Path, help="destination file or directory (default: original name in cwd)")

    s = sub.add_parser("upload", help="upload a local file into a writable folder (or folder/Class-VII)")
    s.add_argument("folder", type=folder_arg)
    s.add_argument("file", type=Path)
    s.add_argument("--name", help="name to give the file in Drive (default: local file name)")
    s.add_argument("--mime", help="MIME type (default: guessed from the name)")

    s = sub.add_parser("move", help="move (and optionally rename) a file to a writable folder (or folder/Class-VII)")
    s.add_argument("id")
    s.add_argument("folder", type=folder_arg)
    s.add_argument("--name", help="new name for the file")

    sub.add_parser("ping", help="check the bridge: folders, tracker sheet, email")

    s = sub.add_parser("track", help="append a row to the tracker sheet (JSON object of column -> value)")
    s.add_argument("row", help='e.g. \'{"Original file": "x.docx", "Result": "test"}\'')

    s = sub.add_parser("notify", help="email the uploader of a pipeline file")
    s.add_argument("id")
    s.add_argument("--subject", required=True)
    s.add_argument("--body", required=True, help="plain-text body")

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
        elif a.cmd == "ping":
            print(json.dumps(ping(), indent=2))
        elif a.cmd == "track":
            try:
                row = json.loads(a.row)
            except json.JSONDecodeError as e:
                raise BridgeError(f"row is not JSON: {e}")
            r = track(row)
            print(f"row {r.get('row')} added to {r.get('url')}")
        elif a.cmd == "notify":
            r = notify(a.id, a.subject, a.body)
            print(f"sent to {r['to']}" + (f" (cc {r['cc']})" if r.get("cc") else "") if r.get("sent") else f"not sent: {r.get('reason')}")
    except BridgeError as e:
        print(f"qp.py: error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
