// Render a paper model to a .docx that follows template/VVCHS_Question_Paper_Format_Spec.md.
// The layout helpers mirror template/build_paper_example.js.

"use strict";

const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");
const {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell,
  AlignmentType, TabStopType, BorderStyle, WidthType, VerticalAlign, Footer,
  PageNumber, HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom,
  TextWrappingType, PageBorderOffsetFrom, TableLayoutType,
} = require("docx");
const { plain, examNameOf, examCodeOf } = require("./model");

// ---------- page geometry (A4, matches reference) ----------
const PAGE_W = 11906, PAGE_H = 16838;
const M_L = 709, M_R = 709, M_T = 700, M_B = 567;
const TEXT_W = PAGE_W - M_L - M_R; // 10488 twips
const FONT = "Times New Roman";
const LINE = 276; // 1.15 line spacing
const pt2px = (pt) => Math.round(pt * 4 / 3);
const pt2tw = (pt) => Math.round(pt * 20);
const LOGO = path.join(__dirname, "..", "..", "template", "vvchs_logo.jpg");

// ---------- runs ----------
const DEVANAGARI = /[\u0900-\u097F]/;
const CS_FONT = "Mangal"; // complex-script font for Devanagari runs (Word picks w:cs for that script)

function textRuns(runs, base = {}) {
  if (typeof runs === "string") runs = [{ text: runs }];
  return runs.map((r) => new TextRun({
    text: r.text.replace(/\t/g, " "),
    font: DEVANAGARI.test(r.text) ? { ascii: FONT, hAnsi: FONT, cs: CS_FONT, eastAsia: FONT } : FONT,
    sizeComplexScript: base.size || 22,
    size: base.size || 22,
    bold: base.bold || !!r.bold,
    italics: base.italics || !!r.italic,
    underline: base.underline || r.underline ? {} : undefined,
    superScript: r.sup || undefined,
    subScript: r.sub || undefined,
    highlight: r.highlight ? "yellow" : undefined,
  }));
}
const T = (text, o = {}) => new TextRun(Object.assign({ text, font: FONT, size: 22 }, o));
const TAB = () => new TextRun({ text: "\t", font: FONT, size: 22 });

const P = (runs, o = {}) => new Paragraph({
  alignment: o.align || AlignmentType.LEFT,
  spacing: { line: LINE, lineRule: "auto", before: o.before || 0, after: o.after == null ? 0 : o.after },
  indent: o.indent, tabStops: o.tabs, keepNext: o.keepNext, keepLines: true,
  children: textRuns(runs, o),
});

// question stem: bold number, hanging indent, optional right-aligned mark
const Q = (num, runs, o = {}) => {
  const children = [T(num, { bold: true }), TAB(), ...textRuns(runs)];
  const tabs = [];
  if (o.mark) { children.push(TAB(), T(o.mark)); tabs.push({ type: TabStopType.RIGHT, position: o.right || TEXT_W }); }
  return new Paragraph({
    spacing: { line: LINE, lineRule: "auto", before: o.before || 0, after: o.after == null ? 40 : o.after },
    indent: { left: 360, hanging: 360 },
    keepNext: o.keepNext !== false, keepLines: true,
    tabStops: tabs.length ? tabs : undefined,
    children,
  });
};

// continuation line inside a question (aligned with question text)
const C = (runs, o = {}) => {
  const children = textRuns(runs);
  const tabs = [];
  if (o.mark) { children.push(TAB(), T(o.mark)); tabs.push({ type: TabStopType.RIGHT, position: o.right || TEXT_W }); }
  return new Paragraph({
    alignment: o.align || AlignmentType.LEFT,
    spacing: { line: LINE, lineRule: "auto", before: 0, after: o.after == null ? 40 : o.after },
    indent: { left: o.left == null ? 360 : o.left }, keepNext: o.keepNext, keepLines: true,
    tabStops: tabs.length ? tabs : (o.tabs || undefined),
    children,
  });
};

