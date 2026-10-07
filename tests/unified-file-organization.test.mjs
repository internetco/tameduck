import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

process.env.DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "unified-files-test-"),
);
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
const s = await import("../server/store.mjs");
const uploads = await import("../server/uploads.mjs");
const folders = await import("../server/file-folders.mjs");
const organization = await import("../server/file-organization.mjs");
const owner = s.id(),
  other = s.id();
for (const [id, name] of [
  [owner, "Owner"],
  [other, "Other"],
])
  s.run(
    "INSERT INTO users VALUES(?,?,?,?,?,?)",
    id,
    `${name.toLowerCase()}@example.test`,
    name,
    "unused",
    null,
    s.now(),
  );
const company = s.createCompany(owner, "Files test");
s.run(
  "INSERT INTO memberships VALUES(?,?,?,?)",
  company,
  other,
  "member",
  "{}",
);
const duck = s.one(
  "SELECT * FROM ducks WHERE company_id=? AND chief=1",
  company,
);
const mine = s.directConversation(company, owner, duck);
const otherChat = s.directConversation(company, other, duck);
const second = s.id();
s.run(
  "INSERT INTO conversations(id,company_id,name,kind,creator_id,created) VALUES(?,?,?,?,?,?)",
  second,
  company,
  "Other private",
  "direct",
  owner,
  s.now(),
);
s.run("INSERT INTO conversation_members VALUES(?,?)", second, owner);
s.run("INSERT INTO conversation_ducks VALUES(?,?)", second, duck.id);
const job = {
  id: s.id(),
  company_id: company,
  user_id: owner,
  conversation_id: mine.id,
  duck_id: duck.id,
};
const message = (chat, byDuck = false) =>
  s.addMessage(
    company,
    chat,
    "File",
    byDuck ? { duck: duck.id } : { user: owner },
  );
