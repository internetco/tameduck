import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "folder-tools-"));
process.env.DATA_DIR = temporary;
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
const s = await import("../server/store.mjs");
const { handleTool, enqueue, dynamicTools } = await import("../server/duck-tools.mjs");
const { consultationTools } = await import("../server/duck-consultations.mjs");
const folders = await import("../server/file-folders.mjs");
const { ticketDocuments } = await import("../server/ticket-activity.mjs");
const user = s.id();
s.run("INSERT INTO users VALUES(?,?,?,?,?,?)", user, "folder-tools@example.test", "Folder Tester", "unused", null, s.now());
const company = s.createCompany(user, "Folder tools");
const duck = s.one("SELECT * FROM ducks WHERE company_id=? AND chief=1", company);
const conv = s.directConversation(company, user, duck);
const message = s.addMessage(company, conv.id, "Organize my saved documents", { user });
const jobId = enqueue(company, user, conv.id, duck.id, message);
s.run("UPDATE jobs SET status='running' WHERE id=?", jobId);
const job = s.tenant("jobs", jobId, company);
const call = (tool, args, receipt = s.id(), context = job) => handleTool(context, tool, args, receipt);
const save = (title, folderId, context = job) => call("document_save", {
  id: "", title, content: "Original contents", updated: "", task_id: "", folder_id: folderId,
}, s.id(), context);
after(() => { s.db.close(); fs.rmSync(temporary, {recursive:true, force:true}); });

test("folder tools are available to delegated ducks and old save schemas remain valid", () => {
  const names = ["folder_list", "folder_create", "folder_rename", "folder_delete", "file_move"];
  const delegated = new Set(consultationTools(dynamicTools).map(t => t.name));
  for (const name of names) {
    const tool = dynamicTools.find(t => t.name === name);
    assert.ok(tool?.inputSchema && typeof tool.description === "string", name);
    assert.ok(delegated.has(name), name);
  }
  for (const name of ["document_save", "computer_export_file"]) {
    const schema = dynamicTools.find(t => t.name === name).inputSchema;
    assert.equal(schema.properties.folder_id.type, "string");
    assert.equal(schema.required.includes("folder_id"), false);
  }
});

test("duck can retain an empty folder, save and move a document, then delete only the empty folder", async () => {
  const receipt = s.id();
  const first = await call("folder_create", {name:"Reports", computer:false}, receipt);
  assert.equal((await call("folder_create", {name:"Reports", computer:false}, receipt)).id, first.id);
  assert.ok((await call("folder_list", {})).folders.some(f => f.id === first.id));
  const doc = await save("Monthly report", first.id);
  assert.equal(doc.folder_id, first.id);
  const read = await call("document_read", {id:doc.id});
  assert.equal(read.folder_id, first.id);
  await assert.rejects(call("folder_delete", {id:first.id}), e => e.status === 409);
  await call("folder_rename", {id:first.id, name:"Finished reports"});
  assert.equal((await call("document_read", {id:doc.id})).folder_id, first.id);
  await call("file_move", {kind:"document", id:doc.id, folder_id:""});
  assert.equal((await call("document_read", {id:doc.id})).folder_id, null);
  assert.ok((await call("folder_list", {})).folders.some(f => f.id === first.id));
  await call("folder_delete", {id:first.id});
  assert.equal((await call("folder_list", {})).folders.some(f => f.id === first.id), false);
  assert.equal(s.tenant("documents", doc.id, company).content, "Original contents");
});

test("ticket folders remain visible empty and document placement preserves its ticket history", async () => {
  const task = s.id();
  s.run("INSERT INTO tasks(id,company_id,title,creator_id,created,updated) VALUES(?,?,?,?,?,?)", task, company, "Folder ticket", user, s.now(), s.now());
  const ticketJob = {...job, task_id:task};
  const folder = await call("folder_create", {name:"Ticket reports", computer:false}, s.id(), ticketJob);
  assert.ok(folders.folderList({company_id:company,user_id:user}, {task_id:task}).some(f => f.id === folder.id));
  const doc = await save("Ticket document", folder.id, ticketJob);
  assert.ok(ticketDocuments(company, task).some(d => d.id === doc.id));
  await call("file_move", {kind:"document",id:doc.id,folder_id:""}, s.id(), ticketJob);
  assert.ok(ticketDocuments(company, task).some(d => d.id === doc.id));
  assert.ok(folders.folderList({company_id:company,user_id:user}, {task_id:task}).some(f => f.id === folder.id));
});

test("invalid folder destinations are rejected before document creation or editing", async () => {
  const before = s.one("SELECT count(*) n FROM documents WHERE company_id=?", company).n;
  await assert.rejects(save("Should not exist", s.id()), e => e.status === 404 || e.status === 403);
  assert.equal(s.one("SELECT count(*) n FROM documents WHERE company_id=?", company).n, before);
  const otherCompany = s.createCompany(user, "Other folder company");
  const other = await folders.folderCreate({company_id:otherCompany,user_id:user}, {name:"Other",computer:false});
  await assert.rejects(save("Cross company", other.id), e => e.status === 404 || e.status === 403);
  assert.equal(s.one("SELECT count(*) n FROM documents WHERE company_id=?", company).n, before);
});

