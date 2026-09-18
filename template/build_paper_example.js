// VVCHS question-paper builder (docx-js). Helpers reproduce the reference format exactly;
// the "body" section is paper-specific — replace it per paper. Put the paper's figures and
// the logo (media/image1.jpeg) in ./media before running: node build_paper_example.js
// After building: strip <w:highlightCs .../> from word/document.xml (docx-js emits it; schema-invalid).
const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell,
  AlignmentType, TabStopType, BorderStyle, WidthType, VerticalAlign, Footer,
  PageNumber, HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom,
  TextWrappingType, PageBorderOffsetFrom, TableLayoutType,
} = require("docx");

// ---------- page geometry (A4, matches reference) ----------
const PAGE_W = 11906, PAGE_H = 16838;
const M_L = 709, M_R = 709, M_T = 700, M_B = 567;
const TEXT_W = PAGE_W - M_L - M_R; // 10488 twips
const FONT = "Times New Roman";
const LINE = 276; // 1.15 line spacing
const pt2px = (pt) => Math.round(pt * 4 / 3);
const pt2tw = (pt) => Math.round(pt * 20);

// ---------- inline markup: **bold**, ==highlight==, ^{sup}, __underline__ ----------
function runs(text, base = {}) {
  const out = [];
  let bold = !!base.bold, hl = false, ul = !!base.underline;
  const parts = text.split(/(\^\{[^}]*\}|\*\*|==|__)/);
  for (const p of parts) {
    if (p === "") continue;
    if (p === "**") { bold = !bold; continue; }
    if (p === "==") { hl = !hl; continue; }
    if (p === "__") { ul = !ul; continue; }
    const sup = p.startsWith("^{");
    const txt = sup ? p.slice(2, -1) : p;
    out.push(new TextRun({
      text: txt, font: FONT, size: base.size || 22, bold, italics: !!base.italics,
      underline: ul ? {} : undefined, superScript: sup || undefined,
      highlight: hl ? "yellow" : undefined,
    }));
  }
  return out;
}

const P = (text, o = {}) => new Paragraph({
  alignment: o.align || AlignmentType.LEFT,
  spacing: { line: LINE, lineRule: "auto", before: o.before || 0, after: o.after == null ? 0 : o.after },
  indent: o.indent, tabStops: o.tabs, keepNext: o.keepNext, keepLines: true,
  children: runs(text, o),
});

// question stem: bold number, hanging indent; o.hang=720 when the stem itself starts with "i)\t"
const Q = (num, text, o = {}) => new Paragraph({
  spacing: { line: LINE, lineRule: "auto", before: o.before || 0, after: o.after == null ? 40 : o.after },
  indent: { left: o.hang || 360, hanging: o.hang || 360 },
  keepNext: true, keepLines: true,
  tabStops: o.hang ? [{ type: TabStopType.LEFT, position: 360 }, { type: TabStopType.LEFT, position: o.hang }] : o.tabs,
  children: [
    new TextRun({ text: num + ".", font: FONT, size: 22, bold: true }),
    new TextRun({ text: "\t", font: FONT, size: 22 }),
    ...runs(text),
  ],
});

// continuation line inside a question (aligned with question text)
const C = (text, o = {}) => P(text, { indent: { left: 360 }, after: o.after == null ? 40 : o.after, keepNext: o.keepNext, tabs: o.tabs });

// sub-part "(a) ..." / "i) ..." with optional right-aligned mark ("1M")
const SUB = (label, text, mark, o = {}) => {
  const left = o.left == null ? 720 : o.left;
  const right = o.right == null ? TEXT_W : o.right;
  const ch = [new TextRun({ text: label, font: FONT, size: 22 }), new TextRun({ text: "\t", font: FONT, size: 22 }), ...runs(text)];
  if (mark) ch.push(new TextRun({ text: "\t", font: FONT, size: 22 }), ...runs(mark));
  return new Paragraph({
    spacing: { line: LINE, lineRule: "auto", after: o.after == null ? 0 : o.after },
    indent: { left, hanging: 360 }, keepNext: o.keepNext, keepLines: true,
    tabStops: [{ type: TabStopType.LEFT, position: left }, { type: TabStopType.RIGHT, position: right }],
    children: ch,
  });
};

