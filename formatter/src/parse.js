// Parse a .docx into a flat list of blocks the model builder can classify.
//
// Block shapes:
//   { type: 'p', runs, images, shapes, math, num, style, align, text }
//   { type: 'table', rows: [[{ paragraphs }]], bordered, floating, cols }
//
// A run is { text, bold, italic, underline, sup, sub, highlight }.
// An image is { name, data, ext, wpt, hpt, floating }.

"use strict";

const JSZip = require("jszip");
const { XMLParser } = require("fast-xml-parser");

const EMU_PER_PT = 12700;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  removeNSPrefix: false,
});

// ---------------------------------------------------------------- xml helpers

function tagOf(node) {
  return Object.keys(node).find((k) => k !== ":@");
}
function kids(node) {
  const t = tagOf(node);
  return t ? node[t] || [] : [];
}
function attrs(node) {
  return node[":@"] || {};
}
function child(node, tag) {
  return kids(node).find((n) => tagOf(n) === tag);
}
function children(node, tag) {
  return kids(node).filter((n) => tagOf(n) === tag);
}
function attr(node, tag, name = "w:val") {
  const c = child(node, tag);
  return c ? attrs(c)[name] : undefined;
}
function has(node, tag) {
  return !!child(node, tag);
}
function* walk(node) {
  yield node;
  for (const k of kids(node)) if (typeof k === "object" && tagOf(k)) yield* walk(k);
}
function findFirst(node, tag) {
  for (const n of walk(node)) if (tagOf(n) === tag) return n;
  return null;
}

// ---------------------------------------------------------------- numbering

function toRoman(n) {
  const t = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let s = "";
  for (const [v, r] of t) while (n >= v) { s += r; n -= v; }
  return s;
}
function toLetter(n) {
  let s = "";
  while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}
function fmtNum(fmt, n) {
  switch (fmt) {
    case "lowerLetter": return toLetter(n);
    case "upperLetter": return toLetter(n).toUpperCase();
    case "lowerRoman": return toRoman(n);
    case "upperRoman": return toRoman(n).toUpperCase();
    case "bullet": return "•";
    case "none": return "";
    default: return String(n);
  }
}

class Numbering {
  constructor(xml) {
    this.abstract = new Map(); // abstractNumId -> { lvls: Map(ilvl -> {fmt, text, start}) }
    this.nums = new Map(); // numId -> { abstractId, overrides: Map(ilvl -> start) }
    this.counters = new Map(); // abstractId -> [count per level]
    this.started = new Set(); // numId:ilvl that already applied a startOverride
    if (!xml) return;
    const root = findFirst({ root: parser.parse(xml) }, "w:numbering");
    if (!root) return;
    for (const a of children(root, "w:abstractNum")) {
      const lvls = new Map();
      for (const l of children(a, "w:lvl")) {
        lvls.set(Number(attrs(l)["w:ilvl"]), {
          fmt: attr(l, "w:numFmt") || "decimal",
          text: attr(l, "w:lvlText") || "%1.",
          start: Number(attr(l, "w:start") || 1),
        });
      }
      this.abstract.set(attrs(a)["w:abstractNumId"], { lvls });
    }
    for (const n of children(root, "w:num")) {
      const overrides = new Map();
      for (const o of children(n, "w:lvlOverride")) {
        const so = attr(o, "w:startOverride");
        if (so !== undefined) overrides.set(Number(attrs(o)["w:ilvl"]), Number(so));
      }
      this.nums.set(attrs(n)["w:numId"], { abstractId: attr(n, "w:abstractNumId"), overrides });
    }
  }

