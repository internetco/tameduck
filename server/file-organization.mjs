import { z } from "zod";
import { all, one, memberFor, permissions, fail } from "./store.mjs";
import { listFiles } from "./uploads.mjs";
import {
  folderList,
  folderMoveItem,
  rollbackOrganizingFolders,
  ensureOrganizingFolder,
  fileMoveCapability,
  validateFolderDestination,
} from "./file-folders.mjs";

const uuid = z.string().uuid();
const fileId = z
  .string()
  .regex(/^(document|upload|shared_file|screenshot|notes):[0-9a-fA-F-]{36}$/);
const kindOf = (item) =>
  item.kind === "shared_file" ? "shared_file" : item.kind;
const refOf = (item) => `${kindOf(item)}:${item.id}`;
const contextFor = (job) => ({
  ...job,
  company_id: job.company_id,
  user_id: job.user_id,
});
function authorizedItems(job) {
  const member = memberFor(job.company_id, job.user_id);
  if (!member || !permissions(member).docs)
    fail(403, "You do not have permission to manage files.");
  const items = listFiles(job.company_id, job.user_id);
  return items.filter((item) => {
    if (item.kind === "notes") return item.id === job.duck_id;
    if (item.kind === "document")
      return (
        item.from?.duck_id === job.duck_id ||
        item.conversation_ids?.includes(job.conversation_id) ||
        (job.task_id && item.task_ids?.includes(job.task_id))
      );
    if (item.from?.duck_id === job.duck_id) return true;
    return (
      item.conversation_ids?.includes(job.conversation_id) ||
      (job.task_id && item.task_ids?.includes(job.task_id))
    );
  });
}
function decorate(job, item) {
  const capability = fileMoveCapability(contextFor(job), kindOf(item), item.id);
  const folder = item.folder_id
    ? one(
        "SELECT relative_path FROM file_folders WHERE id=? AND company_id=?",
        item.folder_id,
        job.company_id,
      )
    : null;
  return {
    file_id: refOf(item),
    name: item.name,
    type: kindOf(item),
    folder_id: item.folder_id || null,
    folder_path: folder?.relative_path || null,
    can_move: capability.can_move,
    ...(capability.reason ? { reason: capability.reason } : {}),
    from: item.from || null,
    conversation_ids: item.conversation_ids || [],
    task_ids: item.task_ids || [],
    duck_ids: item.duck_ids || [],
    archived: !!item.archived,
  };
}
export function listOrganizableFiles(job, args = {}) {
  const offset = z
    .number()
    .int()
    .min(0)
    .default(0)
    .parse(args.offset ?? 0);
  const limit = z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(100)
    .parse(args.limit ?? 100);
  const folderId =
    args.folder_id === undefined
      ? undefined
      : args.folder_id === "unfiled"
        ? null
        : uuid.parse(args.folder_id);
  const items = authorizedItems(job)
    .map((item) => decorate(job, item))
    .filter((item) => !!args.include_archived || !item.archived);
  const unfiled_count = items.filter((item) => !item.folder_id).length;
  const filtered =
    folderId === undefined
      ? items
      : items.filter((item) => item.folder_id === folderId);
  filtered.sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.file_id.localeCompare(b.file_id),
  );
  const folders = folderList({
    company_id: job.company_id,
    user_id: job.user_id,
  }).filter((folder) => {
    if (folder.duck_id === job.duck_id) return true;
    if (folder.duck_id) return false;
    return (
      folder.conversation_ids.includes(job.conversation_id) ||
      (job.task_id && folder.task_ids.includes(job.task_id)) ||
      !!one(
        "SELECT 1 FROM file_folder_scopes WHERE folder_id=? AND scope_kind='company' AND scope_id=?",
        folder.id,
        job.company_id,
      )
    );
  });
  return {
    files: filtered.slice(offset, offset + limit),
    total: filtered.length,
    next_offset: offset + limit < filtered.length ? offset + limit : null,
    unfiled_count,
    folders,
  };
}
export async function organizeFiles(job, args = {}) {
  const refs = z.array(fileId).min(1).max(50).parse(args.file_ids);
  const hasPath = Object.hasOwn(args, "folder_path");
  const hasId = Object.hasOwn(args, "folder_id");
  if (hasPath === hasId) fail(400, "Choose one destination folder or path.");
  const folderId = hasId
    ? args.folder_id === "unfiled"
      ? null
      : uuid.parse(args.folder_id)
    : undefined;
  const folderPath = hasPath
    ? z.string().min(1).max(2048).parse(args.folder_path)
    : undefined;
  const visible = new Map();
  for (const item of authorizedItems(job)) {
    visible.set(refOf(item), item);
    if (item.kind === "shared_file")
      for (const place of item.places || [])
        visible.set(`shared_file:${place.shared_file_id}`, item);
  }
  const results = [];
  for (const ref of refs) {
    const item = visible.get(ref);
    if (!item) {
      results.push({
        file_id: ref,
        status: "failed",
        error_code: "file_not_found",
        error:
          "This file_id is not in the current file inventory. Call file_list, copy the exact file_id of the intended file, and retry if it is available.",
      });
      continue;
    }
    const capability = fileMoveCapability(
      contextFor(job),
      kindOf(item),
      item.id,
    );
    if (!capability.can_move) {
      results.push({
        file_id: ref,
        status: "failed",
        error: capability.reason || "This file cannot be moved.",
      });
      continue;
    }
    let createdIds = [];
    try {
      const resolved = folderPath
        ? ensureOrganizingFolder(
            contextFor(job),
            folderPath,
            { kind: kindOf(item), id: item.id },
            { details: true },
          )
        : null;
      createdIds = resolved?.createdIds || [];
      const destination = resolved?.id ?? folderId;
      validateFolderDestination(contextFor(job), destination, {
        kind: kindOf(item),
        id: item.id,
      });
      const previous =
        one(
          "SELECT folder_id FROM file_folder_items WHERE company_id=? AND kind=? AND item_id=?",
          job.company_id,
          kindOf(item),
          item.id,
        )?.folder_id || null;
      if (previous === destination) {
        results.push({
          file_id: ref,
          status: "unchanged",
          folder_id: destination,
        });
      } else {
        const moved = await folderMoveItem(contextFor(job), destination, {
          kind: kindOf(item),
          id: item.id,
        });
        results.push({
          file_id: ref,
          status: "moved",
          folder_id: moved.folder_id,
        });
      }
    } catch (error) {
      let cleanupError = null;
      try {
        await rollbackOrganizingFolders(
          contextFor(job),
          error.createdFolderIds || createdIds,
          error.createdDirectories || [],
          { providerMoveCompleted: !!error.providerMoveCompleted },
        );
      } catch (failure) {
        cleanupError = failure.message || "Folder cleanup failed.";
      }
      results.push({
        file_id: ref,
        status: "failed",
        error:
          (error.message || "Move failed.") +
          (cleanupError ? ` Folder cleanup also failed: ${cleanupError}` : ""),
      });
    }
  }
  return {
    results,
    moved: results.filter((r) => r.status === "moved").length,
    unchanged: results.filter((r) => r.status === "unchanged").length,
    failed: results.filter((r) => r.status === "failed").length,
  };
}
