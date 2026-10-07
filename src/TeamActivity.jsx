import React, { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Clock,
  CircleHelp,
  ListTodo,
  Play,
  ShieldCheck,
  Users,
} from "lucide-react";
import { Avatar, Button, Markdown, flock } from "./ui.jsx";
import { ChatArtifacts } from "./Attachments.jsx";
import { DuckConsultations } from "./DuckConsultations.jsx";
import { activityAge, activityLabel } from "./duck-activity.mjs";
import "./team-activity.css";

const icons = {
  working: Play,
  queued: ListTodo,
  waiting_duck: Users,
  needs_you: CircleHelp,
  waiting_approval: ShieldCheck,
};

function ActivityItem({
  item,
  duck,
  data,
  action,
  go,
  setModal,
  notify,
  current,
}) {
  const Icon = icons[item.state] || Clock;
  const age = activityAge(item.updated, current);
  const statusLabel = activityLabel(item);
  const sameText = (left, right) =>
    String(left || "")
      .replace(/[.!]+$/, "")
      .toLowerCase() ===
    String(right || "")
      .replace(/[.!]+$/, "")
      .toLowerCase();
  const incoming = (item.consultations || []).filter(
    (c) => c.to_duck_id === duck.id && c.from_duck_id !== duck.id,
  );
  const outgoing = (item.consultations || []).filter(
    (c) => c.from_duck_id === duck.id,
  );
  const sharedArtifacts = (item.artifacts || []).filter((a) =>
    ["document", "file"].includes(a.kind),
  );
  const details =
    item.consultations?.length || sharedArtifacts.length || item.parent_duck;
  const screenRequest = (data.human_requests || []).some(
    (r) =>
      r.job_id === item.job_id &&
      ["pending", "preparing", "desktop", "submitting"].includes(r.status) &&
      r.expires > current,
  );
  const needsInbox = item.state === "waiting_approval" || screenRequest;
  const destination = needsInbox ? { type: "inbox" } : item.destination;
  const label = needsInbox
    ? "Review request"
    : item.state === "needs_you"
      ? "Answer"
      : destination?.type === "tasks"
        ? "Open ticket"
        : "Open chat";
  const conversation = data.conversations?.find(
    (c) => c.id === item.destination?.id,
  );
  return (
    <li className="team-task" aria-label={`${duck.name}: ${item.title}`}>
      <div className="team-task-main">
        <div className="team-task-copy">
          <span className={"team-task-state " + item.state}>
            <Icon size={15} aria-hidden="true" />
            {statusLabel}
          </span>
          <h3>{item.title}</h3>
          {item.parent_duck && (
            <p className="team-task-for">Helping {item.parent_duck.name}</p>
          )}
          {item.latest_action && !sameText(item.latest_action, statusLabel) && (
            <p>{item.latest_action}</p>
          )}
          {item.blocking_reason &&
            !sameText(item.blocking_reason, item.latest_action) &&
            !sameText(item.blocking_reason, statusLabel) && (
              <p className="team-task-blocker">{item.blocking_reason}</p>
            )}
          {item.state === "waiting_duck" && (
            <p className="team-task-next">
              Continues automatically when the requested work finishes.
            </p>
          )}
          {age && (
            <time
              dateTime={item.updated}
              title={new Date(item.updated).toLocaleString()}
            >
              Updated {age}
            </time>
          )}
        </div>
        {destination && (
          <Button
            type="button"
            className="secondary small team-task-open"
            onClick={() => go(destination)}
          >
            {label}
            <ArrowUpRight size={14} />
          </Button>
        )}
      </div>
      {!!details && (
        <details className="team-task-details">
          <summary>View activity</summary>
          <div>
            <DuckConsultations
              items={outgoing}
              data={data}
              action={action}
              go={go}
              showHumanRequests
            />
            {incoming.map((request) => (
              <section key={request.id} className="team-task-request">
                <h4>Requested by {item.parent_duck?.name || "another duck"}</h4>
                <Markdown>{request.question}</Markdown>
                {request.answer && (
                  <>
                    <h4>Returned answer</h4>
                    <Markdown>{request.answer}</Markdown>
                  </>
                )}
              </section>
            ))}
            {!item.consultations?.length && item.parent_duck && (
              <p className="muted">
                Requested by {item.parent_duck.name}. Its conversation or ticket
                contains the full handoff.
              </p>
            )}
            {!!sharedArtifacts.length && (
              <section
                className="team-task-documents"
                aria-label="Shared documents and files"
              >
                <h4>Documents & files</h4>
                <ChatArtifacts
                  items={sharedArtifacts}
                  changesEndpoint={
                    item.destination?.type === "tasks"
                      ? (a) =>
                          "/tasks/" +
                          item.destination.id +
                          "/artifacts/" +
                          a.id +
                          "/changes"
                      : undefined
                  }
                  data={data}
                  action={action}
                  go={go}
                  setModal={setModal}
                  notify={notify}
                  conversation={conversation}
                  threadId={item.destination?.threadId}
                />
              </section>
            )}
          </div>
        </details>
      )}
    </li>
  );
}

export function TeamActivity({
  data,
  action,
  go,
  setModal,
  notify,
  focusDuckId,
}) {
  const [current, setCurrent] = useState(Date.now());
  const cards = useRef({});
  useEffect(() => {
    const timer = setInterval(() => setCurrent(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    cards.current[focusDuckId]?.scrollIntoView({ block: "nearest" });
  }, [focusDuckId]);
  const entries = new Map(
    (data.duck_activity || []).map((entry) => [entry.duck_id, entry]),
  );
  const activeDucks = flock(data).filter(
    (duck) => entries.get(duck.id)?.items.length,
  );
  return (
    <div className="team-activity">
      <div className="page-heading">
        <div>
          <h2>Live activity</h2>
          <p>What your ducks are doing, and what they’re waiting for.</p>
        </div>
      </div>
      <p className="team-activity-scope">
        Showing work you can access. A duck’s tasks are listed separately.
      </p>
      {!Array.isArray(data.duck_activity) ? (
        <p role="status">Activity is unavailable. Refresh to try again.</p>
      ) : (
        <div className="team-activity-list">
          {!activeDucks.length && <p className="muted">No work to show.</p>}
          {activeDucks.map((duck) => {
            const items = entries.get(duck.id)?.items || [];
            return (
              <section
                key={duck.id}
                ref={(element) => {
                  cards.current[duck.id] = element;
                }}
                className={
                  "team-duck-activity" +
                  (focusDuckId === duck.id ? " focused" : "")
                }
                aria-label={`${duck.name} activity`}
              >
                <header>
                  <Avatar duck={duck} size={36} />
                  <div>
                    <h2>{duck.name}</h2>
                    <span>
                      {items.length
                        ? `${items.length} ${items.length === 1 ? "task" : "tasks"}`
                        : "No active tasks"}
                    </span>
                  </div>
                </header>
                {items.length ? (
                  <ul className="team-task-list">
                    {items.map((item) => (
                      <ActivityItem
                        key={item.id}
                        item={item}
                        duck={duck}
                        data={data}
                        action={action}
                        go={go}
                        setModal={setModal}
                        notify={notify}
                        current={current}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="team-duck-empty">
                    No active tasks you can view.
                  </p>
                )}
              </section>
            );
          })}
          {!flock(data).length && (
            <p className="muted">
              Add a duck in Ducks &amp; people to get started.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