// sub-part "(a) ..." with optional right-aligned mark
const SUB = (label, runs, mark, o = {}) => {
  const left = o.left == null ? 720 : o.left;
  const right = o.right == null ? TEXT_W : o.right;
  const ch = [T(label), TAB(), ...textRuns(runs)];
  if (mark) ch.push(TAB(), T(mark));
  return new Paragraph({
    spacing: { line: LINE, lineRule: "auto", after: o.after == null ? 0 : o.after },
    indent: { left, hanging: 360 }, keepNext: o.keepNext, keepLines: true,
    tabStops: [{ type: TabStopType.LEFT, position: left }, { type: TabStopType.RIGHT, position: right }],
    children: ch,
  });
};

// n options on one line; positions are the tab stops for items 2..n
const OPTS = (items, positions, o = {}) => {
  const children = [];
  items.forEach((it, i) => { if (i) children.push(TAB()); children.push(...textRuns(it)); });
  return new Paragraph({
    spacing: { line: LINE, lineRule: "auto", after: o.after == null ? 120 : o.after },
    indent: { left: 360 }, keepLines: true, keepNext: o.keepNext,
    tabStops: positions.map((p) => ({ type: TabStopType.LEFT, position: p })),
    children,
  });
};
const OPT_POS = { 4: [2880, 5400, 7920], 3: [3720, 7080], 2: [5400] };

const OR = (o = {}) => P([{ text: "OR", bold: true }], { align: AlignmentType.CENTER, before: o.before == null ? 40 : o.before, after: o.after == null ? 40 : o.after, keepNext: true });

const HEADING = (text) => new Paragraph({
  alignment: AlignmentType.CENTER, spacing: { line: LINE, lineRule: "auto", before: 200, after: 120 }, keepNext: true,
  children: [new TextRun({ text, font: FONT, size: 28, bold: true, underline: {} })],
});

const INSTR = (runs, o = {}) => P(runs, { bold: true, after: o.after == null ? 80 : o.after, keepNext: true, align: o.align });
const spacer = () => new Paragraph({ spacing: { before: 0, after: 0, line: 120, lineRule: "exact" }, children: [] });

// ---------- images ----------
const MAX_IMG_W = 300; // pt: wider images go on their own line
function imgSize(img, maxW = 500) {
  let w = img.wpt || 150, h = img.hpt || 100;
  if (!img.wpt || !img.hpt) { w = 150; h = 100; }
  if (w > maxW) { h = h * maxW / w; w = maxW; }
  return { w, h };
}
function IMG(img, w, h) {
  return new ImageRun({ type: img.ext === "png" ? "png" : img.ext === "gif" ? "gif" : img.ext === "bmp" ? "bmp" : "jpg", data: img.data, transformation: { width: pt2px(w), height: pt2px(h) } });
}

const NOB = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const NOBORDERS = { top: NOB, bottom: NOB, left: NOB, right: NOB, insideHorizontal: NOB, insideVertical: NOB };
const SB = { style: BorderStyle.SINGLE, size: 4, color: "000000" };
const BORDERS = { top: SB, bottom: SB, left: SB, right: SB, insideHorizontal: SB, insideVertical: SB };

// figure question: borderless 2-col table (text | image)
function FIG(leftParas, img) {
  const { w, h } = imgSize(img, 260);
  const rightW = pt2tw(w) + 120, leftW = TEXT_W - rightW;
  return new Table({
    width: { size: TEXT_W, type: WidthType.DXA }, columnWidths: [leftW, rightW], layout: TableLayoutType.FIXED,
    borders: NOBORDERS, margins: { left: 0, right: 0, top: 0, bottom: 0 },
    rows: [new TableRow({ cantSplit: true, children: [
      new TableCell({ width: { size: leftW, type: WidthType.DXA }, borders: NOBORDERS, margins: { left: 0, right: 100, top: 0, bottom: 0 }, verticalAlign: VerticalAlign.CENTER, children: leftParas }),
      new TableCell({ width: { size: rightW, type: WidthType.DXA }, borders: NOBORDERS, margins: { left: 0, right: 0, top: 0, bottom: 0 }, verticalAlign: VerticalAlign.CENTER,
        children: [new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 0, after: 0, line: 240, lineRule: "auto" }, children: [IMG(img, w, h)] })] }),
    ] })],
  });
}

