import React from "react";
import { MessageSquare, Loader2, Monitor } from "lucide-react";
import { Button, Markdown } from "./ui.jsx";
import { HumanInputCard } from "./HumanInput.jsx";
import { ToolAskCard } from "./AskCard.jsx";
import { Terminal } from "./Terminal.jsx";
import "./duck-consultations.css";

const statusText = {
  waiting: "Queued",
  running: "Working on your request",
  answered: "Answer received",
  failed: "Could not answer",
  timed_out: "Wait ended",
  cancelled: "Cancelled",
};
export function DuckConsultations({ items = [], data, action, go, showHumanRequests = false }) {
  if (!items.length) return null;
  const pendingCount = items.filter((item) =>
    ["waiting", "running"].includes(item.status),
  ).length;
  return (
    <div className="duck-consultations" aria-label="Requests to other ducks">
      {pendingCount > 1 && (
        <p className="duck-consultation-progress" role="status">
          Waiting for {pendingCount} ducks. Replies are collected here as they finish.
        </p>
      )}
      {items.map((c) => {
        const target =
          c.to_duck_name ||
          data.ducks?.find((d) => d.id === c.to_duck_id)?.name ||
          "another duck";
        const pending = ["waiting", "running"].includes(c.status);
        const approval = (data.approvals || []).find((item) => item.job_id === c.child_job_id && ["pending", "executing"].includes(item.status));
        const status = !pending ? statusText[c.status] :
          approval ? (approval.status === "executing" ? "Running approved action" : "Waiting for approval") :
          c.child_status === "waiting_human" ? "Needs your input" :
          c.child_status === "queued" ? "Queued · waiting for availability" :
          statusText[c.status];
        const computer = data.computers?.items?.find((item) => item.id === c.computer_id);
        const typed = computer && data.terminal_jobs?.includes(c.child_job_id);
        const usedDesktop = computer && data.desktop_jobs?.includes(c.child_job_id);
        // The helper's tool asks for this run, answered here: a card while it
        // waits, the line it folds to after. It used to be a button that
        // jumped to Needs you.
        const asks = (data.approvals || []).filter(
          (item) => item.job_id === c.child_job_id,
        );
        const requests = showHumanRequests
          ? (data.human_requests || []).filter((request) => request.job_id === c.child_job_id)
          : [];
        return (
          <div className="duck-consultation-item" key={c.id}>
          <details className="duck-consultation">
            <summary>
              {pending ? (
                <Loader2 size={16} className="spin" aria-hidden="true" />
              ) : (
                <MessageSquare size={16} aria-hidden="true" />
              )}
              <span>
                <strong>Asked {target}</strong>
                <small>{status || "Waiting for answer"}</small>
              </span>
            </summary>
            <div className="duck-consultation-content">
              <h4>Request</h4>
              <Markdown>{c.question}</Markdown>
              {c.answer && (
                <>
                  <h4>Answer from {target}</h4>
                  <Markdown>{c.answer}</Markdown>
                </>
              )}
              {c.error && <p className="muted">{c.error}</p>}
              {typed && <Terminal computer={computer.id} job={c.child_job_id} name={target} live={c.child_status === "running"} />}
              {usedDesktop && go && (
                <Button type="button" className="secondary small" onClick={() => go({ type: "computers", id: computer.id, control: true })}>
                  <Monitor size={15} /> View {target}'s screen
                </Button>
              )}
              {pending && (
                <p className="muted">
                  {pendingCount > 1
                    ? "The asking duck will continue when all outstanding requests finish."
                    : "The asking duck will continue automatically when this work finishes."}
                </p>
              )}
            </div>
          </details>
          {asks.map((ask) => <ToolAskCard key={ask.id} approval={ask} data={data} action={action} go={go} />)}
          {requests.map((request) => <HumanInputCard key={request.id} request={request} data={data} action={action} go={go} showDuck />)}
          </div>
        );
      })}
    </div>
  );
}
