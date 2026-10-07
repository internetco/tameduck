import React, { useEffect, useId, useRef, useState } from "react";
import {
  CheckSquare,
  Download,
  File,
  FileSpreadsheet,
  FileText,
  Presentation,
  Image,
  MessageSquare,
  MoreHorizontal,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { api, Avatar, Button, Modal } from "./ui.jsx";
import { CsvFilePreview } from "./CsvSheet.jsx";
import { isCsvFile } from "./csv.mjs";
import { FilePreview, previewKind } from "./FilePreview.jsx";
import { formatBytes, typeLabel, uploadUrl } from "./file-ui.jsx";
import { atWhen, fmtWhen } from "./when.mjs";
import {
  deleteProblem,
  deleteWarning,
  placeToShow,
  savedName,
  sharedWhere,
} from "./file-viewer.mjs";
import "./file-viewer.css";

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
// Back to whatever opened a dialog, when it closes. A dialog taken out of the
// page leaves the focus nowhere, and the next Tab starts from the top of the
// app. When a delete takes the opener away as well - the file's row in Files,
// its card in a chat, often a moment later, once the list or the message has
// come back from the server - the focus goes to what is beside where it was:
// the next file in the list, or the message that now says it was deleted.
export function useFocusBack() {
  const start = useRef(null);
  if (!start.current) {
    const el = document.activeElement;
    const all =
      el && el !== document.body
        ? [...document.querySelectorAll(TABBABLE)]
        : [];
    const at = all.indexOf(el);
    const around = [];
    let up = el?.parentElement;
    while (up && up !== document.body) {
      around.push(up);
      up = up.parentElement;
    }
    start.current = {
      el,
      around,
      beside:
        at < 0
          ? []
          : [
              ...all.slice(at + 1, at + 25),
              ...all.slice(Math.max(0, at - 25), at).reverse(),
            ],
    };
  }
  useEffect(
    () => () => {
      const { el, around = [], beside = [] } = start.current || {};
      if (!el || el === document.body) return;
      const nearby = () => {
        const home = around.find((a) => a.isConnected);
        if (!home) return;
        const next = beside.find(
          (x) =>
            x.isConnected && home.contains(x) && x.getClientRects().length > 0,
        );
        if (next) return next.focus({ preventScroll: true });
        if (!home.hasAttribute("tabindex")) home.tabIndex = -1;
        home.focus({ preventScroll: true });
      };
      if (!el.isConnected) return nearby();
      el.focus({ preventScroll: true });
      const gone = new MutationObserver(() => {
        if (el.isConnected) return;
        gone.disconnect();
        // Unless the person has already moved on.
        if (document.activeElement && document.activeElement !== document.body)
          return;
        nearby();
      });
      gone.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => gone.disconnect(), 5000);
    },
    [],
  );
}

