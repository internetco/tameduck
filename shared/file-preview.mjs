const spreadsheet = new Set([
  "xlsx",
  "xlsm",
  "xls",
  "ods",
  "numbers",
  "csv",
  "tsv",
]);
const document = new Set(["docx", "odt", "pptx"]);
const text = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "jsonl",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "tsx",
  "css",
  "html",
  "htm",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "sql",
  "sh",
  "bash",
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
  "log",
  "srt",
  "vtt",
]);
const unsupported = new Set([
  "doc",
  "ppt",
  "odg",
  "odp",
  "pages",
  "key",
  "rtf",
  "pdf",
  "svg",
]);
export function previewKind(item) {
  if (
    item?.inline &&
    (/^image\//.test(item.mime || "") || item.mime === "application/pdf")
  )
    return null;
  const extension =
    /\.([a-z0-9]+)$/i.exec(String(item?.name || ""))?.[1].toLowerCase() || "";
  if (spreadsheet.has(extension)) return "spreadsheet";
  if (document.has(extension)) return "document";
  if (unsupported.has(extension)) return null;
  const mime = String(item?.mime || "")
    .split(";")[0]
    .toLowerCase();
  if (
    text.has(extension) ||
    mime.startsWith("text/") ||
    ["application/json", "application/xml"].includes(mime)
  )
    return "text";
  return null;
}
export const PREVIEW_LIMITS = Object.freeze({
  bytes: 25 * 1000 * 1000,
  archiveBytes: 40 * 1024 * 1024,
  entries: 2048,
  sheets: 20,
  rows: 500,
  columns: 100,
  cells: 50_000,
  text: 200_000,
  cellText: 10_000,
  sectionText: 50_000,
  timeout: 5000,
});
export class PreviewError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}
