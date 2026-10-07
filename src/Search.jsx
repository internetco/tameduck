import React, { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Columns3,
  CornerDownLeft,
  FileText,
  Hash,
  MessageSquare,
  Search,
  X,
} from "lucide-react";
import { api, Avatar, Button, Modal, flock, fmtDate } from "./ui.jsx";
import { conversationPeer } from "./chat-utils.mjs";
import { excerpt, markParts, statusSays } from "./search.mjs";
import { recentPlaces } from "./recent-places.mjs";
import "./search.css";

// The box ⌘K opens: one field that finds anything in the company, and, when
// nothing in the list is it, hands the same words to Chief Duck.
//
// Every kind of thing has its own shape in the list - a duck wears its face, a
// person their initial, a channel a #, a task and a file their icon, a message
// the place it was said and a piece of what it says - because six kinds in one
// identical row is a list nobody can read at a glance.

// The typed word, marked wherever it appears in a line.
function Marked({ text, word }) {
  return markParts(text, word).map((piece, i) =>
    piece.mark ? (
      <mark className="search-mark" key={i}>
        {piece.text}
      </mark>
    ) : (
      <React.Fragment key={i}>{piece.text}</React.Fragment>
    ),
  );
}

const Tile = ({ icon: Icon }) => (
  <span className="search-tile" aria-hidden="true">
    <Icon size={17} />
  </span>
);

