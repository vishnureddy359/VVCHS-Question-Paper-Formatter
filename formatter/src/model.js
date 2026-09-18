// Turn parsed blocks into a paper model:
//   { header, sections: [{ letter, heading, marksExpr, entries: [question|note] }], trailing, stats }
//
// A question is { number, alt, marks, marksSource, items: [...], text }
// Items: stem | cont | opts | sub | or | image | images | table | tables

"use strict";

const TEXT_W = 10488; // twips between the margins (A4, 709 twip margins)

// ---------------------------------------------------------------- run helpers

function cloneRun(r, text) {
  return { text, bold: !!r.bold, italic: !!r.italic, underline: !!r.underline, sup: !!r.sup, sub: !!r.sub, highlight: !!r.highlight, math: !!r.math };
}

function plain(runs) {
  return runs.map((r) => r.text).join("");
}

// Slice runs by character offsets of the joined text.
function sliceRuns(runs, from, to) {
  const out = [];
  let pos = 0;
  for (const r of runs) {
    const start = pos, end = pos + r.text.length;
    pos = end;
    const a = Math.max(from, start), b = Math.min(to === undefined ? end : to, end);
    if (b > a) out.push(cloneRun(r, r.text.slice(a - start, b - start)));
  }
  return out;
}

// Collapse whitespace across runs, trim both ends, drop zero-width chars.
function normalizeRuns(runs) {
  const out = [];
  let prevSpace = true;
  for (const r of runs) {
    let text = "";
    for (const ch of r.text.replace(/[\u200b\u200c\u200d\ufeff]/g, "")) {
      const isSpace = ch === " " || ch === "\t" || ch === "\u00a0";
      if (isSpace) { if (!prevSpace) text += " "; prevSpace = true; }
      else { text += ch; prevSpace = false; }
    }
    if (text) out.push(cloneRun(r, text));
  }
  // trim trailing space
  while (out.length) {
    const last = out[out.length - 1];
    last.text = last.text.replace(/\s+$/, "");
    if (last.text) break;
    out.pop();
  }
  return out;
}

function stripPrefix(runs, n) {
  return normalizeRuns(sliceRuns(runs, n));
}

function stripSuffix(runs, n) {
  const text = plain(runs);
  return normalizeRuns(sliceRuns(runs, 0, text.length - n));
}

// Split a paragraph into logical lines at hard line breaks, keeping images with the segment they sit in.
function splitLines(p) {
  const lines = [];
  let cur = [], imgIdx = 0, curImgs = [];
  const flush = () => { lines.push({ runs: cur, images: curImgs }); cur = []; curImgs = []; };
  for (const r of p.runs) {
    const parts = r.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) flush();
      if (!part) return;
      const n = (part.match(/\uFFFC/g) || []).length;
      for (let k = 0; k < n; k++) if (p.images[imgIdx]) curImgs.push(p.images[imgIdx++]);
      cur.push(cloneRun(r, part.replace(/\uFFFC/g, "")));
    });
  }
  flush();
  return lines.map((l) => ({ runs: normalizeRuns(l.runs), images: l.images, num: p.num, style: p.style, align: p.align, shapes: p.shapes, math: p.math }))
    .filter((l, i, arr) => l.runs.length || l.images.length || (arr.length === 1));
}

// ---------------------------------------------------------------- regexes

