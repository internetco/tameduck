import React, { useEffect, useRef, useState } from "react";
import { Search, Check, ChevronRight, ArrowUpRight } from "lucide-react";
import { api, Avatar, Button, flock } from "./ui.jsx";
import {
  topicTiles,
  topicSkills,
  searchSkills,
  worksAsIs,
  needOf,
  worksAsIsLine,
  isBusinessTopic,
  count,
  NEEDS_SHORT,
  SOFTWARE,
  topicSlug,
} from "./skill-topics.mjs";
import "./skill-catalog.css";
export function SkillProvenance({ skill }) {
  if (!skill.publisher) return null;
  return (
    <div className="skill-provenance">
      <span>
        Publisher: <strong>{skill.publisher}</strong>
      </span>
      <span>
        {skill.category} · {skill.license}
      </span>
      <a
        href={skill.source_url || skill.sourceUrl}
        target="_blank"
        rel="noreferrer noopener"
      >
        Original source <ArrowUpRight size={13} />
      </a>
    </div>
  );
}
// The ducks on the team that a library skill is given to.
export const using = (data, skill) =>
  flock(data).filter((d) => skill.ducks.includes(d.id));
// Library skills by the catalogue skill they came from, so one that is already
// added opens as the company's own page, wherever it is found.
export const added = (data) =>
  new Map(
    data.skills.filter((s) => s.catalog_id).map((s) => [s.catalog_id, s]),
  );
