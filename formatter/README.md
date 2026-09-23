# VVCHS question-paper formatter

Takes a teacher-submitted `.docx` from `1_Inbox`, reformats it to the school
template (`template/VVCHS_Question_Paper_Format_Spec.md`) and writes a review
note. The text is kept verbatim; only layout changes.

```
cd formatter
npm install
node src/index.js path/to/Maths_8th_PT1_2026-2027.docx --out out
```

Output in `out/`:

| File | What it is |
| --- | --- |
| `<Subject>_<Class>_<Exam>_<Session>.docx` | The paper on the template (A4, page border, header block, TNR 11, marks right-aligned as `nM`, options 4 per line, figures beside their question). |
| `<same name>_REVIEW.md` | The review checklist result: marks arithmetic, header fields, numbering, wording, figures, and what the formatter changed. |

Exit code `0` means formatted; `2` means formatted but a blocking issue was
found (missing figure, marks that don't add up, incomplete question), so the
paper belongs in `3_Needs-Fixes`; `1` is an error. `--json` prints a machine
readable summary; `--name BASE` overrides the output name.

## How it works

1. `src/parse.js` reads `word/document.xml` directly: runs with bold/italic/superscript/highlight, images with their display size (inline, anchored, VML and AlternateContent), Word auto-numbering resolved to labels, equation objects linearised (`3/4`, `x^{2}`), tables with their borders.
2. `src/model.js` classifies the lines: header fields, `Section X (…)` headings, question starts (`Q.1.`, `12.`, `16.(A)`, auto-numbers), `1M`/`[1]`/`(2 marks)` marks, `OR` lines (also when glued to a sentence), option rows (`a) … b) … c) … d) …`, sub-parts `(a)`/`(i)`, figures and tables. A run of three or more spaces is read as a column gap (a tab), so a matching exercise typed as `a) Plains        i) Rajasthan` under a `Column A        Column B` line keeps its two columns; a blank inside brackets `(     )` stays a blank. A heading written `SECTION: HISTORY` without a letter gets the next letter (noted in the review), a rule of dashes before a heading is ignored, a mark typed at the start of the next question's line (`2M  5) A. …`) is attached to the right question, and `OR.` glued to the end of a sentence becomes an OR line. A section expression such as `(20 * 1 = 20)` is read as "count × per" when the first factor matches the number of questions in the section and none of them carries its own mark; `Q .1.` with a space, a question glued to a section heading (`Section D (15 marks) Q. 8. …`) and a first sub-part glued after the marks product (`… (1x5=5m) 1) A lion …`) are recognised, and a small `4) …` line inside a high-numbered question is a match-table row, not question 4. It then infers missing marks from the section expression or the sub-parts, joins lines the teacher broke by hand (also a line ending on a function word such as "in" or "the", and a closing fragment such as "Writer?"), drops whole-line bold, and sets `180o` as `180°`. Option labels are set as `(a)` whatever the teacher typed (`a)`, `a.`, `(d)Text`); labels glued to the previous word (`Animation(b) Hyperlink(c) …`) are still split; options typed in two columns (`(a) … (c) …` over `(b) … (d) …`) are read across; rows whose labels run on (`(a) (b)` then `(c) (d)`) are one set, laid out 4, 2 or 1 per line by length; and in an MCQ question ("Select the correct option …") four `(a)`–`(d)` lines under a numbered sub-question are its options however long they are. `i.____ feature of Writer` is sub-part (i).
3. `src/review.js` runs the checklist from the spec and decides whether anything is blocking.
4. `src/build.js` renders the model with `docx` using the same helpers as `template/build_paper_example.js`.

Papers vary a lot, so the model is heuristic. Anything it is unsure about is listed in the review rather than silently fixed.

## Test

```
npm test
```

Builds a small synthetic paper, runs the whole pipeline and checks the model, the review and the generated document. No real exam papers are kept in the repository.
