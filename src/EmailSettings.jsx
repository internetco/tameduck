import React, { useCallback, useEffect, useState } from "react";
import { Mail, Loader2 } from "lucide-react";
import { api } from "./ui.jsx";
import "./duck-permissions.css";
import "./email-settings.css";
import SettingsHead from "./SettingsHead.jsx";

// The product's switch, which is a real tick box drawn as a track and a knob:
// Tab and Space still work and a screen reader still announces on or off. Same
// one the duck permissions table uses, so there is one switch in this product
// rather than two that are nearly alike.
function Switch({ checked, disabled, label, onChange }) {
  return (
    <span className="duck-perms-switch">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="duck-perms-track" aria-hidden="true" />
    </span>
  );
}

// Which emails this person gets.
//
// Per person, not per company: somebody in four companies does not want to
// answer this four times. The switches and the words beside them come from the
// server, so the page and the thing that decides whether to send cannot
// disagree about what somebody just turned off.
//
// Saved on the switch rather than behind a Save button. There is nothing here
// to get half-right, and a settings page that silently keeps a choice nobody
// pressed Save on is the reason people think they turned something off.
export default function EmailSettings() {
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState("");
  const load = useCallback(async () => {
    try {
      setState(await api("/email-settings"));
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function toggle(key, on) {
    const next = { ...state.settings, [key]: on };
    // Moved at once, put back if the server disagrees: a switch that waits for
    // a round trip feels broken on a slow connection.
    setState((s) => ({ ...s, settings: next }));
    setSaving(key);
    setError("");
    try {
      const r = await api("/email-settings", "PUT", next);
      setState((s) => ({ ...s, settings: r.settings }));
    } catch (e) {
      setError(e.message);
      await load();
    } finally {
      setSaving("");
    }
  }

  return (
    <section className="email-settings" aria-label="Emails">
      <SettingsHead page="emails" />
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {!state && !error && (
        <div className="settings-card" role="status">
          <Loader2 size={15} className="spin" /> Reading your settings…
        </div>
      )}
      {state && (
        <>
          <div className="settings-card">
            <ul className="email-kinds">
              {Object.entries(state.kinds).map(([key, kind]) => (
                <li key={key}>
                  <div className="email-kind-text">
                    <strong>{kind.title}</strong>
                    <p>{kind.detail}</p>
                  </div>
                  <Switch
                    checked={!!state.settings[key]}
                    disabled={saving === key}
                    label={kind.title}
                    onChange={(on) => toggle(key, on)}
                  />
                </li>
              ))}
            </ul>
          </div>
          <div className="info-box">
            <Mail size={16} />
            <span>
              Sign-in links are always sent. They are how you get in, so turning
              them off would lock you out of this page as well.
            </span>
          </div>
          <p className="email-note">
            We never email you a chat message. Everything your ducks say is in
            the app, under Needs you.
          </p>
        </>
      )}
    </section>
  );
}
