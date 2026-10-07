import path from "node:path";
import { z } from "zod";
import {
  db,
  id,
  now,
  one,
  all,
  run,
  fail,
  memberFor,
  permissions,
  tenant,
  conversationFor,
  emit,
} from "./store.mjs";

const uuid = z.string().uuid();
const itemKinds = new Set([
  "document",
  "upload",
  "shared_file",
  "screenshot",
  "notes",
]);
const folderName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      value !== "." &&
      value !== ".." &&
      !/[\\/\u0000-\u001f\u007f]/.test(value),
    "Folder names cannot contain slashes or control characters.",
  );
const locks = new Map();
let outputOperation = null;

export function setOutputFolderOperation(operation) {
  outputOperation = operation;
}

async function mutateOutput(
  context,
  operation,
  args,
  commit = undefined,
  guard = async () => {},
) {
  const mutate =
    outputOperation || (await import("./computers.mjs")).outputFolderOperation;
  if (typeof mutate !== "function")
    fail(503, "Computer folder operations are unavailable.");
  return mutate(context, operation, args, {
    request: context.request,
    guard,
    ...(commit ? { commit } : {}),
  });
}

async function serialized(key, action) {
  const prior = locks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  locks.set(key, next);
  await prior;
  try {
    return await action();
  } finally {
    release();
    if (locks.get(key) === next) locks.delete(key);
  }
}

const keyOf = (value) => value.normalize("NFC").toLocaleLowerCase("en-US");
const folderKey = (physical, value) => (physical ? value : keyOf(value));

function cleanRelative(value) {
  const raw = String(value || "");
  if (
    !raw ||
    raw === "." ||
    raw === ".." ||
    path.posix.isAbsolute(raw) ||
    raw.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(raw) ||
    raw.split("/").some((part) => !part || part === "." || part === "..")
  )
    fail(400, "That folder path is invalid.");
  return raw;
}

function outputRelative(filePath, outputDirectory = null) {
  const source = String(filePath || "").replaceAll("\\", "/");
  let relative = null;
  if (outputDirectory) {
    const root = String(outputDirectory).replace(/\/+$/, "");
    if (source.startsWith(root + "/")) relative = source.slice(root.length + 1);
  }
  if (relative === null) {
    const marker = "/tameduck/outputs/";
    const at = source.indexOf(marker);
    if (at >= 0) relative = source.slice(at + marker.length);
  }
  return cleanRelative(relative);
}

function requireMember(context) {
  const member = memberFor(context.company_id, context.user_id);
  if (!member) fail(403, "Company membership is required.");
  return member;
}

function validateFilters(context, filters = {}) {
  requireMember(context);
  const result = {};
  if (filters.duck_id)
    result.duck_id = tenant(
      "ducks",
      uuid.parse(filters.duck_id),
      context.company_id,
    ).id;
  if (filters.conversation_id)
    result.conversation_id = conversationFor(
      uuid.parse(filters.conversation_id),
      context.company_id,
      context.user_id,
    ).id;
  if (filters.task_id) {
    result.task_id = tenant(
      "tasks",
      uuid.parse(filters.task_id),
      context.company_id,
    ).id;
    requireMember(context);
  }
  return result;
}

function accessibleScope(context, scope) {
  if (scope.scope_kind === "company")
    return (
      scope.scope_id === context.company_id &&
      !!memberFor(context.company_id, context.user_id)
    );
  if (scope.scope_kind === "task")
    return (
      !!memberFor(context.company_id, context.user_id) &&
      !!one(
        "SELECT 1 FROM tasks WHERE id=? AND company_id=?",
        scope.scope_id,
        context.company_id,
      )
    );
  return !!one(
    `SELECT 1 FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id
     WHERE c.id=? AND c.company_id=? AND m.user_id=?`,
    scope.scope_id,
    context.company_id,
    context.user_id,
  );
}

function scopesFor(folderId) {
  return all(
    "SELECT scope_kind,scope_id FROM file_folder_scopes WHERE folder_id=? ORDER BY scope_kind,scope_id",
    folderId,
  );
}

function scopeMatchesContext(context, scopes, { company = false } = {}) {
  if (!context.id) return true;
  if (
    company &&
    scopes.some(
      (scope) =>
        scope.scope_kind === "company" && scope.scope_id === context.company_id,
    )
  )
    return true;
  if (context.task_id)
    return scopes.some(
      (scope) =>
        scope.scope_kind === "task" && scope.scope_id === context.task_id,
    );
  if (context.conversation_id)
    return scopes.some(
      (scope) =>
        scope.scope_kind === "conversation" &&
        scope.scope_id === context.conversation_id,
    );
  return false;
}

function rawFolder(context, folderId, { visible = true } = {}) {
  requireMember(context);
  const folder = one(
    "SELECT * FROM file_folders WHERE id=? AND company_id=?",
    uuid.parse(folderId),
    context.company_id,
  );
  const scopes = folder ? scopesFor(folder.id) : [];
  if (
    !folder ||
    (visible && !scopes.some((scope) => accessibleScope(context, scope)))
  )
    fail(404, "This folder is unavailable.");
  return folder;
}

export function validateFolder(context, folderId) {
  return rawFolder(context, folderId);
}

function canManageFolder(context, folder) {
  const member = requireMember(context);
  if (!permissions(member).docs) return false;
  if (!scopesFor(folder.id).some((scope) => accessibleScope(context, scope)))
    return false;
  const elevated =
    ["owner", "admin"].includes(member.role) || !!permissions(member).company;
  if (folder.created_by !== context.user_id && !elevated) return false;
  return !folder.physical || !!permissions(member).computers;
}

function requireManage(context, folder) {
  if (!canManageFolder(context, folder))
    fail(403, "Only this folder's creator or a company admin can manage it.");
}

function sourceRows(folder, descendants = false) {
  if (!folder.physical) return [];
  return all(
    `SELECT * FROM shared_files WHERE company_id=? AND computer_id=? AND source_box_id=?`,
    folder.company_id,
    folder.computer_id,
    folder.source_box_id,
  ).filter((row) => {
    let relative;
    try {
      relative = outputRelative(row.source_path);
    } catch {
      return false;
    }
    return (
      relative === folder.relative_path ||
      (descendants && relative.startsWith(folder.relative_path + "/"))
    );
  });
}