const createUpload = async (chat, name, published = false, user = owner) => {
  const upload = await uploads.storeUpload(
    company,
    chat,
    user,
    name,
    Readable.from([Buffer.from("some bytes\n")]),
  );
  const m = s.addMessage(
    company,
    chat,
    "file",
    published ? { duck: duck.id } : { user },
  );
  s.run("UPDATE uploads SET message_id=? WHERE id=?", m, upload.id);
  if (published) {
    const jobId = s.id();
    s.run(
      "INSERT INTO jobs(id,company_id,user_id,conversation_id,duck_id,status,created,updated) VALUES(?,?,?,?,?,?,?,?)",
      jobId,
      company,
      user,
      chat,
      duck.id,
      "done",
      s.now(),
      s.now(),
    );
    s.run(
      "INSERT INTO computer_file_exports(upload_id,company_id,job_id,call_id,duck_id,created) VALUES(?,?,?,?,?,?)",
      upload.id,
      company,
      jobId,
      s.id(),
      duck.id,
      s.now(),
    );
  }
  return upload.id;
};
const computer = s.id();
s.run(
  "INSERT INTO computers(id,company_id,duck_id,box_id,state,bootstrapped,created,updated) VALUES(?,?,?,?,?,?,?,?)",
  computer,
  company,
  duck.id,
  "box",
  "ready",
  1,
  s.now(),
  s.now(),
);
const fakeProvider = async (_ctx, _op, args, { guard, commit } = {}) => {
  await guard?.();
  const result = {
    computer_id: computer,
    source_box_id: "box",
    result: { path: `/home/duck/tameduck/outputs/${args.target || args.path}` },
  };
  commit?.(result, () => {});
  return result;
};
folders.setOutputFolderOperation(fakeProvider);
after(() => {
  s.db.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test("catalog distinguishes identical names, includes own cross-chat exports and excludes unrelated private files", async () => {
  const first = await createUpload(mine.id, "same.csv");
  const secondUpload = await createUpload(mine.id, "same.csv");
  const ownExport = await createUpload(second, "export.csv", true);
  const foreign = await createUpload(otherChat.id, "secret.csv", false, other);
  const files = organization.listOrganizableFiles(job).files;
  assert(files.some((f) => f.file_id === `upload:${first}`));
  assert(files.some((f) => f.file_id === `upload:${secondUpload}`));
  assert(files.some((f) => f.file_id === `upload:${ownExport}` && f.can_move));
  assert(!files.some((f) => f.file_id === `upload:${foreign}`));
  const moved = await organization.organizeFiles(job, {
    file_ids: [`upload:${ownExport}`],
    folder_path: "Projects/October",
  });
  assert.equal(moved.moved, 1);
  assert.equal(
    (
      await organization.organizeFiles(job, {
        file_ids: [`upload:${ownExport}`],
        folder_path: "Projects/October",
      })
    ).unchanged,
    1,
  );
  assert.equal(
    s.one(
      "SELECT count(*) n FROM file_folders WHERE company_id=? AND relative_path='Projects/October'",
      company,
    ).n,
    1,
  );
  const mixed = await organization.organizeFiles(job, {
    file_ids: [`upload:${first}`, `upload:${foreign}`],
    folder_id: "unfiled",
  });
  assert.equal(mixed.failed, 1);
  assert.equal(mixed.unchanged, 1);
});

test("captures and notes use metadata placement and keep original links", async () => {
  const capture = s.id();
  s.run(
    "INSERT INTO computer_captures VALUES(?,?,?,?,?,?,?)",
    capture,
    company,
    mine.id,
    computer,
    "Screen",
    "ciphertext",
    s.now(),
  );
  const m = s.addMessage(company, mine.id, "shown", { duck: duck.id });
  s.run(
    "INSERT INTO message_artifacts VALUES(?,?,?,?,?,?,?,?)",
    s.id(),
    company,
    m,
    "screenshot",
    capture,
    "Screen",
    "Shared",
    s.now(),
  );
  s.run("UPDATE ducks SET notes=? WHERE id=?", "Remember this", duck.id);
  const files = organization.listOrganizableFiles(job).files;
  assert(
    files.some((f) => f.file_id === `screenshot:${capture}` && f.can_move),
  );
  assert(files.some((f) => f.file_id === `notes:${duck.id}` && f.can_move));
  const moved = await organization.organizeFiles(job, {
    file_ids: [`screenshot:${capture}`, `notes:${duck.id}`],
    folder_path: "Projects/October",
  });
  assert.equal(moved.moved, 2);
  assert.equal(
    s.one(
      "SELECT count(*) n FROM message_artifacts WHERE reference_id=?",
      capture,
    ).n,
    1,
  );
  assert.equal(
    s.one("SELECT conversation_id FROM computer_captures WHERE id=?", capture)
      .conversation_id,
    mine.id,
  );
  assert.equal(
    s.one("SELECT notes FROM ducks WHERE id=?", duck.id).notes,
    "Remember this",
  );
  const folder = s.one(
    "SELECT id FROM file_folders WHERE company_id=? AND relative_path='Projects/October'",
    company,
  );
  await assert.rejects(
    folders.folderDelete({ company_id: company, user_id: owner }, folder.id),
    /empty/,
  );
});

test("a published capture in another accessible chat can be filed without making an unseen capture visible", async () => {
  const published = s.id(),
    unseen = s.id();
  for (const [capture, chat] of [
    [published, second],
    [unseen, otherChat.id],
  ])
    s.run(
      "INSERT INTO computer_captures VALUES(?,?,?,?,?,?,?)",
      capture,
      company,
      chat,
      computer,
      "Screen",
      "ciphertext",
      s.now(),
    );
  const m = s.addMessage(company, second, "published", { duck: duck.id });
  s.run(
    "INSERT INTO message_artifacts VALUES(?,?,?,?,?,?,?,?)",
    s.id(),
    company,
    m,
    "screenshot",
    published,
    "Screen",
    "Shared",
    s.now(),
  );
  const files = organization.listOrganizableFiles(job).files;
  assert(
    files.some((f) => f.file_id === `screenshot:${published}` && f.can_move),
  );
  assert(!files.some((f) => f.file_id === `screenshot:${unseen}`));
  const result = await organization.organizeFiles(job, {
    file_ids: [`screenshot:${published}`, `screenshot:${unseen}`],
    folder_path: "Evidence/Week 1",
  });
  assert.equal(result.moved, 1);
  assert.equal(result.failed, 1);
  assert.equal(
    s.one(
      "SELECT folder_id FROM file_folder_items WHERE kind='screenshot' AND item_id=?",
      published,
    ).folder_id,
    s.one(
      "SELECT id FROM file_folders WHERE company_id=? AND relative_path='Evidence/Week 1'",
      company,
    ).id,
  );
});

test("linked source and app capture share one folder while source aliases and version IDs survive", async () => {
  const folder = s.one(
    "SELECT id FROM file_folders WHERE company_id=? AND relative_path='Evidence/Week 1'",
    company,
  );
  const upload = await createUpload(mine.id, "linked.txt", true);
  const source = "/home/duck/tameduck/outputs/linked.txt";
  const shared = s.id();
  const messageId = s.one(
    "SELECT message_id FROM uploads WHERE id=?",
    upload,
  ).message_id;
  s.run(
    `INSERT INTO shared_files(id,company_id,computer_id,source_box_id,duck_id,conversation_id,user_id,message_id,
    source_path,display_name,source_dev,source_ino,source_token,current_upload_id,created,updated)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    shared,
    company,
    computer,
    "box",
    duck.id,
    mine.id,
    owner,
    messageId,
    source,
    "linked.txt",
    "1",
    "2",
    JSON.stringify(["1", "2", "3", "4", "5"]),
    upload,
    s.now(),
    s.now(),
  );
  s.run(
    "INSERT INTO shared_file_versions VALUES(?,?,?,?)",
    shared,
    upload,
    1,
    s.now(),
  );
  const moved = await organization.organizeFiles(job, {
    file_ids: [`shared_file:${shared}`],
    folder_path: "Evidence/Week 1",
  });
  assert.equal(moved.moved, 1, JSON.stringify(moved));
  assert.equal(moved.results[0].folder_id, folder.id);
  assert.equal(
    s.one("SELECT source_path FROM shared_files WHERE id=?", shared)
      .source_path,
    "/home/duck/tameduck/outputs/Evidence/Week 1/linked.txt",
  );
  assert.equal(
    s.one(
      "SELECT upload_id FROM shared_file_versions WHERE shared_file_id=?",
      shared,
    ).upload_id,
    upload,
  );
  assert.equal(
    s.one(
      "SELECT folder_id FROM file_folder_items WHERE kind='shared_file' AND item_id=?",
      shared,
    ).folder_id,
    folder.id,
  );
  uploads.listFiles(company, owner);
  assert.equal(
    s.one(
      "SELECT count(*) n FROM file_folders WHERE company_id=? AND relative_path='Evidence/Week 1'",
      company,
    ).n,
    1,
  );
  await folders.folderRename(
    { company_id: company, user_id: owner },
    folder.id,
    "Week 2",
  );
  assert.equal(
    s.one("SELECT source_path FROM shared_files WHERE id=?", shared)
      .source_path,
    "/home/duck/tameduck/outputs/Evidence/Week 2/linked.txt",
  );
  assert.equal(
    s.one("SELECT relative_path FROM file_folders WHERE id=?", folder.id)
      .relative_path,
    "Evidence/Week 2",
  );
  assert.equal(
    s.one(
      "SELECT count(*) n FROM file_folder_items WHERE kind='screenshot' AND folder_id=?",
      folder.id,
    ).n,
    1,
  );
  assert.equal(
    s.one(
      "SELECT count(*) n FROM file_folder_materializations WHERE folder_id=?",
      folder.id,
    ).n,
    1,
  );
  await organization.organizeFiles(job, {
    file_ids: [`shared_file:${shared}`],
    folder_id: "unfiled",
  });
  const captureInFolder = s.one(
    "SELECT item_id FROM file_folder_items WHERE kind='screenshot' AND folder_id=?",
    folder.id,
  ).item_id;
  await organization.organizeFiles(job, {
    file_ids: [`screenshot:${captureInFolder}`],
    folder_id: "unfiled",
  });
  await folders.folderDelete(
    { company_id: company, user_id: owner },
    folder.id,
  );
  assert.equal(
    s.one("SELECT 1 FROM file_folders WHERE id=?", folder.id),
    undefined,
  );
  assert.equal(
    s.one(
      "SELECT 1 FROM file_folder_materializations WHERE folder_id=?",
      folder.id,
    ),
    undefined,
  );
});

test("a failed guarded provider move does not add source grants or alter alias paths", async () => {
  const target = await folders.folderCreate(
    {
      company_id: company,
      user_id: owner,
      duck_id: duck.id,
      conversation_id: mine.id,
    },
    { name: "Failure target", computer: false, duck_id: duck.id },
  );
  const source = "/home/duck/tameduck/outputs/fail.txt";
  const shares = [];
  for (const chat of [mine.id, second]) {
    const upload = await createUpload(chat, "fail.txt", true);
    const shared = s.id();
    s.run(
      `INSERT INTO shared_files(id,company_id,computer_id,source_box_id,duck_id,conversation_id,user_id,message_id,
      source_path,display_name,source_dev,source_ino,source_token,current_upload_id,created,updated)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      shared,
      company,
      computer,
      "box",
      duck.id,
      chat,
      owner,
      s.one("SELECT message_id FROM uploads WHERE id=?", upload).message_id,
      source,
      "fail.txt",
      "1",
      "2",
      JSON.stringify(["1", "2", "3", "4", "5"]),
      upload,
      s.now(),
      s.now(),
    );
    s.run(
      "INSERT INTO shared_file_versions VALUES(?,?,?,?)",
      shared,
      upload,
      1,
      s.now(),
    );
    shares.push(shared);
  }
  assert.equal(
    s.one(
      "SELECT count(*) n FROM file_folder_scopes WHERE folder_id=? AND scope_kind='conversation' AND scope_id=?",
      target.id,
      second,
    ).n,
    0,
  );
  folders.setOutputFolderOperation(
    async (ctx, operation, args, options = {}) => {
      if (operation === "move_file") {
        await options.guard?.();
        throw Object.assign(new Error("Provider refused"), { status: 409 });
      }
      return fakeProvider(ctx, operation, args, options);
    },
  );
  try {
    const failed = await organization.organizeFiles(job, {
      file_ids: [`shared_file:${shares[0]}`],
      folder_id: target.id,
    });
    assert.equal(failed.failed, 1);
  } finally {
    folders.setOutputFolderOperation(fakeProvider);
  }
  assert.equal(
    s.one(
      "SELECT count(*) n FROM file_folder_scopes WHERE folder_id=? AND scope_kind='conversation' AND scope_id=?",
      target.id,
      second,
    ).n,
    0,
  );
  for (const shared of shares) {
    assert.equal(
      s.one("SELECT source_path FROM shared_files WHERE id=?", shared)
        .source_path,
      source,
    );
    assert.equal(
      s.one(
        "SELECT folder_id FROM file_folder_items WHERE kind='shared_file' AND item_id=?",
        shared,
      ),
      undefined,
    );
  }
  const retry = await organization.organizeFiles(job, {
    file_ids: [`shared_file:${shares[1]}`],
    folder_id: target.id,
  });
  assert.equal(retry.moved, 1, JSON.stringify(retry));
  assert.equal(
    (
      await organization.organizeFiles(job, {
        file_ids: [`shared_file:${shares[0]}`],
        folder_id: target.id,
      })
    ).unchanged,
    1,
  );
  assert.equal(
    s.one(
      "SELECT count(*) n FROM file_folder_scopes WHERE folder_id=? AND scope_kind='conversation' AND scope_id=?",
      target.id,
      second,
    ).n,
    1,
  );
  folders.setOutputFolderOperation(
    async (ctx, operation, args, options = {}) => {
      if (operation === "move_file") {
        await options.guard?.();
        throw Object.assign(new Error("Provider refused"), { status: 409 });
      }
      return fakeProvider(ctx, operation, args, options);
    },
  );
  try {
    const failedPath = await organization.organizeFiles(job, {
      file_ids: [`shared_file:${shares[0]}`],
      folder_path: "Temporary/Failure",
    });
    assert.equal(failedPath.failed, 1);
  } finally {
    folders.setOutputFolderOperation(fakeProvider);
  }
  assert.equal(
    s.one(
      "SELECT count(*) n FROM file_folders WHERE company_id=? AND relative_path LIKE 'Temporary%'",
      company,
    ).n,
    0,
  );
});

test("periodic directory and file registration reuse a materialized logical child under a physical parent", async () => {
  const physical = await folders.folderCreate(
    {
      company_id: company,
      user_id: owner,
      duck_id: duck.id,
      conversation_id: mine.id,
    },
    { name: "Published", duck_id: duck.id },
  );
  const logicalId = folders.ensureOrganizingFolder(job, "Published/Review", {
    kind: "notes",
    id: duck.id,
  });
  await folders.folderMoveItem(
    { company_id: company, user_id: owner },
    logicalId,
    { kind: "notes", id: duck.id },
  );
  const upload = await createUpload(mine.id, "a.txt", true);
  const shared = s.id();
  const sourcePath = "/home/duck/tameduck/outputs/Published/Review/a.txt";
  s.run(
    `INSERT INTO shared_files(id,company_id,computer_id,source_box_id,duck_id,conversation_id,user_id,message_id,
    source_path,display_name,source_dev,source_ino,source_token,current_upload_id,created,updated)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    shared,
    company,
    computer,
    "box",
    duck.id,
    mine.id,
    owner,
    s.one("SELECT message_id FROM uploads WHERE id=?", upload).message_id,
    sourcePath,
    "a.txt",
    "1",
    "2",
    JSON.stringify(["1", "2", "3", "4", "5"]),
    upload,
    s.now(),
    s.now(),
  );
  folders.registerPublishedFile(
    {
      company_id: company,
      user_id: owner,
      duck_id: duck.id,
      conversation_id: mine.id,
    },
    {
      file: {
        path: sourcePath,
        output_directory: "/home/duck/tameduck/outputs",
        computer_id: computer,
        source_box_id: "box",
      },
      shared_file_id: shared,
    },
  );
  const scan = folders.syncPublishedDirectories(
    { company_id: company },
    {
      computer_id: computer,
      source_box_id: "box",
      directories: [
        { relative_path: "Published" },
        { relative_path: "Published/Review" },
      ],
    },
  );
  assert.equal(scan.registered, 0);
  assert.equal(
    s.one(
      "SELECT count(*) n FROM file_folders WHERE company_id=? AND relative_path='Published/Review'",
      company,
    ).n,
    1,
  );
  assert.equal(
    s.one(
      "SELECT folder_id FROM file_folder_items WHERE kind='shared_file' AND item_id=?",
      shared,
    ).folder_id,
    logicalId,
  );
  assert.equal(
    s.one(
      "SELECT folder_id FROM file_folder_items WHERE kind='notes' AND item_id=?",
      duck.id,
    ).folder_id,
    logicalId,
  );
  const nestedId = folders.ensureOrganizingFolder(
    job,
    "Published/Review/Attachments",
    { kind: "notes", id: duck.id },
  );
  await folders.folderMoveItem(
    { company_id: company, user_id: owner },
    nestedId,
    { kind: "notes", id: duck.id },
  );
  const count = folders.syncPublishedFileSource({
    company_id: company,
    computer_id: computer,
    source_box_id: "box",
    old_path: "Published/Review",
    new_path: "Published/Renamed",
  });
  assert.equal(count, 2);
  assert.equal(
    s.one("SELECT relative_path,name FROM file_folders WHERE id=?", logicalId)
      .relative_path,
    "Published/Renamed",
  );
  assert.equal(
    s.one("SELECT name FROM file_folders WHERE id=?", logicalId).name,
    "Renamed",
  );
  assert.equal(
    s.one(
      "SELECT folder_id FROM file_folder_items WHERE kind='notes' AND item_id=?",
      duck.id,
    ).folder_id,
    nestedId,
  );
  assert.equal(
    s.one("SELECT relative_path FROM file_folders WHERE id=?", nestedId)
      .relative_path,
    "Published/Renamed/Attachments",
  );
  assert.equal(
    s.one("SELECT id FROM file_folders WHERE id=?", physical.id).id,
    physical.id,
  );
});

test("inventory offers accessible empty folders across this duck's chats and excludes other private or unrelated duck folders", async () => {
  const reusable = await folders.folderCreate(
    {
      company_id: company,
      user_id: owner,
      duck_id: duck.id,
      conversation_id: second,
    },
    { name: "Reusable empty", duck_id: duck.id, computer: false },
  );
  const hidden = await folders.folderCreate(
    {
      company_id: company,
      user_id: other,
      duck_id: duck.id,
      conversation_id: otherChat.id,
    },
    { name: "Other private empty", duck_id: duck.id, computer: false },
  );
  const foreignDuck = s.id();
  s.run(
    "INSERT INTO ducks(id,company_id,name,role,soul,identity,created) VALUES(?,?,?,?,?,?,?)",
    foreignDuck,
    company,
    "Another duck",
    "assistant",
    "",
    "",
    s.now(),
  );
  const unrelated = await folders.folderCreate(
    {
      company_id: company,
      user_id: owner,
      duck_id: foreignDuck,
      conversation_id: mine.id,
    },
    { name: "Unrelated duck empty", duck_id: foreignDuck, computer: false },
  );
  const inventory = organization.listOrganizableFiles(job);
  assert(inventory.folders.some((folder) => folder.id === reusable.id));
  assert(!inventory.folders.some((folder) => folder.id === hidden.id));
  assert(!inventory.folders.some((folder) => folder.id === unrelated.id));
  const exportId = await createUpload(second, "cross-chat.csv", true);
  const moved = await organization.organizeFiles(job, {
    file_ids: [`upload:${exportId}`],
    folder_id: reusable.id,
  });
  assert.equal(moved.moved, 1, JSON.stringify(moved));
  assert.equal(
    s.one(
      "SELECT folder_id FROM file_folder_items WHERE kind='upload' AND item_id=?",
      exportId,
    ).folder_id,
    reusable.id,
  );
});

test("ticket-associated documents and uploads appear with exact move eligibility", async () => {
  const taskId = s.id();
  s.run(
    "INSERT INTO tasks(id,company_id,title,creator_id,created,updated) VALUES(?,?,?,?,?,?)",
    taskId,
    company,
    "Document ticket",
    owner,
    s.now(),
    s.now(),
  );
  const doc = s.id();
  s.run(
    "INSERT INTO documents(id,company_id,title,content,user_id,created,updated) VALUES(?,?,?,?,?,?,?)",
    doc,
    company,
    "Ticket memo",
    "Text",
    owner,
    s.now(),
    s.now(),
  );
  s.run(
    "INSERT INTO ticket_activity(company_id,task_id,kind,action,body,user_id,document_id,source_key,created) VALUES(?,?,?,?,?,?,?,?,?)",
    company,
    taskId,
    "document",
    "Created document",
    "Ticket memo",
    owner,
    doc,
    `doc:${doc}`,
    s.now(),
  );
  const ticketJob = { ...job, task_id: taskId };
  const entry = organization
    .listOrganizableFiles(ticketJob)
    .files.find((file) => file.file_id === `document:${doc}`);
  assert(entry);
  assert(entry.task_ids.includes(taskId));
  const upload = await createUpload(mine.id, "owner-ticket.txt");
  s.run(
    "INSERT INTO task_uploads(upload_id,company_id,task_id,created) VALUES(?,?,?,?)",
    upload,
    company,
    taskId,
    s.now(),
  );
  const own = uploads
    .taskFiles(company, taskId, { user_id: owner, task_id: taskId, id: "test" })
    .find((file) => file.id === upload);
  const teammate = uploads
    .taskFiles(company, taskId, { user_id: other, task_id: taskId, id: "test" })
    .find((file) => file.id === upload);
  assert.equal(own.file_id, `upload:${upload}`);
  assert.equal(own.can_move, true);
  assert.equal(teammate.can_move, false);
  assert(teammate.move_reason);
});

const createSharedForRollback = async (name) => {
  const upload = await createUpload(mine.id, name, true);
  const shared = s.id();
  const source = `/home/duck/tameduck/outputs/${name}`;
  s.run(
    `INSERT INTO shared_files(id,company_id,computer_id,source_box_id,duck_id,conversation_id,user_id,message_id,
    source_path,display_name,source_dev,source_ino,source_token,current_upload_id,created,updated)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    shared,
    company,
    computer,
    "box",
    duck.id,
    mine.id,
    owner,
    s.one("SELECT message_id FROM uploads WHERE id=?", upload).message_id,
    source,
    name,
    "1",
    "2",
    JSON.stringify(["1", "2", "3", "4", "5"]),
    upload,
    s.now(),
    s.now(),
  );
  s.run(
    "INSERT INTO shared_file_versions VALUES(?,?,?,?)",
    shared,
    upload,
    1,
    s.now(),
  );
  return { shared, source };
};

test("failed linked move preserves an unregistered preexisting directory", async () => {
  const { shared, source } = await createSharedForRollback(
    "rollback-existing.txt",
  );
  const calls = [];
  folders.setOutputFolderOperation(async (_ctx, op, args, { guard } = {}) => {
    calls.push({ op, path: args.path });
    await guard?.();
    if (op === "move_file") throw new Error("provider move failed");
    return { created: false, computer_id: computer, source_box_id: "box" };
  });
  try {
    const result = await organization.organizeFiles(job, {
      file_ids: [`shared_file:${shared}`],
      folder_path: "Existing disk/Empty",
    });
    assert.equal(result.failed, 1, JSON.stringify(result));
    assert.deepEqual(
      calls.filter((call) => call.op === "delete"),
      [],
    );
    assert.equal(
      s.one("SELECT source_path FROM shared_files WHERE id=?", shared)
        .source_path,
      source,
    );
    assert.equal(
      s.one(
        "SELECT count(*) n FROM file_folders WHERE relative_path LIKE 'Existing disk%'",
      ).n,
      0,
    );
  } finally {
    folders.setOutputFolderOperation(fakeProvider);
  }
});

test("partial provider creation failure removes only newly created directories", async () => {
  const { shared, source } = await createSharedForRollback(
    "rollback-partial.txt",
  );
  const calls = [];
  folders.setOutputFolderOperation(async (_ctx, op, args, { guard } = {}) => {
    calls.push({ op, path: args.path });
    await guard?.();
    if (op === "create" && args.path === "Partial/Second")
      throw new Error("second directory failed");
    return {
      created: op === "create",
      computer_id: computer,
      source_box_id: "box",
    };
  });
  try {
    const result = await organization.organizeFiles(job, {
      file_ids: [`shared_file:${shared}`],
      folder_path: "Partial/Second",
    });
    assert.equal(result.failed, 1, JSON.stringify(result));
    assert.deepEqual(
      calls.filter((call) => call.op === "delete"),
      [{ op: "delete", path: "Partial" }],
    );
    assert.equal(
      s.one("SELECT source_path FROM shared_files WHERE id=?", shared)
        .source_path,
      source,
    );
    assert.equal(
      s.one(
        "SELECT count(*) n FROM file_folders WHERE relative_path LIKE 'Partial%'",
      ).n,
      0,
    );
  } finally {
    folders.setOutputFolderOperation(fakeProvider);
  }
});

test("a delegated child artifact can publish its original-chat capture", async () => {
  const childChat = s.id();
  s.run(
    "INSERT INTO conversations(id,company_id,name,kind,creator_id,created) VALUES(?,?,?,?,?,?)",
    childChat,
    company,
    "Delegated child",
    "direct",
    owner,
    s.now(),
  );
  s.run("INSERT INTO conversation_members VALUES(?,?)", childChat, owner);
  s.run("INSERT INTO conversation_ducks VALUES(?,?)", childChat, duck.id);
  const capture = s.id();
  s.run(
    "INSERT INTO computer_captures VALUES(?,?,?,?,?,?,?)",
    capture,
    company,
    mine.id,
    computer,
    "Delegated screenshot",
    "ciphertext",
    s.now(),
  );
  const childMessage = s.addMessage(company, childChat, "child output", {
    duck: duck.id,
  });
  s.run(
    "INSERT INTO message_artifacts VALUES(?,?,?,?,?,?,?,?)",
    s.id(),
    company,
    childMessage,
    "screenshot",
    capture,
    "Delegated screenshot",
    "Shared",
    s.now(),
  );
  const entry = organization
    .listOrganizableFiles(job)
    .files.find((file) => file.file_id === `screenshot:${capture}`);
  assert(entry);
  assert.equal(entry.can_move, true, JSON.stringify(entry));
  const result = await organization.organizeFiles(job, {
    file_ids: [`screenshot:${capture}`],
    folder_path: "Delegated captures",
  });
  assert.equal(result.moved, 1, JSON.stringify(result));
  assert.equal(
    s.one("SELECT conversation_id FROM computer_captures WHERE id=?", capture)
      .conversation_id,
    mine.id,
  );
});

test("an unknown file_id gives exact relist guidance without guessing a nearby file", async () => {
  const exact = organization
    .listOrganizableFiles(job)
    .files.find((file) => file.file_id === `notes:${duck.id}`);
  assert(exact?.can_move);
  const guessed = `notes:${s.id()}`;
  const missing = await organization.organizeFiles(job, {
    file_ids: [guessed],
    folder_path: "Recovery notes",
  });
  assert.equal(missing.failed, 1);
  assert.equal(missing.results[0].file_id, guessed);
  assert.equal(missing.results[0].error_code, "file_not_found");
  assert.match(
    missing.results[0].error,
    /Call file_list, copy the exact file_id/,
  );
  assert.equal(missing.results[0].status, "failed");
  assert.equal(
    s.one("SELECT 1 FROM file_folders WHERE relative_path='Recovery notes'"),
    undefined,
  );
  const retry = await organization.organizeFiles(job, {
    file_ids: [exact.file_id],
    folder_path: "Recovery notes",
  });
  assert.equal(retry.moved, 1, JSON.stringify(retry));
});
