import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tameduck-oauth-test-"));
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
process.env.APP_URL = "https://staging.tameduck.com";
const { oauthProvider, refreshIfExpired, withConnectionLock } =
  await import("../server/mcp-oauth.mjs");
const { guardedFetch } = await import("../server/mcp-network.mjs");
const { mcpCatalog } = await import("../server/mcp-catalog.mjs");
const { auth } = await import("@modelcontextprotocol/sdk/client/auth.js");
const { db } = await import("../server/store.mjs");
after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
const connection = { provider_id: "notion", url: "https://mcp.notion.com/mcp" };
const metadata = {
  issuer: "https://mcp.notion.com",
  authorization_endpoint: "https://mcp.notion.com/authorize",
  token_endpoint: "https://mcp.notion.com/token",
  registration_endpoint: "https://mcp.notion.com/register",
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: ["none"],
  code_challenge_methods_supported: ["S256"],
};
const response = (data) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
function fixture(initial = {}) {
  let data = initial,
    redirect;
  const state = crypto.randomBytes(32).toString("base64url");
  const provider = oauthProvider(connection, {
    load: () => data,
    save: (d) => (data = d),
    state,
    redirect: (url) => (redirect = url),
  });
  return { provider, state, data: () => data, redirect: () => redirect };
}
test("OAuth performs discovery, registration, PKCE exchange and token refresh", async () => {
  const f = fixture();
  let registrations = 0;
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.includes("oauth-protected-resource"))
      return response({
        resource: connection.url,
        authorization_servers: ["https://mcp.notion.com"],
      });
    if (u.pathname.includes("oauth-authorization-server"))
      return response(metadata);
    if (u.pathname === "/register") {
      registrations++;
      const b = JSON.parse(init.body);
      assert.deepEqual(b.redirect_uris, [
        "https://staging.tameduck.com/mcp/oauth/callback",
      ]);
      assert.equal(b.token_endpoint_auth_method, "none");
      return response({ ...b, client_id: "synthetic-client" });
    }
    if (u.pathname === "/token") {
      const p = new URLSearchParams(init.body);
      if (p.get("grant_type") === "authorization_code") {
        assert.equal(p.get("code"), "synthetic-code");
        assert.equal(p.get("code_verifier"), f.data().verifier);
        return response({
          access_token: "access-first",
          refresh_token: "refresh-first",
          token_type: "Bearer",
          expires_in: 1,
        });
      }
      assert.equal(p.get("refresh_token"), "refresh-first");
      return response({
        access_token: "access-new",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    throw new Error("Unexpected request " + u.pathname);
  };
  assert.equal(
    await auth(f.provider, { serverUrl: connection.url, fetchFn }),
    "REDIRECT",
  );
  const url = new URL(f.redirect());
  assert.equal(url.searchParams.get("state"), f.state);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    url.searchParams.get("code_challenge"),
    crypto.createHash("sha256").update(f.data().verifier).digest("base64url"),
  );
  assert.equal(
    await auth(f.provider, {
      serverUrl: connection.url,
      authorizationCode: "synthetic-code",
      fetchFn,
    }),
    "AUTHORIZED",
  );
  assert.equal(f.provider.tokens().access_token, "access-first");
  assert.equal(f.provider.tokens().issuer, metadata.issuer);
  assert.equal(f.provider.clientInformation().issuer, metadata.issuer);
  await refreshIfExpired(f.provider, connection.url, fetchFn);
  assert.equal(f.provider.tokens().access_token, "access-new");
  assert.equal(f.provider.tokens().refresh_token, "refresh-first");
  assert.equal(f.provider.tokens().issuer, metadata.issuer);
  assert.equal(registrations, 1);
});
test("legacy credentials require sign-in before background use, even before token expiry", () => {
  for (const credential of [
    { client: { client_id: "old", client_secret: "old-secret" } },
    { tokens: { access_token: "old-access", refresh_token: "old-refresh", token_type: "Bearer" } },
    { client: { client_id: "old", issuer: metadata.issuer }, tokens: { access_token: "old", issuer: " " } },
  ]) {
    let data = { ...credential, verifier: "old-verifier", expires_at: Date.now() + 3600000 };
    assert.throws(() => oauthProvider(connection, {
      load: () => data, save: value => { data = value; },
    }), error => error.status === 401 && /Sign in again/.test(error.message));
    assert.deepEqual(data, {});
  }
});
test("interactive sign-in discards unbound client credentials instead of reusing them", async () => {
  const f = fixture({
    client: { client_id: "legacy-client", client_secret: "legacy-secret" },
    tokens: { access_token: "legacy-access", refresh_token: "legacy-refresh" },
    verifier: "old-verifier", expires_at: Date.now() + 3600000,
  });
  assert.deepEqual(f.data(), {});
  let registrations = 0;
  const fetchFn = async (url, init) => {
    assert.doesNotMatch(String(init?.body || ""), /legacy-/);
    const u = new URL(url);
    if (u.pathname.includes("oauth-protected-resource"))
      return response({ resource: connection.url, authorization_servers: [metadata.issuer] });
    if (u.pathname.includes("oauth-authorization-server")) return response(metadata);
    if (u.pathname === "/register") {
      registrations++;
      return response({ ...JSON.parse(init.body), client_id: "fresh-client" });
    }
    throw new Error("Unexpected request " + u.pathname);
  };
  assert.equal(await auth(f.provider, { serverUrl: connection.url, fetchFn }), "REDIRECT");
  assert.equal(registrations, 1);
  assert.equal(f.provider.clientInformation().client_id, "fresh-client");
  assert.equal(f.provider.clientInformation().issuer, metadata.issuer);
  assert.notEqual(f.data().verifier, "old-verifier");
});
test("cached OAuth discovery must still match the provider allowlist", () => {
  assert.throws(() => fixture({
    discovery: { authorizationServerUrl: "https://attacker.example" },
  }), /Untrusted authorization server/);
});
test("a changed issuer on an allowed host receives neither old refresh tokens nor client secrets", async () => {
  const changedIssuer = metadata.issuer + "/different-issuer";
  const f = fixture({
    client: { client_id: "old-client", client_secret: "old-secret", issuer: metadata.issuer },
    tokens: { access_token: "old-access", refresh_token: "old-refresh", token_type: "Bearer", issuer: metadata.issuer },
    discovery: {
      authorizationServerUrl: changedIssuer,
      authorizationServerMetadata: { ...metadata, issuer: changedIssuer },
      resourceMetadata: { resource: connection.url, authorization_servers: [changedIssuer] },
    },
  });
  const requests = [];
  const fetchFn = async (url, init) => {
    const request = { url: String(url), body: String(init?.body || ""), headers: Object.fromEntries(new Headers(init?.headers)) };
    requests.push(request);
    assert.doesNotMatch(JSON.stringify(request), /old-(?:secret|refresh|access|client)/);
    assert.equal(new URL(url).pathname, "/register", "must not refresh credentials against the changed issuer");
    return response({ ...JSON.parse(init.body), client_id: "new-client" });
  };
  assert.equal(await auth(f.provider, { serverUrl: connection.url, fetchFn }), "REDIRECT");
  assert.equal(requests.length, 1);
  assert.equal(f.provider.clientInformation().issuer, changedIssuer);
});
test("OAuth state, PKCE verifiers and tokens remain isolated per connection attempt", () => {
  const a = fixture(),
    b = fixture();
  a.provider.saveCodeVerifier("a-only");
  a.provider.saveTokens({ access_token: "private-a", token_type: "Bearer" });
  assert.equal(b.provider.tokens(), undefined);
  assert.notEqual(a.state, b.state);
  assert.throws(() => b.provider.codeVerifier());
  a.provider.invalidateCredentials("tokens");
  assert.equal(a.provider.tokens(), undefined);
});
test("OAuth rejects changed provider URLs and credential destinations outside the allowlist", async () => {
  assert.throws(() =>
    oauthProvider(
      { ...connection, url: "https://evil.example/mcp" },
      { load: () => ({}), save: () => {} },
    ),
  );
  const p = fixture().provider;
  assert.throws(() =>
    p.saveDiscoveryState({
      authorizationServerUrl: "https://attacker.example",
    }),
  );
  assert.throws(() =>
    p.saveDiscoveryState({
      authorizationServerUrl: "https://mcp.notion.com",
      authorizationServerMetadata: {
        ...metadata,
        token_endpoint: "https://attacker.example/token",
      },
    }),
  );
  assert.throws(() =>
    p.redirectToAuthorization(new URL("https://attacker.example/authorize")),
  );
  await assert.rejects(() =>
    guardedFetch(["mcp.notion.com"])("https://attacker.example/token", {
      method: "POST",
      body: "synthetic-secret",
    }),
  );
  await assert.rejects(() =>
    guardedFetch(["localhost"])("https://localhost/token"),
  );
});
test("background OAuth never opens sign-in or creates an unbound PKCE flow", () => {
  const p = oauthProvider(connection, { load: () => ({}), save: () => {} });
  assert.throws(() => p.state());
  assert.throws(() => p.saveCodeVerifier("bad"));
  assert.throws(() =>
    p.redirectToAuthorization(new URL("https://mcp.notion.com/authorize")),
  );
});
test("connection locks serialize refresh/disconnect, release after failure, and allow unrelated services", async () => {
  const order = [];
  let release;
  const first = withConnectionLock("a", async () => {
    order.push("a1");
    await new Promise((r) => (release = r));
    throw new Error("synthetic failure");
  });
  while (!release) await new Promise((r) => setImmediate(r));
  const second = withConnectionLock("a", async () => order.push("a2"));
  await withConnectionLock("b", async () => order.push("b"));
  release();
  await assert.rejects(first);
  await second;
  assert.deepEqual(order, ["a1", "b", "a2"]);
});
test("catalog has unique official HTTPS endpoints and complete supported setup metadata", () => {
  assert.equal(new Set(mcpCatalog.map((p) => p.id)).size, mcpCatalog.length);
  for (const p of mcpCatalog) {
    assert.equal(new URL(p.url).protocol, "https:");
    assert.equal(new URL(p.docs).protocol, "https:");
    assert.ok(p.auth.length);
    if (p.auth.includes("oauth"))
      assert.ok(p.oauthHosts.includes(new URL(p.url).hostname));
  }
  assert.equal(
    mcpCatalog.find((p) => p.id === "atlassian").url,
    "https://mcp.atlassian.com/v2/mcp",
  );
});
