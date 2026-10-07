import { z } from "zod";
import {
  db,
  all,
  one,
  emit,
  run,
  tenant,
  onTeam,
  can,
  fail,
  id,
  now,
  json,
  encrypt,
  audit,
  permissions,
  DUCK_LIMIT,
} from "./store.mjs";
import { mcpCatalog, mcpSetupGuides, catalogProvider } from "./mcp-catalog.mjs";
import { validateUrl, inspectMCP } from "./integrations.mjs";
import { accessGiven, waitingForSignIn } from "./connection-blocks.mjs";
import {
  beginOAuth,
  invalidateOAuthFlows,
  withConnectionLock,
} from "./mcp-oauth.mjs";
import { joined, notOnKey, keyRefusal } from "../shared/key-access.mjs";
const uuid = z.string().uuid();
const name = z.string().trim().min(1).max(100);
const newSecretSchema = z.object({
  name,
  value: z.string().trim().min(1).max(20000),
  group_id: uuid.nullable().optional(),
});
const schema = z.object({
  name,
  url: z.string().max(2000),
  secret_id: uuid.nullable().default(null),
  new_secret: newSecretSchema.optional(),
  allowed_ducks: z.array(uuid).max(DUCK_LIMIT),
  add_to_key: z.array(uuid).max(DUCK_LIMIT).default([]),
  enabled: z.boolean().default(true),
});
function checkAccess(company, ducks, secretId) {
  for (const duck of ducks) onTeam(duck, company);
  if (secretId) tenant("secrets", secretId, company);
}
// The key must let in every duck the connection is for, or those ducks are
// refused at work while the card says Connected. Saving adds them, but only
// the ducks the person was shown, so a key is never opened to a duck nobody
// agreed to. It never takes anyone off a key, and never adds a duck that is
// not on the connection's own list.
function letKeyAllow(company, user, secretId, ducks, shown, connectionName) {
  if (!secretId) return;
  const key = tenant("secrets", secretId, company);
  const team = all(
    "SELECT id,name FROM ducks WHERE company_id=? AND removed=0 ORDER BY chief DESC,created",
    company,
  );
  const missing = notOnKey(team, key, ducks);
  const unseen = missing.filter((d) => !shown.includes(d.id));
  if (unseen.length) fail(400, keyRefusal(key.name, unseen));
  if (!missing.length) return;
  run(
    "UPDATE secrets SET allowed_ducks=? WHERE id=?",
    JSON.stringify([...json(key.allowed_ducks), ...missing.map((d) => d.id)]),
    key.id,
  );
  // The Activity log shows only a line's duck, name and tool.
  audit(company, user, "Ducks allowed to use a key", {
    duck: joined(missing.map((d) => d.name)),
    name: key.name,
    tool: connectionName,
  });
}
function validateSecretInput(company, a) {
  if (a.secret_id && a.new_secret)
    fail(400, "Choose an existing key or add a new one.");
  checkAccess(company, a.allowed_ducks, a.secret_id);
  if (a.new_secret?.group_id)
    tenant("secret_groups", a.new_secret.group_id, company);
}
// Called inside the connection transaction, so rejected updates cannot leave orphaned keys.
function saveConnectionSecret(company, a, user) {
  if (!a.new_secret) return a.secret_id || null;
  if (
    all(
      "SELECT id FROM secrets WHERE company_id=? AND name=?",
      company,
      a.new_secret.name,
    ).length
  )
    fail(
      409,
      "A secret already has that name. Choose it from saved secrets or use a different name.",
    );
  const secretId = id();
  run(
    "INSERT INTO secrets(id,company_id,name,value,allowed_ducks,created,group_id,created_by_user) VALUES(?,?,?,?,?,?,?,?)",
    secretId,
    company,
    a.new_secret.name,
    encrypt(a.new_secret.value),
    JSON.stringify(a.allowed_ducks),
    now(),
    a.new_secret.group_id || null,
    user,
  );
  return secretId;
}
export function listConnections(company) {
  return all(
    "SELECT c.*,EXISTS(SELECT 1 FROM connection_oauth o WHERE o.connection_id=c.id) AS has_oauth FROM connections c WHERE company_id=? ORDER BY created",
    company,
  ).map((c) => ({
    ...c,
    ...(c.auth_type === "secret" && !c.secret_id
      ? {
          connection_status: "auth_required",
          last_error: "Choose a saved key to reconnect this service.",
        }
      : {}),
  }));
}
async function testSaved(company, connection) {
  try {
    const tools = await inspectMCP(company, connection);
    return { id: connection, connected: true, tool_count: tools.length };
  } catch (error) {
    return { id: connection, connected: false, error: error.message };
  }
}
export function registerConnections(app) {
  app.get("/api/connections/catalog", (req, res) => {
    can(req.member, "integrations");
    res.json({
      providers: mcpCatalog.map(
        ({ oauthHosts, confidential, scope, ...p }) => p,
      ),
      setup_guides: mcpSetupGuides,
      reviewed: "2026-09-16",
    });
  });
  app.post("/api/connections/catalog/:provider/connect", async (req, res) => {
    can(req.member, "integrations");
    const provider = catalogProvider(req.params.provider);
    if (!provider) fail(404, "This service is not in the catalog.");
    const a = z
      .object({
        auth_type: z.enum(["none", "secret", "oauth"]),
        allowed_ducks: z.array(uuid).max(DUCK_LIMIT),
        secret_id: uuid.nullable().optional(),
        new_secret: newSecretSchema.optional(),
        add_to_key: z.array(uuid).max(DUCK_LIMIT).default([]),
      })
      .parse(req.body);
    if (!provider.auth.includes(a.auth_type))
      fail(400, "Choose an authentication method supported by this service.");
    if (a.secret_id && a.new_secret)
      fail(400, "Choose an existing key or add a new one.");
    if (a.auth_type === "secret" && !a.secret_id && !a.new_secret)
      fail(400, "Add a key or choose a saved secret.");
    if (a.auth_type !== "secret" && (a.secret_id || a.new_secret))
      fail(400, "A key is only used with key authentication.");
    validateSecretInput(req.company.id, a);
    const connection = id();
    db.transaction(() => {
      if (
        all(
          "SELECT id FROM connections WHERE company_id=? AND provider_id=?",
          req.company.id,
          provider.id,
        ).length
      )
        fail(
          409,
          "This service is already added. Configure its existing connection.",
        );
      letKeyAllow(
        req.company.id,
        req.user.id,
        a.secret_id,
        a.allowed_ducks,
        a.add_to_key,
        provider.name,
      );
      const secretId = saveConnectionSecret(req.company.id, a, req.user.id);
      run(
        "INSERT INTO connections(id,company_id,name,url,secret_id,allowed_ducks,enabled,tools,created,provider_id,auth_type,connection_status) VALUES(?,?,?,?,?,?,1,?,?,?,?,?)",
        connection,
        req.company.id,
        provider.name,
        provider.url,
        secretId,
        JSON.stringify(a.allowed_ducks),
        "[]",
        now(),
        provider.id,
        a.auth_type,
        a.auth_type === "oauth" ? "auth_required" : "unchecked",
      );
      audit(req.company.id, req.user.id, "MCP connection added", provider.name);
    })();
    if (a.auth_type === "oauth")
      return res.json({ id: connection, needs_sign_in: true });
    res.json(await testSaved(req.company.id, connection));
  });
  app.post("/api/connections", (req, res) => {
    can(req.member, "integrations");
    const a = schema.parse(req.body);
    validateUrl(a.url);
    validateSecretInput(req.company.id, a);
    const connection = id();
    db.transaction(() => {
      letKeyAllow(
        req.company.id,
        req.user.id,
        a.secret_id,
        a.allowed_ducks,
        a.add_to_key,
        a.name,
      );
      const secretId = saveConnectionSecret(req.company.id, a, req.user.id);
      run(
        "INSERT INTO connections(id,company_id,name,url,secret_id,allowed_ducks,enabled,tools,created,auth_type) VALUES(?,?,?,?,?,?,?,?,?,?)",
        connection,
        req.company.id,
        a.name,
        a.url,
        secretId,
        JSON.stringify(a.allowed_ducks),
        a.enabled ? 1 : 0,
        "[]",
        now(),
        secretId ? "secret" : "none",
      );
      audit(req.company.id, req.user.id, "MCP connection created", a.name);
    })();
    res.json({ id: connection });
  });
  app.patch("/api/connections/:id", async (req, res) => {
    can(req.member, "integrations");
    const a = schema.parse(req.body);
    validateUrl(a.url);
    validateSecretInput(req.company.id, a);
    await withConnectionLock(req.params.id, () =>
      db.transaction(() => {
        const old = tenant("connections", req.params.id, req.company.id);
        if (old.provider_id && a.url !== old.url)
          fail(
            400,
            "Catalog services use their official server address. Add a custom server for another address.",
          );
        if (old.auth_type === "oauth" && (a.secret_id || a.new_secret))
          fail(400, "This connection uses browser sign-in.");
        const authType =
          old.auth_type === "oauth"
            ? "oauth"
            : a.secret_id || a.new_secret
              ? "secret"
              : "none";
        if (
          old.provider_id &&
          !catalogProvider(old.provider_id)?.auth.includes(authType)
        )
          fail(400, "This service needs a supported authentication method.");
        letKeyAllow(
          req.company.id,
          req.user.id,
          a.secret_id,
          a.allowed_ducks,
          a.add_to_key,
          a.name,
        );
        const secretId = saveConnectionSecret(req.company.id, a, req.user.id);
        const changed = old.url !== a.url || old.secret_id !== secretId;
        invalidateOAuthFlows(old.id);
        if (changed)
          run("DELETE FROM connection_oauth WHERE connection_id=?", old.id);
        run(
          "UPDATE connections SET name=?,url=?,secret_id=?,allowed_ducks=?,enabled=?,tools=?,auth_type=?,connection_status=?,last_error=? WHERE id=?",
          a.name,
          a.url,
          secretId,
          JSON.stringify(a.allowed_ducks),
          a.enabled ? 1 : 0,
          changed ? "[]" : old.tools,
          authType,
          changed || (!old.enabled && a.enabled)
            ? "unchecked"
            : old.connection_status,
          changed ? null : old.last_error,
          old.id,
        );
        audit(req.company.id, req.user.id, "MCP connection updated", a.name);
      })(),
    );
    // Ducks waiting for exactly this carry on, as if the button in Needs you
    // had been pressed. One waiting for a sign-in should not also wait for
    // somebody to find the Test button: a new key is tried straight away.
    accessGiven(req.company.id, req.params.id, req.user.id);
    if (a.enabled && waitingForSignIn(req.params.id))
      inspectMCP(req.company.id, req.params.id, req.user.id).catch(() => {});
    res.json({ ok: true });
  });
  // The card's Let them use the key: the connection's own ducks that its key
  // does not let in, added to the key. Nothing else about the key changes.
  app.post("/api/connections/:id/allow-on-key", async (req, res) => {
    can(req.member, "integrations");
    const a = z
      .object({ ducks: z.array(uuid).min(1).max(DUCK_LIMIT) })
      .parse(req.body);
    await withConnectionLock(req.params.id, () =>
      db.transaction(() => {
        const c = tenant("connections", req.params.id, req.company.id);
        if (!c.secret_id) fail(400, c.name + " has no saved key.");
        const ducks = a.ducks.map((d) => onTeam(d, req.company.id));
        const gone = ducks.filter((d) => !json(c.allowed_ducks).includes(d.id));
        if (gone.length)
          fail(
            409,
            joined(gone.map((d) => d.name)) +
              (gone.length === 1 ? " is" : " are") +
              " no longer on " +
              c.name +
              ".",
          );
        letKeyAllow(
          req.company.id,
          req.user.id,
          c.secret_id,
          a.ducks,
          a.ducks,
          c.name,
        );
      })(),
    );
    // Ducks stopped by this key carry on, as they do after Allow in Needs you.
    accessGiven(req.company.id, req.params.id, req.user.id);
    res.json({ ok: true });
  });
  app.post("/api/connections/:id/oauth", async (req, res) =>
    res.json(await beginOAuth(req, res, req.params.id)),
  );
  app.post("/api/connections/:id/test", async (req, res) => {
    can(req.member, "integrations");
    tenant("connections", req.params.id, req.company.id);
    res.json({
      tools: await inspectMCP(req.company.id, req.params.id, req.user.id),
    });
  });
  // Disconnect only switches a connection off; the row stayed in the list for
  // good, so a service tried once and abandoned, or added by mistake, sat there
  // for ever with no way to clear it.
  app.delete("/api/connections/:id", async (req, res) => {
    can(req.member, "integrations");
    await withConnectionLock(req.params.id, () => {
      const c = tenant("connections", req.params.id, req.company.id);
      // Needs you only carries approvals from your own runs unless you have
      // the approvals permission, so telling everybody to "answer it in Needs
      // you" sent most people to a page that would be blank for them, with no
      // screen anywhere that could clear the way. It now says whose run it is
      // and, when it is not theirs to answer, that somebody else has to.
      const waiting = all(
        "SELECT j.user_id,u.name person,d.name duck FROM approvals a JOIN jobs j ON j.id=a.job_id " +
          "LEFT JOIN users u ON u.id=j.user_id LEFT JOIN ducks d ON d.id=j.duck_id " +
          "WHERE a.connection_id=? AND a.status='pending'",
        c.id,
      );
      if (waiting.length) {
        const yours =
          permissions(req.member).approvals ||
          waiting.every((w) => w.user_id === req.user.id);
        const who = [...new Set(waiting.map((w) => w.person).filter(Boolean))];
        fail(
          409,
          (waiting.length === 1
            ? (waiting[0].duck || "A duck") +
              " is still waiting on an approval for this connection"
            : waiting.length +
              " approvals for this connection are still waiting") +
            (who.length ? ", in work for " + who.join(" and ") : "") +
            ". " +
            (yours
              ? "Answer it in Needs you first."
              : "Somebody who can answer approvals has to deal with it before this connection can be removed."),
        );
      }
      invalidateOAuthFlows(c.id);
      db.transaction(() => {
        run("DELETE FROM connection_oauth WHERE connection_id=?", c.id);
        run("DELETE FROM mcp_oauth_flows WHERE connection_id=?", c.id);
        // Its approvals are the record of what this connection was asked to do
        // and cannot outlive it; the audit log keeps the account of that.
        run("DELETE FROM approvals WHERE connection_id=?", c.id);
        run("DELETE FROM connection_blocks WHERE connection_id=?", c.id);
        run(
          "DELETE FROM connections WHERE id=? AND company_id=?",
          c.id,
          req.company.id,
        );
      })();
      audit(req.company.id, req.user.id, "MCP connection removed", c.name);
      emit(req.company.id);
    });
    res.json({ ok: true });
  });
  app.post("/api/connections/:id/disconnect", async (req, res) => {
    can(req.member, "integrations");
    await withConnectionLock(req.params.id, () => {
      const c = tenant("connections", req.params.id, req.company.id);
      invalidateOAuthFlows(c.id);
      run("DELETE FROM connection_oauth WHERE connection_id=?", c.id);
      run(
        "UPDATE connections SET enabled=0,connection_status='disconnected',tools='[]',last_error=NULL WHERE id=?",
        c.id,
      );
      audit(req.company.id, req.user.id, "MCP connection disconnected", c.name);
    });
    res.json({ ok: true });
  });
}
