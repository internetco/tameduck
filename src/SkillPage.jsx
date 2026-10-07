import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  CircleCheck,
  BookOpen,
  UserRound,
  Monitor,
  PlugZap,
  Wrench,
  Plus,
  Trash2,
  PowerOff,
} from "lucide-react";
import { api, Avatar, Button, flock } from "./ui.jsx";
import { Crumbs, using, added } from "./SkillCatalog.jsx";
import { readingLine } from "../shared/skill-text.mjs";
import {
  NEEDS,
  needOf,
  licenceWords,
  addLabel,
  namesLine,
} from "./skill-topics.mjs";

// The page's own heading is the skill's name, so the text's headings sit one
// step below it: its parts are the page's third level.
const below = { h1: "h3", h2: "h3", h3: "h4", h4: "h5", h5: "h6", h6: "h6" };
const textParts = {
  ...Object.fromEntries(
    Object.entries(below).map(([from, to]) => [
      from,
      ({ node, ...props }) => React.createElement(to, props),
    ]),
  ),
  // A link to the publisher's other files is a path in their folder, which
  // means nothing here; only a real web address stays a link.
  a: ({ node, href, children, ...props }) =>
    /^(https?:|mailto:)/i.test(href || "") ? (
      <a {...props} href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }) => <span>[Image: {alt || "picture"}]</span>,
};
function SkillText({ text }) {
  return (
    <div className="markdown skill-text">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={textParts}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
const needIcon = {
  playbook: CircleCheck,
  computer: Monitor,
  service: PlugZap,
  agent: Wrench,
};

// One skill, as a page you read like a document: what it tells the duck down
// the middle, and who gets it in a card at the side. A skill from the
// catalogue is added from here; one the company has opens as the same page,
// where each tick saves as it is pressed.
export default function SkillPage({
  data,
  action,
  notify,
  go,
  catalog,
  skillId,
  catalogId,
  onEdit,
  onRemoved,
  edits,
  headingRef,
}) {
  const own = skillId ? data.skills.find((s) => s.id === skillId) : null;
  const from = own?.catalog_id || catalogId;
  const card = from ? catalog.skills.find((s) => s.id === from) : null;
  const [detail, setDetail] = useState(null),
    [problem, setProblem] = useState(false),
    [attempt, setAttempt] = useState(0),
    [picked, setPicked] = useState([]);
  // A catalogue skill the company has already added is the company's own, and
  // opens as that. Not while ducks are ticked here, though: somebody else may
  // just have added it, and the ticks would be thrown away without a word.
  const have = catalogId ? added(data).get(catalogId) : null;
  const leave = !!have && !picked.length;
  useEffect(() => {
    if (leave) go({ type: "skills", id: have.id }, { replace: true });
  }, [leave]);
  useEffect(() => {
    if (leave) return;
    let current = true;
    setProblem(false);
    api(skillId ? "/skills/" + skillId : "/skill-catalog/" + catalogId)
      .then((skill) => {
        if (current) setDetail(skill);
      })
      .catch((e) => {
        if (!current) return;
        // Gone from the catalogue: back to the library, saying so, the way a
        // missing chat or file does. Anything else can be tried again.
        if (e.status === 404 && catalogId) {
          go({ type: "skills" }, { replace: true });
          notify("That skill is unavailable.");
        } else setProblem(true);
      });
    return () => {
      current = false;
    };
    // `edits` counts the times the instructions were changed here.
  }, [skillId, catalogId, attempt, edits, leave]);
  // The card beside the text stays in view while the text scrolls. One taller
  // than the window stays with its foot in view instead of its top, so the
  // button at the bottom - Add, or Remove and its question - is never pushed
  // off the screen, however many ducks there are or however tall it grows.
  const sideRef = useRef(null);
  const [top, setTop] = useState(12);
  useLayoutEffect(() => {
    const side = sideRef.current,
      scroller = side?.closest(".page");
    if (!side || !scroller || typeof ResizeObserver === "undefined") return;
    // The room is inside the scrolling area's padding, which is where a
    // sticky card is held.
    const fit = () => {
      const pad = getComputedStyle(scroller);
      const room =
        scroller.clientHeight -
        parseFloat(pad.paddingTop) -
        parseFloat(pad.paddingBottom);
      setTop(Math.min(12, room - side.offsetHeight - 12));
    };
    const watch = new ResizeObserver(fit);
    watch.observe(side);
    watch.observe(scroller);
    fit();
    return () => watch.disconnect();
  }, [leave]);
  if (leave) return null;
  const name = own?.name || detail?.name || card?.name || "";
  const description = own
    ? own.description
    : detail?.description || card?.description;
  const topic = own?.category || detail?.category || card?.category;
  const needs = needOf({
    id: from,
    requirements: detail?.requirements || card?.requirements,
  });
  const publisher = own?.publisher || detail?.publisher;
  const source = own?.source_url || detail?.sourceUrl;
  const licence = own?.license || detail?.license;
  // The server leaves out what was written for software, and for an added
  // skill only while nobody has changed it (shared/skill-text.mjs).
  const text = detail ? (skillId ? detail.text : detail.content) : null;
  const NeedIcon = needIcon[needs];
  return (
    <>
      <Crumbs go={go} topic={topic} skill />
      <h2 className="skills-title" tabIndex={-1} ref={headingRef}>
        {name || "Loading the skill…"}
      </h2>
      {description && <p className="skills-lede">{description}</p>}
      <div className="skill-cols">
        <aside
          className="skill-side"
          style={{ "--side-top": top + "px" }}
          aria-label="Who uses it"
          ref={sideRef}
        >
          {own ? (
            <OwnCard
              skill={own}
              data={data}
              action={action}
              onEdit={onEdit}
              onRemoved={onRemoved}
            />
          ) : (
            <AddCard
              name={name}
              catalogId={catalogId}
              data={data}
              action={action}
              go={go}
              picked={picked}
              setPicked={setPicked}
              taken={!!have}
            />
          )}
          <ul className="skill-facts">
            {NeedIcon && (
              <li className={needs === "playbook" ? "ok" : ""}>
                <NeedIcon size={16} aria-hidden="true" />
                <span>{NEEDS[needs]}</span>
              </li>
            )}
            {text && (
              <li>
                <BookOpen size={16} aria-hidden="true" />
                <span>{readingLine(text)}</span>
              </li>
            )}
            {publisher ? (
              <li>
                <UserRound size={16} aria-hidden="true" />
                <span>
                  Written by {publisher}. {licenceWords(licence)}{" "}
                  {source && (
                    <a
                      className="skills-link"
                      href={source}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      See the original
                    </a>
                  )}
                </span>
              </li>
            ) : (
              own && (
                <li>
                  <UserRound size={16} aria-hidden="true" />
                  <span>Written by {data.company.name}.</span>
                </li>
              )
            )}
          </ul>
        </aside>
        <section className="skill-doc" aria-label="What it tells the duck">
          <p className="skill-doc-cap">What it tells the duck</p>
          {text !== null ? (
            <SkillText text={text} />
          ) : problem ? (
            <div className="skills-problem" role="alert">
              <p>The instructions could not be loaded.</p>
              <Button
                className="secondary"
                onClick={() => setAttempt((n) => n + 1)}
              >
                Try again
              </Button>
            </div>
          ) : (
            <p className="skills-note" role="status">
              Loading the instructions…
            </p>
          )}
        </section>
      </div>
    </>
  );
}

// Ticks for a skill not added yet. Nothing is saved until the button is
// pressed, and the button says who it is for.
function AddCard({
  name,
  catalogId,
  data,
  action,
  go,
  picked,
  setPicked,
  taken,
}) {
  const [busy, setBusy] = useState(false);
  const here = useStillHere();
  const ducks = flock(data);
  if (!data.permissions.skills)
    return (
      <div className="skill-give">
        <h3>Give it to</h3>
        <p className="skill-give-say">Ask a company admin to add this skill.</p>
      </div>
    );
  const names = ducks.filter((d) => picked.includes(d.id)).map((d) => d.name);
  async function add() {
    setBusy(true);
    const saved = await action(
      async () => {
        const r = await api(`/skill-catalog/${catalogId}/install`, "POST", {
          ducks: picked,
        });
        // Somebody else added it a moment ago. Theirs is kept, and the ducks
        // ticked here are given it all the same rather than dropped.
        if (r.alreadyInstalled)
          for (const duck of picked)
            await api("/ducks/" + duck + "/skills", "PUT", {
              skill: r.id,
              enabled: true,
            });
        return r;
      },
      names.length
        ? name +
            " added for " +
            (names.length > 2 ? names.length + " ducks" : names.join(" and "))
        : name + " added to the library",
    );
    // Somebody who has already gone elsewhere stays there.
    if (!here.current) return;
    setBusy(false);
    if (saved) go({ type: "skills", id: saved.id }, { replace: true });
  }
  return (
    <div className="skill-give" role="group" aria-labelledby="skill-give">
      <h3 id="skill-give">Give it to</h3>
      {taken && !busy && (
        <p className="skill-give-say" role="status">
          Someone else just added this skill. Press the button to give it to the
          ducks you ticked.
        </p>
      )}
      {ducks.map((d) => (
        <label className="skill-check" key={d.id}>
          <input
            type="checkbox"
            checked={picked.includes(d.id)}
            disabled={busy}
            onChange={(e) =>
              setPicked((p) =>
                e.target.checked ? [...p, d.id] : p.filter((x) => x !== d.id),
              )
            }
          />
          <Avatar duck={d} size={28} />
          <span>
            <b>{d.name}</b>
            {d.role && <i>{d.role}</i>}
          </span>
        </label>
      ))}
      <Button className="skill-add" busy={busy} disabled={!name} onClick={add}>
        <Plus size={16} aria-hidden="true" />
        {addLabel(names)}
      </Button>
    </div>
  );
}

// Ticks for a skill the company has: each one is saved the moment it is
// pressed, the way a duck's own Skills tab does it.
function OwnCard({ skill, data, action, onEdit, onRemoved }) {
  const [pending, setPending] = useState({}),
    [asking, setAsking] = useState(false),
    [busy, setBusy] = useState(false);
  const here = useStillHere();
  const removeRef = useRef(null),
    keepRef = useRef(null),
    asked = useRef(false);
  const ducks = flock(data);
  const holders = using(data, skill);
  useLayoutEffect(() => {
    if (asking) keepRef.current?.focus();
    else if (asked.current) removeRef.current?.focus();
    asked.current = asking;
  }, [asking]);
  const off = !skill.enabled && (
    <p className="skill-off">
      <PowerOff size={16} aria-hidden="true" />
      <span>
        Turned off, so no duck uses it.{" "}
        {data.permissions.skills
          ? "To turn it on, press Change the instructions and tick Enabled for assigned ducks."
          : "Ask a company admin to turn it on."}
      </span>
    </p>
  );
  if (!data.permissions.skills)
    return (
      <div className="skill-give">
        {off}
        <h3>Who has it</h3>
        {holders.length ? (
          <ul className="skill-holders">
            {holders.map((d) => (
              <li key={d.id}>
                <Avatar duck={d} size={28} />
                <span>
                  <b>{d.name}</b>
                  {d.role && <i>{d.role}</i>}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="skill-give-say">No duck has it yet.</p>
        )}
        <p className="skill-give-say">
          Ask a company admin to change who has it.
        </p>
      </div>
    );
  const has = (d) =>
    d.id in pending ? pending[d.id] : skill.ducks.includes(d.id);
  const tick = (d, on) => {
    // One save per duck at a time; the box stays where it is meanwhile, and
    // goes to whatever the server says once it answers.
    if (d.id in pending) return;
    setPending((p) => ({ ...p, [d.id]: on }));
    action(
      () =>
        api("/ducks/" + d.id + "/skills", "PUT", {
          skill: skill.id,
          enabled: on,
        }),
      on
        ? skill.name + " added to " + d.name
        : skill.name + " removed from " + d.name,
    ).finally(() =>
      setPending((p) => {
        const next = { ...p };
        delete next[d.id];
        return next;
      }),
    );
  };
  async function remove() {
    setBusy(true);
    const done = await action(async () => {
      await api("/skills/" + skill.id, "DELETE");
      // Off this page before the library is read again, so the page that
      // has just gone is not reported as missing - unless the person has
      // already gone somewhere else, where they stay.
      await onRemoved(skill.id, here.current);
      return true;
    }, skill.name + " removed");
    if (!done && here.current) setBusy(false);
  }
  return (
    <div className="skill-give" role="group" aria-labelledby="skill-give">
      {off}
      <h3 id="skill-give">Give it to</h3>
      <p className="skill-give-say">Saved as you tick.</p>
      {ducks.map((d) => (
        <label className="skill-check" key={d.id}>
          <input
            type="checkbox"
            checked={has(d)}
            aria-busy={d.id in pending}
            onChange={(e) => tick(d, e.target.checked)}
          />
          <Avatar duck={d} size={28} />
          <span>
            <b>{d.name}</b>
            {d.role && <i>{d.role}</i>}
          </span>
        </label>
      ))}
      <Button className="secondary skill-add" onClick={onEdit}>
        Change the instructions
      </Button>
      <div className="skill-give-foot">
        {asking ? (
          <div
            className="skill-remove-ask"
            role="group"
            aria-labelledby="skill-remove-q"
            aria-describedby="skill-remove-what"
            onKeyDown={(e) => {
              if (e.key === "Escape" && !busy) {
                e.stopPropagation();
                setAsking(false);
              }
            }}
          >
            <p id="skill-remove-q" className="skill-remove-q">
              Remove {skill.name}?
            </p>
            <p id="skill-remove-what">
              {holders.length
                ? namesLine(holders.map((d) => d.name)) +
                  (holders.length === 1 ? " loses it" : " lose it") +
                  ", and its instructions and history are deleted."
                : "Its instructions and history are deleted."}
            </p>
            <div className="skill-remove-btns">
              <Button
                className="secondary"
                ref={keepRef}
                disabled={busy}
                onClick={() => setAsking(false)}
              >
                Keep it
              </Button>
              <Button className="skill-remove go" busy={busy} onClick={remove}>
                <Trash2 size={16} aria-hidden="true" />
                Remove
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="skill-remove"
            ref={removeRef}
            onClick={() => setAsking(true)}
          >
            <Trash2 size={16} aria-hidden="true" />
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

// False once the page this was pressed on has gone, so an answer that comes
// back later does not pull the person back from where they went.
function useStillHere() {
  const here = useRef(true);
  useEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
    };
  }, []);
  return here;
}
