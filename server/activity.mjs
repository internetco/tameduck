// Settings > Activity log: what people and ducks did in a company, newest
// first, a day at a time on the company's own clock.
//
// It used to be the newest hundred rows of the audit table, sent to every open
// tab with every refresh. A busy company's runs pushed last week's secret
// changes off the end within days, and there was no way to see further back.
// Now the page asks for whole days, as many as it takes to fill a screen, and
// asks again for the days before them. Tool decisions come from the approvals
// they were made on, read by the same days, so each sits where it happened.
import { z } from "zod";
import { all, can, permissions } from "./store.mjs";
import { companyTimezone } from "./schedules.mjs";
import { shortTitle } from "./duck-activity.mjs";
import { instantOf, clockAt } from "../shared/schedule-times.mjs";
import {
  COMPUTER_USE,
  RUN_FINISHED,
  dayHeading,
  dayName,
  decision,
  foldComputer,
  foldRun,
  foldWords,
  kindOf,
  sentence,
} from "./activity-words.mjs";

// A page is whole days, until it has this many lines to show.
const ENOUGH = 10;
// The most days one request looks through, so a filter with little in it
// cannot walk a company's whole history in one go.
const MOST_DAYS = 31;
// The most rows of one day read at once. A duck's computer writes one for
// every click. A day with more than this goes on in the next page, under the
// same heading, rather than losing what did not fit.
const MOST_ROWS = 5000;
const ENDED = [
  "executed",
  "denied",
  "changes_requested",
  "failed",
  "unknown",
  "cancelled",
];
const ended = ENDED.map((s) => "'" + s + "'").join(",");
export const SHOW = ["everything", "secrets", "tools", "people", "work"];

const QUARTER = 15 * 60000;
const startOf = (day, tz) => {
  const [y, m, d] = day.split("-").map(Number);
  let at = instantOf(y, m, d, 0, tz);
  // Where the clocks go back at midnight (the Azores, Havana) midnight happens
  // twice, and instantOf() gives the second. The day starts at the first:
  // lines written in between were otherwise on a day that never read them,
  // and paging stopped there for good.
  for (let i = 0; i < 12 && clockAt(at - QUARTER, tz).date === day; i++)
    at -= QUARTER;
  return new Date(at).toISOString();
};
const dayOf = (iso, tz) => clockAt(Date.parse(iso), tz).date;
const timeOf = (iso, tz) => clockAt(Date.parse(iso), tz).time;
const inList = (values) => JSON.stringify([...new Set(values)]);
function parse(details) {
  if (!details) return null;
  try {
    const value = JSON.parse(details);
    return value && typeof value === "object" ? value : details;
  } catch {
    return details;
  }
}
// Rows whose words are the name, or the id, of the duck they are about.
const NAMES_A_DUCK = new Set([
  "Duck finished a run",
  "Duck updated notes",
  "Duck profile updated",
  "Duck created",
  "Steered active reply",
  "Idle computer saving and stopping",
  "Computer saving and stopping",
]);

// Everything one request needs to know, once.
function reader(company, viewer, member, show) {
  const tz = companyTimezone(company);
  const may = permissions(member);
  const kind = show === "everything" ? null : show;
  const decisions = !kind || kind === "tools";
  const ducks = all(
    "SELECT id,name,chief FROM ducks WHERE company_id=?",
    company,
  );
  const duckById = new Map(ducks.map((d) => [d.id, d]));
  const duckByName = new Map();
  for (const d of ducks)
    duckByName.set(d.name, duckByName.has(d.name) ? null : d);
  const duckFor = (value) => {
    if (!value || typeof value !== "string") return null;
    const d = duckById.get(value) || duckByName.get(value);
    if (d) return { id: d.id, name: d.name };
    // Taken off the team long ago, or renamed since: the name it had.
    return /^[0-9a-f-]{36}$/i.test(value) ? null : { id: null, name: value };
  };
  const chief = ducks.find((d) => d.chief) || null;
  // Only somebody who may answer approvals sees everybody's; anyone else sees
  // the ones their own runs asked for, as Needs you does.
  const scope = [may.approvals ? 1 : 0, viewer];
  return {
    company,
    viewer,
    tz,
    kind,
    decisions,
    duckFor,
    chief: chief && { id: chief.id, name: chief.name },
    scope,
    today: dayOf(new Date().toISOString(), tz),
  };
}
// Setting a company up says what creating it said: a new company opened on
// "Noor set up Harbour Bakery" over "Noor created Harbour Bakery". Asked only
// when the day that holds "Company created" is read.
function setUp(r) {
  if (r.setUp === undefined)
    r.setUp = !!all(
      "SELECT 1 yes FROM audit WHERE company_id=? AND action='Company set up' LIMIT 1",
      r.company,
    )[0];
  return r.setUp;
}

