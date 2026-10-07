import path from "node:path";
import { inflateRawSync } from "node:zlib";
import sax from "sax";
import XLSX from "xlsx";
import {
  previewKind,
  PREVIEW_LIMITS,
  PreviewError,
} from "../shared/file-preview.mjs";

export { previewKind, PREVIEW_LIMITS, PreviewError };
const extension = (name) => path.extname(String(name || "")).toLowerCase();
const invalidArchive = () =>
  new PreviewError(
    "This file is damaged or is not a readable Office archive. Download the original to open it.",
  );

// Validate central AND local sizes before inflating, then cap actual output.
// ZIP64, encryption and exotic compression get a download fallback. No paths
// are written to disk, and document relationships never cause network reads.
function readZip(buffer, keep = () => false) {
  let end = -1;
  for (
    let i = buffer.length - 22;
    i >= Math.max(0, buffer.length - 65557);
    i--
  ) {
    if (
      buffer.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + buffer.readUInt16LE(i + 20) === buffer.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0 || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6))
    throw invalidArchive();
  const count = buffer.readUInt16LE(end + 10);
  const directory = buffer.readUInt32LE(end + 16);
  const directorySize = buffer.readUInt32LE(end + 12);
  if (
    count !== buffer.readUInt16LE(end + 8) ||
    directory + directorySize !== end
  )
    throw invalidArchive();
  if (count > PREVIEW_LIMITS.entries)
    throw new PreviewError(
      "This file has too many parts to preview. Download it to open it.",
      413,
    );
  let at = directory,
    total = 0;
  const entries = [],
    names = new Set();
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || buffer.readUInt32LE(at) !== 0x02014b50)
      throw invalidArchive();
    const flags = buffer.readUInt16LE(at + 8),
      method = buffer.readUInt16LE(at + 10);
    const compressed = buffer.readUInt32LE(at + 20),
      size = buffer.readUInt32LE(at + 24);
    const nameSize = buffer.readUInt16LE(at + 28),
      extra = buffer.readUInt16LE(at + 30),
      comment = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    if (flags & 1)
      throw new PreviewError(
        "This file is password-protected. Download it to open it.",
      );
    if (
      size === 0xffffffff ||
      compressed === 0xffffffff ||
      local === 0xffffffff ||
      buffer.readUInt16LE(at + 34)
    )
      throw invalidArchive();
    if (
      ![0, 8].includes(method) ||
      at + 46 + nameSize + extra + comment > end ||
      local + 30 > directory
    )
      throw invalidArchive();
    const name = buffer.subarray(at + 46, at + 46 + nameSize).toString("utf8");
    if (!name || names.has(name)) throw invalidArchive();
    names.add(name);
    total += size;
    if (total > PREVIEW_LIMITS.archiveBytes)
      throw new PreviewError(
        "This file expands beyond the preview limit. Download it to open it.",
        413,
      );
    if (
      buffer.readUInt32LE(local) !== 0x04034b50 ||
      buffer.readUInt16LE(local + 8) !== method ||
      buffer.readUInt16LE(local + 6) !== flags
    )
      throw invalidArchive();
    const localNameSize = buffer.readUInt16LE(local + 26),
      localExtra = buffer.readUInt16LE(local + 28);
    const start = local + 30 + localNameSize + localExtra;
    if (
      start + compressed > directory ||
      buffer
        .subarray(local + 30, local + 30 + localNameSize)
        .toString("utf8") !== name
    )
      throw invalidArchive();
    if (
      !(flags & 8) &&
      (buffer.readUInt32LE(local + 18) !== compressed ||
        buffer.readUInt32LE(local + 22) !== size)
    )
      throw invalidArchive();
    entries.push({ name, method, start, compressed, size });
    at += 46 + nameSize + extra + comment;
  }
  if (at !== end) throw invalidArchive();
  const files = new Map();
  for (const entry of entries) {
    const compressed = buffer.subarray(
      entry.start,
      entry.start + entry.compressed,
    );
    let bytes;
    try {
      bytes =
        entry.method === 0
          ? compressed
          : inflateRawSync(compressed, {
              maxOutputLength: Math.max(1, entry.size),
            });
    } catch {
      throw invalidArchive();
    }
    if (bytes.length !== entry.size) throw invalidArchive();
    if (keep(entry.name)) files.set(entry.name, bytes.toString("utf8"));
  }
  return { files, names };
}

function parseText(buffer) {
  let encoding = "utf-8",
    start = 0;
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    encoding = "utf-16le";
    start = 2;
  } else if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    encoding = "utf-16be";
    start = 2;
  } else if (buffer.includes(0))
    throw new PreviewError(
      "This file contains binary data. Download it to open it.",
    );
  let text;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(
      buffer.subarray(start),
    );
  } catch {
    throw new PreviewError(
      "This text encoding cannot be previewed. Save it as UTF-8 or download the original.",
    );
  }
  return {
    kind: "text",
    text: text.slice(0, PREVIEW_LIMITS.text),
    truncated: text.length > PREVIEW_LIMITS.text,
  };
}

