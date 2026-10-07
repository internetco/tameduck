import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { readForAI } from "../server/file-reader.mjs";
import { readForAIIsolated } from "../server/file-reader-runner.mjs";

// Minimal ZIP writer for Office fixtures; every second entry is deflated.
function zip(entries) {
  const parts = [],
    central = [];
  let offset = 0,
    index = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text),
      deflate = index++ % 2 === 1,
      data = deflate ? zlib.deflateRawSync(raw) : raw,
      n = Buffer.from(name),
      local = Buffer.alloc(30),
      head = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(deflate ? 8 : 0, 10);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(n.length, 28);
    head.writeUInt32LE(offset, 42);
    parts.push(local, n, data);
    central.push(head, n);
    offset += 30 + n.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
const workbook = (sheet, extra = {}) =>
  zip({
    "xl/workbook.xml":
      '<workbook><sheets><sheet name="Q&amp;A" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      '<Relationships><Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": sheet,
    ...extra,
  });
const read = (format, buffer) =>
  readForAI({ name: "file." + format }, buffer, format);

test("Word, Excel and PowerPoint files read as text", () => {
  const word = read(
    "docx",
    zip({
      "word/document.xml":
        '<w:document><w:body><w:p><w:r><w:t>Launch &amp; grow</w:t><w:tab/><w:t xml:space="preserve">now </w:t></w:r></w:p><w:p><w:r><w:t>Line</w:t><w:br w:type="page"/><w:t>break</w:t></w:r></w:p></w:body></w:document>',
    }),
  );
  assert.equal(word.text, "Launch & grow\tnow\nLine\nbreak");
  const sheet = read(
    "xlsx",
    workbook(
      '<worksheet><cols><col min="1" max="3"/></cols><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" s="2"/><c r="C1" t="inlineStr"><is><r><t>in</t></r><r><t>line</t></r></is></c></row><row r="3"><c r="A3" t="b"><v>1</v></c><c r="C3"><f>SUM(A1:A2)</f><v>42</v></c></row></sheetData><rowBreaks count="1"><brk id="2"/></rowBreaks></worksheet>',
      {
        "xl/sharedStrings.xml":
          "<sst><si><r><rPr><b/></rPr><t>Ducks,</t></r><r><t> large</t></r></si></sst>",
      },
    ),
  );
  assert.equal(sheet.text, '## Sheet: Q&A\n"Ducks, large",,inline\nTRUE,,42');
  const slides = read(
    "pptx",
    zip({
      "ppt/slides/slide10.xml":
        "<p:sld><a:p><a:r><a:t>Last</a:t></a:r></a:p></p:sld>",
      "ppt/slides/slide2.xml":
        "<p:sld><a:p><a:r><a:t>First</a:t></a:r></a:p><a:p><a:r><a:t>point</a:t></a:r></a:p></p:sld>",
    }),
  );
  assert.equal(slides.text, "## Slide 2\nFirst\npoint\n\n## Slide 10\nLast");
});

// Each of these once made a backtracking pattern take time quadratic in the
// file: a few kilobytes compressed held the server for hours. Two million
// characters took about half an hour; linear, it is milliseconds.
test("crafted Office files are read in time linear in their size", () => {
  const big = (unit) => unit.repeat(Math.ceil(2e6 / unit.length));
  const cases = {
    "unclosed tags": ["docx", zip({ "word/document.xml": big("<") })],
    "spaces that never end a line": [
      "docx",
      zip({ "word/document.xml": "<w:t>" + big(" ") + "x</w:t>" }),
    ],
    "unclosed breaks": ["docx", zip({ "word/document.xml": big("<w:br") })],
    "unclosed shared strings": [
      "xlsx",
      workbook("<sheetData/>", { "xl/sharedStrings.xml": big("<si>") }),
    ],
    "unclosed relationships": [
      "xlsx",
      zip({
        "xl/_rels/workbook.xml.rels": big("<Relationship "),
        "xl/worksheets/sheet1.xml": "<sheetData/>",
      }),
    ],
    "unclosed sheets": [
      "xlsx",
      zip({
        "xl/workbook.xml": big("<sheet "),
        "xl/worksheets/sheet1.xml": "<sheetData/>",
      }),
    ],
    "unclosed rows": ["xlsx", workbook(big("<row>"))],
    "unclosed cells": ["xlsx", workbook("<row>" + big("<c>") + "</row>")],
    "unclosed values": [
      "xlsx",
      workbook('<row><c r="A1">' + big("<v>") + "</c></row>"),
    ],
    "unclosed inline strings": [
      "xlsx",
      workbook('<row><c r="A1" t="inlineStr">' + big("<is>") + "</c></row>"),
    ],
    "unclosed slide tags": [
      "pptx",
      zip({ "ppt/slides/slide1.xml": big("<") }),
    ],
  };
  for (const [name, [format, buffer]] of Object.entries(cases)) {
    const started = Date.now();
    const result = read(format, buffer);
    const took = Date.now() - started;
    assert.ok(result.text !== undefined || result.error, name);
    assert.ok(took < 3000, `${name} took ${took} ms`);
  }
});

test("a duck's read runs in a worker that gives up in time", async () => {
  const buffer = zip({
    "word/document.xml":
      "<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>",
  });
  const upload = { name: "brief.docx" };
  assert.deepEqual(
    await readForAIIsolated(upload, buffer, "docx"),
    readForAI(upload, buffer, "docx"),
  );
  const late = await readForAIIsolated(upload, buffer, "docx", 0, {
    timeout: 1,
  });
  assert.match(late.error, /^brief\.docx took too long to read\./);
  // More reads than run at once wait their turn, and all of them finish.
  const all = await Promise.all(
    Array.from({ length: 6 }, () => readForAIIsolated(upload, buffer, "docx")),
  );
  assert.deepEqual(
    all.map((r) => r.text),
    Array(6).fill("Hello"),
  );
  const broken = await readForAIIsolated(
    upload,
    Buffer.from("not a zip"),
    "docx",
  );
  assert.match(broken.error, /^brief\.docx couldn't be opened\./);
});
