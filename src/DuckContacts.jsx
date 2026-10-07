import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Check, ChevronDown, Info, Plus } from "lucide-react";
import { api, Avatar } from "./ui.jsx";
import { Switch } from "./Switch.jsx";
import {
  LATER,
  canAsk,
  flip,
  offTeam,
  takeable,
  undoneSaid,
  rowLine,
  askLine,
  flipSaid,
  HOW_OFTEN,
  ANOTHER,
  limitChoices,
  gridFits,
} from "./duck-contacts.mjs";
import "./duck-contacts.css";

// Who a duck may ask for help: one switch for each other duck, in the duck's
// profile and in one grid on Settings > Ducks.
//
// There used to be a second editor with its own Save button, a dropdown of
// three answers that wiped every tick when it changed, and five cards on
// Settings that each opened another copy of it. The answer is the same switch
// in both places now, drawn from what the server already sends every tab.

// The ducks on the team, in the order Settings > Ducks lists them, with the
// face each one wears.
const team = (data) =>
  (data.duck_settings || []).map((d) => ({
    ...d,
    face: (data.ducks || []).find((x) => x.id === d.id),
  }));
// Which duck is the chief is the one thing about a duck its name cannot tell.
const jobOf = (d) => (d.chief ? "Chief of staff" : d.role);

function LaterTile() {
  return (
    <span className="duck-contacts-tile" aria-hidden="true">
      <Plus size={14} />
    </span>
  );
}