// several images on one centred line
function IMAGES(images, keepNext = true) {
  const total = images.reduce((a, i) => a + (i.wpt || 120), 0) + 12 * (images.length - 1);
  const maxTotal = TEXT_W / 20 - 40;
  const scale = total > maxTotal ? maxTotal / total : 1;
  const children = [];
  images.forEach((img, i) => {
    const { w, h } = imgSize(img, 500);
    if (i) children.push(T("    "));
    children.push(IMG(img, w * scale, h * scale));
  });
  return new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 40, after: 40, line: 240, lineRule: "auto" }, keepNext, children });
}

function IMAGE_LINE(img, keepNext = true) {
  const { w, h } = imgSize(img, TEXT_W / 20 - 60);
  return new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 40, after: 40, line: 240, lineRule: "auto" }, keepNext, children: [IMG(img, w, h)] });
}

// ---------- data tables ----------
function cellParas(cell, center) {
  const paras = cell.paragraphs.filter((p) => p.runs.length).map((p) => new Paragraph({
    alignment: center ? AlignmentType.CENTER : AlignmentType.LEFT,
    spacing: { line: 240, lineRule: "auto", before: 0, after: 0 },
    children: textRuns(p.runs.map((r) => Object.assign({}, r, { text: r.text.replace(/￼/g, "") }))),
  }));
  return paras.length ? paras : [new Paragraph({ spacing: { before: 0, after: 0 }, children: [] })];
}

function DATA_TABLE(t, maxW = TEXT_W - 360, indent = 360) {
  const ncols = Math.max(...t.rows.map((r) => r.reduce((a, c) => a + (c.span || 1), 0)), 1);
  let cols = t.cols && t.cols.length === ncols ? t.cols.slice() : Array(ncols).fill(Math.round(Math.min(maxW, ncols * 1800) / ncols));
  let sum = cols.reduce((a, b) => a + b, 0);
  if (sum > maxW) { cols = cols.map((c) => Math.round(c * maxW / sum)); sum = cols.reduce((a, b) => a + b, 0); }
  const allShort = t.rows.every((r) => r.every((c) => c.paragraphs.every((p) => plain(p.runs).length <= 14)));
  const rows = t.rows.map((r) => new TableRow({ cantSplit: true, children: r.map((c, ci) => new TableCell({
    width: { size: cols[ci] || cols[0], type: WidthType.DXA },
    columnSpan: c.span > 1 ? c.span : undefined,
    borders: t.bordered ? BORDERS : NOBORDERS,
    margins: { left: 80, right: 80, top: 20, bottom: 20 },
    verticalAlign: VerticalAlign.CENTER,
    children: cellParas(c, allShort),
  })) }));
  return new Table({
    width: { size: sum, type: WidthType.DXA }, columnWidths: cols, layout: TableLayoutType.FIXED,
    indent: indent ? { size: indent, type: WidthType.DXA } : undefined,
    borders: t.bordered ? BORDERS : NOBORDERS, rows,
  });
}

// matching exercise: two borderless columns, aligned with the question text
function PAIRS(rows) {
  const colW = 2880;
  return new Table({
    width: { size: colW * 2, type: WidthType.DXA }, columnWidths: [colW, colW], layout: TableLayoutType.FIXED,
    indent: { size: 720, type: WidthType.DXA }, borders: NOBORDERS,
    rows: rows.map((r) => new TableRow({ cantSplit: true, children: r.map((cell) => new TableCell({
      width: { size: colW, type: WidthType.DXA }, borders: NOBORDERS, margins: { left: 0, right: 80, top: 20, bottom: 20 },
      children: [new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: textRuns(cell) })],
    })) })),
  });
}

