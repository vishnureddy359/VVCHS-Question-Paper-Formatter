# VVCHS Question Paper — Format Specification & Processing Rules

Reference: English_IX_HYE_2026-27.pdf (Word-generated). First applied to Maths_IX_HYE_2026-27.docx on 16 Sep 2026.

## 1. Page setup (A4 portrait)
- Margins: top 700 twips (~0.49"), bottom 567, left 709, right 709. Header distance 113, footer 200.
- Page border on every page, offset from page edge (space 24pt), size 12:
  top/left = thinThickSmallGap, bottom/right = thickThinSmallGap (renders thick outer + thin inner line).
- Footer: "Page N" centred, Calibri 11.
- Body font: Times New Roman 11, line spacing 1.15 (w:line=276, auto). Passages justified.

## 2. Header block (page 1 only)
- School logo (vvchs_logo.jpeg, 47×41 pt) floating top-left: horizontal offset −97790 EMU from column, vertical ≈ −40000 EMU from title paragraph. No wrap.
- Line 1: VIDYA VIHAR CONVENT HIGH SCHOOL, CHANDRAPUR — TNR Bold 16, centred, all caps.
- Line 2: <EXAM NAME> – <SESSION>  (e.g. HALF-YEARLY EXAMINATION – 2026-2027) — TNR Bold 14, centred.
- Line 3: Class: <IX> [tab 3600] Subject: <SUBJECT (code)> [tab 8640] Marks: <80> marks — TNR Bold 12. Subject in caps.
- Line 4: Date: <dd/mm/yyyy> [tab 3600] Roll No.:______________ [tab 8640] Time: <3 hours> — TNR Bold 12.
  Paragraph bottom border 1.75pt (sz 14), space 4; indent left −152 / firstLine 152 / right −228 so the rule runs border-to-border.
- "General Instructions:" — TNR Bold Italic 12, underlined.
- Instruction items — TNR Bold Italic 12, numbered "1." with indent left 284 / hanging 284.

## 3. Body
- Section heading: SECTION A – <TITLE> (<marks>) — TNR Bold 14, centred, underlined, spacing before 200 / after 120. Marks expression stays inside the heading in parentheses.
- Section instruction line ("Questions 1–18: …") — TNR Bold 11, left.
- Question: number bold ("1."), text regular; indent left 360 / hanging 360; keepNext + keepLines; spacing after 40.
- Umbrella question (a stem that only introduces its sub-parts, e.g. "1. Answer any 4 out of the given 6 questions:", "Fill in the blanks:", "Match the following:"): the stem is bold as well, like a sub-heading. A question that is itself answerable ("6. What is a hyperlink?") stays regular. (Added 22 Sep 2026.)
- Sub-parts (a)/(i): label at 360, text at 720 (indent left 720 / hanging 360).
- MCQ options, 4 on one line: indent 360, tab stops 2880 / 5400 / 7920; spacing after 120 closes the question.
- Options beside a figure: 2 per line.
- Marks per question/sub-part: right-aligned at the margin (right tab 10488), written as "1M", "2M", "5M".
- OR: bold, centred, spacing 40/40.
- Figures: borderless 2-column table (text left, image right-aligned), row cantSplit, cell vAlign centre; keep the source display size. Cell margins 0 (left cell right margin 100).
- Superscripts as true superscript runs; recurring decimals with combining overline (2.2̅5̅7̅).
- Closing line: asterisks + END + asterisks, bold, centred.
- Everything black; no colours, no highlights added by us.

## 4. Content rules (what we change vs. keep)
- Change ONLY formatting. Text stays verbatim, including odd wording — list issues in the REVIEW file instead of silently fixing.
- Keep any highlights the teacher left (they are reviewer flags); mention them in REVIEW.
- Keep duplicate question numbers used for OR alternatives (e.g. two "29.") — flag in REVIEW.
- Figures built from loose Word shapes that don't render: redraw cleanly with the same labels and say so in REVIEW.
- Convert "[1]" style marks to "1M" right-aligned.

## 5. Review checklist (runs before formatting; output = <name>_REVIEW.md)
1. Marks arithmetic: section totals vs. the blueprint in General Instructions vs. section headings vs. paper total.
2. Numbering: gaps, duplicates, sub-part labels, OR alternates with missing parts.
3. Marks missing on any question/sub-part, "(marks)" placeholders, stray notes ("Which numbers", "drawn").
4. Figures: each "in the figure" reference has a figure; figures readable; stray duplicates.
5. Notation: superscripts, √, ∠, ⊥, ∥, ₹, degree signs; x vs X consistency; missing brackets/commas in options.
6. Language: obvious typos, "Is" for "is", broken sentences.
7. Header fields present: class, subject + code, marks, date, time.
Blocking (send to 3_Needs-Fixes): missing figures, marks that don't add up, incomplete questions. Non-blocking: list only.

## 6. Naming convention
<Subject>_<Class>_<ExamCode>_<Session>.docx   e.g. Maths_IX_HYE_2026-27.docx
- Subject as on the paper (Maths, English, Science, SocialScience, Hindi, Marathi…), Class in Roman numerals.
- Exam codes: PT1, PT2, HYE, PREBOARD, ANNUAL.
- Companion file: <same name>_REVIEW.md. Originals archived as <same name>_ORIGINAL.<ext>. Re-uploads: _v2, _v3.

## 7. Folder workflow
1_Inbox → (review + format) → 2_Formatted (docx + REVIEW) ; original → 4_Archive
Blocking issues → 3_Needs-Fixes (original + REVIEW) ; teacher fixes and re-uploads to 1_Inbox.
