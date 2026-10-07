import React, { useEffect, useRef, useState } from "react";
import {
  Search,
  Plug,
  Plus,
  ArrowUpRight,
  ShieldCheck,
  KeyRound,
  Check,
  RefreshCw,
  Settings2,
  Unplug,
  Trash2,
  AlertCircle,
  BookOpen,
} from "lucide-react";
import { plural, api, Button, Modal, Field, DuckPicker, Empty, flock } from "./ui.jsx";
import "./connections.css";
import SettingsHead from "./SettingsHead.jsx";
import { joined, notOnKey, keyHint, alsoLets } from "../shared/key-access.mjs";
const parse = (value) => {
  try {
    return JSON.parse(value || "[]");
  } catch {
    return [];
  }
};
const authLabel = {
  none: "No account needed",
  secret: "API key",
  oauth: "Sign in",
};
async function change(action, setError, fn, message) {
  setError("");
  return action(async () => {
    try {
      return await fn();
    } catch (e) {
      setError(e.message);
      throw e;
    }
  }, message);
}
function ProviderIcon({ provider }) {
  return (
    <span
      className="connection-catalog-icon"
      style={{ background: provider?.color || "var(--green)" }}
      aria-hidden="true"
    >
      {provider?.monogram || <Plug size={22} />}
    </span>
  );
}
// The ducks on the team that a connection is granted to. The stored list keeps
// a duck that has been taken off the team, so that putting it back gives it the
// connection again; it is simply not one of the ducks using it today.
const granted = (data, connection) =>
  flock(data).filter((d) =>
    (() => {
      try {
        return JSON.parse(connection.allowed_ducks || "[]");
      } catch {
        return [];
      }
    })().includes(d.id),
  );

// The ducks stopped until this connection lets TameDuck in again.
const waitingOn = (data, c) => [
  ...new Set(
    (data.connection_blocks || [])
      .filter((b) => b.connection_id === c.id && b.kind === "sign_in")
      .map((b) => b.duck_name),
  ),
];

