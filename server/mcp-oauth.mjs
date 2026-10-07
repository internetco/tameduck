import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  one,
  run,
  now,
  token,
  hash,
  encrypt,
  decrypt,
  tenant,
  fail,
  can,
  memberFor,
  audit,
} from "./store.mjs";
import { catalogProvider } from "./mcp-catalog.mjs";
import { validateUrl, guardedFetch } from "./mcp-network.mjs";
const appUrl = process.env.APP_URL || "http://localhost:3000";
export const callbackUrl = appUrl + "/mcp/oauth/callback";
const locks = new Map();
export async function withConnectionLock(id, work) {
  const previous = locks.get(id) || Promise.resolve();
  let release;
  const barrier = new Promise((r) => (release = r));
  const tail = previous.catch(() => {}).then(() => barrier);
  locks.set(id, tail);
  await previous.catch(() => {});
  try {
    return await work();
  } finally {
    release();
    if (locks.get(id) === tail) locks.delete(id);
  }
}
const unpack = (value) => (value ? JSON.parse(decrypt(value)) : {});
const credentials = (id) =>
  unpack(
    one("SELECT data FROM connection_oauth WHERE connection_id=?", id)?.data,
  );
function validateDiscovery(provider, discovery) {
  for (const raw of [
    discovery.authorizationServerUrl,
    discovery.resourceMetadataUrl,
  ]) {
    if (raw && !provider.oauthHosts.includes(validateUrl(raw).hostname))
      throw new Error("Untrusted authorization server");
  }
  const metadata = discovery.authorizationServerMetadata || {};
  for (const field of [
    "issuer",
    "authorization_endpoint",
    "token_endpoint",
    "registration_endpoint",
    "revocation_endpoint",
  ]) {
    if (
      metadata[field] &&
      !provider.oauthHosts.includes(validateUrl(metadata[field]).hostname)
    )
      throw new Error("Untrusted authorization endpoint");
  }
}
export function oauthProvider(connection, { load, save, state, redirect }) {
  const provider = catalogProvider(connection.provider_id);
  if (!provider?.auth.includes("oauth") || connection.url !== provider.url)
    fail(400, "This connection does not support browser sign-in.");
  // Credentials saved by older SDKs were not bound to an authorization
  // server. Never assign them an issuer from new discovery: require a fresh
  // sign-in instead, before the transport can read even an unexpired token.
  const stored = load();
  if ([stored.client, stored.tokens].some(value =>
    value && (typeof value.issuer !== "string" || !value.issuer.trim()))) {
    const { client, tokens, expires_at, verifier, ...metadata } = stored;
    save(metadata);
    if (!state) fail(401, "Sign in again from Connections.");
  }
  // Cached discovery is read directly by the SDK, without calling its save
  // hook again. Apply the same destination checks to both paths.
  if (load().discovery) validateDiscovery(provider, load().discovery);
  return {
    redirectUrl: callbackUrl,
    get clientMetadata() {
      return {
        client_name: "TameDuck",
        client_uri: appUrl,
        redirect_uris: [callbackUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: provider.confidential
          ? "client_secret_post"
          : "none",
      };
    },
    state() {
      if (!state) fail(401, "Sign in again from Connections.");
      return state;
    },
    clientInformation: () => load().client,
    saveClientInformation: (client) => save({ ...load(), client }),
    tokens: () => load().tokens,
    saveTokens(tokens) {
      save({
        ...load(),
        tokens,
        expires_at: tokens.expires_in
          ? Date.now() + tokens.expires_in * 1000
          : null,
      });
    },
    saveCodeVerifier(verifier) {
      if (!state) fail(401, "Sign in again from Connections.");
      save({ ...load(), verifier });
    },
    codeVerifier() {
      const v = load().verifier;
      if (!v) fail(400, "Sign-in expired. Please try again.");
      return v;
    },
    redirectToAuthorization(url) {
      if (!state || !redirect) fail(401, "Sign in again from Connections.");
      if (!provider.oauthHosts.includes(validateUrl(url).hostname))
        fail(400, "Unexpected sign-in address.");
      redirect(url.toString());
    },
    discoveryState: () => load().discovery,
    saveDiscoveryState(discovery) {
      validateDiscovery(provider, discovery);
      save({ ...load(), discovery });
    },
    invalidateCredentials(scope) {
      const data = load();
      if (scope === "all") {
        save({});
        return;
      }
      const key = {
        client: "client",
        tokens: "tokens",
        verifier: "verifier",
        discovery: "discovery",
      }[scope];
      delete data[key];
      save(data);
    },
    expiresAt: () => load().expires_at,
  };
}
export function connectionOAuthProvider(connection) {
  if (!credentials(connection.id).tokens)
    fail(401, "Sign in again from Connections.");
  return oauthProvider(connection, {
    load: () => credentials(connection.id),
    save: (data) =>
      run(
        "INSERT INTO connection_oauth VALUES(?,?,?) ON CONFLICT(connection_id) DO UPDATE SET data=excluded.data,updated=excluded.updated",
        connection.id,
        encrypt(JSON.stringify(data)),
        now(),
      ),
  });
}
export async function refreshIfExpired(provider, url, fetchFn, scope) {
  if (provider.expiresAt() && provider.expiresAt() <= Date.now() + 30000)
    await auth(provider, { serverUrl: url, fetchFn, scope });
}
function flowCookie(state) {
  return "td_mcp_" + hash(state).slice(0, 12);
}
const cookieOptions = {
  httpOnly: true,
  secure: appUrl.startsWith("https:"),
  sameSite: "lax",
  path: "/mcp/oauth/callback",
  maxAge: 15 * 60000,
};
export function invalidateOAuthFlows(connectionId) {
  run("DELETE FROM mcp_oauth_flows WHERE connection_id=?", connectionId);
}
function validFlow(state) {
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(state))
    fail(400, "Invalid sign-in link.");
  const flow = one(
    "SELECT * FROM mcp_oauth_flows WHERE state_hash=? AND status='pending' AND expires>?",
    hash(state),
    Date.now(),
  );
  if (!flow)
    fail(
      400,
      "This sign-in link expired or was already used. Start again from Connections.",
    );
  return flow;
}
function checkFlowIdentity(flow, browserCookie) {
  if (!browserCookie || hash(browserCookie) !== flow.browser_hash)
    fail(403, "Complete sign-in in the same browser where you started.");
  if (
    !one(
      "SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires>?",
      flow.session_hash,
      flow.user_id,
      Date.now(),
    )
  )
    fail(401, "Your TameDuck session ended. Please sign in again.");
  const connection = one(
    "SELECT * FROM connections WHERE id=?",
    flow.connection_id,
  );
  if (!connection || !connection.enabled || connection.auth_type !== "oauth")
    fail(409, "This connection was changed. Start sign-in again.");
  const member = memberFor(connection.company_id, flow.user_id);
  if (!member) fail(403, "Your company membership ended.");
  can(member, "integrations");
  return connection;
}
export async function beginOAuth(req, res, connectionId) {
  can(req.member, "integrations");
  return withConnectionLock(connectionId, async () => {
    const connection = tenant("connections", connectionId, req.company.id);
    const provider = catalogProvider(connection.provider_id);
    if (connection.auth_type !== "oauth" || !provider?.oauthHosts)
      fail(400, "This connection does not support browser sign-in.");
    run("DELETE FROM mcp_oauth_flows WHERE expires<?", Date.now());
    invalidateOAuthFlows(connection.id);
    const state = token(),
      browser = token(),
      previous = credentials(connection.id);
    const payload = { client: previous.client, discovery: previous.discovery };
    run(
      "INSERT INTO mcp_oauth_flows(state_hash,connection_id,user_id,session_hash,browser_hash,expires,payload) VALUES(?,?,?,?,?,?,?)",
      hash(state),
      connection.id,
      req.user.id,
      req.session.token_hash,
      hash(browser),
      Date.now() + 15 * 60000,
      encrypt(JSON.stringify(payload)),
    );
    const load = () =>
      unpack(
        one(
          "SELECT payload FROM mcp_oauth_flows WHERE state_hash=?",
          hash(state),
        )?.payload,
      );
    const save = (data) =>
      run(
        "UPDATE mcp_oauth_flows SET payload=? WHERE state_hash=?",
        encrypt(JSON.stringify(data)),
        hash(state),
      );
    let authorizationUrl;
    try {
      await auth(
        oauthProvider(connection, {
          load,
          save,
          state,
          redirect: (url) => (authorizationUrl = url),
        }),
        {
          serverUrl: connection.url,
          scope: provider.scope,
          fetchFn: guardedFetch(provider.oauthHosts),
        },
      );
      if (!authorizationUrl) throw new Error("No sign-in URL");
      run(
        "UPDATE connections SET enabled=1,connection_status='auth_required',last_error=NULL WHERE id=?",
        connection.id,
      );
      res.cookie(flowCookie(state), browser, cookieOptions);
      audit(
        connection.company_id,
        req.user.id,
        "MCP sign-in started",
        provider.name,
      );
      return { authorization_url: authorizationUrl };
    } catch (error) {
      invalidateOAuthFlows(connection.id);
      fail(
        400,
        "Could not start sign-in. The provider may be unavailable or require administrator setup. Try again or check its setup guide.",
      );
    }
  });
}
export function registerOAuthCallback(app) {
  app.get("/mcp/oauth/callback", async (req, res) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    let flow, connection;
    const state = String(req.query.state || "");
    try {
      flow = validFlow(state);
      connection = checkFlowIdentity(flow, req.cookies[flowCookie(state)]);
      const provider = catalogProvider(connection.provider_id);
      const payload = unpack(flow.payload);
      if (
        req.query.iss &&
        String(req.query.iss) !==
          payload.discovery?.authorizationServerMetadata?.issuer
      )
        fail(400, "The sign-in provider did not match.");
      if (
        !run(
          "UPDATE mcp_oauth_flows SET status='exchanging' WHERE state_hash=? AND status='pending'",
          flow.state_hash,
        ).changes
      )
        fail(409, "Sign-in was already handled.");
      if (req.query.error) {
        run(
          "UPDATE connections SET connection_status='auth_required',last_error=? WHERE id=?",
          "Sign-in was cancelled. You can try again whenever you are ready.",
          connection.id,
        );
      } else {
        const code = String(req.query.code || "");
        if (!code || code.length > 8192) fail(400, "Missing sign-in code.");
        await withConnectionLock(connection.id, async () => {
          let data = payload;
          await auth(
            oauthProvider(connection, {
              load: () => data,
              save: (d) => (data = d),
              state,
            }),
            {
              serverUrl: connection.url,
              authorizationCode: code,
              scope: provider.scope,
              fetchFn: guardedFetch(provider.oauthHosts),
            },
          );
          checkFlowIdentity(flow, req.cookies[flowCookie(state)]);
          if (
            !one(
              "SELECT 1 FROM mcp_oauth_flows WHERE state_hash=? AND status='exchanging' AND expires>?",
              flow.state_hash,
              Date.now(),
            )
          )
            fail(409, "The connection changed during sign-in.");
          delete data.verifier;
          run(
            "INSERT INTO connection_oauth VALUES(?,?,?) ON CONFLICT(connection_id) DO UPDATE SET data=excluded.data,updated=excluded.updated",
            connection.id,
            encrypt(JSON.stringify(data)),
            now(),
          );
          run(
            "UPDATE connections SET connection_status='unchecked',last_error=NULL WHERE id=?",
            connection.id,
          );
          audit(
            connection.company_id,
            flow.user_id,
            "MCP account connected",
            provider.name,
          );
        });
        const { inspectMCP } = await import("./integrations.mjs");
        await inspectMCP(
          connection.company_id,
          connection.id,
          flow.user_id,
        ).catch(() => {});
      }
      res.clearCookie(flowCookie(state), {
        ...cookieOptions,
        maxAge: undefined,
      });
      run("DELETE FROM mcp_oauth_flows WHERE state_hash=?", flow.state_hash);
      return res.redirect(
        303,
        `/w/${connection.company_id}/settings/connections`,
      );
    } catch (error) {
      // Never render provider error bodies: they can contain credentials or user-controlled markup.
      if (flow && connection) {
        run("DELETE FROM mcp_oauth_flows WHERE state_hash=?", flow.state_hash);
        run(
          "UPDATE connections SET last_error=? WHERE id=?",
          "Sign-in did not finish. Please try connecting again.",
          connection.id,
        );
      }
      res
        .status(error.status || 400)
        .type("html")
        .send(
          '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Finish connecting · TameDuck</title><body><main><h1>Sign-in did not finish</h1><p>The link may have expired, or your browser or access changed. Start again from Connections in the same browser.</p><a href="/settings/connections">Back to TameDuck connections</a></main></body></html>',
        );
    }
  });
}
