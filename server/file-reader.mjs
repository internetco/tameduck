import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

// Groups drive the Files filter and the icon shown in chat.
const groups = {
  image: [
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "heic",
    "heif",
    "bmp",
    "tif",
    "tiff",
    "avif",
    "ico",
  ],
  pdf: ["pdf"],
  spreadsheet: ["csv", "tsv", "xlsx", "xlsm", "xls", "ods", "numbers"],
  presentation: ["pptx", "ppt", "odp", "key"],
  doc: ["docx", "doc", "odt", "rtf", "pages"],
  text: [
    "txt",
    "md",
    "markdown",
    "json",
    "jsonl",
    "xml",
    "yaml",
    "yml",
    "toml",
    "ini",
    "log",
    "html",
    "htm",
    "css",
    "js",
    "mjs",
    "cjs",
    "ts",
    "tsx",
    "jsx",
    "py",
    "rb",
    "go",
    "rs",
    "java",
    "kt",
    "swift",
    "c",
    "h",
    "cc",
    "cpp",
    "hpp",
    "cs",
    "php",
    "sh",
    "sql",
    "svg",
    "srt",
    "vtt",
    "ics",
    "vcf",
    "tex",
  ],
  media: [
    "mp3",
    "wav",
    "m4a",
    "aac",
    "ogg",
    "flac",
    "mp4",
    "mov",
    "webm",
    "mkv",
    "avi",
  ],
  archive: ["zip", "gz", "tgz", "tar", "rar", "7z", "bz2"],
};
const mimes = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  avif: "image/avif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  md: "text/markdown",
  markdown: "text/markdown",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  zip: "application/zip",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
};
export const MAX_UPLOAD_BYTES = 25 * 1000 * 1000;
export const extension = (name) =>
  (/\.([a-z0-9]{1,10})$/i.exec(name || "")?.[1] || "").toLowerCase();
export function groupFor(name) {
  const ext = extension(name);
  return Object.keys(groups).find((g) => groups[g].includes(ext)) || "other";
}
// Types come from the bytes, never from the browser. Only magic-verified images and
// PDFs may be displayed inline; every other type is downloaded.
export function sniff(name, head) {
  const ext = extension(name);
  const starts = (...bytes) => bytes.every((b, i) => head[i] === b);
  const ascii = (offset, text) =>
    head.subarray(offset, offset + text.length).toString("latin1") === text;
  let mime = null;
  if (starts(0x89, 0x50, 0x4e, 0x47)) mime = "image/png";
  else if (starts(0xff, 0xd8, 0xff)) mime = "image/jpeg";
  else if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) mime = "image/gif";
  else if (ascii(0, "RIFF") && ascii(8, "WEBP")) mime = "image/webp";
  else if (ascii(0, "%PDF-")) mime = "application/pdf";
  const inline = !!mime;
  if (!mime && starts(0x50, 0x4b, 0x03, 0x04))
    mime = ["docx", "xlsx", "xlsm", "pptx"].includes(ext)
      ? mimes[ext === "xlsm" ? "xlsx" : ext]
      : "application/zip";
  const text = !head.includes(0) && !mime;
  if (!mime) {
    mime = mimes[ext] || (text ? "text/plain" : "application/octet-stream");
    // A misleading extension must not make bytes look like an image, PDF or text.
    if (
      mime === "application/pdf" ||
      visionTypes.includes(mime) ||
      (!text && /^text\/|json|xml/.test(mime))
    )
      mime = "application/octet-stream";
  }
  let group = groupFor(name);
  if (inline && mime.startsWith("image/")) group = "image";
  if (mime === "application/pdf") group = "pdf";
  if (group === "other" && text) group = "text";
  return { mime, group, inline, text };
}

const pdfBinary = ["/usr/bin/pdftotext", "/usr/local/bin/pdftotext"].find((p) =>
  fs.existsSync(p),
);
const visionTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"];
// Describe, without reading content, whether a duck on this model can read a file.
export function aiAccess(upload, { vision = null, pdf = !!pdfBinary } = {}) {
  const ext = extension(upload.name);
  const label = ext ? "." + ext : "this type of";
  const previewUnavailable = (detail) => ({
    readable: false,
    reason:
      "This file cannot be previewed directly. " +
      detail +
      " The computer can still process the original file when computer access is enabled.",
  });
  if (upload.group === "image") {
    if (!visionTypes.includes(upload.mime))
      return previewUnavailable(
        "Direct AI image preview supports PNG, JPEG, GIF and WebP.",
      );
    if (vision === false)
      return previewUnavailable(
        "The AI model this duck is using does not support direct image preview.",
      );
    return { readable: true, format: "image" };
  }
  if (upload.mime === "application/pdf")
    return pdf
      ? { readable: true, format: "pdf" }
      : previewUnavailable(
          "Direct PDF reading is not available on this server.",
        );
  if (
    ["docx", "xlsx", "xlsm", "pptx"].includes(ext) &&
    upload.mime !== "application/zip"
  )
    return { readable: true, format: ext === "xlsm" ? "xlsx" : ext };
  if (["doc", "xls", "ppt"].includes(ext))
    return previewUnavailable(
      "Direct AI preview does not support older " + label + " files.",
    );
  if (
    upload.mime.startsWith("text/") ||
    ["application/json", "application/xml", "image/svg+xml"].includes(
      upload.mime,
    )
  )
    return { readable: true, format: "text" };
  // A .txt or .csv saved in UTF-16 - which is what a spreadsheet exports on
  // Windows if you pick the wrong option - has null bytes in it, so it is not
  // treated as text. Answering "share it as text or CSV" about a CSV tells
  // somebody nothing; the problem is how it was saved.
  if (/^text\/|json|xml/.test(mimes[ext] || ""))
    return previewUnavailable(upload.name + " is not saved as UTF-8 text.");
  return previewUnavailable(
    "Direct AI preview does not support " + label + " files.",
  );
}

