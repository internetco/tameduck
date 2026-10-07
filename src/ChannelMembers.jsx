// Members: one dialog for everything about a channel - its name, the people,
// the ducks, adding anyone, leaving and archiving.
//
// It used to be a list with no headings where your own row sat below the
// ducks, a duck went on one click, a person went through the browser's grey
// box, and clicking a name in the Add box added that person, because the Add
// word sat inside the row's label. Every removal now asks in its own row, and
// nobody is added until Add beside them is pressed.
import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Archive,
  Check,
  CircleAlert,
  Eye,
  Hash,
  Loader2,
  Lock,
  LogOut,
  Pencil,
  Plus,
  Search,
  X,
} from "lucide-react";
import { api, Avatar, Button, flock, useCountsAsDialog } from "./ui.jsx";
import { canArchiveChannel } from "./ChannelArchive.jsx";
import {
  blank,
  channelLists,
  duckRule,
  footLine,
  headLine,
  maker,
  onlyWho,
  peopleRule,
  plain,
  removeAsk,
  toAdd,
} from "./channel-members.mjs";
import "./channel-members.css";

export default function ChannelMembers({
  data,
  channel,
  action,
  go,
  onClose,
  onArchive,
  // "archive" when coming back from the archive dialog's Cancel.
  focus,
  // What had focus before the dialog opened, to go back to when it closes.
  opener,
}) {
  const ref = useRef(null);
  const nameRef = useRef(null);
  const ids = useId();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(channel.name);
  const [nameError, setNameError] = useState("");
  // null, "leave", or the person or duck whose row is asking.
  const [asking, setAsking] = useState(null);
  const [busy, setBusy] = useState(null);
  const [query, setQuery] = useState("");
  // Who was added since the search last changed: their rows stay, saying so.
  const [added, setAdded] = useState([]);
  const back = useRef(opener);
  useCountsAsDialog(true);

  const me = data.user.id;
  const ducks = flock(data);
  const lists = channelLists({ members: data.members, ducks, me }, channel);
  const made = maker({ members: data.members, me }, channel);
  const archived = !!channel.archived;
  const chat = !!data.permissions.chat && !archived;
  const runs = chat && canArchiveChannel(data, channel);
  const rights = { chat, runs };
  const alone = lists.people.length <= 1;
  const searching = chat && query.trim() !== "";
  const found = toAdd({ members: data.members, ducks }, channel, query, added);
  // A question or a rename can outlive what it is about: the channel
  // archived in another tab, or the person already taken out there. It went
  // on offering what the band above it said nobody could do.
  const leaving = asking === "leave" && chat && !alone;
  const everyone = [...lists.people, ...lists.ducks];
  const removable = (kind, who) =>
    chat && who.id !== me && (kind === "duck" || runs);
  const askGone =
    !!asking &&
    !leaving &&
    !everyone.some(
      (x) =>
        x.id === asking.id &&
        removable(lists.ducks.includes(x) ? "duck" : "person", x),
    );
  const editing = renaming && runs;

  // Where the focus goes once React has drawn the change: the first match
  // on screen, since the phone and the desktop each show their own Rename.
  // In the same frame as the change, so it never falls to the page between.
  const [aim, setAim] = useState(null);
  const focusSoon = (...selectors) => setAim({ selectors });
  useLayoutEffect(() => {
    if (!aim) return;
    for (const selector of aim.selectors) {
      const el = [...(ref.current?.querySelectorAll(selector) || [])].find(
        (x) => x.offsetParent !== null,
      );
      if (el) return el.focus();
    }
  }, [aim]);

  function stopRenaming() {
    setRenaming(false);
    setNameError("");
    focusSoon('[data-focus="rename"]');
  }
  function stopAsking() {
    const was = asking;
    setAsking(null);
    focusSoon(
      was === "leave" ? '[data-focus="leave"]' : `[data-remove="${was?.id}"]`,
    );
  }
  // Clears a question or a rename that has lost what it was about, and keeps
  // the focus in the dialog if it was on something that went with it.
  useLayoutEffect(() => {
    if (busy || !(askGone || (renaming && !runs))) return;
    setAsking(null);
    setRenaming(false);
    setNameError("");
    if (!ref.current?.contains(document.activeElement))
      focusSoon(
        "#" + CSS.escape(ids + "find"),
        "#" + CSS.escape(ids + "title"),
      );
  }, [askGone, renaming, runs, busy]);

  // A double click on Remove or Leave put its second click on the question's
  // own answer, which appears right where Remove or Leave was: Sam left a
  // channel he could not get back into. An answer takes a click of its own.
  const askedAt = useRef(0);
  const ask = (what) => {
    askedAt.current = performance.now();
    setRenaming(false);
    setAsking(what);
    focusSoon("[data-keep]");
  };
  const deliberate = (e) =>
    e.detail === 0 ||
    (e.detail === 1 && performance.now() - askedAt.current > 500);

  // Escape steps back out of a question or a rename before it closes the
  // dialog; the X and the backdrop close it at once.
  const escape = useRef();
  escape.current = () => {
    if (renaming) return stopRenaming();
    if (asking) return stopAsking();
    onClose();
  };
  // Handled as a key, before the browser makes it a request to close: Chrome
  // lets a page refuse only so many of those in a row, and the third Escape
  // closed the whole dialog. While a name is being saved it waits, as Cancel
  // does, so a refusal still has a field to be said under.
  const stepBack = (e) => {
    if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
    if (!renaming && !asking) return;
    e.preventDefault();
    e.stopPropagation();
    if (!busy) escape.current();
  };
  const close = useRef();
  close.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    back.current ||= document.activeElement;
    dialog.showModal();
    if (focus === "archive")
      dialog.querySelector('[data-focus="archive"]')?.focus();
    const cancel = (e) => {
      e.preventDefault();
      escape.current();
    };
    // The browser closes a dialog itself on a second Escape in a row.
    const closed = () => close.current();
    dialog.addEventListener("cancel", cancel);
    dialog.addEventListener("close", closed);
    return () => {
      dialog.removeEventListener("cancel", cancel);
      dialog.removeEventListener("close", closed);
      const to =
        typeof back.current === "function" ? back.current() : back.current;
      if (to?.isConnected) to.focus();
    };
  }, []);
  useLayoutEffect(() => {
    if (!renaming) return;
    nameRef.current?.focus();
    nameRef.current?.select();
  }, [renaming]);

  function startRenaming() {
    setName(channel.name);
    setNameError("");
    setAsking(null);
    setRenaming(true);
  }
  async function saveName(e) {
    e.preventDefault();
    const next = name.trim();
    if (blank(next)) {
      setNameError("Give the channel a name.");
      return nameRef.current?.focus();
    }
    if (next === channel.name) return stopRenaming();
    setBusy("name");
    setNameError("");
    let refused = "";
    const saved = await action(
      async () => {
        try {
          return await api("/conversations/" + channel.id, "PATCH", {
            name: next,
          });
        } catch (err) {
          // Said under the field, where the name is being typed. A request
          // that never reached the server has only the browser's words.
          refused = err.status
            ? err.message
            : "The name was not saved. Check your connection and try again.";
          return null;
        }
      },
      (r) => (r ? "Renamed to #" + next : ""),
    );
    setBusy(null);
    if (saved) return stopRenaming();
    setNameError(refused);
    nameRef.current?.focus();
  }

  async function change(body, said) {
    return action(
      () =>
        api("/conversations/" + channel.id, "PATCH", body).catch((err) => {
          throw plain(err);
        }),
      said,
    );
  }
  async function remove(e, kind, who, list) {
    if (!deliberate(e)) return;
    // Where focus goes once the row has gone: the next Remove down, or up.
    const others = list.filter((x) => x.id !== me);
    const at = others.findIndex((x) => x.id === who.id);
    const next = others[at + 1] || others[at - 1];
    setBusy(who.id);
    const done = await change(
      kind === "duck"
        ? { remove_ducks: [who.id] }
        : { remove_members: [who.id] },
      who.name + " removed",
    );
    setBusy(null);
    setAsking(null);
    if (done)
      focusSoon(
        next ? `[data-remove="${next.id}"]` : "#" + CSS.escape(ids + "find"),
        ".cm-x",
      );
    else focusSoon(`[data-remove="${who.id}"]`);
  }
  async function add(kind, who) {
    setBusy(who.id);
    const done = await change(
      kind === "duck" ? { add_ducks: [who.id] } : { add_members: [who.id] },
      who.name + " added",
    );
    if (done) setAdded((list) => [...list, who.id]);
    setBusy(null);
    // The row stays where it was, now saying they are in, and keeps the focus.
    focusSoon(`[data-add="${who.id}"]`);
  }
  async function leave(e) {
    if (!deliberate(e)) return;
    // Leaving cannot be undone by the person who leaves: a channel you are not
    // in is one you cannot see. So it waits for the server, and only then goes
    // somewhere real; offline it went on at once while you were still in.
    const left = channel;
    setBusy("leave");
    let refused = null;
    await api("/conversations/" + left.id, "PATCH", {
      remove_members: [me],
    }).catch((err) => (refused = plain(err)));
    setBusy(null);
    if (refused) {
      focusSoon("[data-keep]");
      return action(() => Promise.reject(refused));
    }
    // A chat with a duck, or else another channel, or else Needs you: a
    // person with no chat of their own landed on an empty page.
    const open = (c) => c.id !== left.id && !c.archived;
    const next =
      data.conversations.find((c) => c.kind === "direct" && open(c)) ||
      data.conversations.find((c) => c.kind === "group" && open(c));
    // Once the dialog has gone, the focus goes to the title of where you are.
    back.current = () => document.querySelector(".topbar h1");
    onClose();
    go(next ? { type: "chat", id: next.id } : { type: "inbox" });
    action(async () => true, "You left #" + left.name);
  }
  async function unarchive() {
    setBusy("archive");
    const done = await action(
      () =>
        api("/conversations/" + channel.id + "/archive", "PATCH", {
          archived: false,
        }).catch((err) => {
          throw plain(err);
        }),
      "Channel unarchived",
    );
    setBusy(null);
    if (done) focusSoon("#" + CSS.escape(ids + "title"));
  }

  const row = (kind, who, list) => {
    const mine = who.id === me;
    const canRemove = removable(kind, who);
    if (canRemove && !searching && asking && asking.id === who.id) {
      const q = removeAsk(who, kind);
      return (
        <div className="cm-ask" role="listitem" key={who.id}>
          <div
            className="cm-ask-in"
            role="group"
            aria-label={q.title}
            aria-describedby={ids + "what"}
          >
            <Avatar
              duck={kind === "duck" ? who : null}
              name={who.name}
              size={32}
            />
            <span className="cm-who">
              <b>{q.title}</b>
              <span id={ids + "what"}>{q.what}</span>
            </span>
            <span className="cm-end">
              <button
                type="button"
                className="cm-btn"
                data-keep=""
                disabled={!!busy}
                onClick={stopAsking}
              >
                {q.keep}
              </button>
              <button
                type="button"
                className="cm-btn cm-stop"
                disabled={!!busy}
                onClick={(e) => remove(e, kind, who, list)}
              >
                {busy === who.id && <Loader2 className="spin" size={16} />}
                {q.remove}
              </button>
            </span>
          </div>
        </div>
      );
    }
    const tag = mine
      ? "You"
      : kind === "person" && who.id === channel.creator_id
        ? "Made this channel"
        : "";
    const inside = (kind === "duck" ? channel.ducks : channel.members).includes(
      who.id,
    );
    return (
      <div className="cm-row" role="listitem" key={who.id}>
        <Avatar duck={kind === "duck" ? who : null} name={who.name} size={32} />
        <span className="cm-who">
          <b>
            {who.name}
            {tag && (
              <>
                {" "}
                <span className="cm-tag">{tag}</span>
              </>
            )}
          </b>
          <span>{kind === "duck" ? who.role : who.email}</span>
        </span>
        {searching ? (
          <span className="cm-end">
            {inside ? (
              // Still a button, so the focus has somewhere to stay; pressing
              // it again does nothing.
              <button
                type="button"
                className="cm-btn cm-added"
                data-add={who.id}
                aria-label={"Added " + who.name}
                aria-disabled="true"
              >
                <Check size={16} aria-hidden="true" />
                Added
              </button>
            ) : (
              <button
                type="button"
                className="cm-btn"
                data-add={who.id}
                aria-label={"Add " + who.name}
                disabled={!!busy}
                onClick={() => add(kind, who)}
              >
                {busy === who.id ? (
                  <Loader2 className="spin" size={16} />
                ) : (
                  <Plus size={16} aria-hidden="true" />
                )}
                Add
              </button>
            )}
          </span>
        ) : (
          canRemove && (
            <span className="cm-end">
              <button
                type="button"
                className="cm-btn"
                data-remove={who.id}
                aria-label={"Remove " + who.name}
                disabled={!!busy}
                onClick={() => ask(who)}
              >
                Remove
              </button>
            </span>
          )
        )}
      </div>
    );
  };
  const group = (title, count, rule, kind, list, empty) => (
    <section className="cm-grp" aria-labelledby={ids + kind}>
      <div className="cm-gh">
        <h3 id={ids + kind}>
          {title}
          {count !== null && <span> {count}</span>}
        </h3>
        {rule && <p>{rule}</p>}
      </div>
      {list.length ? (
        <div className="cm-rows" role="list">
          {list.map((who) => row(kind, who, list))}
        </div>
      ) : (
        <p className="cm-empty">{empty}</p>
      )}
    </section>
  );

  const say = !archived && footLine(rights, made, alone);
  return (
    <dialog
      ref={ref}
      className="modal cm-dialog"
      aria-label={channel.name}
      onKeyDown={stepBack}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="cm-head">
        <span className="cm-tile" aria-hidden="true">
          {archived ? <Archive size={20} /> : <Hash size={20} />}
        </span>
        {editing ? (
          <form className="cm-ht" onSubmit={saveName} noValidate>
            <label className="cm-label" htmlFor={ids + "name"}>
              Channel name
            </label>
            <input
              id={ids + "name"}
              ref={nameRef}
              className="cm-input"
              value={name}
              maxLength={100}
              autoComplete="off"
              aria-invalid={!!nameError}
              aria-describedby={ids + "hint"}
              onChange={(e) => {
                setName(e.target.value);
                setNameError("");
              }}
            />
            {nameError ? (
              <p className="cm-hint bad" id={ids + "hint"} role="alert">
                <CircleAlert size={16} aria-hidden="true" />
                <span>{nameError}</span>
              </p>
            ) : (
              <p className="cm-hint" id={ids + "hint"}>
                Everyone in the channel sees the new name.
              </p>
            )}
            <div className="cm-rename-acts">
              <button
                type="button"
                className="cm-btn"
                disabled={busy === "name"}
                onClick={stopRenaming}
              >
                Cancel
              </button>
              <Button type="submit" className="cm-go" busy={busy === "name"}>
                Save name
              </Button>
            </div>
          </form>
        ) : (
          <div className="cm-ht">
            <h2 id={ids + "title"} tabIndex={-1}>
              {channel.name}
            </h2>
            <p>{headLine(channel, lists, made)}</p>
          </div>
        )}
        <div className="cm-hacts">
          {runs && !editing && (
            <button
              type="button"
              className="cm-btn cm-rename"
              data-focus="rename"
              onClick={startRenaming}
            >
              <Pencil size={16} aria-hidden="true" />
              Rename
            </button>
          )}
          <button
            type="button"
            className="cm-x"
            aria-label="Close dialog"
            title="Close dialog"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
      </div>
      <div className="cm-body">
        {archived ? (
          <div className="cm-band">
            <Lock size={18} aria-hidden="true" />
            <span>
              <b>This channel is archived.</b> Nobody can be added or removed
              until it is back.
              {!canArchiveChannel(data, channel) &&
                " " + onlyWho(made, "unarchive")}
            </span>
            {canArchiveChannel(data, channel) && (
              <button
                type="button"
                className="cm-btn"
                disabled={busy === "archive"}
                onClick={unarchive}
              >
                {busy === "archive" && <Loader2 className="spin" size={16} />}
                Unarchive
              </button>
            )}
          </div>
        ) : (
          chat && (
            <div>
              <label className="cm-label" htmlFor={ids + "find"}>
                Add people or ducks
              </label>
              <div className="cm-find">
                <Search size={18} aria-hidden="true" />
                <input
                  id={ids + "find"}
                  className="cm-input"
                  type="search"
                  placeholder="Search by name"
                  autoComplete="off"
                  aria-describedby={ids + "note"}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setAdded([]);
                    setAsking(null);
                  }}
                />
              </div>
              <p className="cm-note" id={ids + "note"}>
                <Eye size={16} aria-hidden="true" />
                <span>
                  Anyone you add can read everything said here, from the first
                  message.
                </span>
              </p>
            </div>
          )
        )}
        {searching ? (
          found.people.length || found.ducks.length ? (
            <div className="cm-card">
              {found.people.length > 0 &&
                group("People", null, "", "person", found.people)}
              {found.ducks.length > 0 &&
                group("Ducks", null, "", "duck", found.ducks)}
            </div>
          ) : (
            <p className="cm-none" role="status">
              {found.anyone
                ? "Nobody by that name is left to add."
                : "Everyone at " +
                  data.company.name +
                  " is already in this channel."}
            </p>
          )
        ) : (
          <div className="cm-card">
            {group(
              "People",
              lists.people.length,
              peopleRule(rights, made),
              "person",
              lists.people,
            )}
            {group(
              "Ducks",
              lists.ducks.length,
              duckRule(rights),
              "duck",
              lists.ducks,
              "No ducks in here yet.",
            )}
          </div>
        )}
      </div>
      {!archived && (
        <div className={"cm-foot" + (leaving ? " asking" : "")}>
          {leaving ? (
            <div
              className="cm-leave"
              role="group"
              aria-label={"Leave #" + channel.name + "?"}
              aria-describedby={ids + "gone"}
            >
              <span className="cm-say">
                <b>Leave #{channel.name}?</b>{" "}
                <span id={ids + "gone"}>
                  You won’t see it any more unless someone adds you back.
                </span>
              </span>
              <span className="cm-foot-acts">
                <button
                  type="button"
                  className="cm-btn"
                  data-keep=""
                  disabled={!!busy}
                  onClick={stopAsking}
                >
                  Stay
                </button>
                <button
                  type="button"
                  className="cm-btn cm-stop"
                  disabled={!!busy}
                  onClick={leave}
                >
                  {busy === "leave" ? (
                    <Loader2 className="spin" size={16} />
                  ) : (
                    <LogOut size={16} aria-hidden="true" />
                  )}
                  Leave channel
                </button>
              </span>
            </div>
          ) : (
            <>
              {runs && !editing && (
                <div className="cm-foot-acts cm-phone-rename">
                  <button
                    type="button"
                    className="cm-btn"
                    data-focus="rename"
                    onClick={startRenaming}
                  >
                    <Pencil size={16} aria-hidden="true" />
                    Rename
                  </button>
                </div>
              )}
              {say && <p className="cm-say">{say}</p>}
              {chat && (!alone || runs) && (
                <div className="cm-foot-acts">
                  {!alone && (
                    <button
                      type="button"
                      className="cm-btn cm-warn"
                      data-focus="leave"
                      disabled={!!busy}
                      onClick={() => ask("leave")}
                    >
                      <LogOut size={16} aria-hidden="true" />
                      Leave channel
                    </button>
                  )}
                  {runs && (
                    <button
                      type="button"
                      className="cm-btn cm-warn"
                      data-focus="archive"
                      disabled={!!busy}
                      onClick={() => {
                        // Cancel there comes back here, and closing after
                        // that still returns to whatever opened Members.
                        const opened = back.current;
                        back.current = null;
                        onArchive(opened);
                      }}
                    >
                      <Archive size={16} aria-hidden="true" />
                      Archive channel
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </dialog>
  );
}
