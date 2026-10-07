import crypto from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { Readable } from "node:stream";
import {
  db,
  id,
  now,
  one,
  all,
  run,
  can,
  fail,
  tenant,
  conversationFor,
  memberFor,
  permissions,
  emit,
  audit,
} from "./store.mjs";
import { consultationVisibleJob } from "./duck-consultations.mjs";
import { attachArtifact } from "./artifacts.mjs";
import { storeUpload, readUpload, discardUnlinkedUpload } from "./uploads.mjs";
import {
  registerPublishedFile,
  syncPublishedDirectories,
} from "./file-folders.mjs";
import {
  readComputerFile,
  scanComputerOutputTree,
} from "./computer-file-export.mjs";

const uuid = z.string().uuid();
const locks = new Map();
async function serialized(key, action) {
  const prior = locks.get(key) || Promise.resolve();
  let release;
  const done = new Promise((resolve) => {
    release = resolve;
  });
  locks.set(key, done);
  await prior;
  try {
    return await action();
  } finally {
    release();
    if (locks.get(key) === done) locks.delete(key);
  }
}
const stableUrl = (id) => `/api/shared-files/${id}?download=1`;
const versionUrl = (id) => `/api/uploads/${id}?download=1`;
const sameToken = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function verifiedSource(file) {
  if (
    !file?.verified ||
    !file.stream ||
    !Number.isSafeInteger(file.size) ||
    !file.computer_id ||
    !file.source_box_id ||
    !Array.isArray(file.source_token) ||
    file.source_token.length !== 5 ||
    file.source_token.some(
      (part) => typeof part !== "string" || !/^\d+$/.test(part),
    ) ||
    typeof file.path !== "string" ||
    !path.posix.isAbsolute(file.path) ||
    !file.output_directory ||
    !file.path.startsWith(file.output_directory + "/")
  )
    fail(502, "The computer did not verify this file.");
}
function verifyComputerBinding(job, file) {
  const computer = one(
    "SELECT company_id,duck_id,box_id,state FROM computers WHERE id=?",
    file.computer_id,
  );
  if (
    !computer ||
    computer.company_id !== job.company_id ||
    computer.duck_id !== job.duck_id ||
    computer.box_id !== file.source_box_id ||
    !["ready", "idle", "running"].includes(computer.state)
  )
    fail(409, "The computer changed while this file was being shared.");
}
function findSource(
  {
    company_id,
    computer_id,
    source_box_id,
    conversation_id,
    task_id,
    path: sourcePath,
    source_token,
  },
  preferredId = null,
) {
  const candidates = all(
    `SELECT * FROM shared_files WHERE company_id=? AND computer_id=? AND source_box_id=?
     AND conversation_id=? AND task_id IS ? ORDER BY updated DESC`,
    company_id,
    computer_id,
    source_box_id,
    conversation_id,
    task_id || null,
  );
  const byPath = candidates.find((row) => row.source_path === sourcePath);
  const byInode = candidates.find(
    (row) =>
      row.missing_count < 2 &&
      row.source_dev === source_token[0] &&
      row.source_ino === source_token[1],
  );
  if (preferredId) {
    const chosen = candidates.find((row) => row.id === preferredId);
    if (!chosen || (chosen !== byPath && chosen !== byInode))
      fail(
        409,
        "That linked file does not match this computer source and conversation.",
      );
    return chosen;
  }
  if (byPath && byInode && byPath.id !== byInode.id)
    fail(
      409,
      "This source is ambiguous. Export it again with shared_file_id to choose the linked file.",
    );
  // Exact path supports atomic replacement. Device and inode support rename.
  return byPath || byInode || null;
}
function linkedResult(shared, upload) {
  return {
    exported: true,
    shared_file_id: shared.id,
    upload_id: upload.id,
    name: upload.name,
    mime: upload.mime,
    size: upload.size,
    sha256: upload.sha256,
    url: stableUrl(shared.id),
    download_url: stableUrl(shared.id),
    version_download_url: versionUrl(upload.id),
    ...(shared.task_id ? { task_id: shared.task_id } : {}),
    instruction:
      "The file is attached to your reply. Its private link always downloads the latest saved version; mention it by name in your reply.",
  };
}
export function priorLinkedExport(job, callId) {
  const row = one(
    `SELECT s.*,u.id upload_id,u.name upload_name,u.mime upload_mime,u.size upload_size,u.sha256 upload_sha256
     FROM shared_file_exports e JOIN shared_files s ON s.id=e.shared_file_id
     JOIN uploads u ON u.id=e.upload_id WHERE e.job_id=? AND e.call_id=? AND s.company_id=?`,
    job.id,
    callId,
    job.company_id,
  );
  if (!row) return null;
  return linkedResult(row, {
    id: row.upload_id,
    name: row.upload_name,
    mime: row.upload_mime,
    size: row.upload_size,
    sha256: row.upload_sha256,
  });
}
export async function publishLinkedComputerFile(
  job,
  file,
  args,
  callId,
  guard = async () => {},
) {
  const prior = priorLinkedExport(job, callId);
  if (prior) return prior;
  verifiedSource(file);
  verifyComputerBinding(job, file);
  return serialized(
    `${job.company_id}\0${file.computer_id}\0${file.source_box_id}`,
    async () => {
      const again = priorLinkedExport(job, callId);
      if (again) return again;
      verifyComputerBinding(job, file);
      const visibleJob = consultationVisibleJob(job);
      const conversation = tenant(
        "conversations",
        job.conversation_id,
        job.company_id,
      );
      conversationFor(visibleJob.conversation_id, job.company_id, job.user_id);
      const output = one(
        "SELECT id FROM messages WHERE id=? AND company_id=? AND conversation_id=?",
        job.output_message_id,
        job.company_id,
        conversation.id,
      );
      if (!output) fail(409, "This run has no reply to attach the file to.");
      const task = job.task_id
        ? tenant("tasks", job.task_id, job.company_id)
        : null;
      const name = String(args?.name || file.name || "")
        .normalize("NFC")
        .replace(/[\u0000-\u001f\u007f/\\]/g, "")
        .replace(/^\.+/, "")
        .trim()
        .slice(-200);
      if (!name) fail(400, "Give the file a name.");
      const identity = {
        company_id: job.company_id,
        computer_id: file.computer_id,
        source_box_id: file.source_box_id,
        conversation_id: conversation.id,
        task_id: task?.id || null,
        path: file.path,
        source_token: file.source_token,
      };
      const existing = findSource(identity, args?.shared_file_id || null);
      const current = existing?.current_upload_id
        ? one("SELECT * FROM uploads WHERE id=?", existing.current_upload_id)
        : null;
      const changed =
        !current ||
        current.sha256 !== file.sha256 ||
        current.size !== file.size;
      let upload = current;
      if (changed)
        upload = await storeUpload(
          job.company_id,
          conversation.id,
          job.user_id,
          name,
          file.stream,
          { allowEmpty: true },
        );
      else
        for await (const chunk of file.stream) {
          void chunk;
        }
      try {
        await guard();
        verifyComputerBinding(job, file);
        conversationFor(
          visibleJob.conversation_id,
          job.company_id,
          job.user_id,
        );
        // A newer publication in another process wins. Never point backward.
        const fresh = findSource(identity, args?.shared_file_id || null);
        const actual = fresh?.current_upload_id
          ? one("SELECT * FROM uploads WHERE id=?", fresh.current_upload_id)
          : null;
        if (fresh && existing && fresh.revision !== existing.revision)
          fail(409, "This file changed while it was being shared. Try again.");
        if (
          changed &&
          (upload.sha256 !== file.sha256 || upload.size !== file.size)
        )
          fail(409, "This file changed while it was being shared. Try again.");
        const sharedId = fresh?.id || id();
        const stamp = now();
        db.transaction(() => {
          verifyComputerBinding(job, file);
          if (!fresh)
            run(
              `INSERT INTO shared_files(id,company_id,computer_id,source_box_id,duck_id,conversation_id,task_id,user_id,message_id,
           source_path,display_name,source_dev,source_ino,source_token,current_upload_id,archived,archive_reason,created,updated,revision)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,?,?,1)`,
              sharedId,
              job.company_id,
              file.computer_id,
              file.source_box_id,
              job.duck_id,
              conversation.id,
              task?.id || null,
              job.user_id,
              output.id,
              file.path,
              name,
              file.source_token[0],
              file.source_token[1],
              JSON.stringify(file.source_token),
              upload.id,
              stamp,
              stamp,
            );
          else
            run(
              `UPDATE shared_files SET source_path=?,display_name=?,source_dev=?,source_ino=?,source_token=?,
           current_upload_id=?,archived=0,archive_reason=NULL,missing_count=0,observed_token=NULL,
           observed_count=0,updated=?,revision=revision+1 WHERE id=?`,
              file.path,
              name,
              file.source_token[0],
              file.source_token[1],
              JSON.stringify(file.source_token),
              changed ? upload.id : actual.id,
              stamp,
              sharedId,
            );
          if (changed) {
            run(
              "UPDATE uploads SET message_id=? WHERE id=?",
              output.id,
              upload.id,
            );
            run(
              `INSERT INTO shared_file_versions(shared_file_id,upload_id,version,created)
             VALUES(?,?,COALESCE((SELECT max(version)+1 FROM shared_file_versions WHERE shared_file_id=?),1),?)`,
              sharedId,
              upload.id,
              sharedId,
              stamp,
            );
            if (task)
              run(
                "INSERT INTO task_uploads(upload_id,company_id,task_id,created) VALUES(?,?,?,?)",
                upload.id,
                job.company_id,
                task.id,
                stamp,
              );
          }
          run(
            "INSERT INTO shared_file_exports(job_id,call_id,shared_file_id,upload_id,created) VALUES(?,?,?,?,?)",
            job.id,
            callId,
            sharedId,
            upload.id,
            stamp,
          );
          attachArtifact(
            job.company_id,
            output.id,
            "file",
            upload.id,
            name,
            "Created",
          );
          registerPublishedFile(job, {
            file,
            shared_file_id: sharedId,
            folder_id: args?.folder_id || null,
          });
        })();
        emit(job.company_id);
        return linkedResult(
          { id: sharedId, task_id: task?.id || null },
          upload,
        );
      } catch (error) {
        const raced = priorLinkedExport(job, callId);
        if (raced) return raced;
        if (changed) discardUnlinkedUpload(upload);
        throw error;
      }
    },
  );
}