  // Returns { label, fmt, ilvl, value } for a paragraph's numPr, advancing counters.
  next(numId, ilvl) {
    const num = this.nums.get(numId);
    if (!num) return null;
    const abs = this.abstract.get(num.abstractId);
    if (!abs) return null;
    const lvl = abs.lvls.get(ilvl) || { fmt: "decimal", text: "%1.", start: 1 };
    // Word restarts a sequence for a w:num that carries a startOverride.
    const key = num.abstractId + ":" + numId;
    if (!this.counters.has(key)) this.counters.set(key, []);
    const c = this.counters.get(key);
    const startKey = numId + ":" + ilvl;
    if (num.overrides.has(ilvl) && !this.started.has(startKey)) {
      this.started.add(startKey);
      c[ilvl] = num.overrides.get(ilvl) - 1;
    }
    if (c[ilvl] === undefined) c[ilvl] = lvl.start - 1;
    c[ilvl] += 1;
    for (let i = ilvl + 1; i < c.length; i++) c[i] = undefined;
    let label = lvl.text;
    for (let i = 0; i <= 8; i++) {
      const l = abs.lvls.get(i) || { fmt: "decimal" };
      const v = c[i] === undefined ? (l.start || 1) : c[i];
      label = label.replace(new RegExp("%" + (i + 1), "g"), fmtNum(l.fmt, v));
    }
    return { label, fmt: lvl.fmt, ilvl, value: c[ilvl] };
  }
}

// ---------------------------------------------------------------- math (OMML)

function mathText(node) {
  const t = tagOf(node);
  const sub = () => kids(node).map(mathText).join("");
  switch (t) {
    case "m:t": return kids(node).map((k) => k["#text"] || "").join("");
    case "m:f": {
      const num = mathText(child(node, "m:num") || {}), den = mathText(child(node, "m:den") || {});
      const wrap = (s) => (/[+\-×÷ ]/.test(s) ? "(" + s + ")" : s);
      return wrap(num) + "/" + wrap(den);
    }
    case "m:sSup": return mathText(child(node, "m:e") || {}) + "^{" + mathText(child(node, "m:sup") || {}) + "}";
    case "m:sSub": return mathText(child(node, "m:e") || {}) + "_{" + mathText(child(node, "m:sub") || {}) + "}";
    case "m:sSubSup": return mathText(child(node, "m:e") || {}) + "_{" + mathText(child(node, "m:sub") || {}) + "}^{" + mathText(child(node, "m:sup") || {}) + "}";
    case "m:rad": {
      const deg = mathText(child(node, "m:deg") || {});
      return (deg ? deg + "√(" : "√(") + mathText(child(node, "m:e") || {}) + ")";
    }
    case "m:d": {
      const pr = child(node, "m:dPr");
      const beg = pr ? attr(pr, "m:begChr", "m:val") ?? "(" : "(";
      const end = pr ? attr(pr, "m:endChr", "m:val") ?? ")" : ")";
      return beg + children(node, "m:e").map(mathText).join(", ") + end;
    }
    case "m:bar": return mathText(child(node, "m:e") || {}).replace(/./g, (c) => c + "\u0305");
    case "m:num": case "m:den": case "m:e": case "m:sup": case "m:sub": case "m:deg":
    case "m:r": case "m:oMath": case "m:oMathPara": case "m:nary": case "m:box": case "m:borderBox":
    case "m:func": case "m:fName": case "m:limLow": case "m:lim": case "m:acc": case "m:groupChr": case "m:eqArr":
      return sub();
    case "m:rPr": case "m:ctrlPr": case "m:fPr": case "m:sSupPr": case "m:sSubPr": case "m:radPr": case "m:dPr":
    case "m:naryPr": case "m:boxPr": case "m:barPr": case "m:accPr": case "m:funcPr": case "m:limLowPr": case "m:groupChrPr":
    case "m:eqArrPr": case "m:sSubSupPr": case "m:oMathParaPr": case "m:borderBoxPr":
      return "";
    default: return sub();
  }
}

// ---------------------------------------------------------------- paragraph

function runProps(rPr, inherited) {
  const p = Object.assign({}, inherited);
  if (!rPr) return p;
  const on = (tag) => {
    const c = child(rPr, tag);
    if (!c) return undefined;
    const v = attrs(c)["w:val"];
    return v === undefined || v === "true" || v === "1" || v === "on";
  };
  if (on("w:b") !== undefined) p.bold = on("w:b");
  if (on("w:i") !== undefined) p.italic = on("w:i");
  if (has(rPr, "w:u")) p.underline = attr(rPr, "w:u") !== "none";
  const va = attr(rPr, "w:vertAlign");
  if (va !== undefined) { p.sup = va === "superscript"; p.sub = va === "subscript"; }
  const hl = attr(rPr, "w:highlight");
  if (hl !== undefined) p.highlight = hl !== "none";
  if (has(rPr, "w:shd")) {
    const fill = attr(rPr, "w:shd", "w:fill");
    if (fill && fill !== "auto" && fill.toUpperCase() !== "FFFFFF") p.highlight = true;
  }
  return p;
}