// A duck's Contacts tab. It is part of the profile's form: what it holds is
// saved by the dialog's own Save changes, with everything else. `saved` is
// what it opened with.
export function DuckContactsTab({
  duck,
  data,
  saved,
  value,
  onChange,
  problem,
}) {
  const uid = useId();
  const others = team(data).filter((d) => d.id !== duck.id);
  const ids = others.map((d) => d.id);
  const chief = (data.ducks || []).find((d) => d.chief && !d.removed);
  const chiefName = chief ? chief.name : "the chief";
  const set = (to, on) =>
    onChange({ ...value, ...flip(value, ids, to, on, offTeam(saved, ids)) });
  // The box for a number of your own is new when it appears, so the cursor is
  // put in it; and when Save changes found it wrong, the cursor goes back.
  // Each only when it happens: a flip afterwards leaves the cursor alone.
  const [typing, setTyping] = useState(null);
  useEffect(() => {
    if (typing) document.getElementById(uid + typing)?.focus();
  }, [typing, uid]);
  useEffect(() => {
    if (problem?.limit) document.getElementById(uid + problem.limit)?.focus();
  }, [problem, uid]);
  const row = (key, face, name, about, to) => {
    const on = canAsk(value, to);
    return (
      <label
        key={key}
        className={"duck-contacts-row" + (to === LATER ? " is-later" : "")}
      >
        {face}
        <span className="duck-contacts-who">
          <b>{name}</b>
          <i>{about}</i>
        </span>
        <Switch
          checked={on}
          label={
            duck.name +
            " can ask " +
            (to === LATER ? "ducks you add later" : name)
          }
          onChange={(next) => set(to, next)}
        />
        {/* The switch already says which way it is. */}
        <span
          className={"duck-contacts-word" + (on ? " on" : "")}
          aria-hidden="true"
        >
          {on ? "Can ask" : "Off"}
        </span>
      </label>
    );
  };
  return (
    <div className="duck-contacts">
      <h3 className="duck-contacts-q">Who can {duck.name} ask for help?</h3>
      <p className="duck-contacts-say">
        One switch for each duck. The same switches are on Settings › Ducks.
      </p>
      {problem?.notice && (
        <p className="duck-contacts-notice" role="alert">
          {problem.notice}
        </p>
      )}
      <div className="duck-contacts-box">
        {others.map((d) =>
          row(d.id, <Avatar duck={d.face} size={24} />, d.name, jobOf(d), d.id),
        )}
        {row(
          LATER,
          <LaterTile />,
          "Ducks you add later",
          "On means every duck, now and later",
          LATER,
        )}
      </div>
      <div className="duck-contacts-limits">
        <h4>How often</h4>
        {HOW_OFTEN.map((limit) => {
          const v = value[limit.key];
          const own = typeof v === "string";
          const wrong = problem?.limit === limit.key;
          return (
            <div className="duck-contacts-limit" key={limit.key}>
              <label htmlFor={uid + limit.key + "-pick"}>{limit.label}</label>
              <div className="duck-contacts-pick">
                <select
                  id={uid + limit.key + "-pick"}
                  value={own ? "other" : v === null ? "" : String(v)}
                  onChange={(e) => {
                    const picked = e.target.value;
                    setTyping(picked === "other" ? limit.key : null);
                    onChange({
                      ...value,
                      [limit.key]:
                        picked === "other"
                          ? ""
                          : picked === ""
                            ? null
                            : Number(picked),
                    });
                  }}
                >
                  {limitChoices(limit, own ? null : v).map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.text}
                    </option>
                  ))}
                  <option value="other">{ANOTHER}</option>
                </select>
                {own && (
                  <label className="duck-contacts-own">
                    <span>A number from 1 to 1000</span>
                    {/* Plain text with a keypad of numbers: a number box
                        with limits of its own stops the whole form with the
                        browser's words, before these can say anything. */}
                    <input
                      id={uid + limit.key}
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      value={v}
                      aria-invalid={wrong || undefined}
                      aria-describedby={
                        wrong ? uid + limit.key + "-wrong" : undefined
                      }
                      onChange={(e) =>
                        onChange({ ...value, [limit.key]: e.target.value })
                      }
                    />
                  </label>
                )}
                {wrong && (
                  <p
                    className="duck-contacts-wrong"
                    id={uid + limit.key + "-wrong"}
                    role="alert"
                  >
                    {problem.text}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <label className="duck-contacts-lock">
        <Switch
          checked={!value.chief_can_manage}
          label="Only people can change this"
          describedBy={uid + "lock"}
          onChange={(on) => onChange({ ...value, chief_can_manage: !on })}
        />
        <span className="duck-contacts-who">
          <b>Only people can change this</b>
          <i id={uid + "lock"}>
            {value.chief_can_manage
              ? "Right now " + chiefName + " can change it too."
              : chiefName[0].toUpperCase() +
                chiefName.slice(1) +
                " cannot change it."}
          </i>
        </span>
      </label>
    </div>
  );
}

// Settings > Ducks: who can ask whom, one row per duck asking and one column
// per duck asked. A flip is saved there and then, and can be undone.
export function DuckContactGrid({ data, action }) {
  const uid = useId();
  const ducks = team(data);
  const idsBut = (id) => ducks.filter((x) => x.id !== id).map((x) => x.id);
  const nameOf = (id) =>
    (data.ducks || []).find((x) => x.id === id)?.name || "a duck";
  const switchName = (d, to, name) =>
    d.name + " can ask " + (to === LATER ? "new ducks" : name);
  // The ducks whose rows are being saved. A row's switches wait for its
  // answer, because the next flip on that row has to start from what this one
  // saved; the other rows do not. They are not disabled: a switch that is
  // disabled under the keyboard drops the focus to the top of the page.
  const savingNow = useRef(new Set());
  const [saving, setSaving] = useState([]);
  const hold = (id) => {
    if (savingNow.current.has(id)) return false;
    savingNow.current.add(id);
    setSaving([...savingNow.current]);
    return true;
  };
  const release = (id) => {
    savingNow.current.delete(id);
    setSaving([...savingNow.current]);
  };
  // What the last flip did, said under the row it was on: with Undo and what
  // the row had before, or why nothing was saved. One at a time: the next
  // flip is about something else and replaces it.
  const [note, setNote] = useState(null);
  // Undo takes its own button away, so the keyboard goes back to the switch.
  const page = useRef(null);
  const [refocus, setRefocus] = useState(null);
  useEffect(() => {
    if (!refocus) return;
    [...page.current.querySelectorAll("input[role=switch]")]
      .find((el) => el.getAttribute("aria-label") === refocus)
      ?.focus();
    setRefocus(null);
  }, [refocus]);
  // A grid of five ducks needs about 560px and one of nine never fits in this
  // page at all. It is measured here because the room this page has is not
  // the window's: on a tablet the menus leave it a phone's width.
  const box = useRef(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  // Sends one duck's new answer. Somebody else (or the Chief) may have changed
  // it since this page last heard, and the server refuses that with 409. It
  // refuses a duck off the team with 409 too, in words of its own, so the
  // version is asked for again: only a newer one means it had just changed.
  const send = (id, next, version) =>
    action(async () => {
      try {
        return await api("/ducks/" + id + "/contacts", "PATCH", {
          mode: next.mode,
          allowed_duck_ids: next.allowed_duck_ids,
          expected_version: version,
        });
      } catch (e) {
        if (e.status !== 409) throw e;
        const now = await api("/ducks/" + id + "/contacts").catch(() => null);
        if (!now || now.contact_policy.version === version) throw e;
        return { stale: true };
      }
    });
  // Said under the row, not in a toast over it: the switches it points to are
  // the ones to look at.
  const stale = (id, name) =>
    setNote({
      id,
      text:
        "Who " +
        name +
        " can ask had just been changed, so nothing was saved. The switches show it as it is now.",
    });

  async function set(d, to, targetName, on) {
    if (!hold(d.id)) return;
    const before = d.contact_policy;
    try {
      const r = await send(
        d.id,
        flip(before, idsBut(d.id), to, on),
        before.version,
      );
      if (r?.stale) stale(d.id, d.name);
      else if (r?.contact_policy)
        setNote({
          id: d.id,
          text: flipSaid(d.name, targetName, on, before),
          undo: {
            name: d.name,
            before: {
              mode: before.mode,
              allowed_duck_ids: before.allowed_duck_ids,
            },
            version: r.contact_policy.version,
            label: switchName(d, to, targetName),
          },
        });
    } finally {
      release(d.id);
    }
  }

  async function putBack() {
    const { id, undo } = note;
    if (!hold(id)) return;
    try {
      // A duck off the team goes back only onto a list it is still on, and
      // "every duck" keeps no list: the rest is put back, and that is said.
      const now = ducks.find((x) => x.id === id)?.contact_policy;
      const back = takeable(undo.before, idsBut(id), now || undo.before);
      // Saved against the version this flip made, so that if anyone changed
      // the row since, Undo says so rather than throwing their change away.
      const r = await send(id, back, undo.version);
      if (!r) return;
      if (r.stale) stale(id, undo.name);
      else
        setNote({
          id,
          text: undoneSaid(undo.name, back.left.map(nameOf)),
          done: true,
        });
      setRefocus(undo.label);
    } finally {
      release(id);
    }
  }

  const cell = (d, t, name, to) => (
    <Switch
      checked={canAsk(d.contact_policy, to)}
      label={switchName(d, to, name)}
      onChange={(on) => set(d, to, t ? name : null, on)}
    />
  );
  const othersOf = (d) => ducks.filter((x) => x.id !== d.id);
  // What a flip did, with its Undo. The region is there before anything is
  // said in it, so that what appears is read out.
  const said = (show) => (
    <div role="status">
      {show && note && (
        <div className="duck-perms-undo duck-contacts-undo">
          {note.undo || note.done ? (
            <Check size={15} aria-hidden="true" />
          ) : (
            <Info size={15} aria-hidden="true" className="is-info" />
          )}
          <span id={uid + "undo"}>{note.text}</span>
          {note.undo && (
            <button
              type="button"
              aria-describedby={uid + "undo"}
              onClick={putBack}
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
  const folds = !gridFits(width, ducks.length);

  return (
    <section className="duck-contacts-page" aria-labelledby={uid} ref={page}>
      <h3 id={uid}>Who can ask whom</h3>
      <p className="muted">
        Who each duck may ask for help. Changes save straight away.
      </p>
      <div ref={box}>
        {!folds ? (
          <div className="duck-contacts-wrap">
            <table className="duck-contacts-grid" aria-labelledby={uid}>
              <thead>
                <tr>
                  <th scope="col">
                    <b>Asking</b>
                    <span>can ask the duck above</span>
                  </th>
                  {ducks.map((t) => (
                    <th scope="col" key={t.id}>
                      <Avatar duck={t.face} size={24} />
                      <b>{t.name}</b>
                    </th>
                  ))}
                  <th scope="col">
                    <LaterTile />
                    <b>New ducks</b>
                  </th>
                </tr>
              </thead>
              <tbody>
                {ducks.map((d) => (
                  <tr key={d.id} aria-busy={saving.includes(d.id) || undefined}>
                    <th scope="row">
                      <span className="duck-contacts-name">
                        <Avatar duck={d.face} size={28} />
                        <span className="duck-contacts-who">
                          <b>{d.name}</b>
                          <i>{rowLine(d.contact_policy, othersOf(d))}</i>
                        </span>
                      </span>
                    </th>
                    {ducks.map((t) =>
                      t.id === d.id ? (
                        <td key={t.id} className="duck-contacts-self">
                          <span aria-hidden="true">—</span>
                          <span className="duck-perms-sr">Itself</span>
                        </td>
                      ) : (
                        <td key={t.id}>
                          <label className="duck-contacts-cell">
                            {cell(d, t, t.name, t.id)}
                          </label>
                        </td>
                      ),
                    )}
                    <td>
                      <label className="duck-contacts-cell">
                        {cell(d, null, "", LATER)}
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="duck-contacts-folds">
            {ducks.map((d) => (
              // What a flip did is said under its own row here: under the
              // last one it was out of sight on a phone.
              <div key={d.id}>
                <details
                  className="duck-contacts-fold"
                  aria-busy={saving.includes(d.id) || undefined}
                >
                  <summary>
                    <Avatar duck={d.face} size={28} />
                    <span className="duck-contacts-who">
                      <b>{d.name}</b>
                      <i>{askLine(d.contact_policy, othersOf(d))}</i>
                    </span>
                    <ChevronDown size={18} aria-hidden="true" />
                  </summary>
                  {othersOf(d).map((t) => (
                    <label className="duck-contacts-row" key={t.id}>
                      <Avatar duck={t.face} size={24} />
                      <span className="duck-contacts-who">
                        <b>{t.name}</b>
                      </span>
                      {cell(d, t, t.name, t.id)}
                    </label>
                  ))}
                  <label className="duck-contacts-row is-later">
                    <LaterTile />
                    <span className="duck-contacts-who">
                      <b>New ducks</b>
                    </span>
                    {cell(d, null, "", LATER)}
                  </label>
                </details>
                {said(note?.id === d.id)}
              </div>
            ))}
          </div>
        )}
      </div>
      {!folds && said(true)}
    </section>
  );
}
