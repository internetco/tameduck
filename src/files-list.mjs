// What the Files page shows, worked out without a browser so it can be tested.

// Word files and company documents share one filter; everything else keeps its group.
export const filterGroup = (item) =>
  item.group === "doc" ? "document" : item.group;

// Folder filtering is deliberately pure so Files, ticket panels and browser
// checks use the same semantics. "all" includes every item; "unfiled" means
// an item with no folder assignment.
export const inFolder = (item, folder = "all") =>
  !folder || folder === "all" ||
  (folder === "unfiled" ? !item.folder_id : item.folder_id === folder);

export const validFolder = (folders, folder = "all") =>
  !folder || folder === "all" || folder === "unfiled" ||
  folders.some((item) => item.id === folder);

export const inFileScope = (item, folders, { duckId, conversationId } = {}) => {
  const assignedHere = !!item.folder_id && folders.some((folder) => folder.id === item.folder_id);
  if (duckId)
    return item.duck_ids?.includes(duckId) ||
      (conversationId && item.conversation_ids?.includes(conversationId)) ||
      assignedHere;
  if (conversationId)
    return item.conversation_ids?.includes(conversationId) || assignedHere;
  return true;
};

export function folderOptions(folders = []) {
  const byParent = new Map();
  for (const folder of folders) {
    const parent = folders.some((f) => f.id === folder.parent_id)
      ? folder.parent_id
      : null;
    byParent.set(parent, [...(byParent.get(parent) || []), folder]);
  }
  const result = [];
  const visit = (parent, depth, seen = new Set()) => {
    for (const folder of (byParent.get(parent) || []).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (seen.has(folder.id)) continue;
      result.push({ ...folder, depth });
      visit(folder.id, depth + 1, new Set([...seen, folder.id]));
    }
  };
  visit(null, 0);
  return result;
}

// Capitals and accents do not count, so "daniel" finds Daniël.
const plain = (text) =>
  String(text || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase();

// The files a search finds, newest change first, and how many of each kind
// there are among them. The counts come after the search and before the kind,
// so each kind says how many a click on it would show. A search matches the
// file's name or the name of whoever shared it, which is how "From anyone"
// could go. Each word may be anywhere, so "invoice flour" finds
// "invoice-2026-0917 Flour Mills B.V.pdf".
export function findFiles(items, { query = "", kind = "", names } = {}) {
  const words = plain(query).split(/\s+/).filter(Boolean);
  const found = words.length
    ? items.filter((item) => {
        const text = [item.name, ...(names ? names(item) : [])]
          .map(plain)
          .join("\n");
        return words.every((word) => text.includes(word));
      })
    : items;
  const counts = {};
  for (const item of found)
    counts[filterGroup(item)] = (counts[filterGroup(item)] || 0) + 1;
  const shown = (
    kind ? found.filter((item) => filterGroup(item) === kind) : found
  )
    .slice()
    .sort(
      (a, b) =>
        String(b.updated).localeCompare(String(a.updated)) ||
        String(a.name).localeCompare(String(b.name)),
    );
  return { shown, counts, total: found.length };
}

// A size as a person reads it: "3.2 MB", "48.2 KB", "520 bytes". Chat and
// tickets keep formatBytes and its two decimals; here one is plenty.
export function fileSize(bytes) {
  const n = Math.max(0, Math.round(Number(bytes) || 0));
  if (n < 1000) return n + (n === 1 ? " byte" : " bytes");
  const units = ["KB", "MB", "GB"];
  let value = n / 1000,
    unit = 0;
  while (unit < units.length - 1 && Math.round(value * 10) / 10 >= 1000) {
    value /= 1000;
    unit++;
  }
  return (
    new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
      value,
    ) +
    " " +
    units[unit]
  );
}

// What a file is, in plain words, on the card of a file this page cannot show.
// It used to say "DOCX" and "ZIP".
const kinds = {
  document: "Document",
  doc: "Word document",
  pdf: "PDF",
  spreadsheet: "Spreadsheet",
  image: "Image",
  presentation: "Presentation",
  text: "Text file",
  media: "Audio or video",
  archive: "Archive",
};
export const kindName = (item) => kinds[item.group] || "File";