const Key = ({ children }) => <span className="search-key">{children}</span>;

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function SearchView({
  data,
  onClose,
  go,
  openDuck,
  openPerson,
  action,
  here,
}) {
  const [q, setQ] = useState("");
  const [extra, setExtra] = useState([]);
  // The row the arrow keys are on. Enter opens it.
  const [active, setActive] = useState(0);
  const [asking, setAsking] = useState(false);
  // Where this person has been, read once when the box opens so the list does
  // not shuffle under them while they look at it.
  const [places] = useState(() => recentPlaces(data.company.id));
  const boxRef = useRef(null);
  const fieldRef = useRef(null);
  const words = q.trim();
  const needle = words.toLowerCase();
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      if (words.length < 2) {
        setExtra([]);
        return;
      }
      api("/search?q=" + encodeURIComponent(words))
        .then((r) => {
          if (live) setExtra(r);
        })
        .catch(() => {});
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [words]);
  // A new word is a new list, so the arrow keys start at the top of it again.
  useEffect(() => setActive(0), [words]);

  const ducks = flock(data);
  const duckNamed = (id) => data.ducks.find((d) => d.id === id);
  const personNamed = (id) => data.members.find((m) => m.id === id);
  const madeBy = (item) =>
    duckNamed(item.duck_id)?.name ||
    (item.user_id === data.user.id
      ? "You"
      : personNamed(item.user_id)?.name || "");

  // One row per kind of thing, so each kind can say what it is in its own
  // shape. open() is what happens when somebody presses it.
  const duckRow = (duck) => ({
    key: "duck:" + duck.id,
    kind: "Duck",
    face: <Avatar duck={duck} size={32} />,
    title: duck.name,
    // One piece, not two: .search-sub lays its children out in a row, and a
    // bare <mark> beside the rest of the words would be a box of its own with
    // a gap beside it - "Invoice s and reconciliation".
    sub: (
      <span>
        <Marked text={duck.role} word={needle} />
      </span>
    ),
    open: () => openDuck(duck),
  });
  const personRow = (person) => ({
    key: "person:" + person.id,
    kind: "Person",
    face: <Avatar name={person.name} size={32} />,
    title: person.name,
    sub: "Teammate",
    open: () => openPerson(person),
  });
  const channelRow = (channel) => ({
    key: "channel:" + channel.id,
    kind: "Channel",
    face: <Tile icon={Hash} />,
    title: channel.name,
    sub: `${count(channel.members.length, "person", "people")} and ${count(
      ducks.filter((d) => channel.ducks.includes(d.id)).length,
      "duck",
      "ducks",
    )}`,
    open: () => go({ type: "chat", id: channel.id }),
  });
  const taskRow = (task) => ({
    key: "task:" + task.id,
    kind: "Task",
    face: <Tile icon={Columns3} />,
    title: task.title,
    sub: (
      <>
        {duckNamed(task.assignee_id)?.name && (
          <span>{duckNamed(task.assignee_id).name}</span>
        )}
        <span className="search-pill">{statusSays(task.status)}</span>
      </>
    ),
    open: () => go({ type: "tasks", id: task.id }),
  });
  const fileRow = (doc) => ({
    key: "file:" + doc.id,
    kind: "File",
    face: <Tile icon={FileText} />,
    title: doc.title,
    sub: [madeBy(doc), fmtDate(doc.updated)].filter(Boolean).join(" · "),
    open: () => go({ type: "files", id: doc.id }),
  });
  // A message says where it was said and when, and shows the piece of itself
  // that matched. Who said it is not in the answer the server sends back, so
  // the row does not pretend to know.
  const messageRow = (message) => {
    const where = data.conversations.find(
      (c) => c.id === message.conversation_id,
    );
    const duck = where && duckNamed(where.ducks[0]);
    const peer = where && conversationPeer(where, data);
    return {
      key: "message:" + message.id,
      kind: "Message",
      face:
        where?.kind === "group" ? (
          <Tile icon={Hash} />
        ) : where?.kind === "human" && peer ? (
          <Avatar name={peer.name} size={32} />
        ) : duck ? (
          <Avatar duck={duck} size={32} />
        ) : (
          <Tile icon={MessageSquare} />
        ),
      where:
        where?.kind === "group"
          ? "In #" + where.name
          : peer
            ? "With " + peer.name
            : duck
              ? "With " + duck.name
              : "Message",
      when: fmtDate(message.created),
      said: excerpt(message.body, words),
      // Opened where it was said, on the message itself: in its chat, or in
      // its thread when it is a reply. Every hit used to open as a thread of
      // its own, so a message nobody had answered came up as an empty thread
      // ("0 replies") with nothing around it.
      open: () =>
        go({
          type: "chat",
          id: message.conversation_id,
          ...(message.thread_id ? { threadId: message.thread_id } : {}),
          at: message.id,
        }),
    };
  };

  // Six lists joined end to end and cut at thirty. Messages went in last, so
  // a word that matched a few ducks and a hundred tasks threw every message
  // away - and the screen said nothing, because the "nothing found" line only
  // shows when there are none at all. Each kind gets a turn instead, and the
  // list says how much of the answer it is showing.
  const LIMIT = 30;
  const groups = words
    ? [
        ducks
          .filter((x) => (x.name + " " + x.role).toLowerCase().includes(needle))
          .map(duckRow),
        data.members
          .filter(
            (m) =>
              m.id !== data.user.id &&
              (m.name + " " + m.email).toLowerCase().includes(needle),
          )
          .map(personRow),
        data.tasks
          .filter((x) => x.title.toLowerCase().includes(needle))
          .map(taskRow),
        data.documents
          .filter((x) => x.title.toLowerCase().includes(needle))
          .map(fileRow),
        data.conversations
          .filter(
            (x) => x.kind === "group" && x.name.toLowerCase().includes(needle),
          )
          .map(channelRow),
        extra.slice(0, 25).map(messageRow),
      ]
    : [];
  // The server was asked for one more message than we show, so a full page of
  // them means there are older ones this search never saw.
  const moreMessages = extra.length > 25;
  const total = groups.reduce((n, g) => n + g.length, 0);
  // A turn each, round and round, in that order. Grouping them instead put
  // the single message hit under twenty-nine near-identical tasks, where it
  // may as well have been dropped; this way the first rows show every kind
  // that matched at all.
  const found = [];
  for (let i = 0; found.length < LIMIT; i++) {
    const before = found.length;
    for (const g of groups) {
      if (found.length >= LIMIT) break;
      if (g.length > i) found.push(g[i]);
    }
    if (found.length === before) break;
  }
  // Nothing typed: the last few places this person opened, as the same rows.
  // A place that has since been deleted no longer resolves, and drops out, and
  // so does the page they are standing on - offering somebody the page they
  // are already looking at wastes the row.
  const recent = words
    ? []
    : places
        .filter(
          (place) => !(place.type === here?.type && place.id === here?.id),
        )
        .map((place) => {
          if (place.type === "tasks") {
            const task = data.tasks.find((t) => t.id === place.id);
            return task && taskRow(task);
          }
          if (place.type === "files") {
            const doc = data.documents.find((d) => d.id === place.id);
            return doc && fileRow(doc);
          }
          const chat = data.conversations.find((c) => c.id === place.id);
          if (!chat) return null;
          if (chat.kind === "group") return channelRow(chat);
          const peer = conversationPeer(chat, data);
          if (chat.kind === "human")
            return peer && { ...personRow(peer), key: "recent:" + chat.id };
          const duck = ducks.find((d) => chat.ducks.includes(d.id));
          // The chat itself, not a new one: this is where they were.
          return (
            duck && {
              ...duckRow(duck),
              key: "recent:" + chat.id,
              open: () => go({ type: "chat", id: chat.id }),
            }
          );
        })
        .filter(Boolean)
        .slice(0, 5);
  const matches = words ? found : recent;

  const chief = ducks.find((d) => d.chief);
  // The last resort, and only ever last: the same words, handed to the chief
  // of staff. Somebody who cannot send messages here is not offered it.
  const canAsk = !!chief && !!data.permissions.chat && !!words;
  async function ask() {
    if (!canAsk || asking) return;
    setAsking(true);
    const chat = await action(() =>
      api("/conversations/direct", "POST", { duck_id: chief.id }),
    );
    // The box stays open and keeps the words if this does not work, so there
    // is something to try again with rather than an empty screen.
    const sent =
      chat &&
      (await action(() =>
        api("/conversations/" + chat.id + "/messages", "POST", {
          body: words,
          duck_ids: [chief.id],
        }),
      ));
    setAsking(false);
    if (sent) go({ type: "chat", id: chat.id });
  }
  // Everything the arrow keys walk, in the order it is on screen.
  const rows = [...matches, ...(canAsk ? [{ key: "ask", open: ask }] : [])];
  const on = Math.min(active, Math.max(rows.length - 1, 0));
  useEffect(() => {
    boxRef.current
      ?.querySelector(".search-row.on")
      ?.scrollIntoView({ block: "nearest" });
  }, [on]);
  // The keys are heard by the whole box, not only by the field, because
  // somebody who has tabbed into the list should not have to tab back to the
  // field to keep moving. Once the keyboard is on a row the arrows carry it
  // along, so the row that is marked and the row that is ringed are the same
  // one. Enter is the field's alone: a row already opens on its own Enter,
  // and answering it twice would open two things.
  const keys = (e) => {
    const inField = e.target === fieldRef.current;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!rows.length) return;
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : rows.length - 1;
      const next = (Math.min(on, rows.length - 1) + step) % rows.length;
      setActive(next);
      if (!inField)
        boxRef.current
          ?.querySelectorAll(".search-row, .search-ask")
          [next]?.focus();
    } else if (e.key === "Enter" && inField && rows[on]) {
      e.preventDefault();
      // Asking keeps the box open until the message is away; everything else
      // is a page, so the box gets out of the way first.
      if (rows[on].key === "ask") ask();
      else {
        onClose();
        rows[on].open();
      }
    }
  };
  const pick = (row) => {
    if (row.key === "ask") return ask();
    onClose();
    row.open();
  };
  const showing =
    words && matches.length && (matches.length < total || moreMessages)
      ? `Showing ${matches.length} of ${total}${moreMessages ? "+" : ""} matches` +
        (moreMessages ? ", newest messages only" : "") +
        ". Add a word to narrow it down."
      : "";

  // The dialog is called Search; the field inside it says what you can do
  // there. With the same name on both, a screen reader - and anything looking
  // for the field by its label - found two things called the same.
  return (
    <Modal title="" ariaLabel="Search" onClose={onClose}>
      <div className="search-dialog" ref={boxRef} onKeyDown={keys}>
        {/* No title bar: the field below says what this is, in the same words
            the title used, and a dialog cannot be two things at once. */}
        <div className="search-head">
          <Search size={20} aria-hidden="true" />
          <input
            className="search-input"
            ref={fieldRef}
            autoFocus
            aria-label="Search, or ask Chief Duck"
            placeholder="Search, or ask Chief Duck"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button
            type="button"
            className="search-x"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </div>
        {!!matches.length && (
          <div className="search-list">
            {!words && <h3 className="search-group">Recent</h3>}
            {matches.map((row, i) => (
              <button
                type="button"
                key={row.key}
                className={"search-row" + (i === on ? " on" : "")}
                aria-current={i === on ? "true" : undefined}
                onFocus={() => setActive(i)}
                onClick={() => pick(row)}
              >
                {row.face}
                <span className="search-main">
                  {row.said ? (
                    <>
                      <span className="search-who">
                        <b>{row.where}</b> · {row.when}
                      </span>
                      <span className="search-snip">
                        <Marked text={row.said} word={needle} />
                      </span>
                    </>
                  ) : (
                    <span className="search-line">
                      <span className="search-title">
                        <Marked text={row.title} word={needle} />
                      </span>
                      <span className="search-sub">{row.sub}</span>
                    </span>
                  )}
                </span>
                <span
                  className={
                    "search-kind" + (row.kind === "Message" ? " message" : "")
                  }
                >
                  {row.kind}
                  {i === on && (
                    <Key>
                      <CornerDownLeft size={12} />
                    </Key>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
        {!matches.length && canAsk && (
          <div className="search-none">
            <Avatar duck={chief} size={44} />
            <div className="search-none-main">
              <h3>Nothing found for “{words}”</h3>
              <p>{chief.name} can look into it and answer in your chat.</p>
              <Button busy={asking} onClick={ask}>
                Ask {chief.name}
                {!asking && (
                  <Key>
                    <CornerDownLeft size={12} />
                  </Key>
                )}
              </Button>
            </div>
          </div>
        )}
        {!matches.length && !canAsk && (
          <p className="search-hint">
            {words
              ? "Nothing found. Try a different word."
              : "Type to find ducks, people, channels, tasks and files."}
          </p>
        )}
        {!!matches.length && canAsk && (
          <button
            type="button"
            className={"search-ask" + (on === matches.length ? " on" : "")}
            aria-current={on === matches.length ? "true" : undefined}
            disabled={asking}
            onFocus={() => setActive(matches.length)}
            onClick={ask}
          >
            <Avatar duck={chief} size={32} />
            <span className="search-main">
              <span className="search-title">
                Ask {chief.name} about “{words}”
              </span>
              <span className="search-sub">It answers in your chat.</span>
            </span>
            <span className="search-askbtn">
              {asking ? "Asking…" : "Ask"}
              {on === matches.length && !asking && (
                <Key>
                  <CornerDownLeft size={12} />
                </Key>
              )}
            </span>
          </button>
        )}
        {!!matches.length && (
          <div className="search-foot">
            <span className="search-keys">
              <span>
                <Key>
                  <ArrowUp size={12} />
                </Key>
                <Key>
                  <ArrowDown size={12} />
                </Key>
                to move
              </span>
              <span>
                <Key>
                  <CornerDownLeft size={12} />
                </Key>
                to open
              </span>
              <span>
                <Key>esc</Key>
                to close
              </span>
            </span>
            {!!showing && <span className="search-count">{showing}</span>}
          </div>
        )}
      </div>
    </Modal>
  );
}
