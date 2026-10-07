import React, { useCallback, useEffect, useState } from "react";
import {
  Gauge,
  RefreshCw,
  Play,
  Monitor,
  Info,
  ChevronDown,
  Globe2,
} from "lucide-react";
import { api, Button } from "./ui.jsx";
import { COMPUTER_STARTS_PER_HOUR_PER_COMPUTER } from "../shared/plan.mjs";
import { COMPUTER_IDLE_SECONDS } from "../shared/computer-policy.mjs";
import "./computer-use.css";
import SettingsHead from "./SettingsHead.jsx";

// "3d 4h", "2h 15m", "40m", "42s". Days matter once there are days; minutes
// stop mattering then, because the number they sit under is twenty days.
// Seconds matter only under a minute: a machine plainly running read "0m"
// for its first sixty seconds, which looked like nothing was being counted.
export function duration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return s ? `${s}s` : "0m";
}
// "1 day", not "1 days": a trial has exactly one.
const days = (seconds) => {
  const n = seconds / 86400;
  const text = Number.isInteger(n) ? String(n) : n.toFixed(1);
  return text === "1" ? "1 day" : `${text} days`;
};
const when = (ms) =>
  new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

// One line of the plan against one number of use. The bar fills to the
// limit and stops there; going past it changes the words, not the bar.
function Meter({ label, note, used, limit, render = String }) {
  const share = limit ? used / limit : 0;
  const state = share >= 1 ? "over" : share >= 0.8 ? "near" : "";
  return (
    <li className={"usage-meter " + state}>
      <div className="usage-meter-text">
        <strong>{label}</strong>
        {note && <p>{note}</p>}
      </div>
      <div className="usage-meter-bar">
        <span
          className="usage-bar"
          role="img"
          aria-label={`${render(used)} of ${render(limit)}`}
        >
          <span style={{ width: `${Math.min(100, share * 100)}%` }} />
        </span>
        <small>
          <b>{render(used)}</b> of {render(limit)}
          {state === "over" && " · limit reached"}
        </small>
      </div>
    </li>
  );
}

const gigabytes = (bytes) => {
  const value = Math.max(0, Number(bytes) || 0) / 1e9;
  return value > 0 && value < 0.0001
    ? "<0.0001 GB"
    : value.toLocaleString(undefined, { maximumFractionDigits: 4 }) + " GB";
};

