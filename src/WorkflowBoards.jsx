import React, { useEffect, useState } from "react";
import {
  Plus,
  Settings2,
  ArrowRight,
  Search,
  Check,
  Clock,
  ShieldCheck,
  Play,
  Pause,
  RotateCcw,
  MessageSquare,
  Columns3,
  User,
  TriangleAlert,
} from "lucide-react";
import {
  api,
  Avatar,
  Modal,
  Field,
  Button,
  IconButton,
  Markdown,
  flock,
} from "./ui.jsx";
import TicketPage from "./TicketPage.jsx";
import { ChiefBoardAccess } from "./BoardProposals.jsx";
import { personStep, whoHasIt } from "./board-turn.mjs";
import { ArchivedBoardsDialog } from "./BoardArchive.jsx";
import { RecoveryStatus } from "./RecoveryStatus.jsx";
import BoardDisplaySettings from "./BoardDisplaySettings.jsx";
import {
  displaySettings,
  isHiddenDone,
  sortBoardCards,
} from "./board-display.mjs";
export default function WorkflowBoards({
  data,
  action,
  go,
  initialId,
  boardId,
  folderId,
}) {
  const w = data.workflows || {
    boards: [],
    columns: [],
    tickets: [],
    runs: [],
    history: [],
  };
  const selectedTask = initialId && data.tasks.find((t) => t.id === initialId),
    selectedTicket =
      selectedTask && w.tickets.find((t) => t.task_id === selectedTask.id);
  // Nothing on the original board runs by itself, so landing there by default
  // meant a first ticket sat waiting for a person who did not know they were
  // the one waited on. A board that actually does the work comes first.
  // An archived board is out of the list, though a ticket on one still opens.
  const board =
    w.boards.find(
      (b) =>
        b.id === (boardId || selectedTicket?.board_id) &&
        (!b.archived || selectedTicket),
    ) ||
    w.boards.find((b) => !b.legacy && !b.archived) ||
    w.boards[0];
  const [newTask, setNewTask] = useState(false),
    [archivedOpen, setArchivedOpen] = useState(false),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    // The board the Your turn filter was pressed on. Carried over, it left
    // the next board looking empty behind a button that could never count.
    [yoursOn, setYoursOn] = useState(null),
    // Which card is in the air, so a lane can say whether it would take it.
    [dragging, setDragging] = useState(null),
    [displayOpen, setDisplayOpen] = useState(false),
    [showOlderDone, setShowOlderDone] = useState(false);
  useEffect(() => setShowOlderDone(false), [board?.id]);
  if (!board) return <div className="page">Loading your task boards…</div>;
  const columns = w.columns
      .filter((c) => c.board_id === board.id)
      .sort((a, b) => a.position - b.position),
    tickets = w.tickets.filter((t) => t.board_id === board.id),
    settings = displaySettings(board),
    lastColumn = columns.length - 1,
    close = () => go({ type: "tasks", boardId: board.id }),
    yoursOnly = yoursOn === board.id,
    archived = w.boards.filter((b) => b.archived).length;
  const who = (t, task) => {
    const at = columns.findIndex((c) => c.id === t.column_id);
    return whoHasIt({
      ticket: t,
      task,
      column: columns[at] || {},
      isLast: at === columns.length - 1,
      legacy: board.legacy,
      runs: w.runs,
      ducks: data.ducks,
      members: data.members,
      me: data.user.id,
      canDoTasks: data.permissions.tasks,
    });
  };
  const yours = (t) => {
    const task = data.tasks.find((x) => x.id === t.task_id);
    const now = task && who(t, task);
    return !!now && (now.kind === "you" || !!now.mine);
  };
  const visibleByRetention = (t) => {
    const task = data.tasks.find((x) => x.id === t.task_id);
    const at = columns.findIndex((c) => c.id === t.column_id);
    return (
      showOlderDone ||
      !isHiddenDone({
        ticket: t,
        task,
        columnIndex: at,
        lastColumn,
        legacy: board.legacy,
        settings,
      })
    );
  };
  const hiddenDone = tickets.filter((t) => {
    const task = data.tasks.find((x) => x.id === t.task_id);
    const at = columns.findIndex((c) => c.id === t.column_id);
    return (
      isHiddenDone({
        ticket: t,
        task,
        columnIndex: at,
        lastColumn,
        legacy: board.legacy,
        settings,
      }) &&
      !!task &&
      task.title.toLowerCase().includes(query.toLowerCase()) &&
      (filter === "all" || task.assignee_id === filter) &&
      (!yoursOnly || yours(t))
    );
  }).length;
  const yourTurn = tickets.filter(
    (t) => visibleByRetention(t) && yours(t),
  ).length;
  // One definition of "on the board right now", used by the lanes and by the
  // number beside the search box, so the two cannot drift apart again.
  const matches = (t) => {
    const task = data.tasks.find((x) => x.id === t.task_id);
    return (
      !!task &&
      task.title.toLowerCase().includes(query.toLowerCase()) &&
      (filter === "all" || task.assignee_id === filter) &&
      (!yoursOnly || yours(t)) &&
      visibleByRetention(t)
    );
  };
  const shown = tickets.filter(matches);
  if (selectedTask && selectedTicket && selectedTicket.board_id === board.id)
    return (
      <TicketPage
        key={selectedTask.id}
        task={selectedTask}
        ticket={selectedTicket}
        board={board}
        columns={columns}
        data={data}
        action={action}
        go={go}
        onClose={close}
        initialFolder={folderId}
      />
    );

  return (
    <div className="page workflow-page">
      <div className="workflow-heading">
        <div className="workflow-heading-title">
          <div className="eyebrow">TASK BOARDS</div>
          {/* The name is plain text with the dropdown laid over it, unseen.
              A dropdown shortens its own text however each browser likes:
              Safari just stopped, so "QA audit — document handoff — 20 Sep"
              read "... — 2" with room to spare. Plain text ends in "…" the
              same way everywhere. */}
          <div className="board-picker">
            <span className="board-picker-name" aria-hidden="true">
              {board.name}
            </span>
            <select
              aria-label="Choose task board"
              title={board.name}
              className="board-select"
              value={board.id}
              onChange={(e) => {
                // The select stays on this board: its value is the board's.
                if (e.target.value === "archived") return setArchivedOpen(true);
                setQuery("");
                setYoursOn(null);
                go({ type: "tasks", boardId: e.target.value });
              }}
            >
              {w.boards
                .filter((b) => !b.archived)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              {data.permissions.tasks && archived > 0 && (
                <option value="archived">
                  {"Archived boards (" + archived + ")"}
                </option>
              )}
            </select>
          </div>
          <p>
            {board.description || "A clear path from idea to finished work."}
          </p>
        </div>
        <div className="workflow-heading-actions">
          <Button
            className="secondary small"
            onClick={() => setDisplayOpen(true)}
          >
            <Settings2 size={15} />
            Board view
          </Button>
          {data.permissions.tasks && (
            <>
              <Button
                className="secondary small"
                onClick={() => go({ type: "tasks", newBoard: true })}
              >
                <Plus size={15} />
                New board
              </Button>
              {!board.legacy && (
                <Button
                  className="secondary small"
                  onClick={() =>
                    go({ type: "tasks", boardId: board.id, setup: true })
                  }
                >
                  <Settings2 size={15} />
                  Edit board
                </Button>
              )}
              <Button
                className="secondary small"
                onClick={() => go({ type: "tasks", scheduled: true })}
              >
                <Clock size={15} />
                Scheduled
              </Button>
              <Button className="small" onClick={() => setNewTask(true)}>
                <Plus size={15} />
                New ticket
              </Button>
            </>
          )}
        </div>
      </div>
      <ChiefBoardAccess board={board} data={data} action={action} />
      <div className="workflow-toolbar">
        <div className="search-field">
          <Search size={16} />
          <input
            aria-label="Find tickets"
            placeholder="Find a ticket…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select
          aria-label="Filter tickets by duck"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">All ducks</option>
          {flock(data).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        {(yourTurn > 0 || yoursOnly) && (
          <button
            type="button"
            className="workflow-yours-filter"
            aria-pressed={yoursOnly}
            onClick={() => setYoursOn(yoursOnly ? null : board.id)}
          >
            <User size={15} aria-hidden="true" />
            Your turn
            <span>{yourTurn}</span>
          </button>
        )}
        {hiddenDone > 0 && (
          <button
            type="button"
            className="workflow-done-toggle"
            aria-label={
              showOlderDone
                ? "Hide older Done tickets"
                : "Show older Done tickets"
            }
            onClick={() => setShowOlderDone((v) => !v)}
            aria-pressed={showOlderDone}
          >
            {showOlderDone
              ? "Hide older Done tickets"
              : "Show older Done tickets"}{" "}
            <span>{hiddenDone}</span>
          </button>
        )}
        <span>
          {/* What the board is actually showing. This counted every ticket on
              the board while sitting immediately to the right of the search box
              and the duck filter that had just narrowed it - so typing a word
              that matched two tickets still read "37 tickets". */}
          {shown.length} {shown.length === 1 ? "ticket" : "tickets"}
          {shown.length !== tickets.length ? " of " + tickets.length : ""}
        </span>
        <span className="workflow-mode">
          {board.legacy
            ? // It said "Manual board", right above the line saying a ticket
              // assigned to a duck starts by itself - which it does.
              "Assigned tickets start by themselves"
            : !board.enabled
              ? "Duck work paused"
              : board.auto_advance
                ? "Moves after work & approvals"
                : "Human moves approved tickets"}
        </span>
      </div>
      <div className="workflow-lanes" aria-label={board.name + " task board"}>
        {columns.map((c, index) => {
          // Where the card being dragged could actually go. On the original
          // board a ticket is just a status, so any column takes it. On a
          // workflow board it moves one stage to the right and nowhere else.
          const takes = (lane) => {
            if (!dragging) return true;
            if (board.legacy) return true;
            const from = tickets.find((t) => t.task_id === dragging);
            if (!from) return false;
            const at = columns.findIndex((x) => x.id === from.column_id);
            return columns.findIndex((x) => x.id === lane.id) === at + 1;
          };
          const duck = data.ducks.find((d) => d.id === c.duck_id),
            cards = sortBoardCards(
              tickets
                .map((t) => ({
                  ...t,
                  task: data.tasks.find((x) => x.id === t.task_id),
                }))
                .filter((t) => t.task && t.column_id === c.id && matches(t)),
              settings.sort_order,
            ),
            human =
              !board.legacy && personStep(c, index === columns.length - 1),
            // A step people do, which this person can do, is theirs - unless a
            // ticket in it is waiting on somebody else, when "You do this step"
            // would sit right above a card naming that somebody.
            mineToDo =
              human &&
              data.permissions.tasks &&
              !tickets.some((t) => {
                const task = data.tasks.find((x) => x.id === t.task_id);
                return (
                  task && t.column_id === c.id && who(t, task).kind === "person"
                );
              });
          return (
            <section
              className={
                "workflow-lane" +
                (mineToDo ? " yours" : "") +
                (dragging ? (takes(c) ? " can-take" : " cannot-take") : "")
              }
              key={c.id}
              aria-label={c.name + " column"}
              // Only the lane that would actually take it. Every lane used to
              // accept the drop and then the server refused the move, so the
              // board invited a drag it could not honour - including the very
              // first one on a new board. Dragging a card back a stage was
              // answered with "Tickets move one column to the right", about a
              // drag made to the left; there is no way back anywhere in the
              // product, so the lane simply does not take it now.
              onDragOver={(e) => {
                if (data.permissions.tasks && takes(c)) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                const tid = e.dataTransfer.getData("text/plain");
                if (
                  tickets.some((t) => t.task_id === tid) &&
                  data.permissions.tasks
                )
                  action(() =>
                    api("/workflow/tasks/" + tid + "/move", "POST", {
                      column_id: c.id,
                    }),
                  );
              }}
            >
              <header className="workflow-column-heading">
                <span
                  className={
                    "column-number " +
                    (index === columns.length - 1 ? "last" : "")
                  }
                >
                  {index === columns.length - 1 ? (
                    <Check size={12} />
                  ) : (
                    index + 1
                  )}
                </span>
                <h3>{c.name}</h3>
                <span>{cards.length}</span>
                {data.permissions.tasks && !board.legacy && (
                  <IconButton
                    icon={Settings2}
                    label={"Change the " + c.name + " step"}
                    onClick={() =>
                      go({
                        type: "tasks",
                        boardId: board.id,
                        setup: true,
                        stepId: c.id,
                      })
                    }
                  />
                )}
              </header>
              {!board.legacy && (
                <div className="workflow-column-owner">
                  {duck ? (
                    <>
                      <Avatar duck={duck} size={22} />
                      <span>{duck.name}</span>
                    </>
                  ) : human ? (
                    <>
                      <span className="workflow-person-mark">
                        <User size={13} aria-hidden="true" />
                      </span>
                      <span>
                        {mineToDo
                          ? "You do this step"
                          : "A person does this step"}
                      </span>
                    </>
                  ) : (
                    <span>Done</span>
                  )}
                  {c.approvers.length > 0 && (
                    <span
                      className="review-count"
                      title={c.approvers
                        .map((id) => data.ducks.find((d) => d.id === id)?.name)
                        .join(", ")}
                    >
                      <ShieldCheck size={13} />
                      {c.approvers.length}
                    </span>
                  )}
                </div>
              )}
              <div className="workflow-cards">
                {cards.map((t) => {
                  const now = who(t, t.task),
                    reviews = w.runs.filter(
                      (r) =>
                        r.task_id === t.task_id &&
                        r.revision === t.revision &&
                        r.column_id === t.column_id &&
                        r.role === "reviewer",
                    );
                  return (
                    <button
                      key={t.task_id}
                      className="workflow-card"
                      draggable={data.permissions.tasks}
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", t.task_id);
                        setDragging(t.task_id);
                      }}
                      onDragEnd={() => setDragging(null)}
                      onClick={() =>
                        go({ type: "tasks", boardId: board.id, id: t.task_id })
                      }
                    >
                      {t.task.priority === "high" && (
                        <span className="workflow-card-top">
                          <span className="priority-high">High priority</span>
                        </span>
                      )}
                      <strong>{t.task.title}</strong>
                      {t.task.description && (
                        <p>{t.task.description.slice(0, 130)}</p>
                      )}
                      {t.task.recovery && (
                        <RecoveryStatus
                          recovery={t.task.recovery}
                          data={data}
                          action={action}
                          compact
                        />
                      )}
                      {/* A stage held up for an ordinary reason - the board
                          paused, no AI connected - keeps its explanation in the
                          same column as a real failure, and it was painted red
                          either way. Waiting is not failing. */}
                      {t.error && (
                        <span
                          className={
                            t.state === "waiting"
                              ? "workflow-card-note"
                              : "workflow-card-error"
                          }
                        >
                          {t.error}
                        </span>
                      )}
                      <span className={"workflow-card-who " + now.kind}>
                        {now.duck ? (
                          <Avatar duck={now.duck} size={26} />
                        ) : now.kind === "stuck" ? (
                          <TriangleAlert size={16} aria-hidden="true" />
                        ) : now.kind === "done" ? (
                          <Check size={16} aria-hidden="true" />
                        ) : now.kind === "wait" ? (
                          <Clock size={16} aria-hidden="true" />
                        ) : (
                          <User size={16} aria-hidden="true" />
                        )}
                        {now.duck ? (
                          <span className="workflow-card-who-words">
                            <span>{now.duck.name}</span>
                            <span>{now.status}</span>
                          </span>
                        ) : (
                          <span className="workflow-card-who-words">
                            {now.kind === "you"
                              ? "Your turn"
                              : now.kind === "person"
                                ? now.name + "’s turn"
                                : now.kind === "done"
                                  ? "Done"
                                  : now.mine
                                    ? now.status + " · Your turn"
                                    : now.status}
                          </span>
                        )}
                        {reviews.length > 0 && (
                          <span className="workflow-card-reviews">
                            <ShieldCheck size={13} />
                            {
                              reviews.filter(
                                (r) =>
                                  r.decision === "approved" &&
                                  r.status === "done",
                              ).length
                            }
                            /{c.approvers.length}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
                {!cards.length && (
                  <div className="workflow-empty">
                    {hiddenDone && index === lastColumn
                      ? hiddenDone +
                        " older Done " +
                        (hiddenDone === 1 ? "ticket is" : "tickets are") +
                        " hidden."
                      : index === 0
                        ? "New tickets start here."
                        : "Tickets arrive from the left."}
                  </div>
                )}
              </div>
              {index === 0 && data.permissions.tasks && (
                <button
                  className="workflow-add-ticket"
                  onClick={() => setNewTask(true)}
                >
                  <Plus size={15} />
                  Add ticket
                </button>
              )}
            </section>
          );
        })}
      </div>
      <p className="workflow-footnote">
        {board.legacy
          ? // This used to say nothing here runs on its own and send people off
            // to build a board with stages. Both halves stopped being true when
            // a ticket assigned to a duck started picking itself up, and this
            // is the first thing a new person reads on the task board.
            "Assign a ticket to a duck and the duck starts it. Leave it unassigned and it waits for a person. For work that needs steps and review, make a board with stages."
          : "Tickets move left to right. Each stage keeps its work, review decisions and earlier attempts together."}
      </p>
      {archivedOpen && (
        <ArchivedBoardsDialog
          data={data}
          action={action}
          go={go}
          onClose={() => setArchivedOpen(false)}
        />
      )}
      {displayOpen && (
        <BoardDisplaySettings
          key={board.id}
          board={board}
          data={data}
          action={action}
          onClose={() => setDisplayOpen(false)}
        />
      )}
      {newTask && (
        <NewTicket
          board={board}
          data={data}
          action={action}
          onClose={() => setNewTask(false)}
          onSaved={(id) => {
            setNewTask(false);
            go({ type: "tasks", boardId: board.id, id });
          }}
        />
      )}
    </div>
  );
}
function NewTicket({ board, data, action, onClose, onSaved }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={"New ticket in " + board.name} warnUnsaved onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const a = Object.fromEntries(new FormData(e.currentTarget));
          setBusy(true);
          const r = await action(
            () =>
              api("/boards/" + board.id + "/tasks", "POST", {
                ...a,
                assignee_id: a.assignee_id || null,
              }),
            "Ticket created",
          );
          setBusy(false);
          if (r) onSaved(r.id);
        }}
      >
        <Field label="What needs doing?">
          <input
            name="title"
            required
            maxLength={200}
            autoFocus
            placeholder="Plan our autumn campaign"
          />
        </Field>
        <Field label="Brief">
          <textarea
            name="description"
            rows={5}
            maxLength={60000}
            placeholder="Give your team the context, goals and a clear definition of done."
          />
        </Field>
        <Field label="Priority">
          <select name="priority" defaultValue="normal">
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
        </Field>
        {!!board.legacy && (
          <Field label="Assigned duck">
            <select name="assignee_id">
              <option value="">Unassigned</option>
              {flock(data).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <p className="workflow-hint">
          This ticket starts in the leftmost column.{" "}
          {!board.legacy && board.enabled
            ? "Assigned ducks start automatically on this company’s AI connection."
            : ""}
        </p>
        <div className="modal-actions">
          <Button busy={busy}>Create ticket</Button>
        </div>
      </form>
    </Modal>
  );
}
