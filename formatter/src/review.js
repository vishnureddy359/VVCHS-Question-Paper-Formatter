// Run the review checklist over a paper model and produce <name>_REVIEW.md.
//
// Blocking (send to 3_Needs-Fixes): missing figures, marks that don't add up, incomplete questions.
// Everything else is listed only.

"use strict";

const { plain, normalizeClass, subjectSlug, romanToInt, topSubs } = require("./model");

// "picture" and "image" only count when the text points at one ("in the given picture", "identify the image
// shown"): computer papers talk about images and pictures as subject matter
const FIGURE_WORDS = /\b(figure|fig\.|diagram|adjoining|graph shown|in the given figure|the given diagram|(?:in|observe|identify|look at|see|study|label|name|from)\s+the\s+(?:given\s+|following\s+|above\s+|below\s+)?(?:picture|image|photo(?:graph)?)|(?:picture|image|photo(?:graph)?)s?\s+(?:given|shown|below|above|alongside)|on the (?:given |outline |political |physical )?map|outline map|in the map|map of india|map of the world)\b/i;
const DRAW_WORDS = /\b(draw|construct|sketch|plot|represent .* on)\b/i;

function qLabel(e) {
  if (e.kind !== "question") return "note";
  return "Q" + e.number + (e.alt ? "(" + e.alt + ")" : "");
}

function stemText(e) {
  return e.items.filter((x) => x.kind === "stem" || x.kind === "cont").map((x) => plain(x.runs)).join(" ");
}

function allText(e) {
  const parts = [];
  for (const it of e.items) {
    if (it.runs) parts.push(plain(it.runs));
    if (it.items) for (const o of it.items) parts.push(plain(o));
  }
  return parts.join(" ");
}

function hasFigure(e) {
  return e.items.some((x) => x.kind === "image" || x.kind === "images" || x.kind === "table" || x.kind === "tables");
}

// Consecutive questions with the same number (or A/B alternatives) are one question for marks.
function groupQuestions(section) {
  const groups = [];
  for (const e of section.entries) {
    if (e.kind !== "question") continue;
    const last = groups[groups.length - 1];
    if (last && last.number === e.number) last.parts.push(e);
    else groups.push({ number: e.number, parts: [e] });
  }
  return groups;
}

// A part's questions, with those under an "Answer any N … (NxM=T)" instruction gathered into one unit that
// counts T towards the section whatever number of questions the paper offers to choose from.
function sectionUnits(part) {
  const units = [];
  let cur = null;
  for (const e of part.entries) {
    if (e.kind === "note") { cur = e.group ? { kind: "grp", group: e.group, qs: [] } : null; if (cur) units.push(cur); continue; }
    if (e.kind !== "question") continue;
    const target = cur ? cur.qs : units;
    const last = target[target.length - 1];
    if (last && last.kind === "q" && last.number === e.number) last.parts.push(e); else target.push({ kind: "q", number: e.number, parts: [e] });
  }
  return units;
}

function groupMarks(g) {
  const ms = g.parts.map((p) => p.marks).filter((m) => m != null);
  return ms.length ? Math.max(...ms) : null;
}

