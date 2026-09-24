# VVCHS question-paper formatter — notes for Claude

Teachers drop question papers (.docx, .doc, .pdf) into the Drive folder `1_Inbox`. `pipeline.py` formats each one to the
school template, files it into `2_Formatted` or `3_Needs-Fixes` (sub-folder `Class-<Roman>`), archives the original in
`4_Archive`, appends a row to the "Question Papers - Tracker" sheet and emails the uploading teacher.

## Layout
- `formatter/src/` — Node formatter: `parse.js` (docx → blocks), `model.js` (heuristics: questions, sub-parts, options,
  marks, layout tables), `review.js` (checklist, blocking issues), `build.js` (renders the template with `docx`).
- `pipeline.py` — the run; `qp.py` — client for the Apps Script bridge (`bridge/Code.gs`), the only way to reach Drive.
- `template/VVCHS_Question_Paper_Format_Spec.md` — the formatting rules. Change it whenever a rule changes.
- `tools/regress.py` — regression over real papers kept outside the repo.

## Commands
- Tests: `cd formatter && npm test` (synthetic fixtures only).
- Check the inbox without touching anything: `python3 pipeline.py pending` (counts only).
- Dry run: `python3 pipeline.py run --dry-run --work <scratch dir>`.
- Real run: `python3 pipeline.py run --class-folders --track --notify --json`.
- Regression: `python3 tools/regress.py run <papers> <out_old>` on main, again after the change, then `diff <out_old> <out_new>`.
- Visual check: `soffice --headless --convert-to pdf`, then render only the pages you changed, at about 80 dpi.

## Rules
- Never print `QP_BRIDGE_TOKEN`. Change Drive only through `qp.py` / `pipeline.py`. The bridge cannot delete files, and
  `_Template` is read-only.
- Never commit a real exam paper; tests use synthetic fixtures built in `formatter/test/run.js`.
- Re-issuing a paper: move the old `<Name>.docx` and `<Name>_REVIEW.docx` to `4_Archive/Class-<n>` as
  `<Name>_superseded_vN.docx` (next free N), then upload the new pair.
- Git: work on the branch the session names, open PRs as drafts, and merge only when the user says "merge PRn".
  This repo has no CI, so do not schedule PR check-ins or subscribe to PR activity.
- A formatter change needs: `npm test` passing, a clean regression diff (explain every changed paper), the spec or
  README updated when a rule changes, and a render of the affected pages.

## Keeping token use low
- One task per session; start a new session instead of continuing a long one.
- Read files by section (`sed -n`, `grep -n`), never whole large files; print short summaries, not full outputs.
- Render only the pages that changed, at low resolution, and look at them once.