// When the newest thing before `end` happened, or null.
function newestBefore(r, end) {
  const audit = all(
    "SELECT max(created) at FROM audit WHERE company_id=? AND created<?" +
      (r.kind ? " AND kind=?" : ""),
    r.company,
    end,
    ...(r.kind ? [r.kind] : []),
  )[0]?.at;
  const decided = r.decisions
    ? all(
        `SELECT max(a.updated) at FROM approvals a JOIN jobs j ON j.id=a.job_id
          WHERE a.company_id=? AND a.updated<? AND a.status IN (${ended})
            AND (?=1 OR j.user_id=?)`,
        r.company,
        end,
        ...r.scope,
      )[0]?.at
    : null;
  return [audit, decided].filter(Boolean).sort().at(-1) || null;
}

// The runs these rows happened in: who each was for, what it was, and where it
// can be opened - only when the person looking may see what was asked. A run
// in somebody else's chat with a duck is theirs; a ticket is everybody's.
function runsOf(r, ids) {
  if (!ids.length) return new Map();
  const rows = all(
    `SELECT j.id,j.duck_id,j.user_id,u.name user_name,
            COALESCE(j.task_id,root.task_id) task_id,t.title task_title,
            COALESCE(NULLIF(root.schedule_title,''),NULLIF(j.schedule_title,'')) schedule_title,
            input.body input_body,root.conversation_id,root.thread_id,
            cv.kind conversation_kind,cv.name conversation_name,
            EXISTS(SELECT 1 FROM conversation_members m
                    WHERE m.conversation_id=root.conversation_id AND m.user_id=?) mine
       FROM jobs j
       JOIN jobs root ON root.id=COALESCE(j.root_job_id,j.id) AND root.company_id=j.company_id
       LEFT JOIN users u ON u.id=j.user_id
       LEFT JOIN tasks t ON t.id=COALESCE(j.task_id,root.task_id) AND t.company_id=j.company_id
       LEFT JOIN messages input ON input.id=root.input_message_id
       LEFT JOIN conversations cv ON cv.id=root.conversation_id
      WHERE j.company_id=? AND j.id IN (SELECT value FROM json_each(?))`,
    r.viewer,
    r.company,
    inList(ids),
  );
  return new Map(
    rows.map((j) => {
      const ticket = !!(j.task_id && j.task_title);
      const visible = ticket || !!j.mine;
      const duck = r.duckFor(j.duck_id);
      return [
        j.id,
        {
          duck,
          user: j.user_id,
          for: j.user_name || null,
          title: visible
            ? j.task_title || j.schedule_title || shortTitle(j.input_body, "")
            : null,
          place: !visible
            ? null
            : ticket
              ? "On the ticket “" + j.task_title + "”"
              : j.conversation_kind === "direct"
                ? "In the chat with " + (duck?.name || "a duck")
                : j.conversation_name
                  ? "In " + j.conversation_name
                  : null,
          open: !visible
            ? null
            : ticket
              ? { type: "tasks", id: j.task_id, label: "Open the ticket" }
              : {
                  type: "chat",
                  id: j.conversation_id,
                  thread: j.thread_id || null,
                  label: "Open the chat",
                },
        },
      ];
    }),
  );
}

// Names for the ids some rows keep in their details.
function namesOf(r, rows) {
  const want = { users: [], groups: [], tasks: [], skills: [] };
  for (const row of rows) {
    const d = row.parsed;
    if (!d || typeof d !== "object") continue;
    if (typeof d.member === "string") want.users.push(d.member);
    if (typeof d.group_id === "string") want.groups.push(d.group_id);
    if (typeof d.task === "string") want.tasks.push(d.task);
    if (typeof d.skill === "string") want.skills.push(d.skill);
  }
  const named = {};
  const look = (sql, ids) => {
    if (!ids.length) return;
    for (const x of all(sql, inList(ids), r.company)) named[x.id] = x.name;
  };
  // A teammate who has left is still named: users outlive memberships.
  if (want.users.length)
    for (const x of all(
      "SELECT id,name FROM users WHERE id IN (SELECT value FROM json_each(?))",
      inList(want.users),
    ))
      named[x.id] = x.name;
  look(
    "SELECT id,name FROM secret_groups WHERE id IN (SELECT value FROM json_each(?)) AND company_id=?",
    want.groups,
  );
  look(
    "SELECT id,title name FROM tasks WHERE id IN (SELECT value FROM json_each(?)) AND company_id=?",
    want.tasks,
  );
  look(
    "SELECT id,name FROM skills WHERE id IN (SELECT value FROM json_each(?)) AND company_id=?",
    want.skills,
  );
  return named;
}

