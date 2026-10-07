import { after, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "file-folders-test-"));
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
const s = await import("../server/store.mjs");
const uploads = await import("../server/uploads.mjs");
const folders = await import("../server/file-folders.mjs");

const owner = s.id();
const teammate = s.id();
const outsider = s.id();
for (const [user, name] of [
  [owner, "Owner"],
  [teammate, "Teammate"],
  [outsider, "Outsider"],
])
  s.run(
    "INSERT INTO users VALUES(?,?,?,?,?,?)",
    user,
    `${name.toLowerCase()}@example.test`,
    name,
    "unused",
    null,
    s.now(),
  );
const company = s.createCompany(owner, "Folder tests");
s.run(
  "INSERT INTO memberships VALUES(?,?,?,?)",
  company,
  teammate,
  "member",
  "{}",
);
const otherCompany = s.createCompany(outsider, "Elsewhere");
const duck = s.one(
  "SELECT * FROM ducks WHERE company_id=? AND chief=1",
  company,
);
const ownerConversation = s.directConversation(company, owner, duck);
const teammateConversation = s.directConversation(company, teammate, duck);
const task = {
  id: s.id(),
  title: "Folder ticket",
};
s.run(
  "INSERT INTO tasks(id,company_id,title,creator_id,created,updated) VALUES(?,?,?,?,?,?)",
  task.id,
  company,
  task.title,
  owner,
  s.now(),
  s.now(),
);
const computerId = s.id();
const boxId = "box-folders";
s.run(
  "INSERT INTO computers(id,company_id,duck_id,box_id,state,bootstrapped,created,updated) VALUES(?,?,?,?,?,?,?,?)",
  computerId,
  company,
  duck.id,
  boxId,
  "ready",
  1,
  s.now(),
  s.now(),
);
const operations = [];
const fakeOutput = async (context, operation, args, { commit, guard } = {}) => {
  operations.push({ context, operation, args });
  await guard?.();
  const result = {
    computer_id: computerId,
    source_box_id: boxId,
    output_directory: "/home/duck/tameduck/outputs",
    result: {
      path: `/home/duck/tameduck/outputs/${args.target || args.path}`,
      output_directory: "/home/duck/tameduck/outputs",
    },
  };
  if (commit) commit(result, () => {});
  return result;
};
folders.setOutputFolderOperation(fakeOutput);
const context = (extra = {}) => ({
  company_id: company,
  user_id: owner,
  ...extra,
});

