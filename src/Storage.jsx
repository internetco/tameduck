import React, { useCallback, useEffect, useState } from "react";
import {
  HardDrive,
  RefreshCw,
  MessageSquare,
  Files,
  Database,
  ChevronDown,
  Info,
  Clock3,
} from "lucide-react";
import { api, Button } from "./ui.jsx";
import "./storage.css";
import SettingsHead from "./SettingsHead.jsx";

export function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log10(bytes) / 3), units.length - 1);
  return (
    new Intl.NumberFormat(undefined, {
      maximumFractionDigits: index ? 2 : 0,
    }).format(bytes / 1000 ** index) +
    " " +
    units[index]
  );
}
const countLabel = (category) => {
  const singular = {
    messages: "message",
    chats: "chat",
    documents: "document",
    files: "file",
    images: "image",
    tasks: "task",
    records: "record",
    "skills and versions": "skill or saved version",
    "secrets and connections": "secret or connection",
    "activity entries": "activity entry",
  };
  return (
    category.count.toLocaleString() +
    " " +
    (category.count === 1
      ? singular[category.unit] || category.unit
      : category.unit)
  );
};
const exact = (bytes) => new Intl.NumberFormat().format(bytes) + " bytes";
const date = (value) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
const colors = [
  "var(--blue)",
  "var(--green)",
  "#e29313",
  "#9862e9",
  "#e7567d",
  "#10a6aa",
  "#bd7536",
  "#707eda",
  "#4b98b1",
  "#a4864c",
  "#c2508f",
  "var(--muted)",
];