function ProxyUsage({ proxy }) {
  const rows = [...(proxy?.by_duck || [])].sort(
    (a, b) =>
      b.total_bytes - a.total_bytes ||
      (a.duck_name || "").localeCompare(b.duck_name || ""),
  );
  const month = proxy?.month_started
    ? new Date(proxy.month_started).toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      })
    : "This month";
  const hasRecordedUse =
    Number(proxy?.total_bytes || 0) > 0 || rows.length > 0 || proxy?.estimated;

  return (
    <section
      className="settings-card usage-card proxy-usage-card"
      aria-label="Proxy usage"
    >
      <div className="proxy-usage-head">
        <div>
          <h3>Proxy usage</h3>
          <p>{month} (UTC)</p>
        </div>
        <Globe2 size={20} aria-hidden="true" />
      </div>
      <div className="proxy-usage-explainer">
        <p>
          The proxy is an optional alternate internet connection for a Duck’s
          whole computer. Its different IP address may help when a website
          blocks the computer’s usual one.
        </p>
        <p>
          It starts off. Ducks with access can turn it on only when needed and
          should turn it off afterward. It also turns off when their work ends.
        </p>
        <p>
          Usage includes the data apps upload and download through the proxy,
          including pages, images, and files. Direct traffic while it is off is
          excluded. Screen controls and provider disk restoration use the normal
          connection.
        </p>
      </div>
      {!proxy?.configured && !hasRecordedUse ? (
        <div className="proxy-usage-empty">
          Proxy traffic is not enabled for this company.
        </div>
      ) : (
        <>
          {!proxy?.configured && (
            <p className="proxy-usage-state">
              Proxy traffic is not currently enabled. Earlier traffic from this
              month is still shown.
            </p>
          )}
          <dl className="proxy-usage-summary">
            <div>
              <dt>All ducks</dt>
              <dd>{gigabytes(proxy?.total_bytes)}</dd>
            </div>
            <div>
              <dt>Uploaded</dt>
              <dd>{gigabytes(proxy?.upload_bytes)}</dd>
            </div>
            <div>
              <dt>Downloaded</dt>
              <dd>{gigabytes(proxy?.download_bytes)}</dd>
            </div>
          </dl>
          {proxy?.estimated && (
            <p className="proxy-usage-warning" role="status">
              Some proxy usage this month could not be confirmed. These totals
              may be incomplete.
            </p>
          )}
          <h4>By duck</h4>
          {rows.length ? (
            <ul className="proxy-usage-ducks">
              {rows.map((row) => (
                <li key={row.duck_id}>
                  <span className="proxy-duck-name">
                    <strong>{row.duck_name}</strong>
                    {row.estimated && <small>May be incomplete</small>}
                  </span>
                  <span className="proxy-duck-use">
                    <strong>{gigabytes(row.total_bytes)}</strong>
                    <small>
                      {gigabytes(row.upload_bytes)} up ·{" "}
                      {gigabytes(row.download_bytes)} down
                    </small>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="proxy-usage-empty">
              No proxy traffic has been recorded this month.
            </div>
          )}
          <p className="proxy-usage-note">
            Shown in GB for each UTC month. Provider billing may differ from
            these totals.
          </p>
        </>
      )}
    </section>
  );
}

export default function ComputerUse({ company }) {
  const [use, setUse] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const load = useCallback(
    async (signal, quiet = false) => {
      if (!quiet) setBusy(true);
      try {
        const value = await api("/computer-use");
        if (value.company_id !== company.id)
          throw new Error(
            "Your active company changed. Reopen this page to load its use.",
          );
        if (!signal.aborted) {
          setUse(value);
          setError("");
        }
      } catch (e) {
        if (!signal.aborted) setError(e.message);
      } finally {
        if (!signal.aborted) setBusy(false);
      }
    },
    [company.id],
  );
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    // A minute's window moves every second; thirty seconds is close enough
    // for a page somebody is reading rather than watching.
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") load(controller.signal, true);
    }, 30000);
    // A tab in the background is not refreshed, so when it comes back the
    // numbers are as old as the last time it was looked at. Catch up then,
    // rather than making somebody wait for the next tick.
    const onVisible = () => {
      if (document.visibilityState === "visible") load(controller.signal, true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);
  const limits = use?.limits;
  // The same three states the start meters have, for the same reason: past
  // the line should be said in words, not left to a bar that cannot go
  // further than full.
  const allowance = limits?.running_seconds_per_month;
  const runShare = use ? use.running_seconds / allowance : 0;
  // The 1st is midnight where the company is, so it is named on the company's
  // clock too: read on the viewer's, an Amsterdam company's 1 October is
  // "30 September" to somebody looking from New York.
  const resets =
    use &&
    // The time and the zone as well as the day: "1 October" is a different
    // moment for somebody reading this from another country.
    new Date(use.period.end).toLocaleString(undefined, {
      timeZone: use.timezone,
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });
  const runState = runShare >= 1 ? "over" : runShare >= 0.8 ? "near" : "";
  // A trial's time is for its whole week, not for the month, and the page
  // says what the plan has once the trial is over.
  // Its dates are in English, as the billing pages write them: in a Dutch
  // browser the sentence around "dinsdag 13 oktober" is still English.
  const trial = !!use?.period?.trial;
  const after = use?.after_trial;
  const trialDay = (at, time = false) =>
    new Date(at).toLocaleString("en-GB", {
      timeZone: use.timezone,
      weekday: "long",
      day: "numeric",
      month: "long",
      ...(time ? { hour: "2-digit", minute: "2-digit", timeZoneName: "short" } : {}),
    });
  const planStarts = after && trialDay(after.from);
  return (
    <section className="usage-page" aria-label="Computer use">
      <SettingsHead page="usage">
        <Button
          className="secondary"
          disabled={busy}
          onClick={() => load(new AbortController().signal)}
        >
          <RefreshCw size={16} className={busy ? "spin" : ""} />
          {busy ? "Checking…" : "Refresh"}
        </Button>
      </SettingsHead>
      {error && (
        <div className="usage-alert" role="alert">
          {error} {use && "The last loaded numbers are shown below."}
        </div>
      )}
      {!use && !error && (
        <div className="settings-card" role="status">
          Adding up your company’s computer use…
        </div>
      )}
      {use && (
        <>
          {use.blocked && (
            <div className="usage-alert usage-blocked" role="alert">
              <p>{use.blocked.message}</p>
            </div>
          )}
          <div className="usage-overview">
            <div className={"usage-total " + runState}>
              <span className="usage-kicker">
                <Gauge size={19} />
                {trial
                  ? "Running time in the trial, all computers together"
                  : "Running time this month, all computers together"}
              </span>
              <strong>{duration(use.running_seconds)}</strong>
              <span>
                of {days(allowance)} {trial ? "for the whole trial" : "included this month"}
                {runState === "over" && " · limit reached"}
              </span>
              <span
                className="usage-bar"
                role="img"
                aria-label={`${duration(use.running_seconds)} of ${days(allowance)} ${trial ? "in the trial" : "this month"}`}
              >
                <span
                  style={{
                    width: `${Math.min(100, runShare * 100)}%`,
                  }}
                />
              </span>
              <p>
                {!use.first_start
                  ? "No computer has been started yet."
                  : trial
                    ? `The trial ends on ${trialDay(use.period.end, true)}.`
                    : `Resets on ${resets}.`}
              </p>
            </div>
            <div className="usage-facts">
              <div>
                <Play size={20} />
                <span>
                  <strong>{use.starts.total.toLocaleString()}</strong>
                  {use.starts.total === 1 ? "start" : "starts"} all together
                </span>
              </div>
              <div>
                <Monitor size={20} />
                <span>
                  <strong>{use.running_now.toLocaleString()}</strong>
                  running right now
                </span>
              </div>
            </div>
          </div>
          {after && (
            <div className="settings-card usage-card usage-next">
              <h3>After the trial</h3>
              <p>
                The trial has {days(allowance)} of computer time for its whole
                week. From {planStarts}, on the {after.plan} plan:
              </p>
              <ul className="usage-next-list">
                <li>
                  <strong>{days(after.running_seconds_per_month)}</strong>
                  of computer running time a month
                </li>
                <li>
                  <strong>{after.starts_per_day.toLocaleString()}</strong>
                  computer starts a day
                </li>
                <li>
                  <strong>{after.running_at_once.toLocaleString()}</strong>
                  computers running at once
                </li>
              </ul>
            </div>
          )}
          <div className="settings-card usage-card">
            <h3>Starts</h3>
            <p>
              A start is a computer being created or woken. Each window is the
              one just gone: the last sixty seconds, the last hour, the last
              twenty-four hours.
            </p>
            <ul className="usage-meters">
              <Meter
                label="Last minute"
                used={use.starts.minute}
                limit={limits.starts_per_minute}
              />
              <Meter
                label="Last hour"
                used={use.starts.hour}
                limit={limits.starts_per_hour}
              />
              <Meter
                label="Last 24 hours"
                used={use.starts.day}
                limit={limits.starts_per_day}
              />
            </ul>
          </div>
          <ProxyUsage proxy={use.proxy} />
          <details className="settings-card usage-details">
            <summary>
              <Info size={18} />
              <span>How this is counted</span>
              <ChevronDown size={18} />
            </summary>
            <ul className="usage-policy">
              <li>
                A start is counted when a computer is actually created or woken.
                One that was refused, or failed to come up, is not.
              </li>
              <li>
                A computer that stops after {COMPUTER_IDLE_SECONDS / 60} idle
                minutes and is woken again counts as a new start. The one
                exception: woken within moments of stopping, before the stop has
                been recorded, it carries on as the same start.
              </li>
              <li>
                Running time is added up across every computer the company has,
                for this calendar month on your company’s own clock, and
                includes any machine running right now. One that runs across
                midnight on the 1st counts only its hours after it.
              </li>
              <li>
                The starts are counted over the last sixty seconds, sixty
                minutes and twenty-four hours, not the minute, hour or day on
                the clock.
              </li>
              <li>
                One computer started more than{" "}
                {COMPUTER_STARTS_PER_HOUR_PER_COMPUTER} times in an hour is held
                back for a while on its own, because that nearly always means
                something is stuck in a loop. Every other computer carries on.
              </li>
              <li>
                A computer counts as running while the service that hosts it
                keeps confirming it is there, and no single session counts for
                more than a day. Both are so that a fault on our side cannot use
                up your month.
              </li>
            </ul>
          </details>
          <p className="usage-updated">Checked {when(use.now)}</p>
        </>
      )}
    </section>
  );
}