class DocxParser {
  constructor(zip, rels, media, numbering, styles) {
    this.zip = zip; this.rels = rels; this.media = media; this.numbering = numbering; this.styles = styles;
  }

  imageFromBlip(blipNode, cx, cy, floating) {
    const rid = attrs(blipNode)["r:embed"] || attrs(blipNode)["r:link"];
    const target = this.rels.get(rid);
    if (!target) return null;
    const data = this.media.get(target);
    if (!data) return null;
    const ext = (target.split(".").pop() || "").toLowerCase();
    return {
      name: target.split("/").pop(), data, ext: ext === "jpeg" ? "jpg" : ext,
      wpt: cx ? cx / EMU_PER_PT : 0, hpt: cy ? cy / EMU_PER_PT : 0, floating,
    };
  }

  parseDrawing(node) {
    const inline = child(node, "wp:inline"), anchor = child(node, "wp:anchor");
    const box = inline || anchor;
    if (!box) return null;
    const ext = child(box, "wp:extent");
    const cx = ext ? Number(attrs(ext).cx) : 0, cy = ext ? Number(attrs(ext).cy) : 0;
    const blip = findFirst(box, "a:blip");
    if (!blip) return { shape: true };
    return this.imageFromBlip(blip, cx, cy, !!anchor);
  }

  parsePict(node) {
    const idata = findFirst(node, "v:imagedata");
    if (!idata) return { shape: true };
    const rid = attrs(idata)["r:id"];
    const shape = findFirst(node, "v:shape");
    let wpt = 0, hpt = 0;
    if (shape) {
      const style = attrs(shape).style || "";
      const w = /width:([\d.]+)pt/.exec(style), h = /height:([\d.]+)pt/.exec(style);
      if (w) wpt = Number(w[1]);
      if (h) hpt = Number(h[1]);
    }
    const target = this.rels.get(rid);
    const data = target && this.media.get(target);
    if (!data) return { shape: true };
    const ext = (target.split(".").pop() || "").toLowerCase();
    return { name: target.split("/").pop(), data, ext: ext === "jpeg" ? "jpg" : ext, wpt, hpt, floating: false };
  }