function logicalLinkedSources(folder) {
  if (folder.physical) return sourceRows(folder, true);
  const placed = all(
    `SELECT sf.* FROM file_folder_items i
     JOIN file_folders f ON f.id=i.folder_id
     JOIN shared_files sf ON sf.id=i.item_id AND sf.company_id=i.company_id
     WHERE i.company_id=? AND i.kind='shared_file' AND f.duck_id=?`,
    folder.company_id,
    folder.duck_id,
  ).filter((row) => {
    const placement = one(
      "SELECT f.relative_path FROM file_folder_items i JOIN file_folders f ON f.id=i.folder_id WHERE i.company_id=? AND i.kind='shared_file' AND i.item_id=?",
      folder.company_id,
      row.id,
    );
    return (
      placement &&
      (placement.relative_path === folder.relative_path ||
        placement.relative_path.startsWith(folder.relative_path + "/"))
    );
  });
  if (!placed.length) return [];
  const origins = new Set(
    placed.map((row) => `${row.computer_id}:${row.source_box_id}`),
  );
  if (origins.size !== 1)
    fail(
      409,
      "This folder has linked files on multiple computers and cannot be renamed together.",
    );
  const origin = placed[0];
  return all(
    "SELECT * FROM shared_files WHERE company_id=? AND computer_id=? AND source_box_id=?",
    folder.company_id,
    origin.computer_id,
    origin.source_box_id,
  ).filter((row) => {
    try {
      const relative = outputRelative(row.source_path);
      return relative.startsWith(folder.relative_path + "/");
    } catch {
      return false;
    }
  });
}

function canManageShared(context, shared) {
  const member = requireMember(context);
  return (
    shared.user_id === context.user_id ||
    ["owner", "admin"].includes(member.role) ||
    !!permissions(member).company
  );
}

function hasContents(folder) {
  return (
    !!one("SELECT 1 FROM file_folders WHERE parent_id=? LIMIT 1", folder.id) ||
    !!one(
      `SELECT 1 FROM file_folder_items i WHERE i.folder_id=? AND (
       (i.kind='document' AND EXISTS(SELECT 1 FROM documents d WHERE d.id=i.item_id AND d.company_id=i.company_id)) OR
       (i.kind='upload' AND EXISTS(SELECT 1 FROM uploads u WHERE u.id=i.item_id AND u.company_id=i.company_id)) OR
       (i.kind='shared_file' AND EXISTS(SELECT 1 FROM shared_files s WHERE s.id=i.item_id AND s.company_id=i.company_id)) OR
       (i.kind='screenshot' AND EXISTS(SELECT 1 FROM computer_captures c WHERE c.id=i.item_id AND c.company_id=i.company_id)) OR
       (i.kind='notes' AND EXISTS(SELECT 1 FROM ducks d WHERE d.id=i.item_id AND d.company_id=i.company_id AND d.notes<>''))
       ) LIMIT 1`,
      folder.id,
    ) ||
    sourceRows(folder, true).length > 0
  );
}

function publicFolder(context, folder) {
  const visibleScopes = scopesFor(folder.id).filter(
    (scope) =>
      accessibleScope(context, scope) &&
      (!context.id || scopeMatchesContext(context, [scope])),
  );
  return {
    id: folder.id,
    name: folder.name,
    path: folder.relative_path,
    parent_id: folder.parent_id,
    duck_id: folder.duck_id,
    computer_id: folder.computer_id,
    conversation_ids: visibleScopes
      .filter((s) => s.scope_kind === "conversation")
      .map((s) => s.scope_id),
    task_ids: visibleScopes
      .filter((s) => s.scope_kind === "task")
      .map((s) => s.scope_id),
    can_manage: canManageFolder(context, folder),
    can_delete: canManageFolder(context, folder) && !hasContents(folder),
  };
}

export function folderList(context, filters = {}) {
  const checked = validateFilters(context, filters);
  cachePublishedFolders(context);
  const jobScoped = !!context.id;
  return all(
    "SELECT * FROM file_folders WHERE company_id=? ORDER BY path_key,id",
    context.company_id,
  )
    .filter((folder) => {
      if (checked.duck_id && folder.duck_id !== checked.duck_id) return false;
      const visible = scopesFor(folder.id).filter((scope) =>
        accessibleScope(context, scope),
      );
      if (!visible.length) return false;
      if (
        checked.conversation_id &&
        !visible.some(
          (s) =>
            s.scope_kind === "conversation" &&
            s.scope_id === checked.conversation_id,
        )
      )
        return false;
      if (
        checked.task_id &&
        !visible.some(
          (s) => s.scope_kind === "task" && s.scope_id === checked.task_id,
        )
      )
        return false;
      if (jobScoped && !scopeMatchesContext(context, visible)) return false;
      return true;
    })
    .map((folder) => publicFolder(context, folder));
}

// Older linked files predate folder records. Their verified source paths are
// enough to rebuild ancestor metadata while the computer is offline; only
// sources already visible to this viewer are considered.
export function cachePublishedFolders(context) {
  requireMember(context);
  for (const source of all(
    "SELECT * FROM shared_files WHERE company_id=? AND computer_id IS NOT NULL",
    context.company_id,
  )) {
    const visible = source.task_id
      ? !!memberFor(context.company_id, context.user_id)
      : !!one(
          "SELECT 1 FROM conversation_members WHERE conversation_id=? AND user_id=?",
          source.conversation_id,
          context.user_id,
        );
    if (!visible || !memberFor(context.company_id, source.user_id)) continue;
    const marker = "/tameduck/outputs/";
    const at = String(source.source_path || "").indexOf(marker);
    if (at < 0) continue;
    try {
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
            output_directory: source.source_path.slice(
              0,
              at + marker.length - 1,
            ),
            computer_id: source.computer_id,
            source_box_id: source.source_box_id,
          },
          shared_file_id: source.id,
        },
      );
    } catch {
      // A malformed legacy path or a concurrent repair stays unprojected.
    }
  }
}

function requestedScopes(context, args, parent = null) {
  const scopes = parent ? scopesFor(parent.id) : [];
  const conversationId =
    args.conversation_id || context.conversation_id || null;
  const taskId = args.task_id || context.task_id || null;
  if (conversationId) {
    const conversation = conversationFor(
      uuid.parse(conversationId),
      context.company_id,
      context.user_id,
    );
    scopes.push({ scope_kind: "conversation", scope_id: conversation.id });
  }
  if (taskId) {
    const task = tenant("tasks", uuid.parse(taskId), context.company_id);
    requireMember(context);
    scopes.push({ scope_kind: "task", scope_id: task.id });
  }
  if (!scopes.length)
    scopes.push({ scope_kind: "company", scope_id: context.company_id });
  return [
    ...new Map(
      scopes.map((scope) => [`${scope.scope_kind}:${scope.scope_id}`, scope]),
    ).values(),
  ];
}

function namespaceFor({
  physical,
  computer_id,
  source_box_id,
  duck_id,
  scopes,
}) {
  if (physical) return `physical:${computer_id}:${source_box_id}`;
  if (duck_id) return `duck:${duck_id}`;
  const first = scopes[0];
  return `${first.scope_kind}:${first.scope_id}`;
}

function insertScopes(folderId, scopes, stamp = now()) {
  for (const scope of scopes)
    run(
      "INSERT OR IGNORE INTO file_folder_scopes(folder_id,scope_kind,scope_id,created) VALUES(?,?,?,?)",
      folderId,
      scope.scope_kind,
      scope.scope_id,
      stamp,
    );
}