// A face: the duck's, or the person's.
const faceOf = (by, row) =>
  by === "duck"
    ? { duck: row.duck?.id || null, name: row.duck?.name || "A duck" }
    : { person: row.person || "Somebody" };

// Everything that happened in [start, end), as the lines the page shows, and
// where what it read begins: `start`, or later when the day had more rows than
// one read holds. The next page carries on from there, under the same heading.
function readDay(r, day, start, end) {
  let rows = all(
    "SELECT a.*,u.name user_name FROM audit a LEFT JOIN users u ON u.id=a.user_id " +
      "WHERE a.company_id=? AND a.created>=? AND a.created<?" +
      " AND NOT EXISTS (SELECT 1 FROM jobs monitor WHERE monitor.id=a.job_id AND monitor.company_id=a.company_id AND monitor.checkin=1)" +
      (r.kind ? " AND a.kind=?" : "") +
      " ORDER BY a.created DESC,a.rowid DESC LIMIT ?",
    r.company,
    start,
    end,
    ...(r.kind ? [r.kind] : []),
    MOST_ROWS,
  ).map((row) => ({ ...row, parsed: parse(row.details) }));
  // Cut short: this part begins just after the oldest moment it read, and the
  // rows of that moment all go to the next page - some of them did not fit
  // here, and the next page reads what is older than where this one begins.
  if (rows.length === MOST_ROWS) {
    const cut = rows.at(-1).created;
    const after = new Date(Date.parse(cut) + 1).toISOString();
    const newer = rows.filter((row) => row.created >= after);
    // Unless every row read is of that one moment: then it has to be cut.
    if (newer.length) {
      rows = newer;
      start = after;
    } else start = cut;
  }
  const approvals = r.decisions
    ? all(
        `SELECT a.id,a.tool,a.summary,a.args,a.status,a.result,a.created,a.updated,a.job_id,
                cn.name connection_name,u.name decider
           FROM approvals a JOIN jobs j ON j.id=a.job_id
           LEFT JOIN connections cn ON cn.id=a.connection_id
           LEFT JOIN users u ON u.id=a.decided_by
          WHERE a.company_id=? AND a.updated>=? AND a.updated<? AND a.status IN (${ended})
            AND (?=1 OR j.user_id=?)
          ORDER BY a.updated DESC`,
        r.company,
        start,
        end,
        ...r.scope,
      )
    : [];
  const runs = runsOf(r, [
    ...rows.map((row) => row.job_id).filter(Boolean),
    ...approvals.map((a) => a.job_id),
  ]);
  const named = namesOf(r, rows);

  // A row about a tool decision says again what its approval says better, and
  // one about an approval this person may not see is not theirs either. It
  // stays only when the approval is gone: removing a connection deletes the
  // decisions made on it.
  const toolRows = rows.filter(
    (row) => row.kind === "tools" || kindOf(row.action) === "tools",
  );
  const known = toolRows.length
    ? all(
        `SELECT a.job_id,a.tool,a.created,a.updated FROM approvals a
          WHERE a.company_id=? AND a.tool IN (SELECT value FROM json_each(?))
            AND a.created<=? AND a.updated>=?`,
        r.company,
        inList(
          toolRows.map((row) =>
            typeof row.parsed === "string"
              ? row.parsed
              : String(row.parsed?.tool || ""),
          ),
        ),
        new Date(Date.parse(end) + 60000).toISOString(),
        new Date(Date.parse(start) - 60000).toISOString(),
      )
    : [];
  const explained = (row) => {
    const tool =
      typeof row.parsed === "string" ? row.parsed : row.parsed?.tool || "";
    const at = Date.parse(row.created);
    return known.some(
      (a) =>
        a.tool === tool &&
        (row.job_id
          ? a.job_id === row.job_id
          : Date.parse(a.created) - 60000 <= at &&
            at <= Date.parse(a.updated) + 60000),
    );
  };

  const lines = [];
  const folded = { runs: [], computer: [] };
  for (const row of rows) {
    const job = row.job_id ? runs.get(row.job_id) : null;
    const d = row.parsed;
    const duck =
      r.duckFor(row.duck_id) ||
      (d && typeof d === "object"
        ? r.duckFor(d.duck) || r.duckFor(d.duck_id)
        : NAMES_A_DUCK.has(row.action)
          ? r.duckFor(d)
          : null) ||
      job?.duck ||
      null;
    const input = {
      action: row.action,
      details: d,
      person: row.user_name || null,
      duck,
      chief: r.chief,
      job,
      named,
    };
    if (row.action === RUN_FINISHED) {
      folded.runs.push({ row, input });
      continue;
    }
    if (COMPUTER_USE.has(row.action)) {
      folded.computer.push({ row, input });
      continue;
    }
    if ((row.kind || kindOf(row.action)) === "tools") {
      if (explained(row)) continue;
      // Its approval has gone: somebody who may not answer approvals still
      // sees only what their own runs asked for.
      if (!r.scope[0] && job?.user !== r.viewer) continue;
    }
    if (row.action === "Company created" && setUp(r)) continue;
    const said = sentence(input);
    if (said.hide) continue;
    lines.push({
      id: row.id,
      time: row.created,
      at: timeOf(row.created, r.tz),
      kind: row.kind || kindOf(row.action),
      face: faceOf(said.by, input),
      mark: said.mark,
      line: said.line,
      sub: said.sub || null,
      why: said.why || null,
      outcome: said.outcome || null,
      // A run that did not finish can be opened where it happened.
      open: said.outcome?.tone === "bad" ? job?.open || null : null,
    });
  }
  for (const a of approvals) {
    const job = runs.get(a.job_id);
    const duck = job?.duck || null;
    const said = decision({ ...a, duck });
    lines.push({
      id: a.id,
      time: a.updated,
      at: timeOf(a.updated, r.tz),
      kind: "tools",
      face: faceOf("duck", { duck }),
      mark: said.mark,
      line: said.line,
      sub: said.sub || null,
      why: said.why || null,
      outcome: said.outcome,
      asked: said.asked || null,
      sent: said.sent || null,
      service: a.connection_name || null,
      open: null,
    });
  }

  // The day's routine work: one line each, where the newest of it happened.
  const tally = (group, key) => {
    const by = new Map();
    for (const one of group) {
      const d = one.input.duck;
      const k = key(d);
      if (!by.has(k))
        by.set(k, {
          duck: d?.id || null,
          name: d?.name || "A duck",
          count: 0,
          newest: one.row.created,
        });
      by.get(k).count++;
    }
    return [...by.values()].sort((x, y) => y.count - x.count);
  };
  const who = (d) => d?.id || d?.name || "";
  // A fold keeps its id all day, so the one somebody opened stays open, with
  // what they were reading, when another run finishes or the duck clicks
  // again. A day read in two goes has a second part, told apart by its end.
  const part = end !== "9999" && dayOf(end, r.tz) === day ? "-" + end : "";
  if (folded.runs.length === 1) {
    const { row, input } = folded.runs[0];
    const said = sentence(input);
    lines.push({
      id: row.id,
      time: row.created,
      at: timeOf(row.created, r.tz),
      kind: "work",
      face: faceOf("duck", input),
      mark: said.mark,
      line: said.line,
      sub: null,
      why: null,
      outcome: null,
      open: null,
    });
  } else if (folded.runs.length) {
    const ducks = tally(folded.runs, who);
    const said = foldWords("runs", ducks, folded.runs.length);
    lines.push({
      id: "runs-" + day + part,
      fold: "runs",
      time: folded.runs[0].row.created,
      at: timeOf(folded.runs[0].row.created, r.tz),
      kind: "work",
      faces: ducks.slice(0, 3).map((d) => ({ duck: d.duck, name: d.name })),
      line: said.line,
      sub: said.sub,
      items: folded.runs.map(({ row, input }) => ({
        id: row.id,
        face: faceOf("duck", input),
        rest: foldRun(input),
        time: row.created,
        at: timeOf(row.created, r.tz),
      })),
    });
  }
  if (folded.computer.length === 1) {
    const { row, input } = folded.computer[0];
    const said = sentence(input);
    lines.push({
      id: row.id,
      time: row.created,
      at: timeOf(row.created, r.tz),
      kind: "work",
      face: faceOf("duck", input),
      mark: said.mark,
      line: said.line,
      sub: said.sub || null,
      why: null,
      outcome: null,
      open: null,
    });
  } else if (folded.computer.length) {
    const ducks = tally(folded.computer, who);
    const said = foldWords("computer", ducks, folded.computer.length);
    // One duck's clicks: the line says all there is, and opens onto nothing.
    if (ducks.length === 1)
      lines.push({
        id: "computer-" + day + part,
        time: folded.computer[0].row.created,
        at: timeOf(folded.computer[0].row.created, r.tz),
        kind: "work",
        face: faceOf("duck", folded.computer[0].input),
        mark: "computer",
        line: said.line,
        sub: null,
        why: null,
        outcome: null,
        open: null,
      });
    else
      lines.push({
        id: "computer-" + day + part,
        fold: "computer",
        time: folded.computer[0].row.created,
        at: timeOf(folded.computer[0].row.created, r.tz),
        kind: "work",
        faces: ducks.slice(0, 3).map((d) => ({ duck: d.duck, name: d.name })),
        line: said.line,
        sub: said.sub,
        items: ducks.map((d) => ({
          id: "computer-" + day + "-" + (d.duck || d.name),
          face: { duck: d.duck, name: d.name },
          rest: foldComputer(d.count),
          time: d.newest,
          at: timeOf(d.newest, r.tz),
        })),
      });
  }
  lines.sort((x, y) => (x.time < y.time ? 1 : x.time > y.time ? -1 : 0));
  return { lines, from: start };
}

