import React, { useEffect, useId, useRef, useState } from "react";
import { Clock } from "lucide-react";
import { api, Button, Field, useUnsavedGuard } from "./ui.jsx";
import SettingsHead from "./SettingsHead.jsx";
import "./work-limits.css";

const PRESETS = [
  ["0", "Unlimited"],
  ["30", "30 minutes"],
  ["60", "1 hour"],
  ["240", "4 hours"],
  ["480", "8 hours"],
  ["1440", "24 hours"],
];
const MAX_MINUTES = 10080;
const choice = (minutes) =>
  PRESETS.some(([value]) => value === String(minutes))
    ? String(minutes)
    : "custom";
const displayDuration = (minutes) => {
  if (minutes === 0) return "Unlimited";
  if (minutes % 60 === 0)
    return minutes / 60 + (minutes === 60 ? " hour" : " hours");
  if (minutes < 60) return minutes + (minutes === 1 ? " minute" : " minutes");
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return (
    hours +
    (hours === 1 ? " hour" : " hours") +
    (remainder
      ? " and " + remainder + (remainder === 1 ? " minute" : " minutes")
      : "")
  );
};
const fromSettings = (settings) => ({
  auto_resume: settings?.auto_resume !== false,
  run_minutes: choice(settings?.run_minutes ?? 30),
  run_custom:
    settings?.run_minutes != null && choice(settings.run_minutes) === "custom"
      ? String(settings.run_minutes)
      : "",
  ducks: (settings?.ducks || []).map((duck) => ({
    id: duck.id,
    name: duck.name,
    run_minutes: duck.run_minutes == null ? "" : choice(duck.run_minutes),
    run_custom:
      duck.run_minutes != null && choice(duck.run_minutes) === "custom"
        ? String(duck.run_minutes)
        : "",
    effective_minutes: duck.effective_minutes,
    auto_resume: duck.auto_resume == null ? "" : !!duck.auto_resume,
    effective_auto_resume:
      duck.effective_auto_resume == null
        ? settings?.auto_resume !== false
        : !!duck.effective_auto_resume,
  })),
});
const numberValue = (selected, custom) =>
  selected === "custom" ? Number(custom) : Number(selected);
const Options = ({ inherit = false }) => (
  <>
    {inherit && <option value="">Use company default</option>}
    {PRESETS.map(([value, label]) => (
      <option value={value} key={value}>
        {label}
      </option>
    ))}
    <option value="custom">Custom</option>
  </>
);

const ResumeOptions = () => (
  <>
    <option value="">Use company default</option>
    <option value="true">Resume unfinished work</option>
    <option value="false">Leave unfinished work waiting</option>
  </>
);

