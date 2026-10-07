import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { parseCsv } from "./csv.mjs";

const safeLink = (value) =>
  /^(https?:|mailto:)/i.test(value || "") ? value : undefined;
function inline(node, inherited = {}) {
  if (node.type === "text") return [{ text: node.value, ...inherited }];
  if (node.type === "break") return [{ text: "\n", ...inherited }];
  if (node.type === "inlineCode")
    return [{ text: node.value, background: "#f1f5f9", ...inherited }];
  if (node.type === "image")
    return [
      { text: "[Image: " + (node.alt || "attachment") + "]", ...inherited },
    ];
  const style = { ...inherited };
  if (node.type === "strong") style.bold = true;
  if (node.type === "emphasis") style.italics = true;
  if (node.type === "delete") style.decoration = "lineThrough";
  if (node.type === "link" && safeLink(node.url)) {
    style.link = node.url;
    style.color = "#3159ef";
    style.decoration = "underline";
  }
  return (node.children || []).flatMap((child) => inline(child, style));
}
function tableBlocks(rows) {
  if (!rows.length) return [];
  const columns = Math.max(...rows.map((row) => row.length));
  const out = [];
  // Wide sheets are split into numbered column groups so no cell falls off
  // the printed page. Every group repeats the row numbers and header row.
  for (let start = 0; start < columns; start += 6) {
    const count = Math.min(6, columns - start);
    if (columns > 6)
      out.push({
        text: `Columns ${start + 1}–${start + count}`,
        bold: true,
        margin: [0, 8, 0, 4],
      });
    const body = rows.map((row, r) => [
      { text: r === 0 ? "" : String(r), color: "#64748b", fontSize: 8 },
      ...Array.from({ length: count }, (_, c) => ({
        text: row[start + c] ?? "",
        fontSize: 8,
        bold: r === 0,
        fillColor: r === 0 ? "#eef2f7" : undefined,
      })),
    ]);
    out.push({
      table: { headerRows: 1, widths: [24, ...Array(count).fill("*")], body },
      layout: "lightHorizontalLines",
      margin: [0, 3, 0, 12],
    });
  }
  return out;
}
function blocks(nodes) {
  return (nodes || []).flatMap((node) => {
    if (node.type === "heading")
      return [
        {
          text: inline(node),
          style: "h" + Math.min(node.depth, 3),
          margin: [0, 10, 0, 5],
        },
      ];
    if (node.type === "paragraph")
      return [{ text: inline(node), margin: [0, 0, 0, 8] }];
    if (node.type === "blockquote")
      return [
        {
          stack: blocks(node.children),
          color: "#475569",
          margin: [12, 2, 0, 8],
        },
      ];
    if (node.type === "list")
      return [
        {
          [node.ordered ? "ol" : "ul"]: node.children.map((item) => ({
            stack: blocks(item.children),
            ...(item.checked != null ? { markerColor: "#3159ef" } : {}),
          })),
          ...(node.ordered ? { start: node.start || 1 } : {}),
          margin: [12, 0, 0, 8],
        },
      ];
    if (node.type === "code") {
      if (/^(csv|tsv)$/i.test(node.lang || "")) {
        const parsed = parseCsv(node.value, {
          delimiter: node.lang.toLowerCase() === "tsv" ? "\t" : ",",
          maxRows: Infinity,
          maxColumns: Infinity,
        });
        if (!parsed.error && parsed.rows.length)
          return tableBlocks(parsed.rows);
      }
      return [
        {
          text: node.value || " ",
          fontSize: 8,
          background: "#f5f5fa",
          color: "#334155",
          margin: [0, 3, 0, 10],
        },
      ];
    }
    if (node.type === "table")
      return tableBlocks(
        node.children.map((row) => row.children.map((cell) => inline(cell))),
      );
    if (node.type === "thematicBreak")
      return [
        {
          canvas: [
            {
              type: "line",
              x1: 0,
              y1: 0,
              x2: 499,
              y2: 0,
              lineWidth: 1,
              lineColor: "#dfe3ea",
            },
          ],
          margin: [0, 5, 0, 8],
        },
      ];
    if (node.type === "html")
      return [{ text: node.value, fontSize: 8, margin: [0, 2, 0, 8] }];
    return node.children ? blocks(node.children) : [];
  });
}
export function markdownToPdfDefinition(title, markdown) {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .parse(markdown || "");
  return {
    info: { title: title || "Document" },
    pageSize: "A4",
    pageMargins: [48, 52, 48, 52],
    defaultStyle: {
      font: "Roboto",
      fontSize: 10,
      lineHeight: 1.2,
      color: "#202035",
    },
    styles: {
      h1: { fontSize: 22, bold: true },
      h2: { fontSize: 16, bold: true },
      h3: { fontSize: 13, bold: true },
    },
    footer: (page, total) => ({
      text: `${page} / ${total}`,
      alignment: "center",
      color: "#626378",
      fontSize: 8,
      margin: [0, 20, 0, 0],
    }),
    content: [
      { text: title || "Document", style: "h1", margin: [0, 0, 0, 14] },
      ...blocks(tree.children),
    ],
  };
}
export async function createMarkdownPdf(title, markdown) {
  const [{ default: pdfMake }, { default: fonts }] = await Promise.all([
    import("pdfmake/build/pdfmake.js"),
    import("pdfmake/build/vfs_fonts.js"),
  ]);
  pdfMake.addVirtualFileSystem(fonts);
  pdfMake.addFonts({
    Roboto: {
      normal: "Roboto-Regular.ttf",
      bold: "Roboto-Medium.ttf",
      italics: "Roboto-Italic.ttf",
      bolditalics: "Roboto-MediumItalic.ttf",
    },
  });
  return pdfMake.createPdf(markdownToPdfDefinition(title, markdown));
}
export async function downloadMarkdownPdf(title, markdown) {
  const pdf = await createMarkdownPdf(title, markdown);
  await pdf.download(
    (title.replace(/[^a-z0-9]+/gi, "-") || "document") + ".pdf",
  );
}
