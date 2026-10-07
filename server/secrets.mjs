import crypto from "node:crypto";
import { z } from "zod";
import {
  db,
  all,
  one,
  run,
  id,
  now,
  encrypt,
  can,
  tenant,
  onTeam,
  audit,
  fail,
  json,
  DUCK_LIMIT,
} from "./store.mjs";
import { keyInUse } from "../shared/key-access.mjs";
const name = z.string().trim().min(1, "Give every secret a name.").max(100);
const groupName = z.string().trim().min(1, "Give the group a name.").max(100);
const uuid = z.string().uuid();
const access = z.array(uuid).max(DUCK_LIMIT);
const value = z.string().min(1, "Enter a value for every secret.").max(16000);
const destination = {
  group_id: uuid.nullable().optional(),
  new_group: z.object({ name: groupName }).optional(),
};
function checkDestination(a, company) {
  if (a.new_group && a.group_id)
    fail(400, "Choose an existing group or create a new one.");
  if (a.group_id) tenant("secret_groups", a.group_id, company);
}
function createGroup(company, label) {
  if (
    one(
      "SELECT 1 FROM secret_groups WHERE company_id=? AND name=? COLLATE NOCASE",
      company,
      label,
    )
  )
    fail(
      409,
      "A group with that name already exists. Choose it from the group list.",
    );
  const group = id();
  run(
    "INSERT INTO secret_groups(id,company_id,name,created) VALUES(?,?,?,?)",
    group,
    company,
    label,
    now(),
  );
  return group;
}
function targetGroup(a, company) {
  return a.new_group
    ? createGroup(company, a.new_group.name)
    : a.group_id || null;
}
function checkAccess(ducks, company) {
  for (const duck of ducks) onTeam(duck, company);
}
function checkNames(secrets, company) {
  const seen = new Set();
  for (const secret of secrets) {
    if (seen.has(secret.name)) fail(400, "Each secret needs a different name.");
    if (
      one(
        "SELECT 1 FROM secrets WHERE company_id=? AND name=?",
        company,
        secret.name,
      )
    )
      fail(
        409,
        `A secret named “${secret.name}” already exists. Choose another name or edit the existing secret.`,
      );
    seen.add(secret.name);
  }
}
function insertSecret(company, secret, ducks, group, user) {
  const secretId = id();
  run(
    "INSERT INTO secrets(id,company_id,name,value,allowed_ducks,created,group_id,created_by_user) VALUES(?,?,?,?,?,?,?,?)",
    secretId,
    company,
    secret.name,
    encrypt(secret.value),
    JSON.stringify(ducks),
    now(),
    group,
    user,
  );
  return secretId;
}
export function listSecrets(company) {
  return all(
    "SELECT s.id,s.name,s.allowed_ducks,s.created,s.group_id,s.created_by_user,s.created_by_duck,u.name user_name,d.name duck_name FROM secrets s LEFT JOIN users u ON u.id=s.created_by_user LEFT JOIN ducks d ON d.id=s.created_by_duck AND d.company_id=s.company_id WHERE s.company_id=? ORDER BY s.name COLLATE NOCASE,s.id",
    company,
  ).map((s) => {
    const {
      created_by_user,
      created_by_duck,
      user_name,
      duck_name,
      ...secret
    } = s;
    return {
      ...secret,
      creator: created_by_user
        ? {
            type: "user",
            id: created_by_user,
            name: user_name || "Former user",
          }
        : created_by_duck
          ? {
              type: "duck",
              id: created_by_duck,
              name: duck_name || "Former duck",
            }
          : null,
    };
  });
}
export function listSecretGroups(company) {
  return all(
    "SELECT id,name,created FROM secret_groups WHERE company_id=? ORDER BY name COLLATE NOCASE,id",
    company,
  );
}
// What this secret looked like when a dialog opened it. The dialog sends the
// whole allowed_ducks list back, taken as a snapshot when it opened, so two
// admins editing the same secret each wrote their own snapshot plus their own
// change and the later save silently took away what the earlier one had just
// granted. Both were told "Secret saved", nothing said otherwise, and the only
// way to find out was to open it again - by which time a duck had already been
// refused a key it was supposed to have, for no reason anybody could see.
//
// The same bug was fixed for a duck's skills, and for documents, tickets and
// boards. A digest rather than a column because secrets have no updated field
// and this needs no migration.
export const secretDigest = (row) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify([row.name, row.allowed_ducks, row.group_id || null]))
    .digest("hex");