// several small tables side by side in one borderless row
function TABLE_ROW(tables) {
  const n = tables.length;
  const cellW = Math.floor((TEXT_W - 360) / n);
  return new Table({
    width: { size: TEXT_W - 360, type: WidthType.DXA }, columnWidths: Array(n).fill(cellW), layout: TableLayoutType.FIXED,
    indent: { size: 360, type: WidthType.DXA },
    borders: NOBORDERS, margins: { left: 0, right: 0, top: 0, bottom: 0 },
    rows: [new TableRow({ cantSplit: true, children: tables.map((t) => new TableCell({
      width: { size: cellW, type: WidthType.DXA }, borders: NOBORDERS, margins: { left: 40, right: 40, top: 40, bottom: 40 }, verticalAlign: VerticalAlign.CENTER,
      children: [DATA_TABLE(t, cellW - 120, 0), new Paragraph({ spacing: { before: 0, after: 0 }, children: [] })],
    })) })],
  });
}

// ---------- header block ----------
const HDR_TABS = [{ type: TabStopType.LEFT, position: 3600 }, { type: TabStopType.LEFT, position: 8640 }];

function headerBlock(model, totals) {
  const h = model.header;
  const code = examCodeOf(h.exam) || (h.fromFile && h.fromFile.exam);
  const exam = h.exam ? h.exam.toUpperCase().replace(/\s+/g, " ") : examNameOf(code, h.session);
  const subject = (h.subject || "SUBJECT").toUpperCase() + (h.subjectCode ? ` (${h.subjectCode})` : "");
  const marks = h.marks != null ? h.marks : (totals != null ? totals : "____");
  const date = h.date && !/^_+$/.test(h.date) ? h.date : "____/____/________";
  const time = h.time || "3 hours";
  const logo = fs.existsSync(LOGO) ? [new ImageRun({
    type: "jpg", data: fs.readFileSync(LOGO), transformation: { width: pt2px(47), height: pt2px(41) },
    floating: {
      horizontalPosition: { relative: HorizontalPositionRelativeFrom.COLUMN, offset: -97790 },
      verticalPosition: { relative: VerticalPositionRelativeFrom.PARAGRAPH, offset: -40000 },
      wrap: { type: TextWrappingType.NONE }, allowOverlap: true, behindDocument: false,
    },
  })] : [];
  const out = [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      children: [...logo, new TextRun({ text: "VIDYA VIHAR CONVENT HIGH SCHOOL, CHANDRAPUR", font: FONT, size: 32, bold: true })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      children: [new TextRun({ text: exam, font: FONT, size: 28, bold: true })] }),
    new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, tabStops: HDR_TABS,
      children: [T(`Class: ${h.cls || "____"}`, { bold: true, size: 24 }), TAB(), T(`Subject: ${subject}`, { bold: true, size: 24 }), TAB(), T(`Marks: ${marks} marks`, { bold: true, size: 24 })] }),
    new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 100 }, tabStops: HDR_TABS,
      indent: { left: -152, firstLine: 152, right: -228 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 14, space: 4, color: "000000" } },
      children: [T(`Date: ${date}`, { bold: true, size: 24 }), TAB(), T("Roll No.:______________", { bold: true, size: 24 }), TAB(), T(`Time: ${time}`, { bold: true, size: 24 })] }),
  ];
  if (h.instructions.length) {
    out.push(P([{ text: "General Instructions:" }], { bold: true, italics: true, underline: true, size: 24, before: 60, after: 0, keepNext: true }));
    h.instructions.forEach((runs, i) => {
      const text = plain(runs);
      const numbered = /^\d+\s*[.)]/.test(text);
      const body = numbered ? runs : [{ text: `${i + 1}.\t` }].concat(runs);
      const withTab = numbered ? runs.map((r, k) => (k === 0 ? Object.assign({}, r, { text: r.text.replace(/^(\d+\s*[.)])\s*/, "$1\t") }) : r)) : body;
      out.push(P(withTab, { bold: true, italics: true, size: 24, indent: { left: 284, hanging: 284 }, tabs: [{ type: TabStopType.LEFT, position: 284 }], keepNext: true }));
    });
  }
  return out;
}