function conflict(error) {
  if (
    error?.code?.startsWith("SQLITE_CONSTRAINT") ||
    /UNIQUE constraint/i.test(error?.message || "")
  )
    fail(409, "A folder with that name already exists here.");
  throw error;
}

export async function folderCreate(context, args = {}) {
  const member = requireMember(context);
  if (!permissions(member).docs)
    fail(403, "You do not have permission to manage files.");
  const suppliedName = folderName.parse(args.name);
  const parent = args.parent_id ? rawFolder(context, args.parent_id) : null;
  if (parent) requireManage(context, parent);
  const scopes = requestedScopes(context, args, parent);
  let duckId = parent?.duck_id || args.duck_id || context.duck_id || null;
  if (duckId)
    duckId = tenant("ducks", uuid.parse(duckId), context.company_id).id;
  const physical = parent
    ? !!parent.physical
    : args.computer !== false && !!duckId;
  const name = physical ? suppliedName : suppliedName.normalize("NFC");
  if (physical && !permissions(member).computers)
    fail(403, "You do not have permission to use company computers.");
  const relativePath = cleanRelative(
    parent ? `${parent.relative_path}/${name}` : name,
  );
  let computerId = parent?.computer_id || args.computer_id || null;
  let sourceBoxId = parent?.source_box_id || args.source_box_id || null;
  let sourceToken = null;
  let folderId = id();
  const stamp = now();
  const persist = (result = null) => {
    if (result) {
      computerId = result.computer_id;
      sourceBoxId = result.source_box_id;
      sourceToken = result.result?.source_token
        ? JSON.stringify(result.result.source_token)
        : null;
    }
    const namespaceKey =
      parent?.namespace_key ||
      namespaceFor({
        physical,
        computer_id: computerId,
        source_box_id: sourceBoxId,
        duck_id: duckId,
        scopes,
      });
    if (physical) {
      const existing = one(
        `SELECT * FROM file_folders WHERE company_id=? AND computer_id=? AND source_box_id=?
         AND path_key=? AND physical=1`,
        context.company_id,
        computerId,
        sourceBoxId,
        relativePath,
      );
      if (existing) {
        const elevated =
          ["owner", "admin"].includes(member.role) ||
          !!permissions(member).company;
        if (
          existing.parent_id !== (parent?.id || null) ||
          existing.duck_id !== duckId ||
          (existing.created_by !== context.user_id && !elevated)
        )
          fail(409, "A folder with that name already exists here.");
        insertScopes(existing.id, scopes, stamp);
        folderId = existing.id;
        return;
      }
    }
    try {
      db.transaction(() => {
        run(
          `INSERT INTO file_folders(id,company_id,parent_id,namespace_key,name,name_key,relative_path,path_key,
         duck_id,computer_id,source_box_id,source_token,physical,created_by,created,updated)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          folderId,
          context.company_id,
          parent?.id || null,
          namespaceKey,
          name,
          folderKey(physical, name),
          relativePath,
          folderKey(physical, relativePath),
          duckId,
          computerId,
          sourceBoxId,
          sourceToken,
          physical ? 1 : 0,
          context.user_id,
          stamp,
          stamp,
        );
        insertScopes(folderId, scopes, stamp);
      })();
    } catch (error) {
      conflict(error);
    }
  };
  const guard = () => {
    const currentMember = requireMember(context);
    if (
      !permissions(currentMember).docs ||
      !permissions(currentMember).computers
    )
      fail(403, "You no longer have permission to create this folder.");
    if (parent) {
      const currentParent = rawFolder(context, parent.id);
      requireManage(context, currentParent);
      if (
        currentParent.relative_path !== parent.relative_path ||
        currentParent.computer_id !== parent.computer_id ||
        currentParent.source_box_id !== parent.source_box_id ||
        currentParent.namespace_key !== parent.namespace_key
      )
        fail(
          409,
          "The parent folder changed while this folder was being created.",
        );
    }
    requestedScopes(context, args, parent);
  };
  if (physical)
    await mutateOutput(
      { ...context, duck_id: duckId },
      "create",
      {
        path: relativePath,
        ...(computerId ? { computer_id: computerId } : {}),
        ...(sourceBoxId ? { source_box_id: sourceBoxId } : {}),
      },
      persist,
      guard,
    );
  else persist();
  emit(context.company_id);
  return publicFolder(context, rawFolder(context, folderId));
}

export async function folderRename(context, folderId, value) {
  const folder = rawFolder(context, folderId);
  requireManage(context, folder);
  const suppliedName = folderName.parse(value);
  const name = folder.physical ? suppliedName : suppliedName.normalize("NFC");
  const parent = folder.parent_id ? rawFolder(context, folder.parent_id) : null;
  const nextPath = cleanRelative(
    parent ? `${parent.relative_path}/${name}` : name,
  );
  if (nextPath === folder.relative_path) return publicFolder(context, folder);
  return serialized(
    `${context.company_id}\0${folder.namespace_key}`,
    async () => {
      if (
        one(
          `SELECT 1 FROM file_folders WHERE company_id=? AND namespace_key=? AND COALESCE(parent_id,'')=?
       AND name_key=? AND id<>?`,
          context.company_id,
          folder.namespace_key,
          folder.parent_id || "",
          folderKey(!!folder.physical, name),
          folder.id,
        )
      )
        fail(409, "A folder with that name already exists here.");
      const affectedSources = logicalLinkedSources(folder);
      const materializations = all(
        "SELECT computer_id,source_box_id FROM file_folder_materializations WHERE folder_id=?",
        folder.id,
      );
      if (materializations.length > 1)
        fail(
          409,
          "This folder is present on multiple computers and cannot be renamed together.",
        );
      if (affectedSources.some((source) => !canManageShared(context, source)))
        fail(403, "This folder contains a file shared by someone else.");
      const oldPath = folder.relative_path;
      const stamp = now();
      const guard = () => {
        const current = rawFolder(context, folder.id);
        requireManage(context, current);
        if (
          current.relative_path !== oldPath ||
          current.computer_id !== folder.computer_id ||
          current.source_box_id !== folder.source_box_id
        )
          fail(409, "This folder changed while it was being renamed.");
        const currentMaterializations = all(
          "SELECT computer_id,source_box_id FROM file_folder_materializations WHERE folder_id=?",
          current.id,
        );
        if (
          currentMaterializations.length !== materializations.length ||
          currentMaterializations.some(
            (row) =>
              !materializations.some(
                (original) =>
                  original.computer_id === row.computer_id &&
                  original.source_box_id === row.source_box_id,
              ),
          )
        )
          fail(
            409,
            "This folder's computer location changed while it was being renamed.",
          );
        const currentSources = logicalLinkedSources(current);
        if (
          currentSources.length !== affectedSources.length ||
          currentSources.some(
            (source) =>
              !affectedSources.some((original) => original.id === source.id),
          )
        )
          fail(409, "Files in this folder changed while it was being renamed.");
        if (currentSources.some((source) => !canManageShared(context, source)))
          fail(403, "This folder contains a file shared by someone else.");
      };
      const persist = () => {
        guard();
        try {
          db.transaction(() => {
            const descendants = all(
              `SELECT id,relative_path,physical FROM file_folders
               WHERE company_id=? AND (namespace_key=? OR (physical=0 AND duck_id=?))`,
              context.company_id,
              folder.namespace_key,
              folder.duck_id,
            ).filter(
              (row) =>
                row.relative_path === oldPath ||
                row.relative_path.startsWith(oldPath + "/"),
            );
            for (const row of descendants) {
              const relative =
                nextPath + row.relative_path.slice(oldPath.length);
              run(
                "UPDATE file_folders SET name=CASE WHEN id=? THEN ? ELSE name END,name_key=CASE WHEN id=? THEN ? ELSE name_key END,relative_path=?,path_key=?,updated=? WHERE id=?",
                folder.id,
                name,
                folder.id,
                folderKey(!!folder.physical, name),
                relative,
                folderKey(!!row.physical, relative),
                stamp,
                row.id,
              );
            }
            for (const source of affectedSources) {
              const relative = outputRelative(source.source_path);
              const nextRelative = nextPath + relative.slice(oldPath.length);
              const prefix = source.source_path.slice(
                0,
                source.source_path.length - relative.length,
              );
              run(
                "UPDATE shared_files SET source_path=?,updated=?,revision=revision+1 WHERE id=?",
                prefix + nextRelative,
                stamp,
                source.id,
              );
            }
          })();
        } catch (error) {
          conflict(error);
        }
      };
      if (
        folder.physical ||
        affectedSources.length ||
        materializations.length
      ) {
        const source = affectedSources[0] || materializations[0];
        await mutateOutput(
          { ...context, duck_id: folder.duck_id },
          "rename",
          {
            path: folder.relative_path,
            target: nextPath,
            computer_id: folder.computer_id || source.computer_id,
            source_box_id: folder.source_box_id || source.source_box_id,
          },
          persist,
          guard,
        );
      } else persist();
      emit(context.company_id);
      return publicFolder(context, rawFolder(context, folder.id));
    },
  );
}

export async function folderDelete(context, folderId) {
  const folder = rawFolder(context, folderId);
  requireManage(context, folder);
  if (hasContents(folder))
    fail(409, "The folder must be empty before it can be deleted.");
  const guard = () => {
    const current = rawFolder(context, folder.id);
    requireManage(context, current);
    if (
      current.relative_path !== folder.relative_path ||
      current.computer_id !== folder.computer_id ||
      current.source_box_id !== folder.source_box_id
    )
      fail(409, "This folder changed while it was being deleted.");
    if (hasContents(current))
      fail(409, "The folder must be empty before it can be deleted.");
  };
  const persist = () => {
    guard();
    db.transaction(() => {
      run(
        `DELETE FROM file_folder_items WHERE folder_id=? AND (
         (kind='document' AND NOT EXISTS(SELECT 1 FROM documents d WHERE d.id=file_folder_items.item_id AND d.company_id=file_folder_items.company_id)) OR
         (kind='upload' AND NOT EXISTS(SELECT 1 FROM uploads u WHERE u.id=file_folder_items.item_id AND u.company_id=file_folder_items.company_id)) OR
         (kind='shared_file' AND NOT EXISTS(SELECT 1 FROM shared_files s WHERE s.id=file_folder_items.item_id AND s.company_id=file_folder_items.company_id)) OR
         (kind='screenshot' AND NOT EXISTS(SELECT 1 FROM computer_captures c WHERE c.id=file_folder_items.item_id AND c.company_id=file_folder_items.company_id)) OR
         (kind='notes' AND NOT EXISTS(SELECT 1 FROM ducks d WHERE d.id=file_folder_items.item_id AND d.company_id=file_folder_items.company_id AND d.notes<>''))
         )`,
        folder.id,
      );
      run(
        "DELETE FROM file_folders WHERE id=? AND company_id=?",
        folder.id,
        context.company_id,
      );
    })();
  };
  if (folder.physical)
    await mutateOutput(
      { ...context, duck_id: folder.duck_id },
      "delete",
      {
        path: folder.relative_path,
        computer_id: folder.computer_id,
        source_box_id: folder.source_box_id,
      },
      persist,
      guard,
    );
  else {
    const materializations = all(
      "SELECT computer_id,source_box_id FROM file_folder_materializations WHERE folder_id=?",
      folder.id,
    );
    for (const materialized of materializations)
      await mutateOutput(
        { ...context, duck_id: folder.duck_id },
        "delete",
        {
          path: folder.relative_path,
          computer_id: materialized.computer_id,
          source_box_id: materialized.source_box_id,
        },
        undefined,
        guard,
      );
    persist();
  }
  emit(context.company_id);
  return { deleted: true, id: folder.id };
}

function itemScopes(context, kind, itemId, { allowMissing = false } = {}) {
  if (!itemKinds.has(kind)) fail(400, "Unknown file type.");
  const member = requireMember(context);
  if (!permissions(member).docs)
    fail(403, "You do not have permission to manage files.");
  if (kind === "document") {
    if (!permissions(requireMember(context)).docs)
      fail(403, "You do not have permission to manage documents.");
    const document = one(
      "SELECT id FROM documents WHERE id=? AND company_id=?",
      itemId,
      context.company_id,
    );
    if (!document && !allowMissing) fail(404, "This document is unavailable.");
    return [];
  }
  if (kind === "notes") {
    if (!context.id && !permissions(member).ducks)
      fail(403, "You do not have permission to manage duck notes.");
    const duck = one(
      "SELECT id FROM ducks WHERE id=? AND company_id=? AND notes<>''",
      itemId,
      context.company_id,
    );
    if (!duck) fail(404, "These notes are unavailable.");
    if (context.id && context.duck_id !== itemId)
      fail(404, "These notes are unavailable in the current work.");
    return [{ scope_kind: "company", scope_id: context.company_id }];
  }
  if (kind === "screenshot") {
    const capture = one(
      "SELECT cc.id,cc.conversation_id,co.duck_id FROM computer_captures cc JOIN computers co ON co.id=cc.computer_id WHERE cc.id=? AND cc.company_id=?",
      itemId,
      context.company_id,
    );
    if (!capture) fail(404, "This capture is unavailable.");
    conversationFor(
      capture.conversation_id,
      context.company_id,
      context.user_id,
    );
    if (
      context.id &&
      (capture.duck_id !== context.duck_id ||
        !one(
          `SELECT 1 FROM message_artifacts a JOIN messages m ON m.id=a.message_id
       WHERE a.company_id=? AND a.kind='screenshot' AND a.reference_id=?
         AND m.company_id=? AND m.duck_id=?`,
          context.company_id,
          itemId,
          context.company_id,
          context.duck_id,
        ))
    )
      fail(404, "This capture is unavailable in the current work.");
    return [{ scope_kind: "conversation", scope_id: capture.conversation_id }];
  }
  if (kind === "upload") {
    const upload = one(
      "SELECT * FROM uploads WHERE id=? AND company_id=?",
      itemId,
      context.company_id,
    );
    if (!upload) fail(404, "This file is unavailable.");
    const task = one(
      "SELECT task_id FROM task_uploads WHERE upload_id=? AND company_id=?",
      upload.id,
      context.company_id,
    );
    if (
      context.id &&
      ((task && task.task_id !== context.task_id) ||
        (!task && upload.conversation_id !== context.conversation_id))
    ) {
      const exportRow = one(
        "SELECT duck_id FROM computer_file_exports WHERE upload_id=? AND company_id=?",
        upload.id,
        context.company_id,
      );
      if (
        !exportRow ||
        exportRow.duck_id !== context.duck_id ||
        !upload.message_id
      )
        fail(404, "This file is unavailable in the current work.");
    }
    if (task) tenant("tasks", task.task_id, context.company_id);
    else
      conversationFor(
        upload.conversation_id,
        context.company_id,
        context.user_id,
      );
    const member = requireMember(context);
    const elevated =
      ["owner", "admin"].includes(member.role) || !!permissions(member).company;
    if (upload.user_id !== context.user_id && !elevated)
      fail(
        403,
        "Only the person who shared this file or a company admin can move it.",
      );
    if (task) return [{ scope_kind: "task", scope_id: task.task_id }];
    return [{ scope_kind: "conversation", scope_id: upload.conversation_id }];
  }
  const anchor = one(
    "SELECT * FROM shared_files WHERE id=? AND company_id=?",
    itemId,
    context.company_id,
  );
  if (!anchor) fail(404, "This file is unavailable.");
  if (anchor.task_id) tenant("tasks", anchor.task_id, context.company_id);
  else
    conversationFor(
      anchor.conversation_id,
      context.company_id,
      context.user_id,
    );
  const group = sharedSourceGroup(anchor);
  if (
    context.id &&
    group.some(
      (row) =>
        row.duck_id !== context.duck_id || (!row.task_id && !row.message_id),
    )
  )
    fail(404, "This file is unavailable in the current work.");
  if (group.some((row) => !canManageShared(context, row)))
    fail(
      403,
      "Every private share of this file must be manageable before it can be moved.",
    );
  const scopes = [];
  for (const row of group) {
    if (row.task_id) scopes.push({ scope_kind: "task", scope_id: row.task_id });
    else {
      conversationFor(row.conversation_id, context.company_id, context.user_id);
      scopes.push({
        scope_kind: "conversation",
        scope_id: row.conversation_id,
      });
    }
  }
  return scopes;
}

function sharedSourceGroup(anchor) {
  return all(
    "SELECT * FROM shared_files WHERE company_id=? AND computer_id IS ? AND source_box_id=? AND source_path=?",
    anchor.company_id,
    anchor.computer_id,
    anchor.source_box_id,
    anchor.source_path,
  );
}

function folderCovers(folder, requiredScopes) {
  const available = scopesFor(folder.id);
  if (
    available.some(
      (scope) =>
        scope.scope_kind === "company" && scope.scope_id === folder.company_id,
    )
  )
    return true;
  return requiredScopes.every((required) =>
    available.some(
      (scope) =>
        scope.scope_kind === required.scope_kind &&
        scope.scope_id === required.scope_id,
    ),
  );
}

export function validateFolderDestination(context, folderId, item = {}) {
  requireMember(context);
  const required = item.kind
    ? itemScopes(context, item.kind, item.id, {
        allowMissing: item.kind === "document" && item.allow_missing !== false,
      })
    : [];
  if (folderId === null || folderId === undefined || folderId === "")
    return null;
  const folder = rawFolder(context, folderId);
  requireManage(context, folder);
  if (item.kind) {
    if (
      item.kind === "shared_file" &&
      !folder.physical &&
      folder.duck_id !==
        one("SELECT duck_id FROM shared_files WHERE id=?", item.id)?.duck_id
    )
      fail(409, "Choose a folder for this duck.");
  }
  return folder;
}

function placeItem(context, folder, kind, itemId) {
  if (!folder) {
    run(
      "DELETE FROM file_folder_items WHERE company_id=? AND kind=? AND item_id=?",
      context.company_id,
      kind,
      itemId,
    );
    return;
  }
  run(
    `INSERT INTO file_folder_items(company_id,folder_id,kind,item_id,created) VALUES(?,?,?,?,?)
     ON CONFLICT(company_id,kind,item_id) DO UPDATE SET folder_id=excluded.folder_id,created=excluded.created`,
    context.company_id,
    folder.id,
    kind,
    itemId,
    now(),
  );
}

export function documentFolder(context, documentId, folderId) {
  const docId = uuid.parse(documentId);
  tenant("documents", docId, context.company_id);
  const folder = validateFolderDestination(context, folderId, {
    kind: "document",
    id: docId,
    allow_missing: false,
  });
  placeItem(context, folder, "document", docId);
  return { kind: "document", id: docId, folder_id: folder?.id || null };
}

export async function folderMoveItem(context, folderId, item = {}) {
  let kind = String(item.kind || "");
  let itemId = uuid.parse(item.id);
  if (kind === "upload") {
    const linked = one(
      `SELECT sf.id FROM shared_file_versions v JOIN shared_files sf ON sf.id=v.shared_file_id
       WHERE v.upload_id=? AND sf.company_id=? AND sf.current_upload_id=v.upload_id`,
      itemId,
      context.company_id,
    );
    if (linked) {
      kind = "shared_file";
      itemId = linked.id;
    }
  }
  if (kind === "document") tenant("documents", itemId, context.company_id);
  const folder = validateFolderDestination(context, folderId, {
    kind,
    id: itemId,
  });
  if (kind !== "shared_file") {
    db.transaction(() => {
      validateFolderDestination(context, folder?.id || null, {
        kind,
        id: itemId,
      });
      placeItem(context, folder, kind, itemId);
      if (folder) insertScopes(folder.id, itemScopes(context, kind, itemId));
    })();
    emit(context.company_id);
    return { kind, id: itemId, folder_id: folder?.id || null };
  }
  const anchor = one(
    "SELECT * FROM shared_files WHERE id=? AND company_id=?",
    itemId,
    context.company_id,
  );
  const group = sharedSourceGroup(anchor);
  const sourceRelative = outputRelative(anchor.source_path);
  const targetRelative = folder
    ? cleanRelative(
        `${folder.relative_path}/${path.posix.basename(sourceRelative)}`,
      )
    : path.posix.basename(sourceRelative);
  if (
    folder?.physical &&
    (folder.computer_id !== anchor.computer_id ||
      folder.source_box_id !== anchor.source_box_id)
  )
    fail(409, "Choose a folder on the same computer as this file.");
  const stamp = now();
  const guard = () => {
    const currentAnchor = one(
      "SELECT * FROM shared_files WHERE id=? AND company_id=?",
      itemId,
      context.company_id,
    );
    if (
      !currentAnchor ||
      currentAnchor.source_path !== anchor.source_path ||
      currentAnchor.computer_id !== anchor.computer_id ||
      currentAnchor.source_box_id !== anchor.source_box_id
    )
      fail(409, "This file changed while it was being moved.");
    const currentGroup = sharedSourceGroup(currentAnchor);
    if (
      currentGroup.length !== group.length ||
      currentGroup.some(
        (row) => !group.some((original) => original.id === row.id),
      )
    )
      fail(409, "This file's shares changed while it was being moved.");
    const currentDestination = validateFolderDestination(
      context,
      folder?.id || null,
      {
        kind: "shared_file",
        id: itemId,
      },
    );
    if (
      folder &&
      (currentDestination.relative_path !== folder.relative_path ||
        currentDestination.computer_id !== folder.computer_id ||
        currentDestination.source_box_id !== folder.source_box_id)
    )
      fail(
        409,
        "The destination folder changed while the file was being moved.",
      );
  };
  const persist = () =>
    db.transaction(() => {
      guard();
      const prefix = anchor.source_path.slice(
        0,
        anchor.source_path.length - sourceRelative.length,
      );
      for (const row of group) {
        run(
          "UPDATE shared_files SET source_path=?,updated=?,revision=revision+1 WHERE id=?",
          prefix + targetRelative,
          stamp,
          row.id,
        );
        placeItem(context, folder, "shared_file", row.id);
      }
      if (folder) {
        insertScopes(folder.id, itemScopes(context, "shared_file", itemId));
        if (!folder.physical) {
          const parts = folder.relative_path.split("/");
          for (let n = 1; n <= parts.length; n++) {
            const directoryPath = parts.slice(0, n).join("/");
            const logical = one(
              "SELECT id FROM file_folders WHERE company_id=? AND duck_id=? AND physical=0 AND relative_path=?",
              context.company_id,
              anchor.duck_id,
              directoryPath,
            );
            if (logical)
              run(
                "INSERT OR IGNORE INTO file_folder_materializations VALUES(?,?,?,?)",
                logical.id,
                anchor.computer_id,
                anchor.source_box_id,
                stamp,
              );
          }
        }
      }
    })();
  const createdDirectories = [];
  let providerMoveCompleted = false;
  try {
    if (targetRelative !== sourceRelative && folder && !folder.physical) {
      const parts = folder.relative_path.split("/");
      for (let n = 1; n <= parts.length; n++) {
        const directoryPath = parts.slice(0, n).join("/");
        const created = await mutateOutput(
          { ...context, duck_id: anchor.duck_id },
          "create",
          {
            path: directoryPath,
            computer_id: anchor.computer_id,
            source_box_id: anchor.source_box_id,
          },
          undefined,
          guard,
        );
        if (created.created === true)
          createdDirectories.push({
            path: directoryPath,
            computer_id: anchor.computer_id,
            source_box_id: anchor.source_box_id,
            duck_id: anchor.duck_id,
          });
      }
    }
    if (targetRelative !== sourceRelative)
      await mutateOutput(
        { ...context, duck_id: anchor.duck_id },
        "move_file",
        {
          path: sourceRelative,
          target: targetRelative,
          computer_id: anchor.computer_id,
          source_box_id: anchor.source_box_id,
        },
        () => {
          providerMoveCompleted = true;
          persist();
        },
        guard,
      );
    else persist();
  } catch (error) {
    error.createdDirectories = createdDirectories;
    error.providerMoveCompleted = providerMoveCompleted;
    throw error;
  }
  emit(context.company_id);
  return { kind, id: itemId, folder_id: folder?.id || null };
}

export function registerPublishedFile(
  context,
  { file, shared_file_id, folder_id = null },
) {
  requireMember(context);
  const shared = one(
    "SELECT * FROM shared_files WHERE id=? AND company_id=?",
    uuid.parse(shared_file_id),
    context.company_id,
  );
  if (!shared) fail(404, "This file is unavailable.");
  const fileRelative = outputRelative(file.path, file.output_directory);
  const directory = path.posix.dirname(fileRelative);
  if (directory === ".") {
    if (folder_id)
      fail(409, "The selected folder does not match the exported file path.");
    placeItem(context, null, "shared_file", shared.id);
    return { folder_id: null };
  }
  const parts = directory.split("/");
  const namespaceKey = `physical:${file.computer_id}:${file.source_box_id}`;
  const scopes = shared.task_id
    ? [
        { scope_kind: "task", scope_id: shared.task_id },
        { scope_kind: "conversation", scope_id: shared.conversation_id },
      ]
    : [{ scope_kind: "conversation", scope_id: shared.conversation_id }];
  let parentId = null;
  let relative = "";
  let current = null;
  const stamp = now();
  db.transaction(() => {
    for (const part of parts) {
      relative = relative ? `${relative}/${part}` : part;
      current = one(
        `SELECT * FROM file_folders WHERE company_id=? AND computer_id=? AND source_box_id=? AND path_key=? AND physical=1`,
        context.company_id,
        file.computer_id,
        file.source_box_id,
        relative,
      );
      if (!current)
        current = one(
          `SELECT * FROM file_folders WHERE company_id=? AND namespace_key=? AND physical=0 AND path_key=?`,
          context.company_id,
          `duck:${shared.duck_id}`,
          keyOf(relative),
        );
      if (!current) {
        const folderId = id();
        run(
          `INSERT INTO file_folders(id,company_id,parent_id,namespace_key,name,name_key,relative_path,path_key,
           duck_id,computer_id,source_box_id,source_token,physical,created_by,created,updated)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          folderId,
          context.company_id,
          parentId,
          namespaceKey,
          part,
          part,
          relative,
          relative,
          shared.duck_id,
          file.computer_id,
          file.source_box_id,
          null,
          1,
          context.user_id,
          stamp,
          stamp,
        );
        current = one("SELECT * FROM file_folders WHERE id=?", folderId);
      }
      insertScopes(current.id, scopes, stamp);
      if (!current.physical)
        run(
          "INSERT OR IGNORE INTO file_folder_materializations VALUES(?,?,?,?)",
          current.id,
          file.computer_id,
          file.source_box_id,
          stamp,
        );
      parentId = current.id;
    }
    if (folder_id && current.id !== uuid.parse(folder_id))
      fail(409, "The selected folder does not match the exported file path.");
    placeItem(context, current, "shared_file", shared.id);
  })();
  return { folder_id: current.id };
}