// four MCQ options on one line
const OPT4 = (a, b, c, d, o = {}) => new Paragraph({
  spacing: { line: LINE, lineRule: "auto", after: o.after == null ? 120 : o.after },
  indent: { left: 360 }, keepLines: true,
  tabStops: [{ type: TabStopType.LEFT, position: 2880 }, { type: TabStopType.LEFT, position: 5400 }, { type: TabStopType.LEFT, position: 7920 }],
  children: [...runs(a), new TextRun({ text: "\t" }), ...runs(b), new TextRun({ text: "\t" }), ...runs(c), new TextRun({ text: "\t" }), ...runs(d)],
});

// two options per line (beside figures); mid = tab position in twips
const OPT2 = (a, b, mid, o = {}) => new Paragraph({
  spacing: { line: LINE, lineRule: "auto", after: o.after == null ? 0 : o.after },
  indent: { left: 360 }, keepLines: true,
  tabStops: [{ type: TabStopType.LEFT, position: mid }],
  children: [...runs(a), new TextRun({ text: "\t" }), ...runs(b)],
});

const OR = (o = {}) => P("**OR**", { align: AlignmentType.CENTER, before: o.before == null ? 40 : o.before, after: o.after == null ? 40 : o.after, keepNext: true });

const HEADING = (text) => new Paragraph({
  alignment: AlignmentType.CENTER, spacing: { line: LINE, lineRule: "auto", before: 200, after: 120 }, keepNext: true,
  children: [new TextRun({ text, font: FONT, size: 28, bold: true, underline: {} })],
});

const INSTR = (text, o = {}) => P("**" + text + "**", { after: o.after == null ? 80 : o.after, keepNext: true });
const spacer = () => new Paragraph({ spacing: { before: 0, after: 0, line: 120, lineRule: "exact" }, children: [] });

// ---------- figure question: borderless 2-col table (text | image) ----------
const IMG = (file, wpt, hpt) => new ImageRun({
  type: file.endsWith(".png") ? "png" : "jpg", data: fs.readFileSync("media/" + file),
  transformation: { width: pt2px(wpt), height: pt2px(hpt) },
});
const NOB = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const NOBORDERS = { top: NOB, bottom: NOB, left: NOB, right: NOB, insideHorizontal: NOB, insideVertical: NOB };
const FIG = (leftParas, file, wpt, hpt, o = {}) => {
  const rightW = pt2tw(wpt) + 120, leftW = TEXT_W - rightW;
  return new Table({
    width: { size: TEXT_W, type: WidthType.DXA }, columnWidths: [leftW, rightW], layout: TableLayoutType.FIXED,
    borders: NOBORDERS, margins: { left: 0, right: 0, top: 0, bottom: 0 },
    rows: [new TableRow({ cantSplit: true, children: [
      new TableCell({ width: { size: leftW, type: WidthType.DXA }, borders: NOBORDERS, margins: { left: 0, right: 100, top: 0, bottom: 0 },
        verticalAlign: o.valign || VerticalAlign.CENTER, children: leftParas }),
      new TableCell({ width: { size: rightW, type: WidthType.DXA }, borders: NOBORDERS, margins: { left: 0, right: 0, top: 0, bottom: 0 },
        verticalAlign: VerticalAlign.CENTER,
        children: [new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 0, after: 0, line: 240, lineRule: "auto" }, children: [IMG(file, wpt, hpt)] })] }),
    ] })],
  });
};