function authorized(req, shared) {
  if (!shared || shared.company_id !== req.company.id)
    fail(404, "This file is unavailable.");
  if (shared.task_id) {
    tenant("tasks", shared.task_id, req.company.id);
    if (!memberFor(req.company.id, req.user.id))
      fail(404, "This file is unavailable.");
  } else conversationFor(shared.conversation_id, req.company.id, req.user.id);
  return shared;
}
function canManage(company, user, shared) {
  return (
    shared.user_id === user || !!permissions(memberFor(company, user)).company
  );
}
function versionRows(shared) {
  return all(
    `SELECT v.version,u.id,u.name,u.mime,u.file_group,u.size,u.sha256,v.created
     FROM shared_file_versions v JOIN uploads u ON u.id=v.upload_id
     WHERE v.shared_file_id=? ORDER BY v.version DESC`,
    shared.id,
  ).map((v) => ({ ...v, group: v.file_group, download_url: versionUrl(v.id) }));
}
function publicShared(shared, company, user) {
  const u = one("SELECT * FROM uploads WHERE id=?", shared.current_upload_id);
  if (!u) fail(410, "This file could not be loaded from storage.");
  const versions = one(
    "SELECT count(*) n FROM shared_file_versions WHERE shared_file_id=?",
    shared.id,
  ).n;
  const seesConversation = !!one(
    "SELECT 1 FROM conversation_members WHERE conversation_id=? AND user_id=?",
    shared.conversation_id,
    user,
  );
  return {
    key: `shared_file:${shared.id}`,
    kind: "shared_file",
    id: shared.id,
    shared_file_id: shared.id,
    current_upload_id: u.id,
    name: shared.display_name,
    mime: u.mime,
    group: u.file_group,
    inline: !!u.inline,
    size: u.size,
    created: shared.created,
    updated: shared.updated,
    archived: !!shared.archived,
    version_count: versions,
    download_url: stableUrl(shared.id),
    version_download_url: versionUrl(u.id),
    message_id: seesConversation ? shared.message_id : null,
    conversation_id: seesConversation ? shared.conversation_id : null,
    conversation_ids: seesConversation ? [shared.conversation_id] : [],
    task_ids: shared.task_id ? [shared.task_id] : [],
    duck_ids: [shared.duck_id],
    from: { duck_id: shared.duck_id },
    can_manage: canManage(company, user, shared),
  };
}
export function sharedFilesForList(company, user, visible, seesTickets) {
  const groups = new Map();
  for (const shared of visibleSharedFiles(
    company,
    user,
    visible,
    seesTickets,
  )) {
    const key = sourceGroupKey(shared);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(shared);
  }
  return [...groups.values()].map((rows) =>
    publicSourceGroup(rows, company, user),
  );
}

