import SkillCatalog, {
  SkillProvenance,
  TopicPage,
  useCatalog,
  using,
  Faces,
} from "./SkillCatalog.jsx";
import SkillPage from "./SkillPage.jsx";
import { whoLine, topicSkills, SOFTWARE } from "./skill-topics.mjs";
import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import {
  Plus,
  BookOpen,
  ArrowUpRight,
  Upload,
  History,
  Check,
  ChevronRight,
} from "lucide-react";
import {
  api,
  Modal,
  Field,
  Button,
  Markdown,
  DuckPicker,
  flock,
} from "./ui.jsx";
// One page for what the ducks know and what they could learn, and a page for
// each skill. It used to open on a tab of a thousand cards every time, with
// the company's own skills on a second tab nobody was sent to.
export default function Skills({
  data,
  action,
  notify,
  initialId,
  catalogId,
  topic,
  go,
  onTitle,
}) {
  const [edit, setEdit] = useState(null),
    [edits, setEdits] = useState(0),
    [find, setFind] = useState({ query: "", limit: 30 });
  const catalog = useCatalog(data.company.id);
  const place = initialId
    ? "skill:" + initialId
    : catalogId
      ? "catalog:" + catalogId
      : topic
        ? "topic:" + topic
        : "home";
  // Each place is its own page in one scrolling area. Opening a skill starts
  // at its top; coming back to a list finds it scrolled where it was, with the
  // row that was opened still under the keyboard.
  // The window's title names the skill or topic that is open, so a row of
  // pages in the Back menu can be told apart.
  const title = initialId
    ? data.skills.find((s) => s.id === initialId)?.name
    : catalogId
      ? catalog.skills.find((s) => s.id === catalogId)?.name
      : topic === SOFTWARE
        ? "For software teams"
        : topic
          ? topicSkills(catalog.skills, topic).name
          : "";
  useEffect(() => {
    onTitle?.(title || "");
    return () => onTitle?.("");
  }, [title]);
  const pageRef = useRef(null),
    headingRef = useRef(null),
    left = useRef(new Map()),
    here = useRef({ top: 0, row: null }),
    was = useRef(place),
    // The place this one was opened from, while on this page.
    from = useRef(null);
  useLayoutEffect(() => {
    const page = pageRef.current;
    if (was.current === place || !page) return;
    left.current.set(was.current, here.current);
    const before = left.current.get(place);
    page.scrollTop = before?.top || 0;
    here.current = { top: page.scrollTop, row: before?.row || null };
    const row =
      before?.row &&
      page.querySelector('[data-place="' + CSS.escape(before.row) + '"]');
    (row || headingRef.current)?.focus({ preventScroll: true });
    from.current = was.current;
    was.current = place;
  }, [place]);
  // The button that opened the editor gets the focus back when it closes. The
  // dialog is taken out of the page rather than closed, so the browser does
  // not do it, and the focus fell to the top of the page.
  const opener = useRef(null);
  // Changing the instructions starts from the skill as it is now: a tick
  // pressed on the page since it opened is part of the skill too.
  async function change(e) {
    opener.current = e?.currentTarget || null;
    try {
      // `text` is what the page shows, not part of the skill.
      const { text, ...skill } = await api("/skills/" + initialId);
      const now = data.skills.find((s) => s.id === initialId);
      setEdit({ ...skill, ducks: now?.ducks || [] });
    } catch (e) {
      notify(e.message);
    }
  }
  return (
    <div
      className="page skills-page"
      ref={pageRef}
      onScroll={(e) => (here.current.top = e.currentTarget.scrollTop)}
      // A scroll is only reported on the next frame, so a press that leaves
      // straight away notes where the page is itself.
      onClickCapture={(e) => (here.current.top = e.currentTarget.scrollTop)}
      onKeyDownCapture={(e) => (here.current.top = e.currentTarget.scrollTop)}
      onFocus={(e) =>
        (here.current.row =
          e.target.closest?.("[data-place]")?.dataset.place || null)
      }
    >
      <div className="skills-wrap">
        {initialId || catalogId ? (
          <SkillPage
            key={place}
            data={data}
            action={action}
            notify={notify}
            go={go}
            catalog={catalog}
            skillId={initialId}
            catalogId={catalogId}
            onEdit={change}
            // A skill just removed has no row to come back to: the list's
            // heading gets the focus instead of the page itself. Opened from
            // the list, its page goes back to it, so Back afterwards does not
            // show the same list a second time.
            onRemoved={(id, still) => {
              for (const spot of left.current.values())
                if (spot.row === "own:" + id) spot.row = null;
              if (!still) return;
              if (from.current !== "home")
                return go({ type: "skills" }, { replace: true });
              return new Promise((done) => {
                window.addEventListener("popstate", done, { once: true });
                window.history.back();
              });
            }}
            edits={edits}
            headingRef={headingRef}
          />
        ) : topic ? (
          <TopicPage
            key={place}
            data={data}
            go={go}
            catalog={catalog}
            slug={topic}
            notify={notify}
            headingRef={headingRef}
          />
        ) : (
          <>
            <div className="page-heading skills-heading">
              <div>
                <h2 tabIndex={-1} ref={headingRef}>
                  Skills library
                </h2>
                <p>What your ducks know, and more you can add.</p>
              </div>
              {data.permissions.skills && (
                <Button
                  className="secondary"
                  onClick={(e) => {
                    opener.current = e.currentTarget;
                    setEdit({});
                  }}
                >
                  <Plus size={16} aria-hidden="true" />
                  Write a skill
                </Button>
              )}
            </div>
            <section className="skills-sec" aria-labelledby="skills-in-use">
              <h3 id="skills-in-use">
                In use{" "}
                {data.skills.length > 0 && <span>{data.skills.length}</span>}
              </h3>
              {data.skills.length ? (
                <ul className="skills-own">
                  {data.skills.map((s) => {
                    const ducks = using(data, s);
                    return (
                      <li key={s.id}>
                        <button
                          type="button"
                          data-place={"own:" + s.id}
                          onClick={() => go({ type: "skills", id: s.id })}
                        >
                          <b>{s.name}</b>
                          <span className="skills-who">
                            {s.enabled ? (
                              <>
                                <Faces ducks={ducks} />
                                {whoLine(ducks.map((d) => d.name))}
                              </>
                            ) : (
                              "Turned off"
                            )}
                          </span>
                          <ChevronRight
                            className="skills-go"
                            size={18}
                            aria-hidden="true"
                          />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="skills-note">
                  No skills yet. Add one below, or write your own.
                </p>
              )}
            </section>
            <SkillCatalog
              data={data}
              go={go}
              catalog={catalog}
              find={find}
              setFind={setFind}
            />
          </>
        )}
      </div>
      {edit && (
        <SkillEditor
          key={edit.id || "new"}
          skill={edit}
          data={data}
          action={action}
          notify={notify}
          onClose={() => {
            setEdit(null);
            // The page shows the text as saved, not as it was when it opened.
            if (edit.id) setEdits((n) => n + 1);
            const back = opener.current;
            requestAnimationFrame(() => {
              if (back?.isConnected) back.focus();
            });
          }}
        />
      )}
    </div>
  );
}
function SkillEditor({ skill, data, action, notify, onClose }) {
  const [form, setForm] = useState({
    name: "",
    description: "",
    content: "",
    enabled: true,
    ducks: [],
    ...skill,
    enabled: skill.enabled === undefined ? true : !!skill.enabled,
  });
  const [tab, setTab] = useState("write"),
    [busy, setBusy] = useState(false),
    [versions, setVersions] = useState([]);
  const writable = data.permissions.skills;
  const field = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  async function history() {
    try {
      setVersions(await api("/skills/" + skill.id + "/versions"));
      setTab("history");
    } catch (e) {
      notify(e.message);
    }
  }
  return (
    <Modal
      title={skill.id ? "Skill: " + skill.name : "Create a skill"}
      wide
      onClose={onClose}
      warnUnsaved
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const r = await action(
            () =>
              api(
                "/skills" + (skill.id ? "/" + skill.id : ""),
                skill.id ? "PATCH" : "POST",
                form,
              ),
            "Skill saved",
          );
          setBusy(false);
          if (r) onClose();
        }}
      >
        <SkillProvenance skill={skill} />
        <Field label="Skill name">
          <input
            required
            maxLength={100}
            value={form.name}
            onChange={(e) => field("name", e.target.value)}
            readOnly={!writable}
            placeholder="Customer support playbook"
          />
        </Field>
        <Field label="When should a duck use this skill?">
          <input
            maxLength={500}
            value={form.description}
            onChange={(e) => field("description", e.target.value)}
            readOnly={!writable}
            placeholder="Use when drafting a customer reply or resolving a support issue."
          />
        </Field>
        <div className="editor-toolbar">
          <div className="segmented">
            <button
              type="button"
              className={tab === "write" ? "selected" : ""}
              onClick={() => setTab("write")}
            >
              Instructions
            </button>
            <button
              type="button"
              className={tab === "preview" ? "selected" : ""}
              onClick={() => setTab("preview")}
            >
              Preview
            </button>
            {skill.id && writable && (
              <button
                type="button"
                className={tab === "history" ? "selected" : ""}
                onClick={history}
              >
                History
              </button>
            )}
          </div>
          {writable && (
            <label className="file-import">
              <Upload size={14} />
              Import .md
              <input
                type="file"
                accept=".md,.txt,text/markdown,text/plain"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  if (f.size > 60000) {
                    notify("Choose a Markdown file smaller than 60 KB.");
                    return;
                  }
                  field("content", await f.text());
                  if (!form.name)
                    field("name", f.name.replace(/\.(md|txt)$/i, ""));
                  setTab("write");
                  e.target.value = "";
                }}
              />
            </label>
          )}
        </div>
        {tab === "write" ? (
          <textarea
            className="document-editor"
            aria-label="Skill instructions"
            required
            value={form.content}
            onChange={(e) => field("content", e.target.value)}
            readOnly={!writable}
            maxLength={60000}
            placeholder={
              "# How to use this skill\n\nDescribe the steps, examples, and quality checks your duck should follow."
            }
          />
        ) : tab === "preview" ? (
          <div className="document-preview">
            <Markdown>{form.content}</Markdown>
          </div>
        ) : (
          <div className="skill-history">
            {versions.map((v) => (
              <details key={v.version}>
                <summary>
                  Version {v.version} · {new Date(v.created).toLocaleString()}
                </summary>
                <Markdown>{v.content}</Markdown>
                <Button
                  type="button"
                  className="secondary small"
                  onClick={() => {
                    setForm((f) => ({
                      ...f,
                      content: v.content,
                      name: v.name,
                      description: v.description,
                    }));
                    setTab("write");
                  }}
                >
                  Use this version
                </Button>
              </details>
            ))}
          </div>
        )}
        {writable && (
          <>
            <Field label="Ducks with access">
              <DuckPicker
                ducks={flock(data)}
                value={form.ducks}
                onChange={(v) => field("ducks", v)}
              />
            </Field>
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => field("enabled", e.target.checked)}
              />
              Enabled for assigned ducks
            </label>
          </>
        )}
        <div className="modal-actions">
          <small className="muted">
            Skills guide behaviour. Company rules and permissions still apply.
          </small>
          {writable && <Button busy={busy}>Save skill</Button>}
        </div>
      </form>
    </Modal>
  );
}
export function DuckSkills({ duck, data, action }) {
  // What the server says, not a copy taken when the panel opened. Seeded once,
  // this list went on showing what a teammate had already changed, and a tick
  // put back after a failed save was put back into a list that was itself out
  // of date. `pending` is only the tick currently in flight, so the box still
  // responds the moment it is pressed.
  const [pending, setPending] = useState(null),
    [busy, setBusy] = useState(false);
  const assigned = (id) =>
    pending?.id === id
      ? pending.on
      : !!data.skills.find((s) => s.id === id)?.ducks.includes(duck.id);
  return (
    <div className="duck-skills">
      <p>Choose the playbooks {duck.name} can read and use.</p>
      <div className="check-list">
        {data.skills.map((s) => (
          <label key={s.id}>
            <input
              type="checkbox"
              checked={assigned(s.id)}
              disabled={!data.permissions.skills || busy}
              onChange={(e) => {
                // Saved as it is ticked. It used to wait for a button, and the
                // ticks lived only in this tab, so switching tabs or closing
                // the dialog threw them away without a word.
                const on = e.target.checked;
                setPending({ id: s.id, on });
                setBusy(true);
                action(
                  () =>
                    // Just this one tick. Sending the whole list meant the list
                    // this panel read when it opened, so two people on the same
                    // duck each saved their own stale snapshot and the later one
                    // silently took away what the earlier had just granted.
                    api("/ducks/" + duck.id + "/skills", "PUT", {
                      skill: s.id,
                      enabled: on,
                    }),
                  on
                    ? s.name + " added to " + duck.name
                    : s.name + " removed from " + duck.name,
                )
                  // And the tick goes back to whatever the server says either
                  // way. It used to stay where the person left it after a save
                  // that never happened, so the dialog kept showing a skill the
                  // duck does not have, under a line promising the change took
                  // effect immediately. They closed it believing the duck could
                  // use that playbook.
                  .finally(() => {
                    setPending(null);
                    setBusy(false);
                  });
              }}
            />
            <BookOpen size={18} />
            <span>
              {s.name}
              <small>
                {s.enabled ? s.description : "Disabled in the company library"}
              </small>
            </span>
          </label>
        ))}
        {!data.skills.length && (
          <p className="muted">Create your first skill in Skills library.</p>
        )}
      </div>
    </div>
  );
}