export function registerSecrets(app) {
  app.post("/api/secret-groups", (req, res) => {
    can(req.member, "integrations");
    const a = z.object({ name: groupName }).parse(req.body);
    const group = createGroup(req.company.id, a.name);
    audit(req.company.id, req.user.id, "Secret group created", a.name);
    res.json({ id: group });
  });
  app.patch("/api/secret-groups/:id", (req, res) => {
    can(req.member, "integrations");
    const old = tenant("secret_groups", req.params.id, req.company.id);
    const a = z.object({ name: groupName }).parse(req.body);
    if (
      one(
        "SELECT 1 FROM secret_groups WHERE company_id=? AND name=? COLLATE NOCASE AND id<>?",
        req.company.id,
        a.name,
        old.id,
      )
    )
      fail(409, "A group with that name already exists.");
    run("UPDATE secret_groups SET name=? WHERE id=?", a.name, old.id);
    audit(req.company.id, req.user.id, "Secret group renamed", {
      from: old.name,
      to: a.name,
    });
    res.json({ ok: true });
  });
  app.delete("/api/secret-groups/:id", (req, res) => {
    can(req.member, "integrations");
    const group = tenant("secret_groups", req.params.id, req.company.id);
    db.transaction(() => {
      run(
        "UPDATE secrets SET group_id=NULL WHERE group_id=? AND company_id=?",
        group.id,
        req.company.id,
      );
      run("DELETE FROM secret_groups WHERE id=?", group.id);
      audit(req.company.id, req.user.id, "Secret group removed", group.name);
    })();
    res.json({ ok: true });
  });
  app.post("/api/secrets/batch", (req, res) => {
    can(req.member, "integrations");
    const a = z
      .object({
        ...destination,
        secrets: z.array(z.object({ name, value })).min(1).max(20),
        allowed_ducks: access,
      })
      .parse(req.body);
    checkDestination(a, req.company.id);
    checkAccess(a.allowed_ducks, req.company.id);
    const result = db.transaction(() => {
      checkNames(a.secrets, req.company.id);
      const group = targetGroup(a, req.company.id);
      const ids = a.secrets.map((secret) =>
        insertSecret(
          req.company.id,
          secret,
          a.allowed_ducks,
          group,
          req.user.id,
        ),
      );
      audit(req.company.id, req.user.id, "Secrets saved", {
        count: ids.length,
        group_id: group,
      });
      return { ids, group_id: group };
    })();
    res.json(result);
  });
  // Register the bulk route before the individual-secret route.
  app.patch("/api/secrets/group", (req, res) => {
    can(req.member, "integrations");
    const a = z
      .object({ ...destination, ids: z.array(uuid).min(1).max(100) })
      .parse(req.body);
    checkDestination(a, req.company.id);
    const result = db.transaction(() => {
      const ids = [...new Set(a.ids)];
      for (const secret of ids) tenant("secrets", secret, req.company.id);
      const group = targetGroup(a, req.company.id);
      for (const secret of ids)
        run(
          "UPDATE secrets SET group_id=? WHERE id=? AND company_id=?",
          group,
          secret,
          req.company.id,
        );
      audit(req.company.id, req.user.id, "Secrets moved", {
        count: ids.length,
        group_id: group,
      });
      return { ok: true, count: ids.length, group_id: group };
    })();
    res.json(result);
  });
  app.post("/api/secrets", (req, res) => {
    can(req.member, "integrations");
    const a = z
      .object({
        name,
        value,
        allowed_ducks: access,
        group_id: uuid.nullable().default(null),
      })
      .parse(req.body);
    checkDestination(a, req.company.id);
    checkAccess(a.allowed_ducks, req.company.id);
    checkNames([a], req.company.id);
    const secret = insertSecret(
      req.company.id,
      a,
      a.allowed_ducks,
      a.group_id,
      req.user.id,
    );
    audit(req.company.id, req.user.id, "Secret saved", a.name);
    res.json({ id: secret });
  });
  app.patch("/api/secrets/:id", (req, res) => {
    can(req.member, "integrations");
    const old = tenant("secrets", req.params.id, req.company.id);
    const a = z
      .object({
        name,
        value: value.optional(),
        allowed_ducks: access,
        group_id: uuid.nullable().optional(),
      })
      .parse(req.body);
    checkDestination(a, req.company.id);
    checkAccess(a.allowed_ducks, req.company.id);
    if (
      one(
        "SELECT 1 FROM secrets WHERE company_id=? AND name=? AND id<>?",
        req.company.id,
        a.name,
        old.id,
      )
    )
      fail(409, "A secret with that name already exists.");
    // A connection using this key requires the key to allow every duck the
    // connection allows; that is checked when a connection is set up, but not
    // from this side, so narrowing access here quietly broke the connection
    // while Connections went on reporting it as working.
    for (const c of all(
      "SELECT name,allowed_ducks FROM connections WHERE company_id=? AND secret_id=?",
      req.company.id,
      old.id,
    )) {
      const missing = json(c.allowed_ducks).filter(
        (d) => !a.allowed_ducks.includes(d),
      );
      if (missing.length)
        fail(
          409,
          "“" +
            c.name +
            "” uses this key for " +
            (missing.length === 1 ? "a duck" : missing.length + " ducks") +
            " you are removing, and would stop working. Take " +
            (missing.length === 1 ? "that duck" : "those ducks") +
            " off that connection first, or leave the access here as it is.",
        );
    }
    if (req.body?.base && req.body.base !== secretDigest(old))
      fail(
        409,
        "Somebody changed who can use this secret while you had it open. Close this and open it again so you are working from what it says now.",
      );
    run(
      "UPDATE secrets SET name=?,value=?,allowed_ducks=?,group_id=? WHERE id=?",
      a.name,
      a.value ? encrypt(a.value) : old.value,
      JSON.stringify(a.allowed_ducks),
      a.group_id === undefined ? old.group_id : a.group_id,
      old.id,
    );
    audit(req.company.id, req.user.id, "Secret updated", a.name);
    res.json({ ok: true });
  });
  app.delete("/api/secrets/:id", (req, res) => {
    can(req.member, "integrations");
    const secret = tenant("secrets", req.params.id, req.company.id);
    const tools = all(
      "SELECT name FROM connections WHERE company_id=? AND secret_id=? ORDER BY created",
      req.company.id,
      secret.id,
    );
    if (tools.length) fail(409, keyInUse(tools.map((t) => t.name)));
    run("DELETE FROM secrets WHERE id=?", secret.id);
    audit(req.company.id, req.user.id, "Secret deleted", secret.name);
    res.json({ ok: true });
  });
}
