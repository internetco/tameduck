import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  Folder,
  FolderInput,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { api, Button, Modal } from "./ui.jsx";
import { folderOptions } from "./files-list.mjs";

// Shared folder navigation for Files and ticket file panels. Folder records are
// scoped by the caller; this component never broadens that scope.
export function FolderBrowser({
  folders = [],
  folderId = "all",
  onSelect,
  onChanged,
  scope = {},
  canCreate = false,
  ownerName,
  notify = () => {},
}) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const current = folders.find((f) => f.id === folderId);
  const [createError, setCreateError] = useState("");
  const createErrorId = useId();
  const createInput = useRef(null);
  useEffect(() => {
    if (creating) requestAnimationFrame(() => createInput.current?.focus());
  }, [creating]);
  const compact = !folders.length;
  const children = folders.filter(
    (f) => (f.parent_id || null) === (current?.id || null),
  );
  const crumbs = [];
  const seen = new Set();
  for (
    let f = current;
    f && !seen.has(f.id);
    f = folders.find((x) => x.id === f.parent_id)
  ) {
    seen.add(f.id);
    crumbs.unshift(f);
  }
  async function create(e) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setCreateError("");
    try {
      const made = await api("/file-folders", "POST", {
        name: name.trim(),
        ...(current ? { parent_id: current.id } : {}),
        ...scope,
      });
      try {
        await onChanged?.();
      } catch (e) {
        notify(
          e.message || "Folder created, but the list could not be refreshed.",
        );
      }
      setName("");
      setCreating(false);
      setCreateError("");
      onSelect(made.id);
    } catch (e) {
      setCreateError(e.message || "Could not create folder.");
    } finally {
      setBusy(false);
    }
  }
  async function rename(folder) {
    if (!folder.can_manage) return;
    const next = window.prompt("Folder name", folder.name);
    if (!next?.trim() || next.trim() === folder.name) return;
    try {
      await api("/file-folders/" + folder.id, "PATCH", { name: next.trim() });
      await onChanged?.();
    } catch (e) {
      notify(e.message);
    }
  }
  async function remove(folder) {
    if (
      !folder.can_manage ||
      !folder.can_delete ||
      !window.confirm("Delete this empty folder?")
    )
      return;
    try {
      await api("/file-folders/" + folder.id, "DELETE");
      if (folder.id === folderId) onSelect(folder.parent_id || "all");
      await onChanged?.();
    } catch (e) {
      notify(e.message);
    }
  }
  return (
    <nav
      className={"folder-browser" + (compact ? " empty-root" : "")}
      aria-label="Folders"
    >
      {/* The folder you are in is a place on this page, not a page of its
          own: only the menu says which page you are on. */}
      <div className="folder-crumbs">
        <button
          type="button"
          onClick={() => onSelect("all")}
          aria-current={folderId === "all" ? "location" : undefined}
        >
          All files
        </button>
        {folderId === "unfiled" && (
          <>
            <ChevronRight size={14} aria-hidden="true" />
            <span aria-current="location">Unfiled</span>
          </>
        )}
        {crumbs.map((f) => (
          <React.Fragment key={f.id}>
            <ChevronRight size={14} aria-hidden="true" />
            <button
              type="button"
              onClick={() => onSelect(f.id)}
              aria-current={f.id === folderId ? "location" : undefined}
            >
              {f.name}
            </button>
          </React.Fragment>
        ))}
      </div>
      {!compact &&
        canCreate &&
        (!current || current.can_manage) &&
        !creating && (
          <button
            type="button"
            className="text-button folder-browser-new"
            onClick={() => {
              setCreateError("");
              setCreating(true);
            }}
          >
            <Plus size={14} /> New folder{current ? " here" : ""}
          </button>
        )}
      <div className="folder-browser-list">
        {folderId === "all" && (
          <button
            type="button"
            className="folder-browser-row folder-browser-open"
            onClick={() => onSelect("unfiled")}
          >
            <Folder size={16} />
            Unfiled
          </button>
        )}
        {children.map((f) => (
          <div className="folder-browser-row" key={f.id}>
            <button
              type="button"
              className="folder-browser-open"
              onClick={() => onSelect(f.id)}
            >
              <Folder size={16} />
              <span>
                {f.name}
                {ownerName?.(f) && <small>{ownerName(f)}</small>}
              </span>
            </button>
            {f.can_manage && (
              <button
                type="button"
                aria-label={`Rename ${f.name}`}
                onClick={() => rename(f)}
              >
                <Pencil size={14} />
              </button>
            )}
            {f.can_manage && f.can_delete && (
              <button
                type="button"
                aria-label={`Delete ${f.name}`}
                onClick={() => remove(f)}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ))}
        {compact &&
          canCreate &&
          (!current || current.can_manage) &&
          !creating && (
            <button
              type="button"
              className="text-button folder-browser-new"
              onClick={() => {
                setCreateError("");
                setCreating(true);
              }}
            >
              <Plus size={14} /> New folder{current ? " here" : ""}
            </button>
          )}
        {!children.length && current && (
          <p className="folder-browser-empty">No subfolders here.</p>
        )}
      </div>
      {canCreate && (!current || current.can_manage) && creating && (
        <Modal
          title="New folder"
          ariaLabel="New folder"
          className="folder-create-modal"
          onClose={() => {
            if (busy) return;
            setCreating(false);
            setName("");
            setCreateError("");
          }}
        >
          <form className="files-dialog folder-create-dialog" onSubmit={create}>
            <p className="folder-create-destination">
              Create in{" "}
              <strong>
                {current?.path ||
                  current?.name ||
                  (scope.task_id ? "Ticket files" : "All files")}
              </strong>
            </p>
            <label>
              Folder name
              <input
                ref={createInput}
                autoFocus
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setCreateError("");
                }}
                placeholder="e.g. Project notes"
                aria-label="Folder name"
                maxLength={200}
                disabled={busy}
                aria-invalid={Boolean(createError)}
                aria-describedby={createError ? createErrorId : undefined}
              />
            </label>
            {createError && (
              <p className="files-error" id={createErrorId} role="alert">
                {createError}
              </p>
            )}
            <div className="modal-actions">
              <Button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setCreating(false);
                  setName("");
                  setCreateError("");
                }}
              >
                Cancel
              </Button>
              <Button type="submit" busy={busy} disabled={!name.trim()}>
                <Plus size={14} /> Create folder
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </nav>
  );
}

