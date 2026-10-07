import { avatarFor, avatarImage } from "../shared/avatars.mjs";
import { hereHeaders } from "./presence.mjs";
import React, { useEffect, useRef, useState, useId } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CsvSheet } from "./CsvSheet.jsx";
import { X, Loader2, Check, Copy, ArrowUpRight } from "lucide-react";
export async function api(path, method = "GET", body) {
  const r = await fetch("/api" + path, {
    method,
    // hereHeaders() says the person is here, on the requests the app makes
    // anyway, when the tab is showing and has been used lately. See
    // src/presence.mjs for why it is not a request of its own.
    headers: {
      "Content-Type": "application/json",
      "X-TameDuck": "1",
      ...hereHeaders(),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).catch(() => {
    // Offline, or the server out of reach. The browser's own words for that
    // are "Failed to fetch", and they were shown to people as they were. The
    // strip at the top of the page knows it by offline.
    throw Object.assign(
      new Error("Could not reach TameDuck. Check your connection."),
      { offline: true },
    );
  });
  const data = await r
    .json()
    .catch(() => ({ error: "The server did not respond. Try again." }));
  if (!r.ok)
    throw Object.assign(new Error(data.error || "Something went wrong."), {
      status: r.status,
      request_id: data.request_id,
    });
  return data;
}
export function IconButton({ icon: Icon, label, ...props }) {
  return (
    <button
      type="button"
      className="icon-button"
      title={label}
      aria-label={label}
      {...props}
    >
      <Icon size={19} />
    </button>
  );
}
// The ducks this company has, for every list, picker and count.
//
// The payload carries every duck the company has ever had, removed ones
// included, because a message written two years ago still has to render the
// right face and the right name. So the screens filter, and they filter here,
// once, by name - a list that forgets shows a duck that should not be offered
// work, which somebody notices straight away, and that is the failure worth
// having.
export const flock = (data) => (data.ducks || []).filter((d) => !d.removed);
export const offTheTeam = (data) => (data.ducks || []).filter((d) => d.removed);
// Ducks stopped on a screen, waiting for this person to do something. The Needs
// you page counted these; the sidebar number and the dot beside it did not, so a
// duck could be holding a screen open for a code while the nav said there was
// nothing to do, and the page it linked to said there was one thing. It lives
// here so the two cannot drift apart again.
//
// A screen this person took themselves is not a duck waiting on them: nothing
// asked. It was counted anyway, so taking control put a 1 on Needs you and a
// "10 min left" clock on a deadline they did not have, while the banner beside
// it rightly said only "You have a duck's screen open". The banner is how they
// get back to it.
export const waitingOnYou = (data) =>
  (data?.human_requests || []).filter(
    (r) =>
      r.kind !== "takeover" &&
      ["pending", "preparing", "desktop", "submitting"].includes(r.status) &&
      r.expires > Date.now(),
  );
export function Avatar({ duck, name, size = 38 }) {
  const avatar = duck && avatarFor(duck);
  return (
    <span
      className={"avatar " + (!duck ? "human" : "")}
      style={{
        width: size,
        height: size,
        minWidth: size,
        background: duck?.color || undefined,
        fontSize: size > 50 ? 32 : size < 32 ? 17 : 23,
      }}
      aria-hidden="true"
    >
      {avatar ? (
        <img
          src={avatarImage(avatar)}
          srcSet={`${avatarImage(avatar)} 1x, ${avatarImage(avatar, 256)} 2x`}
          width={size}
          height={size}
          alt=""
          decoding="async"
        />
      ) : (
        duck?.emoji || name?.slice(0, 1).toUpperCase() || "🦆"
      )}
    </span>
  );
}
// Escape and a click on the backdrop close a dialog, which is right until the
// dialog is holding something somebody typed. A dialog that has unsaved work
// passes closeGuard, and it decides.
// Whether anything is open. Dialogs live in a dozen different components, some
// in App's own state and most in their own, so "is a dialog on screen" is not a
// question any one of them could answer. Search used to replace whatever was
// open, and a dialog swapped out that way never runs its own close, so the
// warning about unsaved work never fired and a half-written ticket went with it.
const openDialogs = new Set();
export const anyDialogOpen = () => openDialogs.size > 0;
// A page holding typed work nobody has saved yet. Going to another page, or
// closing the tab, asks first - the way a dialog does. Settings > Company used
// to drop up to 60,000 characters of company rules without a word when
// somebody clicked another tab before scrolling down to its Save button.
const unsaved = new Set();
export function useUnsavedGuard(hasUnsaved) {
  const latest = useRef(hasUnsaved);
  latest.current = hasUnsaved;
  useEffect(() => {
    const check = () => latest.current();
    const warn = (e) => {
      if (!check()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    unsaved.add(check);
    window.addEventListener("beforeunload", warn);
    return () => {
      unsaved.delete(check);
      window.removeEventListener("beforeunload", warn);
    };
  }, []);
}
export const mayLeave = () =>
  ![...unsaved].some((check) => check()) ||
  window.confirm(
    "Leave without saving? What you have typed here will be lost.",
  );
// For something that covers the window the way a dialog does without being
// one: a duck's screen held full window. Search opened over it and led away,
// leaving the duck paused behind a page nobody could see.
export function useCountsAsDialog(open) {
  useEffect(() => {
    if (!open) return;
    const token = {};
    openDialogs.add(token);
    return () => openDialogs.delete(token);
  }, [open]);
}
// A message that has to be seen over a dialog. A modal <dialog> lives in the
// browser's top layer, where no z-index on the page can reach it, so a toast
// explaining why a save was refused was painted behind the very dialog that
// refused it - and on a phone, where the dialog fills the screen, it could not
// be seen at all. A popover is in that same top layer. The attribute is set
// here rather than in the markup so a browser without the API never gets it:
// an unsupported [popover] is display:none, which would hide the message
// completely.
export function Toast({ children }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.showPopover !== "function") return;
    el.setAttribute("popover", "manual");
    try {
      el.showPopover();
    } catch {
      el.removeAttribute("popover");
      return;
    }
    return () => {
      try {
        el.hidePopover();
      } catch {}
      el.removeAttribute("popover");
    };
  }, []);
  return (
    <div className="toast" role="status" ref={ref}>
      {children}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  // The whole window, for a file opened for a look (src/FileViewer.jsx).
  full = false,
  // A head of the dialog's own in place of the title and its close button:
  // a function given the close that closeGuard and warnUnsaved still guard.
  head,
  className = "",
  closeGuard,
  ariaLabel,
  // The id of what says more about it, read out after its name.
  describedBy,
  // For a dialog whose form is uncontrolled and has no state to compare: it
  // notices anything typed inside it and asks before throwing that away.
  warnUnsaved = false,
}) {
  const ref = useRef();
  const typed = useRef(false);
  const guard = useRef(closeGuard);
  guard.current = closeGuard;
  const close = () => {
    if (guard.current && !guard.current()) return;
    if (
      warnUnsaved &&
      typed.current &&
      !window.confirm(
        "Close without saving? What you have written here will be lost.",
      )
    )
      return;
    onClose();
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const token = {};
    openDialogs.add(token);
    return () => openDialogs.delete(token);
  }, []);
  useEffect(() => {
    ref.current.showModal();
    const handler = (e) => {
      e.preventDefault();
      closeRef.current();
    };
    ref.current.addEventListener("cancel", handler);
    const noteTyping = () => {
      typed.current = true;
    };
    ref.current.addEventListener("input", noteTyping);
    const dialog = ref.current;
    return () => {
      dialog?.removeEventListener("cancel", handler);
      dialog?.removeEventListener("input", noteTyping);
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={
        "modal " +
        (wide ? "wide" : "") +
        (full ? " full" : "") +
        " " +
        className
      }
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      onClick={(e) => {
        // The second click of a double-click that opened the dialog lands
        // beside it, and used to shut it again at once.
        if (e.target === ref.current && e.detail < 2) close();
      }}
    >
      <div className="modal-head">
        {head ? (
          head(close)
        ) : (
          <>
            <h2>{title}</h2>
            <IconButton icon={X} label="Close dialog" onClick={close} />
          </>
        )}
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
export function Field({ label, hint, children }) {
  const id = useId();
  const native =
    React.isValidElement(children) &&
    ["input", "select", "textarea"].includes(children.type);
  return (
    <div
      className="field"
      role={native ? undefined : "group"}
      aria-labelledby={native ? undefined : id + "-label"}
    >
      <label id={id + "-label"} htmlFor={native ? id : undefined}>
        {label}
      </label>
      {native
        ? React.cloneElement(children, {
            id,
            "aria-describedby": hint ? id + "-hint" : undefined,
          })
        : children}
      {hint && <small id={id + "-hint"}>{hint}</small>}
    </div>
  );
}
export function Button({ busy, children, className = "", ...props }) {
  return (
    <button
      className={"button " + className}
      {...props}
      // After the spread, not before it. A later spread wins every key it
      // carries, so any caller that passed disabled of its own threw this away
      // and the button stayed live for the whole time it showed its spinner.
      // Fifteen of them do, including both takeover buttons, "Start computer",
      // "Post update" and the billing button - so a second press posted the
      // comment twice, or opened a second checkout, or told somebody the
      // desktop was still preparing while the takeover they started was in
      // fact working.
      disabled={busy || props.disabled}
    >
      {busy && <Loader2 className="spin" size={16} />} {children}
    </button>
  );
}
// `as` is the title's level. On a settings page it is h3, under the page's
// own title.
export function Empty({
  icon: Icon,
  title,
  children,
  action,
  as: Title = "h2",
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        {Icon ? <Icon size={28} /> : <span>🦆</span>}
      </div>
      <Title>{title}</Title>
      <p>{children}</p>
      {action}
    </div>
  );
}
// Somebody who presses Shift+Enter in the message box means a new line, and
// every chat they have ever used agrees with them. Markdown does not: a single
// newline inside a paragraph is just a space, so a message typed on four lines
// arrived as one long one and the shape the person gave it was gone. This turns
// those soft line endings into real breaks. Blank lines between paragraphs,
// lists, headings and code blocks are untouched, because those are separate
// nodes and this only ever looks inside the text of one.
const softBreaks = () => (tree) => {
  const walk = (node) => {
    if (!node.children) return;
    const out = [];
    for (const child of node.children) {
      if (child.type === "text" && child.value.includes("\n")) {
        child.value.split("\n").forEach((line, i) => {
          if (i) out.push({ type: "break" });
          if (line) out.push({ type: "text", value: line });
        });
      } else {
        walk(child);
        out.push(child);
      }
    }
    node.children = out;
  };
  walk(tree);
  return tree;
};
const markdownRemarkPlugins = [remarkGfm, softBreaks];

function MarkdownPre({ node, children, ...props }) {
  const code = node.children?.find((child) => child.tagName === "code");
  const language = code?.properties?.className?.find((name) =>
    /^language-(csv|tsv)$/.test(name),
  );
  if (language) {
    const source =
      code.children?.map((child) => child.value || "").join("") || "";
    return (
      <CsvSheet
        source={source}
        delimiter={language === "language-tsv" ? "\t" : ","}
      />
    );
  }
  return <pre {...props}>{children}</pre>;
}

function MarkdownLink({ node, ...props }) {
  return <a {...props} target="_blank" rel="noreferrer noopener" />;
}

function MarkdownImage({ src, alt }) {
  return /^\/api\/computer-captures\/[a-f0-9-]{36}$/.test(src || "") ? (
    <a
      href={src}
      target="_blank"
      rel="noreferrer noopener"
      className="chat-screenshot"
    >
      <img src={src} alt={alt || "Saved desktop screenshot"} loading="lazy" />
      <span>{alt || "Saved desktop screenshot"} · Open full size</span>
    </a>
  ) : (
    <span>[Image: {alt || "attachment"}]</span>
  );
}

const markdownComponents = {
  pre: MarkdownPre,
  a: MarkdownLink,
  img: MarkdownImage,
};

export function Markdown({ children }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins}
        components={markdownComponents}
      >
        {children || ""}
      </ReactMarkdown>
    </div>
  );
}
export function CopyButton({ value, label = "Copy link", className = "" }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      className={"secondary " + className}
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          window.prompt("Copy this value", value);
        }
      }}
    >
      {copied ? <Check size={16} /> : <Copy size={16} />}{" "}
      {copied ? "Copied" : label}
    </Button>
  );
}
export const fmtTime = (s) =>
  new Date(s).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