after(() => {
  s.db.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test("empty ticket and private chat folders keep explicit isolated scopes", async () => {
  const ticketFolder = await folders.folderCreate(
    context({ task_id: task.id }),
    { name: "Empty ticket", computer: false },
  );
  assert.deepEqual(ticketFolder.task_ids, [task.id]);
  assert.equal(
    folders.folderList(context({ user_id: teammate }), { task_id: task.id })[0]
      .id,
    ticketFolder.id,
  );

  const privateFolder = await folders.folderCreate(
    context({ conversation_id: ownerConversation.id }),
    { name: "Owner private", computer: false },
  );
  assert.equal(
    folders
      .folderList(context({ user_id: teammate }), {
        conversation_id: teammateConversation.id,
      })
      .some((folder) => folder.id === privateFolder.id),
    false,
  );
  assert.throws(
    () =>
      folders.validateFolder(
        { company_id: otherCompany, user_id: outsider },
        privateFolder.id,
      ),
    /unavailable/,
  );
  assert.deepEqual(
    await folders.folderDelete(context({ task_id: task.id }), ticketFolder.id),
    {
      deleted: true,
      id: ticketFolder.id,
    },
  );
});

test("app namespaces reject folded collisions and invalid paths", async () => {
  await folders.folderCreate(context({ task_id: task.id }), {
    name: "Planning",
    task_id: task.id,
    computer: false,
  });
  await assert.rejects(
    folders.folderCreate(context({ task_id: task.id }), {
      name: "planning",
      task_id: task.id,
      computer: false,
    }),
    /already exists/,
  );
  await assert.rejects(
    folders.folderCreate(context({ task_id: task.id }), {
      name: "../escape",
      task_id: task.id,
      computer: false,
    }),
  );
});

test("physical paths preserve case and decomposed Unicode and commit inside the computer lock", async () => {
  const upper = await folders.folderCreate(context(), {
    name: "Reports",
    duck_id: duck.id,
  });
  const lower = await folders.folderCreate(context(), {
    name: "reports",
    duck_id: duck.id,
  });
  const decomposed = "Cafe\u0301";
  const unicode = await folders.folderCreate(context(), {
    name: decomposed,
    duck_id: duck.id,
  });
  assert.notEqual(upper.id, lower.id);
  assert.equal(unicode.path, decomposed);
  assert.deepEqual(
    operations
      .filter((entry) => entry.operation === "create")
      .map((entry) => entry.args.path),
    ["Reports", "reports", decomposed],
  );
  const renamed = await folders.folderRename(
    context(),
    unicode.id,
    "CAFE\u0301",
  );
  assert.equal(renamed.path, "CAFE\u0301");
  assert.equal(operations.at(-1).operation, "rename");
});

test("document placement changes only metadata and keeps ticket history", async () => {
  const folder = await folders.folderCreate(context({ task_id: task.id }), {
    name: "Drafts",
    task_id: task.id,
    computer: false,
  });
  const documentId = s.id();
  s.run(
    "INSERT INTO documents(id,company_id,title,content,user_id,created,updated) VALUES(?,?,?,?,?,?,?)",
    documentId,
    company,
    "Draft",
    "Text",
    owner,
    s.now(),
    s.now(),
  );
  s.run(
    "INSERT INTO ticket_activity(company_id,task_id,kind,action,body,user_id,document_id,source_key,created) VALUES(?,?,?,?,?,?,?,?,?)",
    company,
    task.id,
    "document",
    "Created document",
    "Draft",
    owner,
    documentId,
    `document:test:${documentId}`,
    s.now(),
  );
  folders.documentFolder(context({ task_id: task.id }), documentId, folder.id);
  assert.equal(
    folders.folderIdsForItems(
      company,
      [{ kind: "document", id: documentId }],
      context({ task_id: task.id, id: "job" }),
    )[0].folder_id,
    folder.id,
  );
  assert.equal(
    s.one(
      "SELECT count(*) n FROM ticket_activity WHERE document_id=?",
      documentId,
    ).n,
    1,
  );
  folders.documentFolder(context({ task_id: task.id }), documentId, null);
  assert.equal(
    s.one(
      "SELECT count(*) n FROM ticket_activity WHERE document_id=?",
      documentId,
    ).n,
    1,
  );
});

test("physical delete rechecks a concurrent placement before committing metadata", async () => {
  const folder = await folders.folderCreate(context(), {
    name: "Delete race",
    duck_id: duck.id,
  });
  const documentId = s.id();
  s.run(
    "INSERT INTO documents(id,company_id,title,content,user_id,created,updated) VALUES(?,?,?,?,?,?,?)",
    documentId,
    company,
    "Arriving",
    "Text",
    owner,
    s.now(),
    s.now(),
  );
  folders.setOutputFolderOperation(
    async (ctx, operation, args, options = {}) => {
      await options.guard?.();
      s.run(
        "INSERT INTO file_folder_items(company_id,folder_id,kind,item_id,created) VALUES(?,?,?,?,?)",
        company,
        folder.id,
        "document",
        documentId,
        s.now(),
      );
      await options.guard?.();
      return fakeOutput(ctx, operation, args, options);
    },
  );
  await assert.rejects(
    folders.folderDelete(context(), folder.id),
    /must be empty/,
  );
  assert.ok(s.one("SELECT 1 FROM file_folders WHERE id=?", folder.id));
  assert.ok(
    s.one("SELECT 1 FROM file_folder_items WHERE folder_id=?", folder.id),
  );
  folders.setOutputFolderOperation(fakeOutput);
});

test("deleting the last document does not leave a stale placement blocking its folder", async () => {
  const folder = await folders.folderCreate(context({ task_id: task.id }), {
    name: "Disposable",
    task_id: task.id,
    computer: false,
  });
  const documentId = s.id();
  s.run(
    "INSERT INTO documents(id,company_id,title,content,user_id,created,updated) VALUES(?,?,?,?,?,?,?)",
    documentId,
    company,
    "Temporary",
    "Text",
    owner,
    s.now(),
    s.now(),
  );
  folders.documentFolder(context({ task_id: task.id }), documentId, folder.id);
  s.run(
    "DELETE FROM documents WHERE id=? AND company_id=?",
    documentId,
    company,
  );
  assert.deepEqual(
    await folders.folderDelete(context({ task_id: task.id }), folder.id),
    { deleted: true, id: folder.id },
  );
  assert.equal(
    s.one("SELECT 1 FROM file_folder_items WHERE folder_id=?", folder.id),
    undefined,
  );
});

async function storedFile(conversation, user, name, bytes) {
  const upload = await uploads.storeUpload(
    company,
    conversation.id,
    user,
    name,
    Readable.from(bytes),
    { allowEmpty: true },
  );
  const message = s.addMessage(company, conversation.id, name, { user });
  s.run("UPDATE uploads SET message_id=? WHERE id=?", message, upload.id);
  return { upload, message };
}

test("hidden private source grants prevent a physical move", async () => {
  const target = await folders.folderCreate(context(), {
    name: "Archive",
    duck_id: duck.id,
  });
  const first = await storedFile(ownerConversation, owner, "report.txt", "one");
  const second = await storedFile(
    teammateConversation,
    teammate,
    "report.txt",
    "two",
  );
  const sourcePath = "/home/duck/tameduck/outputs/report.txt";
  const makeShared = ({ upload, message }, user, conversation) => {
    const sharedId = s.id();
    s.run(
      `INSERT INTO shared_files(id,company_id,computer_id,source_box_id,duck_id,conversation_id,user_id,message_id,
       source_path,display_name,source_dev,source_ino,source_token,current_upload_id,created,updated)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      sharedId,
      company,
      computerId,
      boxId,
      duck.id,
      conversation.id,
      user,
      message,
      sourcePath,
      "report.txt",
      "1",
      "2",
      JSON.stringify(["1", "2", "3", "4", "5"]),
      upload.id,
      s.now(),
      s.now(),
    );
    return sharedId;
  };
  const ownerShare = makeShared(first, owner, ownerConversation);
  makeShared(second, teammate, teammateConversation);
  await assert.rejects(
    folders.folderMoveItem(context(), target.id, {
      kind: "shared_file",
      id: ownerShare,
    }),
    /Every private share|not a member of this conversation/,
  );
  assert.equal(
    s.one("SELECT source_path FROM shared_files WHERE id=?", ownerShare)
      .source_path,
    sourcePath,
  );
  assert.equal(operations.at(-1).operation, "create");
});