export function FolderMoveDialog({
  item,
  folders = [],
  ownerName,
  onClose,
  onMoved,
  notify = () => {},
}) {
  const options = useMemo(
    () => folderOptions(folders).filter((f) => f.can_manage),
    [folders],
  );
  const present =
    item.folder_id && options.some((f) => f.id === item.folder_id)
      ? item.folder_id
      : "unfiled";
  const [to, setTo] = useState(present);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const errorId = useId();
  async function move() {
    setBusy(true);
    setError("");
    try {
      await api("/file-folders/" + to + "/items", "POST", {
        kind: item.kind,
        id: item.id,
      });
      await onMoved?.(to);
      onClose();
    } catch (e) {
      setError(e.message || "Could not move this file.");
      setBusy(false);
    }
  }
  return (
    <Modal
      title={"Move " + item.name}
      ariaLabel={"Move " + item.name}
      onClose={() => !busy && onClose()}
    >
      <div className="files-dialog folder-move-dialog">
        <label>
          Folder
          <select
            value={to}
            disabled={busy}
            aria-describedby={error ? errorId : undefined}
            onChange={(e) => { setTo(e.target.value); setError(""); }}
          >
            <option value="unfiled">Unfiled</option>
            {options.map((f) => (
              <option value={f.id} key={f.id}>
                {"  ".repeat(f.depth) +
                  (f.path || f.name) +
                  (ownerName?.(f) ? " · " + ownerName(f) : "")}
              </option>
            ))}
          </select>
        </label>
        {error && <p className="files-error" role="alert" id={errorId}>{error}</p>}
        <div className="modal-actions">
          <Button className="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button busy={busy} disabled={to === present} onClick={move}>
            <FolderInput size={16} /> Move
          </Button>
        </div>
      </div>
    </Modal>
  );
}