// The thousand skills to add from. Read once for the whole Skills library: the
// home page counts them, a topic lists them, a skill's page needs what its
// skill needs.
export function useCatalog(company) {
  const [state, setState] = useState({
    skills: [],
    loading: true,
    error: false,
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setState((s) => ({ ...s, loading: true, error: false }));
    api("/skill-catalog")
      .then((r) => {
        if (current)
          setState({ skills: r.skills, loading: false, error: false });
      })
      .catch(() => {
        if (current) setState((s) => ({ ...s, loading: false, error: true }));
      });
    return () => {
      current = false;
    };
  }, [company, attempt]);
  return { ...state, retry: () => setAttempt((n) => n + 1) };
}
export function Faces({ ducks }) {
  if (!ducks.length) return null;
  return (
    <span className="skills-faces" aria-hidden="true">
      {ducks.slice(0, 3).map((d) => (
        <Avatar key={d.id} duck={d} size={24} />
      ))}
    </span>
  );
}
// "Skills library › Writing & Communication": every place above this one. A
// skill's page names its topic; a topic's page does not name itself.
export function Crumbs({ go, topic, skill = false }) {
  const trail = [{ label: "Skills library", to: { type: "skills" } }];
  if (topic && topic !== SOFTWARE && !isBusinessTopic(topic))
    trail.push({
      label: "For software teams",
      to: { type: "skills", topic: SOFTWARE },
    });
  if (topic && topic !== SOFTWARE && skill)
    trail.push({
      label: topic,
      to: { type: "skills", topic: topicSlug(topic) },
    });
  return (
    <nav className="skills-crumbs" aria-label="Where you are">
      {trail.map((step, i) => (
        <React.Fragment key={step.label}>
          {i > 0 && <ChevronRight size={14} aria-hidden="true" />}
          <button type="button" onClick={() => go(step.to)}>
            {step.label}
          </button>
        </React.Fragment>
      ))}
    </nav>
  );
}
function Unloaded({ catalog }) {
  if (catalog.error)
    return (
      <div className="skills-problem" role="alert">
        <p>The skills could not be loaded.</p>
        <Button className="secondary" onClick={catalog.retry}>
          Try again
        </Button>
      </div>
    );
  return (
    <p className="skills-note" role="status">
      Loading the skills…
    </p>
  );
}
function TopicTile({ tile, go }) {
  return (
    <button
      type="button"
      className="skills-tile"
      data-place={"topic:" + tile.slug}
      onClick={() => go({ type: "skills", topic: tile.slug })}
    >
      <b>{tile.name}</b>
      <span className={"skills-tile-n" + (tile.ready ? " ready" : "")}>
        {worksAsIsLine(tile.ready, tile.total)}
      </span>
      {tile.examples.length > 0 && (
        <span className="skills-tile-ex">{tile.examples.join(", ")}</span>
      )}
    </button>
  );
}
// Skills to add, one row each. A skill the company already has says so, and
// opens as the company's own.
export function SkillRows({ skills, data, go, needs = false, topics = false }) {
  const have = added(data);
  return (
    <ul className="skills-rows">
      {skills.map((s) => {
        const own = have.get(s.id);
        return (
          <li key={s.id}>
            <button
              type="button"
              data-place={"skill:" + s.id}
              onClick={() =>
                go(
                  own
                    ? { type: "skills", id: own.id }
                    : { type: "skills", catalogId: s.id },
                )
              }
            >
              <span className="skills-row-words">
                <b>{s.name}</b>
                <i>
                  {topics ? s.category + ". " : ""}
                  {s.description}
                </i>
              </span>
              {own ? (
                <span className="skills-row-tag">
                  <Check size={15} aria-hidden="true" />
                  Added
                </span>
              ) : (
                needs && (
                  <span
                    className={
                      "skills-row-tag" + (worksAsIs(s) ? " ready" : "")
                    }
                  >
                    {NEEDS_SHORT[needOf(s)]}
                  </span>
                )
              )}
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
  );
}
// "Add a skill" on the Skills library: a search over all of them, and the
// topics to pick from. No skill is listed until one or the other is used.
// The search and how far down it was shown live in the page above this, so
// coming back from a skill finds them as they were left.
export default function SkillCatalog({ data, go, catalog, find, setFind }) {
  const { query, limit } = find;
  const setQuery = (value) => setFind({ query: value, limit: 30 });
  const setLimit = (more) => setFind((f) => ({ ...f, limit: more(f.limit) }));
  const q = query.trim();
  const found = q ? searchSkills(catalog.skills, q) : [];
  const tiles = topicTiles(catalog.skills);
  const searching = !!q && catalog.skills.length > 0;
  // The last "Show more" takes its button away with it. The focus goes to the
  // first of the skills it brought, not to the top of the page.
  const listRef = useRef(null),
    firstNew = useRef(null);
  useEffect(() => {
    const at = firstNew.current;
    firstNew.current = null;
    if (at !== null)
      listRef.current?.querySelectorAll(".skills-rows button")[at]?.focus();
  }, [limit]);
  return (
    <section className="skills-sec" aria-labelledby="skills-add" ref={listRef}>
      <h3 id="skills-add">Add a skill</h3>
      <label className="skills-search">
        <Search size={17} aria-hidden="true" />
        <input
          aria-label="Search all skills"
          placeholder={
            catalog.skills.length
              ? "Search " + count(catalog.skills.length) + " skills"
              : "Search skills"
          }
          enterKeyHint="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.preventDefault();
              setQuery("");
            }
          }}
        />
      </label>
      {/* On the page before the first letter is typed, so the first count is
          read aloud too: a live region that arrives with its words in it is
          not. */}
      <div className={"skills-found" + (searching ? "" : " idle")}>
        <p aria-live="polite">
          {!searching
            ? ""
            : found.length
              ? count(found.length) +
                (found.length === 1 ? " skill matches “" : " skills match “") +
                q +
                "”"
              : "No skill matches “" +
                q +
                "”. Try another word, or pick a topic."}
        </p>
        {searching && (
          <button
            type="button"
            className="skills-link"
            onClick={() => setQuery("")}
          >
            Clear search
          </button>
        )}
      </div>
      {!catalog.skills.length ? (
        <Unloaded catalog={catalog} />
      ) : q ? (
        <>
          {found.length > 0 && (
            <SkillRows
              skills={found.slice(0, limit)}
              data={data}
              go={go}
              needs
              topics
            />
          )}
          {found.length > limit && (
            <div className="skills-more">
              <Button
                className="secondary"
                onClick={() => {
                  if (found.length <= limit + 30) firstNew.current = limit;
                  setLimit((n) => n + 30);
                }}
              >
                Show more skills ({count(found.length - limit)} remaining)
              </Button>
            </div>
          )}
        </>
      ) : (
        <div className="skills-tiles">
          {tiles.business.map((t) => (
            <TopicTile key={t.slug} tile={t} go={go} />
          ))}
          {tiles.software.length > 0 && (
            <button
              type="button"
              className="skills-tile soft"
              data-place={"topic:" + SOFTWARE}
              onClick={() => go({ type: "skills", topic: SOFTWARE })}
            >
              <b>For software teams</b>
              <span className="skills-tile-n">
                {tiles.software.length} more topics,{" "}
                {count(tiles.softwareSkills)} skills
              </span>
              <span className="skills-tile-ex">
                Most need a computer or a connected account
              </span>
            </button>
          )}
        </div>
      )}
    </section>
  );
}
// A topic's own page: its skills, the ones that work as is first. "For
// software teams" is a page of topics instead.
export function TopicPage({ data, go, catalog, slug, notify, headingRef }) {
  const tiles = topicTiles(catalog.skills);
  const topic = topicSkills(catalog.skills, slug);
  const known = slug === SOFTWARE ? tiles.software.length > 0 : !!topic.name;
  // An address for a topic that is not in the catalogue goes back to the
  // library, and says why, the way a missing chat or file does.
  useEffect(() => {
    if (catalog.skills.length && !known) {
      notify("That topic is unavailable.");
      go({ type: "skills" }, { replace: true });
    }
  }, [catalog.skills.length, known]);
  if (!catalog.skills.length)
    return (
      <>
        <Crumbs go={go} />
        <h2 className="skills-title" tabIndex={-1} ref={headingRef}>
          Skills library
        </h2>
        <Unloaded catalog={catalog} />
      </>
    );
  if (!known) return null;
  if (slug === SOFTWARE)
    return (
      <>
        <Crumbs go={go} />
        <h2 className="skills-title" tabIndex={-1} ref={headingRef}>
          For software teams
        </h2>
        <p className="skills-lede">
          {tiles.software.length} topics, {count(tiles.softwareSkills)} skills.
          Most need a computer or a connected account.
        </p>
        <div className="skills-tiles">
          {tiles.software.map((t) => (
            <TopicTile key={t.slug} tile={t} go={go} />
          ))}
        </div>
      </>
    );
  const total = topic.ready.length + topic.needs.length;
  return (
    <>
      <Crumbs go={go} topic={topic.name} />
      <h2 className="skills-title" tabIndex={-1} ref={headingRef}>
        {topic.name}
      </h2>
      <p className="skills-lede">{worksAsIsLine(topic.ready.length, total)}.</p>
      {topic.ready.length > 0 && (
        <section className="skills-sec" aria-labelledby="skills-ready">
          <h3 id="skills-ready">
            Work as is <span>{topic.ready.length}</span>
          </h3>
          <SkillRows skills={topic.ready} data={data} go={go} />
        </section>
      )}
      {topic.needs.length > 0 && (
        <section className="skills-sec" aria-labelledby="skills-needs">
          <h3 id="skills-needs">
            Need something set up first <span>{topic.needs.length}</span>
          </h3>
          <SkillRows skills={topic.needs} data={data} go={go} needs />
        </section>
      )}
    </>
  );
}
