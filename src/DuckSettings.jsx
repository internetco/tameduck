import { DuckContactGrid } from "./DuckContacts.jsx";
import React, { useState } from "react";
import { Check, Clock, Globe2, Users } from "lucide-react";
import { api, Avatar } from "./ui.jsx";
import { Switch } from "./Switch.jsx";
import {
  PERMISSIONS,
  anyDuck,
  undoGroups,
  afterBulk,
} from "./duck-permissions.mjs";
import "./duck-permissions.css";
import SettingsHead from "./SettingsHead.jsx";
import ChiefCheckins from "./ChiefCheckins.jsx";

export default function DuckSettings({ data, action, onTab }) {
  const ducks = data.duck_settings || [];
  const [busy, setBusy] = useState("");
  // What the All ducks row last did, and what every duck had before it. One at
  // a time: the next press is about a different column and replaces this.
  const [undo, setUndo] = useState(null);
  // Computers can be switched off for the whole company, which overrules every
  // one of these switches.
  const computersOff =
    !!data.computers && (!data.computers.enabled || !data.computers.configured);

  async function change(duckIds, patch, key) {
    setBusy(key);
    try {
      // action() shows anything that goes wrong as a toast and answers null.
      return await action(
        () => api("/duck-settings", "PATCH", { duck_ids: duckIds, ...patch }),
        (result) => result.warning || "",
      );
    } finally {
      setBusy("");
    }
  }

  async function bulk(column, value) {
    // Remember each duck's own answer before they are all set the same way.
    // It has to be kept here: once the call returns, the only thing the server
    // can still say is the one answer they now share.
    const before = ducks.map((d) => ({
      id: d.id,
      [column.key]: !!d[column.key],
    }));
    const done = await change(
      ducks.map((d) => d.id),
      { [column.key]: value },
      "all-" + column.key,
    );
    if (done)
      setUndo({
        key: column.key,
        said: afterBulk(column.key, value, before.length),
        before,
      });
  }

  async function putBack() {
    setBusy("undo");
    try {
      for (const group of undoGroups(undo.before, undo.key)) {
        const done = await action(
          () =>
            api("/duck-settings", "PATCH", {
              duck_ids: group.ids,
              [undo.key]: group.value,
            }),
          (result) => result.warning || "",
        );
        if (!done) return;
      }
      setUndo(null);
    } finally {
      setBusy("");
    }
  }

  if (!ducks.length)
    return (
      <section className="settings-section duck-perms">
        <SettingsHead page="ducks" />
        <p className="muted">This company has no ducks yet.</p>
      </section>
    );
  return (
    <section className="settings-section duck-perms">
      <div className="duck-perms-page">
        <SettingsHead page="ducks" />
        {computersOff && (
          <div className="duck-perms-head">
            <p className="muted">
              {data.computers?.configured
                ? "Computers are switched off for this company, so no duck can start one whatever its switch says."
                : "Computers are not set up for this workspace yet, so no duck can start one whatever its switch says."}
            </p>
          </div>
        )}
        <div className="duck-perms-wrap">
          <table className="duck-perms-table">
            <thead>
              <tr>
                <th scope="col">
                  <b className="duck-perms-sr">Duck</b>
                </th>
                {PERMISSIONS.map((column) => (
                  <th key={column.key} scope="col">
                    <b>{column.head}</b>
                    {/* The help line is read where the switches are, so when
                        the whole company has computers off it is the line that
                        says so rather than twenty cells. */}
                    <span>
                      {column.key === "computer" && computersOff
                        ? "Nobody can start one now"
                        : column.help}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ducks.map((duck) => (
                <tr key={duck.id}>
                  <th scope="row">
                    <span className="duck-perms-who">
                      <Avatar
                        duck={(data.ducks || []).find((x) => x.id === duck.id)}
                        size={28}
                      />
                      <span className="duck-perms-name">
                        <b>{duck.name}</b>
                        {/* Who the chief is stays on screen in a narrow window,
                            where the others' jobs go: a job can be guessed from
                            the duck's name, and which one is the chief cannot. */}
                        <span
                          className={
                            duck.chief ? "duck-perms-chief" : undefined
                          }
                        >
                          {duck.chief ? "Chief of staff" : duck.role}
                        </span>
                      </span>
                    </span>
                  </th>
                  {PERMISSIONS.map((column) => (
                    <td key={column.key}>
                      <label className="duck-perms-cell">
                        {/* Only a phone shows this: there the row becomes a
                            card and each switch needs its own name. */}
                        <span className="duck-perms-lab">{column.lab}</span>
                        <Switch
                          checked={!!duck[column.key]}
                          disabled={busy === duck.id + column.key}
                          label={duck.name + ": " + column.said}
                          onChange={(on) => {
                            // Undo remembers what the ducks had before the last
                            // All ducks press. Set one of them by hand and that
                            // memory is no longer what is on screen.
                            if (undo?.key === column.key) setUndo(null);
                            change(
                              [duck.id],
                              { [column.key]: on },
                              duck.id + column.key,
                            );
                          }}
                        />
                        <span className="duck-perms-word">
                          {duck[column.key] ? column.on : column.off}
                        </span>
                      </label>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">
                  <span className="duck-perms-who">
                    <span className="duck-perms-tile" aria-hidden="true">
                      <Users size={15} />
                    </span>
                    <span className="duck-perms-name">
                      <b>All ducks</b>
                    </span>
                  </span>
                </th>
                {PERMISSIONS.map((column) => {
                  const any = anyDuck(ducks, column.key);
                  const words = any ? column.allOff : column.allOn;
                  return (
                    <td key={column.key}>
                      <span className="duck-perms-cell">
                        <span className="duck-perms-lab">{column.lab}</span>
                        <button
                          type="button"
                          className="duck-perms-bulk"
                          disabled={busy === "all-" + column.key}
                          aria-label={
                            words +
                            ": " +
                            column.head.toLowerCase() +
                            ", all ducks"
                          }
                          onClick={() => bulk(column, !any)}
                        >
                          {words}
                        </button>
                      </span>
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="duck-perms-proxy-note">
          <Globe2 size={15} aria-hidden="true" />
          <span>
            Allowing proxy access lets a Duck switch it on when needed; it does
            not turn it on. Switching access off disconnects an active proxy and
            leaves the Duck’s computer available.
          </span>
        </p>
        {undo && (
          <div className="duck-perms-undo" role="status">
            <Check size={15} aria-hidden="true" />
            <span>{undo.said}</span>
            <button type="button" disabled={busy === "undo"} onClick={putBack}>
              Undo
            </button>
          </div>
        )}
        <p className="duck-perms-fine">
          <Clock size={15} aria-hidden="true" />
          <span>
            How long a duck waits for you is your own setting, so it lives in{" "}
            <button
              type="button"
              className="text-button"
              onClick={() => onTab("account")}
            >
              Your account
            </button>
            .
          </span>
        </p>
      </div>
      <ChiefCheckins data={data} action={action} /> <DuckContactGrid data={data} action={action} />
    </section>
  );
}
