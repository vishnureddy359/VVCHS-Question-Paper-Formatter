# VVCHS Question Paper Formatter

Tooling that reformats teacher-submitted question papers for Vidya Vihar
Convent High School, Chandrapur, to the school's CBSE-pattern template.

Papers flow through Google Drive folders (1_Inbox, 2_Formatted, 3_Needs-Fixes,
4_Archive, _Template) via a small Apps Script bridge; the tools in this repo
talk to that bridge, never to Drive directly.

## Pieces

| Path | Purpose |
| --- | --- |
| `qp.py` | Command-line client for the bridge: `list`, `download`, `upload`, `move`. |
| `formatter/` | Node package that turns one teacher `.docx` into the template layout plus a `_REVIEW.md` note. See `formatter/README.md`. |
| `pipeline.py` | Runs the whole inbox through the formatter and routes results into the Drive folders. |
| `pdf_to_docx.py` | Converts a PDF submission to a plain `.docx` (text rows, images, tables) so the formatter can read it. |
| `template/` | Local copies of the `_Template` assets: format spec, reference builder, logo. |

## Setup

```
cd formatter && npm install && cd ..
pip install -r requirements.txt        # PyMuPDF + python-docx, only needed for PDF submissions
export QP_BRIDGE_URL=https://script.google.com/macros/s/<deployment>/exec
export QP_BRIDGE_TOKEN=<the TOKEN script property>
```

## Running the pipeline

```
python3 pipeline.py run --dry-run    # download + format only; nothing changes in Drive
python3 pipeline.py run              # the real thing
python3 pipeline.py run --only Maths_8th_PT1_2026-2027.docx
```

For every `.docx` or `.pdf` in `1_Inbox` the pipeline downloads it (a PDF is
first converted to Word with `pdf_to_docx.py`, and the review note says so),
runs the formatter and then:

- **no blocking issues**: uploads `<Name>.docx` and `<Name>_REVIEW.md` to
  `2_Formatted` and moves the original to `4_Archive` as `<Name>_ORIGINAL.docx`;
- **blocking issues** (missing figure, marks that don't add up, incomplete
  question): uploads the review to `3_Needs-Fixes` and moves the original there
  unchanged, so the teacher can fix it and re-upload with `_v2`;
- **formatter error**: leaves the file in the inbox and reports it;
- **our own output already in the target folder** while the original is still
  in the inbox (a move that stalled in an earlier run): uploads whatever is
  missing, redoes the move and reports the file as recovered. A review note
  with the same name but different content is someone else's file and is left
  alone; the pipeline then uses a `_v2` name for its own output.

Names are `<Subject>_<Class>_<ExamCode>_<Session>` per the spec, the class in
Roman numerals and the exam code taken from the paper's own header. If a name
is already taken in the target folder the pipeline appends `_v2`, `_v3`, and
so on. Files that are neither `.docx` nor `.pdf` are left alone. Because
processed originals always leave the inbox, re-running is safe.

PDFs are second best: a PDF has no paragraphs, so the converter rebuilds them
from line positions, stacked fractions are rejoined as `a/b`, and drawn shapes
survive only as pictures. Teachers should send the Word file when they have it.

Each run writes `work/last_run.json` with the outcome per file. Exit code is 1
if any file errored.
