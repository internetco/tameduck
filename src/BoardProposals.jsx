import React, { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { api, Button, Modal } from "./ui.jsx";
import { AskCard } from "./AskCard.jsx";
import { askTitle } from "./inbox-list.mjs";
import { boardLines, cannot, folded, toast } from "./ask-words.mjs";
import { openUntil } from "./schedule-proposal-words.mjs";
import "./skill-proposals.css";
import "./board-proposals.css";

const statusLabels = {
  pending: "Needs approval",
  applied: "Approved",
  denied: "Declined",
  changes_requested: "Changes requested",
  superseded: "Replaced",
  expired: "Expired",
};
// Chief asking to set up a task board, or to change one. The card says its
// stages and who does each, or what changes, and is answered where it is; the
// box lets Chief change this board from now on without asking. The dialog
// shows every setting.
// head: in the Needs you list the line above the card is its heading, so there
// the card leaves its own off. Everywhere else keeps it.
export function BoardProposalCard({
  proposal: p,
  data,
  action,
  go,
  head = true,
}) {
  const [review, setReview] = useState(false);
  const chief =
    data.ducks.find((d) => d.id === p.duck_id)?.name || "Chief Duck";
  const title = askTitle("board", p);
  const allowed = data.permissions.tasks && data.permissions.approvals;
  const words = {
    me: data.user?.id,
    duck: chief,
    exists: (data.workflows?.boards || []).some((b) => b.id === p.board_id),
  };
  return (
    <>
      <AskCard
        title={title}
        head={head}
        lines={boardLines(p)}
        more={{ label: "See all settings", onClick: () => setReview(true) }}
        askee={chief}
        always="Always let Chief change this board"
        refusal={allowed ? null : cannot("board")}
        done={p.status === "pending" ? null : folded("board", p, words)}
        lapse={folded("board", { ...p, status: "expired" }, words)}
        expires={p.expires}
        decide={(decision, { note, always }) =>
          api("/board-proposals/" + p.id + "/decide", "POST", {
            decision,
            fingerprint: p.fingerprint,
            ...(decision === "changes" ? { feedback: note } : {}),
            ...(decision === "approve" ? { always_allow: always } : {}),
          })
        }
        said={(decision, { always }) =>
          toast(decision, title, { duck: chief, always })
        }
        action={action}
        go={go}
      />
      {review && (
        <BoardProposalReview
          proposal={p}
          data={data}
          onClose={() => setReview(false)}
        />
      )}
    </>
  );
}
const yes = (v) => (v ? "Yes" : "No");
// Every setting Chief prepared, to read. The card decides; this only shows.
function BoardProposalReview({ proposal, data, onClose }) {
  const [detail, setDetail] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setDetail(null);
    setError("");
    api("/board-proposals/" + proposal.id)
      .then((d) => {
        if (current) setDetail(d);
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [proposal.id, proposal.status, proposal.fingerprint]);
  const pending = proposal.status === "pending" && detail?.status === "pending";
  const config = detail?.configuration;
  const duckName = (id) =>
    config?.ducks?.[id]?.name ||
    data.ducks.find((d) => d.id === id)?.name ||
    "Unknown duck";
  return (
    <Modal title="All settings" wide onClose={onClose}>
      {error && <p role="alert">{error}</p>}
      {!detail && !error && <p>Loading board settings…</p>}
      {config && (
        <div className="skill-proposal-review">
          <p className="muted">
            {detail.operation === "create"
              ? "Create a new task board"
              : "Change the settings of " + config.before.name}
            {detail.standing_permission &&
              " · Applied with standing permission"}
          </p>
          <BoardDiff config={config} duckName={duckName} />
          <p className="skill-proposal-effect">
            Approving saves exactly these settings. Existing tickets keep their
            history; if a stage's working duck, instructions or approvers
            change, tickets in that stage start a new attempt. Ticket work is
            not started by this approval unless the board runs assigned ducks
            automatically.
          </p>
          {/* How long it stays open, the way the card says it. Once decided
              the status line below says what became of it. */}
          {pending && <p className="muted">{openUntil(detail.expires)}</p>}
          {detail.feedback && (
            <p>
              <strong>Requested changes:</strong> {detail.feedback}
            </p>
          )}
          {!pending && (
            <p role="status">
              <strong>{statusLabels[detail.status] || detail.status}.</strong>{" "}
              {detail.status === "applied"
                ? "These exact settings were applied."
                : "This proposal is no longer awaiting approval."}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
function BoardDiff({ config, duckName }) {
  const { board, before } = config;
  const names = (ids) => (ids.length ? ids.map(duckName).join(", ") : "None");
  const fields = [
    ["Board name", (b) => b.name],
    ["Description", (b) => b.description || "No description"],
    ["Run assigned ducks automatically", (b) => yes(b.enabled)],
    [
      "Move tickets after work and approvals finish",
      (b) => yes(b.auto_advance),
    ],
  ];
  const columnFields = [
    ["Working duck", (c) => (c.duck_id ? duckName(c.duck_id) : "Human")],
    ["Required approvals", (c) => names(c.approvers)],
    [
      "Review order",
      (c) =>
        c.approvers.length > 1
          ? c.review_in_order
            ? "One at a time"
            : "All together"
          : "—",
    ],
    ["Wait for these ducks", (c) => names(c.wait_for_ducks)],
    ["Instructions", (c) => c.instructions || "No instructions"],
  ];
  const removed = before
    ? before.columns.filter((c) => !board.columns.some((x) => x.id === c.id))
    : [];
  // A column moved only if its order changed among the columns that stay.
  const kept = (list, other) =>
    list.filter((c) => other.some((x) => x.id === c.id)).map((c) => c.id);
  const keptBefore = before ? kept(before.columns, board.columns) : [],
    keptAfter = before ? kept(board.columns, before.columns) : [];
  return (
    <>
      <dl className="skill-proposal-details">
        {fields
          .filter(([, get]) => !before || get(before) !== get(board))
          .map(([label, get]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>
                {before && (
                  <>
                    <del>{get(before)}</del> →{" "}
                  </>
                )}
                {get(board)}
              </dd>
            </div>
          ))}
      </dl>
      <h3>Columns, left to right</h3>
      <ol className="board-proposal-columns">
        {board.columns.map((c, index) => {
          const old = before?.columns.find((x) => x.id === c.id);
          const changed = old
            ? [["Column name", (x) => x.name], ...columnFields].filter(
                ([, get]) => get(old) !== get(c),
              )
            : [];
          const tag = !before
            ? null
            : !old
              ? "New"
              : changed.length
                ? "Changed"
                : keptBefore.indexOf(c.id) !== keptAfter.indexOf(c.id)
                  ? "Moved"
                  : null;
          return (
            <li key={c.id || "new-" + index}>
              <div className="board-proposal-column-head">
                <strong>{c.name}</strong>
                {index === board.columns.length - 1 && (
                  <small>Finish line</small>
                )}
                {tag && <span className="pill">{tag}</span>}
              </div>
              <dl className="skill-proposal-details">
                {(old && changed.length ? changed : old ? [] : columnFields)
                  .filter(
                    ([label, get]) =>
                      label !== "Review order" ||
                      get(c) !== "—" ||
                      (old && get(old) !== "—"),
                  )
                  .map(([label, get]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>
                        {old && (
                          <>
                            <del>{get(old)}</del> →{" "}
                          </>
                        )}
                        {get(c)}
                      </dd>
                    </div>
                  ))}
                {old && !changed.length && (
                  <div>
                    <dt>Settings</dt>
                    <dd>
                      Unchanged · {c.duck_id ? duckName(c.duck_id) : "Human"}
                    </dd>
                  </div>
                )}
              </dl>
            </li>
          );
        })}
      </ol>
      {removed.length > 0 && (
        <>
          <h3>Removed columns</h3>
          <ul className="board-proposal-columns removed">
            {removed.map((c) => (
              <li key={c.id}>
                <del>{c.name}</del>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
export function ChiefBoardAccess({ board, data, action }) {
  const [busy, setBusy] = useState(false);
  if (board.legacy) return null;
  const access = (data.board_access || []).find(
    (g) => g.board_id === board.id && g.active,
  );
  const manage = data.permissions.tasks && data.permissions.approvals;
  if (!access && !manage) return null;
  async function set(allow) {
    setBusy(true);
    await action(
      () => api("/boards/" + board.id + "/chief-access", "POST", { allow }),
      allow
        ? "Chief may now change this board without asking"
        : "Chief will ask before changing this board",
    );
    setBusy(false);
  }
  return (
    <div className="chief-board-access">
      <ShieldCheck size={15} />
      <span>
        {access
          ? "Chief Duck can change this board's settings without asking" +
            (access.granted_by_name
              ? " (allowed by " + access.granted_by_name + ")"
              : "")
          : "Chief Duck asks before changing this board's settings"}
      </span>
      {manage && (
        <Button
          className="secondary small"
          busy={busy}
          onClick={() => set(!access)}
        >
          {access ? "Remove permission" : "Always allow"}
        </Button>
      )}
    </div>
  );
}