export function syncPublishedFileSource({
  company_id,
  computer_id,
  source_box_id,
  old_path,
  new_path,
}) {
  const oldRelative = cleanRelative(old_path);
  const nextRelative = cleanRelative(new_path);
  const within = (relative) =>
    relative === oldRelative || relative.startsWith(oldRelative + "/");
  const allFolders = all(
    "SELECT * FROM file_folders WHERE company_id=?",
    company_id,
  );
  const roots = new Set(
    allFolders
      .filter(
        (folder) =>
          within(folder.relative_path) &&
          ((folder.physical &&
            folder.computer_id === computer_id &&
            folder.source_box_id === source_box_id) ||
            (!folder.physical &&
              !!one(
                `SELECT 1 FROM file_folder_materializations WHERE folder_id=?
         AND computer_id=? AND source_box_id=?`,
                folder.id,
                computer_id,
                source_box_id,
              ))),
      )
      .map((folder) => folder.id),
  );
  if (!roots.size) return 0;
  if (path.posix.dirname(oldRelative) !== path.posix.dirname(nextRelative))
    fail(
      409,
      "A known folder can only be synchronized after a rename within its parent.",
    );
  const byId = new Map(allFolders.map((folder) => [folder.id, folder]));
  const linkedToRoot = (folder) => {
    let current = folder;
    while (current) {
      if (roots.has(current.id)) return true;
      current = current.parent_id ? byId.get(current.parent_id) : null;
    }
    return false;
  };
  const folders = allFolders.filter(
    (folder) => within(folder.relative_path) && linkedToRoot(folder),
  );
  const stamp = now();
  db.transaction(() => {
    for (const folder of folders) {
      const relative =
        nextRelative + folder.relative_path.slice(oldRelative.length);
      const renamed = folder.relative_path === oldRelative;
      const name = renamed ? path.posix.basename(relative) : folder.name;
      run(
        `UPDATE file_folders SET name=?,name_key=?,relative_path=?,path_key=?,updated=? WHERE id=?`,
        name,
        folderKey(!!folder.physical, name),
        relative,
        folderKey(!!folder.physical, relative),
        stamp,
        folder.id,
      );
    }
  })();
  return folders.length;
}