function review(model, opts = {}) {
  const f = { unreadable: [], marks: [], header: [], structure: [], wording: [], figures: [], changes: [] };
  let blocking = false;
  const block = (list, msg) => { list.push(msg + " **[blocking]**"); blocking = true; };
  const h = model.header;

  // ---------------------------------------------------------------- 0. unreadable text
  const g = model.stats.garbled;
  if (g && g.garbled) {
    block(f.unreadable, `The Devanagari text in this file is garbled (${g.orphans} of ${g.marks} vowel signs stand alone): the file looks like a PDF converted back to Word, which loses Hindi/Marathi text. Upload the original Word file the paper was typed in.`);
  }

  // ---------------------------------------------------------------- 1. marks arithmetic
  const sectionTotals = [];
  let paperSum = 0, allKnown = true;
  // "Section B: I. Grammar" + "Section B. II. Writing" are two parts of one section: add them up together
  const merged = [];
  for (const s of model.sections) {
    const last = merged[merged.length - 1];
    if (s.part && last && last.letter === s.letter) last.parts.push(s); else merged.push({ letter: s.letter, parts: [s] });
  }
  for (const ms of merged) {
    const s = ms.parts[0];
    const units = ms.parts.flatMap(sectionUnits);
    const groups = units.flatMap((u) => (u.kind === "q" ? [u] : u.qs));
    const hasChoiceGroups = units.some((u) => u.kind === "grp");
    const missing = [];
    let sum = 0;
    for (const u of units) {
      const qs = u.kind === "q" ? [u] : u.qs;
      let usum = 0, complete = true;
      for (const g of qs) {
        const m = groupMarks(g);
        if (m == null) { missing.push("Q" + g.number); allKnown = false; complete = false; }
        else usum += m;
      }
      // "any 4 of 6": the group is worth its stated total, not the sum of all six
      sum += u.kind === "grp" && complete && u.group.total != null && qs.length >= u.group.count ? u.group.total : usum;
    }
    const totals = ms.parts.map((p) => (p.marksExpr ? p.marksExpr.total : null));
    const expected = totals.every((t) => t != null) ? totals.reduce((a, t) => a + t, 0) : (totals.find((t) => t != null) ?? null);
    // a section with text but no numbered question (a reading passage whose questions carry no number):
    // its marks cannot be checked, but that is not a reason to hold the paper
    if (!groups.length && expected != null && ms.parts.some((p) => p.instr.length || p.entries.length)) {
      f.marks.push(`Section ${s.letter}: no question number found, so its ${expected} marks could not be checked (the text is kept as written).`);
      sectionTotals.push({ letter: s.letter, sum: expected, expected, missing: [], count: 0, expectedCount: null, unchecked: true });
      paperSum += expected;
      continue;
    }
    sectionTotals.push({ letter: s.letter, sum, expected, missing, count: groups.length, expectedCount: s.marksExpr && s.marksExpr.count });
    paperSum += sum;
    if (s.implicit) { /* no heading to compare against; the paper total is checked below */ }
    else if (expected != null && sum !== expected) {
      const why = missing.length ? ` (${missing.join(", ")} carr${missing.length === 1 ? "ies" : "y"} no mark)` : "";
      if (missing.length && sum < expected) f.marks.push(`Section ${s.letter}: questions with marks sum to ${sum}, heading says ${expected}${why}. Add the missing mark${missing.length > 1 ? "s" : ""} so the section adds up.`);
      else block(f.marks, `Section ${s.letter}: marks sum to ${sum}, heading says ${expected}${why}.`);
    } else if (expected == null && missing.length) {
      f.marks.push(`Section ${s.letter}: ${missing.join(", ")} carr${missing.length === 1 ? "ies" : "y"} no mark and the section heading gives no total.`);
    }
    if (ms.parts.length === 1 && !hasChoiceGroups && s.marksExpr && s.marksExpr.count && groups.length !== s.marksExpr.count) {
      f.marks.push(`Section ${s.letter}: heading says ${s.marksExpr.count} questions, paper has ${groups.length}.`);
    }
    for (const g of groups) for (const p of g.parts) {
      const subs = topSubs(p.items.filter((x) => x.kind === "sub"));
      const withMarks = subs.filter((x) => x.marks != null);
      const stemText = plain((p.items.find((x) => x.kind === "stem") || { runs: [] }).runs);
      const abAlt = p.abParts || (/^\(?A\)/.test(stemText) && subs.length === 1 && subs[0].label === "(B)");
      if (withMarks.length && withMarks.length < subs.length && !abAlt && !p.items.some((x) => x.kind === "or")) {
        const none = subs.filter((x) => x.marks == null).map((x) => x.label);
        f.marks.push(`${qLabel(p)}: mark shown on ${withMarks.map((x) => x.label).join(", ")} but not on ${none.join(", ")}.`);
      }
      const orWithMark = p.items.find((x) => x.kind === "or" && x.marks != null);
      if (orWithMark) f.marks.push(`${qLabel(p)}: the mark sits on the OR line instead of the question.`);
    }
  }
  const okSections = sectionTotals.filter((t) => (t.expected != null && t.sum === t.expected) || (model.sections.find((x) => x.letter === t.letter) || {}).implicit);
  if (okSections.length === sectionTotals.length && sectionTotals.length) {
    const parts = sectionTotals.map((t) => `${t.letter || "questions"} ${t.sum}`);
    const line = `Adds up: ${parts.join(" + ")} = ${paperSum}` + (h.marks ? (h.marks === paperSum ? ` — matches the header (${h.marks} marks).` : `, but the header says ${h.marks} marks.`) : ".");
    if (h.marks && h.marks !== paperSum) block(f.marks, line); else f.marks.unshift(line);
  } else if (h.marks && allKnown && paperSum !== h.marks) {
    block(f.marks, `Paper total from questions is ${paperSum}; header says ${h.marks} marks.`);
  } else if (h.marks && allKnown && paperSum === h.marks && sectionTotals.length) {
    f.marks.unshift(`Questions total ${paperSum}, matching the header.`);
  }

  // ---------------------------------------------------------------- 2. header
  const n = model.naming;
  if (n.conflict) f.header.push(`Exam name conflict: file named ${n.fileCode}, paper says ${h.exam}. Output uses ${n.headerCode} (from the paper). Confirm.`);
  if (!h.school && !h.exam && !h.cls) f.header.push("No header block in the file: class, subject, marks, date and time were taken from the file name or left blank in the template.");
  const senior = (romanToInt(h.cls || "") || 0) >= 9;
  if (h.fromFile && h.fromFile.cls && h.cls && !h.missing.includes("class") && h.fromFile.cls !== normalizeClass(h.cls)) {
    f.header.push(`File name says Class ${h.fromFile.cls}, the paper's header says Class ${h.cls}; filed under Class ${h.cls}. Confirm which is right.`);
  }
  if (h.fromFile && h.fromFile.subject && h.subject && !h.missing.includes("subject") && subjectSlug(h.fromFile.subject) !== "Paper" && subjectSlug(h.fromFile.subject) !== subjectSlug(h.subject)) {
    f.header.push(`File name says ${h.fromFile.subject}, the paper's header says ${h.subject}; filed under ${subjectSlug(h.subject)}. Confirm.`);
  }
  for (const m of h.missing) {
    // subject codes and the CBSE instructions block only matter from Class IX up; below that they are noise
    if (m === "general instructions") { if (senior) f.header.push("No General Instructions block."); }
    else if (m === "roll no. line") f.header.push("Roll No. line missing (added by the template).");
    else if (m === "subject code") { if (senior) f.header.push("Subject code missing after the subject name (e.g. Mathematics (041))."); }
    else if (m === "class" || m === "subject") f.header.push(`${m[0].toUpperCase() + m.slice(1)} taken from the file name (${h.fromFile ? h.fromFile[m === "class" ? "cls" : "subject"] : "?"}).`);
    else f.header.push(`${m[0].toUpperCase() + m.slice(1)} missing from the header.`);
  }
  if (h.date && /^_+$/.test(h.date)) f.header.push("Date left blank.");

  // ---------------------------------------------------------------- 3. numbering & structure
  const numbers = [];
  for (const s of model.sections) {
    const nums = groupQuestions(s).map((g) => g.number);
    if ((s.title || s.part) && nums.length) numbers.push("restart");
    numbers.push(...nums);
  }
  let seen = new Set(), expect = 1;
  const dups = [], gaps = [];
  const firstNum = numbers.find((n) => n !== "restart");
  if (firstNum != null && firstNum !== 1) f.structure.push(`Numbering starts at Q${firstNum}.`);
  if (firstNum != null) expect = firstNum;
  for (const num of numbers) {
    // numbering that starts again at 1 (a new part of the paper) is a restart, not a duplicate
    if (num === "restart" || (num === 1 && seen.size)) { seen = new Set(); expect = 1; if (num === "restart") continue; }
    if (seen.has(num)) dups.push(num);
    seen.add(num);
    while (expect < num) { gaps.push(expect); expect++; }
    if (num >= expect) expect = num + 1;
  }
  if (gaps.length) f.structure.push(`Question number${gaps.length > 1 ? "s" : ""} missing: ${gaps.map((g) => "Q" + g).join(", ")}.`);
  if (dups.length) f.structure.push(`Duplicate question number${dups.length > 1 ? "s" : ""} not separated by OR: ${dups.map((d) => "Q" + d).join(", ")}.`);

  for (const s of model.sections) {
    const entries = s.entries;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.kind !== "question") continue;
      const items = e.items;
      const label = qLabel(e);
      // OR with nothing after it and no twin following
      const lastOr = items.length && items[items.length - 1].kind === "or";
      if (lastOr) {
        const next = entries[i + 1];
        const twin = next && next.kind === "question" && next.number === e.number;
        if (twin) { /* fine */ }
        else if (next && next.kind === "question") f.structure.push(`${label}: OR is followed by Q${next.number}, a differently numbered question — if they are alternatives, number both Q${e.number}.`);
        else block(f.structure, `${label}: OR at the end of the question but no alternative follows.`);
      }
      if (items.some((x) => x.kind === "or" && x.glued)) f.wording.push(`${label}: "OR" glued to the end of a sentence — set on its own line.`);
      const st = stemText(e);
      if (!st.trim() && !items.some((x) => x.kind === "sub" || x.kind === "opts")) block(f.structure, `${label}: question has no text.`);
      if (/^[.,;:]/.test(st)) f.wording.push(`${label}: starts with a stray "${st[0]}".`);
      // sub-part label sequence
      const subs = items.filter((x) => x.kind === "sub" && /^\([a-h]\)$/i.test(x.label));
      if (subs.length) {
        const labels = [];
        for (const x of subs) { const l = x.label.toLowerCase(); if (!labels.includes(l)) labels.push(l); }
        const letters = labels.map((l) => l[1]);
        const bad = letters.some((l, k) => l !== String.fromCharCode(97 + k));
        if (bad && !/^\(?[a-h]\)/i.test(st)) f.structure.push(`${label}: sub-part labels run ${labels.join(", ")}.`);
      }
      // option count in MCQ context
      const optRows = items.filter((x) => x.kind === "opts");
      const optCount = optRows.reduce((a, x) => a + x.items.length, 0);
      const mcq = s.marksExpr && s.marksExpr.per === 1;
      if (mcq && optCount && optCount !== 4 && optCount !== 0 && !/assertion/i.test(st)) f.structure.push(`${label}: ${optCount} options.`);
      if (optRows.some((r) => r.items.every((o) => /^\(?[a-dA-D][).]?$/.test(plain(o))))) f.structure.push(`${label}: options are images (labels only in the text) — check that the image order matches A–D.`);
      // placeholders and highlights
      const at = allText(e);
      if (/\(\s*marks?\s*\)/i.test(at)) f.marks.push(`${label}: "(marks)" placeholder — fill in the mark.`);
      if (/\b(\d+)\s*[oO]\b/.test(at) && !/°/.test(at)) f.wording.push(`${label}: degree written with the letter "o".`);
      if (/\bIs\b(?!\s*[A-Z])/.test(st.replace(/^[^.?!]*/, "")) || /\b[a-z]+\s+Is\s/.test(st)) f.wording.push(`${label}: "Is" for "is".`);
      if (/\b[A-Z]{2,}\s+IS\b|\sIS_+/.test(at)) f.wording.push(`${label}: "IS" in capitals.`);
      if (/\bRs\.?\s*\d/.test(at)) f.wording.push(`${label}: "Rs" — use ₹.`);
      if (/\b(?:for|cost|costs|price|deposit|deposits|paid|pays|earns|of)\s+\d{2,}(?:,\d{3})*(?!\s*(?:m|cm|km|kg|g|units?|students?|plants?|%|pieces?|marks?|years?|days?|minutes?|hours?|litres?|ml|mL|°|digits?|numbers?|chairs?|rows?|books?|symbols?|chocolates?|terms?|inches))\b/i.test(at) && !/₹/.test(at) && /\b(bought|sold|cost|price|deposit|profit|loss|discount|pay|paid|charges?|fare|amount)\b/i.test(at)) f.wording.push(`${label}: money amount without ₹.`);
      if (/\b\d+\s*(?:m|cm|kg|g|km)\s*\.\s*\d\b/.test(at)) f.wording.push(`${label}: unit power written as "m.3" — should be m³.`);
      if (/\bKg\b/.test(at)) f.wording.push(`${label}: "Kg" — use kg.`);
      if (/\b(the|a|an|is|are|was|were|and|of|to|in|on|for|with|by)\s+\1\b/i.test(at)) f.wording.push(`${label}: repeated word.`);
      const stemOnly = items.find((x) => x.kind === "stem");
      if (stemOnly) {
        const t = plain(stemOnly.runs);
        if (t && /[A-Za-z0-9]$/.test(t) && !items.some((x) => x.kind === "cont") && (items.some((x) => x.kind === "opts") || items.length === 1) && !/^\(?[a-h]\)/i.test(t)) f.wording.push(`${label}: no punctuation at the end of the question.`);
      }
      // figures
      const wantsFigure = FIGURE_WORDS.test(at) && !DRAW_WORDS.test(at.slice(Math.max(0, at.search(FIGURE_WORDS) - 40), at.search(FIGURE_WORDS) + 40));
      if (wantsFigure && !hasFigure(e)) {
        // outline maps are printed and handed out separately, so a map question without a map is not a blocker
        if (/\bmap\b/i.test(at)) f.figures.push(`${label}: map question — no map in the file; the outline map is printed separately.`);
        else block(f.figures, `${label}: refers to a figure/diagram but none is in the file.`);
      }
    }
  }

  // ---------------------------------------------------------------- 4. figures carried over / dropped
  const carried = [];
  for (const s of model.sections) for (const e of s.entries) {
    const inCells = (t) => t.rows.reduce((a, row) => a + row.reduce((b, c) => b + c.paragraphs.reduce((d, p) => d + ((p.images || []).length), 0), 0), 0);
    const imgs = e.items.filter((x) => x.kind === "image").length + e.items.filter((x) => x.kind === "images").reduce((a, x) => a + x.images.length, 0)
      + e.items.filter((x) => x.kind === "table").reduce((a, x) => a + inCells(x.table), 0) + e.items.filter((x) => x.kind === "tables").reduce((a, x) => a + x.tables.reduce((b, t) => b + inCells(t), 0), 0);
    const tbls = e.items.filter((x) => x.kind === "table").length + e.items.filter((x) => x.kind === "tables").reduce((a, x) => a + x.tables.length, 0);
    if (imgs || tbls) carried.push(`${qLabel(e)}${imgs ? ` (${imgs} image${imgs > 1 ? "s" : ""})` : ""}${tbls ? ` (${tbls} table${tbls > 1 ? "s" : ""})` : ""}`);
  }
  if (carried.length) f.figures.push(`Carried over from the file: ${carried.join(", ")}.`);
  const shaped = [];
  for (const s of model.sections) for (const e of s.entries) if (e.shapes) shaped.push(`${qLabel(e)} (${e.shapes})`);
  if (shaped.length) f.figures.push(`Drawing objects (lines, arrows or shapes drawn in Word) could not be carried over in ${shaped.join(", ")} — check what stood there (equation arrows, drawn figures) and redraw as an image if needed.`);
  else if (model.stats.shapesDropped) f.figures.push(`${model.stats.shapesDropped} drawing object${model.stats.shapesDropped > 1 ? "s" : ""} outside the questions (header rules etc.) were dropped.`);
  if (model.stats.tablesRelaid) f.figures.push(`Floating mini-tables were re-laid side by side (${model.stats.tablesRelaid} tables) — check they read in the intended order.`);

  // ---------------------------------------------------------------- 5. formatter changes
  const c = f.changes;
  c.push(`Text kept verbatim; spacing, indents, fonts and page setup reset to the template.`);
  if (model.naming.base + ".docx" !== model.source) c.push(`File renamed ${model.source} → ${model.naming.base}.docx.`);
  if (model.stats.sectionLettered && model.stats.sectionLettered.length) {
    c.push(`Section heading without a letter given the next letter: ${model.stats.sectionLettered.join("; ")}. Confirm.`);
  }
  if (model.stats.emptyTablesDropped) c.push(`${model.stats.emptyTablesDropped} empty table${model.stats.emptyTablesDropped > 1 ? "s" : ""} or trailing empty row${model.stats.emptyTablesDropped > 1 ? "s" : ""} (answer boxes) dropped.`);
  if (model.stats.degreeFixed.length) {
    const qs = [...new Set(model.stats.degreeFixed)];
    c.push(`Degree signs: "o" after a number set as ° in ${qs.join(", ")}.`);
  }
  if (model.stats.mathObjects) c.push(`${model.stats.mathObjects} equation object${model.stats.mathObjects > 1 ? "s" : ""} set as plain text (fractions as a/b, powers as ^{n}) — verify they read correctly.`);
  if (model.stats.highlighted.length) {
    const qs = [...new Set(model.stats.highlighted.map((x) => x.where))];
    c.push(`Teacher highlights kept as reviewer flags in ${qs.join(", ")}: ${model.stats.highlighted.slice(0, 6).map((x) => `"${x.text.slice(0, 40)}"`).join(", ")}.`);
  }
  c.push(`Marks set as right-aligned "nM"; MCQ options laid 4 per line where they fit; OR lines centred.`);

  // ---------------------------------------------------------------- markdown
  const date = opts.date || new Date();
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const ist = new Date(date.getTime() + 330 * 60000);
  const dateStr = `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]} ${ist.getUTCFullYear()}`;
  const status = blocking ? "NEEDS FIXES — moved to 3_Needs-Fixes" : "FORMATTED — in 2_Formatted";
  const lines = [`# Review — ${model.naming.base}`, `Source: ${model.source} · Reviewed ${dateStr} · Status: ${status}`, ""];
  const section = (title, list) => {
    if (!list.length) return;
    lines.push(`## ${title}`);
    for (const x of list) lines.push(`- ${x}`);
    lines.push("");
  };
  section("Unreadable text", f.unreadable);
  section("Marks", f.marks);
  section("Header / template", f.header);
  section("Structure", f.structure);
  section("Wording / notation", f.wording);
  section("Figures", f.figures);
  section("Changes made by the formatter", f.changes);
  return { findings: f, blocking, markdown: lines.join("\n").trimEnd() + "\n", sectionTotals, paperSum };
}

module.exports = { review };