export const fmtDate = (s) =>
  new Date(s).toLocaleDateString([], { day: "numeric", month: "short" });
// Day-aware times and plurals, in src/when.mjs so they can be tested alone.
export { atWhen, fmtWhen, plural } from "./when.mjs";
// `note` puts a word beside a duck, like Not on key in a connection's list,
// read out with its name.
export function DuckPicker({ ducks, value, onChange, note }) {
  return (
    <div className="check-list">
      {ducks.map((d) => (
        <label key={d.id}>
          <input
            type="checkbox"
            checked={value.includes(d.id)}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? [...value, d.id]
                  : value.filter((x) => x !== d.id),
              )
            }
          />
          <Avatar duck={d} size={30} />
          {note?.(d) ? (
            <span className="check-list-noted">
              <span>
                {d.name}
                <small>{d.role}</small>
              </span>
              <span className="pill warning">{note(d)}</span>
            </span>
          ) : (
            <span>
              {d.name}
              <small>{d.role}</small>
            </span>
          )}
        </label>
      ))}
    </div>
  );
}

// The logo: a lowercase t that is also a duck. Three forms, and the ground it
// sits on picks which:
//   default   the yellow tile. Right on anything that is not brand yellow.
//   onDark    the bare mark, white with a yellow bill, for beside the wordmark
//             on the dark top bar, where a tile would be a yellow square.
//   onYellow  the inverse tile, ink with a yellow t, for the sign-in pages,
//             which are brand yellow edge to edge - there the yellow tile
//             simply disappears and leaves a t with no box.
// They live in /public/brand, and this is the only place that knows their names.
export function BrandMark({ onDark = false, onYellow = false, size }) {
  const src = onDark
    ? "/brand/mark-on-dark.svg"
    : onYellow
      ? "/brand/mark-on-yellow.svg"
      : "/brand/mark.svg";
  return (
    <img
      className={"brand-img" + (onDark ? " brand-img-on-dark" : "")}
      src={src}
      alt=""
      decoding="async"
      draggable="false"
      style={size ? { width: size, height: size } : undefined}
    />
  );
}
