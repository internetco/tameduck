import React, { useEffect, useRef, useState } from "react";
import {
  Check,
  Download,
  KeyRound,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { api, Button, CopyButton, Field, Modal } from "./ui.jsx";
import "./two-step.css";

// Fewer backup codes than this, and the card says to get new ones before they
// run out: with none left and no phone there is no way in but the owner.
const FEW = 3;

// The picture an authenticator app's camera reads. The server sends the
// squares as one SVG path, so there is no image to fetch and nothing to run.
// Always black on white, whatever the theme: that is what a camera expects.
function QrCode({ qr }) {
  return (
    <svg
      className="two-step-qr"
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR code to scan with your authenticator app"
    >
      <rect width={qr.size} height={qr.size} fill="#fff" />
      <path d={qr.path} fill="#000" />
    </svg>
  );
}

// One box for a code from the app or a backup code: six digits is the app's,
// anything else is a backup code.
const answerFrom = (form) => {
  const typed = String(new FormData(form).get("code") || "");
  return /^\d{6}$/.test(typed.replace(/\s/g, ""))
    ? { code: typed }
    : { backup: typed };
};

// Settings > Your account > Two-step sign-in. Turning it on is three steps
// on one card - scan, type a code, save the backup codes - and it only counts
// once the code from the app has been typed back, so a key that never reached
// the phone cannot lock anybody out.
export default function TwoStep({ info, notify, reload }) {
  const [setup, setSetup] = useState(null),
    // { list, first }: first is the codes shown as it is turned on.
    [codes, setCodes] = useState(null),
    // "off" or "codes": which of the two things that need a code is asked.
    [asking, setAsking] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const on = info.two_step;
  const steps = useRef(null);
  const typed = useRef(null);
  const turnOn = useRef(null);
  const justOff = useRef(false);
  const newCodes = useRef(null);
  const [stale, setStale] = useState(false);

  // Pressing Turn on takes that button away. Without this the keyboard fell
  // back to the top of the page, a whole sidebar away from the first step.
  useEffect(() => {
    if (setup) steps.current?.focus();
  }, [setup]);
  // The same after Turn off: the button pressed is gone once it is off, and
  // the keyboard was left at the top of the page, some thirty Tabs away.
  useEffect(() => {
    if (!on && justOff.current) {
      justOff.current = false;
      turnOn.current?.focus();
    }
  }, [on]);
  // After a wrong code, back to the box with what was typed selected, ready
  // for the next one. The busy button had taken the keyboard with it, which
  // on a phone also closed the on-screen keyboard.
  const again = () => {
    typed.current?.focus();
    typed.current?.select();
  };

  async function start() {
    setBusy(true);
    setError("");
    setStale(false);
    try {
      setSetup(await api("/account/two-step/start", "POST", {}));
    } catch (e) {
      setError(e.message);
      setStale(e.status === 403);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api("/account/two-step/confirm", "POST", {
        code: new FormData(e.currentTarget).get("code"),
      });
      setSetup(null);
      setCodes({ list: r.codes, first: true });
      reload();
    } catch (err) {
      setError(err.message);
      again();
    } finally {
      setBusy(false);
    }
  }

  async function withCode(e) {
    e.preventDefault();
    const answer = answerFrom(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      if (asking === "off") {
        await api("/account/two-step/off", "POST", answer);
        justOff.current = true;
        setAsking(null);
        notify("Two-step sign-in is off.");
      } else {
        const r = await api("/account/two-step/backup-codes", "POST", answer);
        setAsking(null);
        setCodes({ list: r.codes, first: false });
      }
      reload();
    } catch (err) {
      setError(err.message);
      again();
    } finally {
      setBusy(false);
    }
  }

  const stop = () => {
    setSetup(null);
    setAsking(null);
    setError("");
  };
  const ask = (what) => {
    setError("");
    setAsking(what);
  };
  const saved = codes && codes.list.join("\n") + "\n";
  // Closing the dialog, however it is closed, is the same as saying they
  // saved them: the codes have been shown, and the dialog says they are not
  // shown again.
  const saw = () => {
    notify(
      codes.first
        ? "Two-step sign-in is on."
        : "You have new backup codes. The old ones no longer work.",
    );
    setCodes(null);
    // The button that opened the dialog is gone by now, and focus fell to the
    // top of the page: a keyboard had thirty stops to come back.
    setTimeout(() => newCodes.current?.focus(), 0);
  };
  const left = info.backup_codes_left;

  return (
    <div className="account-signin-row two-step">
      <div className="account-signin-line">
        <div>
          <div className="two-step-head">
            <h4>Two-step sign-in</h4>
            <span className={"pill" + (on ? " success" : "")}>
              {on ? "On" : "Off"}
            </span>
          </div>
          <p>
            After the email link, also ask for a code from an app on your phone.
          </p>
        </div>
        {!on && !setup && (
          <Button
            ref={turnOn}
            className="secondary"
            busy={busy}
            onClick={start}
          >
            <ShieldCheck size={16} />
            Turn on
          </Button>
        )}
      </div>

      {!on && setup && (
        <form onSubmit={confirm}>
          <ol className="two-step-steps" ref={steps} tabIndex={-1}>
            <li>
              Open an authenticator app on your phone, like Google
              Authenticator, Microsoft Authenticator or 1Password.
            </li>
            {/* A phone cannot point its camera at its own screen, so there
                the link to the app comes first and the QR code is for a
                second device. */}
            <li>
              <span className="two-step-mouse">
                Scan this QR code with it, or type the setup key.
              </span>
              <span className="two-step-touch">
                Tap Open in authenticator app, or copy the setup key into the
                app.
              </span>
            </li>
            <li>Type the 6-digit code the app shows.</li>
          </ol>
          <a
            className="button secondary two-step-open two-step-touch"
            href={setup.uri}
          >
            <Smartphone size={16} />
            Open in authenticator app
          </a>
          <div className="two-step-setup">
            <QrCode qr={setup.qr} />
            <div className="two-step-key">
              <span className="two-step-label" id="two-step-key-label">
                Setup key
              </span>
              <code
                className="secret-display"
                aria-labelledby="two-step-key-label"
              >
                {setup.key}
              </code>
              <div className="two-step-actions">
                <CopyButton
                  value={setup.key.replace(/ /g, "")}
                  label="Copy setup key"
                />
              </div>
            </div>
          </div>
          <Field label="6-digit code from the app">
            <input
              ref={typed}
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              required
              placeholder="123456"
            />
          </Field>
          {error && <div className="error-box">{error}</div>}
          <div className="modal-actions">
            <Button busy={busy}>Turn on</Button>
            <Button type="button" className="secondary" onClick={stop}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {on && !asking && (
        <>
          <p className="two-step-left">
            {left === 1
              ? "You have 1 backup code left."
              : `You have ${left} backup codes left.`}
            {left < FEW &&
              " Get new ones before they run out: without your phone, they are your way in."}
          </p>
          <div className="two-step-actions">
            <Button
              ref={newCodes}
              className="secondary"
              onClick={() => ask("codes")}
            >
              <KeyRound size={16} />
              Get new backup codes
            </Button>
            <Button className="secondary" onClick={() => ask("off")}>
              Turn off
            </Button>
          </div>
        </>
      )}

      {/* Without this the box just appeared, and nothing said why a code was
          wanted from somebody who is already signed in. */}
      {on && asking && (
        <p>
          To show it is really you, type the code your app shows now, or one of
          your backup codes.
        </p>
      )}
      {on && asking && (
        <form onSubmit={withCode}>
          <Field label="Code from your app, or a backup code">
            <input
              ref={typed}
              name="code"
              autoComplete="one-time-code"
              maxLength={20}
              required
              autoFocus
            />
          </Field>
          {error && <div className="error-box">{error}</div>}
          <div className="modal-actions">
            <Button busy={busy}>
              {asking === "off" ? "Turn off" : "Get new backup codes"}
            </Button>
            <Button type="button" className="secondary" onClick={stop}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {!setup && !asking && error && <div className="error-box">{error}</div>}
      {stale && (
        <Button
          className="secondary"
          onClick={async () => {
            await api("/auth/logout", "POST", {});
            location.href = "/";
          }}
        >
          Sign in again
        </Button>
      )}

      {codes && (
        <Modal
          title="Save your backup codes"
          ariaLabel="Save your backup codes"
          onClose={saw}
        >
          <p>
            {codes.first
              ? "Two-step sign-in is on. If you lose your phone, each of these codes gets you in once."
              : "These are your new backup codes, and the old ones no longer work. If you lose your phone, each of these codes gets you in once."}{" "}
            Keep them somewhere safe, like a password manager.
          </p>
          {/* Turning it on signs the account out everywhere else. Unsaid,
              that was a phone signed out for no reason anybody could see. */}
          {codes.first && (
            <p>
              You are now signed out of TameDuck on your other devices. There,
              sign in again and type a code.
            </p>
          )}
          <p className="two-step-once">
            You cannot see these codes again once you close this.
          </p>
          <ul className="two-step-codes">
            {codes.list.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
          <div className="two-step-actions">
            <CopyButton value={saved} label="Copy codes" />
            <a
              className="button secondary"
              download="tameduck-backup-codes.txt"
              href={
                "data:text/plain;charset=utf-8," + encodeURIComponent(saved)
              }
            >
              <Download size={16} />
              Download
            </a>
          </div>
          <div className="modal-actions">
            <Button onClick={saw}>
              I saved my codes <Check size={16} />
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
