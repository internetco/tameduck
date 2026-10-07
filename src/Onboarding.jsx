import React, { useEffect, useLayoutEffect, useState } from "react";
import { Check } from "lucide-react";
import { api, Button, Field, BrandMark } from "./ui.jsx";
import AISettings from "./AISettings.jsx";
import { connectedAIs } from "./ai-connection.mjs";
import { OnboardingBilling, returnedPayment } from "./Billing.jsx";
import { pricePerCompany } from "./billing-words.mjs";
import { isCommunityEdition } from "./settings-pages.mjs";
import "./onboarding.css";

// The two screens between opening the link in your email and the app.
//
// Everything a brand-new company starts with was guessed: it is named after
// the part of your email address after the @, you are named after the part
// before it, and its clock is set to wherever this server happens to be. None
// of those guesses is reliable - somebody signing up as info@ is called "Info"
// - and none of them is anywhere a new person would think to look. So they are
// asked once, here, with the guesses filled in so that most people read them
// and press Continue.
//
// The second screen is the one that matters: with no AI connected no duck can
// answer, and every other screen in the product can only point at this one.
//
// Neither can be skipped. There is no version of this product that does
// anything without an AI, so a way past would be a way to a workspace where
// nothing works. Closing the tab is fine: the company is only marked as set up
// when the last screen is answered, so coming back starts where this left off.

// Every zone this browser knows, with the one it is in already chosen. Guessed
// rather than asked, but shown rather than hidden, because a wrong clock is
// invisible until a duck does something at the wrong hour.
const zones = () => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
};
const hereNow = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

function Shell({ step, of = 2, children }) {
  return (
    <div className="auth-page onboarding-page">
      <div className="auth-nav">
        <div className="brand">
          <span className="brand-mark">
            <BrandMark onYellow />
          </span>
          TameDuck
        </div>
        <span className="onboarding-step" aria-label={`Step ${step} of ${of}`}>
          {Array.from({ length: of }, (_, i) => (
            <i key={i} className={step >= i + 1 ? "on" : ""} />
          ))}
          {step} of {of}
        </span>
      </div>
      <div className="onboarding-grid">{children}</div>
    </div>
  );
}

function Details({ data, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    // The guesses, so that reading them and carrying on is the fast path.
    name: data.user.name || "",
    company: data.company.name || "",
    rules: data.company.rules || "",
    timezone: data.company.timezone || hereNow(),
  });
  const field = (key) => ({
    value: form[key],
    onChange: (e) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });
  const all = zones();
  // A zone this browser has not heard of is still the company's zone; it goes
  // in the list rather than being silently swapped for one that is close.
  const options = all.includes(form.timezone) ? all : [form.timezone, ...all];
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/onboarding", "POST", form);
      await onDone();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }
  return (
    <>
      <section className="onboarding-story">
        <span className="eyebrow">FIRST, THE BASICS</span>
        <h1>Two things and your ducks can work.</h1>
        {/* Only while they are guesses. Said over answers somebody typed, on
            the way back from the second screen, it read as if those had been
            thrown away. */}
        <p>
          {data.company.details_at
            ? "These are your answers. Change anything you like."
            : "We guessed some of this from your email address. Change anything that is wrong."}
        </p>
      </section>
      <form className="onboarding-card" onSubmit={submit}>
        <h2>You and your company</h2>
        <Field label="Your name">
          <input {...field("name")} maxLength={100} required autoFocus />
        </Field>
        <Field label="Company name">
          <input {...field("company")} maxLength={100} required />
        </Field>
        <Field
          label="What does your company do?"
          hint="Every duck reads this before it starts work. A couple of sentences is enough."
        >
          <textarea
            {...field("rules")}
            rows={4}
            maxLength={60000}
            placeholder="We sell fittings to plumbers in the Benelux. Our customers are small firms, so keep everything plain and short."
          />
        </Field>
        <Field
          label="Your working clock"
          hint="Used whenever a duck does something at a set time."
        >
          <select {...field("timezone")}>
            {options.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </Field>
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <Button busy={busy}>Continue</Button>
      </form>
    </>
  );
}

// A refusal from the server appears above the footer, which sticks to the
// bottom of the screen and on a phone would cover it.
const intoView = (el) => el?.scrollIntoView({ block: "nearest" });

