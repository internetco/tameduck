// What the Files page shows, worked out without a browser: which files a
// search finds, how many of each kind, in what order, and a size in words.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fileSize,
  filterGroup,
  findFiles,
  kindName,
  inFolder,
  validFolder,
  folderOptions,
  inFileScope,
} from "../src/files-list.mjs";

const file = (name, group, updated, by) => ({ name, group, updated, by });
const files = [
  file(
    "stock-count-september.tsv",
    "spreadsheet",
    "2026-09-22T14:05:00Z",
    "Daan Visser",
  ),
  file("shop-photos.zip", "archive", "2026-09-22T14:05:00Z", "Daan Visser"),
  file("invoice-2026-0917.pdf", "pdf", "2026-09-23T06:51:00Z", "Sam de Vries"),
  file("Supplier contract.docx", "doc", "2026-09-21T07:12:00Z", "You"),
  file(
    "How we answer emails",
    "document",
    "2026-09-23T08:42:00Z",
    "Writer Duck",
  ),
];
const names = (item) => [item.by];

test("a search finds a file by its name or by who shared it", () => {
  const byName = findFiles(files, { query: "  INVOICE ", names });
  assert.deepEqual(
    byName.shown.map((f) => f.name),
    ["invoice-2026-0917.pdf"],
  );
  const byPerson = findFiles(files, { query: "daan", names });
  assert.deepEqual(
    byPerson.shown.map((f) => f.name),
    ["shop-photos.zip", "stock-count-september.tsv"],
  );
  // Without the names of who shared it, a person's name finds nothing.
  assert.equal(findFiles(files, { query: "daan" }).total, 0);
});

// With "From anyone" gone, typing a name is the only way to find someone's
// files, and Dutch names carry accents people do not type.
test("a search ignores accents, and its words may be anywhere", () => {
  const more = [
    ...files,
    file("rota-october.pdf", "pdf", "2026-09-20T09:00:00Z", "Daniël Jansen"),
    file(
      "invoice-2026-0917 Flour Mills B.V.pdf",
      "pdf",
      "2026-09-19T09:00:00Z",
      "Sam de Vries",
    ),
  ];
  const find = (query) =>
    findFiles(more, { query, names }).shown.map((f) => f.name);
  assert.deepEqual(find("daniel"), ["rota-october.pdf"]);
  assert.deepEqual(find("Daniël"), ["rota-october.pdf"]);
  assert.deepEqual(find("invoice flour"), [
    "invoice-2026-0917 Flour Mills B.V.pdf",
  ]);
  assert.deepEqual(find("flour   INVOICE"), [
    "invoice-2026-0917 Flour Mills B.V.pdf",
  ]);
  // A word from the name and a word from who shared it.
  assert.deepEqual(find("daan zip"), ["shop-photos.zip"]);
  assert.deepEqual(find("invoice croissant"), []);
});

test("each kind counts what the search found, before the kind is picked", () => {
  const found = findFiles(files, { query: "daan", kind: "archive", names });
  assert.deepEqual(found.counts, { spreadsheet: 1, archive: 1 });
  assert.equal(found.total, 2, "All counts the search, not the kind");
  assert.deepEqual(
    found.shown.map((f) => f.name),
    ["shop-photos.zip"],
  );
});

test("a Word file counts as a document", () => {
  assert.equal(filterGroup({ group: "doc" }), "document");
  const docs = findFiles(files, { kind: "document", names });
  assert.deepEqual(
    docs.shown.map((f) => f.name),
    ["How we answer emails", "Supplier contract.docx"],
  );
  assert.equal(docs.counts.document, 2);
});

test("newest change first, and the same order every time for a tie", () => {
  const order = findFiles(files, { names }).shown.map((f) => f.name);
  assert.deepEqual(order, [
    "How we answer emails",
    "invoice-2026-0917.pdf",
    "shop-photos.zip",
    "stock-count-september.tsv",
    "Supplier contract.docx",
  ]);
  assert.deepEqual(
    findFiles([...files].reverse(), { names }).shown.map((f) => f.name),
    order,
  );
  assert.equal(
    files[0].name,
    "stock-count-september.tsv",
    "the list given is left alone",
  );
});

test("a size reads as a person says it, to one decimal", () => {
  assert.equal(fileSize(3200000), "3.2 MB");
  assert.equal(fileSize(48200), "48.2 KB");
  assert.equal(fileSize(245000), "245 KB");
  assert.equal(fileSize(999950), "1 MB");
  assert.equal(fileSize(25000000), "25 MB");
  assert.equal(fileSize(1234567890), "1.2 GB");
  assert.equal(fileSize(520), "520 bytes");
  assert.equal(fileSize(1), "1 byte");
  assert.equal(fileSize(0), "0 bytes");
  assert.equal(fileSize(undefined), "0 bytes");
});

test("the card says what a file is in words, not a file-type code", () => {
  assert.equal(kindName({ group: "doc" }), "Word document");
  assert.equal(kindName({ group: "archive" }), "Archive");
  assert.equal(kindName({ group: "presentation" }), "Presentation");
  assert.equal(kindName({ group: "text" }), "Text file");
  assert.equal(kindName({ group: "other" }), "File");
  assert.equal(kindName({}), "File");
});

test("folder filters keep All unchanged and distinguish Unfiled", () => {
  const unfiled = { id: "a", folder_id: null };
  const filed = { id: "b", folder_id: "reports" };
  assert.equal(inFolder(unfiled, "all"), true);
  assert.equal(inFolder(filed, "all"), true);
  assert.equal(inFolder(unfiled, "unfiled"), true);
  assert.equal(inFolder(filed, "unfiled"), false);
  assert.equal(inFolder(filed, "reports"), true);
  assert.equal(inFolder(unfiled, "reports"), false);
});

test("folder selection falls back safely and move choices follow the tree", () => {
  const folders = [
    { id: "child", name: "March", parent_id: "reports" },
    { id: "loose", name: "Inbox", parent_id: "gone" },
    { id: "reports", name: "Reports", parent_id: null },
  ];
  assert.equal(validFolder(folders, "all"), true);
  assert.equal(validFolder(folders, "unfiled"), true);
  assert.equal(validFolder(folders, "reports"), true);
  assert.equal(validFolder(folders, "removed"), false);
  assert.deepEqual(
    folderOptions(folders).map(({ id, depth }) => [id, depth]),
    [["loose", 0], ["reports", 0], ["child", 1]],
  );
});

test("a scoped folder includes a new human document without changing its source links", () => {
  const folders = [{ id: "duck-plans" }];
  const document = {
    folder_id: "duck-plans",
    duck_ids: [],
    conversation_ids: [],
  };
  assert.equal(inFileScope(document, folders, { duckId: "writer" }), true);
  assert.equal(inFileScope(document, folders, { conversationId: "writers-chat" }), true);
  assert.deepEqual(document.duck_ids, []);
  assert.deepEqual(document.conversation_ids, []);
  assert.equal(inFileScope(document, [], { duckId: "writer" }), false);
  assert.equal(
    inFileScope({ ...document, folder_id: null, conversation_ids: ["writers-chat"] }, [], {
      duckId: "writer",
      conversationId: "writers-chat",
    }),
    true,
  );
});
