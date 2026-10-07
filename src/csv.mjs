// CSV values stay text: previewing a file never evaluates formulas or HTML.
export const CSV_PREVIEW_BYTES = 2 * 1024 * 1024;
export function parseCsv(
  source,
  { delimiter = ",", maxRows = 501, maxColumns = 100 } = {},
) {
  source = String(source ?? "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [],
    field = "",
    quoted = false,
    closed = false,
    truncated = false;
  const cell = () => {
    if (row.length < maxColumns) row.push(field);
    else truncated = true;
    field = "";
    closed = false;
  };
  const record = () => {
    cell();
    rows.push(row);
    row = [];
  };
  const error = () => ({
    rows: [],
    truncated: false,
    error:
      "This CSV has an incomplete or incorrectly quoted cell. The original text is shown below.",
  });
  if (!source) return { rows, truncated, error: null };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
      continue;
    }
    if (c === delimiter) cell();
    else if (c === "\n" || c === "\r") {
      record();
      if (c === "\r" && source[i + 1] === "\n") i++;
      if (rows.length >= maxRows && i < source.length - 1) {
        return { rows, truncated: true, error: null };
      }
    } else if (closed) {
      if (c !== " " && c !== "\t") return error();
    } else if (c === '"') {
      if (field) return error();
      quoted = true;
    } else field += c;
  }
  if (quoted) return error();
  if (field || row.length || closed || source.endsWith(delimiter)) record();
  return { rows, truncated, error: null };
}
export function columnLabel(index) {
  let label = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    label = String.fromCharCode(65 + ((n - 1) % 26)) + label;
  return label;
}
export function isCsvFile(item) {
  return (
    /\.(csv|tsv)$/i.test(item?.name || "") ||
    ["text/csv", "text/tab-separated-values"].includes(item?.mime)
  );
}
export function decodeCsvBytes(bytes) {
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : "utf-8";
  return new TextDecoder(encoding).decode(bytes);
}
