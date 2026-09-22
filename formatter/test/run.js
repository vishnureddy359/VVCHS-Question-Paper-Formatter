// Round-trip test: build a small teacher-style paper with docx-js, run it through the
// formatter, and check the model, the review and the output document.
//
//   node test/run.js

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const JSZip = require("jszip");
const { Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, AlignmentType } = require("docx");
const { parseDocx } = require("../src/parse");
const { buildModel, plain, garbledDevanagari, subjectSlug } = require("../src/model");
const { review } = require("../src/review");
const { formatPaper } = require("../src/index");

// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const p = (text, o = {}) => new Paragraph({ alignment: o.center ? AlignmentType.CENTER : undefined, children: [new TextRun({ text, bold: o.bold })] });

async function makeFixture() {
  const doc = new Document({ sections: [{ children: [
    p("VIDYA VIHAR CONVENT HIGH SCHOOL, CHANDRAPUR", { center: true, bold: true }),
    p("HALF-YEARLY EXAMINATION – 2026-2027", { center: true }),
    p("Class: VII\t\tSubject: Science (086)\t\tMarks: 10 marks"),
    p("Date: 01/10/2026\t\tRoll No.:______\t\tTime: 1 hour"),
    p("General Instructions:"),
    p("1. All questions are compulsory."),
    p("Section A (1×4 = 4 Marks)"),
    p("Q.1. Which gas do plants absorb?"),
    p("     a) Oxygen        b) Carbon dioxide        c) Nitrogen        d) Helium"),
    p("Q.2. The sum of angles of a triangle is 180o. The value of 90o + 90o is:                1M"),
    p("a) 180o          b) 270o            c) 360o             d) 450o"),
    p("Q.3. Observe the figure and name the shape.     1M"),
    new Paragraph({ children: [new ImageRun({ type: "png", data: PNG, transformation: { width: 60, height: 40 } })] }),
    p("Q.4. Which of these is a compound? [1]"),
    p("(A) Air"), p("(B) Water"), p("(C) Brass"), p("(D) Milk"),
    p("Section – B"),
    p("Section B consists of short answers.        (3×2=6Marks)"),
    p("Q.5. Read the table below and answer:"),
    new Table({ rows: [
      new TableRow({ children: [new TableCell({ children: [p("Item")] }), new TableCell({ children: [p("Count")] })] }),
      new TableRow({ children: [new TableCell({ children: [p("Pens")] }), new TableCell({ children: [p("12")] })] }),
    ] }),
    p("(a) How many pens are there?     1M"),
    p("(b) Explain why the count matters.     2M"),
    p("Q.6. State two uses of water.                    3M"),
    p("OR"),
    p("State two uses of air.                    3M"),
    p("Q.7. What is friction? Give an example      2M"),
    p("******************************************"),
  ] }] });
  return Packer.toBuffer(doc);
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qpfmt-"));
  const input = path.join(dir, "Science_7th_PT1_2026-2027.docx");
  fs.writeFileSync(input, await makeFixture());

  // --- parse + model
  const parsed = await parseDocx(fs.readFileSync(input));
  const model = buildModel(parsed, path.basename(input));
  assert.strictEqual(model.header.cls, "VII");
  assert.strictEqual(model.header.subject, "Science");
  assert.strictEqual(model.header.subjectCode, "086");
  assert.strictEqual(model.header.marks, 10);
  assert.strictEqual(model.header.time, "1 hour");
  assert.strictEqual(model.header.instructions.length, 1);
  assert.strictEqual(model.naming.base, "Science_VII_HYE_2026-27");
  assert.strictEqual(model.naming.conflict, true, "file says PT1, paper says half-yearly");
  assert.strictEqual(model.sections.length, 2);
  const [A, B] = model.sections;
  assert.deepStrictEqual(A.marksExpr && [A.marksExpr.per, A.marksExpr.count, A.marksExpr.total], [1, 4, 4]);
  assert.deepStrictEqual(B.marksExpr && [B.marksExpr.per, B.marksExpr.count, B.marksExpr.total], [3, 2, 6], "section marks read from the instruction line");
  const qs = A.entries.filter((e) => e.kind === "question");
  assert.deepStrictEqual(qs.map((q) => q.number), [1, 2, 3, 4]);
  // options split from one line, degree sign fixed, marks read from the line
  const q1opts = qs[0].items.find((i) => i.kind === "opts");
  assert.deepStrictEqual(q1opts.items.map(plain), ["a) Oxygen", "b) Carbon dioxide", "c) Nitrogen", "d) Helium"]);
  assert.strictEqual(qs[1].marks, 1);
  assert.ok(/180°\. The value of 90° \+ 90°/.test(plain(qs[1].items[0].runs)), "degree signs fixed in the stem");
  assert.deepStrictEqual(qs[1].items.find((i) => i.kind === "opts").items.map(plain), ["a) 180°", "b) 270°", "c) 360°", "d) 450°"]);
  // image carried, [1] mark form, one-per-line options merged
  assert.ok(qs[2].items.some((i) => i.kind === "image"), "Q3 keeps its image");
  assert.strictEqual(qs[3].marks, 1);
  assert.strictEqual(qs[3].items.find((i) => i.kind === "opts").items.length, 4, "single-line options merged into one row");
  // section B: table, sub-part marks summed, OR twin, missing mark inferred from section
  const bq = B.entries.filter((e) => e.kind === "question");
  assert.deepStrictEqual(bq.map((q) => q.number), [5, 6, 7]);
  assert.ok(bq[0].items.some((i) => i.kind === "table"), "Q5 keeps its table");
  assert.strictEqual(bq[0].marks, 3, "Q5 = (a) 1 + (b) 2");
  assert.strictEqual(bq[1].marks, 3);
  assert.ok(bq[1].items.some((i) => i.kind === "or"));
  assert.strictEqual(bq[2].marks, 2);

  // --- review
  const rev = review(model, { date: new Date("2026-09-18T06:00:00Z") });
  assert.ok(rev.markdown.includes("Reviewed 18 Sep 2026"));
  assert.ok(rev.markdown.includes("Exam name conflict"), "conflict is reported");
  assert.ok(/Section B: marks sum to 8, heading says 6/.test(rev.markdown), "section B mismatch is reported: " + rev.markdown);
  assert.strictEqual(rev.blocking, true);
  assert.ok(rev.markdown.includes("Q7: no punctuation at the end of the question."));
  assert.ok(rev.markdown.includes("Degree signs"));

  // --- full CLI path writes both files and the docx has the expected pieces
  const result = await formatPaper(input, { out: path.join(dir, "out"), date: new Date("2026-09-18T06:00:00Z") });
  assert.strictEqual(result.name, "Science_VII_HYE_2026-27");
  assert.ok(fs.existsSync(result.docx) && fs.existsSync(result.review));
  const zip = await JSZip.loadAsync(fs.readFileSync(result.docx));
  const xml = await zip.file("word/document.xml").async("string");
  assert.ok(!/highlightCs/.test(xml), "schema-invalid highlightCs stripped");
  assert.ok(xml.includes("VIDYA VIHAR CONVENT HIGH SCHOOL, CHANDRAPUR"));
  assert.ok(xml.includes("SECTION A (1×4 = 4 Marks)"));
  assert.ok(xml.includes("Subject: SCIENCE (086)"));
  assert.ok(xml.includes("General Instructions:"));
  assert.ok(xml.includes("<w:pgBorders"), "page border present");
  assert.ok(/w:tab[^>]*w:val="right"[^>]*w:pos="10488"/.test(xml), "marks right-tab at the margin");
  assert.ok((xml.match(/<w:tbl>/g) || []).length >= 2, "figure table and data table present");
  assert.strictEqual(Object.keys(zip.files).filter((f) => f.startsWith("word/media/") && !zip.files[f].dir).length, 2, "logo + one figure");
  assert.ok(xml.includes("END"));

  // --- a primary-class Hindi paper: header variants, no sections, Devanagari labels, (i)(ii)(iii) options, matching pairs
  const hindiDoc = new Document({ sections: [{ children: [
    p("VIDYA VIHAR CONVENT HIGH SCHOOL CHANDRAPUR", { center: true, bold: true }),
    p("HALF YEAR  EXAMINATION  2026-27", { center: true, bold: true }),
    p("CLASS  :   II\t\tSUB – HINDI", { bold: true }),
    p("DATE  :      /09/2026\t\tROLL NO.____\t\tMARKS: 15 MARKS", { bold: true }),
    p("NAME : ..................\t\tTIME   : 3.00 HRS", { bold: true }),
    p("प्र. 1 : निम्नलिखित प्रश्नों के सही उत्तर पर सही का निशान लगाइए -        (1x5 M)", { bold: true }),
    p("क)   देबू कौन सी कक्षा में पढ़ता था ?"),
    p("       (i) छठी          (ii) पाँचवी          (iii) चौथी"),
    p("प्र. 2 : दिए गए शब्दों से रिक्त स्थान भरिए -        (1x 5=5 M)", { bold: true }),
    p("क)   शुभो जब कमरे से बाहर निकला तो ______ सा लग रहा था |"),
    p("प्र. 3 : कविता पूर्ण करें |        (1 M)", { bold: true }),
    p("क)   केवल उनको मीत बनाना"),
    p("प्र. 4 : सही मिलान कीजिए -        (4 M)", { bold: true }),
    p("देश\t\tनिभाना"), p("विश्व\t\tनारा"), p("साथ\t\tभक्ति"), p("बुलंद\t\tशांति"),
    p("ड)   पाँचवाँ भाग"),
    p("व्याकरण:", { center: true, bold: true }),
    p("प्र. 1 : विलोम शब्द लिखिए -        (2 M)", { bold: true }),
    p("(iii) माता = ______      (iv) बकरा = ______"),
  ] }] });
  const hindiPath = path.join(dir, "Hindi_II_HYE_2026_2027.docx");
  fs.writeFileSync(hindiPath, await Packer.toBuffer(hindiDoc));
  const hm = buildModel(await parseDocx(fs.readFileSync(hindiPath)), path.basename(hindiPath));
  assert.strictEqual(hm.header.cls, "II");
  assert.strictEqual(hm.header.subject, "HINDI");
  assert.strictEqual(hm.header.marks, 15);
  assert.strictEqual(hm.header.time, "3.00 HRS");
  assert.strictEqual(hm.naming.base, "Hindi_II_HYE_2026-27", "HALF YEAR -> HYE, 2026_2027 -> 2026-27");
  assert.ok(hm.sections[0].implicit, "a paper without section headings gets an implicit section");
  const hq = hm.sections[0].entries.filter((e) => e.kind === "question");
  assert.deepStrictEqual(hq.map((q) => [q.number, q.marks]), [[1, 5], [2, 5], [3, 1], [4, 4]]);
  assert.strictEqual(hm.sections.length, 2, "a centred title followed by Q1 again opens a second part");
  assert.strictEqual(plain(hm.sections[1].title), "व्याकरण:");
  assert.strictEqual(hq[3].items.filter((i) => i.kind === "sub").pop().label, "(ड)", "ड) accepted as a sub-part label");
  const part2 = hm.sections[1].entries.filter((e) => e.kind === "question");
  assert.deepStrictEqual(part2.map((q) => [q.number, q.marks]), [[1, 2]]);
  assert.deepStrictEqual(part2[0].items.find((i) => i.kind === "opts").items.map(plain), ["(iii) माता = ______", "(iv) बकरा = ______"], "a row starting at (iii) is an option row");
  assert.strictEqual(hq[0].items.find((i) => i.kind === "sub").label, "(क)");
  assert.deepStrictEqual(hq[0].items.find((i) => i.kind === "opts").items.map(plain), ["(i) छठी", "(ii) पाँचवी", "(iii) चौथी"]);
  const pairs = hq[3].items.find((i) => i.kind === "pairs");
  assert.ok(pairs && pairs.rows.length === 4 && plain(pairs.rows[0][0]) === "देश" && plain(pairs.rows[0][1]) === "निभाना", "matching pairs kept as columns");
  const hrev = review(hm, { date: new Date("2026-09-18T06:00:00Z") });
  assert.ok(hrev.markdown.includes("Adds up: questions 15 + questions 2 = 17, but the header says 15 marks."), hrev.markdown);
  assert.ok(!hrev.markdown.includes("Duplicate question number"), "numbering restart after a part title is not a duplicate");
  const hres = await formatPaper(hindiPath, { out: path.join(dir, "out2") });
  const hxml = await (await JSZip.loadAsync(fs.readFileSync(hres.docx))).file("word/document.xml").async("string");
  assert.ok(/w:cs="Mangal"/.test(hxml), "Devanagari runs carry a complex-script font");
  assert.ok(!hxml.includes("SECTION "), "no section heading for an implicit section");

  // --- a "Q.1." paper with numbered sub-parts, a numeric answer-key row, Section F and a map question
  const sstDoc = new Document({ sections: [{ children: [
    p("VIDYA VIHAR CONVENT HIGH SCHOOL, CHANDRAPUR", { center: true, bold: true }),
    p("HALF-YEARLY EXAMINATION – 2026-2027", { center: true }),
    p("Class: III\t\tSubject: SST (SOCIAL STUDIES)\t\tMarks: 20"),
    p("Date: 14/10/2026\t\tRoll No.: ______\t\tTime: 2 hours"),
    p("Section A (10 marks)", { center: true, bold: true }),
    p("Q.1. Match the following:\t\t(1 x 5 = 5 m)"),
    p("1)a,b,c,d,e          2)b,c,a,d,e          3)c,d,b,e,a"),
    p("Q.2. Very Short Answer Type Question [Any 5]:\t\t(1×5=5 m)"),
    p("1) Name any two rain fed rivers."),
    p("2) What is a sledge?"),
    p("Section F (10 marks)", { center: true, bold: true }),
    p("Q.3. Read the passage and answer the following questions:\t\t(5 m)"),
    p("1) Which is the largest river island in the world?\t\t2m"),
    p("2) How is this island formed?\t\t3m"),
    p("Q.4. Map-Based Question:\t\t(5 m)"),
    p("On the map of India, mark the following rivers:"),
    p("a) Narmada          b) Tapti          c) Kaveri          d) Ganga          e) Brahmaputra"),
  ] }] });
  const sstPath = path.join(dir, "SST_3_HYE_2026-27.docx");
  fs.writeFileSync(sstPath, await Packer.toBuffer(sstDoc));
  const sm = buildModel(await parseDocx(fs.readFileSync(sstPath)), path.basename(sstPath));
  assert.strictEqual(sm.naming.base, "SocialScience_III_HYE_2026-27");
  assert.deepStrictEqual(sm.sections.map((x) => x.letter), ["A", "F"], "sections beyond E are recognised");
  const sq = sm.sections.flatMap((x) => x.entries.filter((e) => e.kind === "question"));
  assert.deepStrictEqual(sq.map((q) => [q.number, q.marks]), [[1, 5], [2, 5], [3, 5], [4, 5]], "1) lines are sub-parts, not questions");
  assert.deepStrictEqual(sq[0].items.find((i) => i.kind === "opts").items.map(plain), ["1)a,b,c,d,e", "2)b,c,a,d,e", "3)c,d,b,e,a"], "numeric answer-key row");
  assert.deepStrictEqual(sq[1].items.filter((i) => i.kind === "sub").map((i) => i.label), ["(1)", "(2)"]);
  assert.deepStrictEqual(sq[2].items.filter((i) => i.kind === "sub").map((i) => i.marks), [2, 3]);
  assert.deepStrictEqual(sq[3].items.find((i) => i.kind === "opts").items.map(plain).slice(-1), ["e) Brahmaputra"], "five-label rows a)–e)");
  const srev = review(sm, { date: new Date("2026-09-19T06:00:00Z") });
  assert.strictEqual(srev.blocking, false, "a map question without a map is a note, not a blocker (maps are printed separately)");
  assert.ok(srev.markdown.includes("Q4: map question — no map in the file; the outline map is printed separately."), srev.markdown);
  assert.ok(srev.markdown.includes("Adds up: A 10 + F 10 = 20"), srev.markdown);
  assert.ok(!srev.markdown.includes("Duplicate question number"), srev.markdown);

  // --- an English paper: table-of-contents lines, "Q1." with "A. / B." parts and "1. 2." items, options one per
  //     line under a lettered part, two headings for one section, class in the file name != class in the header
  const engDoc = new Document({ sections: [{ children: [
    p("VIDYA VIHAR CONVENT HIGH SCHOOL, CHANDRAPUR", { center: true, bold: true }),
    p("HALF-YEARLY EXAMINATION – 2026-2027", { center: true }),
    p("Class: VII\t\tSubject: English\t\tMarks: 20"),
    p("Date: 01/10/2026\t\tRoll No.: ______\t\tTime: 2 hours"),
    p("Section A: Reading", { center: true }),
    p("Section B: Grammar and Writing", { center: true }),
    p("Section A: Reading (10 marks)", { center: true, bold: true }),
    p("Q1. Read the passage and answer the questions:\t\t(1x5=5 m)"),
    p("A. Where is the tree located?"),
    p("(a) Delhi"), p("(b) Kolkata, near Howrah"), p("(c) Mumbai"), p("(d) Chennai"),
    p("B. Complete the sentences."),
    p("1. The tree is very _____."), p("2. It grows in _____."),
    p("Q2. Do as directed:\t\t(5 m)"),
    p("1. Write the plural of box."), p("2. Write the opposite of hot."),
    p("Section B: I. Grammar (5 marks)", { center: true, bold: true }),
    p("Q3. Fill in the blanks:\t\t(1x5=5 m)"),
    p("1. He ___ a boy."), p("2. They ___ playing."),
    p("Section B. II. Writing (5 marks)", { center: true, bold: true }),
    p("Q4. Write a letter to your friend about your holidays.\t\t(5 m)"),
  ] }] });
  const engPath = path.join(dir, "English_VIII_HYE_2026_27.docx");
  fs.writeFileSync(engPath, await Packer.toBuffer(engDoc));
  const em = buildModel(await parseDocx(fs.readFileSync(engPath)), path.basename(engPath));
  assert.deepStrictEqual(em.sections.map((x) => x.letter), ["A", "B", "B"], "table-of-contents lines dropped; second Section B heading kept as a part");
  assert.strictEqual(em.sections[2].part, true);
  const eq = em.sections.flatMap((x) => x.entries.filter((e) => e.kind === "question"));
  assert.deepStrictEqual(eq.map((q) => [q.number, q.marks]), [[1, 5], [2, 5], [3, 5], [4, 5]], "1. items under Q1. are sub-parts");
  assert.deepStrictEqual(eq[0].items.filter((i) => i.kind === "sub").map((i) => i.label), ["(A)", "(B)", "(1)", "(2)"], "A./B. parts and 1./2. items keep their labels");
  assert.deepStrictEqual(eq[0].items.find((i) => i.kind === "opts").items.map(plain), ["a) Delhi", "b) Kolkata, near Howrah", "c) Mumbai", "d) Chennai"], "options one per line under a lettered part");
  const erev = review(em, { date: new Date("2026-09-20T06:00:00Z") });
  assert.ok(erev.markdown.includes("Adds up: A 10 + B 10 = 20"), erev.markdown);
  assert.ok(!erev.markdown.includes("Duplicate question number"), erev.markdown);
  assert.ok(erev.markdown.includes("File name says Class VIII, the paper's header says Class VII"), erev.markdown);
  assert.ok(!erev.markdown.includes("Subject code missing") && !erev.markdown.includes("General Instructions"), "no subject-code / instructions noise below Class IX: " + erev.markdown);
  assert.strictEqual(erev.blocking, false);

  // --- SST-style quirks: a dashed rule before the heading, a heading without a letter, columns laid out with
  //     runs of spaces, "(   )" tick blanks, a mark at the start of the next question's line, "OR." glued on,
  //     and ten roman sub-parts (the text column must clear the "(viii)" label)
  const qDoc = new Document({ sections: [{ children: [
    p("VIDYA VIHAR CONVENT HIGH SCHOOL, CHANDRAPUR", { center: true, bold: true }),
    p("HALF-YEARLY EXAMINATION – 2026-2027", { center: true }),
    p("Class: VIII\t\tSubject: SO. SCIENCE\t\tMarks: 16"),
    p("Date: 13/10/2026\t\tRoll No.: ______\t\tTime: 3 hours"),
    p("----------------------------------------------------------------   SECTION A- HISTORY (6 MARKS)"),
    p("1. Vitthal Temple is located at______\t\t1M"),
    p("     A) Konark       B) Hampi       C) Delhi        D) Agra"),
    p("2. Match the following:\t\t3M"),
    p("Column A                         Column B"),
    p("a) Plains                           i) Rajasthan"),
    p("b) Thar Desert                 ii) Highest peak in the world"),
    p("c) Mt. Everest                 iii) Alluvial soil"),
    p("3. Put a tick if the sentence is correct:\t\t2M"),
    p("a) India has 28 states. (     )"),
    p("b) Plains are flat. (     )"),
    p("SECTION: GEOGRAPHY\t10M"),
    p("4. What is latitude?\t\t1M"),
    p("2M  5)A. Who was the last emperor of the Nanda Dynasty? OR."),
    p("5)B. What was the impact of iron?\t\t2M"),
    p("6. Define the following:\t\t7M"),
    ...["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"].map((r, i) => p(`${r}) Term ${i + 1}`)),
  ] }] });
  const qPath = path.join(dir, "SST_VIII_HYE_2026-27.docx");
  fs.writeFileSync(qPath, await Packer.toBuffer(qDoc));
  const qm = buildModel(await parseDocx(fs.readFileSync(qPath)), path.basename(qPath));
  assert.deepStrictEqual(qm.sections.map((x) => x.letter), ["A", "B"], "dashed rule stripped before the heading; bare 'SECTION:' gets the next letter");
  assert.ok(qm.sections[0].rest.startsWith("HISTORY") && qm.sections[1].rest.startsWith("GEOGRAPHY"), JSON.stringify(qm.sections.map((x) => x.rest)));
  const qq = qm.sections.flatMap((x) => x.entries.filter((e) => e.kind === "question"));
  assert.deepStrictEqual(qq.map((q) => [q.number, q.marks]), [[1, 1], [2, 3], [3, 2], [4, 1], [5, 2], [5, 2], [6, 7]], "leading '2M' goes to the question that follows when the previous one has its mark");
  const qpairs = qq[1].items.find((i) => i.kind === "pairs");
  assert.ok(qpairs && qpairs.rows.length === 4, "space-aligned match columns kept as two columns: " + JSON.stringify(qq[1].items.map((i) => i.kind)));
  assert.deepStrictEqual(qpairs.rows[1].map(plain), ["(a) Plains", "i) Rajasthan"]);
  const tick = qq[2].items.filter((i) => i.kind === "sub").map((i) => plain(i.runs));
  assert.ok(tick.length === 2 && tick.every((t) => /\(\s+\)$/.test(t) && !t.includes("\t")), "tick blanks stay as spaces: " + JSON.stringify(tick));
  assert.ok(qq[4].items.some((i) => i.kind === "or"), "'OR.' glued to the line becomes an OR line: " + JSON.stringify(qq[4].items.map((i) => i.kind)));
  assert.strictEqual(qq[6].items.filter((i) => i.kind === "sub").length, 10);
  const qrev = review(qm, { date: new Date("2026-09-20T06:00:00Z") });
  assert.ok(qrev.markdown.includes("Adds up: A 6 + B 10 = 16"), qrev.markdown);
  assert.ok(qrev.markdown.includes("Section heading without a letter"), qrev.markdown);
  assert.strictEqual(qrev.blocking, false, qrev.markdown);
  const qres = await formatPaper(qPath, { out: path.join(dir, "out5"), date: new Date("2026-09-20T06:00:00Z") });
  const qxml = await (await JSZip.loadAsync(fs.readFileSync(qres.docx))).file("word/document.xml").async("string");
  assert.ok(qxml.includes('w:pos="900"'), "text column moves right of a wide label such as (viii)");

  // --- Science-style quirks: "(20 * 1=20)" written count-first, "Q .1." with a space, a question glued to a
  //     section heading, the first sub-part glued after the marks expression, and match-table leftovers "4) …"
  const scDoc = new Document({ sections: [{ children: [
    p("VIDYA VIHAR CONVENT HIGH SCHOOL, CHANDRAPUR", { center: true, bold: true }),
    p("HALF-YEARLY EXAMINATION – 2026-2027", { center: true }),
    p("Class: VII\t\tSubject: Science\t\tMarks: 20"),
    p("Date: 6/10/2026\t\tRoll No.: ______\t\tTime: 3 hours"),
    p("Section A (3 marks) (3 * 1=3)"),
    p("21. Which gas do plants absorb?"),
    p("a) Oxygen    b) Carbon dioxide    c) Nitrogen    d) Helium"),
    p("22. What is respiration?"),
    p("23. Match the following –"),
    p("a) The number of atoms in a molecule\t1) valency"),
    p("b) The flow of electricity\t2) atomicity"),
    p("3) electric current"),
    p("4) electric circuit"),
    p("Section B (7 marks) Q. 24. Answer in brief. (any 1) (7x1=7m)"),
    p("1) Explain the water cycle."),
    p("2) Explain the carbon cycle."),
    p("Section C (10 marks)"),
    p("Q .25. Choose the correct answer. (1x2=2m) 1) A lion lives in a ________."),
    p("a) den    b) burrow    c) hole    d) kennel"),
    p("2) The food factory of a plant is the ________."),
    p("a) fruit    b) flower    c) leaf    d) root"),
    p("Q .26. Fill in the blanks. (1x8=8m)"),
    p("1) Fish breathe through their ______."),
  ] }] });
  const scPath = path.join(dir, "SCIENCE_VII_HYE_2026-27.docx");
  fs.writeFileSync(scPath, await Packer.toBuffer(scDoc));
  const scm = buildModel(await parseDocx(fs.readFileSync(scPath)), path.basename(scPath));
  assert.deepStrictEqual(scm.sections.map((x) => x.letter), ["A", "B", "C"]);
  assert.strictEqual(scm.sections[1].rest, "(7 marks)", "the question glued to the Section B heading is split off");
  const scq = scm.sections.flatMap((x) => x.entries.filter((e) => e.kind === "question"));
  assert.deepStrictEqual(scq.map((q) => q.number), [21, 22, 23, 24, 25, 26], "3)/4) rows of the match table are not questions; Q .25. is a question");
  assert.deepStrictEqual(scq.map((q) => q.marks), [1, 1, 1, 7, 2, 8], "3 * 1 read as three questions of one mark; any-1 of 7; per-part products");
  assert.strictEqual(scm.sections[0].marksExpr.per, 1, "count-first expression is re-oriented");
  assert.deepStrictEqual(scq[4].items.filter((i) => i.kind === "sub").map((i) => i.label), ["(1)", "(2)"], "sub-part glued after the marks product becomes its own line");
  const screv = review(scm, { date: new Date("2026-09-21T06:00:00Z") });
  assert.ok(screv.markdown.includes("Adds up: A 3 + B 7 + C 10 = 20"), screv.markdown);
  assert.strictEqual(screv.blocking, false, screv.markdown);

  // --- CBSE IT-style section: "Answer any 3 out of the given 5 questions … (3x2=6 m)" groups give the questions
  //     that follow their marks and count their stated total; a trailing empty single-column table row is dropped
  const itDoc = new Document({ sections: [{ children: [
    p("VIDYA VIHAR CONVENT HIGH SCHOOL, CHANDRAPUR", { center: true, bold: true }),
    p("HALF-YEARLY EXAMINATION – 2026-2027", { center: true }),
    p("Class: IX\t\tSubject: Information Technology (402)\t\tMarks: 14"),
    p("Date: 15/10/2026\t\tRoll No.: ______\t\tTime: 2 hours"),
    p("Section B (Objective Type Questions) (14 marks)"),
    p("Answer any 3 out of the given 5 questions on Employability Skills. (3x2=6 m)"),
    p("Q6. What is the purpose of asking questions?"), p("Q7. List three practices for hygiene."), p("Q8. What is a hyperlink?"),
    p("Q9. What is a database?"), p("Q10. What benefits do businesses gain from IT?"),
    p("Answer any 2 out of the given 3 questions in 50 – 80 words each. (2x4=8m)"),
    p("Q11. Discuss personal hygiene and social interactions."), p("Q12. Explain formal and informal greetings."), p("Q13. Describe typing ergonomics."),
    new Table({ rows: [
      new TableRow({ children: [new TableCell({ children: [p("Q14. Write a program that prints the hypotenuse.")] })] }),
      new TableRow({ children: [new TableCell({ children: [p("")] })] }),
    ] }),
  ] }] });
  const itPath = path.join(dir, "IT_IX_HYE_2026-27.docx");
  fs.writeFileSync(itPath, await Packer.toBuffer(itDoc));
  const itm = buildModel(await parseDocx(fs.readFileSync(itPath)), path.basename(itPath));
  const itq = itm.sections[0].entries.filter((e) => e.kind === "question");
  assert.deepStrictEqual(itq.map((q) => [q.number, q.marks]), [[6, 2], [7, 2], [8, 2], [9, 2], [10, 2], [11, 4], [12, 4], [13, 4]], "each group's per-question mark reaches the questions under it");
  assert.strictEqual(itm.sections[0].entries.filter((e) => e.kind === "note" && e.group).length, 2, "both instruction lines stay as grouped notes");
  const itrev = review(itm, { date: new Date("2026-09-22T06:00:00Z") });
  assert.ok(itrev.markdown.includes("Adds up: B 14 = 14") || itrev.markdown.includes("Questions total 14"), itrev.markdown);
  assert.strictEqual(itrev.blocking, false, itrev.markdown);
  assert.strictEqual(itm.stats.emptyTablesDropped, 1, "trailing empty row of the single-column table dropped");
  const lastTable = itm.sections[0].entries.flatMap((e) => e.items).find((i) => i.kind === "table");
  assert.ok(lastTable && lastTable.table.rows.length === 1, "the Q14 row is kept");

  // --- subject spellings teachers use
  assert.deepStrictEqual(["SST (SOCIAL STUDIES)", "S.O. Science", "SO.SCIENCE", "Social Science", "Maths", "ENGLISH"].map(subjectSlug),
    ["SocialScience", "SocialScience", "SocialScience", "SocialScience", "Maths", "English"]);

  // --- garbled Devanagari (a PDF converted back to Word) is detected; real Hindi is not
  const real = garbledDevanagari("देबू कौन सी कक्षा में पढ़ता था ? नैना की दादी के न आने का क्या कारण था ?");
  assert.ok(real.marks > 10 && real.ratio < 0.1, JSON.stringify(real));
  const junk = garbledDevanagari(". 1 : ि ि िO 9 ` ह 7 प ह ा ि ा ाह5 - क) द` कौ ी क ा ा Vा ? (i) ा ी Vी (ii) ी - ी क ी Vी");
  assert.ok(junk.marks > 10 && junk.ratio > 0.5, JSON.stringify(junk));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("ok: formatter round-trip test passed");
})().catch((e) => { console.error(e); process.exit(1); });
