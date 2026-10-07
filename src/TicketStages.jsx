// A ticket's page, built around its stages: the strip of the board's stages
// (StageStrip) and the one panel for the stage a ticket is on, or for a
// picked earlier stage (StagePanel). ticket-stages.mjs works out the words
// and the mode without React; this file only lays them out.
import React from "react";
import {
  Check,
  FileText,
  ArrowUpRight,
  Square,
  Undo2,
  ChevronDown,
  RotateCcw,
  Play,
  TriangleAlert,
  MessageSquare,
} from "lucide-react";
import { Avatar, Button, Field, Markdown, IconButton } from "./ui.jsx";
import { when } from "./ticket-stages.mjs";
import { QueueReason } from "./QueueReason.jsx";
import "./ticket-stages.css";

const fullDate = (iso) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function DocumentCard({ doc, byName, dateFull, onOpen }) {
  return (
    <button
      type="button"
      className="ticket-stage-doc"
      onClick={onOpen}
      aria-label={"Open " + doc.title}
    >
      <span className="ticket-stage-doc-icon">
        <FileText size={16} />
      </span>
      <span className="ticket-stage-doc-info">
        <strong>{doc.title}</strong>
        <small>
          {byName ? byName + " · " : ""}
          {dateFull}
        </small>
      </span>
      <span className="ticket-stage-doc-open">
        Open <ArrowUpRight size={13} />
      </span>
    </button>
  );
}

// What a stage handed over: who did it, what they said, and any document it
// made. Also used, without a name, for the fallback while stages/ has not
// loaded yet.
function StageRecord({ record, ducks, onOpenDocument }) {
  if (!record) return null;
  const duck = record.by?.duck_id ? ducks.find((d) => d.id === record.by.duck_id) : null;
  const name = record.by?.name;
  return (
    <div className="ticket-stage-handover">
      {name && (
        <div className="ticket-stage-handover-head">
          {duck ? <Avatar duck={duck} size={28} /> : <Avatar name={name} size={28} />}
          <span>
            <strong>{name}</strong> handed it over
          </span>
        </div>
      )}
      {record.summary && (
        <div className="ticket-update-body">
          <Markdown>{record.summary}</Markdown>
        </div>
      )}
      {record.details && (
        <details className="ticket-handoff-details">
          <summary>Details for the next duck</summary>
          <Markdown>{record.details}</Markdown>
        </details>
      )}
      {(record.documents || []).map((doc) => (
        <DocumentCard
          key={doc.id}
          doc={doc}
          byName={name || "A teammate"}
          dateFull={fullDate(doc.updated)}
          onOpen={() => onOpenDocument(doc.id)}
        />
      ))}
    </div>
  );
}

function SentBackBlock({ arrived, me, ducks }) {
  const duck = arrived.by?.duck_id ? ducks.find((d) => d.id === arrived.by.duck_id) : null;
  const name = duck?.name || arrived.by?.name || "Somebody";
  const isMe = !!arrived.by?.user_id && arrived.by.user_id === me;
  return (
    <div className="ticket-stage-handover">
      <div className="ticket-stage-handover-head">
        {duck ? <Avatar duck={duck} size={28} /> : <Avatar name={name} size={28} />}
        <span>
          <strong>{isMe ? "You" : name}</strong> sent it back
        </span>
      </div>
      {arrived.note && (
        <div className="ticket-update-body">
          <Markdown>{arrived.note}</Markdown>
        </div>
      )}
    </div>
  );
}

