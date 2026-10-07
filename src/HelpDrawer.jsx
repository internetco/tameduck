import React, { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleHelp,
  Columns3,
  ExternalLink,
  Files,
  Inbox,
  Lightbulb,
  Mail,
  MessageSquare,
  Monitor,
  Webhook,
  Plug,
  Search,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import {
  guideForView,
  highlight,
  richText,
  searchHelp,
  shotLayout,
} from "../shared/help-guides.mjs";
import "./HelpDrawer.css";

// The guides themselves are public/help/guides.json, the same file the Help
// pages are built from. Each guide wears the icon of its place in the sidebar.
const ICONS = {
  plug: Plug,
  duck: UserPlus,
  chat: MessageSquare,
  inbox: Inbox,
  board: Columns3,
  files: Files,
  monitor: Monitor,
  webhook: Webhook,
  users: Users,
};
const CONTACT = "info@tameduck.com";
const label = (step) => step.nav || step.title;
const pageOf = (guide, step) =>
  "/help/" + guide.id + (step != null ? "#step-" + (step + 1) : "");

function Marked({ text, terms }) {
  return highlight(text, terms).map((part, i) =>
    part.hit ? <mark key={i}>{part.text}</mark> : <React.Fragment key={i}>{part.text}</React.Fragment>,
  );
}

/** Guide text: **bold**, [[a control]], and links that stay in the panel. */
function Rich({ text, onLink }) {
  return richText(text).map((p, i) => {
    if (p.kind === "strong") return <strong key={i}>{p.text}</strong>;
    if (p.kind === "ui") return <b key={i} className="help-ui">{p.text}</b>;
    if (p.kind === "link")
      return (
        <a key={i} href={p.href} onClick={(e) => onLink(e, p.href)}>
          {p.text}
        </a>
      );
    return <React.Fragment key={i}>{p.text}</React.Fragment>;
  });
}

function Shot({ image }) {
  // The panel is narrow: of a wide screen it shows the part around the rings.
  const shot = shotLayout(image, { focus: image.width > 700 });
  const { width, left, top } = shot.picture;
  return (
    <figure className="help-shot">
      <a
        className={"help-shot-frame" + (shot.cropped ? " is-cropped" : "")}
        style={{ aspectRatio: shot.ratio }}
        href={image.src}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Open the screenshot at full size"
      >
        <img
          src={image.src}
          alt={image.alt}
          width={image.width}
          height={image.height}
          style={shot.cropped ? { width: width + "%", left: left + "%", top: top + "%" } : undefined}
        />
        {shot.marks.map((m) => (
          <React.Fragment key={m.n}>
            <span
              className="help-mark"
              style={{ left: m.ring.left + "%", top: m.ring.top + "%", width: m.ring.width + "%", height: m.ring.height + "%" }}
            />
            {shot.numbered && (
              <span className={"help-mark-num at-" + m.side} style={{ left: m.badge.left + "%", top: m.badge.top + "%" }}>
                {m.n}
              </span>
            )}
          </React.Fragment>
        ))}
      </a>
      <figcaption>
        {shot.numbered
          ? shot.marks.map((m) => (
              <span className="help-legend" key={m.n}>
                <span className="help-mark-num">{m.n}</span>
                {m.label}
              </span>
            ))
          : image.caption}
      </figcaption>
    </figure>
  );
}

export default function HelpDrawer({ open, onClose, triggerRef, view }) {
  const [guides, setGuides] = useState([]);
  const [status, setStatus] = useState("idle");
  const [query, setQuery] = useState("");
  // The guide being read inside the panel, and the step that is open in it.
  const [reading, setReading] = useState(null);
  const [step, setStep] = useState(0);
  const [earlier, setEarlier] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const controllerRef = useRef(null);
  const startedRef = useRef(false);
  const searchRef = useRef(null);
  const bodyRef = useRef(null);
  const screenRef = useRef(null);

  useEffect(() => {
    if (!open || (startedRef.current && !controllerRef.current?.signal.aborted)) return undefined;
    startedRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    setStatus("loading");
    fetch("/help/guides.json", { cache: "no-store", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Help guides could not be loaded");
        return response.json();
      })
      .then((items) => {
        if (!Array.isArray(items)) throw new Error("Invalid help guide list");
        setGuides(items.filter((item) => item?.id && item.title && Array.isArray(item.steps)));
        setStatus("ready");
      })
      .catch((error) => {
        if (error.name !== "AbortError") setStatus("error");
      });
  }, [open]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const here = guideForView(view);
  useEffect(() => {
    if (!open) return;
    // Back on another screen, the panel starts again from that screen's
    // guide; on the same one it is where it was left.
    if (screenRef.current !== null && screenRef.current !== here) {
      setReading(null);
      setQuery("");
    }
    screenRef.current = here;
    // A pointer-and-keyboard screen gets the search box straight away; on a
    // phone that would throw up the keyboard over the panel.
    if (!reading && window.matchMedia("(pointer: fine)").matches)
      requestAnimationFrame(() => searchRef.current?.focus());
  }, [open, here]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeAndRestoreFocus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose, triggerRef]);

  const closeAndRestoreFocus = () => {
    onClose();
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const read = (guide, at = 0) => {
    setReading(guide.id);
    setStep(at);
    setEarlier(false);
    setFeedback(null);
    requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: 0 }));
  };
  const back = () => {
    setReading(null);
    requestAnimationFrame(() => searchRef.current?.focus());
  };
  // Links in guide text open the guide here, not a new tab.
  const follow = (event, href) => {
    const m = href.match(/^(?:\/help\/([a-z-]+))?(?:#step-(\d+))?$/);
    const guide = m && guides.find((g) => g.id === (m[1] || reading));
    if (!guide) return;
    event.preventDefault();
    read(guide, m[2] ? Number(m[2]) - 1 : 0);
  };

  const guide = guides.find((g) => g.id === reading);
  const hereGuide = guides.find((g) => g.id === here);
  const found = query.trim() ? searchHelp(guides, query) : null;

  const row = (g, mark) => (
    <li key={g.id}>
      <button type="button" className="help-drawer-row" onClick={() => read(g)}>
        {mark}
        <span>{g.title}</span>
        <ChevronRight size={15} aria-hidden="true" />
      </button>
    </li>
  );
  const iconOf = (g) => {
    const Icon = ICONS[g.icon] || BookOpen;
    return <Icon size={18} aria-hidden="true" className="help-drawer-row-icon" />;
  };

  const list = (
    <>
      <div className="help-drawer-head">
        <CircleHelp size={20} aria-hidden="true" className="help-drawer-mark" />
        <h2 id="help-drawer-title">Help</h2>
        <a
          className="help-drawer-icon"
          href="/help"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open the Help center in a new tab"
          title="Help center"
        >
          <ExternalLink size={17} />
        </a>
        <button className="help-drawer-icon" type="button" onClick={closeAndRestoreFocus} aria-label="Close Help">
          <X size={18} />
        </button>
      </div>
      <label className="help-drawer-search">
        <Search size={16} aria-hidden="true" />
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search help, like “add a ticket”"
          aria-label="Search help"
        />
      </label>
      <div className="help-drawer-body" ref={bodyRef} aria-live="polite">
        {status === "loading" && <p className="help-drawer-message">Loading guides…</p>}
        {status === "error" && (
          <p className="help-drawer-message">
            Guides can’t be loaded right now. The{" "}
            <a href="/help" target="_blank" rel="noopener noreferrer">Help center</a> may still work.
          </p>
        )}
        {status === "ready" && found && (
          <>
            {found.steps.length > 0 && <p className="help-drawer-eyebrow">Steps that answer it</p>}
            <ul className="help-drawer-list">
              {found.steps.map((r) => (
                <li key={r.guide.id + r.number}>
                  <button type="button" className="help-drawer-result" onClick={() => read(r.guide, r.index)}>
                    <span className="help-drawer-num">{r.number}</span>
                    <span className="help-drawer-result-text">
                      <strong><Marked text={r.step.title} terms={found.terms} /></strong>
                      <small>{r.guide.title} · Step {r.number}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {found.guides.length > 0 && <p className="help-drawer-eyebrow">Guides</p>}
            <ul className="help-drawer-list">{found.guides.map((g) => row(g, iconOf(g)))}</ul>
            {!found.steps.length && !found.guides.length && (
              <p className="help-drawer-message">
                Nothing about “{query.trim()}” yet. Try other words, or{" "}
                <a href={"mailto:" + CONTACT}>email us</a>.
              </p>
            )}
          </>
        )}
        {status === "ready" && !found && (
          <>
            {hereGuide && (
              <section aria-labelledby="help-here">
                <p className="help-drawer-eyebrow" id="help-here">For this screen</p>
                <div className="help-drawer-here">
                  <button type="button" className="help-drawer-here-main" onClick={() => read(hereGuide)}>
                    <span className="help-drawer-tile">{iconOf(hereGuide)}</span>
                    <span>
                      <strong>{hereGuide.title}</strong>
                      <small>{hereGuide.steps.length} steps · opens here</small>
                    </span>
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                  {hereGuide.quick?.length > 0 && (
                    <div className="help-drawer-chips">
                      {hereGuide.quick.map((n) => (
                        <button type="button" key={n} onClick={() => read(hereGuide, n - 1)}>
                          {label(hereGuide.steps[n - 1])}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </section>
            )}
            <p className="help-drawer-eyebrow">Start here</p>
            <ol className="help-drawer-list">
              {guides
                .filter((g) => g.group === "start")
                .map((g, i) => row(g, <span className="help-drawer-num is-small">{i + 1}</span>))}
            </ol>
            <p className="help-drawer-eyebrow">Everyday work</p>
            <ul className="help-drawer-list">
              {guides.filter((g) => g.group === "everyday" && g.id !== here).map((g) => row(g, iconOf(g)))}
            </ul>
          </>
        )}
      </div>
      <div className="help-drawer-foot">
        <a href={"mailto:" + CONTACT}>
          <Mail size={15} aria-hidden="true" />
          Still stuck? Email us
        </a>
        <a href="/help" target="_blank" rel="noopener noreferrer" className="help-drawer-quiet">
          Help center
          <ExternalLink size={13} aria-hidden="true" />
        </a>
      </div>
    </>
  );

  const reader = guide && (
    <>
      <div className="help-drawer-head">
        <button className="help-drawer-icon" type="button" onClick={back} aria-label="Back to all help">
          <ChevronLeft size={18} />
        </button>
        <h2 id="help-drawer-title" className="help-drawer-guide-title">{guide.title}</h2>
        <a
          className="help-drawer-icon"
          href={pageOf(guide, step)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open this guide as a page in a new tab"
          title="Open as a page"
        >
          <ExternalLink size={17} />
        </a>
        <button className="help-drawer-icon" type="button" onClick={closeAndRestoreFocus} aria-label="Close Help">
          <X size={18} />
        </button>
      </div>
      <div className="help-drawer-progress">
        <span>{step !== null ? `Step ${step + 1} of ${guide.steps.length}` : `${guide.steps.length} steps`}</span>
        <span className="help-drawer-bar" aria-hidden="true">
          <span style={{ width: ((step ?? -1) + 1) / guide.steps.length * 100 + "%" }} />
        </span>
      </div>
      <ol className="help-drawer-body help-drawer-steps" ref={bodyRef}>
        {step > 0 && !earlier && (
          <li>
            <button type="button" className="help-drawer-step help-drawer-earlier" onClick={() => setEarlier(true)}>
              <span className="help-drawer-earlier-nums" aria-hidden="true">
                {guide.steps.slice(0, Math.min(step, 4)).map((_, i) => (
                  <span key={i}>{i + 1}</span>
                ))}
              </span>
              <span>{step === 1 ? "Show step 1" : `Show steps 1 to ${step}`}</span>
              <ChevronDown size={15} aria-hidden="true" />
            </button>
          </li>
        )}
        {guide.steps.map((s, i) => {
          if (i < step && !earlier) return null;
          if (i !== step)
            return (
              <li key={i}>
                <button type="button" className="help-drawer-step" aria-expanded="false" onClick={() => setStep(i)}>
                  <span className="help-drawer-num is-small is-quiet">{i + 1}</span>
                  <span>{label(s)}</span>
                  <ChevronDown size={15} aria-hidden="true" />
                </button>
              </li>
            );
          return (
            <li key={i} className="help-drawer-open">
              <button type="button" className="help-drawer-step is-open" aria-expanded="true" onClick={() => setStep(null)}>
                <span className="help-drawer-num is-small">{i + 1}</span>
                <h3>{s.title}</h3>
                <ChevronUp size={15} aria-hidden="true" />
              </button>
              <div className="help-drawer-step-body">
                <p className="help-drawer-do"><Rich text={s.do} onLink={follow} /></p>
                {s.more && <p className="help-drawer-more"><Rich text={s.more} onLink={follow} /></p>}
                {s.list && (
                  <ul className="help-drawer-points">
                    {s.list.map((item, j) => (
                      <li key={j}><Rich text={item} onLink={follow} /></li>
                    ))}
                  </ul>
                )}
                {s.example && (
                  <blockquote className="help-drawer-example">
                    <small>For example</small>“{s.example}”
                  </blockquote>
                )}
                {s.image && <Shot image={s.image} />}
                {s.warn && (
                  <p className="help-drawer-warn">
                    <TriangleAlert size={16} aria-hidden="true" />
                    <span><strong>Watch out.</strong> <Rich text={s.warn} onLink={follow} /></span>
                  </p>
                )}
                {s.note && (
                  <p className="help-drawer-note">
                    <Lightbulb size={16} aria-hidden="true" />
                    <span><strong>Good to know.</strong> <Rich text={s.note} onLink={follow} /></span>
                  </p>
                )}
                <div className="help-drawer-stepnav">
                  {i > 0 ? (
                    <button type="button" onClick={() => setStep(i - 1)}>
                      <ChevronLeft size={14} aria-hidden="true" />
                      Step {i}
                    </button>
                  ) : <span />}
                  {i < guide.steps.length - 1 ? (
                    <button type="button" className="is-next" onClick={() => setStep(i + 1)}>
                      Next step
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                  ) : (
                    <button type="button" className="is-next" onClick={back}>
                      Done
                    </button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="help-drawer-foot">
        {feedback ? (
          <p className="help-drawer-thanks" role="status">
            {feedback === "yes" ? "Thanks for telling us." : <>Sorry. Tell us what was missing: <a href={"mailto:" + CONTACT}>{CONTACT}</a></>}
          </p>
        ) : (
          <span className="help-drawer-feedback">
            Did this help?
            <button type="button" onClick={() => setFeedback("yes")} aria-label="Yes, this helped">
              <ThumbsUp size={15} />
            </button>
            <button type="button" onClick={() => setFeedback("no")} aria-label="No, this did not help">
              <ThumbsDown size={15} />
            </button>
          </span>
        )}
        {!feedback && (
          <a href={"mailto:" + CONTACT}>
            <Mail size={15} aria-hidden="true" />
            Email us
          </a>
        )}
      </div>
    </>
  );

  return (
    <aside
      className="help-drawer"
      id="help-drawer-panel"
      hidden={!open}
      role="complementary"
      aria-labelledby="help-drawer-title"
    >
      {reader || list}
    </aside>
  );
}