function Connect({ data, action, ready, busy, onDone, onBack, error }) {
  return (
    <>
      <section className="onboarding-story">
        <h1>Connect an AI for your ducks.</h1>
        <p>They think with it. Pick one.</p>
        <p>
          You pay the AI company yourself.
          {!isCommunityEdition(data) && pricePerCompany}
        </p>
      </section>
      <div className="onboarding-card onboarding-card--wide">
        <AISettings data={data} action={action} setup />
        {error && (
          <div className="error-box" role="alert" ref={intoView}>
            {error}
          </div>
        )}
        <div className="onboarding-done">
          <button type="button" className="text-button" onClick={onBack}>
            Back
          </button>
          {/* The way out is always there, greyed until it goes somewhere. A
              spinner saying "Connect one above and this opens" read as
              loading, and people waited for it. */}
          <div className="onboarding-go">
            {ready ? (
              <span className="onboarding-ok">
                <Check size={16} />
                Connected, and your ducks are set to use it.
              </span>
            ) : (
              <span id="onboarding-why" className="onboarding-waiting">
                Connect one AI first
              </span>
            )}
            <Button
              className={ready ? "" : "locked"}
              busy={busy}
              disabled={!ready}
              aria-describedby={ready ? undefined : "onboarding-why"}
              onClick={onDone}
              data-onboarding="finish"
            >
              Open my workspace
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

export default function Onboarding({ data, action, refresh, onFinished }) {
  // Two screens. Once the first is answered the server says so, and every tab
  // and device opens on the second - including the one that comes back from
  // the provider after typing a plan's code. This used to be kept in the tab
  // alone, so a new tab showed the first screen again and called the answers
  // on it guesses. Back is this tab's business only. Only the second screen
  // ends the flow, and only the server decides that it may: a company is
  // marked set up when a duck could answer.
  const [named, goToConnect] = useState(() => !!data.company.details_at);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // These screens wear the brand's yellow and white in every theme, which is
  // what their stylesheet is written for. A browser that had chosen Dark for
  // another company painted them dark, with the heading dark on dark and the
  // words in the white card pale on white. Before the first paint, so it
  // never shows dark for a moment.
  useLayoutEffect(() => {
    const html = document.documentElement,
      was = html.dataset.theme;
    html.dataset.theme = "electric";
    return () => {
      html.dataset.theme = was;
    };
  }, []);
  // Whether a signed-in plan is live is not in the workspace payload - it is
  // the answer to its own question, because finding out means asking the
  // provider. The AI page polls it while it is open; so does this, for the
  // same reason: the person is away at OpenAI typing a code, and this screen
  // has to notice when they come back.
  const [status, setStatus] = useState(null);
  useEffect(() => {
    if (!named) return;
    let live = true;
    const look = () =>
      api("/ai/status")
        .then((r) => live && setStatus(r))
        .catch(() => {});
    look();
    const timer = setInterval(look, 4000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [named]);
  // Connected is not enough on its own. The ducks have to be pointed at
  // something that is actually connected, which is the failure this flow
  // exists to end: a saved key, a green tick, and every run afterwards dying
  // on a provider nobody ever set up.
  // The ChatGPT plan's own answer, not the top-level one: /ai/status says
  // "connected" whenever any key is saved, so reading that made the plan look
  // signed in beside a key, and the green tick below appeared over ducks that
  // were set to a plan nobody had signed in to. The AI page reads it this way.
  const plan = status?.codex || status;
  const connected = connectedAIs(data.ai?.providers || [], plan?.connected);
  const ready = connected.some((p) => p.id === data.ai?.default?.provider);
  async function finish() {
    setBusy(true);
    setError("");
    try {
      await api("/onboarding/ready", "POST");
      await onFinished();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }
  // A company that has to pay before its ducks can work gets a screen for
  // that between the two: billing details and the trial, then Mollie. Coming
  // back from Mollie lands here too, with the payment it came back with, and
  // stays until the person moves on.
  const paying =
    !!data.billing?.enabled &&
    (data.billing.blocked || !!returnedPayment(data.company.id));
  // Three screens wherever new companies pay: the count stays the same from
  // the first screen to the last.
  const steps =
    paying || (data.billing?.enabled && data.billing.mode !== "off") ? 3 : 2;
  if (named && paying)
    return (
      <Shell step={2} of={3}>
        <OnboardingBilling
          data={data}
          refresh={refresh}
          onBack={() => goToConnect(false)}
        />
      </Shell>
    );
  return (
    <Shell step={named ? steps : 1} of={steps}>
      {named ? (
        <Connect
          data={data}
          action={action}
          ready={ready}
          busy={busy}
          onDone={finish}
          onBack={() => goToConnect(false)}
          error={error}
        />
      ) : (
        <Details
          data={data}
          onDone={async () => {
            await refresh();
            goToConnect(true);
          }}
        />
      )}
    </Shell>
  );
}
