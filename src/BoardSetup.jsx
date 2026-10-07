import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  GripVertical,
  Info,
  Plus,
  ShieldCheck,
  TriangleAlert,
  User,
  X,
} from "lucide-react";
import {
  api,
  Avatar,
  Button,
  Field,
  IconButton,
  flock,
  useUnsavedGuard,
} from "./ui.jsx";
import { ArchiveBoardDialog } from "./BoardArchive.jsx";
import {
  MOST_CHECKERS,
  MOST_STEPS,
  blankStep,
  fromBoard,
  fromTemplate,
  moveStep,
  restarts,
  stepKey,
  templates,
  ticketWords,
} from "./board-setup.mjs";
import "./duck-permissions.css";
import "./board-setup.css";

// Its own kind of drag, so a ticket dragged on the board can never be taken
// for a step, or a step for a ticket.
const DRAG = "text/x-board-step";

// Setting up a board, on a page that looks like the board.
//
// "New board", "Edit workflow" and each column's gear used to open one long
// pop-up with every column folded inside it, so nobody could see the board
// they were building while they built it. Here the steps sit in a row in
// board order, and the one picked is edited right under it.
export default function BoardSetup({ data, action, go, boardId, stepId }) {
  const w = data.workflows;
  const board = boardId ? w.boards.find((b) => b.id === boardId) : null;
  // Built once. Every refresh brings a new copy of the board, and the page
  // does not change under the person typing. base stays the version they
  // opened, so saving over somebody else's change is refused instead.
  const [start] = useState(() =>
    board
      ? fromBoard(
          board,
          w.columns
            .filter((c) => c.board_id === board.id)
            .sort((a, b) => a.position - b.position),
        )
      : fromTemplate("content", flock(data)),
  );
  const [base] = useState(board?.base);
  const [form, setForm] = useState(start);
  const [template, setTemplate] = useState(board ? null : "content");
  const first = start.columns.find((c) => c.id && c.id === stepId);
  const [picked, setPicked] = useState(stepKey(first || start.columns[0]));
  // Nothing that is set is ever hidden: a step with waits, or with checkers
  // who go all at once, opens with More options open.
  const somethingSet = (c) =>
    c.wait_for_ducks.length > 0 ||
    (c.approvers.length > 1 && !c.review_in_order);
  const [more, setMore] = useState(() =>
    somethingSet(first || start.columns[0]),
  );
  const [busy, setBusy] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [drag, setDrag] = useState(null);
  const [report, setReport] = useState(false);
  const focusName = useRef(false);
  const nameRef = useRef(null);
  const rowRef = useRef(null);
  const editorRef = useRef(null);
  const whoId = useId();
  const ticketsId = useId();
  const unsaved = JSON.stringify(form) !== JSON.stringify(start);
  useUnsavedGuard(() => unsaved);

  const index = Math.max(
    0,
    form.columns.findIndex((c) => stepKey(c) === picked),
  );
  const current = form.columns[index];
  const hasFinish = !!form.columns.at(-1)?.finish;
  const team = flock(data);
  const duckOf = (id) => data.ducks.find((d) => d.id === id);
  const nameOf = (c) => c.name.trim() || "Untitled step";

  function pick(key) {
    if (key === picked) return;
    setPicked(key);
    setMore(somethingSet(form.columns.find((c) => stepKey(c) === key)));
  }
  const setBoard = (field, value) => setForm((f) => ({ ...f, [field]: value }));
  const change = (patch) =>
    setForm((f) => ({
      ...f,
      columns: f.columns.map((c) =>
        stepKey(c) === picked ? { ...c, ...patch } : c,
      ),
    }));
  const move = (from, to) =>
    setForm((f) => ({ ...f, columns: moveStep(f.columns, from, to) }));
  function startFrom(id) {
    const t = fromTemplate(id, flock(data));
    // A name somebody typed is theirs; only an empty one or a template's own
    // name follows the template.
    setForm((f) => ({
      ...f,
      name:
        !f.name.trim() || templates.some((x) => x.name && x.name === f.name)
          ? t.name
          : f.name,
      columns: t.columns,
    }));
    setTemplate(id);
    setPicked(stepKey(t.columns[0]));
    setMore(false);
  }
  function add() {
    const step = blankStep(form.columns);
    const at = hasFinish ? form.columns.length - 1 : form.columns.length;
    setForm((f) => ({
      ...f,
      columns: [...f.columns.slice(0, at), step, ...f.columns.slice(at)],
    }));
    setPicked(stepKey(step));
    setMore(false);
    focusName.current = true;
  }
  function remove() {
    const next = form.columns[index - 1] || form.columns[index + 1];
    setForm((f) => ({
      ...f,
      columns: f.columns.filter((c) => stepKey(c) !== picked),
    }));
    pick(stepKey(next));
  }
  async function save(e) {
    e.preventDefault();
    // The server's own answer to a blank step name is not readable, and the
    // step may not be the one on screen. Show that step and say it here.
    const blank = form.columns.find((c) => !c.name.trim());
    if (blank) {
      pick(stepKey(blank));
      setReport(true);
      return;
    }
    setBusy(true);
    const body = {
      name: form.name,
      description: form.description,
      enabled: form.enabled,
      auto_advance: form.auto_advance,
      columns: form.columns,
    };
    const r = await action(
      () =>
        board
          ? api("/boards/" + board.id, "PUT", { ...body, base })
          : api("/boards", "POST", body),
      board ? "Board saved" : "Board created",
    );
    setBusy(false);
    if (r) go({ type: "tasks", boardId: r.id }, { asked: true });
  }

  useEffect(() => {
    const input = nameRef.current;
    if (!input) return;
    input.setCustomValidity(
      current.name.trim() ? "" : "Give this step a name.",
    );
    if (report) {
      input.reportValidity();
      setReport(false);
    }
    if (focusName.current) {
      focusName.current = false;
      input.focus();
      input.select();
    }
  });
  useEffect(() => {
    rowRef.current
      ?.querySelector('[aria-pressed="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [picked]);
  useLayoutEffect(() => placeCaret(rowRef.current, editorRef.current));
  useEffect(() => {
    const place = () => placeCaret(rowRef.current, editorRef.current);
    const row = rowRef.current;
    row.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    return () => {
      row.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
    };
  }, []);

  const whoOf = (c) => {
    if (!c.duck_id) return { kind: "person" };
    const duck = duckOf(c.duck_id);
    return { kind: duck && !duck.removed ? "duck" : "gone", duck };
  };
  const who = whoOf(current);
  const saved = current.id && w.columns.find((c) => c.id === current.id);
  const tickets = current.id
    ? w.tickets.filter(
        (t) => t.column_id === current.id && t.state !== "complete",
      ).length
    : 0;
  const name = nameOf(current);
  const last = hasFinish ? form.columns.length - 2 : form.columns.length - 1;

  return (
    <>
      <form className="page board-setup" onSubmit={save}>
        <div className="board-setup-head">
          <div className="board-setup-title">
            <div className="eyebrow">
              {board ? "EDITING BOARD" : "NEW BOARD"}
            </div>
            <div className="board-setup-names">
              <input
                className="board-setup-name"
                required
                maxLength={100}
                aria-label="Board name"
                placeholder="Board name"
                value={form.name}
                onChange={(e) => setBoard("name", e.target.value)}
              />
              <input
                className="board-setup-about"
                maxLength={2000}
                aria-label="Description"
                placeholder="What is this board for?"
                value={form.description}
                onChange={(e) => setBoard("description", e.target.value)}
              />
            </div>
          </div>
          <div className="board-setup-actions">
            {board && (
              <button
                type="button"
                className="board-setup-quiet"
                onClick={() => setArchiving(true)}
              >
                <Archive size={16} aria-hidden="true" />
                Archive board
              </button>
            )}
            <Button
              type="button"
              className="secondary"
              onClick={() =>
                go(
                  board
                    ? { type: "tasks", boardId: board.id }
                    : { type: "tasks" },
                )
              }
            >
              Cancel
            </Button>
            <Button busy={busy}>
              {!busy && <Check size={15} aria-hidden="true" />}
              {board ? "Save board" : "Create board"}
            </Button>
          </div>
        </div>
        {!board && (
          <div className="board-setup-start">
            <div className="board-setup-pills">
              <span className="muted">Start from</span>
              {templates.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  aria-pressed={template === t.id}
                  onClick={() => startFrom(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <p className="muted">
              Ducks are picked by their job. Change any step.
            </p>
          </div>
        )}
        <div className="board-setup-steps-head">
          <h2>Steps</h2>
          <span className="board-setup-hint">
            <span className="board-setup-drag">Drag to reorder. </span>
            Pick a step to change it.
          </span>
        </div>
        <div className="board-setup-steps" ref={rowRef}>
          {form.columns.map((c, i) => {
            const key = stepKey(c);
            const them = whoOf(c);
            const checkers = c.approvers.map(duckOf);
            const lost = checkers.some((d) => !d || d.removed);
            const label = c.finish
              ? "Finish line, " + nameOf(c) + "."
              : "Step " +
                (i + 1) +
                ", " +
                nameOf(c) +
                ". " +
                (them.kind === "gone"
                  ? "Needs a new duck."
                  : (them.kind === "duck"
                      ? them.duck.name + " does it. "
                      : "A person does it. ") +
                    (!checkers.length
                      ? "No check."
                      : lost
                        ? "Needs a new checker."
                        : "Checked by " +
                          checkers.map((d) => d.name).join(", ") +
                          "."));
            return (
              <button
                type="button"
                key={key}
                className={
                  "board-setup-card " +
                  (c.finish
                    ? "finish"
                    : them.kind === "person"
                      ? "person"
                      : "duck") +
                  (drag?.over === key
                    ? drag.after
                      ? " drop-after"
                      : " drop-before"
                    : "")
                }
                aria-pressed={key === picked}
                aria-label={label}
                draggable={!c.finish}
                onClick={() => pick(key)}
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG, key);
                  e.dataTransfer.effectAllowed = "move";
                  setDrag({ key });
                }}
                onDragOver={(e) => {
                  if (!drag || !e.dataTransfer.types.includes(DRAG)) return;
                  e.preventDefault();
                  const box = e.currentTarget.getBoundingClientRect();
                  // Nothing lands after the finish line.
                  const after =
                    !c.finish && e.clientX > box.left + box.width / 2;
                  if (drag.over !== key || drag.after !== after)
                    setDrag({ ...drag, over: key, after });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (!drag?.over) return;
                  const at = (k) =>
                    form.columns.findIndex((x) => stepKey(x) === k);
                  const from = at(drag.key);
                  const to = at(drag.over) + (drag.after ? 1 : 0);
                  move(from, to > from ? to - 1 : to);
                  setDrag(null);
                }}
                onDragEnd={() => setDrag(null)}
              >
                <span className="board-setup-card-top">
                  <span className={"column-number" + (c.finish ? " last" : "")}>
                    {c.finish ? <Check size={12} /> : i + 1}
                  </span>
                  <span className="board-setup-card-name" title={c.name}>
                    {nameOf(c)}
                  </span>
                  {!c.finish && (
                    <GripVertical
                      className="board-setup-grip"
                      size={14}
                      aria-hidden="true"
                    />
                  )}
                </span>
                {c.finish ? (
                  <>
                    <span className="board-setup-card-who">Finish line</span>
                    <span className="board-setup-card-check muted">
                      Tickets here are done
                    </span>
                  </>
                ) : (
                  <>
                    <span
                      className={
                        "board-setup-card-who" +
                        (them.kind === "gone" ? " danger" : "")
                      }
                    >
                      {them.kind === "duck" ? (
                        <Avatar duck={them.duck} size={20} />
                      ) : them.kind === "person" ? (
                        <span className="workflow-person-mark">
                          <User size={13} aria-hidden="true" />
                        </span>
                      ) : (
                        <TriangleAlert size={15} aria-hidden="true" />
                      )}
                      <span>
                        {them.kind === "duck"
                          ? them.duck.name
                          : them.kind === "person"
                            ? "A person"
                            : "Needs a new duck"}
                      </span>
                    </span>
                    <span
                      className={
                        "board-setup-card-check" +
                        (checkers.length && !lost ? " checked" : "")
                      }
                    >
                      <ShieldCheck size={13} aria-hidden="true" />
                      {!checkers.length ? (
                        <span className="muted">No check</span>
                      ) : lost ? (
                        <span className="danger">Needs a new checker</span>
                      ) : (
                        <>
                          {checkers.map((d) => (
                            <Avatar key={d.id} duck={d} size={16} />
                          ))}
                          <span className="board-setup-card-checkers">
                            {checkers.map((d) => d.name).join(", ")}
                          </span>
                        </>
                      )}
                    </span>
                  </>
                )}
              </button>
            );
          })}
          <button
            type="button"
            className="board-setup-add"
            disabled={form.columns.length >= MOST_STEPS}
            title={
              form.columns.length >= MOST_STEPS
                ? "A board can have up to 12 steps."
                : undefined
            }
            onClick={add}
          >
            <Plus size={18} aria-hidden="true" />
            Add step
          </button>
        </div>
        <section
          className="board-setup-editor"
          aria-label={name + " step"}
          ref={editorRef}
        >
          <span className="board-setup-caret" aria-hidden="true" />
          <div className="board-setup-editor-head">
            <span className={"column-number" + (current.finish ? " last" : "")}>
              {current.finish ? <Check size={12} /> : index + 1}
            </span>
            <h3>{name}</h3>
            {!current.finish && (
              <div className="board-setup-tools">
                <IconButton
                  icon={ArrowLeft}
                  label={"Move " + name + " left"}
                  disabled={index === 0}
                  onClick={() => move(index, index - 1)}
                />
                <IconButton
                  icon={ArrowRight}
                  label={"Move " + name + " right"}
                  disabled={index >= last}
                  onClick={() => move(index, index + 1)}
                />
                <button
                  type="button"
                  className="board-setup-quiet"
                  disabled={tickets > 0 || form.columns.length <= 2}
                  title={
                    tickets > 0
                      ? "A step with tickets in it cannot be removed."
                      : undefined
                  }
                  aria-describedby={tickets > 0 ? ticketsId : undefined}
                  onClick={remove}
                >
                  <X size={14} aria-hidden="true" />
                  Remove step
                </button>
              </div>
            )}
          </div>
          {current.finish ? (
            <div className="board-setup-finish">
              <Field label="Step name">
                <input
                  ref={nameRef}
                  required
                  maxLength={100}
                  value={current.name}
                  onChange={(e) => change({ name: e.target.value })}
                />
              </Field>
              <p className="muted">
                This is the finish line. Tickets that reach it are done.
              </p>
            </div>
          ) : (
            <>
              <div className="board-setup-editor-body">
                <div>
                  <Field label="Step name">
                    <input
                      ref={nameRef}
                      required
                      maxLength={100}
                      value={current.name}
                      onChange={(e) => change({ name: e.target.value })}
                    />
                  </Field>
                  <div className="field">
                    <label id={whoId}>Who does this step</label>
                    {who.kind === "gone" && (
                      <p className="board-setup-gone">
                        {(who.duck?.name || "Its duck") +
                          " was taken off the team, so this step needs a new duck."}
                      </p>
                    )}
                    <div
                      className="board-setup-who"
                      role="radiogroup"
                      aria-labelledby={whoId}
                    >
                      {team.map((d) => (
                        <label
                          key={d.id}
                          className={current.duck_id === d.id ? "picked" : ""}
                        >
                          <input
                            type="radio"
                            name="board-setup-who"
                            checked={current.duck_id === d.id}
                            onChange={() =>
                              change({
                                duck_id: d.id,
                                // A duck does not check its own work.
                                approvers: current.approvers.filter(
                                  (x) => x !== d.id,
                                ),
                              })
                            }
                          />
                          <Avatar duck={d} size={24} />
                          <span>
                            <strong>{d.name}</strong>
                            <small>{d.role}</small>
                          </span>
                        </label>
                      ))}
                      <label className={!current.duck_id ? "picked" : ""}>
                        <input
                          type="radio"
                          name="board-setup-who"
                          checked={!current.duck_id}
                          onChange={() => change({ duck_id: null })}
                        />
                        <span className="workflow-person-mark">
                          <User size={13} aria-hidden="true" />
                        </span>
                        <span>
                          <strong>A person</strong>
                          <small>Who made the ticket</small>
                        </span>
                      </label>
                    </div>
                  </div>
                </div>
                <div>
                  <Field label="What to do">
                    <textarea
                      maxLength={12000}
                      placeholder="What should happen in this step?"
                      value={current.instructions}
                      onChange={(e) => change({ instructions: e.target.value })}
                    />
                  </Field>
                  <Ducks
                    label="Checked by"
                    hint="Checks the work before the ticket moves on."
                    add="Add a checker"
                    ids={current.approvers}
                    offer={team.filter(
                      (d) =>
                        d.id !== current.duck_id &&
                        !current.approvers.includes(d.id),
                    )}
                    most={MOST_CHECKERS}
                    duckOf={duckOf}
                    onChange={(approvers) => change({ approvers })}
                  />
                </div>
              </div>
              <div className="board-setup-foot">
                <button
                  type="button"
                  className="board-setup-more"
                  aria-expanded={more}
                  onClick={() => setMore(!more)}
                >
                  <ChevronRight size={14} aria-hidden="true" />
                  <strong>More options</strong>
                  <span className="muted">Wait for other work first</span>
                </button>
                {more && (
                  <div className="board-setup-more-body">
                    <Ducks
                      label="Wait for other work first"
                      hint="This step starts once these ducks have finished their other work."
                      add="Add a duck"
                      ids={current.wait_for_ducks}
                      offer={team.filter(
                        (d) => !current.wait_for_ducks.includes(d.id),
                      )}
                      duckOf={duckOf}
                      onChange={(wait_for_ducks) => change({ wait_for_ducks })}
                    />
                    {current.approvers.length > 1 && (
                      <label className="checkbox-line">
                        <input
                          type="checkbox"
                          checked={current.review_in_order}
                          onChange={(e) =>
                            change({ review_in_order: e.target.checked })
                          }
                        />
                        Ask checkers one at a time
                      </label>
                    )}
                  </div>
                )}
                {tickets > 0 && (
                  <p className="board-setup-tickets" id={ticketsId}>
                    <Info size={15} aria-hidden="true" />
                    {ticketWords(
                      tickets,
                      current.name.trim() || saved?.name,
                      restarts(saved, current),
                    )}
                  </p>
                )}
              </div>
            </>
          )}
        </section>
        <div className="board-setup-whole">
          <strong>Whole board</strong>
          <label>
            <Switch
              checked={form.enabled}
              onChange={(v) => setBoard("enabled", v)}
            />
            Ducks start their steps on their own
          </label>
          <label>
            <Switch
              checked={form.auto_advance}
              onChange={(v) => setBoard("auto_advance", v)}
            />
            Tickets move on when a step is done
          </label>
        </div>
      </form>
      {archiving && (
        <ArchiveBoardDialog
          board={board}
          data={data}
          unsaved={unsaved}
          action={action}
          go={go}
          onClose={() => setArchiving(false)}
        />
      )}
    </>
  );
}

// The small square under the editor's top edge points at the picked card, and
// follows it when the row slides sideways or the window changes size. A card
// scrolled out of the row has nothing to point at.
export function placeCaret(row, editor) {
  const card = row?.querySelector('[aria-pressed="true"]');
  if (!card || !editor) return;
  const c = card.getBoundingClientRect(),
    e = editor.getBoundingClientRect(),
    x = c.left + c.width / 2 - e.left;
  editor.style.setProperty("--caret-x", x + "px");
  editor.toggleAttribute("data-no-caret", x < 20 || x > e.width - 20);
}

// Ducks as chips, with a real dropdown laid unseen over "Add", the way the
// board's name opens its list: the keyboard, a screen reader and a phone's
// own picker all work with it.
function Ducks({ label, hint, add, ids, offer, most, duckOf, onChange }) {
  const id = useId();
  return (
    <div className="field">
      <label id={id}>{label}</label>
      <div
        className="board-setup-chips"
        role="group"
        aria-labelledby={id}
        aria-describedby={id + "-hint"}
      >
        {ids.map((d) => {
          const duck = duckOf(d);
          return (
            <span className="board-setup-chip" key={d}>
              <Avatar duck={duck} size={22} />
              <span>{duck?.name || "A duck"}</span>
              {(!duck || !!duck.removed) && (
                <span className="muted">Off the team</span>
              )}
              <IconButton
                icon={X}
                label={"Remove " + (duck?.name || "this duck")}
                onClick={() => onChange(ids.filter((x) => x !== d))}
              />
            </span>
          );
        })}
        {(!most || ids.length < most) && offer.length > 0 && (
          <span className="board-setup-add-duck">
            <Plus size={15} aria-hidden="true" />
            {add}
            <select
              aria-label={add}
              value=""
              onChange={(e) =>
                e.target.value && onChange([...ids, e.target.value])
              }
            >
              <option value="" disabled>
                {add}
              </option>
              {offer.map((d) => (
                <option key={d.id} value={d.id}>
                  {[d.name, d.role].filter(Boolean).join(" — ")}
                </option>
              ))}
            </select>
          </span>
        )}
      </div>
      <small id={id + "-hint"}>{hint}</small>
    </div>
  );
}

// The product's switch, the same one Settings > Emails and the duck
// permissions use: a real tick box drawn as a track and a knob.
function Switch({ checked, onChange }) {
  return (
    <span className="duck-perms-switch">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="duck-perms-track" aria-hidden="true" />
    </span>
  );
}