const RE = {
  school: /vidya\s*vihar/i,
  exam: /\b(examination|exam|test|assessment)\b/i,
  classLine: /\bclass\s*[:\-]?\s*([IVX]+|\d{1,2}(?:st|nd|rd|th)?)\b/i,
  subject: /\bsubject\s*[:\-]?\s*([^\t]+?)\s*(?=\bmarks?\b|\bmax|\bm\.?m\.?|$)/i,
  marks: /\b(?:max(?:imum)?\.?\s*)?marks?\s*[:\-]?\s*(\d+)/i,
  date: /\bdate\s*[:\-]?\s*([0-9]{1,2}[\/.\-][0-9]{1,2}[\/.\-][0-9]{2,4}|_+|[0-9]{1,2}\s+\w+\s+[0-9]{4})?/i,
  time: /\btime\s*[:\-]?\s*([0-9½.:]+\s*(?:hours?|hrs?|h|minutes?|mins?)?(?:\s*[0-9]+\s*(?:minutes?|mins?))?)/i,
  roll: /\broll\s*no/i,
  genInstr: /^general\s+instructions?\s*[:\-]?\s*$/i,
  genInstrInline: /^general\s+instructions?\s*[:\-]?\s*(.+)$/i,
  section: /^section\s*[-–—:]?\s*([a-e])\b\s*[-–—:.]?\s*(.*)$/i,
  qDot: /^Q\.?\s*(\d{1,2})\s*[.):]?\s*/i,
  qNum: /^(\d{1,2})\s*[.):]\s*(?!\d)/,
  qNumAlt: /^(\d{1,2})\s*\.?\s*\(?([AB])\)\s*/,
  altOnly: /^\(([AB])\)\s+/,
  mark: /(?:^|\s)(?:\[\s*(\d+)\s*\]|\(\s*(\d+)\s*(?:marks?|m)\s*\)|(\d+)\s*M(?:arks?)?)\s*$/i,
  orLine: /^OR\s*(?:\(?(\d+)\s*M(?:arks?)?\)?)?\s*[:.]?\s*$/i,
  orTrail: /\s+OR\s*$/,
  optLabel: /(?<=^|\s)\(?([a-dA-D])[).](?=\s|$|[A-Z₹√(−\-\d])/g,
  subLabel: /^\(?((?:[a-h])|(?:i{1,3}|iv|v|vi{0,3}|ix|x))\)\s*/i,
  subDot: /^([a-h])\.\s+(?=[A-Za-z(])/,
  nestedLabel: /^\(?((?:i{1,3}|iv|v|vi{0,3}|ix|x))\)\s*/i,
  direction: /^(direction|directions|note|instruction|instructions|read the (passage|following)|question nos?\.|questions?\s+\d+|given below|in (the )?questions?\s|for q)/i,
  titleLine: /^(assertion|reason|case[\s-]*study|section|passage|multiple[\s-]*choice|mcq)/i,
  qSplit: /\s(\d+\s*M(?:arks?)?)\s+(?=(?:Q\.?\s*)?\d{1,2}\s*[.)]\s*[A-Za-z(])/i,
  endLine: /^[*\-_=~\s]*(end|all the best|best of luck)?[*\-_=~\s]*$/i,
  marksExpr: /(\d+)\s*[×x*]\s*(\d+)\s*=\s*(\d+)\s*(?:marks?|m)?/i,
  totalOnly: /(\d+)\s*(?:marks?|m)\b/i,
};

function romanToInt(s) {
  const m = { I: 1, V: 5, X: 10 };
  let n = 0;
  s = s.toUpperCase();
  for (let i = 0; i < s.length; i++) {
    const v = m[s[i]], nx = m[s[i + 1]];
    if (!v) return null;
    n += nx && nx > v ? -v : v;
  }
  return n;
}
function intToRoman(n) {
  const t = [[10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let s = "";
  for (const [v, r] of t) while (n >= v) { s += r; n -= v; }
  return s;
}
function normalizeClass(s) {
  if (!s) return null;
  const d = /^(\d{1,2})/.exec(s);
  if (d) return intToRoman(Number(d[1]));
  const r = romanToInt(s);
  return r ? intToRoman(r) : s.toUpperCase();
}

// ---------------------------------------------------------------- header

function parseHeader(lines, filename) {
  const h = {
    school: null, exam: null, session: null, cls: null, subject: null, subjectCode: null, marks: null,
    date: null, time: null, rollNo: false, instructions: [], logo: false, consumed: 0, missing: [],
  };
  let i = 0;
  const limit = Math.min(lines.length, 25);
  let sawBody = false;
  for (; i < limit; i++) {
    const l = lines[i];
    const t = plain(l.runs);
    if (RE.section.test(t) || RE.qDot.test(t) || (RE.qNum.test(t) && i > 2)) { sawBody = true; break; }
    if (l.images.length && !t) { h.logo = true; continue; }
    if (!t) continue;
    if (RE.school.test(t)) { h.school = t; continue; }
    if (RE.exam.test(t) && !h.exam && !/class/i.test(t)) {
      h.exam = t;
      const s = /((?:19|20)\d{2})\s*[-–—]\s*((?:19|20)?\d{2})/.exec(t);
      if (s) h.session = s[1] + "-" + s[2].slice(-2);
      continue;
    }
    let matched = false;
    const c = RE.classLine.exec(t);
    if (c) { h.cls = normalizeClass(c[1]); matched = true; }
    const sj = RE.subject.exec(t);
    if (sj) {
      let sub = sj[1].trim().replace(/\s{2,}/g, " ");
      const code = /\(\s*(\d{3})\s*\)/.exec(sub);
      if (code) { h.subjectCode = code[1]; sub = sub.replace(code[0], "").trim(); }
      h.subject = sub; matched = true;
    }
    const mk = RE.marks.exec(t);
    if (mk && /marks?\s*[:\-]?\s*\d+/i.test(t)) { h.marks = Number(mk[1]); matched = true; }
    const dt = RE.date.exec(t);
    if (dt && /\bdate\b/i.test(t)) { h.date = (dt[1] || "").trim() || null; h.dateLine = true; matched = true; }
    const tm = RE.time.exec(t);
    if (tm && /\btime\b/i.test(t)) { h.time = tm[1].trim(); matched = true; }
    if (RE.roll.test(t)) { h.rollNo = true; matched = true; }
    if (RE.genInstr.test(t)) {
      h.instrStart = true; matched = true;
      for (i = i + 1; i < lines.length; i++) {
        const lt = plain(lines[i].runs);
        if (!lt) continue;
        if (RE.section.test(lt) || RE.qDot.test(lt)) break;
        h.instructions.push(lines[i].runs);
      }
      i--; continue;
    }
    const gi = RE.genInstrInline.exec(t);
    if (gi) { h.instrStart = true; h.instructions.push(stripPrefix(l.runs, t.length - gi[1].length)); matched = true; continue; }
    if (!matched) {
      if (h.instrStart) { h.instructions.push(l.runs); continue; }
      // unknown line before any body: if we've seen nothing header-ish yet and it's the first lines, treat as unknown header text
      if (!h.school && !h.exam && i < 3) continue;
      break;
    }
  }
  h.consumed = i;
  if (!h.school && !h.exam && !h.cls && !h.subject) h.consumed = 0;
  // fill from filename
  const fn = /^([A-Za-z]+)_([A-Za-z0-9]+)_([A-Za-z0-9]+)_(\d{4}-\d{2,4})/.exec(filename || "");
  h.fromFile = fn ? { subject: fn[1], cls: normalizeClass(fn[2]), exam: fn[3].toUpperCase(), session: fn[4] } : null;
  if (!h.cls && h.fromFile) { h.cls = h.fromFile.cls; h.missing.push("class"); }
  if (!h.subject && h.fromFile) { h.subject = h.fromFile.subject; h.missing.push("subject"); }
  if (!h.session && h.fromFile) h.session = h.fromFile.session.replace(/^(\d{4})-(\d{2})(\d{2})$/, "$1-$3");
  if (!h.exam) h.missing.push("exam name");
  if (!h.marks) h.missing.push("total marks");
  if (!h.date) h.missing.push("date");
  if (!h.time) h.missing.push("time");
  if (!h.rollNo) h.missing.push("roll no. line");
  if (!h.subjectCode) h.missing.push("subject code");
  if (!h.instructions.length) h.missing.push("general instructions");
  return h;
}

// ---------------------------------------------------------------- exam / naming

const EXAM_CODES = [
  [/pre\s*-?\s*board/i, "PREBOARD"],
  [/half\s*-?\s*yearly|\bhye\b|mid\s*-?\s*term/i, "HYE"],
  [/annual|final|\bsa\s*-?\s*2\b/i, "ANNUAL"],
  [/(periodic|pt|unit)\s*(test|assessment)?\s*-?\s*(1|i|one)\b|\bpt\s*-?\s*1\b/i, "PT1"],
  [/(periodic|pt|unit)\s*(test|assessment)?\s*-?\s*(2|ii|two)\b|\bpt\s*-?\s*2\b/i, "PT2"],
];
function examCodeOf(text) {
  if (!text) return null;
  for (const [re, code] of EXAM_CODES) if (re.test(text)) return code;
  return null;
}
function examNameOf(code, session) {
  const names = { PT1: "PERIODIC TEST 1", PT2: "PERIODIC TEST 2", HYE: "HALF-YEARLY EXAMINATION", PREBOARD: "PRE-BOARD EXAMINATION", ANNUAL: "ANNUAL EXAMINATION" };
  return (names[code] || "EXAMINATION") + (session ? " – " + session.replace(/^(\d{4})-(\d{2})$/, "$1-20$2") : "");
}
function subjectSlug(subject) {
  if (!subject) return "Paper";
  const s = subject.toLowerCase().replace(/[^a-z ]/g, " ").trim();
  if (/^math/.test(s)) return "Maths";
  if (/social/.test(s)) return "SocialScience";
  if (/^eng/.test(s)) return "English";
  if (/^sci/.test(s)) return "Science";
  if (/^hindi/.test(s)) return "Hindi";
  if (/^marathi/.test(s)) return "Marathi";
  if (/^sanskrit/.test(s)) return "Sanskrit";
  if (/computer|^it$|information/.test(s)) return "Computer";
  return subject.replace(/\(.*?\)/g, "").replace(/[^A-Za-z]+/g, "").replace(/^./, (c) => c.toUpperCase()) || "Paper";
}
function canonicalName(h, filename) {
  const headerCode = examCodeOf(h.exam);
  const fileCode = h.fromFile ? h.fromFile.exam : null;
  const code = headerCode || fileCode || "EXAM";
  const session = (h.session || "").replace(/^(\d{4})-(\d{2})\d{2}$/, "$1-$2") || "session";
  const cls = h.cls || "Class";
  // a teacher's re-upload keeps its _v2/_v3 suffix so the formatted copy never collides with the first one
  const ver = /_v(\d+)(?=\.[A-Za-z0-9]+$|$)/i.exec(filename || "");
  const base = `${subjectSlug(h.subject)}_${cls}_${code}_${session}` + (ver ? `_v${ver[1]}` : "");
  return { base, headerCode, fileCode, conflict: !!(headerCode && fileCode && headerCode !== fileCode) };
}

// ---------------------------------------------------------------- body classification

function parseMarksExpr(text) {
  const m = RE.marksExpr.exec(text);
  if (m) return { per: Number(m[1]), count: Number(m[2]), total: Number(m[3]), text: m[0] };
  const t = RE.totalOnly.exec(text);
  if (t) return { per: null, count: null, total: Number(t[1]), text: t[0] };
  return null;
}

// Find option labels in text; returns [{label, start, end(text start)}] if the line starts with one.
function optionItems(text) {
  const items = [];
  RE.optLabel.lastIndex = 0;
  let m;
  while ((m = RE.optLabel.exec(text))) {
    const labelStart = m.index;
    items.push({ label: m[1], labelStart, textStart: m.index + m[0].length });
    if (m[0].length === 0) RE.optLabel.lastIndex++;
  }
  if (!items.length || items[0].labelStart !== 0) return null;
  // labels should be in order a,b,c,d (case-insensitive) to count as an option row
  const seq = items.map((it) => it.label.toLowerCase());
  const expected = "abcd".slice(0, seq.length).split("");
  const startsAtA = seq[0] === "a";
  const ordered = seq.every((l, i) => l === expected[i]) || (!startsAtA && seq.every((l, i) => l.charCodeAt(0) === seq[0].charCodeAt(0) + i));
  if (!ordered) return null;
  return items;
}

function splitOptions(runs) {
  const text = plain(runs);
  const items = optionItems(text);
  if (!items || items.length < 2) return null;
  return items.map((it, i) => {
    const end = i + 1 < items.length ? items[i + 1].labelStart : text.length;
    return normalizeRuns(sliceRuns(runs, it.labelStart, end));
  });
}

function extractMark(runs) {
  const text = plain(runs);
  const m = RE.mark.exec(text);
  if (!m) return { runs, marks: null };
  if (m[1] && (text.match(/\[/g) || []).length > 1) return { runs, marks: null };
  const val = Number(m[1] || m[2] || m[3]);
  const cut = text.length - m[0].length + (m[0].startsWith(" ") ? 1 : 0);
  return { runs: normalizeRuns(sliceRuns(runs, 0, cut)), marks: val };
}

class Builder {
  constructor(lines, blocks, header) {
    this.lines = lines; // logical lines (paragraph-derived) or table blocks, in order
    this.header = header;
    this.sections = [];
    this.section = null;
    this.entry = null; // current question or note
    this.preamble = []; // entries before the first section
    this.stats = { shapesDropped: 0, mathObjects: 0, degreeFixed: [], highlighted: [], tablesRelaid: 0 };
    this.lastQuestionNumber = 0;
  }

  currentEntries() {
    return this.section ? this.section.entries : this.preamble;
  }

  newSection(letter, rest, runs) {
    this.section = { letter: letter.toUpperCase(), rest, runs, marksExpr: parseMarksExpr(rest), entries: [], instr: [] };
    this.sections.push(this.section);
    this.entry = null;
  }

  newQuestion(number, alt, runs, marks) {
    const q = { kind: "question", number, alt, marks, marksSource: marks != null ? "paper" : null, items: [], subMarks: [] };
    if (runs.length) q.items.push({ kind: "stem", runs });
    this.currentEntries().push(q);
    this.entry = q;
    if (number != null) this.lastQuestionNumber = number;
    return q;
  }

  newNote(runs, opts = {}) {
    const n = Object.assign({ kind: "note", items: [{ kind: "stem", runs }], center: false }, opts);
    this.currentEntries().push(n);
    this.entry = n;
    return n;
  }

  push(item) {
    if (!this.entry) this.newNote([], { silent: true });
    this.entry.items.push(item);
  }

  addLine(line) {
    let runs = line.runs;
    let text = plain(runs);
    const numLabel = line.num ? line.num.label : null;

    // images-only line
    if (!text && line.images.length) {
      this.pushImages(line.images);
      return;
    }
    if (!text) { if (line.shapes) this.noteShapes(line.shapes); return; }

    // two questions glued on one line: "… 2M 12. Why are …"
    const qs = RE.qSplit.exec(text);
    if (qs && this.section) {
      const cut = qs.index + 1 + qs[1].length;
      this.addLine(Object.assign({}, line, { runs: normalizeRuns(sliceRuns(runs, 0, cut)), images: line.images }));
      this.addLine(Object.assign({}, line, { runs: normalizeRuns(sliceRuns(runs, cut)), images: [], num: null }));
      return;
    }
    if (line.shapes) this.noteShapes(line.shapes);
    if (line.math) this.stats.mathObjects += line.math;

    // section heading
    const sec = RE.section.exec(text);
    if (sec && text.length < 90 && !/consists|carry|carries|contains/i.test(text)) {
      this.newSection(sec[1], sec[2].trim(), runs);
      return;
    }

    // closing END line
    if (RE.endLine.test(text) && /[*=_\-~]{5,}|end/i.test(text)) return;

    // trailing mark "1M"
    let marks = null;
    ({ runs, marks } = extractMark(runs));
    text = plain(runs);

    // OR line (optionally carrying a mark)
    const orm = RE.orLine.exec(text);
    if (orm) {
      const m = marks != null ? marks : (orm[1] ? Number(orm[1]) : null);
      this.push({ kind: "or", marks: m });
      return;
    }
    // "… OR" glued to the end of a line
    let trailingOr = false;
    if (RE.orTrail.test(text) && text.length > 3) {
      runs = stripSuffix(runs, RE.orTrail.exec(text)[0].length);
      text = plain(runs);
      trailingOr = true;
    }

    const finish = () => {
      if (line.images.length) this.pushImages(line.images);
      if (trailingOr) this.push({ kind: "or", marks: null, glued: true });
    };

    // question start: "Q.1.", "1.", "16.A) (a)", "10.(A)", or Word numbering at level 0
    let qm = RE.qDot.exec(text);
    let number = null, alt = null, cut = 0;
    if (qm) { number = Number(qm[1]); cut = qm[0].length; }
    else if ((qm = RE.qNumAlt.exec(text))) { number = Number(qm[1]); alt = qm[2]; cut = qm[0].length; }
    else if ((qm = RE.qNum.exec(text))) { number = Number(qm[1]); cut = qm[0].length; }
    else if (numLabel && line.num.fmt === "decimal" && line.num.ilvl === 0 && /^\d+/.test(numLabel)) {
      number = Number(/^\d+/.exec(numLabel)[0]);
      // a numbered paragraph whose text is only an OR alternative label
      const a = RE.altOnly.exec(text);
      if (a) { alt = a[1]; cut = a[0].length; }
    }
    if (number != null && number > 0 && number < 100) {
      const rest = stripPrefix(runs, cut);
      const restText = plain(rest);
      // a numbered line whose remainder is just "(A)" alternative marker
      const a2 = alt ? null : RE.altOnly.exec(restText);
      let stemRuns = rest;
      if (a2) { alt = a2[1]; stemRuns = stripPrefix(rest, a2[0].length); }
      const q = this.newQuestion(number, alt, stemRuns, marks);
      if (q.items.length) this.absorbInlineOptions(q.items[0], "runs");
      finish();
      return;
    }

    // Word-numbered lower-letter / roman paragraphs => labelled sub-part or option line
    if (numLabel && line.num.fmt !== "decimal" && line.num.fmt !== "bullet") {
      const lab = numLabel.replace(/\.$/, ")");
      const existing = optionItems(text);
      const first = existing ? existing[0].label : (RE.subLabel.exec(text) || [])[1];
      const labLetter = /^[(]?([A-Za-z])/.exec(lab);
      // prefix when the text has no label of its own, or its first label is the successor of the numbering label
      if (!first || (labLetter && first.toLowerCase().charCodeAt(0) === labLetter[1].toLowerCase().charCodeAt(0) + 1)) {
        runs = normalizeRuns([{ text: lab + " " }].concat(runs));
        text = plain(runs);
      }
    } else if (numLabel && line.num.fmt === "bullet") {
      runs = normalizeRuns([{ text: "• " }].concat(runs));
      text = plain(runs);
    }

    // option row(s): "a) .. b) .. c) .. d) .."  or "(A) .. (B) .."
    const opts = splitOptions(runs);
    if (opts && opts.length >= 2 && this.entry) {
      const inMcq = this.mcqContext();
      const allShort = opts.every((o) => plain(o).length <= 45);
      if (opts.length >= 3 || inMcq || allShort) { this.push({ kind: "opts", items: opts, marks }); finish(); return; }
    }

    // sub-part "(a) ..." / "i) ..." / "a. ..." (single label at line start)
    const sm = RE.subLabel.exec(text) || RE.subDot.exec(text);
    // "(B) …" right after OR in a question labelled (A) is the alternative, not a sub-part
    if (sm && this.entry && this.entry.kind === "question" && this.entry.alt === "A" && /^\(?B\)/.test(text)
        && this.entry.items.length && this.entry.items[this.entry.items.length - 1].kind === "or") {
      const q = this.newQuestion(this.entry.number, "B", stripPrefix(runs, sm[0].length), marks);
      if (q.items.length) this.absorbInlineOptions(q.items[0], "runs");
      finish();
      return;
    }
    if (sm && this.entry && text.length > sm[0].length) {
      const label = sm[0].trim().replace(/^\(?([^)]+)\)?$/, "($1)").replace(/\.$/, ")");
      let body = stripPrefix(runs, sm[0].length);
      let nested = null;
      const nm = RE.nestedLabel.exec(plain(body));
      if (nm && /^[a-h]$/i.test(sm[1])) { nested = "(" + nm[1] + ")"; body = stripPrefix(body, nm[0].length); }
      const item = { kind: "sub", label, nested, runs: body, marks };
      this.push(item);
      if (this.entry.kind === "question" && marks != null) this.entry.subMarks.push({ label, marks });
      this.absorbInlineOptions(item, "runs");
      finish();
      return;
    }

    // sub-heading / direction lines outside a question
    const isCentered = line.align === "center";
    if (RE.titleLine.test(text) && text.length < 60 && !/[.?:]$/.test(text) && /questions?|based|type/i.test(text)) {
      this.newNote(runs, { center: true });
      finish();
      return;
    }
    if (RE.direction.test(text) || (isCentered && text.length < 80 && !this.entry) || (!this.entry)) {
      const n = this.newNote(runs, { center: isCentered && text.length < 80, marks });
      finish();
      return n;
    }
    if (isCentered && text.length < 60 && /assertion|reason|case|study|passage/i.test(text)) {
      this.newNote(runs, { center: true });
      finish();
      return;
    }

    // continuation line of the current question / note; a choice "a) …" glued after a colon becomes its own sub-part
    const glued = /:\s+(\(?a[).])\s/i.exec(text);
    if (glued && this.entry) {
      const at = glued.index + glued[0].indexOf(glued[1]);
      this.push({ kind: "cont", runs: normalizeRuns(sliceRuns(runs, 0, at)), marks: null });
      this.push({ kind: "sub", label: "(a)", nested: null, runs: stripPrefix(sliceRuns(runs, at), glued[1].length), marks });
      finish();
      return;
    }
    this.push({ kind: "cont", runs, marks });
    if (marks != null && this.entry.kind === "question" && this.entry.marks == null && !this.entry.items.some((it) => it.kind === "or")) {
      this.entry.marks = marks; this.entry.marksSource = "paper";
    }
    finish();
  }

  // "3. Which microorganism … A) Bacteria B) Virus C) Yeast D) Protozoa" on one line
  absorbInlineOptions(holder, key) {
    const runs = holder[key];
    const text = plain(runs);
    RE.optLabel.lastIndex = 0;
    let first = null, m;
    while ((m = RE.optLabel.exec(text))) {
      const lab = m[1].toLowerCase();
      if (lab === "a" && m.index > 0) { first = m.index; break; }
      if (m[0].length === 0) RE.optLabel.lastIndex++;
    }
    if (first == null) return;
    const tail = normalizeRuns(sliceRuns(runs, first));
    const opts = splitOptions(tail);
    if (!opts || opts.length < 3) return;
    // Sub-part lists like "(a) 145° (b) 90°" are kept verbatim; only 3+ short options are split out.
    if (!opts.every((o) => plain(o).length <= 45)) return;
    const head = extractMark(normalizeRuns(sliceRuns(runs, 0, first)));
    holder[key] = head.runs;
    if (head.marks != null && this.entry && this.entry.kind === "question" && this.entry.marks == null) { this.entry.marks = head.marks; this.entry.marksSource = "paper"; }
    this.push({ kind: "opts", items: opts, marks: null });
  }

  mcqContext() {
    const s = this.section;
    if (!s) return false;
    if (s.marksExpr && s.marksExpr.per === 1) return true;
    if (/multiple\s*choice|mcq|choose the correct|select the correct/i.test(s.rest + " " + s.instr.map(plain).join(" "))) return true;
    return false;
  }

  addTable(table) {
    this.push({ kind: "table", table });
  }

  noteShapes(n) {
    this.stats.shapesDropped += n;
    if (this.entry) this.entry.shapes = (this.entry.shapes || 0) + n;
  }

  pushImages(images) {
    this.push(images.length === 1 ? { kind: "image", image: images[0] } : { kind: "images", images });
  }

  isQuestionStart(line) {
    const t = plain(line.runs);
    if (RE.qDot.test(t) || RE.qNum.test(t) || RE.qNumAlt.test(t)) return true;
    return !!(line.num && line.num.fmt === "decimal" && line.num.ilvl === 0);
  }

  // Word-numbered paragraphs whose own text already starts with a label must not get the label twice.
  run() {
    const items = this.lines;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.type === "table") {
        // group consecutive floating mini-tables (separated only by blank lines) into one row
        if (it.floating && it.rows.length <= 4 && (it.rows[0] || []).length <= 3) {
          const group = [it];
          let j = i + 1;
          while (j < items.length) {
            const n = items[j];
            if (n.type === "table" && n.floating && n.rows.length <= 4 && (n.rows[0] || []).length <= 3) { group.push(n); j++; continue; }
            if (n.type === "line" && !plain(n.runs) && !n.images.length) { j++; continue; }
            break;
          }
          // a floating table sitting just above its question line belongs to that question
          if (j < items.length && items[j].type === "line" && this.isQuestionStart(items[j])) {
            this.addLine(items[j]);
            this.push({ kind: "tables", tables: group });
            this.stats.tablesRelaid += group.length;
            i = j; continue;
          }
          if (group.length > 1) { this.push({ kind: "tables", tables: group }); this.stats.tablesRelaid += group.length; i = j - 1; continue; }
        }
        this.addTable(it);
        continue;
      }
      this.addLine(it);
    }
    // Move leading notes of a section (before its first question) into section.instr for tidier rendering.
    for (const s of this.sections) {
      while (s.entries.length && s.entries[0].kind === "note" && s.entries[0].items.every((x) => x.kind === "stem" || x.kind === "cont")) {
        const n = s.entries.shift();
        for (const x of n.items) s.instr.push(x.runs);
      }
      // section marks may live on the instruction line rather than the heading
      if (!s.marksExpr) for (const r of s.instr) { const me = parseMarksExpr(plain(r)); if (me) { s.marksExpr = me; break; } }
      for (const e of s.entries) postProcessEntry(e, s);
    }
    return this;
  }
}

// ---------------------------------------------------------------- post-processing

function isShortOption(runs, max) {
  const t = plain(runs);
  return t.length <= max && !/[?]$/.test(t);
}

// Teacher's bold applied to a whole line is layout, not content: the template sets stems regular.
function dropWholeLineBold(runs) {
  if (!runs || !runs.length) return;
  let bold = 0, total = 0;
  for (const r of runs) { const n = r.text.replace(/\s/g, "").length; total += n; if (r.bold) bold += n; }
  if (total && bold / total >= 0.9) for (const r of runs) r.bold = false;
}

const endsOpen = (t) => /[a-z0-9,;]$/i.test(t) && !/[.?!:]$/.test(t);
const startsLower = (t) => /^[a-z(]/.test(t) && !/^\(?[a-h]\)/i.test(t) && !/^\(?(i{1,3}|iv|v|vi{0,3})\)/i.test(t);

function postProcessEntry(e, section) {
  const items = e.items;
  const out = [];
  // 1. re-join lines the teacher broke by hand ("… in the shape of a" + "rectangle ABCD …")
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    // look back past a figure that the teacher dropped mid-sentence
    let k = out.length - 1;
    while (k >= 0 && (out[k].kind === "image" || out[k].kind === "images")) k--;
    const prev = k >= 0 ? out[k] : null;
    if (it.kind === "cont" && prev && (prev.kind === "stem" || prev.kind === "cont" || prev.kind === "sub") && prev.runs && it.marks == null
        && endsOpen(plain(prev.runs)) && startsLower(plain(it.runs))) {
      prev.runs = normalizeRuns(prev.runs.concat([{ text: " " }], it.runs));
      continue;
    }
    out.push(it);
  }
  items.length = 0; items.push(...out); out.length = 0;
  for (const it of items) {
    if (it.runs) dropWholeLineBold(it.runs);
    if (it.items) for (const o of it.items) dropWholeLineBold(o);
  }
  const mcq = !!(section.marksExpr && section.marksExpr.per === 1) || /multiple\s*choice|mcq/i.test(section.rest + " " + section.instr.map(plain).join(" "));
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    // merge consecutive 'tables' groups (a floating table before the question line + the rest after it)
    if (it.kind === "tables" && out.length && out[out.length - 1].kind === "tables") { out[out.length - 1].tables.push(...it.tables); continue; }
    if (it.kind === "tables" && out.length && out[out.length - 1].kind === "table") { const prev = out.pop(); out.push({ kind: "tables", tables: [prev.table, ...it.tables] }); continue; }
    // a run of short single-label sub-parts a..d (no marks) is an MCQ option list
    if (it.kind === "sub" && /^\([a-d]\)$/i.test(it.label) && it.marks == null && !it.nested) {
      let j = i;
      const run = [];
      while (j < items.length && items[j].kind === "sub" && /^\([a-d]\)$/i.test(items[j].label) && items[j].marks == null && !items[j].nested) { run.push(items[j]); j++; }
      const labels = run.map((x) => x.label.toLowerCase());
      const ordered = labels.join("") === ["(a)", "(b)", "(c)", "(d)"].slice(0, run.length).join("");
      if (run.length === 4 && ordered && run.every((x) => isShortOption(x.runs, mcq ? 45 : 30))) {
        out.push({ kind: "opts", items: run.map((x) => normalizeRuns([{ text: x.label.replace(/[()]/g, "") + ") " }].concat(x.runs))), marks: null });
        i = j - 1; continue;
      }
    }
    // two 2-item option rows -> one 4-item row when everything is short
    if (it.kind === "opts" && it.items.length === 2 && i + 1 < items.length && items[i + 1].kind === "opts" && items[i + 1].items.length === 2) {
      const all = it.items.concat(items[i + 1].items);
      if (all.every((o) => plain(o).length <= 22)) { out.push({ kind: "opts", items: all, marks: it.marks }); i++; continue; }
    }
    out.push(it);
  }
  e.items = out;
}

// ---------------------------------------------------------------- marks inference & fixes

// Sum sub-part marks, counting OR alternatives (same label twice) once.
function sumSubs(subs) {
  const byLabel = new Map();
  for (const x of subs) if (x.marks != null) byLabel.set(x.label, Math.max(byLabel.get(x.label) || 0, x.marks));
  let t = 0;
  for (const v of byLabel.values()) t += v;
  return t;
}

function inferMarks(model) {
  for (const s of model.sections) {
    const per = s.marksExpr && s.marksExpr.per;
    let prevQ = null;
    for (const e of s.entries) {
      if (e.kind !== "question") continue;
      const subs = e.items.filter((x) => x.kind === "sub");
      const stem = e.items.find((x) => x.kind === "stem");
      const stemText = stem ? plain(stem.runs) : "";
      // "16.(A) (a) Label the diagram. 3M" — the stem line is itself sub-part (a); its mark belongs to (a)
      if (e.marks != null && e.marksSource === "paper" && /^\(?[a-h]\)/i.test(stemText) && subs.some((x) => x.marks != null)) {
        e.stemSubMarks = e.marks;
        e.marks = e.marks + sumSubs(subs);
        e.marksSource = "sum of sub-parts";
      }
      const subSum = sumSubs(subs);
      const subAll = subs.length && subs.every((x) => x.marks != null);
      if (e.marks == null) {
        // marks may sit on an item inside the question (e.g. on option (B) of an OR pair, or on the last sub-part)
        const inner = e.items.map((x) => x.marks).filter((m) => m != null);
        if (subAll && !e.items.some((x) => x.kind === "or")) { e.marks = subSum; e.marksSource = "sum of sub-parts"; }
        else if (inner.length && !subs.length) { e.marks = Math.max(...inner); e.marksSource = "paper (inner line)"; }
        else if (inner.length && subs.length && e.items.some((x) => x.kind === "or")) { e.marks = Math.max(...inner); e.marksSource = "paper (inner line)"; }
        else if (prevQ && prevQ.number === e.number && prevQ.marks != null) { e.marks = prevQ.marks; e.marksSource = "OR twin"; }
        else if (per) { e.marks = per; e.marksSource = "section (" + s.marksExpr.text + ")"; }
      }
      if (e.marks != null && prevQ && prevQ.number === e.number && prevQ.marks == null) { prevQ.marks = e.marks; prevQ.marksSource = "OR twin"; }
      prevQ = e;
    }
  }
}

// 180o -> 180° ; records what changed
function fixDegrees(model) {
  const fix = (runs, where) => {
    for (const r of runs) {
      const before = r.text;
      r.text = r.text.replace(/(\d)\s?[oO](?=[\s,.;:)\]]|$)/g, "$1°");
      if (r.text !== before) model.stats.degreeFixed.push(where);
    }
    // a lone superscript "o" run after a digit
    for (let i = 1; i < runs.length; i++) {
      if (runs[i].sup && /^[oO]$/.test(runs[i].text) && /\d$/.test(runs[i - 1].text)) { runs[i].text = "°"; runs[i].sup = false; model.stats.degreeFixed.push(where); }
    }
  };
  for (const s of model.sections) for (const e of s.entries) walkRuns(e, (runs) => fix(runs, e.number != null ? "Q" + e.number : "note"));
}