// One page: the newest whole days before `before` (the moment the last page
// stopped at), until there is a screenful, and where the next page starts.
// With `after` (where the first page on screen stopped) it is that page again,
// read afresh: every day back to there, however many lines, so it takes the
// first page's place exactly and the days loaded below it still follow on.
export function activityPage(
  company,
  viewer,
  member,
  { show = "everything", before = null, after = null } = {},
) {
  const r = reader(company, viewer, member, show);
  let end = before || "9999";
  const days = [];
  let shown = 0,
    next = null;
  for (let looked = 0; ; looked++) {
    const newest = newestBefore(r, end);
    if (!newest) break;
    const day = dayOf(newest, r.tz);
    const done = after
      ? newest < after || looked >= MOST_DAYS * 4
      : (days.length && shown >= ENOUGH) || looked >= MOST_DAYS;
    if (done) {
      // Nothing between `after` and here: the next page starts where the
      // page on screen said it would.
      const from = after && newest < after ? after : end;
      next = { day, date: dayName(day, r.today), before: from };
      break;
    }
    const start = startOf(day, r.tz);
    const { lines: entries, from } = readDay(
      r,
      day,
      after && after > start ? after : start,
      end,
    );
    end = from;
    // A day whose only rows say again what a decision says has nothing to show.
    if (!entries.length) continue;
    days.push({ day, ...dayHeading(day, r.today), entries });
    shown += entries.length;
  }
  const rows = days
    .flatMap((d) => d.entries)
    .reduce((n, e) => n + (e.items ? e.items.length : 1), 0);
  return {
    days,
    next,
    // A company where hardly anything has happened yet says what will: its
    // whole trail is this first page, and short.
    quiet: show === "everything" && !before && !next && rows <= 5,
    // The clock the days were read on. A log left open over midnight, or
    // when somebody changes the company's time zone, starts again from here.
    today: r.today,
    timezone: r.tz,
  };
}

// An instant, as the page was told it.
const instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/)
  .refine((at) => !Number.isNaN(Date.parse(at)))
  .optional();

export function registerActivity(app) {
  app.get("/api/activity", (req, res) => {
    // The trail names the secrets and the connections, so it is only for
    // somebody who may manage them - the same people who see the tab.
    can(req.member, "integrations");
    const a = z
      .object({
        show: z.enum(SHOW).default("everything"),
        // Where the last page stopped.
        before: instant,
        // Where the first page on screen stopped, to read it again.
        after: instant,
      })
      .parse(req.query);
    res.json(
      activityPage(req.company.id, req.user.id, req.member, {
        show: a.show,
        before: a.before || null,
        after: a.after || null,
      }),
    );
  });
}