// A picture or a spreadsheet opened for a look, from Files and from any chat.
// There were three dialogs, each 790px wide with its own buttons: Files gave
// Download and a red Delete file side by side, a chat picture gave Download
// only, and a chat screenshot was titled "Screenshot" and gave Open original.
// None said who shared the file, where or when.
//
// file      an upload, or a screenshot ({kind: "screenshot", id, name})
// who       {duck, name} of whoever shared it, when that is known
// from      {user_id} or {duck_id} of whoever shared it
// shared    {conversationId, taskId, messageId, threadId, created}
// deletable whether this person may delete it (their own, or an admin)
// gone      the file has left the list or the message it was opened from:
//           deleted in another tab, or by someone else
// onDeleted after this viewer deleted it and said so; the caller closes it
export function FileViewer({
  file,
  who,
  from,
  shared = {},
  data,
  go,
  action,
  notify,
  deletable = false,
  gone = false,
  onDeleted,
  onClose,
}) {
  const [menu, setMenu] = useState(false);
  const [asking, setAsking] = useState(false);
  const deleting = useRef(false);
  const more = useRef(null);
  const menuBox = useRef(null);
  const heading = useRef(null);
  const described = useId();
  useFocusBack();
  // It opens on the file's name, which a screen reader reads with who shared
  // it. It opened on Show in chat, so a second Enter left the file at once.
  useEffect(() => heading.current?.focus(), []);
  // Deleted somewhere else while it is open: a viewer still offering Download
  // and More for a file that is gone. Not while this viewer deletes it.
  useEffect(() => {
    if (!gone || deleting.current) return;
    notify?.(file.name + " was deleted.");
    onClose();
  }, [gone]);
  // Back on More once the question is answered or dismissed. Not before: the
  // question is modal until it has gone, and More cannot take the focus then.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current && !asking) more.current?.focus();
    asked.current = asking;
  }, [asking]);
  useEffect(() => {
    if (!menu) return;
    menuBox.current?.querySelector("[role=menuitem]")?.focus();
    const away = (event) => {
      if (!menuBox.current?.contains(event.target)) setMenu(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [menu]);
  const screenshot = file.kind === "screenshot";
  const picture = screenshot || (file.group === "image" && file.inline);
  const sheet = !picture && isCsvFile(file);
  const modernKind = !picture && !sheet ? previewKind(file) : null;
  const Tile =
    sheet || modernKind === "spreadsheet"
      ? FileSpreadsheet
      : picture
        ? Image
        : modernKind === "document" && /\.pptx$/i.test(file.name)
          ? Presentation
          : modernKind
            ? FileText
            : File;
  const src = screenshot
    ? "/api/computer-captures/" + file.id
    : uploadUrl(file.current_upload_id || file.id);
  const download = screenshot ? src : file.download_url || uploadUrl(file.id, true);
  // Only a chat this person is in: Files lists no other, but a file copied
  // onto a reply from another duck's chat can point at one.
  const conversation = data.conversations.find(
    (c) => c.id === shared.conversationId,
  );
  const where = sharedWhere({
    conversation,
    task: data.tasks?.find((t) => t.id === shared.taskId),
    data,
    from,
  });
  const created = shared.created;
  const show = placeToShow({ ...shared, conversationId: conversation?.id });
  const jump = show && go ? () => (onClose(), go(show.view)) : null;
  // A picture says it is on its way, and says so when it cannot come: a slow
  // one left an empty grey window, a refused one a broken-image icon.
  const [look, setLook] = useState("loading");
  const showButton = (className, icon) =>
    jump && (
      <Button type="button" className={"secondary " + className} onClick={jump}>
        {icon &&
          (show.view.type === "tasks" ? (
            <CheckSquare size={16} />
          ) : (
            <MessageSquare size={16} />
          ))}
        {show.label}
      </Button>
    );
  const downloadLink = (className) => (
    <a
      className={"button " + className}
      href={download}
      // A screenshot is sent as a picture to look at, so the link names the
      // copy it saves.
      {...(screenshot ? { download: savedName(file.name, ".jpg") } : {})}
    >
      <Download size={16} /> Download
    </a>
  );
  const shut = (close, className) => (
    <button
      type="button"
      className={"file-viewer-icon " + className}
      aria-label="Close dialog"
      title="Close dialog"
      onClick={close}
    >
      <X size={20} />
    </button>
  );
  const time = created && (
    <time className="file-viewer-phrase" dateTime={created}>
      {atWhen(created)}
    </time>
  );
  // Only between its phrases: "yesterday / at 16:40" and "# / operations"
  // broke on a tablet. Two lines at most, all of it on hover.
  const sentence = [
    who ? who.name + " shared it" : "Shared",
    where && where.words.join(""),
    created && atWhen(created),
  ]
    .filter(Boolean)
    .join(" ");
  const head = (close) => (
    <>
      {shut(close, "file-viewer-phone")}
      <span
        className={"file-viewer-tile" + (picture ? " picture" : "")}
        aria-hidden="true"
      >
        <Tile size={19} />
      </span>
      <div className="file-viewer-title">
        <h2 title={file.name} ref={heading} tabIndex={-1}>
          {file.name}
        </h2>
        <p className="file-viewer-from file-viewer-wide">
          {who && <Avatar duck={who.duck} name={who.name} size={20} />}
          <span id={described} title={sentence}>
            {who ? (
              <>
                <b className="file-viewer-phrase">{who.name}</b> shared it
              </>
            ) : (
              "Shared"
            )}
            {where && (
              <>
                {" " + where.words[0]}
                {where.words[1] && (
                  <b className="file-viewer-phrase">{where.words[1]}</b>
                )}
                {where.words[2]}
              </>
            )}
            {time && <> {time}</>}
          </span>
        </p>
        {(who || where) && (
          <p className="file-viewer-short file-viewer-phone">
            {[who?.name, where?.label].filter(Boolean).join(" · ")}
          </p>
        )}
        {created && (
          <p className="file-viewer-short file-viewer-phone">
            <time dateTime={created}>{fmtWhen(created)}</time>
          </p>
        )}
      </div>
      <div className="file-viewer-acts">
        {showButton("file-viewer-wide", true)}
        {downloadLink("file-viewer-wide")}
        <span className="file-viewer-sep file-viewer-wide" aria-hidden="true" />
        {deletable && (
          <div
            className="file-viewer-more"
            ref={menuBox}
            onKeyDown={(event) => {
              // Escape closes the menu while it is open, not the whole file.
              if (event.key !== "Escape" || !menu) return;
              event.preventDefault();
              event.stopPropagation();
              setMenu(false);
              more.current?.focus();
            }}
            onBlur={(event) => {
              if (menu && !menuBox.current?.contains(event.relatedTarget))
                setMenu(false);
            }}
          >
            <button
              type="button"
              ref={more}
              className="file-viewer-icon"
              aria-label="More"
              title="More"
              aria-haspopup="menu"
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
            >
              <MoreHorizontal size={20} />
            </button>
            {menu && (
              <div className="file-viewer-menu" role="menu" aria-label="More">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    setAsking(true);
                  }}
                >
                  <Trash2 size={16} /> Delete file
                </button>
              </div>
            )}
          </div>
        )}
        {shut(close, "file-viewer-wide")}
      </div>
    </>
  );
  return (
    <>
      <Modal
        full
        ariaLabel={file.name}
        describedBy={described}
        onClose={onClose}
        head={head}
      >
        {sheet ? (
          <CsvFilePreview item={file} url={src} fill />
        ) : modernKind ? (
          <FilePreview item={file.current_upload_id ? { ...file, id: file.current_upload_id } : file} fill />
        ) : picture ? (
          <div className="file-viewer-picture">
            {look === "failed" ? (
              <p role="status">
                The picture could not be loaded. Close it and try again.
              </p>
            ) : (
              <>
                {look === "loading" && <p role="status">Loading picture…</p>}
                <img
                  src={src}
                  alt={file.name}
                  hidden={look !== "ready"}
                  onLoad={() => setLook("ready")}
                  onError={() => setLook("failed")}
                />
              </>
            )}
          </div>
        ) : (
          <div className="file-viewer-other">
            <File size={30} aria-hidden="true" />
            <p>
              {typeLabel(file)} · {formatBytes(file.size)}
            </p>
            <p>
              This kind of file cannot be shown here. Download it to open it.
            </p>
          </div>
        )}
        <div className="file-viewer-bar file-viewer-phone">
          {showButton("", false)}
          {downloadLink("")}
        </div>
      </Modal>
      {/* Beside the viewer, not inside it, so none of its look reaches in. */}
      {asking && (
        <DeleteFileQuestion
          file={file}
          where={where}
          action={action}
          onStart={(going) => (deleting.current = going)}
          onKeep={() => setAsking(false)}
          onDone={onDeleted}
        />
      )}
    </>
  );
}

