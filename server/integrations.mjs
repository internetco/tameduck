import { validateUrl, guardedFetch } from "./mcp-network.mjs";
import { connectionWorksAgain } from "./connection-blocks.mjs";
export { validateUrl, publicIPv4 } from "./mcp-network.mjs";
import { catalogProvider } from "./mcp-catalog.mjs";
import {
  connectionOAuthProvider,
  withConnectionLock,
  refreshIfExpired,
} from "./mcp-oauth.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  all,
  one,
  run,
  tenant,
  json,
  decrypt,
  fail,
  audit,
  now,
  emit,
  memberFor,
  permissions,
} from "./store.mjs";
export async function withMCP(company, connectionId, duckId, callback) {
  return withConnectionLock(connectionId, () =>
    connectMCP(company, connectionId, duckId, callback),
  );
}
async function connectMCP(company, connectionId, duckId, callback) {
  const connection = tenant("connections", connectionId, company);
  if (!connection.enabled) fail(400, "This connection is paused.");
  // Each refusal says which button fixes it: Allow for a duck that may not
  // use this, Reconnect for a connection that cannot get in.
  const refuse = (status, message, block) => {
    throw Object.assign(new Error(message), { status, block });
  };
  if (duckId && !json(connection.allowed_ducks).includes(duckId))
    refuse(403, "This duck cannot access that connection.", "access");
  const url = validateUrl(connection.url);
  const headers = {};
  if (connection.auth_type === "secret" && !connection.secret_id)
    refuse(
      400,
      "Choose a saved key in Connections to reconnect this service.",
      "sign_in",
    );
  if (connection.secret_id) {
    const secret = tenant("secrets", connection.secret_id, company);
    if (duckId && !json(secret.allowed_ducks).includes(duckId))
      refuse(403, "This duck cannot use the selected secret.", "access");
    headers.Authorization = "Bearer " + decrypt(secret.value);
  }
  const client = new Client(
    { name: "tameduck", version: "0.1.0" },
    { capabilities: {} },
  );
  const provider = catalogProvider(connection.provider_id);
  const fetchFn = guardedFetch([
    ...new Set([
      url.hostname,
      ...(connection.auth_type === "oauth" ? provider?.oauthHosts || [] : []),
    ]),
  ]);
  const authProvider =
    connection.auth_type === "oauth"
      ? connectionOAuthProvider(connection)
      : undefined;
  if (authProvider)
    await refreshIfExpired(
      authProvider,
      connection.url,
      fetchFn,
      provider?.scope,
    );
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
    authProvider,
    fetch: fetchFn,
  });
  try {
    await client.connect(transport);
    return await callback(client, connection);
  } finally {
    await client.close().catch(() => {});
  }
}
export function connectionError(error) {
  if (error?.status === 403) return error.message;
  if (
    error?.code === 401 ||
    error?.code === 403 ||
    /Unauthorized|invalid.grant|invalid.token|sign in/i.test(
      error?.message || "",
    )
  )
    return "Sign in again or check that your key has access to this service.";
  return "Could not connect. Check your sign-in, service permissions, and server address, then try again.";
}
export async function listAllTools(client, cap = 500) {
  const tools = [];
  let cursor;
  const cursors = new Set();
  do {
    const list = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...list.tools);
    cursor = list.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error("Repeated tools cursor");
    if (cursor) cursors.add(cursor);
  } while (cursor && tools.length < cap);
  return { tools: tools.slice(0, cap), more: tools.length > cap };
}
export async function inspectMCP(company, connectionId, by = null) {
  try {
    return await withMCP(company, connectionId, null, async (client) => {
      const kept = (await listAllTools(client)).tools;
      run(
        "UPDATE connections SET tools=?,connection_status='connected',checked_at=?,last_error=NULL WHERE id=?",
        JSON.stringify(kept),
        now(),
        connectionId,
      );
      emit(company);
      connectionWorksAgain(company, connectionId, by);
      return kept;
    });
  } catch (error) {
    const message = connectionError(error);
    run(
      "UPDATE connections SET connection_status='error',checked_at=?,last_error=? WHERE id=? AND company_id=?",
      now(),
      message,
      connectionId,
      company,
    );
    emit(company);
    fail(error?.status || 400, message);
  }
}
export async function executeApproved(approval, actor) {
  let callStarted = false;
  try {
    const job = tenant("jobs", approval.job_id, approval.company_id);
    const member = memberFor(job.company_id, job.user_id);
    if (!member || !permissions(member).chat)
      fail(403, "The requesting member no longer has chat permission.");
    if (one("SELECT paused FROM companies WHERE id=?", job.company_id).paused)
      fail(409, "Resume the company before running connected tools.");
    return await withMCP(
      job.company_id,
      approval.connection_id,
      job.duck_id,
      async (client) => {
        // A connection can fail before this call, including its address and
        // access checks. In that case we know the requested tool was not sent.
        const args = json(approval.args);
        callStarted = true;
        const result = await client.callTool(
          { name: approval.tool, arguments: args },
          undefined,
          { timeout: 30000 },
        );
        const output = JSON.stringify(result).slice(0, 60000);
        audit(
          job.company_id,
          actor,
          "Connected tool executed",
          {
            tool: approval.tool,
            connection: approval.connection_id,
            isError: !!result.isError,
          },
          { duck: job.duck_id, job: job.id },
        );
        return { output, isError: !!result.isError };
      },
    );
  } catch (error) {
    if (!callStarted) error.toolNotSent = true;
    throw error;
  }
}