// ---------- header block (edit the four values per paper) ----------
const EXAM = "HALF-YEARLY EXAMINATION – 2026-2027";
const CLASS = "IX", SUBJECT = "MATHS (041)", MARKS = "80", DATE = "07/10/2026", TIME = "3 hours";
const INSTRUCTIONS = [
  "1.\tAll questions are compulsory.",
  "2.\tThe question paper contains five sections – A, B, C, D and E.",
  "3.\tSection A: 20×1 = 20 marks (18 MCQs + 2 Assertion–Reason)",
  "4.\tSection B: 5×2=10 marks; Section C: 6×3=18 marks; Section D: 4×5=20 marks; Section E: 3×4=12 marks.",
  "5.\tDraw neat, labelled figures wherever required.",
];
const logo = new ImageRun({
  type: "jpg", data: fs.readFileSync("media/image1.jpeg"), transformation: { width: pt2px(47), height: pt2px(41) },
  floating: {
    horizontalPosition: { relative: HorizontalPositionRelativeFrom.COLUMN, offset: -97790 },
    verticalPosition: { relative: VerticalPositionRelativeFrom.PARAGRAPH, offset: -40000 },
    wrap: { type: TextWrappingType.NONE }, allowOverlap: true, behindDocument: false,
  },
});
const HDR_TABS = [{ type: TabStopType.LEFT, position: 3600 }, { type: TabStopType.LEFT, position: 8640 }];
const header = [
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
    children: [logo, new TextRun({ text: "VIDYA VIHAR CONVENT HIGH SCHOOL, CHANDRAPUR", font: FONT, size: 32, bold: true })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
    children: [new TextRun({ text: EXAM, font: FONT, size: 28, bold: true })] }),
  new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, tabStops: HDR_TABS,
    children: runs(`Class: ${CLASS}\tSubject: ${SUBJECT}\tMarks: ${MARKS} marks`, { bold: true, size: 24 }) }),
  new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 100 }, tabStops: HDR_TABS,
    indent: { left: -152, firstLine: 152, right: -228 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 14, space: 4, color: "000000" } },
    children: runs(`Date: ${DATE}\tRoll No.:______________\tTime: ${TIME}`, { bold: true, size: 24 }) }),
  P("General Instructions:", { bold: true, italics: true, underline: true, size: 24, before: 60, after: 0, keepNext: true }),
  ...INSTRUCTIONS.map((t) => P(t, { bold: true, italics: true, size: 24, indent: { left: 284, hanging: 284 }, tabs: [{ type: TabStopType.LEFT, position: 284 }], keepNext: true })),
];

// ---------- body (paper-specific; Maths IX HYE 2026-27 shown as the worked example) ----------
const body = [];
const push = (...x) => body.push(...x);

