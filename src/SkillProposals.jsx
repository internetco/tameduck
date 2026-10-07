import React, { useEffect, useState } from "react";
import { api, Avatar, Modal } from "./ui.jsx";
import { AskCard } from "./AskCard.jsx";
import { askTitle } from "./inbox-list.mjs";
import { cannot, folded, skillLines, toast } from "./ask-words.mjs";
import { openUntil } from "./schedule-proposal-words.mjs";
import "./skill-proposals.css";

const statusLabels = {
  pending: "Needs approval",
  applied: "Approved",
  denied: "Declined",
  changes_requested: "Changes requested",
  superseded: "Replaced",
  expired: "Expired",
};
// Chief asking to add a skill, or to give one to more ducks. It used to say
// only "Nothing changes until you approve" and keep the decision in a dialog
// of four same-size buttons; now the card says what the skill is for and who
// gets it, and is answered where it is. The dialog shows everything else.
// head: in the Needs you list the line above the card is its heading, so there
// the card leaves its own off. Everywhere else keeps it.
export function SkillProposalCard({
  proposal: p,
  data,
  action,
  go,
  head = true,
}) {
  const [review, setReview] = useState(false);
  const chief =
    data.ducks.find((d) => d.id === p.duck_id)?.name || "Chief Duck";
  const title = askTitle("skill", p);
  const allowed =
    data.permissions.skills &&
    data.permissions.ducks &&
    data.permissions.approvals;
  const words = {
    me: data.user?.id,
    duck: chief,
    exists: (data.skills || []).some((s) => s.id === p.result_skill_id),
  };
  return (
    <>
      <AskCard
        title={title}
        head={head}
        lines={skillLines(p)}
        more={{ label: "See all settings", onClick: () => setReview(true) }}
        askee={chief}
        until={p.expires && openUntil(p.expires)}
        refusal={allowed ? null : cannot("skill")}
        done={p.status === "pending" ? null : folded("skill", p, words)}
        lapse={folded("skill", { ...p, status: "expired" }, words)}
        expires={p.expires}
        decide={(decision, { note }) =>
          api("/skill-proposals/" + p.id + "/decide", "POST", {
            decision,
            fingerprint: p.fingerprint,
            ...(decision === "changes" ? { feedback: note } : {}),
          })
        }
        said={(decision) => toast(decision, title, { duck: chief })}
        action={action}
        go={go}
      />
      {review && (
        <SkillProposalReview
          proposal={p}
          data={data}
          onClose={() => setReview(false)}
        />
      )}
    </>
  );
}
// Everything Chief prepared, to read. The card decides; this only shows.
function SkillProposalReview({ proposal, data, onClose }) {
  const [detail, setDetail] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setDetail(null);
    setError("");
    api("/skill-proposals/" + proposal.id)
      .then((d) => {
        if (current) setDetail(d);
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [proposal.id, proposal.status, proposal.fingerprint]);
  const pending = proposal.status === "pending" && detail?.status === "pending";
  const config = detail?.configuration,
    skill = config?.skill;
  return (
    <Modal title="All settings" wide onClose={onClose}>
      {error && <p role="alert">{error}</p>}
      {!detail && !error && <p>Loading complete configuration…</p>}
      {skill && (
        <div className="skill-proposal-review">
          <p className="muted">
            {detail.company_name} ·{" "}
            {detail.operation === "create"
              ? "Create a new skill and assign it"
              : "Add assignments to an existing skill"}
          </p>
          <dl className="skill-proposal-details">
            <div>
              <dt>Skill name</dt>
              <dd>{skill.name}</dd>
            </div>
            <div>
              <dt>When to use it</dt>
              <dd>{skill.description || "No description"}</dd>
            </div>
            <div>
              <dt>Enabled for assigned ducks</dt>
              <dd>{skill.enabled ? "Yes" : "No — saved disabled"}</dd>
            </div>
            {skill.version && (
              <div>
                <dt>Existing skill version</dt>
                <dd>{skill.version}</dd>
              </div>
            )}
          </dl>
          <h3>Complete instructions</h3>
          <pre className="skill-proposal-instructions">{skill.content}</pre>
          <h3>
            {detail.operation === "assign"
              ? "All assigned ducks after approval"
              : "Ducks to assign"}
          </h3>
          <ul className="skill-proposal-ducks">
            {config.ducks.map((d) => (
              <li key={d.id}>
                <Avatar
                  duck={data.ducks.find((x) => x.id === d.id)}
                  name={d.name}
                  size={32}
                />
                <div>
                  <strong>{d.name}</strong>
                  <small>{d.role}</small>
                </div>
                <span className="pill">
                  {config.existing?.ducks.includes(d.id)
                    ? "Already assigned"
                    : "New assignment"}
                </span>
              </li>
            ))}
          </ul>
          <p className="skill-proposal-effect">
            {skill.enabled
              ? "After approval, these ducks can read and use this skill when they next work. This does not start a task."
              : "After approval, the skill will be linked to these ducks but will remain disabled."}{" "}
            {detail.operation === "assign" &&
              "Existing instructions and other assignments are preserved."}{" "}
            Company rules and permissions still apply.
          </p>
          {/* How long it stays open, the way the card says it. Once decided
              the status line below says what became of it. */}
          {pending && <p className="muted">{openUntil(detail.expires)}</p>}
          {detail.feedback && (
            <p>
              <strong>Requested changes:</strong> {detail.feedback}
            </p>
          )}
          {!pending && (
            <p role="status">
              <strong>{statusLabels[detail.status] || detail.status}.</strong>{" "}
              {detail.status === "applied"
                ? "This exact configuration was approved."
                : "This proposal is no longer awaiting approval."}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