// One card per step of the board: done, missed, current or later. cardsFor
// (ticket-stages.mjs) already worked out where each stands and what it says.
export function StageStrip({ cards, pickedId, onPick, listRef }) {
  return (
    <ol className="ticket-stage-strip" aria-label="Stages" ref={listRef}>
      {cards.map((c) => {
        const pressable = c.place === "done" || c.place === "missed" || c.place === "current";
        const isCurrent = c.place === "current";
        const showing = pickedId ? pickedId === c.id : isCurrent;
        const Tag = pressable ? "button" : "div";
        // A complete ticket's finish line is still position p (aria-current
        // stays, and picking another card still comes back to it), but it
        // wears the Done style: a tick, and cardsFor already gave it line2
        // "Done" and line3 the date (3.2).
        const doneStyled = c.place === "done" || (isCurrent && c.who?.text === "Done");
        return (
          <li key={c.id}>
            <Tag
              type={pressable ? "button" : undefined}
              className={
                "ticket-stage-card place-" +
                (doneStyled ? "done" : c.place) +
                (c.tone && !doneStyled ? " tone-" + c.tone : "") +
                (c.danger ? " danger" : "") +
                (showing && !isCurrent ? " picked" : "")
              }
              aria-current={isCurrent ? "step" : undefined}
              aria-pressed={pressable ? String(showing) : undefined}
              aria-label={c.label}
              onClick={pressable ? () => onPick(isCurrent ? null : c.id) : undefined}
            >
              <div className="ticket-stage-line1">
                {doneStyled && (
                  <span className="ticket-stage-tick">
                    <Check size={14} />
                  </span>
                )}
                <span className="ticket-stage-title" title={c.name}>
                  {c.name}
                </span>
                {c.chip && (
                  <span className="ticket-stage-chip ticket-stage-card-chip turn">{c.chip}</span>
                )}
              </div>
              <div className="ticket-stage-line2">
                {c.who.duck ? (
                  <Avatar duck={c.who.duck} size={18} />
                ) : c.who.person ? (
                  <Avatar name={c.who.person} size={18} />
                ) : null}
                <span>{c.who.text}</span>
              </div>
              {(c.made || c.line3) && (
                <div className="ticket-stage-line3">
                  {c.made ? (
                    <>
                      <FileText size={13} />
                      <span>
                        {c.made.title}
                        {c.made.more > 0 ? " and " + c.made.more + " more" : ""}
                      </span>
                    </>
                  ) : (
                    <span>{c.line3}</span>
                  )}
                </div>
              )}
            </Tag>
          </li>
        );
      })}
    </ol>
  );
}

const CHIP_TONE = {
  ok: "ok",
  attn: "turn",
  accent: "accent",
  danger: "danger",
  wait: "wait",
};

