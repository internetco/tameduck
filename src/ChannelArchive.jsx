import React, { useEffect, useId, useState } from "react";
import { Archive, Hash, Search } from "lucide-react";
import { api, Button, Empty, Modal } from "./ui.jsx";
export const canArchiveChannel = (data, channel) =>
  !!data.permissions.chat &&
  (channel.creator_id === data.user.id || data.permissions.company);
export function ArchiveChannelDialog({
  channel,
  action,
  onClose,
  onCancel = onClose,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // It opens on Cancel, the safe answer. autoFocus alone lost to the
  // dialog's own opening, which put the focus on the X.
  const cancel = useId();
  useEffect(() => {
    document.getElementById(cancel)?.focus();
  }, []);
  // Archiving stops whatever the ducks are in the middle of in here. That used
  // to happen without saying so - or rather it did not happen at all, and the
  // duck carried on into a channel nobody was reading. Either way the person
  // pressing the button could not tell, so now it says.
  const working = channel.working || 0;
  return (
    <Modal
      title={"Archive #" + channel.name + "?"}
      ariaLabel={"Archive #" + channel.name + "?"}
      onClose={onCancel}
    >
      <p>
        This will archive <strong>#{channel.name}</strong> for everyone in the
        channel.
      </p>
      {working > 0 && (
        <p>
          <strong>
            {working === 1
              ? "A duck is working in here right now."
              : working + " ducks are working in here right now."}
          </strong>{" "}
          {working === 1 ? "That run is" : "Those runs are"} stopped, and
          starting the channel again does not bring{" "}
          {working === 1 ? "it" : "them"} back.
        </p>
      )}
      <p className="muted">
        The conversation history will stay available. You can unarchive this
        channel at any time from <strong>Archived channels</strong> in the
        sidebar.
      </p>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      <div className="modal-actions">
        <Button
          type="button"
          id={cancel}
          className="secondary"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        {/* Danger, as Archive channel is in Members, which asks this. */}
        <Button
          type="button"
          className="danger-button"
          busy={busy}
          onClick={async () => {
            setError("");
            setBusy(true);
            const result = await action(async () => {
              try {
                return await api(
                  "/conversations/" + channel.id + "/archive",
                  "PATCH",
                  { archived: true },
                );
              } catch (e) {
                setError(e.message);
                throw e;
              }
            }, "Channel archived. You can unarchive it from Archived channels.");
            setBusy(false);
            if (result) onClose();
          }}
        >
          <Archive size={16} />
          Archive channel
        </Button>
      </div>
    </Modal>
  );
}
export function ArchivedChannelsDialog({ data, action, onClose, go }) {
  const [busy, setBusy] = useState(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [search, setSearch] = useState("");
  const archived = data.conversations.filter(
    (c) => c.kind === "group" && c.archived,
  );
  const visible = archived.filter((c) =>
    c.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  return (
    <Modal title="Archived channels" onClose={onClose}>
      <p className="muted">
        Open a channel to read its history, or unarchive it to bring it back to
        the sidebar and continue chatting.
      </p>
      {notice && (
        <p className="archive-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {archived.length > 0 && (
        <div className="archive-search">
          <Search size={17} />
          <input
            aria-label="Search archived channels"
            placeholder="Find an archived channel…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}
      <div className="archived-list">
        {visible.map((c) => (
          <div key={c.id}>
            <button
              type="button"
              aria-label={"View history of " + c.name}
              onClick={() => {
                go({ type: "chat", id: c.id });
                onClose();
              }}
            >
              <Hash size={17} />
              <span>{c.name}</span>
            </button>
            {canArchiveChannel(data, c) ? (
              <Button
                type="button"
                className="secondary small"
                aria-label={"Unarchive channel " + c.name}
                busy={busy === c.id}
                disabled={busy !== null}
                onClick={async () => {
                  setBusy(c.id);
                  setError("");
                  setNotice("");
                  const result = await action(async () => {
                    try {
                      return await api(
                        "/conversations/" + c.id + "/archive",
                        "PATCH",
                        { archived: false },
                      );
                    } catch (e) {
                      setError(e.message);
                      throw e;
                    }
                  }, "Channel unarchived");
                  setBusy(null);
                  if (result)
                    setNotice("#" + c.name + " is back in your sidebar.");
                }}
              >
                Unarchive
              </Button>
            ) : (
              <span className="archive-permission">
                Creator or admin can unarchive
              </span>
            )}
          </div>
        ))}
      </div>
      {!visible.length && (
        <Empty
          icon={Archive}
          title={
            archived.length ? "No matching channels" : "No archived channels"
          }
        >
          {archived.length
            ? "Try another channel name."
            : "Channels you archive will appear here. Their conversation history stays saved."}
        </Empty>
      )}
    </Modal>
  );
}