// Minimal ZIP reader for Office files. Output is capped to stop decompression bombs.
function unzip(buffer, wanted, limit = 20000000) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--)
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new Error("Not a readable archive");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const files = new Map();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("Damaged archive");
    const method = buffer.readUInt16LE(offset + 10),
      compressed = buffer.readUInt32LE(offset + 20),
      nameLength = buffer.readUInt16LE(offset + 28),
      extra = buffer.readUInt16LE(offset + 30),
      comment = buffer.readUInt16LE(offset + 32),
      local = buffer.readUInt32LE(offset + 42),
      name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extra + comment;
    if (!wanted(name)) continue;
    if (buffer.readUInt32LE(local) !== 0x04034b50)
      throw new Error("Damaged archive");
    const start =
      local +
      30 +
      buffer.readUInt16LE(local + 26) +
      buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + compressed);
    const content =
      method === 0
        ? data
        : method === 8
          ? zlib.inflateRawSync(data, { maxOutputLength: limit - total })
          : null;
    if (!content) throw new Error("Unsupported compression");
    total += content.length;
    files.set(name, content.toString("utf8"));
  }
  return files;
}
const entities = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
// Every pattern below runs in time linear in the file. A file is somebody's
// input, and a backtracking pattern ran for days on 20 MB of "<" crafted to
// stall the whole server. XML allows no "<" inside a tag, so stopping a tag
// there changes nothing for a real document, and a whitespace run is only
// tried from its first character.
const plain = (xml) =>
  entities(xml.replace(/<[^<>]+>/g, ""))
    .replace(/(?<![ \t])[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
// Each body between open and close, e.g. <si>...</si>, in one forward pass. The
// lazy pattern it replaces read the rest of the file again from every opening
// that is never closed; here a missing close ends the search.
function* between(xml, open, close) {
  for (let at = xml.indexOf(open); at >= 0; ) {
    const end = xml.indexOf(close, at + open.length);
    if (end < 0) return;
    yield xml.slice(at + open.length, end);
    at = xml.indexOf(open, end + close.length);
  }
}
const first = (xml, open, close) => between(xml, open, close).next().value;
// Each <tag attributes>body</tag> as [attributes, body], in one forward pass.
// With selfClosing, <tag attributes/> counts too, with an empty body.
function* elements(xml, tag, selfClosing = false) {
  const opening = new RegExp(`<${tag}\\b([^<>]*)>`, "y"),
    start = "<" + tag,
    close = `</${tag}>`;
  for (let at = xml.indexOf(start); at >= 0; ) {
    opening.lastIndex = at;
    const m = opening.exec(xml);
    if (!m) {
      at = xml.indexOf(start, at + 1);
      continue;
    }
    if (selfClosing && m[1].endsWith("/")) {
      yield [m[1].slice(0, -1), ""];
      at = xml.indexOf(start, opening.lastIndex);
      continue;
    }
    const end = xml.indexOf(close, opening.lastIndex);
    if (end < 0) return;
    yield [m[1], xml.slice(opening.lastIndex, end)];
    at = xml.indexOf(start, end + close.length);
  }
}
const numbered = (files, pattern) =>
  [...files.keys()]
    .map((name) => [name, Number(pattern.exec(name)?.[1])])
    .filter(([, n]) => n)
    .sort((a, b) => a[1] - b[1]);
function docx(buffer) {
  const files = unzip(buffer, (n) => n === "word/document.xml");
  const xml = files.get("word/document.xml");
  if (!xml) throw new Error("Missing document body");
  return plain(
    xml
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<w:br[^<>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n"),
  );
}
function pptx(buffer) {
  const files = unzip(buffer, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  return numbered(files, /slide(\d+)\.xml$/)
    .map(
      ([name, n]) =>
        `## Slide ${n}\n` + plain(files.get(name).replace(/<\/a:p>/g, "\n")),
    )
    .join("\n\n");
}
const column = (ref) =>
  [...(/^[A-Z]+/.exec(ref || "")?.[0] || "A")].reduce(
    (n, c) => n * 26 + c.charCodeAt(0) - 64,
    0,
  ) - 1;
const csvCell = (v) =>
  /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
function xlsx(buffer) {
  const files = unzip(
    buffer,
    (n) =>
      n === "xl/sharedStrings.xml" ||
      n === "xl/workbook.xml" ||
      n === "xl/_rels/workbook.xml.rels" ||
      /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
  );
  const shared = [
    ...between(files.get("xl/sharedStrings.xml") || "", "<si>", "</si>"),
  ].map(plain);
  const targets = new Map(
    [
      ...(files.get("xl/_rels/workbook.xml.rels") || "").matchAll(
        /<Relationship\b[^<>]*>/g,
      ),
    ].map((m) => [
      /Id="([^"]+)"/.exec(m[0])?.[1],
      "xl/" + (/Target="\/?(?:xl\/)?([^"]+)"/.exec(m[0])?.[1] || ""),
    ]),
  );
  let sheets = [
    ...(files.get("xl/workbook.xml") || "").matchAll(/<sheet\b[^<>]*>/g),
  ].map((m) => [
    entities(/name="([^"]*)"/.exec(m[0])?.[1] || "Sheet"),
    targets.get(/r:id="([^"]+)"/.exec(m[0])?.[1]),
  ]);
  if (!sheets.some(([, file]) => files.has(file)))
    sheets = numbered(files, /sheet(\d+)\.xml$/).map(([file, n]) => [
      "Sheet " + n,
      file,
    ]);
  return sheets
    .filter(([, file]) => files.has(file))
    .map(([name, file]) => {
      const rows = [...elements(files.get(file), "row")].map(([, row]) => {
        const cells = [];
        for (const [attrs, body] of elements(row, "c", true)) {
          const type = /t="([^"]+)"/.exec(attrs)?.[1],
            raw = first(body, "<v>", "</v>") ?? "";
          const value =
            type === "s"
              ? shared[Number(raw)] || ""
              : type === "inlineStr"
                ? plain(first(body, "<is>", "</is>") || "")
                : type === "b"
                  ? raw === "1"
                    ? "TRUE"
                    : "FALSE"
                  : entities(raw);
          cells[column(/r="([A-Z]+)\d*"/.exec(attrs)?.[1])] = csvCell(value);
        }
        return Array.from(cells, (v) => v || "").join(",");
      });
      return `## Sheet: ${name}\n` + rows.join("\n");
    })
    .join("\n\n");
}
function pdfText(buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tameduck-pdf-"));
  try {
    const file = path.join(dir, "input.pdf");
    fs.writeFileSync(file, buffer, { mode: 0o600 });
    const r = spawnSync(pdfBinary, ["-layout", "-enc", "UTF-8", file, "-"], {
      timeout: 15000,
      maxBuffer: 20000000,
      env: { PATH: "/usr/bin:/bin" },
    });
    if (r.status !== 0) throw new Error("PDF could not be read");
    return r.stdout.toString("utf8");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
// Images above provider limits are shrunk with the same host Pillow used for screenshots.
function modelImage(buffer, mime) {
  if (buffer.length <= 3500000) return { mime, data: buffer };
  const r = spawnSync(
    "/usr/bin/python3",
    [
      "-c",
      "from PIL import Image; import io,sys; im=Image.open(io.BytesIO(sys.stdin.buffer.read())); im.thumbnail((2000,2000)); im.convert('RGB').save(sys.stdout.buffer,format='JPEG',quality=85)",
    ],
    {
      input: buffer,
      timeout: 15000,
      maxBuffer: 8000000,
      env: { PATH: "/usr/bin:/bin" },
    },
  );
  if (r.status !== 0 || !r.stdout.length)
    throw new Error("Image could not be prepared");
  return { mime: "image/jpeg", data: r.stdout };
}
const PAGE = 40000;
// Returns the text page or image a duck receives. Failures carry a human reason.
export function readForAI(upload, buffer, format, offset = 0) {
  try {
    if (format === "image") {
      const image = modelImage(buffer, upload.mime);
      return {
        image:
          "data:" + image.mime + ";base64," + image.data.toString("base64"),
      };
    }
    const text =
      format === "docx"
        ? docx(buffer)
        : format === "xlsx"
          ? xlsx(buffer)
          : format === "pptx"
            ? pptx(buffer)
            : format === "pdf"
              ? pdfText(buffer)
              : buffer.toString("utf8");
    if (format === "pdf" && !text.trim())
      return {
        error:
          "This PDF has no text layer (it looks scanned), so AI can't read it. Share the pages as images or paste the text.",
      };
    const end = Math.min(offset + PAGE, text.length);
    return {
      text: text.slice(offset, end),
      offset,
      next_offset: end < text.length ? end : null,
      total_characters: text.length,
    };
  } catch {
    return {
      error: `${upload.name} couldn't be opened. It may be damaged or password-protected. Try exporting it again.`,
    };
  }
}