// Asking before a delete, from the viewer's More. A refusal says why here,
// where it is read: a toast from the page sat under this question's backdrop
// the second time. A file somebody else deleted first counts as deleted.
//
// onStart(true) as the delete starts, onStart(false) when it did not happen;
// onDone once it is done, after the toast and the app's own data are up to
// date.
export function DeleteFileQuestion({
  file,
  where,
  action,
  onStart,
  onKeep,
  onDone,
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const confirm = useRef(null);
  // Back on Delete file after a refusal: it was disabled while it waited, and
  // the focus fell out of the question to the page.
  useEffect(() => {
    if (problem) confirm.current?.focus();
  }, [problem]);
  async function remove() {
    setBusy(true);
    setProblem("");
    onStart?.(true);
    let already = false;
    try {
      await api("/uploads/" + file.id, "DELETE");
    } catch (error) {
      if (error.status !== 404) {
        onStart?.(false);
        setBusy(false);
        setProblem(deleteProblem(error));
        return;
      }
      already = true;
    }
    await action(
      async () => {},
      already ? "This file was already deleted." : "File deleted",
    );
    await onDone?.();
  }
  return (
    <Modal
      className="file-confirm"
      ariaLabel={"Delete " + file.name + "?"}
      onClose={() => {
        if (busy) return;
        onKeep();
      }}
      head={() => (
        <>
          <span className="file-confirm-warn" aria-hidden="true">
            <TriangleAlert size={16} />
          </span>
          <h2>Delete {file.name}?</h2>
        </>
      )}
    >
      <p>{deleteWarning(where)}</p>
      {problem && (
        <p role="alert" className="file-confirm-problem">
          {problem}
        </p>
      )}
      <div className="modal-actions">
        <Button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={onKeep}
        >
          Keep the file
        </Button>
        <Button
          type="button"
          className="danger-button"
          busy={busy}
          ref={confirm}
          onClick={remove}
        >
          {!busy && <Trash2 size={16} />} Delete file
        </Button>
      </div>
    </Modal>
  );
}
