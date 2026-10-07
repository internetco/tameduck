import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Sparkles,
  Check,
  RefreshCw,
  ExternalLink,
  Loader2,
  Lock,
} from "lucide-react";
import { api, Button, CopyButton, Field, Modal } from "./ui.jsx";
import {
  providers,
  providerName,
  isSubscription,
} from "../shared/ai-providers.mjs";
import {
  providerEnabled,
  filterAvailableModels,
} from "../shared/ai-availability.mjs";
import {
  canConnectAI,
  whoConnectsAI,
  whoFixesDown,
  aiDown,
} from "../shared/ai-access.mjs";
import {
  connectedAIs,
  ducksChoice,
  borrowedKey,
  otherCompanies,
  keyLine,
  planLine,
  downLine,
} from "./ai-connection.mjs";
import "./ai-settings.css";
import { aiCostLine } from "./billing-words.mjs";
import { isCommunityEdition } from "./settings-pages.mjs";
import SettingsHead from "./SettingsHead.jsx";
import {
  MODEL_INTELLIGENCE_SNAPSHOT,
  automaticChoice,
  highestRated,
  rankedIntelligence,
  scoreGap,
} from "../shared/model-intelligence.mjs";
export function modelLabel(choice) {
  return choice
    ? `${providerName(choice.provider)} · ${choice.model || "Automatic"}`
    : "Company default";
}
export function ModelPicker({
  value,
  onChange,
  disabled = false,
  label = "Model",
  // True only where the rows that connect an AI are on this same page. The
  // picker also runs inside the duck dialog, where it used to say "Connect
  // this provider below" at somebody looking at a modal whose remaining fields
  // are an avatar colour and a face.
  connectHere = false,
  // The settings page offers only the AIs that are connected, calls the first
  // box "AI", and puts its Saved tick beside the two boxes. The duck dialog
  // passes none of these.
  offered = [],
  providerLabel = label + " provider",
  aside = null,
  selectionContext = "",
  onValidityChange,
}) {
  const uid = useId();
  const providerIds = useMemo(
    () => [
      ...new Set(
        offered
          .filter((p) => p.enabled !== false && providerEnabled(p.id))
          .map((p) => p.id),
      ),
    ],
    [offered.map((p) => p.id + ":" + (p.enabled !== false)).join("|")],
  );
  const providerKey = providerIds.join("|");
  const [catalog, setCatalog] = useState({
      providerKey: "",
      models: [],
      automaticProviders: [],
      errors: [],
    }),
    [loading, setLoading] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    // Connection facts changed: old provider choices must stop being usable
    // before the replacement catalogs arrive.
    setCatalog({
      providerKey,
      models: [],
      automaticProviders: [],
      errors: [],
    });
    if (!providerIds.length) {
      setLoading(false);
      return () => {
        live = false;
      };
    }
    setLoading(true);
    Promise.allSettled(
      providerIds.map((id) =>
        api("/ai/models/" + id + (revision ? "?refresh=1" : "")).then(
          (response) => ({
            id,
            models: filterAvailableModels(id, response.models || []).map(
              (model) => ({ ...model, provider: id }),
            ),
          }),
        ),
      ),
    )
      .then((results) => {
        if (!live) return;
        const fulfilled = results
          .filter((result) => result.status === "fulfilled")
          .map((result) => result.value);
        setCatalog({
          providerKey,
          models: fulfilled.flatMap((result) => result.models),
          automaticProviders: fulfilled
            .filter(
              (result) => isSubscription(result.id) && result.models.length > 0,
            )
            .map((result) => result.id),
          errors: results.flatMap((result, index) =>
            result.status === "rejected"
              ? [
                  providerName(providerIds[index]) +
                    ": " +
                    result.reason.message,
                ]
              : [],
          ),
        });
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [revision, providerKey]);
  const currentCatalog =
    catalog.providerKey === providerKey
      ? catalog
      : { models: [], automaticProviders: [], errors: [] };
  const availableModels = rankedIntelligence(currentCatalog.models);
  const choices = [
    ...availableModels,
    ...currentCatalog.automaticProviders.map(automaticChoice),
  ];
  const selected = choices.find(
    (model) =>
      model.provider === value?.provider && model.id === (value?.model || ""),
  );
  const staleModel = !loading && !!value && !selected;
  const best = highestRated(availableModels);
  const gap = scoreGap(value, availableModels);
  const selectedInfo = selected?.intelligence;
  const selectedName = selected?.name || modelLabel(value);
  const summaryId = uid + "-summary";
  const selectionValid = !loading && !!selected;
  useEffect(() => {
    onValidityChange?.(selectionValid);
  }, [onValidityChange, selectionValid]);
  const money = (amount) =>
    "$" + Number(amount).toFixed(Number.isInteger(amount) ? 0 : 2);
  return (
    <div className="model-picker">
      <div className="model-intelligence-head">
        <div>
          <h4>Model intelligence</h4>
          <small>AA reference score · higher is better · scale 0–60</small>
        </div>
      </div>
      <div
        className="model-intelligence-summary"
        id={summaryId}
        aria-live="polite"
      >
        {loading && !selected ? (
          <p>Loading available models…</p>
        ) : staleModel ? (
          <>
            <strong>{modelLabel(value)} · unavailable</strong>
            <p>
              This saved choice is not available through a connected provider.
              Choose another model to replace it.
            </p>
          </>
        ) : selected?.automatic ? (
          <>
            <strong>Automatic · varies — no fixed score</strong>
            {selectionContext && <p>{selectionContext}</p>}
            <p>ChatGPT chooses the model, so its reference score may vary.</p>
          </>
        ) : selected ? (
          <>
            <strong>
              {selectedName} ·{" "}
              {selectedInfo
                ? selectedInfo.score + " reference points"
                : "Not rated"}
            </strong>
            {selectionContext && <p>{selectionContext}</p>}
            {selectedInfo && gap === 0 ? (
              <p>Highest published score among your available models.</p>
            ) : Number.isFinite(gap) ? (
              <p className="model-intelligence-tradeoff">
                <b>
                  {gap} {gap === 1 ? "point" : "points"} below the highest
                  available score on the index.
                </b>{" "}
                For complex, multi-step work, consider {best?.name || best?.id}.
                Review important results.
              </p>
            ) : (
              <p>No published reference score is available for this model.</p>
            )}
          </>
        ) : (
          <p>Choose from the models currently offered by your connections.</p>
        )}
      </div>
      <fieldset
        className="model-intelligence-list"
        aria-describedby={summaryId}
        disabled={disabled}
      >
        <legend className="sr-only">{label}</legend>
        {choices.map((model) => {
          const info = model.intelligence;
          const modelValue = model.id || "";
          return (
            <label
              key={model.provider + ":" + modelValue}
              className="model-intelligence-row"
            >
              <input
                type="radio"
                name={uid + "-model"}
                checked={
                  value?.provider === model.provider &&
                  (value?.model || "") === modelValue
                }
                onChange={() =>
                  onChange({ provider: model.provider, model: modelValue })
                }
              />
              <span className="model-intelligence-name">
                <b>{model.name || model.id}</b>
                <small>
                  {providerName(model.provider)} ·{" "}
                  {isSubscription(model.provider)
                    ? "connected plan"
                    : "API billing"}
                </small>
              </span>
              <strong className="model-intelligence-score">
                {model.automatic ? "Varies" : (info?.score ?? "Not rated")}
              </strong>
              {info && (
                <span className="model-intelligence-bar" aria-hidden="true">
                  <i
                    style={{
                      width:
                        (info.score /
                          MODEL_INTELLIGENCE_SNAPSHOT.scaleMaximum) *
                          100 +
                        "%",
                    }}
                  />
                </span>
              )}
            </label>
          );
        })}
      </fieldset>
      {!loading && choices.length === 0 && (
        <p className="model-help" role="status">
          No models are currently available through the connected providers.
        </p>
      )}
      {selected &&
        (isSubscription(selected.provider) ? (
          <p className="model-intelligence-billing">
            <strong>Uses your connected ChatGPT plan.</strong> Your plan’s usage
            limits apply.
          </p>
        ) : selectedInfo ? (
          <p className="model-intelligence-billing">
            {selected.provider === "openrouter" ? (
              <>
                <strong>OpenRouter · billed by usage.</strong>{" "}
                <a
                  href={"https://openrouter.ai/" + selected.id}
                  target="_blank"
                  rel="noreferrer"
                >
                  View current model pricing
                </a>
              </>
            ) : (
              <>
                <strong>OpenAI API · billed by usage.</strong>{" "}
                {money(selectedInfo.apiPrice.input)} /{" "}
                {money(selectedInfo.apiPrice.output)} per 1M input / output
                tokens.
              </>
            )}
          </p>
        ) : null)}
      {aside}
      <div className="model-catalog-tools">
        <button
          type="button"
          className="text-button"
          disabled={loading}
          onClick={() => setRevision((r) => r + 1)}
        >
          <RefreshCw size={13} />
          {loading ? "Loading models…" : "Refresh models"}
        </button>
        <small>Published reference measurements, not task success rates.</small>
      </div>
      {currentCatalog.errors.map((error) => (
        <p className="model-help warn" role="status" key={error}>
          {connectHere && error.includes("in Settings → AI connection")
            ? error.replace("in Settings → AI connection", "below") +
              " Then refresh models."
            : error}
        </p>
      ))}
    </div>
  );
}
function DisabledProviderRow({ p, action }) {
  const removable = p.configured && p.company_key && !isSubscription(p.id);
  return (
    <Row
      tile={<Lock size={20} />}
      kind="disabled"
      name={p.name}
      tag={<span className="ai-tag">Unavailable</span>}
      what={p.disabledReason}
      side={
        removable ? (
          <Quiet
            onClick={() =>
              action(
                () => api("/ai/providers/" + p.id, "DELETE"),
                p.name + " removed",
              )
            }
          >
            Remove
          </Quiet>
        ) : null
      }
    />
  );
}
// One row per AI, and each opens where it is. The page used to be two and a
// half screens: a model picker nobody could use yet, then five cards, four of
// them holding an empty password box and a greyed-out button. Somebody new has
// one thing to do here, so the page is a short list with a button on each line
// and the model choice stays away until something is connected.
export default function AISettings({ data, action, setup = false }) {
  // The owner, and an admin allowed to connect outside tools.
  const canManage = canConnectAI(data.role, data.permissions),
    // Signing in to a plan is the owner's alone: it is their own account, and
    // the server refuses anybody else.
    owner = data.role === "owner",
    // Telling somebody to "ask the owner" when the owner is sitting in the
    // member list under their own name is one question they should not have
    // to ask anybody.
    ownerName = (data.members || []).find((m) => m.role === "owner")?.name,
    // Who else to send somebody to: everyone who could connect one, by name.
    ask = whoConnectsAI(data.members),
    plan = providers.find((p) => p.kind === "subscription");
  const [status, setStatus] = useState(null),
    [login, setLogin] = useState(null),
    [planBusy, setPlanBusy] = useState(false),
    [planError, setPlanError] = useState(""),
    // Which row is open. One at a time, so the page never grows a second form.
    [open, setOpen] = useState(null);
  const openNow = useRef(open);
  openNow.current = open;
  const load = async () => {
    try {
      const r = await api("/ai/status");
      const s = r.codex || r;
      setStatus(s);
      if (s.connected) {
        setLogin(null);
        setOpen((id) => (id === plan.id ? null : id));
      }
      setPlanError((!s.connected && s.login?.error) || "");
    } catch (e) {
      // "Checking…" for ever is worse than the reason it could not check.
      setStatus((was) => was || { connected: false });
      setPlanError(e.message);
    }
  };
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (!login) return;
    const poll = setInterval(load, 4000);
    return () => clearInterval(poll);
  }, [login]);
  async function connectPlan() {
    setOpen(plan.id);
    setPlanBusy(true);
    setPlanError("");
    try {
      const code = await api("/ai/connect", "POST", {});
      // Somebody who has opened another row while the code was on its way has
      // moved on, and one open row is the rule.
      if (openNow.current === plan.id) setLogin(code);
    } catch (e) {
      setPlanError(e.message);
    } finally {
      setPlanBusy(false);
    }
  }
  // Opening a key row puts the sign-in away, and the other way round.
  const openRow = (id) => {
    setOpen(id);
    setLogin(null);
    setPlanError("");
  };
  // The names and sentences come from the list this browser was built with;
  // only the facts - is there a key, whose is it - are the server's to say.
  const rows = providers.map((p) => {
    const facts = (data.ai?.providers || []).find((x) => x.id === p.id),
      historical =
        !!facts?.configured ||
        data.ai?.default?.provider === p.id ||
        (data.ai?.overrides || []).some((x) => x.provider === p.id);
    return {
      ...p,
      enabled: facts?.enabled !== false && providerEnabled(p.id),
      historical,
      disabledReason:
        facts?.statusReason ||
        facts?.disabled_reason ||
        facts?.disabledReason ||
        "This provider is not available yet.",
      configured: !!facts?.configured,
      connectable: !!facts?.connectable,
      qualificationPending: !!facts?.qualificationPending,
      company_key: !!facts?.company_key,
      also_used_by: facts?.also_used_by || 0,
    };
  });
  const connected = connectedAIs(
    rows.filter((p) => p.enabled),
    status?.connected,
  );
  const who = ownerName || "the owner";
  const signIn = (p) => isSubscription(p.id);
  const item = (p) =>
    !p.enabled && !p.connectable ? (
      <DisabledProviderRow key={p.id} p={p} action={action} />
    ) : signIn(p) ? (
      <PlanRow
        key={p.id}
        p={p}
        owner={owner}
        who={who}
        status={status}
        login={login}
        error={planError}
        busy={planBusy}
        lead={connected.length === 0}
        setup={setup}
        onConnect={connectPlan}
        onCancel={() => openRow(null)}
        onDisconnect={async () => {
          setPlanBusy(true);
          const r = await action(
            () => api("/ai/disconnect", "POST", {}),
            p.name + " disconnected",
          );
          if (r) await load();
          setPlanBusy(false);
        }}
      />
    ) : (
      <KeyRow
        key={p.id}
        p={p}
        data={data}
        action={action}
        who={who}
        setup={setup}
        open={open === p.id}
        onOpen={() => openRow(p.id)}
        onClose={() => openRow(null)}
      />
    );
  return (
    <div className={"ai-page" + (setup ? " setup" : "")}>
      {/* On the sign-up screen the words beside the list say all this. In
          Settings only somebody who may connect an AI is offered this page,
          so the lines that told anybody else who to ask have gone; the chat
          and the Computers page still tell them. */}
      {!setup && <SettingsHead page="ai" />}
      {!setup && connected.length === 0 && (
        <p className="ai-state">
          {aiDown(status)
            ? downLine({
                owner,
                canManage,
                who,
                fixes: whoFixesDown(data.members),
              })
            : "Your ducks need one of these to answer. Connect whichever you already pay for."}
        </p>
      )}
      {/* Held back until the sign-in has been checked, so it never opens by
          saying the ducks are on something that is not connected and then
          takes it back a moment later. */}
      {status && connected.length > 0 && (
        <DucksUse data={data} action={action} offered={connected} ask={ask} />
      )}
      {/* On the second sign-up screen the list is split in two: the plan you
          sign in to, then the keys. One list under "the AI you already pay
          for" sent people with a Claude Pro plan to a row that wants a key
          they do not have. */}
      {setup ? (
        <>
          <section className="ai-setup plan" aria-labelledby="ai-setup-plan">
            <h2 id="ai-setup-plan">Pay for {plan.name} Plus or Pro?</h2>
            <ul className="ai-list">
              {rows
                .filter((p) => p.enabled || p.historical || p.connectable)
                .filter(signIn)
                .map(item)}
            </ul>
          </section>
          <section className="ai-setup keys" aria-labelledby="ai-setup-keys">
            <h2 id="ai-setup-keys">Or paste an API key</h2>
            <p>
              Paid per use at the AI company. A monthly chat plan is not a key.
            </p>
            <ul className="ai-list">
              {rows
                .filter((p) => p.enabled || p.historical || p.connectable)
                .filter((p) => !signIn(p))
                .map(item)}
            </ul>
          </section>
        </>
      ) : (
        <ul className="ai-list">
          {rows
            .filter((p) => p.enabled || p.historical || p.connectable)
            .map(item)}
        </ul>
      )}
      <p className="ai-fine">
        <Lock size={15} />
        {/* On the sign-up screen the price is said beside the heading. */}
        <span>
          {!setup && aiCostLine(isCommunityEdition(data))}
          Keys are encrypted. Ducks and teammates never see them.
        </span>
      </p>
    </div>
  );
}
function Row({
  tile,
  kind = "",
  name,
  tag,
  what,
  side,
  two,
  open,
  onOpen,
  onClose,
  returnFocus = true,
  swapped = 0,
  children,
}) {
  const item = useRef(null),
    wasOpen = useRef(false);
  const takeKeyboard = () =>
    returnFocus &&
    document.activeElement === document.body &&
    item.current?.querySelector(".ai-row-side button")?.focus();
  // When a row closes, whatever had the keyboard inside it is gone. Hand it
  // back to this row's own button - unless another row has just opened and
  // taken it, which is why this only acts when nothing has it.
  useEffect(() => {
    if (wasOpen.current && !open) takeKeyboard();
    wasOpen.current = !!open;
  }, [open]);
  // The same happens without the row closing: Connect turns into Replace key
  // the moment a key is in, and Remove key turns back into Connect. `swapped`
  // counts each time this row's own buttons have just been changed under
  // somebody, who was otherwise left at the top of the page.
  useEffect(() => {
    if (swapped) takeKeyboard();
  }, [swapped]);
  return (
    <li
      ref={item}
      className={"ai-item" + (open ? " open" : "")}
      onKeyDown={(e) => e.key === "Escape" && open && onClose?.()}
    >
      {/* The whole line answers a click, because that is where people aim.
          The button inside it is the one a keyboard reaches. */}
      <div className={"ai-row" + (onOpen ? " can-open" : "")} onClick={onOpen}>
        <span className={"ai-tile " + kind} aria-hidden="true">
          {tile}
        </span>
        <div className="ai-row-main">
          <div className="ai-row-name">
            <h3>{name}</h3>
            {tag}
          </div>
          <p className="ai-row-what">{what}</p>
        </div>
        {side && (
          <div
            className={"ai-row-side" + (two ? " two" : "")}
            onClick={(e) => e.stopPropagation()}
          >
            {side}
          </div>
        )}
      </div>
      {children && <div className="ai-row-body">{children}</div>}
    </li>
  );
}
const Connected = () => <span className="ai-tag ok">Connected</span>;
// Given as a ref to what opens under a row once somebody presses it, so it is
// scrolled into view when it appears. On the sign-up screen a footer sticks to
// the bottom, and on a phone it covered the code and the reason a key failed.
const intoView = (el) => el?.scrollIntoView({ block: "nearest" });
const Quiet = (props) => (
  <button type="button" className="text-button ai-quiet" {...props} />
);
// The one AI somebody signs in to rather than pastes a key for.
function PlanRow({
  p,
  owner,
  who,
  status,
  login,
  error,
  busy,
  lead,
  setup,
  onConnect,
  onCancel,
  onDisconnect,
}) {
  const on = !!status?.connected;
  return (
    <Row
      // Filled only for the person who can press it.
      kind={on ? "ok" : owner ? "lead" : ""}
      tile={on ? <Check size={20} /> : <Sparkles size={20} />}
      name={p.name}
      tag={
        on ? (
          <Connected />
        ) : (
          // The sign-up screen says so in the heading above this row.
          owner && !setup && <span className="ai-tag">Easiest</span>
        )
      }
      what={
        on
          ? planLine(p, status.account, { owner, who })
          : owner
            ? p.blurb
            : "Only " + who + " can sign in here. It uses their own plan."
      }
      // Open from the press, not from the answer. OpenAI takes a moment to hand
      // a code over, and for that moment the row lost the tint it had under
      // the pointer and then got it back, which read as a flash.
      open={!!(login || error) || busy}
      onClose={onCancel}
      // A sign-in that has just gone through closes the row too, and what is
      // then on the right is Disconnect. That is not a button to be left
      // holding the keyboard.
      returnFocus={!on}
      onOpen={owner && status && !on && !login && !busy ? onConnect : undefined}
      side={
        status === null ? (
          <span className="ai-checking" role="status">
            <Loader2 size={14} className="spin" />
            Checking…
          </span>
        ) : !owner ? null : on ? (
          <Quiet
            disabled={busy}
            aria-label={"Disconnect " + p.name}
            onClick={onDisconnect}
          >
            Disconnect
          </Quiet>
        ) : login ? (
          <Quiet onClick={onCancel}>Cancel</Quiet>
        ) : (
          <Button
            className={"small" + (lead ? "" : " secondary")}
            busy={busy}
            aria-label={(setup ? "Sign in with " : "Connect ") + p.name}
            onClick={onConnect}
          >
            {setup ? "Sign in" : "Connect"}
          </Button>
        )
      }
    >
      {(login || error) && (
        <>
          {login && (
            <>
              <ol className="ai-code">
                <li className="ai-code-step">
                  <b>1. Copy this code</b>
                  <div className="ai-code-box">
                    <code>{login.userCode}</code>
                    <CopyButton
                      value={login.userCode}
                      label="Copy"
                      className="small"
                    />
                  </div>
                </li>
                <li className="ai-code-step">
                  <b>2. Type it in at OpenAI</b>
                  <a
                    className="button"
                    href={login.verificationUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Open OpenAI <ExternalLink size={16} />
                  </a>
                </li>
              </ol>
              <p className="ai-wait" role="status" ref={intoView}>
                <Loader2 size={14} className="spin" />
                <span>Waiting for you to finish at OpenAI.</span>
                <button
                  type="button"
                  className="text-button"
                  onClick={onConnect}
                >
                  Get a new code
                </button>
              </p>
            </>
          )}
          {error && (
            <div className="error-box" role="alert" ref={intoView}>
              {error}
            </div>
          )}
        </>
      )}
    </Row>
  );
}
// An AI somebody pastes a key for. Closed it is one line; the box for the key
// only exists while it is the row that was pressed.
function KeyRow({ p, data, action, who, setup, open, onOpen, onClose }) {
  const [key, setKey] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [swapped, setSwapped] = useState(0),
    // Asking before a key that also runs other companies goes. It asked in
    // the browser's own pop-up, which the rest of the app never uses.
    [asking, setAsking] = useState(false);
  const input = useRef(null),
    keep = useRef(null),
    removeButton = useRef(null),
    wasAsking = useRef(false);
  const canManage = canConnectAI(data.role, data.permissions),
    owner = data.role === "owner",
    borrowed = borrowedKey(p, owner),
    others = otherCompanies(p, owner);
  useEffect(() => {
    if (open) input.current?.focus();
    else {
      setKey("");
      setError("");
    }
  }, [open]);
  // The dialog puts the keyboard on its first button, the cross, so the safe
  // answer is given it instead. Closing takes the keyboard with it, so it goes
  // back to the button that opened the dialog.
  useEffect(() => {
    if (asking) keep.current?.focus();
    else if (wasAsking.current && document.activeElement === document.body)
      removeButton.current?.focus();
    wasAsking.current = asking;
  }, [asking]);
  async function remove() {
    setAsking(false);
    setBusy(true);
    // The server moves what the ducks use off the AI that just went, because
    // falling back cannot save a duck when the thing it falls back to IS the
    // one that went. It answers with where that left them; saying only
    // "removed" moved everybody's ducks in silence.
    await action(
      () => api("/ai/providers/" + p.id, "DELETE"),
      (r) =>
        r?.moved_default
          ? p.name +
            " key removed. Your ducks are now on " +
            modelLabel(r.now_using) +
            "."
          : p.name + " key removed",
    );
    setBusy(false);
    setSwapped((n) => n + 1);
  }
  return (
    <Row
      onClose={onClose}
      swapped={swapped}
      kind={p.configured ? "ok" : ""}
      tile={p.configured ? <Check size={20} /> : p.mark}
      name={p.name}
      tag={
        p.configured ? (
          <Connected />
        ) : (
          p.notPlan && <span className="ai-tag not-plan">{p.notPlan}</span>
        )
      }
      what={
        p.qualificationPending
          ? p.configured
            ? "Key saved. Models are being tested before your ducks can use them."
            : "Connect your OpenRouter key. Models are being tested before your ducks can use them."
          : p.configured
            ? keyLine(p, { owner, canManage, who })
            : p.blurb
      }
      open={open}
      onOpen={
        canManage && p.connectable && !open && !p.configured
          ? onOpen
          : undefined
      }
      two={p.configured && !open && !borrowed}
      side={
        !canManage ? null : open ? (
          <Quiet onClick={onClose}>Cancel</Quiet>
        ) : p.configured ? (
          <>
            <Quiet
              disabled={busy}
              aria-label={"Replace " + p.name + " key"}
              onClick={onOpen}
            >
              Replace key
            </Quiet>
            {!borrowed && (
              <Quiet
                ref={removeButton}
                disabled={busy}
                aria-label={"Remove " + p.name + " key"}
                onClick={() => (others ? setAsking(true) : remove())}
              >
                Remove key
              </Quiet>
            )}
            {asking && (
              <Modal
                title={"Remove the " + p.name + " key?"}
                ariaLabel={"Remove the " + p.name + " key?"}
                onClose={() => setAsking(false)}
              >
                <p>
                  This {p.name} key also runs {others}. Removing it takes it
                  from {p.also_used_by === 1 ? "that one" : "those"} too, and
                  their ducks stop until a key is added again.
                </p>
                <div className="modal-actions">
                  <Button
                    ref={keep}
                    type="button"
                    className="secondary"
                    onClick={() => setAsking(false)}
                  >
                    Keep the key
                  </Button>
                  <Button type="button" onClick={remove}>
                    Remove key
                  </Button>
                </div>
              </Modal>
            )}
          </>
        ) : (
          // Five buttons that all say "Connect" are five of the same thing to
          // a screen reader, so each also carries the name of its row.
          <Button
            className="secondary small"
            aria-label={
              setup
                ? "Paste " +
                  (/^[aeiou]/i.test(p.name) ? "an " : "a ") +
                  p.name +
                  " key"
                : "Connect " + p.name
            }
            onClick={onOpen}
          >
            {setup ? "Paste key" : "Connect"}
          </Button>
        )
      }
    >
      {open && (
        <form
          ref={intoView}
          className="ai-key-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await api("/ai/providers/" + p.id, "PUT", { key });
              onClose();
              await action(async () => ({ ok: true }), p.name + " connected");
              setSwapped((n) => n + 1);
            } catch (e) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="ai-key-row">
            <input
              ref={input}
              type="password"
              autoComplete="off"
              aria-label={p.name + " key"}
              value={key}
              placeholder={"Paste your " + p.name + " key"}
              onChange={(e) => setKey(e.target.value)}
              required
              maxLength={2000}
            />
            <Button busy={busy} disabled={key.trim().length < 10}>
              {p.configured ? "Replace key" : "Connect " + p.name}
            </Button>
          </div>
          {error && (
            <div className="error-box" role="alert" ref={intoView}>
              {error}
            </div>
          )}
          <a
            href={p.keyUrl}
            target="_blank"
            rel="noreferrer"
            className="text-link"
          >
            Get {/^[aeiou]/i.test(p.name) ? "an" : "a"} {p.name} key{" "}
            <ExternalLink size={13} />
          </a>
        </form>
      )}
    </Row>
  );
}
// What every duck runs on. It only exists once something is connected, and it
// only offers what is: choosing an AI nobody had connected used to save with a
// green message and then stop every duck in the company.
function DucksUse({ data, action, offered, ask }) {
  const config = data.ai,
    canManage = canConnectAI(data.role, data.permissions),
    saved = config?.default || { provider: "codex", model: "" };
  const [choice, setChoice] = useState(saved),
    // Off. Ticking it deletes every model a duck was deliberately given, and a
    // destructive thing should not happen to somebody who only came here to
    // change the model and pressed Save.
    [all, setAll] = useState(false),
    [busy, setBusy] = useState(false),
    [modelReady, setModelReady] = useState(false);
  useEffect(() => {
    setChoice(saved);
  }, [saved.provider, saved.model]);
  const { works, shown, dirty, ready } = ducksChoice(
    saved,
    choice,
    offered,
    all,
  );
  const stuck =
    "Your ducks are set to " +
    providerName(saved.provider) +
    ", which is not connected, so they cannot answer.";
  if (!canManage)
    return (
      <div className="ai-use">
        <h3>What ducks use</h3>
        {works ? (
          <>
            <p className="ai-use-now">{modelLabel(saved)}</p>
            <p className="ai-hint">
              Every duck uses this unless it has been given its own model.
            </p>
          </>
        ) : (
          <p className="ai-use-warn" role="status">
            {stuck} Ask {ask} to choose one that is.
          </p>
        )}
        <ModelPicker
          value={saved}
          onChange={() => {}}
          offered={offered}
          disabled
          label="Workspace model"
          selectionContext="Selected for your workspace."
        />
      </div>
    );
  return (
    <form
      className="ai-use"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const r = await action(
          () => api("/ai/default", "PUT", { ...shown, apply_all: all }),
          all
            ? "Saved. Every duck now uses " + modelLabel(shown) + "."
            : "Saved. Your ducks now use " + modelLabel(shown) + ".",
        );
        if (r) setAll(false);
        setBusy(false);
      }}
    >
      <h3>What ducks use</h3>
      {!works && (
        <p className="ai-use-warn" role="status">
          {stuck} Choose what they should use and press Save.
        </p>
      )}
      <ModelPicker
        value={shown}
        onChange={setChoice}
        offered={offered}
        providerLabel="AI"
        label="Model"
        connectHere
        selectionContext="Selected for your workspace."
        onValidityChange={setModelReady}
        // Saving is a button, as it always was. The tick only ever says that
        // what is in the boxes is what is saved.
        aside={
          dirty ? (
            <Button busy={busy} disabled={!ready || !modelReady}>
              Save
            </Button>
          ) : (
            <span className="ai-saved" role="status">
              <Check size={15} />
              Saved
            </span>
          )
        }
      />
      {/* With nothing to reset this offered a choice that did nothing and
          said "Also reset 0 individual model choices", which reads like a
          warning about something. It appears when there is something to it. */}
      {config?.overrides?.length > 0 && (
        <label className="ai-apply-all">
          <input
            type="checkbox"
            checked={all}
            onChange={(e) => setAll(e.target.checked)}
          />
          <span>
            <strong>Use this for every duck</strong>
            <small>
              {config.overrides.length === 1
                ? "One duck has been given its own model. Tick this to put it back on this one."
                : config.overrides.length +
                  " ducks have been given their own model. Tick this to put them back on this one."}
            </small>
          </span>
        </label>
      )}
      <p className="ai-hint">
        Every duck uses this. To give one duck its own model, open its profile.
      </p>
    </form>
  );
}
export function DuckModelPicker({
  value,
  onChange,
  companyDefault,
  disabled,
  data,
  connection,
}) {
  const inherit = !value;
  const connectionValue = (status) =>
    typeof status === "boolean"
      ? status
      : (status?.codex?.connected ?? status?.connected);
  const [planConnected, setPlanConnected] = useState(() =>
    connectionValue(connection),
  );
  const [connectionError, setConnectionError] = useState("");
  useEffect(() => {
    const given = connectionValue(connection);
    if (given !== undefined) {
      setPlanConnected(given);
      setConnectionError("");
      return;
    }
    let live = true;
    setPlanConnected(undefined);
    api("/ai/status")
      .then((status) => {
        if (live) setPlanConnected(!!connectionValue(status));
      })
      .catch((error) => {
        if (live) {
          setPlanConnected(false);
          setConnectionError(error.message);
        }
      });
    return () => {
      live = false;
    };
  }, [connection]);
  const offered = connectedAIs(data?.ai?.providers || [], planConnected);
  return (
    <section className="duck-model-setting">
      <div>
        <h4>AI model</h4>
        <p>Choose the intelligence behind this teammate.</p>
      </div>
      <label className="ai-apply-all">
        <input
          type="checkbox"
          checked={inherit}
          disabled={disabled}
          onChange={(e) =>
            onChange(e.target.checked ? null : { ...companyDefault })
          }
        />
        <span>
          <strong>Use company default</strong>
          <small>{modelLabel(companyDefault)}</small>
        </span>
      </label>
      <ModelPicker
        value={value || companyDefault}
        onChange={onChange}
        disabled={disabled || inherit}
        offered={offered}
        label="Duck model"
        selectionContext={
          inherit
            ? "Inherited from company default."
            : "Selected for this duck."
        }
      />
      {connectionError && (
        <p className="model-help warn" role="status">
          Could not check the ChatGPT connection: {connectionError}
        </p>
      )}
      {!inherit && (
        <>
          {/* Saving with no model chosen was refused by the server, and the
              dialog sends every edit as one diff - so the name and the avatar
              somebody changed in the same sitting went nowhere either, with
              only "Choose a model." to go on and nothing pointing here. */}
          {!value.model && !isSubscription(value.provider) ? (
            <p className="model-help warn" role="status">
              Choose a model for this duck, or tick{" "}
              <strong>Use company default</strong> above.
            </p>
          ) : (
            <p className="model-help">
              If this connection is temporarily unavailable, this duck will use{" "}
              {modelLabel(companyDefault)}.
            </p>
          )}
        </>
      )}
    </section>
  );
}