push(HEADING("SECTION A – MCQs AND ASSERTION–REASON (1x18=18 marks)"));
push(INSTR("Questions 1–18: Select the correct option. Each question carries 1 mark."));
push(Q(1, "A point lies in the second quadrant. Its distance from the X axis is 3 units and that from the Y axis is 4 units its coordinates are -"));
push(OPT4("(A) (4, -3)", "(B) (-3, 4)", "(C) (−4 3)", "(D) (3, −4)"));
push(FIG([Q(2, "If the distance between P(3, 4) and the origin is:"), OPT2("(A) 3 units", "(B) 4 units", 2600), OPT2("(C) 5 units", "(D) 7 units", 2600)], "image2.png", 272, 105));
push(spacer());
push(Q(3, "The zero of the linear polynomial 3x − 12 is:")); push(OPT4("(A) 3", "(B) 4", "(C) 6", "(D) 12"));
push(Q(4, "For y = 2x + 1, the value of y when x = 3 is:")); push(OPT4("(A) 5", "(B) 6", "(C) 7", "(D) 8"));
push(Q(5, "Which of the following is irrational?")); push(OPT4("(A) √49", "(B) 0.25", "(C) √2", "(D) 7/8"));
push(Q(6, "The decimal expansion of 1/8 -is:")); push(OPT4("(A) 0.125", "(B) 0.0125", "(C) 0.8", "(D) 0.25"));
push(Q(7, "x^{2} − 16x + 64 can be expressed as the product of")); push(OPT4("(A) (X-4)(X+4)", "(B) (X-8)(X-8)", "(C) (X-16)(X-4)", "(D) X+16)(X+4)"));
push(Q(8, "The factorization of x^{2} − 25 is:")); push(OPT4("(A) (x−5)^{2}", "(B) (x+5)^{2}", "(C) (x−5)(x+5)", "(D) x(x−25)"));
push(FIG([Q(9, "If OM ⟂ AB in the figure, M is:"), OPT2("(A) the centre", "(B) the midpoint of AB", 3200), OPT2("(C) an endpoint", "(D) outside the circle", 3200)], "q9.png", 118, 101));
push(spacer());
push(FIG([Q(10, "In a circle, ∠AOB = 120°, where O is the centre. If C is any point on the remaining arc AB, then ∠ACB is -"), OPT2("(A) 30°", "(B) 60°", 2600), OPT2("(C) 120°", "(D) 240°", 2600)], "image3.png", 213, 103));
push(spacer());
push(Q(11, "If X==^{2}−== X – 42 is equal to (x+6)(x+a) then a =")); push(OPT4("(A) 6", "(B) -6", "(C) 7", "(D) -7"));
push(Q(12, "Addition of the expressions (3√5 − 5√3) and (2√5 + 5√3) gives:")); push(OPT4("(A) 2√5", "(B) 10√3", "(C) 5√5", "(D) 5√3"));
push(FIG([Q(13, "If ABCD is cyclic and ∠A = 82°, then ∠C is:"), OPT2("(A) 82°", "(B) 98°", 2600), OPT2("(C) 164°", "(D) 180°", 2600)], "image4.png", 226, 91));
push(spacer());
push(Q(14, "Abscissa of all points on the X axis is:")); push(OPT4("(A) 0", "(B) 1", "(C) any real number", "(D) none of these"));
push(FIG([Q(15, "In the figure, if AB is the diameter of the circle, then the value of x is:"), OPT2("(A) 40°", "(B) 50°", 2600), OPT2("(C) 80°", "(D) 90°", 2600)], "image5.png", 94, 90));
push(spacer());
push(Q(16, "If two lines intersect and one angle is 72°, the vertically opposite angle is:")); push(OPT4("(A) 72°", "(B) 108°", "(C) 144°", "(D) 288°"));
push(FIG([Q(17, "If a linear pair contains one angle of 65°, the other angle is:"), OPT2("(A) 65°", "(B) 115°", 2600), OPT2("(C) 125°", "(D) 180°", 2600)], "image6.png", 236, 82));
push(spacer());
push(Q(18, "If two parallel lines are cut by a transversal, alternate interior angles are:")); push(OPT4("(A) supplementary", "(B) equal", "(C) always 90°", "(D) always 45°"));
push(INSTR("Questions 19–20: For each Assertion–Reason question, choose the correct option:", { after: 0 }));
push(SUB("(A)", "Both A and R are true, and R is the correct explanation of A.", null, { left: 720, keepNext: true }));
push(SUB("(B)", "Both A and R are true, but R is not the correct explanation of A.", null, { left: 720, keepNext: true }));
push(SUB("(C)", "A is true, but R is false.", null, { left: 720, keepNext: true }));
push(SUB("(D)", "A is false, but R is true.", null, { left: 720, after: 120, keepNext: true }));
push(FIG([Q(19, "**Assertion (A):** If a perpendicular from the centre of a circle meets a chord at M, then M is the midpoint of the chord.", { after: 0 }), C("**Reason (R):** The perpendicular from the centre to a chord bisects the chord.", { after: 0 })], "image7.png", 218, 107));
push(spacer());
push(FIG([Q(20, "**Assertion (A):** If a transversal makes equal alternate interior angles with two lines, then the two lines are parallel.", { after: 0 }), C("**Reason (R):** Equal alternate interior angles are a criterion for two lines to be parallel.", { after: 0 })], "image8.png", 243, 87));

push(HEADING("SECTION B – VERY SHORT ANSWER QUESTIONS (2x5=10 marks)"));
push(INSTR("Questions 21–25 carry 2 marks each."));
push(Q(21, "Using Identity simplify (2x − 3)^{2}.", { after: 120 }));
push(Q(22, "Find the value of polynomial 7x^{2} − 4x + 6 if x = -3", { after: 120 }));
push(FIG([Q(23, "ABCD is cyclic. If ∠A = 3x + 10° and ∠C = 2x + 20°, find x and both angles.", { after: 0 })], "image9.png", 218, 88));
push(spacer());
push(FIG([Q(24, "Two lines intersect at O. If ∠AOC = 72°, find the other three angles.", { after: 0 })], "image10.png", 121, 66));
push(OR());
push(FIG([C("In the figure, l₁ ∥ l₂. If one corresponding angle is 65°, find x and give the reason.", { after: 0 })], "image8.png", 213, 76));
push(spacer());
push(Q(25, "Convert the given decimal number in the form of p/q: 2.2̅5̅7̅", { after: 120 }));