// ---------- body ----------
function markText(m) {
  return m != null ? `${m}M` : null;
}

function questionLabel(e) {
  return e.number != null ? `${e.number}.` : "";
}

// Render one entry (question or note) into an array of Paragraph/Table.
function renderEntry(e, section, showInferred) {
  const out = [];
  const items = e.items.slice();
  const isQ = e.kind === "question";
  // figure placement: first small image becomes a side figure with everything before it
  const figIdx = items.findIndex((x) => x.kind === "image" && imgSize(x.image, 500).w <= MAX_IMG_W);
  const explicit = isQ && e.marks != null && (e.marksSource === "paper" || e.marksSource === "paper (inner line)" || e.marksSource === "OR twin") && !e.items.some((x) => x.kind === "sub" && x.marks != null);
  const stemMark = isQ ? (e.stemSubMarks != null ? markText(e.stemSubMarks) : (explicit || (showInferred && e.marksSource !== "sum of sub-parts") ? markText(e.marks) : null)) : (e.marks != null ? markText(e.marks) : null);

  const renderItem = (it, idx, ctx) => {
    const last = idx === items.length - 1;
    const after = last ? 120 : undefined;
    const right = ctx.right;
    switch (it.kind) {
      case "stem": {
        const runs = e.alt ? [{ text: `(${e.alt}) ` }].concat(it.runs) : it.runs;
        if (isQ && e.number != null) return [Q(questionLabel(e), runs, { mark: idx === 0 ? stemMark : null, right, after: last ? 120 : 40, keepNext: !last })];
        if (e.center) return [INSTR(runs, { align: AlignmentType.CENTER, after })];
        return [INSTR(runs, { after: last ? 80 : 40 })];
      }
      case "cont": return [C(it.runs, { mark: markText(it.marks && it.marks !== e.marks ? it.marks : null), right, after: last ? 120 : 40, keepNext: !last })];
      case "sub": {
        // a nested label "(d) (i) …" would overflow the hanging indent, so it rides with the text
        const runs = it.nested ? [{ text: it.nested + " " }].concat(it.runs) : it.runs;
        return [SUB(it.label, runs, markText(it.marks), { right, after, keepNext: !last })];
      }
      case "opts": {
        const n = it.items.length;
        if (ctx.narrow && n > 2) {
          // beside a figure: two per line
          const rows = [];
          for (let i = 0; i < n; i += 2) rows.push(OPTS(it.items.slice(i, i + 2), [Math.round(ctx.width / 2)], { after: i + 2 >= n ? after || 0 : 0, keepNext: i + 2 < n }));
          return rows;
        }
        const longest = Math.max(...it.items.map((o) => plain(o).length));
        const perLine = n <= 2 ? (longest <= 45 ? 2 : 1) : n === 3 ? (longest <= 28 ? 3 : 1) : longest <= 22 ? 4 : longest <= 45 ? 2 : 1;
        if (perLine === 1) return it.items.map((o, i) => C(o, { after: i === n - 1 ? (last ? 120 : 40) : 0, keepNext: i < n - 1 || !last }));
        const rows = [];
        for (let i = 0; i < n; i += perLine) {
          const chunk = it.items.slice(i, i + perLine);
          const isLastRow = i + perLine >= n;
          rows.push(OPTS(chunk, (OPT_POS[perLine] || OPT_POS[4]).slice(0, chunk.length - 1), { after: isLastRow ? (last ? 120 : 0) : 0, keepNext: !isLastRow || !last }));
        }
        return rows;
      }
      case "or": return [OR({ after: last ? 120 : 40 })];
      case "image": return [IMAGE_LINE(it.image, !last)];
      case "images": return [IMAGES(it.images, !last)];
      case "table": return [DATA_TABLE(it.table), spacer()];
      case "pairs": return [PAIRS(it.rows), spacer()];
      case "tables": return [TABLE_ROW(it.tables), spacer()];
      default: return [];
    }
  };

  if (figIdx > 0) {
    const img = items[figIdx].image;
    const { w } = imgSize(img, 260);
    const rightW = pt2tw(w) + 120, leftW = TEXT_W - rightW;
    const ctx = { right: leftW - 100, narrow: true, width: leftW - 360 };
    const leftParas = [];
    for (let i = 0; i < figIdx; i++) leftParas.push(...renderItem(items[i], i, ctx));
    // paragraphs inside the cell must not carry keepNext to the table
    out.push(FIG(leftParas, img));
    out.push(spacer());
    for (let i = figIdx + 1; i < items.length; i++) out.push(...renderItem(items[i], i, { right: TEXT_W }));
  } else {
    items.forEach((it, i) => out.push(...renderItem(it, i, { right: TEXT_W })));
  }
  return out;
}