export default function Connections({ data, action, focus, unfocus }) {
  // Reconnect in Needs you opens this page on one connection. It used to open
  // the list, and the person had to find which one the duck meant.
  const cards = useRef({});
  useEffect(() => {
    const card = cards.current[focus];
    if (!card) return;
    card.scrollIntoView({ block: "center" });
    // Its first button is the fix: Finish sign-in for an account sign-in,
    // Configure for a key.
    card.querySelector(".connected-actions button")?.focus();
  }, [focus]);
  const [catalog, setCatalog] = useState(null),
    [loadError, setLoadError] = useState(""),
    [query, setQuery] = useState(""),
    [category, setCategory] = useState("All"),
    [dialog, setDialog] = useState(null),
    [testing, setTesting] = useState(null),
    [letting, setLetting] = useState(null),
    [fixed, setFixed] = useState(null),
    [error, setError] = useState("");
  // The button went with the problem, so the keyboard goes to Configure, not
  // to nothing. After the refreshed card is on the screen, hence an effect.
  useEffect(() => {
    if (!fixed) return;
    cards.current[fixed]?.querySelector(".connected-actions button")?.focus();
    setFixed(null);
  }, [fixed]);
  const letIn = async (c, ducks) => {
    setLetting(c.id);
    const r = await change(
      action,
      setError,
      () =>
        api("/connections/" + c.id + "/allow-on-key", "POST", {
          ducks: ducks.map((d) => d.id),
        }),
      // A paused or disconnected tool stays off, and its ducks keep waiting.
      joined(ducks.map((d) => d.name)) +
        (c.enabled
          ? " can now use " + c.name + "."
          : " can use " + c.name + " once it is switched on."),
    );
    setLetting(null);
    if (r) setFixed(c.id);
  };
  const load = () =>
    api("/connections/catalog")
      .then(setCatalog)
      .catch((e) => setLoadError(e.message));
  useEffect(() => {
    load();
  }, []);
  const providers = catalog?.providers || [];
  const filtered = providers.filter(
    (p) =>
      (category === "All" || p.category === category) &&
      [p.name, p.description, p.category]
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase().trim()),
  );
  const connected = data.connections.filter(
    (c) => c.enabled && c.connection_status === "connected",
  ).length;
  return (
    <div className="connections-page">
      <SettingsHead page="connections" />
      <div className="connection-catalog-summary">
        <span>
          <Plug size={19} />
          <strong>{connected} connected</strong>
          <span>in {data.company.name}</span>
        </span>
        <Button
          className="secondary small"
          onClick={() => setDialog({ custom: {} })}
        >
          <Plus size={15} />
          Custom MCP server
        </Button>
      </div>
      {error && (
        <div className="connection-catalog-error" role="alert">
          {error}
        </div>
      )}
      {data.connections.length > 0 && (
        <section className="connected-section" aria-label="Your connections">
          <h3>
            Your connections{" "}
            <span className="connection-catalog-count">
              {data.connections.length}
            </span>
          </h3>
          <div className="connected-list">
            {data.connections.map((c) => {
              const provider = providers.find((p) => p.id === c.provider_id),
                needsAuth =
                  c.auth_type === "oauth" &&
                  (!c.has_oauth || c.connection_status === "auth_required");
              const status =
                c.connection_status === "disconnected"
                  ? "Disconnected"
                  : !c.enabled
                    ? "Paused"
                    : c.connection_status === "connected"
                      ? "Connected"
                      : c.connection_status === "error"
                        ? "Check connection"
                        : needsAuth
                          ? "Finish sign-in"
                          : // A key connection with no key. It said "Ready
                            // to test" beside "Choose a saved key".
                            c.connection_status === "auth_required"
                            ? "Choose a key"
                            : "Ready to test";
              // The ducks this is for that its key does not let in. It said
              // Connected while they were refused at work, so where it would
              // say Connected (or Ready to test) it says how many instead.
              // Paused and the other states are bigger news and stay.
              const key = data.secrets.find((s) => s.id === c.secret_id),
                offKey = notOnKey(flock(data), key, c.allowed_ducks),
                blocked =
                  offKey.length > 0 &&
                  (status === "Connected" || status === "Ready to test");
              return (
                <article
                  className={
                    "connected-item" + (focus === c.id ? " focused" : "")
                  }
                  key={c.id}
                  ref={(el) => (cards.current[c.id] = el)}
                >
                  <div className="connected-top">
                    <ProviderIcon provider={provider} />
                    <div className="connected-name">
                      <h4>{c.name}</h4>
                      <p>
                        {/* The ducks on the team that this is granted to. A
                            duck taken off the team keeps its grant for when it
                            comes back, but it is not one of the ducks using
                            this today. */}
                        {granted(data, c).length}{" "}
                        {granted(data, c).length === 1 ? "duck" : "ducks"} ·{" "}
                        {c.auth_type === "oauth"
                          ? "Account sign-in"
                          : c.secret_id
                            ? "Saved key"
                            : "No account"}
                        {c.connection_status === "connected"
                          ? " · " + plural(parse(c.tools).length, "tool")
                          : ""}
                      </p>
                    </div>
                    <span
                      className={
                        "pill " +
                        (blocked
                          ? "warning"
                          : status === "Connected"
                            ? "success"
                            : "")
                      }
                    >
                      {blocked
                        ? plural(offKey.length, "duck") + " blocked"
                        : status}
                    </span>
                  </div>
                  {c.last_error && (
                    <p className="connection-error">
                      <AlertCircle size={15} />
                      {c.last_error}
                    </p>
                  )}
                  {waitingOn(data, c).length > 0 && (
                    <p className="connection-waiting">
                      {joined(waitingOn(data, c))}{" "}
                      {waitingOn(data, c).length === 1 ? "is" : "are"} waiting
                      for this to work again.
                    </p>
                  )}
                  {offKey.length > 0 && (
                    <p className="connection-key-warn">
                      <AlertCircle size={16} aria-hidden="true" />
                      <span>
                        {offKey.map((d, i) => (
                          <React.Fragment key={d.id}>
                            {i > 0 && (i < offKey.length - 1 ? ", " : " and ")}
                            <strong>{d.name}</strong>
                          </React.Fragment>
                        ))}{" "}
                        cannot use {c.name}. Its key, {key.name}, does not allow{" "}
                        {offKey.length === 1 ? "it" : "them"}.
                      </span>
                    </p>
                  )}
                  <div className="connected-actions">
                    {offKey.length > 0 && (
                      <Button
                        className="small"
                        busy={letting === c.id}
                        onClick={() => letIn(c, offKey)}
                      >
                        <Check size={14} aria-hidden="true" />
                        {offKey.length === 1
                          ? "Let it use the key"
                          : "Let them use the key"}
                      </Button>
                    )}
                    {c.auth_type === "oauth" && (
                      <Button
                        className="secondary small"
                        onClick={() => setDialog({ provider, connection: c })}
                      >
                        {needsAuth ? "Finish sign-in" : "Reconnect account"}
                        <ArrowUpRight size={14} />
                      </Button>
                    )}
                    <Button
                      className="secondary small"
                      onClick={() => setDialog({ custom: c })}
                    >
                      <Settings2 size={14} />
                      Configure
                    </Button>
                    <Button
                      className="secondary small"
                      busy={testing === c.id}
                      disabled={!c.enabled || needsAuth}
                      onClick={async () => {
                        setTesting(c.id);
                        const r = await change(action, setError, () =>
                          api("/connections/" + c.id + "/test", "POST", {}),
                        );
                        if (r)
                          await action(
                            async () => r,
                            "Connected. Found " + plural(r.tools.length, "tool") + ".",
                          );
                        setTesting(null);
                      }}
                    >
                      <RefreshCw size={14} />
                      Test
                    </Button>
                    {/* Only something that is connected, or has a sign-in, can
                        be disconnected. A service added and never tested
                        showed Disconnect beside "0 connected", and its dialog
                        promised to remove an account sign-in it did not have.
                        Remove is the way out for that one. */}
                    {!!(
                      c.has_oauth ||
                      (c.enabled &&
                        ["connected", "error"].includes(c.connection_status))
                    ) && (
                      <button
                        className="connection-catalog-text-button"
                        onClick={() => setDialog({ disconnect: c })}
                      >
                        <Unplug size={14} />
                        Disconnect
                      </button>
                    )}
                    {/* Disconnecting only switches it off, so a service tried
                        once and abandoned stayed on this list for good. */}
                    <button
                      className="connection-catalog-text-button danger"
                      onClick={() => setDialog({ remove: c })}
                    >
                      <Trash2 size={14} />
                      Remove
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}
      <section
        className="connection-catalog-section"
        aria-label="Service catalog"
      >
        <div className="connection-catalog-section-title">
          <div>
            <h3>Explore connections</h3>
            <p>Official hosted servers, with setup already filled in.</p>
          </div>
          <span className="connection-catalog-count">
            {providers.length} services
          </span>
        </div>
        <div className="connection-catalog-search">
          <Search size={18} />
          <input
            aria-label="Search services"
            placeholder="Search services or what you want to do…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div
          className="connection-catalog-filters"
          aria-label="Filter services"
        >
          {["All", ...new Set(providers.map((p) => p.category))].map((c) => (
            <button
              key={c}
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          ))}
        </div>
        {loadError ? (
          <div className="connection-catalog-error" role="alert">
            {loadError}
            <Button
              className="secondary small"
              onClick={() => {
                setLoadError("");
                load();
              }}
            >
              Retry
            </Button>
          </div>
        ) : !catalog ? (
          <p role="status">Loading services…</p>
        ) : filtered.length ? (
          <div className="connection-catalog-grid">
            {filtered.map((p) => {
              const existing = data.connections.find(
                (c) => c.provider_id === p.id,
              );
              return (
                <article className="connection-catalog-card" key={p.id}>
                  <div className="connection-catalog-card-top">
                    <ProviderIcon provider={p} />
                    <div>
                      <h4>{p.name}</h4>
                      <span>{p.category}</span>
                    </div>
                    {existing && <Check size={18} aria-label="Added" />}
                  </div>
                  <p>{p.description}</p>
                  <div className="connection-catalog-card-bottom">
                    <span>{authLabel[p.auth[0]]}</span>
                    <Button
                      className={"small " + (existing ? "secondary" : "")}
                      onClick={() =>
                        setDialog(
                          existing ? { custom: existing } : { provider: p },
                        )
                      }
                    >
                      {existing ? "Configure" : "Connect"}
                      {!existing && <Plus size={14} />}
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <Empty as="h3" icon={Search} title="No services found">
            Try another search or add a custom MCP server.
          </Empty>
        )}
      </section>
      <div className="info-box">
        <ShieldCheck size={20} />
        <span>
          You choose which ducks get access. Connected tool actions ask for
          approval. Each provider’s plan and usage limits still apply.
        </span>
      </div>
      {dialog?.provider && (
        <Activate
          provider={dialog.provider}
          connection={dialog.connection}
          data={data}
          action={action}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.custom && (
        <ConnectionEditor
          connection={dialog.custom}
          data={data}
          action={action}
          onClose={() => setDialog(null)}
          provider={providers.find((p) => p.id === dialog.custom.provider_id)}
          onSignIn={(c) =>
            setDialog({
              provider: providers.find((p) => p.id === c.provider_id),
              connection: c,
            })
          }
        />
      )}
      {dialog?.disconnect && (
        <Disconnect
          connection={dialog.disconnect}
          action={action}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.remove && (
        <Remove
          connection={dialog.remove}
          action={action}
          focus={focus}
          unfocus={unfocus}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
function SecretOptions({ data, empty = "Choose a saved key" }) {
  return (
    <>
      <option value="">{empty}</option>
      {[...(data.secret_groups || []), { id: null, name: "Ungrouped" }].map(
        (g) => {
          const secrets = data.secrets.filter(
            (s) => (s.group_id || null) === g.id,
          );
          return secrets.length ? (
            <optgroup key={g.id || "none"} label={g.name}>
              {secrets.map((s) => (
                <option value={s.id} key={s.id}>
                  {s.name}
                </option>
              ))}
            </optgroup>
          ) : null;
        },
      )}
    </>
  );
}
function Activate({ provider, connection, data, action, onClose }) {
  const [mode, setMode] = useState(connection?.auth_type || provider.auth[0]),
    [ducks, setDucks] = useState(parse(connection?.allowed_ducks)),
    // What the person actually chose, counted against the team as it is. A
    // grant kept for a duck that is off the team is not a duck that can use
    // this today, and telling them "3 ducks" for two is the kind of number
    // people rely on.
    chosen = flock(data).filter((d) => ducks.includes(d.id)),
    [keyMode, setKeyMode] = useState("new"),
    [secretId, setSecretId] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [created, setCreated] = useState(connection?.id),
    [result, setResult] = useState(null);
  // Ticked ducks the chosen key does not let in; connecting lets them in, as
  // saving does in Configure.
  const key = data.secrets.find((s) => s.id === secretId),
    offKey =
      mode === "secret" && keyMode === "saved" && !created
        ? notOnKey(flock(data), key, ducks)
        : [];
  const submit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    const r = await change(action, setError, async () => {
      let connectionId = created;
      if (!connectionId) {
        const added = await api(
          "/connections/catalog/" + provider.id + "/connect",
          "POST",
          {
            auth_type: mode,
            allowed_ducks: ducks,
            ...(mode === "secret"
              ? keyMode === "new"
                ? {
                    new_secret: {
                      name: f.secret_name,
                      value: f.secret_value,
                      group_id: f.group_id || null,
                    },
                  }
                : {
                    secret_id: f.secret_id,
                    add_to_key: offKey.map((d) => d.id),
                  }
              : {}),
          },
        );
        connectionId = added.id;
        setCreated(connectionId);
        if (mode !== "oauth") {
          setResult(added);
          return added;
        }
      }
      if (mode === "oauth") {
        const signIn = await api(
          "/connections/" + connectionId + "/oauth",
          "POST",
          {},
        );
        window.location.assign(signIn.authorization_url);
        return signIn;
      }
      const checked = await api(
        "/connections/" + connectionId + "/test",
        "POST",
        {},
      );
      const done = { connected: true, tool_count: checked.tools.length };
      setResult(done);
      return done;
    });
    setBusy(false);
  };
  return (
    <Modal
      title={(connection ? "Reconnect " : "Connect ") + provider.name}
      warnUnsaved
      onClose={onClose}
    >
      <div className="activation-intro">
        <ProviderIcon provider={provider} />
        <p>{provider.description}</p>
      </div>
      {result ? (
        <div className="activation-result">
          <div
            className={
              "connection-catalog-error " +
              (result.connected ? "connection-success" : "")
            }
            role="status"
          >
            <strong>
              {result.connected
                ? `${provider.name} is connected`
                : "Saved — connection needs attention"}
            </strong>
            {/* The picker starts with nothing ticked, so this cheerfully
                reported that the tools were ready for ducks nobody had chosen,
                and no duck could use the connection at all. */}
            <p>
              {!result.connected
                ? result.error
                : chosen.length
                  ? `${plural(result.tool_count, "tool")} ${result.tool_count === 1 ? "is" : "are"} ready for ${
                      chosen.length === 1
                        ? "the duck"
                        : chosen.length + " ducks"
                    } you chose.`
                  : `${plural(result.tool_count, "tool")} ${result.tool_count === 1 ? "is" : "are"} ready, but no duck may use ${result.tool_count === 1 ? "it" : "them"} yet. Choose which ducks can under Your connections.`}
            </p>
          </div>
          <p>You can manage access and test again under Your connections.</p>
          <Button onClick={onClose}>Done</Button>
        </div>
      ) : (
        <form onSubmit={submit}>
          {!created && provider.auth.length > 1 && (
            <Field label="How would you like to connect?">
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                {provider.auth.map((a) => (
                  <option key={a} value={a}>
                    {authLabel[a]}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {mode === "oauth" && (
            <div className="info-box">
              <ArrowUpRight size={18} />
              <span>
                You’ll continue to {provider.name} to sign in and choose what to
                share with this company.
              </span>
            </div>
          )}
          {mode === "secret" && !created && (
            <>
              <Field label="API key">
                <select
                  value={keyMode}
                  onChange={(e) => setKeyMode(e.target.value)}
                >
                  <option value="new">Add a new key</option>
                  <option value="saved">Use a saved secret</option>
                </select>
              </Field>
              {keyMode === "new" ? (
                <>
                  <Field
                    label={provider.keyLabel || "API key"}
                    hint={
                      provider.keyHint ||
                      "Encrypted when saved. Only the ducks you select below can use this key."
                    }
                  >
                    <input
                      type="password"
                      name="secret_value"
                      autoComplete="new-password"
                      required
                      maxLength={20000}
                    />
                  </Field>
                  <div className="connection-key-fields">
                    <Field label="Save key as">
                      <input
                        name="secret_name"
                        defaultValue={
                          provider.id.replaceAll("-", "_").toUpperCase() +
                          "_API_KEY"
                        }
                        maxLength={100}
                        required
                      />
                    </Field>
                    <Field label="Secret group">
                      <select name="group_id">
                        <option value="">Ungrouped</option>
                        {(data.secret_groups || []).map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                </>
              ) : (
                <Field label="Saved secret" hint={keyHint(flock(data), key)}>
                  <select
                    name="secret_id"
                    value={secretId}
                    onChange={(e) => setSecretId(e.target.value)}
                    required
                  >
                    <SecretOptions data={data} />
                  </select>
                </Field>
              )}
              {provider.keyUrl && (
                <a
                  className="connection-catalog-help-link"
                  href={provider.keyUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Get a key from {provider.name}
                  <ArrowUpRight size={14} />
                </a>
              )}
            </>
          )}
          {!created && (
            <Field
              label="Ducks with access"
              hint="Choose your team now. You can change this later."
            >
              <DuckPicker
                ducks={flock(data)}
                value={ducks}
                onChange={setDucks}
                note={(d) =>
                  offKey.some((o) => o.id === d.id) ? "Not on key" : null
                }
              />
            </Field>
          )}
          {offKey.length > 0 && (
            <div className="info-box" role="status">
              <KeyRound size={18} aria-hidden="true" />
              <span>{alsoLets("Connecting", offKey)}</span>
            </div>
          )}
          {provider.hint && (
            <p className="connection-catalog-hint">{provider.hint}</p>
          )}
          <a
            className="connection-catalog-help-link"
            href={provider.docs}
            target="_blank"
            rel="noreferrer"
          >
            <BookOpen size={15} />
            Official setup guide
            <ArrowUpRight size={14} />
          </a>
          {error && (
            <div className="connection-catalog-error" role="alert">
              {error}
            </div>
          )}
          <div className="modal-actions">
            <Button className="secondary" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button busy={busy}>
              {mode === "oauth"
                ? `Sign in with ${provider.name}`
                : created
                  ? "Try connection again"
                  : "Connect " + provider.name}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
function ConnectionEditor({
  connection,
  data,
  action,
  onClose,
  provider,
  onSignIn,
}) {
  const [ducks, setDucks] = useState(parse(connection.allowed_ducks)),
    [keyMode, setKeyMode] = useState(
      connection.secret_id
        ? "saved"
        : provider && !provider.auth.includes("none")
          ? "new"
          : "none",
    ),
    [secretId, setSecretId] = useState(connection.secret_id || ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  // Ticked ducks the chosen key does not let in. Saving lets them in, and
  // says so first. The save used to be refused, even with nothing changed.
  const team = flock(data),
    key = data.secrets.find((s) => s.id === secretId),
    offKey =
      keyMode === "saved" && connection.auth_type !== "oauth"
        ? notOnKey(team, key, ducks)
        : [];
  const baseSecretName =
    (connection.name || "MCP")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .slice(0, 75) + "_TOKEN";
  let suggestedSecretName = baseSecretName;
  for (let n = 2; data.secrets.some((s) => s.name === suggestedSecretName); n++)
    suggestedSecretName = baseSecretName + "_" + n;
  return (
    <Modal
      title={
        connection.id
          ? "Configure " + connection.name
          : "Connect a custom MCP server"
      }
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const f = Object.fromEntries(new FormData(e.currentTarget));
          const r = await change(
            action,
            setError,
            () =>
              api(
                "/connections" + (connection.id ? "/" + connection.id : ""),
                connection.id ? "PATCH" : "POST",
                {
                  name: f.name,
                  url: f.url,
                  secret_id: keyMode === "saved" ? f.secret_id || null : null,
                  ...(keyMode === "new" &&
                  connection.auth_type !== "oauth" &&
                  (!provider || provider.auth.includes("secret"))
                    ? {
                        new_secret: {
                          name: f.secret_name,
                          value: f.secret_value,
                          group_id: f.group_id || null,
                        },
                      }
                    : {}),
                  allowed_ducks: ducks,
                  add_to_key: offKey.map((d) => d.id),
                  enabled: f.enabled === "on",
                },
              ),
            "Connection saved",
          );
          setBusy(false);
          if (r) onClose();
        }}
      >
        <Field label="Name">
          <input
            name="name"
            defaultValue={connection.name}
            maxLength={100}
            required
          />
        </Field>
        <Field
          label="Server address"
          hint={
            provider
              ? "Official hosted server."
              : "Public HTTPS endpoint using Streamable HTTP."
          }
        >
          <input
            name="url"
            type="url"
            defaultValue={connection.url}
            readOnly={!!provider}
            placeholder="https://mcp.example.com/mcp"
            required
            maxLength={2000}
          />
        </Field>
        {connection.auth_type === "oauth" ? (
          <div className="info-box">
            <ShieldCheck size={18} />
            <span>
              Uses {provider?.name || connection.name} browser sign-in.
            </span>
            <Button
              type="button"
              className="secondary small"
              onClick={() => onSignIn(connection)}
            >
              Sign in again
            </Button>
          </div>
        ) : provider && !provider.auth.includes("secret") ? (
          <div className="info-box">
            <ShieldCheck size={18} />
            <span>No account or key is needed for this service.</span>
          </div>
        ) : (
          <>
            <Field
              label="Authentication"
              hint="Keys are sent as Bearer tokens only to this server."
            >
              <select
                value={keyMode}
                onChange={(e) => setKeyMode(e.target.value)}
              >
                {(!provider || provider.auth.includes("none")) && (
                  <option value="none">No authentication</option>
                )}
                <option value="new">Add a new key</option>
                <option value="saved" disabled={!data.secrets.length}>
                  Use a saved secret
                </option>
              </select>
            </Field>
            {keyMode === "new" && (
              <>
                <Field
                  label={provider?.keyLabel || "Bearer token"}
                  hint="Paste only the token, without the Bearer prefix. It will be encrypted and saved for the ducks you select below."
                >
                  <input
                    type="password"
                    name="secret_value"
                    autoComplete="new-password"
                    required
                    maxLength={20000}
                  />
                </Field>
                <div className="connection-key-fields">
                  <Field label="Save key as">
                    <input
                      name="secret_name"
                      defaultValue={suggestedSecretName}
                      required
                      maxLength={100}
                    />
                  </Field>
                  <Field label="Secret group">
                    <select name="group_id">
                      <option value="">Ungrouped</option>
                      {(data.secret_groups || []).map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              </>
            )}
            {keyMode === "saved" && (
              <Field label="Saved secret" hint={keyHint(team, key)}>
                <select
                  name="secret_id"
                  value={secretId}
                  onChange={(e) => setSecretId(e.target.value)}
                  required
                >
                  <SecretOptions data={data} />
                </select>
              </Field>
            )}
          </>
        )}
        <Field label="Ducks with access">
          <DuckPicker
            ducks={team}
            value={ducks}
            onChange={setDucks}
            note={(d) =>
              offKey.some((o) => o.id === d.id) ? "Not on key" : null
            }
          />
        </Field>
        {offKey.length > 0 && (
          <div className="info-box" role="status">
            <KeyRound size={18} aria-hidden="true" />
            <span>{alsoLets("Saving", offKey)}</span>
          </div>
        )}
        <label className="checkbox-line">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={connection.id ? !!connection.enabled : true}
          />
          Enable this connection
        </label>
        {error && (
          <div className="connection-catalog-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <Button className="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={busy}>Save connection</Button>
        </div>
      </form>
    </Modal>
  );
}
function Disconnect({ connection, action, onClose }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal title={"Disconnect " + connection.name + "?"} onClose={onClose}>
      <p>
        Ducks will stop using this service. Its TameDuck account sign-in will be
        removed. Saved API keys stay in Secrets so you can use them again.
      </p>
      <p>
        You can also revoke TameDuck’s authorization in the provider’s account
        settings.
      </p>
      {error && (
        <div className="connection-catalog-error" role="alert">
          {error}
        </div>
      )}
      <div className="modal-actions">
        <Button className="secondary" onClick={onClose}>
          Keep connection
        </Button>
        <Button
          busy={busy}
          onClick={async () => {
            setBusy(true);
            const r = await change(
              action,
              setError,
              () =>
                api(
                  "/connections/" + connection.id + "/disconnect",
                  "POST",
                  {},
                ),
              "Connection disconnected",
            );
            setBusy(false);
            if (r) onClose();
          }}
        >
          Disconnect
        </Button>
      </div>
    </Modal>
  );
}
// Removing cannot be undone, so it asks first, in a dialog like Disconnect's
// beside it. It asked in the browser's own pop-up.
function Remove({ connection, action, focus, unfocus, onClose }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    // The button that opened it. Closing the dialog takes the keyboard with
    // it, so it is handed back, unless that button went with the connection.
    [opener] = useState(() => document.activeElement);
  useEffect(
    () => () =>
      opener?.isConnected &&
      document.activeElement === document.body &&
      opener.focus(),
    [],
  );
  return (
    <Modal
      title={"Remove " + connection.name + "?"}
      ariaLabel={"Remove " + connection.name + "?"}
      onClose={onClose}
    >
      <p>
        Its sign-in and its record of approved actions go with it, and ducks
        lose its tools. This cannot be undone.
      </p>
      {error && (
        <div className="connection-catalog-error" role="alert">
          {error}
        </div>
      )}
      <div className="modal-actions">
        <Button className="secondary" onClick={onClose}>
          Keep connection
        </Button>
        <Button
          busy={busy}
          onClick={async () => {
            setBusy(true);
            // Off this connection's own page first, or the page says the
            // connection it is on has gone missing.
            if (focus === connection.id) unfocus?.();
            const r = await change(
              action,
              setError,
              () => api("/connections/" + connection.id, "DELETE"),
              connection.name + " removed",
            );
            setBusy(false);
            if (r) onClose();
          }}
        >
          Remove
        </Button>
      </div>
    </Modal>
  );
}