test("a stale document save cannot move the document or replace newer text", async () => {
  const a = await call("folder_create", {name:"First destination", computer:false});
  const b = await call("folder_create", {name:"Second destination", computer:false});
  const doc = await save("Concurrent document", a.id);
  const original = await call("document_read", {id:doc.id});
  await call("document_save", {id:doc.id,title:doc.title,content:"Newer text",updated:original.updated,task_id:""});
  await assert.rejects(call("document_save", {id:doc.id,title:doc.title,content:"Stale text",updated:original.updated,task_id:"",folder_id:b.id}), e => e.status === 409);
  const current = await call("document_read", {id:doc.id});
  assert.equal(current.content, "Newer text");
  assert.equal(current.folder_id, a.id);
});

test("folder mutation receipts recheck current human permissions", async () => {
  const receipt = s.id();
  await call("folder_create", {name:"Permission check", computer:false}, receipt);
  s.run("UPDATE memberships SET role='admin',permissions=? WHERE company_id=? AND user_id=?", JSON.stringify({docs:false}),company,user);
  try {
    await assert.rejects(call("folder_create", {name:"Permission check", computer:false}, receipt), e => e.status === 403);
  } finally {
    s.run("UPDATE memberships SET role='owner',permissions='{}' WHERE company_id=? AND user_id=?",company,user);
  }
});

test("computer export validates a destination before the shared file exists", async () => {
  const oldApiKey = process.env.ASCII_API_KEY;
  delete process.env.ASCII_API_KEY;
  try {
    const computer = s.id();
    const box = "folder-export-preflight-box";
    s.run(
      "INSERT INTO computers(id,company_id,duck_id,box_id,state,bootstrapped,created,updated) VALUES(?,?,?,?,?,?,?,?)",
      computer,
      company,
      duck.id,
      box,
      "ready",
      1,
      s.now(),
      s.now(),
    );
    const physicalId = s.id();
    s.run(
      `INSERT INTO file_folders(id,company_id,parent_id,namespace_key,name,name_key,relative_path,path_key,
        duck_id,computer_id,source_box_id,source_token,physical,created_by,created,updated)
       VALUES(?,?,NULL,?,?,?,?,?,?,?,?,NULL,1,?,?,?)`,
      physicalId,
      company,
      `physical:${computer}:${box}`,
      "Existing",
      "Existing",
      "Existing",
      "Existing",
      duck.id,
      computer,
      box,
      user,
      s.now(),
      s.now(),
    );
    s.run(
      "INSERT INTO file_folder_scopes(folder_id,scope_kind,scope_id,created) VALUES(?,?,?,?)",
      physicalId,
      "company",
      company,
      s.now(),
    );

    const before = s.one(
      "SELECT count(*) n FROM shared_files WHERE company_id=?",
      company,
    ).n;
    await assert.rejects(
      call("computer_export_file", {
        path: "/home/folder/tameduck/outputs/Existing/finished.txt",
        folder_id: physicalId,
      }),
      (error) => error.status === 503,
    );
    assert.equal(
      s.one("SELECT count(*) n FROM shared_files WHERE company_id=?", company).n,
      before,
      "destination validation must happen before publication",
    );

    const appFolder = await call("folder_create", {
      name: "App folder", computer: false,
    });
    await assert.rejects(
      call("computer_export_file", {
        path: "/home/folder/tameduck/outputs/App folder/finished.txt",
        folder_id: appFolder.id,
      }),
      (error) => error.status === 409,
      "a computer export cannot target an app-only folder",
    );

    const otherCompany = s.createCompany(user, "Other export workspace");
    const foreign = await folders.folderCreate(
      { company_id: otherCompany, user_id: user },
      { name: "Foreign folder", computer: false },
    );
    await assert.rejects(
      call("computer_export_file", {
        path: "/home/folder/tameduck/outputs/Foreign folder/finished.txt",
        folder_id: foreign.id,
      }),
      (error) => error.status === 404,
      "a computer export cannot target another workspace's folder",
    );

    for (const args of [
      { path: "/home/folder/tameduck/outputs/file.txt", folder_id: "bad-id" },
      { path: "/home/folder/tameduck/outputs/file.txt", shared_file_id: "bad-id" },
    ])
      await assert.rejects(
        call("computer_export_file", args),
        (error) => error.name === "ZodError",
      );

    // Provider authorization is the next step after preflight. Empty optional IDs
    // are treated as omitted, while nonempty malformed IDs still fail parsing.
    await assert.rejects(
      call("computer_export_file", {
        path: "/home/folder/tameduck/outputs/file.txt",
        folder_id: "",
        shared_file_id: "",
      }),
      (error) => error.status === 503,
    );
  } finally {
    if (oldApiKey === undefined) delete process.env.ASCII_API_KEY;
    else process.env.ASCII_API_KEY = oldApiKey;
  }
});