export default function WorkLimits({ data, action }) {
  const heading = useId();
  const [draft, setDraft] = useState(() => fromSettings(data.work_limits));
  const [busy, setBusy] = useState(false);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [eligible, setEligible] = useState(
    () => data.work_limits?.resume_eligible_count || 0,
  );
  const saved = useRef(JSON.stringify(fromSettings(data.work_limits)));
  const serialized = JSON.stringify(draft);
  const dirty = serialized !== saved.current;
  useUnsavedGuard(() => dirty);
  useEffect(() => {
    if (!resumeBusy) setEligible(data.work_limits?.resume_eligible_count || 0);
  }, [data.work_limits?.resume_eligible_count, resumeBusy]);

  const setCompany = (key, value) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const setDuck = (id, key, value) =>
    setDraft((current) => ({
      ...current,
      ducks: current.ducks.map((duck) =>
        duck.id === id ? { ...duck, [key]: value } : duck,
      ),
    }));

  return (
    <section className="work-limits-page">
      <SettingsHead page="work-limits" />
      <form
        className="settings-card work-limits-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          const sent = {
            auto_resume: draft.auto_resume,
            run_minutes: numberValue(draft.run_minutes, draft.run_custom),
            duck_overrides: draft.ducks.map((duck) => ({
              duck_id: duck.id,
              auto_resume: duck.auto_resume === "" ? null : duck.auto_resume,
              run_minutes:
                duck.run_minutes === ""
                  ? null
                  : numberValue(duck.run_minutes, duck.run_custom),
            })),
          };
          const result = await action(
            () => api("/work-limits", "PATCH", sent),
            "Work limits saved. New runs will use these settings.",
          );
          if (result) {
            const settings = result.work_limits || result;
            const next = fromSettings(settings);
            setDraft(next);
            saved.current = JSON.stringify(next);
            setEligible(settings.resume_eligible_count || 0);
          }
          setBusy(false);
        }}
      >
        <div className="work-limits-section">
          <h3 id={heading}>Company default</h3>
          <label className="work-limits-toggle">
            <input
              type="checkbox"
              checked={draft.auto_resume}
              onChange={(event) =>
                setCompany("auto_resume", event.target.checked)
              }
            />
            <span>Resume unfinished work automatically</span>
          </label>
          <p>
            A run's limit counts active work and pauses while it waits for a
            person or helper. Each helper uses its own duck's limit. Changes to
            time limits apply to new runs; existing runs keep the limit they
            started with, including after a pause. Connection and individual
            action safeguards still apply.
          </p>
          <p>
            When automatic resume is on, unfinished work is checked after 1, 5,
            and 15 minutes, up to 3 attempts. It pauses for a human answer, a
            stopped run, or a work limit.
          </p>
          <p>
            Saving automatic resume on does not restart work already held. The
            Resume button below only releases tasks held because automatic
            resume was off, within their original allowance. Deliberate stops,
            approvals, and human input remain held.
          </p>
          <Field
            label="Longest run"
            hint="Unlimited removes the overall time limit for a run."
          >
            <select
              value={draft.run_minutes}
              onChange={(event) =>
                setCompany("run_minutes", event.target.value)
              }
            >
              <Options />
            </select>
          </Field>
          {draft.run_minutes === "custom" && (
            <Field
              label="Custom company limit, in minutes"
              hint={
                "Enter 1 to " + MAX_MINUTES + " minutes. That is up to 7 days."
              }
            >
              <input
                type="number"
                min="1"
                max={MAX_MINUTES}
                step="1"
                required
                value={draft.run_custom}
                onChange={(event) =>
                  setCompany("run_custom", event.target.value)
                }
              />
            </Field>
          )}
        </div>

        <div
          className="work-limits-section"
          aria-labelledby={heading + "-ducks"}
        >
          <h3 id={heading + "-ducks"}>Different limits for a duck</h3>
          <p>Leave a duck on the company default, or set its own limit.</p>
          <div className="work-limits-ducks">
            {draft.ducks.map((duck) => {
              const effectiveChoice =
                duck.run_minutes === "" ? draft.run_minutes : duck.run_minutes;
              const effectiveCustom =
                duck.run_minutes === "" ? draft.run_custom : duck.run_custom;
              const effective = numberValue(effectiveChoice, effectiveCustom);
              const validEffective =
                Number.isInteger(effective) &&
                (effectiveChoice === "custom"
                  ? effective >= 1
                  : effective >= 0) &&
                effective <= MAX_MINUTES;
              return (
                <div className="work-limits-duck" key={duck.id}>
                  <Field label={duck.name + " can work for"}>
                    <select
                      value={duck.run_minutes}
                      onChange={(event) =>
                        setDuck(duck.id, "run_minutes", event.target.value)
                      }
                    >
                      <Options inherit />
                    </select>
                  </Field>
                  <Field label={duck.name + " resumes unfinished work"}>
                    <select
                      value={String(duck.auto_resume)}
                      onChange={(event) =>
                        setDuck(
                          duck.id,
                          "auto_resume",
                          event.target.value === ""
                            ? ""
                            : event.target.value === "true",
                        )
                      }
                    >
                      <ResumeOptions />
                    </select>
                  </Field>
                  {duck.run_minutes === "custom" && (
                    <Field
                      label={"Custom limit for " + duck.name + ", in minutes"}
                    >
                      <input
                        type="number"
                        min="1"
                        max={MAX_MINUTES}
                        step="1"
                        required
                        value={duck.run_custom}
                        onChange={(event) =>
                          setDuck(duck.id, "run_custom", event.target.value)
                        }
                      />
                    </Field>
                  )}
                  <p className="work-limits-effective">
                    <Clock size={15} aria-hidden="true" />
                    <span>
                      Effective limit:{" "}
                      {validEffective
                        ? displayDuration(effective)
                        : "Enter a limit"}{" "}
                      per run.
                      {(
                        duck.auto_resume === ""
                          ? draft.auto_resume
                          : duck.auto_resume
                      )
                        ? " Unfinished work resumes automatically."
                        : " Unfinished work stays waiting."}
                    </span>
                  </p>
                </div>
              );
            })}
            {!draft.ducks.length && (
              <p className="muted">There are no ducks in this company yet.</p>
            )}
          </div>
        </div>

        <div
          className={
            "work-limits-save" + (dirty || eligible > 0 ? " is-sticky" : "")
          }
          role="status"
          aria-live="polite"
        >
          <span className="work-limits-unsaved">
            {dirty ? "Unsaved changes" : "All changes saved"}
          </span>
          <div className="work-limits-actions">
            {dirty && eligible > 0 && (
              <span className="work-limits-save-hint">
                Save first to resume waiting work.
              </span>
            )}
            {eligible > 0 && (
              <Button
                type="button"
                className="secondary"
                disabled={dirty || busy || resumeBusy}
                busy={resumeBusy}
                title={dirty ? "Save first to resume waiting work" : undefined}
                onClick={async () => {
                  if (dirty || busy || resumeBusy) return;
                  setResumeBusy(true);
                  const result = await action(
                    () => api("/work-limits/resume", "POST"),
                    (response) =>
                      response.resumed
                        ? `Scheduled ${response.resumed} waiting ${response.resumed === 1 ? "task" : "tasks"} to resume.`
                        : "No waiting work was eligible to resume.",
                  );
                  if (result) {
                    const settings = result.work_limits || result;
                    setEligible(settings.resume_eligible_count || 0);
                  }
                  setResumeBusy(false);
                }}
              >
                Resume {eligible} waiting {eligible === 1 ? "task" : "tasks"}
              </Button>
            )}
            <Button type="submit" busy={busy} disabled={!dirty || resumeBusy}>
              Save work limits
            </Button>
          </div>
        </div>
      </form>
    </section>
  );
}