function parseSpreadsheet(buffer, item) {
  const zip = buffer.subarray(0, 2).toString() === "PK";
  if (zip) {
    const { names } = readZip(buffer);
    const workbook =
      names.has("xl/workbook.xml") ||
      names.has("content.xml") ||
      [...names].some(
        (name) => name.startsWith("Index/") && name.endsWith(".iwa"),
      );
    if (!workbook)
      throw new PreviewError(
        "This archive does not contain a supported spreadsheet.",
      );
  } else {
    const ole = buffer
      .subarray(0, 8)
      .equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    const biff =
      buffer.length > 4 && buffer[0] === 9 && [0, 2, 4, 8].includes(buffer[1]);
    if (extension(item.name) !== ".xls" || !(ole || biff))
      throw new PreviewError(
        "This spreadsheet is damaged, password-protected, or uses an unsupported format. Download it to open it.",
      );
  }
  let book;
  try {
    book = XLSX.read(buffer, {
      type: "buffer",
      dense: false,
      cellText: true,
      cellFormula: true,
      cellHTML: false,
      cellNF: false,
      cellStyles: false,
      bookVBA: false,
      bookDeps: false,
      raw: true,
      sheetRows: PREVIEW_LIMITS.rows + 1,
      sheets: Array.from({ length: PREVIEW_LIMITS.sheets }, (_, i) => i),
    });
  } catch {
    throw new PreviewError(
      "This spreadsheet could not be read. It may be damaged or password-protected. Download it to open it.",
    );
  }
  const names = book.SheetNames || [];
  if (!names.length)
    throw new PreviewError("This file contains no readable worksheets.");
  const sheets = [];
  let cells = 0,
    characters = 0,
    missingFormulaResults = false;
  let truncated = names.length > PREVIEW_LIMITS.sheets;
  for (const name of names.slice(0, PREVIEW_LIMITS.sheets)) {
    const sheet = book.Sheets[name];
    if (!sheet?.["!ref"]) {
      sheets.push({ name, rows: [], truncated: false });
      continue;
    }
    const range = XLSX.utils.decode_range(sheet["!fullref"] || sheet["!ref"]);
    let limited =
      range.e.r >= PREVIEW_LIMITS.rows || range.e.c >= PREVIEW_LIMITS.columns;
    const rows = [];
    outer: for (
      let r = 0;
      r <= Math.min(range.e.r, PREVIEW_LIMITS.rows - 1);
      r++
    ) {
      const row = [];
      for (
        let c = 0;
        c <= Math.min(range.e.c, PREVIEW_LIMITS.columns - 1);
        c++
      ) {
        if (
          cells >= PREVIEW_LIMITS.cells ||
          characters >= PREVIEW_LIMITS.text
        ) {
          limited = true;
          if (row.length) rows.push(row);
          break outer;
        }
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        let value = String(cell?.w ?? cell?.v ?? "");
        if (cell?.f && cell.v == null) {
          value = "=" + cell.f;
          missingFormulaResults = true;
        }
        const max = Math.min(
          PREVIEW_LIMITS.cellText,
          PREVIEW_LIMITS.text - characters,
        );
        if (value.length > max) {
          value = value.slice(0, max);
          limited = true;
        }
        characters += value.length;
        cells++;
        row.push(value);
      }
      rows.push(row);
    }
    sheets.push({ name, rows, truncated: limited });
    truncated ||= limited;
  }
  return {
    kind: "spreadsheet",
    sheets,
    truncated,
    ...(missingFormulaResults
      ? {
          notice:
            "Some formulas have no saved result and are shown as text. Download and open the workbook to calculate them.",
        }
      : {}),
  };
}

