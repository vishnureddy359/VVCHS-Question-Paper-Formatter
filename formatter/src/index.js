#!/usr/bin/env node
// qp-format: reformat a teacher-submitted question paper to the VVCHS template.
//
//   node src/index.js <input.docx> [--out DIR] [--name BASE] [--json]
//
// Writes <BASE>.docx and <BASE>_REVIEW.md into DIR (default: ./out).
// Exit codes: 0 formatted, 2 formatted but blocking issues found (needs fixes), 1 error.

"use strict";

const fs = require("fs");
const path = require("path");
const { parseDocx } = require("./parse");
const { buildModel } = require("./model");
const { review } = require("./review");
const { buildDocx } = require("./build");

function usage() {
  console.error("usage: qp-format <input.docx> [--out DIR] [--name BASE] [--json]");
  process.exit(1);
}

async function formatPaper(inputPath, options = {}) {
  const buffer = fs.readFileSync(inputPath);
  const parsed = await parseDocx(buffer);
  const model = buildModel(parsed, path.basename(inputPath));
  if (options.name) model.naming.base = options.name;
  const rev = review(model, { date: options.date });
  const totals = rev.paperSum || null;
  const docx = await buildDocx(model, model.header.marks == null ? totals : null);
  const outDir = options.out || "out";
  fs.mkdirSync(outDir, { recursive: true });
  const docxPath = path.join(outDir, model.naming.base + ".docx");
  const reviewPath = path.join(outDir, model.naming.base + "_REVIEW.md");
  fs.writeFileSync(docxPath, docx);
  fs.writeFileSync(reviewPath, rev.markdown);
  const questions = model.sections.reduce((a, s) => a + s.entries.filter((e) => e.kind === "question").length, 0);
  return {
    input: inputPath, name: model.naming.base, docx: docxPath, review: reviewPath,
    blocking: rev.blocking, sections: model.sections.length, questions, marks: rev.paperSum, headerMarks: model.header.marks,
    sectionTotals: rev.sectionTotals.map((t) => ({ section: t.letter, sum: t.sum, expected: t.expected, missing: t.missing })),
  };
}

async function main(argv) {
  const args = argv.slice(2);
  if (!args.length || args.includes("-h") || args.includes("--help")) usage();
  const opts = {};
  const inputs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out") opts.out = args[++i];
    else if (a === "--name") opts.name = args[++i];
    else if (a === "--json") opts.json = true;
    else if (a.startsWith("-")) usage();
    else inputs.push(a);
  }
  if (inputs.length !== 1) usage();
  const result = await formatPaper(inputs[0], opts);
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`${result.name}: ${result.sections} sections, ${result.questions} question entries, ${result.marks} marks` + (result.headerMarks != null ? ` (header ${result.headerMarks})` : ""));
    console.log(`  docx:   ${result.docx}`);
    console.log(`  review: ${result.review}`);
    console.log(`  status: ${result.blocking ? "NEEDS FIXES" : "FORMATTED"}`);
  }
  return result.blocking ? 2 : 0;
}

if (require.main === module) {
  main(process.argv).then((code) => process.exit(code)).catch((e) => { console.error("qp-format: " + (e.stack || e)); process.exit(1); });
}

module.exports = { formatPaper };