// The panel for the stage the ticket is on - or, when picked is set, a
// read-only look at an earlier stage's own work (3.4).
export function StagePanel({
  board,
  legacy,
  panel,
  t,
  task,
  column,
  columns,
  data,
  me,
  runs,
  stages,
  arrived,
  now,
  pickedColumn,
  pickedRecord,
  draft,
  onDraftChange,
  steering,
  onPostNote,
  postBusy,
  noteLabel,
  noteHint,
  sendBack,
  canStop,
  runningDuck,
  onStop,
  stopBusy,
  primary,
  onPrimary,
  primaryBusy,
  headingRef,
  noteRef,
  onOpenDocument,
  go,
  checkersText,
  askedMe,
  duck,
  active,
  consultation,
  permTasks,
  permChat,
}) {
  const ducks = data.ducks;
  const index = columns ? columns.findIndex((c) => c.id === column?.id) : -1;

  // ---- 3.4: a picked earlier stage, read only ------------------------------
  if (pickedColumn) {
    return (
      <section className="ticket-stage-panel tone-ok" aria-label={pickedColumn.name + ", done"}>
        <div className="ticket-stage-head">
          <span className="ticket-stage-chip ok">Done</span>
          <h2 ref={headingRef} tabIndex={-1}>
            {pickedColumn.name}
          </h2>
          {pickedRecord?.finished && (
            <span className="ticket-stage-meta">Finished {when(pickedRecord.finished, now)}</span>
          )}
        </div>
        <div className="ticket-stage-body">
          {pickedRecord?.by ? (
            <StageRecord record={pickedRecord} ducks={ducks} onOpenDocument={onOpenDocument} />
          ) : (
            <p className="workflow-hint">Nothing was saved for this stage on this ticket.</p>
          )}
        </div>
      </section>
    );
  }

  // ---- General (legacy) ----------------------------------------------------
  if (legacy) {
    const mode = panel.mode;
    return (
      <section
        className={"ticket-stage-panel tone-" + panel.tone}
        aria-label={panel.h2 + ", " + (panel.said || panel.chip || "")}
      >
        <div className="ticket-stage-head">
          {panel.chip && (
            <span className={"ticket-stage-chip " + (CHIP_TONE[panel.tone] || panel.tone)}>
              {panel.chip}
            </span>
          )}
          <h2 ref={headingRef} tabIndex={-1}>
            <Avatar duck={duck} size={22} /> {panel.h2}
          </h2>
        </div>
        <div className="ticket-stage-body">
          {mode === "stuck" && (
            <div className="ticket-stuck-note" role="status">
              <TriangleAlert size={17} aria-hidden="true" />
              <p>
                <strong>Stuck.</strong> The last run stopped before it finished.
                {permTasks &&
                  (duck
                    ? " Ask " + duck.name + " to try again."
                    : " Pick a duck under Edit ticket, then ask it to work.")}
              </p>
              {permTasks && duck && (
                <Button className="small" busy={primaryBusy} disabled={active} onClick={onPrimary}>
                  <Play size={14} />
                  Try again
                </Button>
              )}
            </div>
          )}
          {panel.queueReason ? (
            <div className="workflow-hint">
              <QueueReason reason={panel.queueReason} />
            </div>
          ) : panel.hint ? (
            <p className="workflow-hint">{panel.hint}</p>
          ) : null}
          {mode === "done" && task.result && (
            <StageRecord
              record={{ by: duck ? { duck_id: duck.id, name: duck.name } : null, summary: task.result }}
              ducks={ducks}
              onOpenDocument={onOpenDocument}
            />
          )}
          {mode === "asked" && task.asked && (
            <div className="ticket-stage-handover">
              <div className="ticket-stage-handover-head">
                <Avatar duck={duck} size={28} />
                <span>
                  <strong>{duck?.name || "The duck"}</strong> asked
                </span>
              </div>
              <div className="ticket-update-body">
                <Markdown>{task.asked}</Markdown>
              </div>
            </div>
          )}
        </div>
        <form
          className="ticket-stage-foot"
          onSubmit={(e) => {
            e.preventDefault();
            onPostNote();
          }}
        >
          {permChat ? (
            <>
              <Field label="Your note">
                <textarea
                  rows={2}
                  maxLength={20000}
                  value={draft}
                  onChange={(e) => onDraftChange(e.target.value)}
                  placeholder={askedMe ? "Answer " + (duck?.name || "the duck") + "…" : "Share progress, ask a question, or leave a note for the team…"}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                      e.preventDefault();
                      onPostNote();
                    }
                  }}
                />
              </Field>
              {steering?.message && (
                <p className={"ticket-steering-feedback " + (steering.status || "")} role="status" aria-live="polite">
                  {steering.message}
                </p>
              )}
            </>
          ) : (
            <p className="workflow-hint">
              You can read ticket updates. Ask a company admin for chat permission to post.
            </p>
          )}
          <div className="ticket-stage-buttons">
            {permChat && (
              <button
                type="submit"
                className="ticket-stage-note-only"
                disabled={!draft.trim() || postBusy}
              >
                {askedMe ? "Send answer" : "Post note"}
              </button>
            )}
            {canStop && (
              <Button
                type="button"
                className="secondary ticket-stage-stop"
                busy={stopBusy}
                onClick={onStop}
              >
                <Square size={13} />
                Stop {runningDuck?.name || "the duck"}
              </Button>
            )}
            {permTasks && (mode === "idle") && (
              <Button
                type="button"
                className="ticket-stage-primary"
                busy={primaryBusy}
                disabled={active || !duck}
                onClick={onPrimary}
              >
                <Play size={14} />
                Ask duck to work
              </Button>
            )}
          </div>
        </form>
      </section>
    );
  }

  // ---- board ticket ----------------------------------------------------
  const mode = panel.mode;
  const own = stages ? stages[index] : task?.worker_result || t.worker_result
    ? { summary: t.worker_result, by: null, documents: [], details: "" }
    : null;
  const prev = stages ? stages[index - 1] : null;
  const sentBackHere = ["working", "next-up"].includes(mode) && arrived?.sent_back;
  const showFold = panel.fold && ["stuck", "working", "turn", "next-up"].includes(mode);
  const showRunList = ["stuck", "checking", "working", "checks-next"].includes(mode) && runs?.length > 0;
  const showChecker = mode === "turn" && checkersText;
  const showPaused = board && !board.enabled && mode !== "waiting";

  return (
    <section
      className={"ticket-stage-panel tone-" + panel.tone}
      aria-label={panel.stage + ", " + (panel.said || (panel.chip || "").toLowerCase())}
    >
      <div className="ticket-stage-head">
        {panel.chip && (
          <span className={"ticket-stage-chip " + (CHIP_TONE[panel.tone] || panel.tone)}>
            {panel.chip}
          </span>
        )}
        <h2 ref={headingRef} tabIndex={-1}>
          {panel.h2}
        </h2>
        {panel.meta && <span className="ticket-stage-meta">{panel.meta}</span>}
      </div>
      <div className="ticket-stage-body">
        {showPaused && <p className="workflow-hint">Duck work is paused for this board.</p>}
        {mode === "done" && (
          <>
            <p>{"Finished " + when(t.updated, now) + "."}</p>
            <StageRecord record={prev} ducks={ducks} onOpenDocument={onOpenDocument} />
          </>
        )}
        {mode === "stuck" && (
          <>
            <div className="error-box">{t.error}</div>
            {showRunList && <RunList runs={runs} ducks={ducks} go={go} data={data} />}
          </>
        )}
        {(mode === "asking" || mode === "consulting" || mode === "checking" || mode === "working" || mode === "queued" || mode === "next-up" || mode === "checks-next") &&
          panel.line && (
            <div className="ticket-stage-duck-line">
              <Avatar duck={panel.line.duck} size={28} />
              <div>
                {panel.line.text}
                {panel.queueReason && (
                  <QueueReason reason={panel.queueReason} showLabel={false} />
                )}
              </div>
            </div>
          )}
        {mode === "checking" && <StageRecord record={own} ducks={ducks} onOpenDocument={onOpenDocument} />}
        {mode === "checking" && showRunList && <RunList runs={runs} ducks={ducks} go={go} data={data} />}
        {mode === "working" && sentBackHere && <SentBackBlock arrived={arrived} me={me} ducks={ducks} />}
        {mode === "working" && showRunList && <RunList runs={runs} ducks={ducks} go={go} data={data} />}
        {mode === "waiting" && panel.hint && <p className="workflow-hint">{panel.hint}</p>}
        {mode === "finished" && <StageRecord record={own} ducks={ducks} onOpenDocument={onOpenDocument} />}
        {mode === "checks-next" && !panel.line && (
          <p className="workflow-hint">{panel.hint || "Being checked."}</p>
        )}
        {mode === "checks-next" && <StageRecord record={own} ducks={ducks} onOpenDocument={onOpenDocument} />}
        {mode === "checks-next" && showRunList && <RunList runs={runs} ducks={ducks} go={go} data={data} />}
        {mode === "turn" && (arrived?.sent_back ? (
          <SentBackBlock arrived={arrived} me={me} ducks={ducks} />
        ) : (
          <StageRecord record={prev} ducks={ducks} onOpenDocument={onOpenDocument} />
        ))}
        {mode === "next-up" && sentBackHere && <SentBackBlock arrived={arrived} me={me} ducks={ducks} />}
        {showChecker && <p className="ticket-stage-checkers">{checkersText}</p>}
        {showFold && (
          <details className="ticket-instructions">
            <summary>Instructions for {panel.stage}</summary>
            <Markdown>{column.instructions}</Markdown>
          </details>
        )}
      </div>
      <form
        className="ticket-stage-foot"
        onSubmit={(e) => {
          e.preventDefault();
          onPostNote();
        }}
      >
        {permChat ? (
          <>
            <div className="field">
              <label htmlFor="ticket-stage-note">
                Your note
                {noteHint && <span className="ticket-stage-note-hint">{noteHint}</span>}
              </label>
              <textarea
                id="ticket-stage-note"
                ref={noteRef}
                rows={2}
                maxLength={mode === "stuck" ? 4000 : 20000}
                value={draft}
                onChange={(e) => onDraftChange(e.target.value)}
                placeholder="Share progress, ask a question, or leave a note for the team…"
                aria-invalid={sendBack?.error ? "true" : undefined}
                aria-describedby={sendBack?.error ? "ticket-send-back-error" : undefined}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                    e.preventDefault();
                    onPostNote();
                  }
                }}
              />
            </div>
            {sendBack?.error && (
              <p className="ticket-stage-note-error" id="ticket-send-back-error">
                {sendBack.error}
              </p>
            )}
            {steering?.message && (
              <p className={"ticket-steering-feedback " + (steering.status || "")} role="status" aria-live="polite">
                {steering.message}
              </p>
            )}
          </>
        ) : (
          <p className="workflow-hint">
            You can read ticket updates. Ask a company admin for chat permission to post.
          </p>
        )}
        {!permTasks && primary && (
          <p className="workflow-hint">
            Moving this ticket on needs permission to manage tasks. Your company owner can give you this on
            the Team page.
          </p>
        )}
        <div className="ticket-stage-buttons">
          {permChat && (
            <button type="submit" className="ticket-stage-note-only" disabled={!draft.trim() || postBusy}>
              {noteLabel}
            </button>
          )}
          {permTasks && sendBack && (
            <div className={"ticket-send-back" + (sendBack.earlier.length <= 1 ? " no-chevron" : "")}>
              <Button
                type="button"
                className="secondary ticket-send-back-btn"
                busy={sendBack.busy}
                onClick={sendBack.onSend}
              >
                <Undo2 size={13} />
                Send back to {sendBack.targetName}
              </Button>
              {sendBack.earlier.length > 1 && (
                <span className="ticket-send-back-chevron">
                  <ChevronDown size={14} aria-hidden="true" />
                  <select
                    aria-label="Send back to another stage"
                    value={sendBack.target}
                    onChange={(e) => sendBack.onTargetChange(e.target.value)}
                  >
                    {sendBack.earlier.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </span>
              )}
            </div>
          )}
          {canStop && (
            <Button
              type="button"
              className="secondary ticket-stage-stop"
              busy={stopBusy}
              onClick={onStop}
            >
              <Square size={13} />
              Stop {runningDuck?.name || "the duck"}
            </Button>
          )}
          {permTasks && primary && (
            <Button
              type="button"
              className="ticket-stage-primary"
              busy={primaryBusy}
              onClick={onPrimary}
            >
              {primary.icon === "retry" ? <RotateCcw size={14} /> : <Check size={14} />}
              {primary.label}
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}

function RunList({ runs, ducks, go, data }) {
  const states = {
    ready: "Ready",
    working: "Working",
    stuck: "Stuck",
    reviewing: "In review",
    waiting: "Waiting",
    waiting_consultation: "Waiting for teammate replies",
    blocked: "Needs attention",
    changes_requested: "Changes requested",
    ready_to_move: "Ready to move",
    complete: "Done",
  };
  const display = (value) =>
    value == null || value === "" ? "None" : states[value] || String(value).replaceAll("_", " ");
  return (
    <div className="ticket-run-list">
      {runs.map((r) => (
        <div key={r.id}>
          <Avatar duck={ducks.find((d) => d.id === r.duck_id)} size={28} />
          <span>
            <strong>{ducks.find((d) => d.id === r.duck_id)?.name}</strong>
            <small>
              {r.role === "worker" ? "Working duck" : "Approver"} ·{" "}
              {display(r.status === "done" ? r.decision || "No decision" : r.status)}
            </small>
          </span>
          {data.conversations.some((x) => x.id === r.conversation_id) && (
            <IconButton
              icon={MessageSquare}
              label="Open duck work chat"
              onClick={() => go({ type: "chat", id: r.conversation_id })}
            />
          )}
        </div>
      ))}
    </div>
  );
}