function parseXml(source, handlers) {
  const parser = sax.parser(true, { xmlns: true });
  parser.ondoctype = () => {
    throw new PreviewError(
      "This document uses an unsupported XML declaration. Download it to open it.",
    );
  };
  for (const [name, handler] of Object.entries(handlers))
    parser[name] = handler;
  try {
    parser.write(source).close();
  } catch (error) {
    if (error instanceof PreviewError) throw error;
    throw new PreviewError(
      "This document contains damaged XML. Download it to open it.",
    );
  }
}
function textCollector(limit) {
  let text = "",
    truncated = false;
  return {
    append(value) {
      const remaining = Math.max(0, limit - text.length);
      if (value.length > remaining) truncated = true;
      text += value.slice(0, remaining);
    },
    result() {
      return { text: text.replace(/\n+$/, ""), truncated };
    },
  };
}
function documentText(source, format, limit) {
  const collector = textCollector(limit),
    stack = [];
  let paragraphs = 0,
    textNodes = 0,
    started = false;
  const word = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const wordStrict = "http://purl.oclc.org/ooxml/wordprocessingml/main";
  const draw = "http://schemas.openxmlformats.org/drawingml/2006/main";
  const drawStrict = "http://purl.oclc.org/ooxml/drawingml/main";
  const odt = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";
  const valid = (tag) =>
    format === ".odt"
      ? tag.uri === odt
      : format === ".docx"
        ? [word, wordStrict].includes(tag.uri)
        : [draw, drawStrict].includes(tag.uri);
  parseXml(source, {
    onopentag(tag) {
      const local = tag.local;
      const block =
        valid(tag) && (local === "p" || (format === ".odt" && local === "h"));
      const textNode = valid(tag) && local === "t";
      stack.push({ block, textNode });
      if (block) {
        if (!paragraphs && started) collector.append("\n\n");
        started = true;
        paragraphs++;
      }
      if (textNode) textNodes++;
      if (paragraphs && valid(tag)) {
        if (local === "tab") collector.append("\t");
        if (["br", "cr", "line-break"].includes(local)) collector.append("\n");
        if (format === ".odt" && local === "s") {
          const count = Number(
            Object.values(tag.attributes).find((a) => a.local === "c")?.value ||
              1,
          );
          if (Number.isFinite(count) && count > 0)
            collector.append(" ".repeat(Math.min(count, limit + 1)));
        }
      }
    },
    ontext(value) {
      if (paragraphs && (format === ".odt" || textNodes))
        collector.append(value);
    },
    oncdata(value) {
      if (paragraphs && (format === ".odt" || textNodes))
        collector.append(value);
    },
    onclosetag() {
      const tag = stack.pop();
      if (tag?.textNode) textNodes--;
      if (tag?.block) paragraphs--;
    },
  });
  return collector.result();
}
function attr(tag, local) {
  return Object.values(tag.attributes).find(
    (attribute) => attribute.local === local,
  )?.value;
}
function slideOrder(files) {
  const manifest = files.get("ppt/presentation.xml"),
    rels = files.get("ppt/_rels/presentation.xml.rels");
  if (!manifest || !rels)
    return [...files.keys()]
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort(
        (a, b) =>
          Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]),
      );
  const targets = new Map(),
    order = [];
  parseXml(rels, {
    onopentag(tag) {
      if (
        tag.local !== "Relationship" ||
        attr(tag, "TargetMode") === "External"
      )
        return;
      const target = attr(tag, "Target") || "";
      targets.set(
        attr(tag, "Id"),
        path.posix.normalize(
          target.startsWith("/") ? target.slice(1) : "ppt/" + target,
        ),
      );
    },
  });
  parseXml(manifest, {
    onopentag(tag) {
      if (tag.local !== "sldId") return;
      const id = Object.values(tag.attributes).find(
        (attribute) => attribute.local === "id" && attribute.prefix,
      )?.value;
      const target = targets.get(id);
      if (!target || !target.startsWith("ppt/slides/") || !files.has(target))
        throw new PreviewError(
          "A slide in this presentation is unavailable. Download the original to open it.",
        );
      order.push(target);
    },
  });
  return order;
}
function parseDocument(buffer, item) {
  const { files } = readZip(buffer, (name) => /\.(xml|rels)$/.test(name));
  const format = extension(item.name);
  if (format !== ".pptx") {
    const source = files.get(
      format === ".docx" ? "word/document.xml" : "content.xml",
    );
    if (!source)
      throw new PreviewError(
        "This document has no readable body. Download it to open it.",
      );
    const result = documentText(source, format, PREVIEW_LIMITS.text);
    return {
      kind: "document",
      sections: [{ text: result.text }],
      truncated: result.truncated,
    };
  }
  const names = slideOrder(files),
    sections = [];
  if (!names.length)
    throw new PreviewError(
      "This presentation has no readable slides. Download it to open it.",
    );
  let remaining = PREVIEW_LIMITS.text,
    truncated = names.length > PREVIEW_LIMITS.sheets;
  for (const [index, name] of names.slice(0, PREVIEW_LIMITS.sheets).entries()) {
    const result = documentText(
      files.get(name),
      format,
      Math.min(PREVIEW_LIMITS.sectionText, remaining),
    );
    sections.push({ title: `Slide ${index + 1}`, text: result.text });
    remaining -= result.text.length;
    truncated ||= result.truncated;
  }
  return { kind: "document", sections, truncated };
}
export function parsePreview(buffer, item) {
  if (buffer.length > PREVIEW_LIMITS.bytes)
    throw new PreviewError(
      "This file is too large to preview. Download it to open it.",
      413,
    );
  const kind = previewKind(item);
  if (!kind)
    throw new PreviewError(
      "This file type does not support preview. Download it to open it.",
      415,
    );
  if (kind === "text" || [".csv", ".tsv"].includes(extension(item.name)))
    return parseText(buffer);
  return kind === "spreadsheet"
    ? parseSpreadsheet(buffer, item)
    : parseDocument(buffer, item);
}
export function previewFailure(error) {
  return error instanceof PreviewError
    ? error
    : new PreviewError(
        "This file could not be previewed. It may be damaged or password-protected. Download it to open it.",
      );
}