push(HEADING("SECTION C – SHORT ANSWER QUESTIONS (3x6=18 marks)"));
push(INSTR("Questions 26–31 Carry 3 marks each."));
push(Q(26, "Find the values of P such that AB = BC, where the coordinates of A, B & C are (6, -1), (1, 3) and (p, 8) respectively.", { after: 0 }));
push(OR()); push(C("If the sum of a number and its reciprocal is 4, find the sum of their squares.", { after: 120 }));
push(Q(27, "Simplify the following rational expression assuming ==that the in== denominator is not equal to zero:", { after: 0 }));
push(C("(4x^{2} − 20xz + 25z^{2}) / (25x^{2} − 4x^{2})", { after: 120 }));
push(Q(28, "Given the points A(1,-8), B(-4,7), C(-7,-4) show that they lie on a circle K whose centre is the origin O(0,0), what is the radius of the circle K? If the point is D(-5, 6), check whether D lies within the circle, on the circle or outside the circle K.", { after: 120 }));
push(Q(29, "A taxi charges ₹40 plus ₹12 per kilometer. Write the linear expression for x km and find the fare for 8 km.", { after: 0 }));
push(OR());
push(Q(29, "A mobile phone Is bought for ₹ 10,000. Its value decreases by ₹800 every year.", { after: 0 }));
push(SUB("i)", "Find the value of the phone after three years.", null, { keepNext: true }));
push(SUB("ii)", "Make a table of value for t varying from 0 to 2 years and show how the value of the phone v depreciates with time.", null, { keepNext: true }));
push(SUB("iii)", "Find an expression that relates V & T and explain why it is represent linear decay.", null, { after: 120 }));
push(Q(30, "i)\tProve that the following rational numbers are equal ==(Which numbers)==", { after: 0, hang: 720 }));
push(SUB("ii)", "Simplify by using distributive property : **7/9(6/7−3/4)**", null, { after: 120 }));
push(Q(31, "Draw the graph of the given equation and identify its slope and Y intercept. Also, find the coordinates of the point where the given line cut the Y axis.   **2y = 4x + 7**", { after: 120 }));

push(HEADING("SECTION D – LONG ANSWER QUESTIONS (5x4=20 marks)"));
push(INSTR("Questions 32–35 carry 5 marks each."));
push(FIG([Q(32, "In Fig., if AB ∥ CD, EF ⊥ CD and ∠GED = 126°, find", { after: 0 }), SUB("i)", "∠AGE", null, { keepNext: true }), SUB("ii)", "∠GEF", null, { keepNext: true }), SUB("iii)", "∠FGE", null, { keepNext: true }), SUB("iv)", "∠GFE", null, {})], "image11.jpeg", 193, 114));
push(OR());
push(FIG([Q(32, "In the figure below, AB = AC and AD bisects ∠A.", { after: 0 }), SUB("i)", "Prove that ΔABD ≅ ΔACD.", null, { keepNext: true }), SUB("ii)", "Hence prove that BD = DC and AD ⟂ BC.", null, {})], "image12.png", 175, 107));
push(spacer());
push(Q(33, "i)\tIf a + b + c = 5 and ab + bc + ca = 10 then prove that a^{3} + b^{3} + c^{3} − 3abc = -25.", { after: 0, hang: 720 }));
push(SUB("ii)", "Find the value of x^{3} + y^{3} − 12xy + 64 when x + y = − 4", null, { after: 120 }));
push(Q(34, "i)\tDraw ΔABC with AB = 5 cm, ∠A = 70° and ∠B = 60°. Draw the circumcircle of ΔABC. Is the centre inside or outside the triangle?", { after: 0, hang: 720 }));
push(SUB("ii)", "Prove the theorem - Chords of a circle that subtend equal angle at the centre are equal.", null, { after: 0 }));
push(OR());
push(FIG([C("If CE is perpendicular to AB, CH is perpendicular to GH and CE = CH, show that AB = GF by using the Baudhayana-Pythagoras theorem.", { after: 0 })], "image13.jpeg", 161, 139));
push(spacer());
push(Q(35, "A school canteen charges a fixed amount of ₹30 and ₹15 for each sandwich purchased. Let x be the number of sandwiches and y be the total amount paid.", { after: 0 }));
push(SUB("(a)", "Write the linear relationship between x and y.", "1M", { keepNext: true }));
push(SUB("(b)", "Find the total amount paid for 6 sandwiches.", "1M", { keepNext: true }));
push(SUB("(c)", "If a student pays ₹180, find the number of sandwiches purchased.", "1M", { keepNext: true }));
push(SUB("(d)", "Identify the coefficient of x and the constant term in the relationship.", "1M", { keepNext: true }));
push(SUB("(e)", "Write the equation in the form y = ax + b and state the value of a and b.", "1M", { after: 120 }));

