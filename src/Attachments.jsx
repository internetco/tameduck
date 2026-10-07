import React, { useEffect, useState } from "react";
import {
  FileText,
  Image,
  CheckSquare,
  Columns3,
  BookOpen,
  StickyNote,
  ArrowUpRight,
  Plus,
  Paperclip,
  Download,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { api, Modal, Button, IconButton } from "./ui.jsx";
import { DocumentEditor } from "./views.jsx";
import { FileViewer } from "./FileViewer.jsx";
import { sharerOf } from "./file-viewer.mjs";
import { isCsvFile } from "./csv.mjs";
import { isPreviewable } from "./FilePreview.jsx";
import { FileIcon, formatBytes, typeLabel, uploadUrl } from "./file-ui.jsx";
import { noticeHeading, noticeReason } from "./file-notice.mjs";
import { lineChangeSummary, lineDiff } from "./line-diff.mjs";
import "./artifact-changes.css";

const CHANGEABLE_ARTIFACT_KINDS = new Set([
  "notes",
  "document",
  "task",
  "workflow_ticket",
  "workflow-ticket",
]);
const LEGACY_CHANGES_MESSAGE =
  "Changes were not recorded for this older update.";

function ArtifactChangeField({ field }) {
  const lines = lineDiff(field.before, field.after);
  const summary = lineChangeSummary(field.before, field.after, lines);
  return (
    <section className="artifact-change-field">
      <h3>{field.label}</h3>
      {summary.kind === "unchanged" ? (
        <p className="artifact-change-field-status">No changes.</p>
      ) : summary.kind === "line-endings" ? (
        <p className="artifact-change-field-status">
          Only line endings changed.
        </p>
      ) : (
        <>
          <div className="artifact-change-legend" aria-label="Change counts">
            <span className="added">
              <strong aria-hidden="true">+</strong>
              {summary.added} {summary.added === 1 ? "line" : "lines"} added
            </span>
            <span className="removed">
              <strong aria-hidden="true">−</strong>
              {summary.removed} {summary.removed === 1 ? "line" : "lines"}{" "}
              removed
            </span>
          </div>
          <div
            className="artifact-line-diff"
            role="list"
            aria-label={field.label + " changes"}
          >
            {lines.map((line, index) => (
              <div
                className={"artifact-diff-line " + line.type}
                role="listitem"
                key={line.type + "-" + index}
              >
                <span className="artifact-diff-marker" aria-hidden="true">
                  {line.type === "added"
                    ? "+"
                    : line.type === "removed"
                      ? "−"
                      : " "}
                </span>
                <span className="artifact-diff-label">
                  {line.type === "added"
                    ? "Added: "
                    : line.type === "removed"
                      ? "Removed: "
                      : "Unchanged: "}
                </span>
                <code>{line.text || "\u00a0"}</code>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function ArtifactChanges({ artifact, endpoint, onClose }) {
  const [result, setResult] = useState(() => ({
    loading: Boolean(artifact.has_changes),
    error: artifact.has_changes ? "" : LEGACY_CHANGES_MESSAGE,
    data: null,
  }));

  useEffect(() => {
    if (!artifact.has_changes) return;
    let current = true;
    api(endpoint || "/artifacts/" + artifact.id + "/changes")
      .then((data) => {
        if (current) setResult({ loading: false, error: "", data });
      })
      .catch((error) => {
        if (!current) return;
        setResult({
          loading: false,
          error: error.status === 404 ? LEGACY_CHANGES_MESSAGE : error.message,
          data: null,
        });
      });
    return () => {
      current = false;
    };
  }, [artifact.id, artifact.has_changes, endpoint]);

  const title = "Changes to " + artifact.title;
  return (
    <Modal title={title} ariaLabel={title} wide onClose={onClose}>
      {result.loading ? (
        <p className="artifact-changes-status" role="status">
          Loading changes…
        </p>
      ) : result.error ? (
        <p
          className="artifact-changes-status artifact-changes-error"
          role="alert"
        >
          {result.error}
        </p>
      ) : result.data?.fields?.length ? (
        <div className="artifact-change-fields">
          {result.data.fields.map((field) => (
            <ArtifactChangeField field={field} key={field.key} />
          ))}
        </div>
      ) : (
        <p className="artifact-changes-status">No recorded fields changed.</p>
      )}
    </Modal>
  );
}

export function ArtifactChangesAction({
  artifact,
  endpoint,
  className = "artifact-changes-trigger",
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => setOpen(true)}
        aria-label={"View changes to " + artifact.title}
        title={"View changes to " + artifact.title}
      >
        View changes
      </button>
      {open && (
        <ArtifactChanges
          artifact={artifact}
          endpoint={endpoint}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
// Explain whether a shared file could not be previewed or read.
export function FileNotices({ notices = [], data }) {
  if (!notices.length) return null;
  return (
    <div className="file-notices">
      {notices.map((n) => {
        const duck = data.ducks.find((d) => d.id === n.duck_id);
        return (
          <div className="file-notice" role="status" key={n.upload_id}>
            <TriangleAlert size={16} />
            <span>
              <strong>
                {noticeHeading({
                  name: n.name,
                  reason: n.reason,
                  duckName: duck?.name || "The duck",
                })}
              </strong>{" "}
              {noticeReason(n)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
function SharedFile({ artifact, data, action, onPreview, onMediaLoad }) {
  const file = artifact.file;
  if (!file)
    return (
      <div className="artifact-card file-card deleted">
        <FileIcon item={{ group: "other" }} size={20} />
        <span>
          <strong>{artifact.title}</strong>
          <small>This file was deleted.</small>
        </span>
      </div>
    );
  const allowed = !file.shared_file_id && (file.user_id === data.user.id || data.permissions.company);
  const remove = () => {
    if (
      window.confirm(
        `Delete ${file.name}? Everyone in the chat loses access to it.`,
      )
    )
      action(() => api("/uploads/" + file.id, "DELETE"), "File deleted");
  };
  if (file.group === "image" && file.inline)
    return (
      <button
        type="button"
        className="file-image"
        onClick={() => onPreview(file)}
        aria-label={"Open image: " + file.name}
        title={file.name}
      >
        <img
          src={uploadUrl(file.current_upload_id || file.id)}
          alt={file.name}
          loading="lazy"
          onLoad={onMediaLoad}
        />
      </button>
    );
  return (
    <div className="artifact-card file-card">
      <a
        className="file-card-open"
        href={file.inline ? uploadUrl(file.current_upload_id || file.id) : file.download_url || uploadUrl(file.id, true)}
        {...(file.inline
          ? { target: "_blank", rel: "noreferrer noopener" }
          : {})}
        title={
          (file.inline || isCsvFile(file) || isPreviewable(file)
            ? "Open "
            : "Download ") + file.name
        }
        onClick={
          isCsvFile(file) || isPreviewable(file)
            ? (event) => {
                event.preventDefault();
                onPreview(file);
              }
            : undefined
        }
      >
        <FileIcon item={file} size={20} />
        <span>
          <strong>{file.name}</strong>
          <small>
            {typeLabel(file)} · {formatBytes(file.size)}
          </small>
        </span>
      </a>
      <a
        className="icon-button"
        href={file.download_url || uploadUrl(file.id, true)}
        title={"Download " + file.name}
        aria-label={"Download " + file.name}
      >
        <Download size={16} />
      </a>
      {allowed && (
        <IconButton
          icon={Trash2}
          label={"Delete " + file.name}
          onClick={remove}
        />
      )}
    </div>
  );
}
export function ChatArtifacts({
  items = [],
  data,
  action,
  notify,
  conversation,
  threadId,
  go,
  setModal,
  onMediaLoad,
  changesEndpoint,
  // The message these came in, which says who shared them and when.
  message,
}) {
  const [doc, setDoc] = useState(null);
  const [preview, setPreview] = useState(null);
  const [image, setImage] = useState(null);
  async function open(a) {
    if (a.kind === "document") {
      try {
        setDoc(await api("/documents/" + a.reference_id));
      } catch (error) {
        notify(error.message);
      }
    } else if (a.kind === "duck" || a.kind === "notes") {
      const duck = data.ducks.find((d) => d.id === a.reference_id);
      if (duck) setModal({ type: "duck", duck });
    } else if (a.kind === "board")
      go({ type: "tasks", boardId: a.reference_id });
    else
      go({ type: a.kind === "task" ? "tasks" : "skills", id: a.reference_id });
  }
  const icons = {
    document: FileText,
    task: CheckSquare,
    board: Columns3,
    skill: BookOpen,
    notes: StickyNote,
    duck: BookOpen,
  };
  return (
    <>
      <div className="message-attachments">
        {items.map((a) =>
          a.kind === "file" ? (
            <SharedFile
              key={a.id}
              artifact={a}
              data={data}
              action={action}
              onPreview={setImage}
              onMediaLoad={onMediaLoad}
            />
          ) : a.kind === "screenshot" && !a.kept ? (
            // A company keeps its last 500 screenshots and the oldest give way.
            // The message still says one was taken, because it was.
            <span key={a.id} className="attachment-gone">
              <Image size={15} />
              <span className="attachment-label">
                {a.title} · no longer kept
              </span>
            </span>
          ) : a.kind === "screenshot" ? (
            <button
              key={a.id}
              type="button"
              className="screenshot-attachment"
              onClick={() => setPreview(a)}
              aria-label={"Open screenshot: " + a.title}
              title={a.title}
            >
              <img
                src={"/api/computer-captures/" + a.reference_id}
                alt={a.title}
                loading="lazy"
                onLoad={onMediaLoad}
              />
              <span>
                <Image size={15} />
                <span className="attachment-label">
                  <strong>{a.title}</strong>
                  <small>Screenshot · Click to expand</small>
                </span>
                <ArrowUpRight size={15} />
              </span>
            </button>
          ) : (
            (() => {
              const Icon = icons[a.kind] || FileText;
              const card = (
                <button
                  type="button"
                  className="artifact-card"
                  title={a.title}
                  onClick={() => open(a)}
                >
                  <span className="artifact-icon">
                    <Icon size={22} />
                  </span>
                  <span>
                    <strong>{a.title}</strong>
                    <small>
                      {a.verb} ·{" "}
                      {a.kind === "notes"
                        ? "Duck notes"
                        : a.kind === "document"
                          ? "Document"
                          : a.kind === "board"
                            ? "Task board"
                            : a.kind}
                    </small>
                  </span>
                  <ArrowUpRight size={15} />
                </button>
              );
              if (
                a.verb !== "Updated" ||
                !CHANGEABLE_ARTIFACT_KINDS.has(a.kind)
              )
                return React.cloneElement(card, { key: a.id });
              return (
                <div className="artifact-card-actions" key={a.id}>
                  {card}
                  <ArtifactChangesAction
                    artifact={a}
                    endpoint={changesEndpoint?.(a)}
                  />
                </div>
              );
            })()
          ),
        )}
      </div>
      {/* The same window Files opens, saying who shared it here, where and
          when. A screenshot is titled with the duck's own caption. */}
      {preview && (
        <FileViewer
          file={{
            kind: "screenshot",
            id: preview.reference_id,
            name: preview.title,
            group: "image",
            mime: "image/jpeg",
          }}
          who={sharerOf(message, data)}
          from={message}
          shared={{
            conversationId: conversation?.id,
            messageId: message?.id,
            threadId: message ? message.thread_id : threadId,
            created: preview.created,
          }}
          data={data}
          go={go}
          onClose={() => setPreview(null)}
        />
      )}
      {image && (
        <FileViewer
          file={image}
          who={sharerOf(message, data)}
          from={message}
          shared={{
            conversationId: conversation?.id || image.conversation_id,
            messageId: message?.id || image.message_id,
            threadId: message ? message.thread_id : threadId,
            created: image.created,
          }}
          data={data}
          go={go}
          action={action}
          notify={notify}
          deletable={
            !image.shared_file_id && (image.user_id === data.user.id || !!data.permissions.company)
          }
          gone={!items.some((a) => a.file?.id === image.id)}
          onDeleted={() => setImage(null)}
          onClose={() => setImage(null)}
        />
      )}
      {doc && (
        <DocumentEditor
          doc={doc}
          data={data}
          action={action}
          onClose={() => setDoc(null)}
          onSaved={async () => {
            if (!conversation?.id) return;
            await action(() =>
              api(
                "/conversations/" + conversation.id + "/document-event",
                "POST",
                {
                  document_id: doc.id,
                  verb: "Updated",
                  thread_id: threadId || null,
                },
              ),
            );
          }}
        />
      )}
    </>
  );
}
export function DocumentPicker({
  data,
  action,
  onClose,
  onSelect,
  conversation,
  threadId,
}) {
  const [create, setCreate] = useState(false);
  return create ? (
    <DocumentEditor
      doc={{ title: "", content: "" }}
      data={data}
      action={action}
      onClose={onClose}
      // Made from Attach, so it goes with the message being written - the way
      // picking an existing document does. It was posted on its own instead,
      // as "Created · Document" to nobody, while the message the person was
      // writing went without it and no duck was asked about it.
      onSaved={(d) => onSelect(d.id)}
    />
  ) : (
    <Modal title="Attach a document" onClose={onClose}>
      <p className="muted">
        Share a company document with the people and ducks in this conversation.
      </p>
      <div className="attachment-picker">
        {data.documents.map((d) => (
          <button
            key={d.id}
            onClick={() => {
              onSelect(d.id);
              onClose();
            }}
          >
            <FileText size={19} />
            <strong>{d.title}</strong>
            <Paperclip size={15} />
          </button>
        ))}
      </div>
      {data.permissions.docs && (
        <Button className="secondary" onClick={() => setCreate(true)}>
          <Plus size={15} /> Create a document
        </Button>
      )}
    </Modal>
  );
}
