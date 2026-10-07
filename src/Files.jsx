import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Archive,
  CheckSquare,
  ChevronLeft,
  Download,
  Folder as FolderIcon,
  Files as FilesIcon,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Search,
  History,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api, Avatar, Button, Empty, flock, Modal } from "./ui.jsx";
import { DocumentEditor } from "./views.jsx";
import { FileViewer } from "./FileViewer.jsx";
import { isCsvFile } from "./csv.mjs";
import { isPreviewable } from "./FilePreview.jsx";
import { conversationName, conversationPeer } from "./chat-utils.mjs";
import { filesReturnRoute } from "./navigation.mjs";
import { atWhen, fmtWhen } from "./when.mjs";
import { fileSize, findFiles, inFileScope, inFolder, kindName, validFolder } from "./files-list.mjs";
import { FileIcon, groupLabels, uploadUrl } from "./file-ui.jsx";
import { FolderBrowser, FolderMoveDialog } from "./FolderBrowser.jsx";

// The page's name, which the top bar says. It used to be written a second time
// as a heading right under it.
export function filesTitle(view, data) {
  const duck = data?.ducks.find((d) => d.id === view.duckId);
  const chat = data?.conversations.find((c) => c.id === view.conversationId);
  return duck
    ? duck.name + "’s files"
    : chat
      ? (chat.kind === "human" ? "Files with " : "Files in ") +
        (chat.kind === "group" ? "# " : "") +
        conversationName(chat, data)
      : "Files";
}
const chatLabel = (c, data) =>
  (c.kind === "group" ? "# " : "") + conversationName(c, data);