function walkRuns(entry, fn) {
  for (const it of entry.items) {
    if (it.runs) fn(it.runs);
    if (it.items) for (const o of it.items) fn(o);
    if (it.table) for (const row of it.table.rows) for (const c of row) for (const p of c.paragraphs) fn(p.runs);
    if (it.tables) for (const t of it.tables) for (const row of t.rows) for (const c of row) for (const p of c.paragraphs) fn(p.runs);
  }
}

function collectHighlights(model) {
  for (const s of model.sections) for (const e of s.entries) walkRuns(e, (runs) => {
    for (const r of runs) if (r.highlight && r.text.trim()) model.stats.highlighted.push({ where: e.number != null ? "Q" + e.number : "note", text: r.text.trim() });
  });
}

// ---------------------------------------------------------------- entry point

function buildModel(parsed, filename) {
  // flatten paragraphs to logical lines; keep tables
  const items = [];
  for (const b of parsed.blocks) {
    if (b.type === "p") for (const l of splitLines(b)) items.push(Object.assign({ type: "line" }, l));
    else items.push(b);
  }
  const lines = items.filter((x) => x.type === "line");
  const header = parseHeader(lines, filename);
  // drop header lines from the body stream
  let skip = header.consumed;
  const body = [];
  for (const it of items) {
    if (skip > 0 && it.type === "line") { skip--; continue; }
    if (skip > 0 && it.type === "table") continue;
    body.push(it);
  }
  const b = new Builder(body, parsed.blocks, header).run();
  const model = { header, sections: b.sections, preamble: b.preamble, stats: b.stats, naming: canonicalName(header, filename), source: filename };
  inferMarks(model);
  fixDegrees(model);
  collectHighlights(model);
  return model;
}

module.exports = { buildModel, plain, normalizeRuns, sliceRuns, parseMarksExpr, examNameOf, examCodeOf, TEXT_W };