export default function Storage({ company }) {
  const [usage, setUsage] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const load = useCallback(
    async (signal, quiet = false) => {
      if (!quiet) setBusy(true);
      try {
        const value = await api("/storage");
        if (value.company_id !== company.id)
          throw new Error(
            "Your active company changed. Reopen Storage to load its usage.",
          );
        if (!signal.aborted) {
          setUsage(value);
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
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") load(controller.signal, true);
    }, 30000);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [load]);
  const workspace =
    usage?.breakdown.filter((c) => c.scope === "workspace") || [];
  const supporting =
    usage?.breakdown.filter((c) => c.scope === "supporting") || [];
  const message = workspace.find((c) => c.id === "messages");
  const files = workspace
    .filter((c) =>
      [
        "documents",
        "uploads",
        "duck_files",
        "skills",
        "screenshots",
        "files",
      ].includes(c.id),
    )
    .reduce((n, c) => n + c.count, 0);
  return (
    <section className="storage-page" aria-label="Company storage">
      <SettingsHead page="storage">
        <Button
          className="secondary"
          disabled={busy}
          onClick={() => load(new AbortController().signal)}
        >
          <RefreshCw size={16} className={busy ? "spin" : ""} />
          {busy ? "Checking…" : "Refresh usage"}
        </Button>
      </SettingsHead>
      {error && (
        <div className="storage-alert" role="alert">
          {error} {usage && "The last loaded totals are shown below."}
        </div>
      )}
      {!usage && !error && (
        <div className="settings-card" role="status">
          Measuring your company’s storage…
        </div>
      )}
      {usage && (
        <>
          {usage.warning && (
            <div className="storage-alert" role="alert">
              {usage.warning}
            </div>
          )}
          <div className="storage-overview">
            <div className="storage-total">
              <span className="storage-kicker">
                <HardDrive size={19} />
                Workspace storage
              </span>
              <strong title={exact(usage.workspace_bytes)}>
                {formatBytes(usage.workspace_bytes)}
              </strong>
              <span>{company.name}</span>
              <p>Usage tracking is on. No storage charges are applied.</p>
            </div>
            <div className="storage-facts">
              <div>
                <MessageSquare size={20} />
                <span>
                  <strong>{(message?.count || 0).toLocaleString()}</strong>
                  messages saved
                </span>
              </div>
              <div>
                <Files size={20} />
                <span>
                  <strong>{files.toLocaleString()}</strong>files, images & saved
                  versions
                </span>
              </div>
              <div>
                <Clock3 size={20} />
                <span>
                  <strong>Hourly</strong>usage history saved
                </span>
              </div>
            </div>
          </div>
          <div className="settings-card storage-breakdown">
            <div className="storage-section-heading">
              <h3>Where your space goes</h3>
              <span title={exact(usage.workspace_bytes)}>
                {formatBytes(usage.workspace_bytes)} total
              </span>
            </div>
            <div
              className="storage-bar"
              role="img"
              aria-label="Storage distribution by category; amounts are listed below"
            >
              {workspace
                .filter((c) => c.bytes > 0)
                .map((c) => (
                  <span
                    key={c.id}
                    style={{
                      width: `${(c.bytes / usage.workspace_bytes) * 100}%`,
                      background: colors[workspace.indexOf(c)],
                    }}
                    title={`${c.label}: ${formatBytes(c.bytes)}`}
                  />
                ))}
            </div>
            <ul className="storage-rows">
              {workspace.map((c, i) => (
                <li key={c.id}>
                  <span
                    className="storage-dot"
                    style={{ background: colors[i] }}
                  />
                  <div className="storage-category">
                    <strong>{c.label}</strong>
                    <p>{c.description}</p>
                    <small>{countLabel(c)}</small>
                  </div>
                  <div className="storage-amount" title={exact(c.bytes)}>
                    <strong>{formatBytes(c.bytes)}</strong>
                    <small>
                      {usage.workspace_bytes && c.bytes
                        ? (c.bytes / usage.workspace_bytes) * 100 < 0.1
                          ? "< 0.1"
                          : ((c.bytes / usage.workspace_bytes) * 100).toFixed(1)
                        : "0"}
                      %
                    </small>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <details className="settings-card storage-details">
            <summary>
              <Database size={18} />
              <span>
                Supporting storage <small>Separate from workspace usage</small>
              </span>
              <strong title={exact(usage.supporting_bytes)}>
                {formatBytes(usage.supporting_bytes)}
              </strong>
              <ChevronDown size={18} />
            </summary>
            <p>
              These files support the service. We measure them separately so
              software caches and duplicate duck files don’t inflate your
              workspace usage.
            </p>
            <ul className="storage-rows">
              {supporting.map((c) => (
                <li key={c.id}>
                  <div className="storage-category">
                    <strong>{c.label}</strong>
                    <p>{c.description}</p>
                    <small>{countLabel(c)}</small>
                  </div>
                  <strong className="storage-amount" title={exact(c.bytes)}>
                    {formatBytes(c.bytes)}
                  </strong>
                </li>
              ))}
            </ul>
          </details>
          <details className="settings-card storage-details">
            <summary>
              <Clock3 size={18} />
              <span>
                Usage history <small>Latest 24 hourly measurements</small>
              </span>
              <ChevronDown size={18} />
            </summary>
            <p>
              Tracking started {date(usage.tracking_started_at)}. Earlier usage
              cannot be reconstructed. History records the first successful
              measurement each hour.
            </p>
            {usage.history.length ? (
              <div className="storage-history">
                <table>
                  <thead>
                    <tr>
                      <th>Measured</th>
                      <th>Workspace</th>
                      <th>Supporting</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...usage.history].reverse().map((h) => (
                      <tr key={h.period}>
                        <td>{date(h.observed_at)}</td>
                        <td title={exact(h.workspace_bytes)}>
                          {formatBytes(h.workspace_bytes)}
                        </td>
                        <td title={exact(h.supporting_bytes)}>
                          {formatBytes(h.supporting_bytes)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p>
                The first measurement will appear after your saved files have
                been checked.
              </p>
            )}
          </details>
          <details className="settings-card storage-details">
            <summary>
              <Info size={18} />
              <span>How storage is measured</span>
              <ChevronDown size={18} />
            </summary>
            <ul className="storage-policy">
              <li>
                Text and record details use their saved UTF-8 byte lengths.
                Files use their saved byte lengths. Encrypted content includes
                its stored encoding.
              </li>
              <li>
                Messages, chats and files are tracked individually. Changes to
                records update usage immediately; saved files are checked in the
                background every five minutes and when you open this page.
              </li>
              <li>
                Uploaded files count their encrypted stored size the moment an
                upload finishes, and deleting a file releases it right away.
                Files that were uploaded but never sent are removed after a day.
              </li>
              <li>
                Attaching a document or screenshot again adds only a reference.
                Its contents stay counted once. A latest computer preview and a
                saved chat capture are separate retained images.
              </li>
              <li>
                Archived chats still count because their history remains saved.
                Editing replaces the current size; retained skill versions
                continue to count.
              </li>
              <li>
                Supporting storage is listed separately. Shared database
                overhead, backups and files inside remote computers are
                excluded. Remote computers are never started to measure this
                page.
              </li>
              <li>
                Units are decimal: 1 KB = 1,000 bytes. Future storage pricing
                and allowances have not been set.
              </li>
            </ul>
          </details>
          <p className="storage-updated">
            Records checked {date(usage.measured_at)} · Saved files{" "}
            {usage.files_checked_at
              ? `checked ${date(usage.files_checked_at)}`
              : "awaiting their first check"}
          </p>
        </>
      )}
    </section>
  );
}