export default function FilesView({
  data,
  action,
  notify,
  view,
  go,
  setModal,
  eventVersion,
  topbar,
}) {
  const [items, setItems] = useState(null);
  const [folders, setFolders] = useState([]);
  const [foldersReady, setFoldersReady] = useState(false);
  const [maxBytes, setMaxBytes] = useState(25 * 1000 * 1000);
  const [error, setError] = useState("");
  const [doc, setDoc] = useState(null);
  const [preview, setPreview] = useState(null);
  const [search, setSearch] = useState(view.filters?.q || "");
  // Which menu is open: a file's key, or "add" for the one in the top bar.
  const [menu, setMenu] = useState(null);
  const [card, setCard] = useState(null);
  const [ask, setAsk] = useState(null);
  const [upload, setUpload] = useState(null);
  const [archived, setArchived] = useState(false);
  const [history, setHistory] = useState(null);
  const [move, setMove] = useState(null);
  const historyRequest = useRef(0);
  const picker = useRef(null);
  const list = useRef(null);
  const searchBox = useRef(null);
  const bar = useRef(null);
  const kinds = useRef(null);
  const [narrow, setNarrow] = useState(false);
  // Where the keyboard goes back to when a dialog of this page closes. An open
  // dialog makes the page behind it inert, so this waits until it has gone.
  const returnFocus = useRef(null);
  const [refocus, setRefocus] = useState(0);
  const filters = view.filters || {};
  const folder = filters.folder || "all";
  const duck = data.ducks.find((d) => d.id === view.duckId);
  const chat = data.conversations.find((c) => c.id === view.conversationId);
  const scope = duck
    ? { duckId: duck.id }
    : chat
      ? { conversationId: chat.id }
      : {};
  const backTo =
    chat?.id ||
    (duck &&
      data.conversations.find(
        (c) => c.kind === "direct" && c.ducks.includes(duck.id),
      )?.id);
  const returnTo = filesReturnRoute(view.returnTo, data.company.id);
  // Back is only there when you came from a chat: its Files tab, or a duck's.
  // From the sidebar the sidebar is the way on, as it is on every other page.
  const backChat =
    (duck || chat) && data.conversations.find((c) => c.id === backTo);
  const update = (changes) =>
    go(
      {
        type: "files",
        ...scope,
        filters: { type: filters.type, q: filters.q, folder, ...changes },
        ...(returnTo ? { returnTo: view.returnTo } : {}),
      },
      { replace: true },
    );
  async function load() {
    setFoldersReady(false);
    try {
      const folderQuery = new URLSearchParams();
      if (duck) folderQuery.set("duck_id", duck.id);
      if (chat) folderQuery.set("conversation_id", chat.id);
      const [r, f] = await Promise.all([api("/files"), api("/file-folders" + (folderQuery.toString() ? "?" + folderQuery : ""))]);
      setItems(r.items);
      setFolders(f.folders || []);
      setFoldersReady(true);
      if (r.max_upload_bytes) setMaxBytes(r.max_upload_bytes);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    load();
  }, [eventVersion, duck?.id, chat?.id]);
  useEffect(() => {
    if (foldersReady && !validFolder(folders, folder)) update({ folder: undefined });
  }, [foldersReady, folders, folder]);
  useEffect(() => {
    let live = true;
    setDoc(null);
    if (view.id)
      api("/documents/" + view.id)
        .then((d) => live && setDoc(d))
        .catch((e) => live && notify(e.message));
    return () => {
      live = false;
    };
  }, [view.id]);
  // Typing updates the URL after a pause, so Back does not step through every letter.
  // A kind picked during that pause starts it again, or the search would undo the kind,
  // and so does a document opened from it, or the search would shut the document.
  useEffect(() => {
    if (search === (filters.q || "")) return;
    const t = setTimeout(() => update({ q: search.trim() || undefined }), 350);
    return () => clearTimeout(t);
  }, [search, filters.type, view.id]);
  const scoped = useMemo(
    () =>
      (items || []).filter((item) =>
        inFolder(item, folder) && inFileScope(item, folders, {
          duckId: duck?.id,
          conversationId: chat?.id || (duck ? backTo : undefined),
        }),
      ),
    [items, folders, duck?.id, chat?.id, folder],
  );
  const author = (item) => {
    const d = data.ducks.find((x) => x.id === item.from?.duck_id);
    const u = data.members.find((x) => x.id === item.from?.user_id);
    return item.from?.user_id && u
      ? { name: u.id === data.user.id ? "You" : u.name, person: u.name }
      : d
        ? { duck: d, name: d.name }
        : { name: u?.name || "Teammate" };
  };
  const place = (item) => {
    if (item.grouped && item.places?.length > 1) return "in multiple places";
    if (item.task_ids?.length) {
      const title = data.tasks.find((t) => t.id === item.task_ids[0])?.title;
      return title
        ? title + (/ticket$/i.test(title) ? "" : " ticket")
        : "A ticket";
    }
    const c = data.conversations.find((x) => x.id === item.conversation_ids[0]);
    if (!c) return null;
    const name = chatLabel(c, data);
    // A duck's own chat is named after the duck, so its files said the name twice.
    return name === author(item).name ? null : name;
  };
  // Who shared it, where and when, as one sentence for a dialog.
  const sharedIt = (item) => {
    if (item.grouped && item.places?.length > 1)
      return author(item).name + " shared it in multiple places " + atWhen(item.created) + ".";
    const c = data.conversations.find((x) => x.id === item.conversation_ids[0]);
    const title = data.tasks.find((t) => t.id === item.task_ids?.[0])?.title;
    const where = item.task_ids?.length
      ? title
        ? " on the " + title + (/ticket$/i.test(title) ? "" : " ticket")
        : " on a ticket"
      : c
        ? c.kind === "group"
          ? " in " + chatLabel(c, data)
          : // A duck's own chat, or a teammate's, is named after them.
            conversationName(c, data) !== author(item).name
            ? " in your chat with " + conversationName(c, data)
            : c.kind === "human"
              ? " with you"
              : " in your chat"
        : "";
    return (
      author(item).name +
      " shared it" +
      where +
      " " +
      atWhen(item.created) +
      "."
    );
  };
  const inChat = (c) =>
    c.kind === "group"
      ? "in " + chatLabel(c, data)
      : "with " + conversationName(c, data);
  const { shown, counts, total } = findFiles(scoped, {
    query: search,
    kind: filters.type,
    names: (item) => [author(item).name, author(item).person],
  });
  const visible = shown.filter((item) => !!item.archived === archived);
  const canDelete = (item) =>
    item.kind === "upload" &&
    (item.user_id === data.user.id || data.permissions.company);
  const canManage = (item) => item.kind === "shared_file" && item.can_manage;
  async function setSharedArchived(item, next) {
    const endpoint = item.grouped ? `/shared-file-groups/${item.id}` : `/shared-files/${item.id}`;
    try { await api(`${endpoint}/${next ? "archive" : "restore"}`, "POST"); notify(next ? `${item.name} archived` : `${item.name} restored`); await load(); }
    catch (e) { notify(e.message); }
  }
  async function showHistory(item) {
    const request = ++historyRequest.current;
    const endpoint = item.grouped ? `/shared-file-groups/${item.id}` : `/shared-files/${item.id}`;
    try { setHistory({ item, loading: true }); const result = await api(endpoint); if (request === historyRequest.current) setHistory({ item, ...result }); }
    catch (e) { if (request === historyRequest.current) { notify(e.message); setHistory(null); } }
  }
  // Every chat you could share a file in, in the sidebar's order.
  const chats = data.permissions.chat
    ? [
        ...data.conversations.filter((c) => c.kind === "group" && !c.archived),
        ...flock(data)
          .map((d) =>
            data.conversations.find(
              (c) => c.kind === "direct" && c.ducks.includes(d.id),
            ),
          )
          .filter(Boolean),
        ...data.conversations.filter(
          (c) => c.kind === "human" && conversationPeer(c, data),
        ),
      ]
    : [];
  // A chat's own Files tab uploads into that chat, so an archived channel, or
  // a chat whose teammate has left, offers no Upload rather than another chat.
  const canUpload = chat
    ? chats.some((c) => c.id === chat.id)
    : chats.length > 0;
  const canWrite = !!data.permissions.docs;
  const hasFiles = !!items && scoped.length > 0;
  // The kinds sit beside the search while they fit on its row. Where they
  // would need a second row, on a phone or a laptop or with many kinds, they
  // are one dropdown instead. The search is at least 200px (files.css).
  useLayoutEffect(() => {
    const row = bar.current,
      chips = kinds.current;
    if (!row || !chips) return;
    const fit = () => {
      const cs = getComputedStyle(row);
      const room =
        row.clientWidth -
        parseFloat(cs.paddingLeft) -
        parseFloat(cs.paddingRight) -
        (row.querySelector(".files-views")?.offsetWidth || 0) -
        200 -
        2 * parseFloat(cs.columnGap);
      const gap = parseFloat(getComputedStyle(chips).columnGap) || 0;
      const need = [...chips.children].reduce(
        (sum, chip) => sum + chip.offsetWidth + gap,
        -gap,
      );
      setNarrow(need > room);
    };
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(row);
    watch.observe(chips);
    return () => watch.disconnect();
  }, [hasFiles]);
  // An action picked from a menu goes back to that menu's button.
  const remember = (el = document.activeElement) => {
    returnFocus.current =
      el?.closest?.(".files-menu-at")?.querySelector("[aria-haspopup]") || el;
  };
  const closed = () => setRefocus((n) => n + 1);
  useEffect(() => {
    if (!refocus) return;
    const el = returnFocus.current;
    returnFocus.current = null;
    // A file that is gone takes its row with it; the list is the next best place.
    (el?.isConnected
      ? el
      : list.current?.querySelector(".file-open") || searchBox.current
    )?.focus();
  }, [refocus]);
  // "Keep it" is where the keyboard starts in the question, not the X, and
  // Download (or Open) on the card.
  useEffect(() => {
    if (ask) document.querySelector(".files-ask .button.secondary")?.focus();
  }, [ask?.item.key]);
  useEffect(() => {
    if (card) document.querySelector(".files-card-go")?.focus();
  }, [card?.key]);
  const moreButton = (item) =>
    list.current?.querySelector(
      '[data-key="' + CSS.escape(item.key) + '"] .file-more',
    );
  function open(item) {
    // Shutting the card or the document puts the keyboard back on this row.
    // The file viewer does that itself.
    remember();
    // Scoped pages keep their URL; only unscoped documents get a shareable link.
    // The search goes along, or its pending update would shut the document.
    if (item.kind === "document" && !duck && !chat)
      go({
        type: "files",
        id: item.id,
        filters: { ...filters, q: search.trim() || undefined },
      });
    else if (item.kind === "document")
      api("/documents/" + item.id)
        .then(setDoc)
        .catch((e) => notify(e.message));
    else if (item.kind === "notes") {
      const d = data.ducks.find((x) => x.id === item.id);
      if (d) setModal({ type: "duck", duck: d });
    } else if (item.kind === "screenshot")
      setPreview({ ...item, src: "/api/computer-captures/" + item.id });
    else if (item.group === "image" && item.inline && item.kind !== "shared_file")
      setPreview({ ...item, src: uploadUrl(item.id) });
    else if ((item.kind === "upload" || item.kind === "shared_file") && (isCsvFile(item) || isPreviewable(item)))
      setPreview({ ...item, csv: isCsvFile(item) });
    // A PDF opens for reading in a new tab, as it does in chat.
    else if (item.inline) window.open(uploadUrl(item.current_upload_id || item.id), "_blank", "noopener");
    // Anything else opens a small card whose one button is Download. A click
    // on a Word file or a zip used to download it at once, under a tooltip
    // that said "Open".
    else setCard(item);
  }
  // Delete asks first, in words that say what goes and who loses it.
  function remove(item) {
    remember(
      document.activeElement?.closest(".files-menu-at, dialog")
        ? document.activeElement
        : moreButton(item),
    );
    setAsk({ item, busy: false, error: "" });
  }
  async function confirmRemove() {
    const item = ask.item;
    setAsk({ ...ask, busy: true, error: "" });
    try {
      await api("/uploads/" + item.id, "DELETE");
    } catch (e) {
      setAsk({ item, busy: false, error: e.message });
      return;
    }
    setItems((all) => all.filter((x) => x.key !== item.key));
    setAsk(null);
    setPreview(null);
    notify("Deleted " + item.name);
    closed();
    load();
  }
  function chooseFiles() {
    remember();
    picker.current.value = "";
    picker.current.click();
  }
  function newDocument() {
    remember();
    setDoc({
      title: "",
      content: "",
      ...(chat?.id || (duck && backTo) ? { conversation_id: chat?.id || backTo } : {}),
      ...(folder !== "all" && folder !== "unfiled" ? { folder_id: folder } : {}),
    });
  }
  const startChat =
    [backTo, returnTo?.id].find((id) => chats.some((c) => c.id === id)) ||
    chats[0]?.id;
  const back = backChat && (
    <button
      type="button"
      className="files-back"
      aria-label={"Back to " + chatLabel(backChat, data)}
      title={"Back to " + chatLabel(backChat, data)}
      onClick={() => go({ type: "chat", id: backChat.id })}
    >
      <ChevronLeft size={22} />
    </button>
  );
  const topActions = hasFiles && (canUpload || canWrite) && (
    <span className="files-actions">
      {canUpload && (
        <button
          type="button"
          className={"files-top-btn" + (canWrite ? " files-wide" : "")}
          onClick={chooseFiles}
        >
          <Upload size={16} /> Upload
        </button>
      )}
      {canWrite && (
        <button
          type="button"
          className={"files-top-btn" + (canUpload ? " files-wide" : "")}
          onClick={newDocument}
        >
          <Plus size={16} /> New document
        </button>
      )}
      {canUpload && canWrite && (
        <Menu
          className="files-narrow"
          label="Add"
          open={menu === "add"}
          onOpen={() => setMenu("add")}
          onClose={() => setMenu(null)}
          button={{
            className: "files-top-btn",
            children: (
              <>
                <Plus size={16} /> Add
              </>
            ),
          }}
        >
          <button type="button" role="menuitem" onClick={chooseFiles}>
            <Upload size={16} /> Upload a file
          </button>
          <button type="button" role="menuitem" onClick={newDocument}>
            <Plus size={16} /> New document
          </button>
        </Menu>
      )}
    </span>
  );
  const folderBrowser = (
    <FolderBrowser
      folders={folders}
      folderId={validFolder(folders, folder) ? folder : "all"}
      onSelect={(next) => update({ folder: next === "all" ? undefined : next })}
      onChanged={load}
      scope={{
        ...(duck
          ? {
              duck_id: duck.id,
              ...(backTo ? { conversation_id: backTo } : {}),
              computer: !!data.computers?.items?.some(
                (c) => c.duck_id === duck.id,
              ),
            }
          : {}),
        ...(chat ? { conversation_id: chat.id } : {}),
      }}
      canCreate={!!data.permissions.docs}
      ownerName={(f) =>
        !duck && f.duck_id
          ? data.ducks.find((d) => d.id === f.duck_id)?.name
          : ""
      }
      notify={notify}
    />
  );
  return (
    <div className="page files-page">
      {topbar?.lead && back && createPortal(back, topbar.lead)}
      {topbar?.actions &&
        topActions &&
        createPortal(topActions, topbar.actions)}
      {!hasFiles && folderBrowser}
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = [...e.target.files];
          if (files.length) setUpload({ files, start: startChat });
        }}
      />
      {hasFiles && (
        <div className={"files-bar" + (narrow ? " narrow" : "")} ref={bar}>
          {folderBrowser}
          <div className="files-views" role="group" aria-label="File status">
            <button type="button" className="files-kind" aria-pressed={!archived} onClick={() => setArchived(false)}>Current</button>
            <button type="button" className="files-kind" aria-pressed={archived} onClick={() => setArchived(true)}>Archived</button>
          </div>
          <label className="files-search">
            <span className="files-vh">Find a file</span>
            <Search size={16} aria-hidden="true" />
            <input
              ref={searchBox}
              type="search"
              placeholder="Find a file"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <div
            className="files-kinds"
            role="group"
            aria-label="Kind of file"
            ref={kinds}
          >
            <button
              type="button"
              className="files-kind"
              aria-pressed={!filters.type}
              onClick={() => update({ type: undefined })}
            >
              All <span className="files-n">{total}</span>
            </button>
            {Object.entries(groupLabels)
              .filter(([g]) => counts[g] || filters.type === g)
              .map(([g, label]) => (
                <button
                  key={g}
                  type="button"
                  className="files-kind"
                  aria-pressed={filters.type === g}
                  onClick={() => update({ type: g })}
                >
                  {label} <span className="files-n">{counts[g] || 0}</span>
                </button>
              ))}
          </div>
          <label className="files-kind-select">
            <span className="files-vh">Kind of file</span>
            <select
              value={filters.type || ""}
              onChange={(e) => update({ type: e.target.value || undefined })}
            >
              <option value="">All kinds ({total})</option>
              {Object.entries(groupLabels)
                .filter(([g]) => counts[g] || filters.type === g)
                .map(([g, label]) => (
                  <option key={g} value={g}>
                    {label} ({counts[g] || 0})
                  </option>
                ))}
            </select>
          </label>
        </div>
      )}
      {error && (
        <div className="chat-load-error" role="alert">
          {error}
        </div>
      )}
      {!items && !error ? (
        <div className="inline-loading">
          <Loader2 size={18} className="spin" /> Gathering files
        </div>
      ) : !items ? null : !scoped.length ? (
        <Empty
          icon={FilesIcon}
          title="No files yet"
          action={
            (canUpload || canWrite) && (
              <div className="files-empty-acts">
                {canUpload && (
                  <Button onClick={chooseFiles}>
                    <Upload size={16} /> Upload a file
                  </Button>
                )}
                {canWrite && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={newDocument}
                  >
                    {canUpload ? "or write a document" : "Write a document"}
                  </button>
                )}
              </div>
            )
          }
        >
          {duck
            ? `Files ${duck.name} makes or sees in your chats show up here.`
            : chat
              ? "Files shared in this chat, and documents written in it, show up here."
              : "Files shared in any chat, and documents your ducks write, show up here." +
                (canUpload ? " An upload goes into the chat you pick." : "")}
        </Empty>
      ) : visible.length ? (
        <ul className="files-list" ref={list}>
          {visible.map((item) => {
            const who = author(item);
            const here =
              chat &&
              !item.task_ids?.length &&
              item.conversation_ids[0] === chat.id;
            const where = here ? null : place(item);
            const thumb =
              item.group === "image" &&
              (item.kind === "screenshot" || item.inline)
                ? item.kind === "screenshot"
                  ? "/api/computer-captures/" + item.id
                  : uploadUrl(item.current_upload_id || item.id)
                : null;
            const placements = item.grouped
              ? item.places || []
              : [{ task_id: item.task_ids?.[0], conversation_id: item.conversation_ids?.[0] }];
            const places = [...new Map(placements
              .filter((p) => p.task_id || p.conversation_id)
              .map((p) => [
                p.task_id ? "task:" + p.task_id : "chat:" + p.conversation_id,
                p,
              ])).values()];
            const multipleTickets = places.filter((p) => p.task_id).length > 1;
            const showIns = places.map(({ task_id: taskId, conversation_id: conversationId }) => {
              if (taskId) {
                const title = data.tasks.find((t) => t.id === taskId)?.title;
                return {
                  label: multipleTickets && title ? "Show in " + title : "Show in ticket",
                  icon: CheckSquare,
                  to: { type: "tasks", id: taskId },
                };
              }
              const c = data.conversations.find((x) => x.id === conversationId);
              return c ? {
                label: "Show in " + (c.kind === "group" ? chatLabel(c, data) : "chat with " + conversationName(c, data)),
                icon: MessageSquare,
                to: { type: "chat", id: c.id },
              } : null;
            }).filter(Boolean);
            const download = item.kind === "upload" || item.kind === "shared_file";
            const deletable = canDelete(item);
            const manageable = canManage(item);
            const hasHistory = item.kind === "shared_file";
            const movable = folders.some((f) => f.can_manage) && (
              typeof item.can_move === "boolean" ? item.can_move :
              item.kind === "document" ? canWrite :
              item.kind === "shared_file" ? manageable :
              item.kind === "upload" ? deletable : false
            );
            return (
              <li key={item.key} className="file-row" data-key={item.key}>
                <button
                  type="button"
                  className="file-open"
                  onClick={() => open(item)}
                  title={"Open " + item.name}
                >
                  {thumb ? (
                    <img
                      className="file-thumb"
                      src={thumb}
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <FileIcon item={item} size={19} />
                  )}
                  <span className="file-text">
                    <span className="file-name">{item.name}</span>
                    <span className="file-by">
                      <Avatar
                        duck={who.duck}
                        name={who.person || who.name}
                        size={18}
                      />
                      <span className="file-who">{who.name}</span>
                      {/* A long name is cut short, never the time. */}
                      <span className="file-at">
                        <span className="file-when">
                          <span className="file-sep"> · </span>
                          <time dateTime={item.updated}>
                            {fmtWhen(item.updated)}
                          </time>
                        </span>
                        {where && (
                          <span className="file-where">{" · " + where}</span>
                        )}
                      </span>
                    </span>
                  </span>
                </button>
                {showIns.length || download || deletable || manageable || hasHistory || movable ? (
                  <Menu
                    label={item.name}
                    open={menu === item.key}
                    onOpen={() => setMenu(item.key)}
                    onClose={() => setMenu(null)}
                    button={{
                      className: "file-more",
                      "aria-label": "More for " + item.name,
                      children: <MoreHorizontal size={19} />,
                    }}
                  >
                    {showIns.map((showIn) => (
                      <button
                        key={showIn.to.type + ":" + showIn.to.id}
                        type="button"
                        role="menuitem"
                        onClick={() => go(showIn.to)}
                      >
                        <showIn.icon size={16} /> {showIn.label}
                      </button>
                    ))}
                    {download && (
                      <a
                        role="menuitem"
                        href={item.download_url || uploadUrl(item.id, true)}
                        download
                      >
                        <Download size={16} /> Download
                        <small>{fileSize(item.size)}</small>
                      </a>
                    )}
                    {hasHistory && <>
                      {(showIns.length || download) && <hr />}
                      <button type="button" role="menuitem" onClick={() => showHistory(item)}><History size={16} /> View history</button>
                    </>}
                    {movable && <>
                      {(showIns.length || download || hasHistory) && <hr />}
                      <button type="button" role="menuitem" onClick={() => setMove(item)}><FolderIcon size={16} /> Move to folder…</button>
                    </>}
                    {manageable && <>
                      {(showIns.length || download || hasHistory) && <hr />}
                      <button type="button" role="menuitem" onClick={() => setSharedArchived(item, !item.archived)}>{item.archived ? <RotateCcw size={16} /> : <Archive size={16} />} {item.archived ? "Restore file" : "Archive file"}</button>
                    </>}
                    {deletable && (
                      <>
                        {(showIns.length || download) && <hr />}
                        <button
                          type="button"
                          role="menuitem"
                          className="danger"
                          onClick={() => remove(item)}
                        >
                          <Trash2 size={16} /> Delete file…
                        </button>
                      </>
                    )}
                  </Menu>
                ) : (
                  <span className="file-more-gap" />
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty
          icon={Search}
          title="No files match"
          action={
            <Button
              className="secondary"
              onClick={() => {
                setSearch("");
                update({ type: undefined, q: undefined });
              }}
            >
              Show all files
            </Button>
          }
        >
          Try another word, or the name of whoever shared it.
        </Empty>
      )}
      {preview && (
        <FileViewer
          file={preview}
          who={author(preview)}
          from={preview.from}
          shared={{
            conversationId: preview.grouped ? preview.conversation_id : preview.conversation_ids?.[0],
            taskId: preview.grouped ? preview.task_id : preview.task_ids?.[0],
            messageId: preview.message_id,
            threadId: preview.thread_id,
            created: preview.created,
          }}
          data={data}
          go={go}
          action={action}
          notify={notify}
          deletable={canDelete(preview)}
          gone={!!items && !items.some((item) => item.key === preview.key)}
          // The list first, then the viewer goes, so the file is not seen
          // in the list after it was said to be deleted.
          onDeleted={async () => {
            await load();
            setPreview(null);
          }}
          onClose={() => setPreview(null)}
        />
      )}
      {doc && (
        <DocumentEditor
          key={doc.id || "new"}
          doc={doc}
          data={data}
          action={action}
          onSaved={() => load()}
          onClose={() => {
            setDoc(null);
            if (view.id) go({ type: "files", ...scope, filters });
            closed();
          }}
        />
      )}
      {move && <FolderMoveDialog item={move} folders={folders} ownerName={(f) => f.duck_id ? data.ducks.find((d) => d.id === f.duck_id)?.name : ""} notify={notify} onClose={() => setMove(null)} onMoved={load} />}
      {card && (
        <Modal
          title={card.name}
          ariaLabel={card.name}
          onClose={() => {
            setCard(null);
            closed();
          }}
        >
          <div className="files-dialog">
            <div className="files-card">
              <FileIcon item={card} size={22} />
              <div>
                <strong>
                  {kindName(card)} · {fileSize(card.size)}
                </strong>
                <p>{sharedIt(card)}</p>
              </div>
            </div>
            <div className="modal-actions">
              <a
                className="button files-card-go"
                href={card.download_url || uploadUrl(card.id, true)}
                download
                onClick={() => {
                  setCard(null);
                  closed();
                }}
              >
                <Download size={16} /> Download
              </a>
            </div>
          </div>
        </Modal>
      )}
      {ask && (
        <Modal
          title={
            <span className="files-ask-title">
              <span className="files-warn">
                <AlertTriangle size={16} />
              </span>
              Delete {ask.item.name}?
            </span>
          }
          ariaLabel={"Delete " + ask.item.name + "?"}
          onClose={() => {
            if (ask.busy) return;
            setAsk(null);
            closed();
          }}
        >
          <div className="files-dialog files-ask">
            <p>
              {sharedIt(ask.item)} Deleting it takes it away from{" "}
              {ask.item.task_ids?.length
                ? "that ticket"
                : "everyone in that chat"}
              , and it cannot be brought back.
            </p>
            {ask.error && (
              <p className="files-error" role="alert">
                {ask.error}
              </p>
            )}
            <div className="modal-actions">
              <Button
                className="secondary"
                disabled={ask.busy}
                onClick={() => {
                  setAsk(null);
                  closed();
                }}
              >
                Keep it
              </Button>
              <Button
                className="files-kill"
                busy={ask.busy}
                onClick={confirmRemove}
              >
                {!ask.busy && <Trash2 size={16} />} Delete file
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {history && (
        <Modal title={"History · " + history.item.name} ariaLabel={"History for " + history.item.name} onClose={() => { historyRequest.current++; setHistory(null); }}>
          <div className="files-dialog files-history">
            {history.loading ? <p>Loading history…</p> : <>
              <p>Earlier versions of this file are kept here.</p>
              <ul>
                {(history.versions || []).map((version) => <li key={version.id}>
                  <span><strong>{version.name}</strong><small>{fmtWhen(version.created)} · {fileSize(version.size)}</small></span>
                  <a className="button secondary" href={version.download_url} download><Download size={15} /> Download</a>
                </li>)}
              </ul>
            </>}
          </div>
        </Modal>
      )}
      {upload && (
        <UploadDialog
          files={upload.files}
          start={upload.start}
          chats={chats}
          data={data}
          maxBytes={maxBytes}
          folderId={folder !== "all" && folder !== "unfiled" ? folder : null}
          onClose={() => {
            setUpload(null);
            closed();
          }}
          onDone={(to, names) => {
            setUpload(null);
            notify(
              (names.length === 1 ? names[0] : names.length + " files") +
                " shared " +
                inChat(chats.find((c) => c.id === to)),
            );
            load();
            closed();
          }}
        />
      )}
    </div>
  );
}

// A button that opens a short list of actions. The first action takes the
// keyboard, the arrow keys move between them, and Escape shuts the list and
// puts you back on the button.
function Menu({
  label,
  open,
  onOpen,
  onClose,
  button,
  className = "",
  children,
}) {
  const opener = useRef(null);
  const box = useRef(null);
  const [up, setUp] = useState(false);
  const entries = () => [
    ...(box.current?.querySelectorAll('[role="menuitem"]') || []),
  ];
  useLayoutEffect(() => {
    if (!open) return setUp(false);
    // Near the bottom of the window it opens upwards, not under the edge.
    const below = box.current.getBoundingClientRect();
    const room = opener.current.getBoundingClientRect().top;
    setUp(below.bottom > window.innerHeight - 8 && room > below.height + 8);
    entries()[0]?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e) => {
      if (
        !box.current?.contains(e.target) &&
        !opener.current?.contains(e.target)
      )
        onClose();
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const keys = (e) => {
    const all = entries();
    const at = all.indexOf(document.activeElement);
    const to = (i) => {
      e.preventDefault();
      all[(i + all.length) % all.length]?.focus();
    };
    if (e.key === "ArrowDown") to(at + 1);
    else if (e.key === "ArrowUp") to(at - 1);
    else if (e.key === "Home") to(0);
    else if (e.key === "End") to(all.length - 1);
    else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      opener.current?.focus();
    } else if (e.key === "Tab") onClose();
  };
  return (
    <span className={"files-menu-at " + className}>
      <button
        ref={opener}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        {...button}
        onClick={() => (open ? onClose() : onOpen())}
      />
      {open && (
        <div
          ref={box}
          role="menu"
          aria-label={label}
          className={"files-menu" + (up ? " up" : "")}
          onKeyDown={keys}
          onClick={(e) => {
            if (!e.target.closest('[role="menuitem"]')) return;
            onClose();
            // Whatever it opened takes the keyboard from here.
            opener.current?.focus();
          }}
        >
          {children}
        </div>
      )}
    </span>
  );
}

// One file, sent the way the paperclip sends it, with how far it has got.
function send(file, chatId, folderId, onProgress, transfer) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    transfer.current = xhr;
    xhr.open("POST", "/api/conversations/" + chatId + "/uploads");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-TameDuck", "1");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    if (folderId) xhr.setRequestHeader("X-Folder-Id", folderId);
    xhr.upload.onprogress = (e) =>
      e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status === 200) resolve(body);
      else
        reject(
          new Error(
            body.error ||
              (xhr.status === 413
                ? "This file is too large to upload."
                : "The upload failed. Try again."),
          ),
        );
    };
    xhr.onerror = () =>
      reject(
        new Error("The upload failed. Check your connection and try again."),
      );
    xhr.onabort = () => reject(new Error("The upload was stopped."));
    xhr.send(file);
  });
}

// Upload always goes into a chat: a file that is in no message never shows on
// this page, and the people in that chat are the ones who can open it. These
// are the paperclip's own two steps, and no duck is asked anything.
function UploadDialog({
  files: picked,
  start,
  chats,
  data,
  maxBytes,
  folderId,
  onClose,
  onDone,
}) {
  const [files, setFiles] = useState(() => picked.slice(0, 10));
  const [to, setTo] = useState(start || "");
  // "sending" while the files go up, which Cancel can stop; "sharing" once the
  // message that puts them in the chat is on its way, which nothing can.
  const [phase, setPhase] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const transfer = useRef(null);
  const gone = useRef(false);
  const where = useRef(null);
  const id = useId();
  const problem = (f) =>
    f.size > maxBytes
      ? "too large: files can be up to " + fileSize(maxBytes)
      : !f.size
        ? "this file is empty"
        : "";
  const blocked = files.filter(problem);
  // The choice to make is where it goes, so the keyboard starts there.
  useEffect(() => where.current?.focus(), []);
  // Leaving the page stops an upload, the same as Cancel does.
  useEffect(
    () => () => {
      gone.current = true;
      transfer.current?.abort();
    },
    [],
  );
  function stop() {
    gone.current = true;
    transfer.current?.abort();
    onClose();
  }
  async function share() {
    setPhase("sending");
    setError("");
    const sent = [];
    // Files that went up but are in no message wait unseen; take them back.
    const drop = () =>
      sent.forEach((u) => api("/uploads/" + u, "DELETE").catch(() => {}));
    try {
      for (let i = 0; i < files.length && !gone.current; i++) {
        const row = await send(
          files[i],
          to,
          folderId,
          (part) => setProgress((i + part) / files.length),
          transfer,
        );
        sent.push(row.id);
      }
    } catch (e) {
      drop();
      if (gone.current) return;
      setError(e.message);
      setPhase("");
      setProgress(0);
      return;
    }
    // Cancelled, or the page was left, after the last file went up.
    if (gone.current) return drop();
    setPhase("sharing");
    try {
      await api("/conversations/" + to + "/messages", "POST", {
        body: "",
        upload_ids: sent,
        duck_ids: [],
      });
    } catch (e) {
      // A refusal shares nothing. With no answer at all, the message may be in
      // the chat already, holding these files, so they stay.
      if (e.status) drop();
      if (gone.current) return;
      const c = chats.find((x) => x.id === to);
      setError(
        e.status
          ? e.message
          : "We could not tell whether it was shared. Look in " +
              (c.kind === "group"
                ? chatLabel(c, data)
                : "your chat with " + conversationName(c, data)) +
              " before you try again.",
      );
      setPhase("");
      setProgress(0);
      return;
    }
    onDone(
      to,
      files.map((f) => f.name),
    );
  }
  const title =
    files.length === 1 ? "Upload a file" : "Upload " + files.length + " files";
  return (
    <Modal
      title={title}
      ariaLabel={title}
      // While it uploads, only Cancel stops it: a tap beside the dialog or
      // Escape used to drop the upload without a word, or not stop it at all.
      onClose={() => !phase && stop()}
    >
      <div className="files-dialog">
        <ul className="files-picked">
          {files.map((f, i) => (
            <li key={f.name + i} className={problem(f) ? "cannot" : undefined}>
              <span>
                <strong>{f.name}</strong>
                <small id={id + "-file-" + i}>
                  {fileSize(f.size)}
                  {problem(f) ? " · " + problem(f) : ""}
                </small>
              </span>
              {files.length > 1 && !phase && (
                <button
                  type="button"
                  className="files-drop"
                  aria-label={"Remove " + f.name}
                  title={"Remove " + f.name}
                  onClick={() => {
                    setFiles(files.filter((x) => x !== f));
                    where.current?.focus();
                  }}
                >
                  <X size={16} />
                </button>
              )}
            </li>
          ))}
        </ul>
        {picked.length > 10 && (
          <p className="files-note">
            Only the first 10 go in one upload. Upload the rest after.
          </p>
        )}
        <div className="files-to">
          <label htmlFor={id}>Share it in</label>
          <select
            ref={where}
            id={id}
            aria-describedby={id + "-hint"}
            value={to}
            disabled={!!phase}
            onChange={(e) => setTo(e.target.value)}
          >
            {[
              ["Channels", chats.filter((c) => c.kind === "group")],
              ["Direct messages", chats.filter((c) => c.kind !== "group")],
            ]
              .filter(([, some]) => some.length)
              .map(([heading, some]) => (
                <optgroup key={heading} label={heading}>
                  {some.map((c) => (
                    <option key={c.id} value={c.id}>
                      {chatLabel(c, data)}
                    </option>
                  ))}
                </optgroup>
              ))}
          </select>
          <p id={id + "-hint"} className="files-note">
            Everyone in that chat can open it.
          </p>
        </div>
        <p className="files-note" role="status">
          {phase === "sending"
            ? "Uploading… " + Math.round(progress * 100) + "%"
            : phase === "sharing"
              ? "Sharing…"
              : ""}
        </p>
        {error && (
          <p className="files-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <Button
            className="secondary"
            disabled={phase === "sharing"}
            onClick={stop}
          >
            Cancel
          </Button>
          <Button
            busy={!!phase}
            disabled={!to || blocked.length > 0}
            aria-describedby={
              blocked.map((f) => id + "-file-" + files.indexOf(f)).join(" ") ||
              undefined
            }
            onClick={share}
          >
            {!phase && <Upload size={16} />} Upload
          </Button>
        </div>
      </div>
    </Modal>
  );
}
