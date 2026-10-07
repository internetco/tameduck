import { after, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import express from "express";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "folder-linked-"));
process.env.DATA_DIR = path.join(temporary, "data");
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
const s = await import("../server/store.mjs");
const uploads = await import("../server/uploads.mjs");
const folders = await import("../server/file-folders.mjs");
const { mutateComputerOutputFolder } =
  await import("../server/computer-output-folders.mjs");
const { readComputerFile } = await import("../server/computer-file-export.mjs");
const activity = await import("../server/ticket-activity.mjs");
const linked = await import("../server/shared-files.mjs");
const home = path.join(temporary, "guest");
const outputs = path.join(home, "tameduck/outputs");
fs.mkdirSync(outputs, { recursive: true });
const provider = async (_url, _method, body) => {
  const result = spawnSync("/bin/bash", ["-c", body.command], {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 5 * 1024 * 1024,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home },
  });
  return {
    success: result.status === 0 && !result.error,
    exitCode: result.status,
    timedOut: result.error?.code === "ETIMEDOUT",
    stdout: result.stdout,
    stderr: result.stderr,
  };
};
const owner = s.id();
s.run(
  "INSERT INTO users VALUES(?,?,?,?,?,?)",
  owner,
  "folder-linked@example.test",
  "Owner",
  "unused",
  null,
  s.now(),
);
const company = s.createCompany(owner, "Folder linked regression");
const duck = s.one(
  "SELECT * FROM ducks WHERE company_id=? AND chief=1",
  company,
);
const conversation = s.directConversation(company, owner, duck);
const computerId = s.id(),
  boxId = "folder-fixture-box",
  taskId = s.id();
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
s.run(
  "INSERT INTO tasks(id,company_id,title,creator_id,created,updated) VALUES(?,?,?,?,?,?)",
  taskId,
  company,
  "Organized exports",
  owner,
  s.now(),
  s.now(),
);
const input = s.addMessage(company, conversation.id, "Publish a report", {
  user: owner,
});
const output = s.addMessage(company, conversation.id, "", { duck: duck.id });
const jobId = s.id();
s.run(
  "INSERT INTO jobs(id,company_id,user_id,conversation_id,duck_id,input_message_id,output_message_id,task_id,status,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  jobId,
  company,
  owner,
  conversation.id,
  duck.id,
  input,
  output,
  taskId,
  "running",
  s.now(),
  s.now(),
);
const job = s.tenant("jobs", jobId, company);
const context = {
  company_id: company,
  user_id: owner,
  duck_id: duck.id,
  conversation_id: conversation.id,
  task_id: taskId,
};
let operationLock = Promise.resolve();
folders.setOutputFolderOperation((ctx, operation, args, options) => {
  const action = operationLock.then(async () => {
    assert.equal(ctx.duck_id, duck.id);
    if (args.computer_id) assert.equal(args.computer_id, computerId);
    if (args.source_box_id) assert.equal(args.source_box_id, boxId);
    options.guard?.();
    const result = await mutateComputerOutputFolder({
      request: provider,
      boxId,
      operation,
      path: args.path,
      target: args.target,
      guard: options.guard,
    });
    options.guard?.();
    const bound = { ...result, computer_id: computerId, source_box_id: boxId };
    await options.commit?.(bound, options.guard);
    return bound;
  });
  operationLock = action.catch(() => {});
  return action;
});
async function publish(relative, callId) {
  const file = await readComputerFile({
    request: provider,
    boxId,
    filePath: path.join(outputs, relative),
  });
  Object.assign(file, { computer_id: computerId, source_box_id: boxId });
  const result = await uploads.publishComputerFile(job, file, {}, callId);
  activity.recordTicketFile(company, taskId, {
    uploadId: result.upload_id,
    name: result.name,
    duckId: duck.id,
    jobId,
  });
  return result;
}
const app = express();
app.use((req, _res, next) => {
  req.company = { id: company };
  req.user = { id: owner };
  req.member = s.memberFor(company, owner);
  next();
});
uploads.registerUploads(app);
app.use((error, _req, res, _next) =>
  res.status(error.status || 500).json({ error: error.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  s.db.close();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test(
  "native file moves to the output root clear placement without dropping links",
  { skip: process.platform !== "linux" },
  async () => {
    const folder = await folders.folderCreate(context, { name: "Native move" });
    fs.writeFileSync(
      path.join(outputs, "Native move/direct.txt"),
      "keep this download\n",
    );
    const shared = await publish("Native move/direct.txt", "native-file");
    const sync = () =>
      linked.syncSharedFilesForComputer(
        s.one("SELECT * FROM computers WHERE id=?", computerId),
        provider,
      );
    await sync();
    fs.renameSync(
      path.join(outputs, "Native move/direct.txt"),
      path.join(outputs, "direct.txt"),
    );
    await sync();
    await sync();
    const item = uploads
      .listFiles(company, owner)
      .find((f) => f.shared_file_id === shared.shared_file_id);
    assert.equal(item.folder_id, null);
    assert.equal(
      s.one(
        "SELECT source_path FROM shared_files WHERE id=?",
        shared.shared_file_id,
      ).source_path,
      path.join(outputs, "direct.txt"),
    );
    const download = await fetch(base + shared.url);
    assert.equal(download.status, 200);
    assert.equal(await download.text(), "keep this download\n");
    assert.equal(
      folders.folderList(context).find((f) => f.id === folder.id).can_delete,
      true,
    );
    await folders.folderDelete(context, folder.id);
  },
);

test(
  "physical folder rename and linked-file move preserve immutable downloads and ticket history",
  { skip: process.platform !== "linux" },
  async () => {
    fs.mkdirSync(path.join(outputs, "Reports/Exports"), { recursive: true });
    fs.writeFileSync(
      path.join(outputs, "Reports/Exports/report.csv"),
      "first version\n",
    );
    const first = await publish("Reports/Exports/report.csv", "first");
    const parent = folders
      .folderList(context, { task_id: taskId })
      .find((f) => f.path === "Reports");
    const child = folders
      .folderList(context, { task_id: taskId })
      .find((f) => f.path === "Reports/Exports");
    assert.ok(parent && child);
    assert.equal(
      folders.folderIdsForItems(
        company,
        [{ kind: "shared_file", shared_file_id: first.shared_file_id }],
        owner,
      )[0].folder_id,
      child.id,
    );
    const empty = await folders.folderCreate(context, {
      name: "Empty",
      parent_id: parent.id,
    });
    assert.ok(fs.statSync(path.join(outputs, "Reports/Empty")).isDirectory());
    fs.writeFileSync(
      path.join(outputs, "Reports/Exports/report.csv"),
      "second version\n",
    );
    const second = await publish("Reports/Exports/report.csv", "second");
    assert.equal(second.shared_file_id, first.shared_file_id);
    assert.notEqual(second.upload_id, first.upload_id);
    const versionIds = s
      .all(
        "SELECT upload_id FROM shared_file_versions WHERE shared_file_id=? ORDER BY version",
        first.shared_file_id,
      )
      .map((v) => v.upload_id);
    assert.equal(versionIds.length, 2);
    await folders.folderRename(context, parent.id, "Finished");
    assert.equal(
      fs.readFileSync(
        path.join(outputs, "Finished/Exports/report.csv"),
        "utf8",
      ),
      "second version\n",
    );
    assert.equal(
      s.one(
        "SELECT * FROM shared_files WHERE id=? AND company_id=?",
        first.shared_file_id,
        company,
      ).source_path,
      path.join(outputs, "Finished/Exports/report.csv"),
    );
    assert.equal(
      folders.folderList(context).find((f) => f.id === child.id).path,
      "Finished/Exports",
    );
    assert.equal(
      folders.folderList(context).find((f) => f.id === empty.id).path,
      "Finished/Empty",
    );
    const destination = await folders.folderCreate(context, {
      name: "Delivery",
    });
    await folders.folderMoveItem(context, destination.id, {
      kind: "shared_file",
      id: first.shared_file_id,
    });
    assert.equal(
      fs.existsSync(path.join(outputs, "Finished/Exports/report.csv")),
      false,
    );
    assert.equal(
      fs.readFileSync(path.join(outputs, "Delivery/report.csv"), "utf8"),
      "second version\n",
    );
    assert.equal(
      s.one(
        "SELECT * FROM shared_files WHERE id=? AND company_id=?",
        first.shared_file_id,
        company,
      ).current_upload_id,
      second.upload_id,
    );
    assert.deepEqual(
      s
        .all(
          "SELECT upload_id FROM shared_file_versions WHERE shared_file_id=? ORDER BY version",
          first.shared_file_id,
        )
        .map((v) => v.upload_id),
      versionIds,
    );
    const current = await fetch(base + first.url);
    assert.equal(current.status, 200);
    assert.equal(await current.text(), "second version\n");
    const old = await fetch(
      base + `/api/uploads/${first.upload_id}?download=1`,
    );
    assert.equal(old.status, 200);
    assert.equal(await old.text(), "first version\n");
    assert.deepEqual(
      uploads
        .taskFiles(company, taskId)
        .filter((f) => f.shared_file_id === first.shared_file_id)
        .map((f) => f.id)
        .sort(),
      [first.upload_id, second.upload_id].sort(),
    );
    const listed = uploads
      .listFiles(company, owner)
      .filter(
        (f) =>
          f.kind === "shared_file" && f.shared_file_id === first.shared_file_id,
      );
    assert.equal(listed.length, 1);
    assert.equal(listed[0].shared_file_id, first.shared_file_id);
    assert.equal(listed[0].folder_id, destination.id);
    await assert.rejects(
      folders.folderDelete(context, destination.id),
      (e) => e.status === 409,
    );
    fs.writeFileSync(
      path.join(outputs, "Finished/Exports/.unpublished"),
      "private draft",
    );
    await assert.rejects(
      folders.folderDelete(context, child.id),
      (e) => e.status === 409,
    );
    assert.equal(
      fs.readFileSync(
        path.join(outputs, "Finished/Exports/.unpublished"),
        "utf8",
      ),
      "private draft",
    );
    fs.unlinkSync(path.join(outputs, "Finished/Exports/.unpublished"));
    await folders.folderDelete(context, child.id);
    await folders.folderDelete(context, empty.id);
    await folders.folderDelete(context, parent.id);
    assert.equal(fs.existsSync(path.join(outputs, "Finished")), false);
    assert.equal((await fetch(base + first.url)).status, 200);
  },
);