// A scope row is also an access grant and a permanent download URL. Keep those
// rows (and their private version histories) separate, but show the same source
// only once in Files. Filter by access BEFORE grouping or choosing a version.
// Filenames and hashes are never identity: equal bytes can be unrelated files.
function sourceGroupKey(shared) {
  return JSON.stringify([
    shared.company_id,
    shared.duck_id,
    shared.computer_id || shared.id,
    shared.source_box_id,
    shared.source_path,
  ]);
}
function visibleSharedFiles(company, user, visible = null, seesTickets = null) {
  if (!memberFor(company, user)) return [];
  if (!visible)
    visible = new Set(
      all(
        `SELECT c.id FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id
         WHERE c.company_id=? AND m.user_id=?`,
        company,
        user,
      ).map((row) => row.id),
    );
  seesTickets ??= true;
  return all(
    "SELECT *,rowid source_order FROM shared_files WHERE company_id=? ORDER BY updated DESC",
    company,
  ).filter((s) => (s.task_id ? seesTickets : visible.has(s.conversation_id)));
}
const oldestSourceFirst = (a, b) =>
  a.created.localeCompare(b.created) ||
  (a.source_order || 0) - (b.source_order || 0) ||
  a.id.localeCompare(b.id);
function latestSource(rows) {
  const active = rows.filter((row) => !row.archived);
  // Archive/restore also changes updated. Choose by when the current bytes
  // were saved or explicitly re-shared, so archiving an older copy cannot
  // make the grouped download point backward. Re-sharing unchanged bytes is
  // still a fresh observation (including a deliberate revert to old content).
  return (active.length ? active : rows)
    .map((row) => {
      const saved = one(
        `SELECT max(u.created,coalesce((SELECT max(e.created) FROM shared_file_exports e
        WHERE e.shared_file_id=? AND e.upload_id=u.id),u.created)) stamp,u.rowid upload_order
       FROM uploads u WHERE u.id=? AND u.company_id=?`,
        row.id,
        row.current_upload_id,
        row.company_id,
      );
      return {
        ...row,
        content_at: saved?.stamp || row.created,
        content_order: saved?.upload_order || 0,
      };
    })
    .sort(
      (a, b) =>
        b.content_at.localeCompare(a.content_at) ||
        b.content_order - a.content_order ||
        b.updated.localeCompare(a.updated) ||
        oldestSourceFirst(a, b),
    )[0];
}
const sourceGroupUrl = (id) => `/api/shared-file-groups/${id}`;
function publicSourceGroup(rows, company, user) {
  const ordered = rows.slice().sort(oldestSourceFirst);
  const anchor = ordered[0];
  const latest = latestSource(rows);
  const entries = ordered.map((row) => publicShared(row, company, user));
  const current = entries.find((entry) => entry.id === latest.id);
  return {
    ...current,
    key: `shared_file:${anchor.id}`,
    id: anchor.id,
    shared_file_id: anchor.id,
    grouped: true,
    task_id: latest.task_id || null,
    created: anchor.created,
    updated: rows.reduce(
      (stamp, row) => (row.updated > stamp ? row.updated : stamp),
      anchor.updated,
    ),
    archived: rows.every((row) => !!row.archived),
    version_count: entries.reduce(
      (count, entry) => count + entry.version_count,
      0,
    ),
    download_url: sourceGroupUrl(anchor.id) + "?download=1",
    conversation_ids: [
      ...new Set(entries.flatMap((entry) => entry.conversation_ids)),
    ],
    task_ids: [...new Set(entries.flatMap((entry) => entry.task_ids))],
    can_manage: rows.every((row) => canManage(company, user, row)),
    places: entries.map((entry) => ({
      shared_file_id: entry.id,
      conversation_id: entry.conversation_id,
      task_id: entry.task_ids[0] || null,
      message_id: entry.message_id,
      created: entry.created,
      archived: entry.archived,
    })),
  };
}
function authorizedSourceGroup(req) {
  const anchor = authorized(
    req,
    one("SELECT * FROM shared_files WHERE id=?", uuid.parse(req.params.id)),
  );
  const key = sourceGroupKey(anchor);
  const rows = visibleSharedFiles(req.company.id, req.user.id).filter(
    (row) => sourceGroupKey(row) === key,
  );
  if (!rows.length) fail(404, "This file is unavailable.");
  return rows;
}
function sourceGroupVersions(rows) {
  const currentId = latestSource(rows).current_upload_id;
  // Every immutable upload survives. Version numbers here describe only the
  // history this viewer can access, never the size of a private chat's history.
  return rows
    .flatMap(versionRows)
    .sort(
      (a, b) =>
        Number(a.id === currentId) - Number(b.id === currentId) ||
        a.created.localeCompare(b.created) ||
        a.id.localeCompare(b.id),
    )
    .map((version, index) => ({ ...version, version: index + 1 }))
    .reverse();
}
function sendSharedDownload(req, res, shared) {
  const u = one(
    "SELECT * FROM uploads WHERE id=? AND company_id=?",
    shared.current_upload_id,
    req.company.id,
  );
  if (!u) fail(410, "This file could not be loaded from storage.");
  const etag = `"${u.sha256}"`;
  res.set({
    "Cache-Control": "private, no-cache",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(shared.display_name)}`,
  });
  if (req.get("if-none-match") === etag) return res.status(304).end();
  try {
    res.send(readUpload(u));
  } catch {
    fail(410, "This file could not be loaded from storage.");
  }
}
export function linkedUploadMetadata(uploadId) {
  const s = one(
    `SELECT s.id FROM shared_file_versions v JOIN shared_files s ON s.id=v.shared_file_id
     WHERE v.upload_id=?`,
    uploadId,
  );
  return s
    ? {
        shared_file_id: s.id,
        current_upload_id: one(
          "SELECT current_upload_id FROM shared_files WHERE id=?",
          s.id,
        ).current_upload_id,
        download_url: stableUrl(s.id),
        version_download_url: versionUrl(uploadId),
      }
    : null;
}
export function registerSharedFileRoutes(app) {
  app.get("/api/shared-file-groups/:id", (req, res) => {
    const rows = authorizedSourceGroup(req);
    if (req.query.download === "1")
      return sendSharedDownload(req, res, latestSource(rows));
    res.json({
      ...publicSourceGroup(rows, req.company.id, req.user.id),
      versions: sourceGroupVersions(rows),
    });
  });
  for (const action of ["archive", "restore"])
    app.post(`/api/shared-file-groups/:id/${action}`, (req, res) => {
      const result = db.transaction(() => {
        const rows = authorizedSourceGroup(req);
        if (!rows.every((row) => canManage(req.company.id, req.user.id, row)))
          fail(
            403,
            "Only the original sharer of every listed entry or a company admin can manage this file.",
          );
        const stamp = now();
        for (const row of rows)
          run(
            "UPDATE shared_files SET archived=?,archive_reason=?,updated=?,revision=revision+1 WHERE id=? AND company_id=?",
            action === "archive" ? 1 : 0,
            action === "archive" ? "manual" : "restored",
            stamp,
            row.id,
            req.company.id,
          );
        audit(
          req.company.id,
          req.user.id,
          action === "archive" ? "File archived" : "File restored",
          latestSource(rows).display_name,
        );
        return publicSourceGroup(
          authorizedSourceGroup(req),
          req.company.id,
          req.user.id,
        );
      })();
      emit(req.company.id);
      res.json(result);
    });
  app.get("/api/shared-files/:id", (req, res) => {
    const shared = authorized(
      req,
      one("SELECT * FROM shared_files WHERE id=?", uuid.parse(req.params.id)),
    );
    if (req.query.download !== "1")
      return res.json({
        ...publicShared(shared, req.company.id, req.user.id),
        versions: versionRows(shared),
      });
    sendSharedDownload(req, res, shared);
  });
  for (const action of ["archive", "restore"])
    app.post(`/api/shared-files/:id/${action}`, (req, res) => {
      const shared = authorized(
        req,
        one("SELECT * FROM shared_files WHERE id=?", uuid.parse(req.params.id)),
      );
      if (!canManage(req.company.id, req.user.id, shared))
        fail(
          403,
          "Only the person who shared this file or a company admin can manage it.",
        );
      run(
        "UPDATE shared_files SET archived=?,archive_reason=?,updated=?,revision=revision+1 WHERE id=?",
        action === "archive" ? 1 : 0,
        action === "archive" ? "manual" : "restored",
        now(),
        shared.id,
      );
      audit(
        req.company.id,
        req.user.id,
        action === "archive" ? "File archived" : "File restored",
        one("SELECT name FROM uploads WHERE id=?", shared.current_upload_id)
          .name,
      );
      emit(req.company.id);
      res.json(
        publicShared(
          one("SELECT * FROM shared_files WHERE id=?", shared.id),
          req.company.id,
          req.user.id,
        ),
      );
    });
}

export function duckLinkedFiles(job, taskId = null) {
  const visibleJob = consultationVisibleJob(job);
  conversationFor(visibleJob.conversation_id, job.company_id, job.user_id);
  const member = memberFor(job.company_id, job.user_id);
  if (!member) fail(403, "Membership has been removed.");
  return all(
    "SELECT * FROM shared_files WHERE company_id=? ORDER BY updated DESC",
    job.company_id,
  )
    .filter(
      (shared) =>
        shared.conversation_id === visibleJob.conversation_id ||
        (taskId && shared.task_id === taskId),
    )
    .map((shared) => ({
      id: shared.id,
      name: shared.display_name,
      archived: !!shared.archived,
      updated: shared.updated,
      can_manage: canManage(job.company_id, job.user_id, shared),
      download_url: stableUrl(shared.id),
      version_count: one(
        "SELECT count(*) n FROM shared_file_versions WHERE shared_file_id=?",
        shared.id,
      ).n,
    }));
}

export function duckManageLinkedFile(job, sharedId, action, taskId = null) {
  const visibleJob = consultationVisibleJob(job);
  conversationFor(visibleJob.conversation_id, job.company_id, job.user_id);
  const shared = one(
    "SELECT * FROM shared_files WHERE id=? AND company_id=?",
    uuid.parse(sharedId),
    job.company_id,
  );
  if (
    !shared ||
    !(
      shared.conversation_id === visibleJob.conversation_id ||
      (taskId && shared.task_id === taskId)
    )
  )
    fail(404, "That linked file is not shared here.");
  if (!canManage(job.company_id, job.user_id, shared))
    fail(
      403,
      "Only the person who shared this file or a company admin can manage it.",
    );
  if (!["archive", "restore"].includes(action))
    fail(400, "Unknown file action.");
  const archived = action === "archive";
  if (!!shared.archived !== archived) {
    run(
      "UPDATE shared_files SET archived=?,archive_reason=?,updated=?,revision=revision+1 WHERE id=?",
      archived ? 1 : 0,
      archived ? "manual" : "restored",
      now(),
      shared.id,
    );
    audit(
      job.company_id,
      job.user_id,
      archived ? "File archived" : "File restored",
      shared.display_name,
    );
    emit(job.company_id);
  }
  return {
    id: shared.id,
    name: shared.display_name,
    archived,
    download_url: stableUrl(shared.id),
  };
}

// Called only for an already-ready computer by its janitor. It does not touch
// activity timestamps, start a machine, or archive after an uncertain scan.
export async function syncSharedFilesForComputer(
  computer,
  request,
  { busy = () => false, allowed = () => true } = {},
) {
  const assertCurrent = (source = null) => {
    const current = one(
      "SELECT box_id,state FROM computers WHERE id=? AND company_id=?",
      computer.id,
      computer.company_id,
    );
    if (
      busy() ||
      !allowed() ||
      !current ||
      current.box_id !== computer.box_id ||
      !["ready", "idle", "running"].includes(current.state)
    )
      fail(409, "The computer is no longer ready.");
    if (source) {
      const member = memberFor(source.company_id, source.user_id);
      const duck = one(
        "SELECT removed FROM ducks WHERE id=? AND company_id=?",
        source.duck_id,
        source.company_id,
      );
      const company = one(
        "SELECT paused FROM companies WHERE id=?",
        source.company_id,
      );
      if (!member || !duck || duck.removed || company?.paused)
        fail(409, "This file is no longer allowed to sync.");
      can(member, "computers");
      conversationFor(
        source.conversation_id,
        source.company_id,
        source.user_id,
      );
    }
  };
  const sources = all(
    "SELECT * FROM shared_files WHERE computer_id=? AND source_box_id=? AND archive_reason IS NOT 'manual'",
    computer.id,
    computer.box_id,
  );
  const registered = one(
    "SELECT 1 FROM file_folders WHERE company_id=? AND computer_id=? AND source_box_id=? AND physical=1 LIMIT 1",
    computer.company_id,
    computer.id,
    computer.box_id,
  );
  if (!sources.length && !registered) return;
  const tree = await scanComputerOutputTree({
    request,
    boxId: computer.box_id,
    guard: () => assertCurrent(),
  });
  const inventory = tree.files;
  for (const source of sources) {
    assertCurrent(source);
    registerPublishedFile(
      {
        company_id: source.company_id,
        user_id: source.user_id,
        duck_id: source.duck_id,
        conversation_id: source.conversation_id,
        task_id: source.task_id,
      },
      {
        file: {
          path: source.source_path,
          output_directory: tree.output_directory,
          computer_id: source.computer_id,
          source_box_id: source.source_box_id,
        },
        shared_file_id: source.id,
      },
    );
  }
  syncPublishedDirectories(
    { company_id: computer.company_id },
    {
      computer_id: computer.id,
      source_box_id: computer.box_id,
      directories: tree.directories,
    },
  );
  const byPath = new Map(inventory.map((item) => [item.path, item]));
  for (const source of sources) {
    assertCurrent(source);
    const pathItem = byPath.get(source.source_path);
    // After two missing scans, the old inode may be reused by an unrelated
    // file, including when the owner restores the stored copy. Only the
    // original path can reconnect that source.
    const inodeItem =
      source.missing_count >= 2
        ? null
        : inventory.find(
            (f) =>
              f.token[0] === source.source_dev &&
              f.token[1] === source.source_ino,
          );
    // An old inode moved elsewhere while a new file appeared at the old path
    // cannot be classified as a rename or a save by replacement from one
    // inventory. Keep the last good copy until an explicit re-share resolves it.
    if (pathItem && inodeItem && pathItem.path !== inodeItem.path) continue;
    const item = pathItem || inodeItem;
    if (!item) {
      // An explicit restore means the person wants the last stored copy in
      // Current even while its original is absent. Wait for it to reappear.
      if (source.archive_reason === "restored") continue;
      const missing = source.missing_count + 1;
      run(
        "UPDATE shared_files SET missing_count=?,observed_token=NULL,observed_count=0 WHERE id=? AND revision=?",
        missing,
        source.id,
        source.revision,
      );
      if (missing >= 2 && !source.archived) {
        assertCurrent(source);
        run(
          "UPDATE shared_files SET archived=1,archive_reason='source_missing',updated=?,revision=revision+1 WHERE id=? AND revision=? AND archive_reason IS NOT 'manual'",
          now(),
          source.id,
          source.revision,
        );
        emit(source.company_id);
      }
      continue;
    }
    const tokenText = JSON.stringify(item.token);
    const count =
      source.observed_token === tokenText ? source.observed_count + 1 : 1;
    if (
      tokenText === source.source_token &&
      item.path === source.source_path &&
      !source.archived
    ) {
      if (
        source.missing_count ||
        source.observed_count ||
        source.archive_reason === "restored"
      )
        run(
          "UPDATE shared_files SET missing_count=0,observed_token=NULL,observed_count=0,archive_reason=NULL WHERE id=? AND revision=?",
          source.id,
          source.revision,
        );
      continue;
    }
    run(
      "UPDATE shared_files SET missing_count=0,observed_token=?,observed_count=? WHERE id=? AND revision=?",
      tokenText,
      count,
      source.id,
      source.revision,
    );
    if (count < 2) continue;
    let file;
    try {
      file = await readComputerFile({
        request,
        boxId: computer.box_id,
        filePath: item.path,
        guard: () => assertCurrent(source),
      });
      if (!sameToken(file.source_token, item.token)) continue;
    } catch {
      continue;
    }
    const current = one("SELECT * FROM shared_files WHERE id=?", source.id);
    if (
      !current ||
      current.revision !== source.revision ||
      current.observed_token !== tokenText ||
      current.observed_count < 2 ||
      current.archive_reason === "manual"
    )
      continue;
    const prior = one(
      "SELECT * FROM uploads WHERE id=?",
      current.current_upload_id,
    );
    let upload = prior;
    const changed =
      !prior || prior.sha256 !== file.sha256 || prior.size !== file.size;
    if (changed) {
      try {
        upload = await storeUpload(
          source.company_id,
          source.conversation_id,
          source.user_id,
          path.posix.basename(item.path),
          file.stream,
          { allowEmpty: true },
        );
      } catch {
        continue;
      }
    } else {
      try {
        for await (const chunk of file.stream) {
          void chunk;
        }
      } catch {
        continue;
      }
    }
    try {
      if (
        changed &&
        (upload.sha256 !== file.sha256 || upload.size !== file.size)
      )
        fail(409, "The file changed during sync.");
      const stamp = now();
      const updated = db.transaction(() => {
        assertCurrent(source);
        const result = run(
          `UPDATE shared_files SET source_path=?,display_name=?,source_dev=?,source_ino=?,source_token=?,
           current_upload_id=?,archived=0,archive_reason=NULL,observed_token=NULL,observed_count=0,
           missing_count=0,updated=?,revision=revision+1 WHERE id=? AND revision=? AND source_box_id=?`,
          item.path,
          path.posix.basename(item.path),
          item.token[0],
          item.token[1],
          tokenText,
          upload.id,
          stamp,
          source.id,
          source.revision,
          computer.box_id,
        );
        if (!result.changes) return false;
        if (changed) {
          run(
            "UPDATE uploads SET message_id=? WHERE id=?",
            source.message_id,
            upload.id,
          );
          run(
            `INSERT INTO shared_file_versions(shared_file_id,upload_id,version,created)
            VALUES(?,?,COALESCE((SELECT max(version)+1 FROM shared_file_versions WHERE shared_file_id=?),1),?)`,
            source.id,
            upload.id,
            source.id,
            stamp,
          );
          if (source.task_id)
            run(
              "INSERT INTO task_uploads(upload_id,company_id,task_id,created) VALUES(?,?,?,?)",
              upload.id,
              source.company_id,
              source.task_id,
              stamp,
            );
        }
        registerPublishedFile(
          {
            company_id: source.company_id,
            user_id: source.user_id,
            duck_id: source.duck_id,
            conversation_id: source.conversation_id,
            task_id: source.task_id,
          },
          {
            file: {
              ...file,
              path: item.path,
              output_directory: tree.output_directory,
              computer_id: source.computer_id,
              source_box_id: source.source_box_id,
            },
            shared_file_id: source.id,
          },
        );
        return true;
      })();
      if (!updated && changed) discardUnlinkedUpload(upload);
      if (updated) emit(source.company_id);
    } catch {
      if (changed) discardUnlinkedUpload(upload);
    }
  }
}

// Operator-only migration aid: caller supplies reviewed upload IDs and a
// verified, current source. No filename inference and no deletion of blobs.
export async function adoptExistingExports({
  companyId,
  computerId,
  boxId,
  conversationId,
  taskId = null,
  duckId,
  source,
  uploadIds,
  existingSharedFileId = null,
}) {
  if (
    (existingSharedFileId !== null && !uuid.safeParse(existingSharedFileId).success) ||
    !Array.isArray(uploadIds) ||
    !uploadIds.length ||
    new Set(uploadIds).size !== uploadIds.length ||
    !source?.verified ||
    source.computer_id !== computerId ||
    source.source_box_id !== boxId ||
    !Array.isArray(source.source_token) ||
    source.source_token.length !== 5 ||
    source.source_token.some(
      (part) => typeof part !== "string" || !/^\d+$/.test(part),
    ) ||
    !path.posix.isAbsolute(source.path || "") ||
    !source.path.startsWith(source.output_directory + "/")
  )
    fail(400, "Explicit uploads and verified source binding are required.");
  const computer = tenant("computers", computerId, companyId);
  if (computer.box_id !== boxId || computer.duck_id !== duckId)
    fail(409, "Computer identity changed.");
  const rows = uploadIds.map((uploadId) =>
    one(
      `SELECT u.* FROM uploads u JOIN computer_file_exports e ON e.upload_id=u.id
     WHERE u.id=? AND u.company_id=? AND e.duck_id=?`,
      uploadId,
      companyId,
      duckId,
    ),
  );
  if (
    rows.some(
      (row) =>
        !row ||
        row.conversation_id !== conversationId ||
        !row.message_id ||
        (taskId &&
          !one(
            "SELECT 1 FROM task_uploads WHERE upload_id=? AND task_id=?",
            row.id,
            taskId,
          )),
    )
  )
    fail(409, "The selected exports do not share the reviewed scope.");
  if (
    rows.some(
      (row) =>
        !!one("SELECT 1 FROM task_uploads WHERE upload_id=?", row.id) !==
        !!taskId,
    )
  )
    fail(409, "The selected exports do not share the reviewed ticket scope.");
  if (
    rows.some((row) =>
      one("SELECT 1 FROM shared_file_versions WHERE upload_id=?", row.id),
    )
  )
    fail(409, "An export has already been linked.");
  tenant("conversations", conversationId, companyId);
  if (taskId) tenant("tasks", taskId, companyId);
  const latest = rows.at(-1);
  const message = one(
    "SELECT id FROM messages WHERE id=? AND company_id=? AND conversation_id=?",
    latest.message_id,
    companyId,
    conversationId,
  );
  if (!message || !memberFor(companyId, latest.user_id))
    fail(409, "The latest export no longer has a valid owner and message.");
  // Finish the provider's changed-during-read check before binding history.
  for await (const chunk of source.stream) {
    void chunk;
  }
  if (
    one("SELECT box_id FROM computers WHERE id=?", computerId)?.box_id !== boxId
  )
    fail(409, "Computer identity changed.");
  const stamp = now();
  return db.transaction(() => {
    // Recheck after reading the provider stream. A sync or another adoption may
    // have linked one of these uploads while the verified source was read.
    if (
      rows.some((row) =>
        one("SELECT 1 FROM shared_file_versions WHERE upload_id=?", row.id),
      )
    )
      fail(409, "An export has already been linked.");
    const existing = findSource({
      company_id: companyId,
      computer_id: computerId,
      source_box_id: boxId,
      conversation_id: conversationId,
      task_id: taskId,
      path: source.path,
      source_token: source.source_token,
    });
    if (existingSharedFileId && existing?.id !== existingSharedFileId)
      fail(409, "The reviewed linked file identity changed.");
    if (existing) {
      const current = one(
        "SELECT * FROM uploads WHERE id=? AND company_id=?",
        existing.current_upload_id,
        companyId,
      );
      // The current linked copy must still be the verified guest source. A
      // late export can be older, but its bytes must already exist in this
      // exact linked file's immutable history, not merely share its name.
      if (
        existing.source_dev !== source.source_token[0] ||
        existing.source_ino !== source.source_token[1] ||
        !current ||
        current.sha256 !== source.sha256 ||
        current.size !== source.size
      )
        fail(409, "The reviewed export does not match this linked source.");
      const checkedBytes = (upload) => {
        const bytes = readUpload(upload);
        if (
          bytes.length !== upload.size ||
          crypto.createHash("sha256").update(bytes).digest("hex") !==
            upload.sha256
        )
          fail(409, "A reviewed upload no longer matches its stored bytes.");
        return bytes;
      };
      checkedBytes(current);
      for (const candidate of rows) {
        const matching = one(
          `SELECT u.* FROM shared_file_versions v JOIN uploads u ON u.id=v.upload_id
           WHERE v.shared_file_id=? AND u.company_id=? AND u.sha256=? AND u.size=?
           ORDER BY v.version LIMIT 1`,
          existing.id,
          companyId,
          candidate.sha256,
          candidate.size,
        );
        if (!matching)
          fail(409, "The reviewed export is absent from linked history.");
        if (!checkedBytes(candidate).equals(checkedBytes(matching)))
          fail(409, "The reviewed export differs from linked history.");
      }
      const previous = all(
        "SELECT upload_id,version,created FROM shared_file_versions WHERE shared_file_id=? ORDER BY version",
        existing.id,
      );
      const currentVersion = previous.find(
        (version) => version.upload_id === existing.current_upload_id,
      );
      if (
        !currentVersion ||
        previous.at(-1)?.upload_id !== existing.current_upload_id ||
        previous.some((version) => version.created > currentVersion.created) ||
        rows.some((row) => row.created > currentVersion.created)
      )
        fail(409, "The reviewed export is newer than the current version.");
      const ordered = [
        ...previous.map((version) => ({ ...version, order: version.version })),
        ...rows.map((row, index) => ({
          upload_id: row.id,
          created: row.created,
          order: previous.length + index + 1,
        })),
      ].sort(
        (a, b) =>
          a.created.localeCompare(b.created) ||
          (a.upload_id === existing.current_upload_id ? 1 : 0) -
            (b.upload_id === existing.current_upload_id ? 1 : 0) ||
          a.order - b.order,
      );
      // Replacing the version rows inside one transaction keeps every upload
      // and exact-version URL intact while giving the late history its proper
      // place below the current version. The stable row is not updated.
      run(
        "DELETE FROM shared_file_versions WHERE shared_file_id=?",
        existing.id,
      );
      ordered.forEach((version, index) =>
        run(
          "INSERT INTO shared_file_versions(shared_file_id,upload_id,version,created) VALUES(?,?,?,?)",
          existing.id,
          version.upload_id,
          index + 1,
          version.created,
        ),
      );
      return existing.id;
    }
    const sharedId = id();
    run(
      `INSERT INTO shared_files(id,company_id,computer_id,source_box_id,duck_id,conversation_id,task_id,user_id,message_id,
      source_path,display_name,source_dev,source_ino,source_token,current_upload_id,archived,archive_reason,created,updated,revision)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,?,?,1)`,
      sharedId,
      companyId,
      computerId,
      boxId,
      duckId,
      conversationId,
      taskId,
      latest.user_id,
      message.id,
      source.path,
      latest.name,
      source.source_token[0],
      source.source_token[1],
      "",
      latest.id,
      stamp,
      stamp,
    );
    rows.forEach((row, index) =>
      run(
        "INSERT INTO shared_file_versions(shared_file_id,upload_id,version,created) VALUES(?,?,?,?)",
        sharedId,
        row.id,
        index + 1,
        row.created,
      ),
    );
    return sharedId;
  })();
}
