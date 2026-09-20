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
| `formatter/` | Node package that turns one teacher `.docx` into the template layout plus a `_REVIEW.docx` note (Markdown on disk, Word in Drive). See `formatter/README.md`. |
| `pipeline.py` | Runs the whole inbox through the formatter and routes results into the Drive folders. |
| `pdf_to_docx.py` | Converts a PDF submission to a plain `.docx` (text rows, images, tables) so the formatter can read it. |
| `review_docx.py` | Turns a review note (Markdown) into a small Word file, because Drive has no viewer for `.md`. |
| `template/` | Local copies of the `_Template` assets: format spec, reference builder, logo. |
| `bridge/` | Source of the Apps Script bridge (`Code.gs`) and how to deploy it. |

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
python3 pipeline.py run --class-folders    # file into 2_Formatted/Class-VII etc. (needs the class-aware bridge)
```

For every `.docx` or `.pdf` in `1_Inbox` the pipeline downloads it (a PDF is
first converted to Word with `pdf_to_docx.py`, and the review note says so),
runs the formatter and then:

- **no blocking issues**: uploads `<Name>.docx` and `<Name>_REVIEW.docx` to
  `2_Formatted` and moves the original to `4_Archive` as `<Name>_ORIGINAL.docx`;
- **blocking issues** (missing figure, marks that don't add up, incomplete
  question): uploads the review to `3_Needs-Fixes` and moves the original there
  unchanged, so the teacher can fix it and re-upload with `_v2`;
- **a corrected re-upload**: when a paper formats cleanly and an earlier attempt
  of the same paper is still in `3_Needs-Fixes`, that attempt's note and original
  are moved to `4_Archive` with a `_superseded` suffix;
- **formatter error**: leaves the file in the inbox and reports it;
- **our own output already in the target folder** while the original is still
  in the inbox (a move that stalled in an earlier run): uploads whatever is
  missing, redoes the move and reports the file as recovered. A review note
  with the same name but different content is someone else's file and is left
  alone; the pipeline then uses a `_v2` name for its own output.

With `--class-folders` every output goes into a `Class-<n>` sub-folder of
`2_Formatted`, `3_Needs-Fixes` and `4_Archive` (created on first use), so a
coordinator can open one class at a time. The inbox stays flat. This needs the
bridge in `bridge/Code.gs`; see `bridge/README.md` for deploying it.

Names are `<Subject>_<Class>_<ExamCode>_<Session>` per the spec, the class in
Roman numerals and the exam code taken from the paper's own header. If a name
is already taken in the target folder the pipeline appends `_v2`, `_v3`, and
so on. Files that are neither `.docx` nor `.pdf` are left alone. Because
processed originals always leave the inbox, re-running is safe.

PDFs are second best: a PDF has no paragraphs, so the converter rebuilds them
from line positions, stacked fractions are rejoined as `a/b`, and drawn shapes
survive only as pictures. Teachers should send the Word file when they have it.
A PDF whose text cannot be read at all (Word-generated Hindi/Marathi PDFs often
embed the Mangal font without a character map, and scans have no text) is sent
to `3_Needs-Fixes` with a note asking for the Word file.

Hindi and Marathi papers are supported when they arrive as Word files: `प्र. 1`
question numbers, `क) ख) ग)` sub-parts, `(i) (ii) (iii)` option rows, marks
written as `(1x5 M)`, `(1 M)` or `अंक`, papers without section headings
(primary classes), and matching exercises laid out as two columns. Devanagari
runs are set in Mangal as the complex-script font.

What the review note does and does not hold against a paper:

- Blocking: marks that do not add up, a figure or diagram that the text refers
  to but the file lacks, an OR with no alternative, unreadable text.
- Not blocking: a map question without a map (outline maps are printed
  separately), missing per-question marks when the section total is given, a
  file name whose class or subject differs from the paper's header (the paper
  is filed by its header and the note asks you to confirm).
- Subject codes and the General Instructions block are only expected from
  Class IX up, so notes for younger classes do not mention them.

Each run writes `work/last_run.json` with the outcome per file. Exit code is 1
if any file errored.
