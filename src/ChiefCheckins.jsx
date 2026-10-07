import React, { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { api } from "./ui.jsx";
import { Switch } from "./Switch.jsx";
import "./chief-checkins.css";

const clock = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const instant = (value, zone) => {
  if (!value) return "Not yet";
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: zone || undefined,
  }).format(date);
};
const statusText = (s) =>
  ({
    checking: "A check is running",
    quiet: "Checked; nothing useful to share",
    suggested: "A suggestion was shared in your Chief chat",
    busy: "Skipped; Chief was busy",
    unchanged: "Checked; nothing new to share",
    unavailable: "Skipped; AI or Chief unavailable or permissions changed",
    paused: "Skipped; workspace is paused",
    missed: "Skipped; scheduled time passed",
    failed: "The last check could not finish",
    incomplete: "The check ended before it finished",
    cancelled: "The check was cancelled",
    dismissed: "Suggestion dismissed",
  })[s] || "No check yet";

export default function ChiefCheckins({ data, action }) {
  const server = data.chief_checkins;
  const [draft, setDraft] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [timeInvalid, setTimeInvalid] = useState(false);
  const settings = draft || server || {};
  useEffect(() => {
    if (!dirty && server) setDraft(server);
  }, [server, dirty]);

  if (!server?.chief_id && !server?.chief_name) return null;

  async function save(patch, key, success) {
    setBusy(key);
    setError("");
    setNotice("");
    const result = await action(() => api("/chief-checkins", "PATCH", patch));
    setBusy("");
    if (result) {
      // Keep a time edit intact when another setting saves or polling refreshes.
      const pendingTimes =
        dirty && !Object.hasOwn(patch, "times") ? settings.times : null;
      setDraft(pendingTimes ? { ...result, times: pendingTimes } : result);
      setDirty(!!pendingTimes);
      setNotice(success || "Saved");
      return true;
    }
    setError("Could not save this setting. Try again.");
    return false;
  }
  async function checkNow() {
    setBusy("check");
    setError("");
    setNotice("");
    try {
      const result = await api("/chief-checkins/check", "POST", {});
      await action(() => Promise.resolve(result));
      if (result.started) setNotice("Check started");
      else setNotice(result.reason || "The check was not started.");
    } catch (e) {
      setError(e.message || "The check could not be started.");
    } finally {
      setBusy("");
    }
  }
  function edit(patch) {
    setDraft((current) => ({ ...(current || server), ...patch }));
    setDirty(true);
  }
  const setCount = async (count) => {
    setTimeInvalid(false);
    const times = (settings.times || []).slice(0, count);
    if (count === 2 && times.length === 1)
      times.push(times[0] === 15 * 60 ? 9 * 60 : 15 * 60);
    await save({ times }, "times-count", "Saved");
  };
  const saveTimes = async (event) => {
    event.preventDefault();
    if (
      timeInvalid ||
      !settings.times?.length ||
      settings.times.some(
        (minute) => !Number.isInteger(minute) || minute < 0 || minute > 1439,
      ) ||
      new Set(settings.times).size !== settings.times.length
    ) {
      setError("Enter a valid, distinct time for each check-in.");
      return;
    }
    await save(
      {
        times: (settings.times || []).slice(
          0,
          settings.times?.length === 1 ? 1 : 2,
        ),
      },
      "times",
      "Times saved",
    );
  };
  const times = settings.times?.length ? settings.times : [9 * 60, 15 * 60];
  const nextCheck = !settings.enabled
    ? "Off"
    : server.next_at
      ? instant(server.next_at, server.timezone)
      : "Unavailable";
  return (
    <section
      className="settings-card chief-checkins"
      aria-labelledby="chief-checkins-title"
    >
      <header className="chief-checkins-head">
        <div>
          <h3 id="chief-checkins-title">Chief Duck check-ins</h3>
          <p id="chief-checkins-help" className="chief-checkins-intro">
            Private suggestions for you. Work starts when you ask.
          </p>
        </div>
        <Switch
          checked={!!settings.enabled}
          disabled={!!busy}
          label="Enable Chief Duck check-ins"
          describedBy="chief-checkins-help"
          onChange={(enabled) =>
            save(
              { enabled },
              "enabled",
              enabled ? "Check-ins enabled" : "Check-ins turned off",
            )
          }
        />
      </header>
      <details className="chief-checkins-about">
        <summary>About check-ins</summary>
        <p>
          This setting is just for you in this company. Check-ins are on by
          default when your Chief has a connected model. They use its assigned
          model, stay quiet when there is nothing useful to share, and never
          take actions for you. You can turn them off here.
        </p>
      </details>
      <div
        className="chief-checkins-schedule"
        aria-disabled={!settings.enabled}
      >
        <div className="chief-checkins-next">
          <span className="chief-checkins-clock" aria-hidden="true">
            <Clock size={18} />
          </span>
          <span>
            <span className="chief-checkins-eyebrow">Next check-in</span>
            <strong>{nextCheck}</strong>
          </span>
        </div>
        <div className="chief-checkins-controls">
          <div className="chief-checkins-control">
            <label htmlFor="chief-checkins-frequency">Frequency</label>
            <select
              id="chief-checkins-frequency"
              aria-label="Check-in frequency"
              value={times.length === 1 ? "once" : "twice"}
              disabled={!settings.enabled || !!busy}
              onChange={(event) =>
                setCount(event.target.value === "once" ? 1 : 2)
              }
            >
              <option value="once">Once a day</option>
              <option value="twice">Twice a day</option>
            </select>
            <form onSubmit={saveTimes}>
              <div className="chief-checkins-time-list">
                {times
                  .slice(0, times.length === 1 ? 1 : 2)
                  .map((value, index) => (
                    <label key={index}>
                      {index ? "Second time" : "First time"}
                      <input
                        aria-label={
                          index ? "Second check-in time" : "First check-in time"
                        }
                        type="time"
                        value={clock(value)}
                        disabled={!settings.enabled || !!busy}
                        onChange={(event) => {
                          if (!event.target.value) {
                            setTimeInvalid(true);
                            return;
                          }
                          const [h, m] = event.target.value
                            .split(":")
                            .map(Number);
                          const next = [...times];
                          next[index] = h * 60 + m;
                          setTimeInvalid(false);
                          edit({ times: next });
                        }}
                      />
                    </label>
                  ))}
              </div>
              {dirty && (
                <button
                  className="button secondary"
                  type="submit"
                  disabled={!!busy || timeInvalid}
                >
                  Save times
                </button>
              )}
              {timeInvalid && (
                <span role="alert">Enter a time before saving.</span>
              )}
            </form>
          </div>
          <div className="chief-checkins-control chief-checkins-days">
            <span className="chief-checkins-field-label">Days</span>
            <label className="chief-checkins-weekdays">
              <input
                type="checkbox"
                checked={!!settings.weekdays_only}
                disabled={!settings.enabled || !!busy}
                onChange={(event) =>
                  save(
                    { weekdays_only: event.target.checked },
                    "weekdays",
                    "Saved",
                  )
                }
              />
              Weekdays only
            </label>
            <span className="chief-checkins-zone">
              {server.timezone || "Workspace default"}
            </span>
          </div>
        </div>
      </div>
      <div className="chief-checkins-meta">
        <div>
          <span>Last check-in</span>
          <strong>{instant(server.last_checked_at, server.timezone)}</strong>
        </div>
        <div>
          <span>Status</span>
          <strong>{statusText(server.last_result)}</strong>
        </div>
      </div>
      <div className="chief-checkins-actions">
        <button
          type="button"
          className="button secondary"
          disabled={!settings.enabled || !!busy}
          onClick={checkNow}
        >
          {busy === "check" ? "Starting check…" : "Check now"}
        </button>
        {notice && <span role="status">{notice}</span>}
        {error && <span role="alert">{error}</span>}
      </div>
    </section>
  );
}