// A scan may discover empty directories, but it must never turn the raw tree
// into an access oracle. Only an already registered physical folder and its
// descendants are eligible. The output root itself is deliberately omitted.
export function syncPublishedDirectories(
  context,
  { computer_id, source_box_id, directories = [] } = {},
) {
  const computer = one(
    "SELECT id,company_id,duck_id,box_id FROM computers WHERE id=? AND company_id=?",
    computer_id,
    context.company_id,
  );
  if (!computer || computer.box_id !== source_box_id)
    fail(409, "The computer changed while its folders were being checked.");
  const namespaceKey = `physical:${computer.id}:${source_box_id}`;
  const candidates = directories
    .map((directory) => {
      let relative = directory.relative_path;
      if (!relative && directory.path)
        try {
          relative = outputRelative(directory.path, directory.output_directory);
        } catch {
          return null;
        }
      if (!relative || relative === ".") return null;
      try {
        relative = cleanRelative(relative);
      } catch {
        return null;
      }
      return {
        relative,
        token: Array.isArray(directory.token)
          ? JSON.stringify(directory.token)
          : null,
      };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.relative.split("/").length - b.relative.split("/").length ||
        a.relative.localeCompare(b.relative),
    );
  let inserted = 0;
  const stamp = now();
  db.transaction(() => {
    for (const candidate of candidates) {
      const exact = one(
        `SELECT * FROM file_folders WHERE company_id=? AND computer_id=? AND source_box_id=?
         AND path_key=? AND physical=1`,
        context.company_id,
        computer.id,
        source_box_id,
        candidate.relative,
      );
      if (exact) {
        if (candidate.token && exact.source_token !== candidate.token)
          run(
            "UPDATE file_folders SET source_token=?,updated=? WHERE id=?",
            candidate.token,
            stamp,
            exact.id,
          );
        continue;
      }
      const materialized = one(
        `SELECT f.id FROM file_folders f JOIN file_folder_materializations m ON m.folder_id=f.id
         WHERE f.company_id=? AND f.physical=0 AND f.relative_path=?
           AND m.computer_id=? AND m.source_box_id=?`,
        context.company_id,
        candidate.relative,
        computer.id,
        source_box_id,
      );
      if (materialized) continue;
      const parentPath = path.posix.dirname(candidate.relative);
      if (parentPath === ".") continue;
      const parent =
        one(
          `SELECT * FROM file_folders WHERE company_id=? AND computer_id=? AND source_box_id=?
         AND path_key=? AND physical=1`,
          context.company_id,
          computer.id,
          source_box_id,
          parentPath,
        ) ||
        one(
          `SELECT f.* FROM file_folders f JOIN file_folder_materializations m ON m.folder_id=f.id
         WHERE f.company_id=? AND f.physical=0 AND f.relative_path=?
           AND m.computer_id=? AND m.source_box_id=?`,
          context.company_id,
          parentPath,
          computer.id,
          source_box_id,
        );
      if (!parent) continue;
      const logicalChild = one(
        `SELECT * FROM file_folders WHERE company_id=? AND duck_id=? AND physical=0
         AND parent_id=? AND relative_path=?`,
        context.company_id,
        computer.duck_id,
        parent.id,
        candidate.relative,
      );
      if (logicalChild) {
        run(
          "INSERT OR IGNORE INTO file_folder_materializations VALUES(?,?,?,?)",
          logicalChild.id,
          computer.id,
          source_box_id,
          stamp,
        );
        continue;
      }
      const childId = id();
      const childName = path.posix.basename(candidate.relative);
      try {
        run(
          `INSERT INTO file_folders(id,company_id,parent_id,namespace_key,name,name_key,relative_path,path_key,
           duck_id,computer_id,source_box_id,source_token,physical,created_by,created,updated)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          childId,
          context.company_id,
          parent.id,
          namespaceKey,
          childName,
          childName,
          candidate.relative,
          candidate.relative,
          parent.duck_id || computer.duck_id,
          computer.id,
          source_box_id,
          candidate.token,
          1,
          parent.created_by,
          stamp,
          stamp,
        );
        insertScopes(childId, scopesFor(parent.id), stamp);
        inserted += 1;
      } catch (error) {
        if (!(
          error?.code?.startsWith("SQLITE_CONSTRAINT") ||
          /UNIQUE constraint/i.test(error?.message || "")
        ))
          throw error;
      }
    }
  })();
  if (inserted) emit(context.company_id);
  return { registered: inserted };
}

export function folderIdsForItems(company, items, viewer = null) {
  const viewerContext = viewer
    ? typeof viewer === "object"
      ? { ...viewer, company_id: company }
      : { company_id: company, user_id: viewer }
    : null;
  if (viewerContext) {
    if (!memberFor(company, viewerContext.user_id)) return [];
    cachePublishedFolders(viewerContext);
  }
  return items.map((item) => {
    const kind = item.kind;
    const ids =
      kind === "shared_file"
        ? [
            item.shared_file_id,
            ...(item.places || []).map((place) => place.shared_file_id),
          ].filter(Boolean)
        : [item.id];
    const placed =
      ids
        .map((itemId) =>
          one(
            `SELECT f.* FROM file_folder_items i JOIN file_folders f ON f.id=i.folder_id
         WHERE i.company_id=? AND i.kind=? AND i.item_id=?`,
            company,
            kind,
            itemId,
          ),
        )
        .find(
          (folder) =>
            folder &&
            (!viewerContext ||
              (scopesFor(folder.id).some((scope) =>
                accessibleScope(viewerContext, scope),
              ) &&
                scopeMatchesContext(viewerContext, scopesFor(folder.id)))),
        )?.id || null;
    return { ...item, folder_id: placed };
  });
}

// Used by the unified catalog and by human clients to show actionable moves.
export function fileMoveCapability(context, kind, itemId) {
  try {
    itemScopes(context, kind, itemId);
    return { can_move: true };
  } catch (error) {
    return {
      can_move: false,
      reason: error.message || "This file cannot be moved.",
    };
  }
}

// A path belongs to one duck namespace. Scope rows are taken from the
// source's verified grants, so an existing folder becomes usable in each
// original location without granting file access through the folder itself.
// Roll back only paths the provider explicitly reported as created by this
// attempt. A directory that predated the attempt must never be removed here.
export async function rollbackOrganizingFolders(
  context,
  createdIds = [],
  createdDirectories = [],
  { providerMoveCompleted = false } = {},
) {
  if (providerMoveCompleted)
    fail(
      409,
      "The provider move completed before metadata failed. The folder was kept for reconciliation.",
    );
  for (const directory of [...createdDirectories].reverse())
    await mutateOutput({ ...context, duck_id: directory.duck_id }, "delete", {
      path: directory.path,
      computer_id: directory.computer_id,
      source_box_id: directory.source_box_id,
    });
  db.transaction(() => {
    for (const folderId of [...createdIds].reverse()) {
      const folder = one(
        "SELECT * FROM file_folders WHERE id=? AND company_id=?",
        folderId,
        context.company_id,
      );
      if (
        !folder ||
        folder.created_by !== context.user_id ||
        hasContents(folder)
      )
        continue;
      run(
        "DELETE FROM file_folders WHERE id=? AND company_id=?",
        folderId,
        context.company_id,
      );
    }
  })();
}

export function ensureOrganizingFolder(
  context,
  value,
  item,
  { details = false } = {},
) {
  const member = requireMember(context);
  if (!permissions(member).docs)
    fail(403, "You do not have permission to manage files.");
  const segments = String(value || "")
    .split("/")
    .map((part) => folderName.parse(part));
  if (!segments.length || segments.length > 8)
    fail(400, "That folder path is invalid.");
  const required = itemScopes(context, item.kind, item.id);
  if (context.id && context.conversation_id)
    required.push({
      scope_kind: "conversation",
      scope_id: context.conversation_id,
    });
  if (context.id && context.task_id) {
    tenant("tasks", context.task_id, context.company_id);
    required.push({ scope_kind: "task", scope_id: context.task_id });
  }
  const duckId =
    context.duck_id ||
    (item.kind === "notes"
      ? item.id
      : item.kind === "shared_file"
        ? one("SELECT duck_id FROM shared_files WHERE id=?", item.id)?.duck_id
        : item.kind === "upload"
          ? one(
              "SELECT duck_id FROM computer_file_exports WHERE upload_id=?",
              item.id,
            )?.duck_id
          : item.kind === "document"
            ? one("SELECT duck_id FROM documents WHERE id=?", item.id)?.duck_id
            : null);
  if (!duckId) fail(400, "A duck folder is unavailable for this file.");
  tenant("ducks", duckId, context.company_id);
  let parent = null;
  const createdIds = [];
  let currentPath = "";
  try {
    for (const segment of segments) {
      const name = segment.normalize("NFC");
      currentPath = currentPath ? `${currentPath}/${name}` : name;
      const namespace = `duck:${duckId}`;
      let folder = one(
        "SELECT * FROM file_folders WHERE company_id=? AND namespace_key=? AND parent_id IS ? AND name_key=?",
        context.company_id,
        namespace,
        parent?.id || null,
        keyOf(name),
      );
      if (!folder) {
        const physical = one(
          "SELECT * FROM file_folders WHERE company_id=? AND duck_id=? AND physical=1 AND path_key=?",
          context.company_id,
          duckId,
          currentPath,
        );
        if (physical && (!parent || physical.parent_id === parent.id))
          folder = physical;
      }
      if (folder) {
        requireManage(context, folder);
      } else {
        const folderId = id();
        const stamp = now();
        run(
          `INSERT INTO file_folders(id,company_id,parent_id,namespace_key,name,name_key,relative_path,path_key,
        duck_id,computer_id,source_box_id,source_token,physical,created_by,created,updated)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          folderId,
          context.company_id,
          parent?.id || null,
          namespace,
          name,
          keyOf(name),
          currentPath,
          keyOf(currentPath),
          duckId,
          null,
          null,
          null,
          0,
          context.user_id,
          stamp,
          stamp,
        );
        createdIds.push(folderId);
        insertScopes(
          folderId,
          context.id
            ? context.task_id
              ? [{ scope_kind: "task", scope_id: context.task_id }]
              : [
                  {
                    scope_kind: "conversation",
                    scope_id: context.conversation_id,
                  },
                ]
            : required,
          stamp,
        );
        folder = rawFolder(context, folderId, { visible: false });
      }
      parent = folder;
    }
  } catch (error) {
    error.createdFolderIds = createdIds;
    throw error;
  }
  return details ? { id: parent.id, createdIds } : parent.id;
}

function routeContext(req, extra = {}) {
  return {
    company_id: req.company.id,
    user_id: req.user.id,
    ...extra,
  };
}

export function registerFileFolders(app) {
  app.get("/api/file-folders", (req, res) => {
    const filters = {
      duck_id: req.query.duck_id,
      conversation_id: req.query.conversation_id,
      task_id: req.query.task_id,
    };
    res.json({ folders: folderList(routeContext(req), filters) });
  });
  app.post("/api/file-folders", async (req, res) => {
    res.status(201).json(await folderCreate(routeContext(req), req.body));
  });
  app.patch("/api/file-folders/:id", async (req, res) => {
    res.json(
      await folderRename(routeContext(req), req.params.id, req.body.name),
    );
  });
  app.delete("/api/file-folders/:id", async (req, res) => {
    res.json(await folderDelete(routeContext(req), req.params.id));
  });
  app.post("/api/file-folders/unfiled/items", async (req, res) => {
    res.json(await folderMoveItem(routeContext(req), null, req.body));
  });
  app.post("/api/file-folders/:id/items", async (req, res) => {
    res.json(await folderMoveItem(routeContext(req), req.params.id, req.body));
  });
  app.delete("/api/file-folders/items/:kind/:id", async (req, res) => {
    res.json(
      await folderMoveItem(routeContext(req), null, {
        kind: req.params.kind,
        id: req.params.id,
      }),
    );
  });
}