function sectionHeading(s) {
  if (s.implicit) return null;
  const rest = (s.rest || "").replace(/\s+/g, " ").trim();
  let title = `SECTION ${s.letter}`;
  if (rest) title += (rest.startsWith("(") ? " " : " – ") + rest;
  return HEADING(title);
}

function buildBody(model) {
  const body = [];
  for (const e of model.preamble) body.push(...renderEntry(e, { marksExpr: null }, false));
  for (const s of model.sections) {
    const heading = sectionHeading(s);
    if (heading) body.push(heading);
    for (const runs of s.instr) body.push(INSTR(runs));
    // show a per-question mark on stems only where the paper wrote one, or where the section gives no per-question figure
    const showInferred = !(s.marksExpr && s.marksExpr.per);
    for (const e of s.entries) body.push(...renderEntry(e, s, showInferred));
  }
  body.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { line: LINE, lineRule: "auto", before: 120, after: 0 },
    children: [new TextRun({ text: "*".repeat(40) + " END " + "*".repeat(40), font: FONT, size: 22, bold: true })] }));
  return body;
}

// ---------- document ----------
async function buildDocx(model, totals) {
  const doc = new Document({
    creator: "VVCHS QP Formatter",
    title: model.naming.base,
    styles: { default: { document: { run: { font: FONT, size: 22 }, paragraph: { spacing: { line: LINE, lineRule: "auto" } } } } },
    sections: [{
      properties: { page: {
        size: { width: PAGE_W, height: PAGE_H },
        margin: { top: M_T, bottom: M_B, left: M_L, right: M_R, header: 113, footer: 200, gutter: 0 },
        borders: {
          pageBorders: { offsetFrom: PageBorderOffsetFrom.PAGE },
          pageBorderTop: { style: BorderStyle.THIN_THICK_SMALL_GAP, size: 12, space: 24, color: "auto" },
          pageBorderLeft: { style: BorderStyle.THIN_THICK_SMALL_GAP, size: 12, space: 24, color: "auto" },
          pageBorderBottom: { style: BorderStyle.THICK_THIN_SMALL_GAP, size: 12, space: 24, color: "auto" },
          pageBorderRight: { style: BorderStyle.THICK_THIN_SMALL_GAP, size: 12, space: 24, color: "auto" },
        },
      } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 },
        children: [new TextRun({ text: "Page ", font: "Calibri", size: 22 }), new TextRun({ children: [PageNumber.CURRENT], font: "Calibri", size: 22 })] })] }) },
      children: [...headerBlock(model, totals), ...buildBody(model)],
    }],
  });
  const buf = await Packer.toBuffer(doc);
  // docx-js may emit <w:highlightCs/>, which is schema-invalid; strip it.
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file("word/document.xml").async("string");
  const cleaned = xml.replace(/<w:highlightCs[^>]*\/>/g, "");
  if (cleaned !== xml) zip.file("word/document.xml", cleaned);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

module.exports = { buildDocx };
