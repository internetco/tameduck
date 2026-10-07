import React, { useEffect, useState } from "react";
import {
  Plus,
  Search,
  Folder,
  FolderPlus,
  KeyRound,
  LockKeyhole,
  ChevronDown,
  ChevronRight,
  Pencil,
  Trash2,
  ArrowRight,
  X,
} from "lucide-react";
import {
  api,
  Button,
  Field,
  Modal,
  IconButton,
  DuckPicker,
  Empty,
  flock,
} from "./ui.jsx";
import "./secret-groups.css";
import SettingsHead from "./SettingsHead.jsx";
import { usedBy } from "../shared/key-access.mjs";
const countLabel = (n) => `${n} secret${n === 1 ? "" : "s"}`;
const groupPayload = (group, name) =>
  group === "new"
    ? { new_group: { name: name.trim() } }
    : { group_id: group || null };

async function submitChange(action, setError, perform, success) {
  setError("");
  return action(async () => {
    try {
      return await perform();
    } catch (error) {
      setError(error.message);
      throw error;
    }
  }, success);
}

export default function Secrets({ data, action }) {
  const [dialog, setDialog] = useState(null);
  const [selected, setSelected] = useState([]);
  const [search, setSearch] = useState("");
  const [duckFilter, setDuckFilter] = useState("");
  const [creatorFilter, setCreatorFilter] = useState("");
  const [collapsed, setCollapsed] = useState([]);
  const groups = data.secret_groups || [];
  const activeDucks = flock(data);
  const creators = Array.from(
    new Map(
      data.secrets
        .filter((secret) => secret.creator)
        .map(({ creator }) => [creator.type + ":" + creator.id, creator]),
    ).values(),
  ).sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.type.localeCompare(b.type) ||
      a.id.localeCompare(b.id),
  );
  const query = search.trim().toLowerCase();
  const filtersActive = !!duckFilter || !!creatorFilter;
  const filtering = !!query || filtersActive;
  const matchesFilters = (secret) => {
    const allowed = JSON.parse(secret.allowed_ducks || "[]");
    const duckMatches =
      !duckFilter ||
      (duckFilter === "none"
        ? !activeDucks.some((duck) => allowed.includes(duck.id))
        : allowed.includes(duckFilter));
    const creatorKey = secret.creator
      ? secret.creator.type + ":" + secret.creator.id
      : "unknown";
    return duckMatches && (!creatorFilter || creatorKey === creatorFilter);
  };
  const sections = [...groups, { id: null, name: "Ungrouped" }]
    .map((group) => ({
      ...group,
      secrets: data.secrets.filter(
        (s) => (s.group_id || null) === group.id && matchesFilters(s),
      ),
    }))
    .map((group) => ({
      ...group,
      visible: group.secrets.filter(
        (s) =>
          !query || (group.name + " " + s.name).toLowerCase().includes(query),
      ),
    }))
    .filter((group) =>
      filtersActive
        ? group.visible.length
        : query
          ? group.visible.length || group.name.toLowerCase().includes(query)
          : group.id || group.secrets.length,
    );
  // A refreshed grant/name can hide a selected row without a filter change.
  const visibleIdKey = JSON.stringify(
    sections.flatMap((group) => group.visible.map((secret) => secret.id)),
  );
  useEffect(() => {
    const visible = new Set(JSON.parse(visibleIdKey));
    setSelected((ids) => {
      const next = ids.filter((id) => visible.has(id));
      return next.length === ids.length ? ids : next;
    });
  }, [visibleIdKey]);
  // What is actually on the screen, counted the way the list below is built.
  const shownSecrets = sections.reduce((n, g) => n + g.visible.length, 0);
  const shownGroups = sections.filter((g) => g.id).length;
  const toggle = (id) =>
    setSelected((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
    );
  const close = () => setDialog(null);
  const saved = () => {
    setDialog(null);
    setSearch("");
    setDuckFilter("");
    setCreatorFilter("");
    setSelected([]);
    setCollapsed([]);
  };
  return (
    <div className="secrets-page">
      <SettingsHead page="secrets">
        <Button
          className="secondary"
          onClick={() => setDialog({ type: "group" })}
        >
          <FolderPlus size={16} />
          New group
        </Button>
        <Button onClick={() => setDialog({ type: "add" })}>
          <Plus size={16} />
          Add secrets
        </Button>
      </SettingsHead>
      <div className="secrets-toolbar">
        <div className="search-field">
          <Search size={16} />
          <input
            aria-label="Search secrets and groups"
            placeholder="Find a secret or group…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setSelected([]);
            }}
          />
        </div>
        <label className="secret-filter">
          <span>Duck access</span>
          <select
            aria-label="Duck access"
            value={duckFilter}
            onChange={(e) => {
              setDuckFilter(e.target.value);
              setSelected([]);
            }}
          >
            <option value="">All ducks</option>
            {activeDucks.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
            <option value="none">No duck access</option>
          </select>
        </label>
        <label className="secret-filter">
          <span>Created by</span>
          <select
            aria-label="Created by"
            value={creatorFilter}
            onChange={(e) => {
              setCreatorFilter(e.target.value);
              setSelected([]);
            }}
          >
            <option value="">All creators</option>
            <option value="unknown">Unknown</option>
            {creators.map((c) => (
              <option key={c.type + ":" + c.id} value={c.type + ":" + c.id}>
                {c.name} ({c.type === "duck" ? "Duck" : "Person"})
              </option>
            ))}
          </select>
        </label>
        {(filtersActive || query) && (
          <button
            className="secrets-clear-filters"
            onClick={() => {
              setSearch("");
              setDuckFilter("");
              setCreatorFilter("");
              setSelected([]);
            }}
          >
            Clear filters
          </button>
        )}
        {/* Sitting in the search toolbar, this read as a result count and
            was not: it was the raw totals, so a search that left two keys on
            the screen still said "24 secrets - 5 groups" beside the box that
            had just been typed into. */}
        <span>
          {countLabel(shownSecrets)} · {shownGroups}{" "}
          {shownGroups === 1 ? "group" : "groups"}
          {filtering ? " found" : ""}
        </span>
      </div>
      {!!selected.length && (
        <div
          className="secrets-selection"
          role="region"
          aria-label="Selected secrets"
        >
          <strong>{selected.length} selected</strong>
          <Button
            className="small"
            onClick={() => {
              const selectedSecrets = data.secrets.filter((secret) =>
                selected.includes(secret.id),
              );
              const currentGroup = selectedSecrets[0]?.group_id || null;
              setDialog({
                type: "move",
                ids: selected,
                group_id: selectedSecrets.every(
                  (secret) => (secret.group_id || null) === currentGroup,
                )
                  ? currentGroup
                  : null,
              });
            }}
          >
            <Folder size={15} />
            Move to group
          </Button>
          <button className="secrets-clear" onClick={() => setSelected([])}>
            Clear selection
          </button>
        </div>
      )}
      <div className="secret-groups">
        {sections.map((group) => {
          const hidden = collapsed.includes(group.id) && !filtering;
          return (
            <section
              className="secret-group"
              key={group.id || "ungrouped"}
              aria-label={group.name + " secrets"}
            >
              <div className="secret-group-heading">
                <button
                  className="secret-group-toggle"
                  aria-expanded={!hidden}
                  onClick={() =>
                    setCollapsed((ids) =>
                      ids.includes(group.id)
                        ? ids.filter((id) => id !== group.id)
                        : [...ids, group.id],
                    )
                  }
                >
                  {hidden ? (
                    <ChevronRight size={16} />
                  ) : (
                    <ChevronDown size={16} />
                  )}
                  <span className="secret-group-icon">
                    {group.id ? <Folder size={18} /> : <KeyRound size={18} />}
                  </span>
                  <span>
                    <h3>{group.name}</h3>
                    <small>{countLabel(group.visible.length)}</small>
                  </span>
                </button>
                <div className="secret-group-actions">
                  <IconButton
                    icon={Plus}
                    label={"Add secrets to " + group.name}
                    onClick={() =>
                      setDialog({ type: "add", group_id: group.id })
                    }
                  />
                  {group.id && (
                    <>
                      <IconButton
                        icon={Pencil}
                        label={"Rename group " + group.name}
                        onClick={() => setDialog({ type: "group", group })}
                      />
                      <IconButton
                        icon={Trash2}
                        label={"Remove group " + group.name}
                        onClick={() =>
                          setDialog({ type: "remove-group", group })
                        }
                      />
                    </>
                  )}
                </div>
              </div>
              {!hidden && (
                <div className="secret-group-items">
                  {group.visible.map((secret) => {
                    // Counted from the ducks actually on the team, not from
                    // the stored list. A duck taken off the team keeps its
                    // grant so that putting it back gives it access again -
                    // but it is not one of the ducks with access today, and
                    // the number said it was while the names beside it did
                    // not include it.
                    const ducks = flock(data).filter((d) =>
                      JSON.parse(secret.allowed_ducks).includes(d.id),
                    );
                    const duckNames = ducks.map((d) => d.name).join(", ");
                    const tools = usedBy(data.connections || [], secret.id);
                    return (
                      <div
                        className={
                          "secret-item " +
                          (selected.includes(secret.id) ? "is-selected" : "")
                        }
                        key={secret.id}
                      >
                        <input
                          type="checkbox"
                          aria-label={"Select " + secret.name}
                          checked={selected.includes(secret.id)}
                          onChange={() => toggle(secret.id)}
                        />
                        <button
                          className="secret-item-open"
                          onClick={() => setDialog({ type: "edit", secret })}
                        >
                          <KeyRound size={17} />
                          <span>
                            <strong>{secret.name}</strong>
                            <small title={duckNames}>
                              {ducks.length
                                ? `${ducks.length} ${ducks.length === 1 ? "duck" : "ducks"} with access`
                                : "No duck access yet"}
                              {tools && " · " + tools}
                            </small>
                            <small>
                              Created by {secret.creator?.name || "Unknown"}
                              {secret.creator &&
                                ` (${secret.creator.type === "duck" ? "Duck" : "Person"})`}
                            </small>
                          </span>
                        </button>
                        <div className="secret-item-actions">
                          <IconButton
                            icon={Folder}
                            label={"Move " + secret.name + " to a group"}
                            onClick={() =>
                              setDialog({
                                type: "move",
                                ids: [secret.id],
                                group_id: secret.group_id,
                              })
                            }
                          />
                          <IconButton
                            icon={Pencil}
                            label={"Edit " + secret.name}
                            onClick={() => setDialog({ type: "edit", secret })}
                          />
                          <IconButton
                            icon={Trash2}
                            label={"Delete " + secret.name}
                            onClick={() =>
                              setDialog({ type: "delete", secret })
                            }
                          />
                        </div>
                      </div>
                    );
                  })}
                  {!group.visible.length && (
                    <div className="secret-group-empty">
                      <span>
                        {filtering
                          ? "No matching secrets in this group."
                          : "Ready for your first secret."}
                      </span>
                      <button
                        onClick={() =>
                          setDialog({ type: "add", group_id: group.id })
                        }
                      >
                        Add secrets <ArrowRight size={14} />
                      </button>
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })}
        {!sections.length && (
          <Empty
            as="h3"
            icon={filtering ? Search : LockKeyhole}
            title={
              filtering
                ? "No secrets or groups found"
                : "Keep the keys to your tools here."
            }
            action={
              !filtering && (
                <Button onClick={() => setDialog({ type: "add" })}>
                  <Plus size={16} />
                  Add your first secrets
                </Button>
              )
            }
          >
            {filtering
              ? "Try another name or clear the filters."
              : "Add a few secrets together, then group them by tool, project, or purpose."}
          </Empty>
        )}
      </div>
      <p className="secrets-footnote">
        <LockKeyhole size={15} />
        <span>
          Values are encrypted and hidden after saving. Groups organize secrets;
          access stays with each secret.
        </span>
      </p>
      {dialog?.type === "add" && (
        <AddSecrets
          data={data}
          action={action}
          groupId={dialog.group_id}
          onClose={close}
          onSaved={saved}
        />
      )}
      {dialog?.type === "group" && (
        <GroupEditor
          group={dialog.group}
          action={action}
          onClose={close}
          onSaved={saved}
        />
      )}
      {dialog?.type === "move" && (
        <MoveSecrets
          data={data}
          action={action}
          ids={dialog.ids}
          groupId={dialog.group_id}
          onClose={close}
          onSaved={saved}
        />
      )}
      {dialog?.type === "edit" && (
        <SecretEditor
          secret={dialog.secret}
          data={data}
          action={action}
          onClose={close}
          onSaved={saved}
        />
      )}
      {dialog?.type === "remove-group" && (
        <ConfirmChange
          title={"Remove “" + dialog.group.name + "” group?"}
          label="Remove group"
          action={action}
          onClose={close}
          onSaved={saved}
          perform={() => api("/secret-groups/" + dialog.group.id, "DELETE")}
          success="Group removed. Its secrets are now ungrouped."
        >
          The secrets in this group will move to Ungrouped. Their values, duck
          access, and connections will stay the same.
        </ConfirmChange>
      )}
      {dialog?.type === "delete" && (
        <ConfirmChange
          title={"Delete “" + dialog.secret.name + "”?"}
          label="Delete secret"
          danger
          action={action}
          onClose={close}
          onSaved={saved}
          perform={() => api("/secrets/" + dialog.secret.id, "DELETE")}
          success="Secret deleted"
        >
          This permanently removes the saved value. A secret used by a
          connection must be detached first.
        </ConfirmChange>
      )}
    </div>
  );
}

function GroupChoice({
  groups,
  group,
  setGroup,
  name,
  setName,
  allowNew = true,
}) {
  return (
    <>
      <Field label="Group">
        <select value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="">Ungrouped</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
          {allowNew && <option value="new">+ Create a new group</option>}
        </select>
      </Field>
      {group === "new" && (
        <Field label="New group name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Website, Analytics, Payments"
            required
            maxLength={100}
          />
        </Field>
      )}
    </>
  );
}
function AddSecrets({ data, action, groupId, onClose, onSaved }) {
  const [group, setGroup] = useState(groupId || "");
  const [name, setName] = useState("");
  const [rows, setRows] = useState([
    { key: 0, name: "", value: "" },
    { key: 1, name: "", value: "" },
  ]);
  const [nextKey, setNextKey] = useState(2);
  const [ducks, setDucks] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const update = (key, field, value) => {
    setRows((list) =>
      list.map((row) => (row.key === key ? { ...row, [field]: value } : row)),
    );
    setError("");
  };
  return (
    <Modal title="Add secrets" onClose={onClose} warnUnsaved wide>
      <p>Save related keys together. Add one row per secret.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          const secrets = rows.map(({ name, value }) => ({
            name: name.trim(),
            value,
          }));
          if (new Set(secrets.map((s) => s.name)).size !== secrets.length) {
            setError("Each secret needs a different name.");
            return;
          }
          if (group === "new" && !name.trim()) {
            setError("Give the group a name.");
            return;
          }
          setBusy(true);
          const r = await submitChange(
            action,
            setError,
            () =>
              api("/secrets/batch", "POST", {
                ...groupPayload(group, name),
                secrets,
                allowed_ducks: ducks,
              }),
            `${countLabel(secrets.length)} saved`,
          );
          setBusy(false);
          if (r) onSaved();
        }}
      >
        <GroupChoice
          groups={data.secret_groups || []}
          group={group}
          setGroup={setGroup}
          name={name}
          setName={setName}
        />
        <div className="secret-entry-list">
          {rows.map((row, index) => (
            <fieldset className="secret-entry" key={row.key}>
              <legend>Secret {index + 1}</legend>
              <div className="secret-entry-fields">
                <Field label={"Secret name " + (index + 1)}>
                  <input
                    value={row.name}
                    onChange={(e) => update(row.key, "name", e.target.value)}
                    placeholder={index === 0 ? "API_KEY" : "API_SECRET"}
                    required
                    maxLength={100}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
                <Field label={"Secret value " + (index + 1)}>
                  <input
                    type="password"
                    value={row.value}
                    onChange={(e) => update(row.key, "value", e.target.value)}
                    placeholder="Paste the value"
                    required
                    maxLength={16000}
                    autoComplete="new-password"
                  />
                </Field>
                <IconButton
                  icon={X}
                  label={"Remove secret " + (index + 1)}
                  disabled={rows.length === 1 || busy}
                  onClick={() =>
                    setRows((list) => list.filter((r) => r.key !== row.key))
                  }
                />
              </div>
            </fieldset>
          ))}
        </div>
        <Button
          type="button"
          className="secondary small add-secret-row"
          disabled={rows.length >= 20 || busy}
          onClick={() => {
            setRows((list) => [...list, { key: nextKey, name: "", value: "" }]);
            setNextKey((n) => n + 1);
          }}
        >
          <Plus size={15} />
          Add another secret
        </Button>
        {/* The button simply stopped working at twenty, with no message and no
            count, so it read as the dialog being broken. */}
        {rows.length >= 20 && (
          <small className="muted add-secret-note">
            Twenty at a time is the most this form takes. Save these, then open
            it again for the rest.
          </small>
        )}
        <Field
          label="Ducks allowed to use these secrets"
          hint="Applies to all secrets in this form. You can change access for each secret later."
        >
          <DuckPicker ducks={flock(data)} value={ducks} onChange={setDucks} />
        </Field>
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <Button
            type="button"
            className="secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button busy={busy} type="submit">
            <LockKeyhole size={15} />
            Save {countLabel(rows.length)}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function GroupEditor({ group, action, onClose, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title={group ? "Rename group" : "Create a group"}
      warnUnsaved
      onClose={onClose}
    >
      <p>A group keeps the keys for one tool or project together.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          const name = new FormData(e.currentTarget).get("name").trim();
          if (!name) {
            setError("Give the group a name.");
            return;
          }
          setBusy(true);
          const r = await submitChange(
            action,
            setError,
            () =>
              api(
                "/secret-groups" + (group ? "/" + group.id : ""),
                group ? "PATCH" : "POST",
                { name },
              ),
            group ? "Group renamed" : "Group created",
          );
          setBusy(false);
          if (r) onSaved();
        }}
      >
        <Field label="Group name">
          <input
            name="name"
            defaultValue={group?.name || ""}
            required
            maxLength={100}
            placeholder="e.g. Website, Analytics, Payments"
            autoFocus
          />
        </Field>
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <Button
            type="button"
            className="secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            {group ? "Save name" : "Create group"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function MoveSecrets({ data, action, ids, groupId, onClose, onSaved }) {
  const [group, setGroup] = useState(groupId || "");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title={"Move " + countLabel(ids.length)} onClose={onClose}>
      <p>
        Choose a group or create one. Duck access and connections stay the same.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          if (group === "new" && !name.trim()) {
            setError("Give the group a name.");
            return;
          }
          setBusy(true);
          const r = await submitChange(
            action,
            setError,
            () =>
              api("/secrets/group", "PATCH", {
                ids,
                ...groupPayload(group, name),
              }),
            group ? "Secrets moved to group" : "Secrets moved to Ungrouped",
          );
          setBusy(false);
          if (r) {
            onSaved();
          }
        }}
      >
        <div className="secrets-moving-list">
          {data.secrets
            .filter((s) => ids.includes(s.id))
            .map((s) => (
              <span key={s.id}>
                <KeyRound size={14} />
                {s.name}
              </span>
            ))}
        </div>
        <GroupChoice
          groups={data.secret_groups || []}
          group={group}
          setGroup={setGroup}
          name={name}
          setName={setName}
        />
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <Button
            type="button"
            className="secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Move {countLabel(ids.length)}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function SecretEditor({ secret, data, action, onClose, onSaved }) {
  const [ducks, setDucks] = useState(JSON.parse(secret.allowed_ducks));
  const [group, setGroup] = useState(secret.group_id || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title="Update secret" warnUnsaved onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          const form = Object.fromEntries(new FormData(e.currentTarget));
          if (!form.value) delete form.value;
          setBusy(true);
          const r = await submitChange(
            action,
            setError,
            () =>
              api("/secrets/" + secret.id, "PATCH", {
                ...form,
                group_id: group || null,
                allowed_ducks: ducks,
                // What it said when this dialog opened. The whole duck list is
                // sent back from that snapshot, so without this the later of
                // two people saving quietly undid the other's change and both
                // were told it had been saved.
                base: secret.base,
              }),
            "Secret saved",
          );
          setBusy(false);
          if (r) onSaved();
        }}
      >
        <Field label="Secret name">
          <input
            name="name"
            defaultValue={secret.name}
            required
            maxLength={100}
          />
        </Field>
        <GroupChoice
          groups={data.secret_groups || []}
          group={group}
          setGroup={setGroup}
          allowNew={false}
        />
        <Field
          label="Replacement value"
          hint="Leave blank to keep the current value."
        >
          <input
            name="value"
            type="password"
            autoComplete="new-password"
            maxLength={16000}
            placeholder="Paste a replacement only if needed"
          />
        </Field>
        <Field label="Ducks allowed to use this secret">
          <DuckPicker ducks={flock(data)} value={ducks} onChange={setDucks} />
        </Field>
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <Button
            type="button"
            className="secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Save secret
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function ConfirmChange({
  title,
  label,
  children,
  action,
  perform,
  success,
  onClose,
  danger,
  onSaved,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title={title} onClose={onClose}>
      <p>{children}</p>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      <div className="modal-actions">
        <Button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button
          className={danger ? "danger-button" : ""}
          busy={busy}
          onClick={async () => {
            if (busy) return;
            setBusy(true);
            const r = await submitChange(action, setError, perform, success);
            setBusy(false);
            if (r) onSaved();
          }}
        >
          {label}
        </Button>
      </div>
    </Modal>
  );
}