  parseParagraph(pNode) {
    const pPr = child(pNode, "w:pPr");
    const runs = [], images = [];
    let shapes = 0, math = 0;
    const base = runProps(pPr && child(pPr, "w:rPr"), {});
    const pushText = (text, props) => {
      if (!text) return;
      const last = runs[runs.length - 1];
      if (last && ["bold", "italic", "underline", "sup", "sub", "highlight"].every((k) => !!last[k] === !!props[k])) last.text += text;
      else runs.push(Object.assign({ text }, props));
    };
    const visitRun = (r, inherited) => {
      const props = runProps(child(r, "w:rPr"), inherited);
      for (const k of kids(r)) {
        const t = tagOf(k);
        if (t === "w:t") pushText(kids(k).map((x) => x["#text"] || "").join(""), props);
        else if (t === "w:tab") pushText("\t", props);
        else if (t === "w:br" || t === "w:cr") pushText("\n", props);
        else if (t === "w:sym") pushText(String.fromCharCode(parseInt(attrs(k)["w:char"] || "20", 16)), props);
        else if (t === "w:noBreakHyphen") pushText("-", props);
        else if (t === "w:softHyphen") pushText("", props);
        else if (t === "w:drawing") { const im = this.parseDrawing(k); if (im && im.shape) shapes++; else if (im) { images.push(im); pushText("\uFFFC", props); } }
        else if (t === "w:pict" || t === "w:object") { const im = this.parsePict(k); if (im && im.shape) shapes++; else if (im) { images.push(im); pushText("\uFFFC", props); } }
        else if (t === "mc:AlternateContent") {
          // Word wraps shapes/text boxes here: Choice holds a drawing, Fallback a VML pict
          const choice = child(k, "mc:Choice"), fallback = child(k, "mc:Fallback");
          const drawing = choice && child(choice, "w:drawing");
          const pict = fallback && child(fallback, "w:pict");
          let im = drawing ? this.parseDrawing(drawing) : null;
          if ((!im || im.shape) && pict) { const p2 = this.parsePict(pict); if (p2 && !p2.shape) im = p2; }
          if (im && im.shape) shapes++; else if (im) { images.push(im); pushText("\uFFFC", props); }
          else shapes++;
        }
      }
    };
    const visit = (node, inherited) => {
      for (const k of kids(node)) {
        const t = tagOf(k);
        if (t === "w:r") visitRun(k, inherited);
        else if (t === "w:hyperlink" || t === "w:smartTag" || t === "w:sdt" || t === "w:sdtContent" || t === "w:ins" || t === "w:fldSimple" || t === "w:customXml") visit(k, inherited);
        else if (t === "m:oMath" || t === "m:oMathPara") { math++; pushText(mathText(k), Object.assign({}, inherited, { math: true })); }
      }
    };
    visit(pNode, base);

    let num = null;
    const style = pPr ? attr(pPr, "w:pStyle") : undefined;
    let numPr = pPr && child(pPr, "w:numPr");
    if (!numPr && style && this.styles.has(style)) numPr = this.styles.get(style).numPr;
    if (numPr) {
      const numId = attr(numPr, "w:numId"), ilvl = Number(attr(numPr, "w:ilvl") || 0);
      if (numId && numId !== "0") num = this.numbering.next(numId, ilvl);
    }
    const align = pPr ? attr(pPr, "w:jc") : undefined;
    const text = runs.map((r) => r.text).join("");
    return { type: "p", runs, images, shapes, math, num, style, align, text };
  }

  parseTable(tNode) {
    const tblPr = child(tNode, "w:tblPr");
    let bordered = true;
    if (tblPr) {
      const b = child(tblPr, "w:tblBorders");
      if (b) {
        const vals = ["w:top", "w:left", "w:bottom", "w:right", "w:insideH", "w:insideV"].map((t) => attr(b, t)).filter((v) => v !== undefined);
        if (vals.length && vals.every((v) => v === "none" || v === "nil")) bordered = false;
      } else {
        const st = attr(tblPr, "w:tblStyle");
        if (st && !/grid|border/i.test(st)) bordered = st !== "TableNormal" ? true : false;
        else if (!st) bordered = false;
      }
    }
    const floating = !!(tblPr && has(tblPr, "w:tblpPr"));
    const grid = child(tNode, "w:tblGrid");
    const cols = grid ? children(grid, "w:gridCol").map((c) => Number(attrs(c)["w:w"] || 0)) : [];
    const rows = [];
    for (const tr of children(tNode, "w:tr")) {
      const cells = [];
      for (const tc of children(tr, "w:tc")) {
        const paragraphs = [];
        for (const k of kids(tc)) {
          if (tagOf(k) === "w:p") paragraphs.push(this.parseParagraph(k));
          else if (tagOf(k) === "w:tbl") paragraphs.push(...this.parseTable(k).rows.flat().flatMap((c) => c.paragraphs));
        }
        const tcPr = child(tc, "w:tcPr");
        const span = tcPr ? Number(attr(tcPr, "w:gridSpan") || 1) : 1;
        let cellBorders = null;
        if (tcPr && has(tcPr, "w:tcBorders")) {
          const b = child(tcPr, "w:tcBorders");
          const vals = ["w:top", "w:left", "w:bottom", "w:right"].map((t) => attr(b, t)).filter((v) => v !== undefined);
          cellBorders = vals.length ? vals.some((v) => v !== "none" && v !== "nil") : null;
        }
        cells.push({ paragraphs, span, cellBorders });
      }
      rows.push(cells);
    }
    if (!bordered) {
      const anyCell = rows.flat().some((c) => c.cellBorders === true);
      if (anyCell) bordered = true;
    }
    return { type: "table", rows, bordered, floating, cols };
  }