push(HEADING("SECTION E – CASE STUDY-BASED QUESTIONS (4x3=12 marks)"));
push(INSTR("Questions 36–38 carry 4 marks each."));
push(Q(36, "Two parallel roads l and m are crossed by a straight road t. At one intersection, one of the angles measures 72°. Answer the following:", { after: 0 }));
push(SUB("(a)", "What is the measure of the vertically opposite angle?", "1M", { keepNext: true }));
push(SUB("(b)", "What is the measure of an adjacent angle on the straight line?", "1M", { keepNext: true }));
push(SUB("(c)", "What is the measure of the corresponding angle at the second intersection?", "1M", { keepNext: true }));
push(SUB("(d)", "Name the angle-pair relationship used in part (c).", "1M", { keepNext: true }));
push(OR());
push(SUB("(d)", "If the angle corresponding to the given 72° angle is 72°, what is the measure of the alternate interior angle at the first intersection?", "1M", { after: 120 }));
const CELL_W = TEXT_W - (pt2tw(272) + 120);
push(Q(37, "A school teacher marks four points on a coordinate plane to represent four activity stations, as shown below.", { after: 0 }));
push(FIG([
  SUB("(a)", "In which quadrant does A(2,3) lie?", "1M", { right: CELL_W - 100, keepNext: true }),
  SUB("(b)", "Find the length of AB.", "1M", { right: CELL_W - 100, keepNext: true }),
  SUB("(c)", "Find the length of AD. ==drawn==", "1M", { right: CELL_W - 100, keepNext: true }),
  SUB("(d)", "Name the quadrilateral ABCD.", "1M", { right: CELL_W - 100, keepNext: true }),
  OR(),
  SUB("(d)", "What are the coordinates of the point where the diagonals AC and BD intersect?", "1M", { right: CELL_W - 100 }),
], "image14.png", 272, 203));
push(spacer());
push(Q(38, "A student records the following numbers while studying the number system:", { after: 0 }));
push(C("A = 3/8,\tB = √5,\tC = 0.625,\tD = ==0.121212…== .", { after: 0, keepNext: true, tabs: [{ type: TabStopType.LEFT, position: 2160 }, { type: TabStopType.LEFT, position: 3960 }, { type: TabStopType.LEFT, position: 5940 }] }));
push(C("Answer the following:", { after: 0, keepNext: true }));
push(SUB("(a)", "Which of the four numbers are rational?", "1M", { keepNext: true }));
push(SUB("(b)", "Which number is irrational?", "1M", { keepNext: true }));
push(SUB("(c)", "Convert A into decimal form and state whether it terminates or repeats.", "1M", { keepNext: true }));
push(SUB("(d)", "Write one rational number between 1/2 and 3/4.", "==(marks)==", { after: 200 }));
push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { line: LINE, lineRule: "auto", before: 120, after: 0 },
  children: [new TextRun({ text: "*".repeat(40) + " END " + "*".repeat(40), font: FONT, size: 22, bold: true })] }));

// ---------- document ----------
const doc = new Document({
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
    children: [...header, ...body],
  }],
});

Packer.toBuffer(doc).then((buf) => { fs.writeFileSync("Maths_IX_HYE_2026-27.docx", buf); console.log("written"); });