  parseBody(bodyNode) {
    const blocks = [];
    for (const k of kids(bodyNode)) {
      const t = tagOf(k);
      if (t === "w:p") blocks.push(this.parseParagraph(k));
      else if (t === "w:tbl") blocks.push(this.parseTable(k));
      else if (t === "w:sdt") { const c = child(k, "w:sdtContent"); if (c) blocks.push(...this.parseBody(c)); }
    }
    return blocks;
  }
}

async function readRels(zip, part = "word/_rels/document.xml.rels") {
  const rels = new Map();
  const f = zip.file(part);
  if (!f) return rels;
  const root = findFirst({ root: parser.parse(await f.async("string")) }, "Relationships");
  if (!root) return rels;
  for (const r of children(root, "Relationship")) {
    const a = attrs(r);
    let target = a.Target || "";
    if (target.startsWith("/word/")) target = target.slice(6);
    else if (target.startsWith("/")) target = target.slice(1);
    rels.set(a.Id, target);
  }
  return rels;
}

// The page header of the first section: some teachers put the whole title block there.
async function readFirstPageHeader(zip, body, rels, media, numbering, styles) {
  const sect = findFirst(body, "w:sectPr");
  if (!sect) return [];
  const refs = children(sect, "w:headerReference");
  const pick = refs.find((r) => attrs(r)["w:type"] === "first") || refs.find((r) => attrs(r)["w:type"] === "default");
  if (!pick) return [];
  const target = rels.get(attrs(pick)["r:id"]);
  if (!target || !zip.file("word/" + target)) return [];
  const partRels = await readRels(zip, "word/_rels/" + target.split("/").pop() + ".rels");
  const root = findFirst({ root: parser.parse(await zip.file("word/" + target).async("string")) }, "w:hdr");
  if (!root) return [];
  const dp = new DocxParser(zip, partRels, media, numbering, styles);
  return dp.parseBody(root).filter((b) => b.type === "table" || b.text.trim() || b.images.length);
}

async function readStyles(zip) {
  const styles = new Map();
  const f = zip.file("word/styles.xml");
  if (!f) return styles;
  const root = findFirst({ root: parser.parse(await f.async("string")) }, "w:styles");
  if (!root) return styles;
  for (const s of children(root, "w:style")) {
    const id = attrs(s)["w:styleId"];
    const pPr = child(s, "w:pPr");
    styles.set(id, { name: attr(s, "w:name"), numPr: pPr && child(pPr, "w:numPr"), basedOn: attr(s, "w:basedOn") });
  }
  // resolve inherited numPr one level deep
  for (const [id, st] of styles) if (!st.numPr && st.basedOn && styles.get(st.basedOn)) st.numPr = styles.get(st.basedOn).numPr;
  return styles;
}

async function parseDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("not a .docx: word/document.xml missing");
  const rels = await readRels(zip);
  const media = new Map();
  for (const name of Object.keys(zip.files)) {
    if (name.startsWith("word/media/") && !zip.files[name].dir) media.set(name.slice(5), await zip.file(name).async("nodebuffer"));
  }
  const numXml = zip.file("word/numbering.xml") ? await zip.file("word/numbering.xml").async("string") : null;
  const numbering = new Numbering(numXml);
  const styles = await readStyles(zip);
  const doc = parser.parse(await docFile.async("string"));
  const body = findFirst({ root: doc }, "w:body");
  if (!body) throw new Error("word/document.xml has no body");
  const dp = new DocxParser(zip, rels, media, numbering, styles);
  const blocks = dp.parseBody(body);
  // prepend the first page's header block when the body itself does not start with the school name
  const bodyStart = blocks.filter((b) => b.type === "p" && b.text.trim()).slice(0, 4).map((b) => b.text).join(" ");
  if (!/vidya\s*vihar/i.test(bodyStart)) {
    const hdr = await readFirstPageHeader(zip, body, rels, media, numbering, styles);
    if (hdr.some((b) => b.type === "p" && /vidya\s*vihar|class\s*:/i.test(b.text))) blocks.unshift(...hdr);
  }
  return { blocks, mediaCount: media.size };
}

module.exports = { parseDocx, mathText };
