import fs from "node:fs";
import net from "node:net";
import { z } from "zod";
import { db, id, one, all, run, fail } from "./store.mjs";

export const PROXY_LEASE_SECONDS = 180;
export const PROXY_RENEW_AFTER_MS = 30000;
const DEFAULT_CONFIG_PATH = "/etc/tameduck/proxy.json";
const activeJobStates = new Set(["running", "waiting_human"]);
const guestStates = new Set([
  "starting",
  "enabled",
  "blocked",
  "unreachable",
  "unknown",
  "disabled",
  "expired",
  "failed",
  "absent",
]);
const terminalGuestStates = new Set([
  "disabled",
  "expired",
  "failed",
  "absent",
]);

const configSchema = z
  .object({
    provider: z.literal("webshare"),
    host: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^[A-Za-z0-9.-]+$/),
    port: z.number().int().min(1).max(65535),
    username: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => !/[\r\n]/.test(value)),
    password: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => !/[\r\n]/.test(value)),
    allowed_company_ids: z.array(z.string().uuid()).min(1),
    price_per_gb: z.number().nonnegative().nullable().optional(),
  })
  .strict();

const configPath = () =>
  process.env.TAMEDUCK_PROXY_CONFIG_PATH || DEFAULT_CONFIG_PATH;

export function readProxyConfig(companyId, { required = false } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(configPath(), "utf8");
  } catch {
    if (required)
      fail(503, "The computer proxy is not configured for this company.");
    return null;
  }
  let parsed;
  try {
    parsed = configSchema.parse(JSON.parse(raw));
  } catch {
    if (required) fail(503, "The computer proxy configuration is incomplete.");
    return null;
  }
  if (!parsed.allowed_company_ids.includes(companyId)) {
    if (required)
      fail(403, "The computer proxy is not enabled for this company.");
    return null;
  }
  return parsed;
}

// A missing exception means allowed, including for ducks created after a save.
// Resolve the duck through its company so a foreign or deleted ID fails closed.
export function duckProxyAllowed(companyId, duckId) {
  const duck = one(
    "SELECT id,removed FROM ducks WHERE id=? AND company_id=?",
    duckId,
    companyId,
  );
  if (!duck || duck.removed) return false;
  return (
    one(
      "SELECT enabled FROM duck_proxy_access WHERE company_id=? AND duck_id=?",
      companyId,
      duckId,
    )?.enabled !== 0
  );
}

const finiteCounter = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;

const activeSession = (computerId) =>
  one(
    "SELECT * FROM computer_proxy_sessions WHERE computer_id=? AND ended IS NULL ORDER BY started DESC LIMIT 1",
    computerId,
  );

const recentSession = (computerId) =>
  activeSession(computerId) ||
  one(
    "SELECT * FROM computer_proxy_sessions WHERE computer_id=? ORDER BY started DESC LIMIT 1",
    computerId,
  );

const publicSession = (session) => {
  const active = !!session && session.ended === null;
  return {
    active,
    enabled: active,
    connected: active && session.state === "enabled",
    state: session?.state || "disabled",
    upload_bytes: session?.upload_bytes || 0,
    download_bytes: session?.download_bytes || 0,
    total_bytes: (session?.upload_bytes || 0) + (session?.download_bytes || 0),
    estimated: !!session?.estimated,
    lease_expires_at: session?.lease_expires_at || null,
    exit_ip: session?.exit_ip || null,
    last_seen: session?.last_seen || null,
    error: session?.last_error || null,
  };
};

const responseError = (status, { reset, incomplete }) =>
  status === "absent"
    ? "The proxy session was not present on the computer, so no usage could be recovered for it."
    : reset
      ? "Usage counters restarted; the missing interval is estimated."
      : incomplete
        ? "Some proxy usage could not be recovered and is estimated."
        : status === "blocked"
          ? "Proxy verification failed. Direct traffic remains blocked until the proxy is disabled or expires."
          : status === "unreachable" || status === "unknown"
            ? "Proxy status could not be confirmed. The route may or may not be active."
            : status === "failed"
              ? "The proxy could not start."
              : null;

export function recordProxyGuestState(
  sessionId,
  response,
  { time = Date.now() } = {},
) {
  if (
    !response ||
    response.ok !== true ||
    response.session_id !== sessionId ||
    !guestStates.has(response.status)
  )
    throw new Error("Computer proxy returned a mismatched response.");
  const upload = finiteCounter(response.upload_bytes);
  const download = finiteCounter(response.download_bytes);
  if (upload === null || download === null)
    throw new Error("Computer proxy returned invalid usage counters.");
  return db.transaction(() => {
    const current = one(
      "SELECT * FROM computer_proxy_sessions WHERE id=?",
      sessionId,
    );
    if (!current) throw new Error("Computer proxy session is unavailable.");
    // A journal recovered after the session ended belongs to that known session
    // boundary, not to the later housekeeping round that happened to read it.
    // Open sessions retain the sample time: there is no honest finer interval.
    const recordedAt = current.ended || time;
    const reset =
      upload < current.guest_upload_bytes ||
      download < current.guest_download_bytes;
    const uploadDelta = Math.max(0, upload - current.guest_upload_bytes);
    const downloadDelta = Math.max(0, download - current.guest_download_bytes);
    if (uploadDelta || downloadDelta)
      run(
        "INSERT INTO computer_proxy_usage(id,session_id,company_id,duck_id,computer_id,job_id,recorded,upload_bytes,download_bytes,guest_upload_bytes,guest_download_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        id(),
        current.id,
        current.company_id,
        current.duck_id,
        current.computer_id,
        current.job_id,
        recordedAt,
        uploadDelta,
        downloadDelta,
        upload,
        download,
      );
    const incomplete = response.metering_incomplete === true;
    const leaseSeconds = Number(response.lease_expires_at);
    const leaseExpiresAt = Number.isFinite(leaseSeconds)
      ? Math.round(leaseSeconds * 1000)
      : current.lease_expires_at;
    const exitIp =
      typeof response.exit_ip === "string" && net.isIP(response.exit_ip)
        ? response.exit_ip
        : null;
    const terminal = terminalGuestStates.has(response.status);
    const ended = current.ended || (terminal ? time : null);
    const finalized =
      terminal && (!incomplete || response.status === "absent")
        ? 1
        : current.finalized;
    run(
      "UPDATE computer_proxy_sessions SET state=?,ended=?,last_seen=?,guest_upload_bytes=?,guest_download_bytes=?,upload_bytes=upload_bytes+?,download_bytes=download_bytes+?,estimated=CASE WHEN estimated=1 OR ? OR ? THEN 1 ELSE 0 END,lease_expires_at=?,exit_ip=COALESCE(?,exit_ip),last_error=?,finalized=?,reconcile_attempts=reconcile_attempts+? WHERE id=?",
      response.status,
      ended,
      time,
      Math.max(current.guest_upload_bytes, upload),
      Math.max(current.guest_download_bytes, download),
      uploadDelta,
      downloadDelta,
      reset ? 1 : 0,
      incomplete ? 1 : 0,
      leaseExpiresAt,
      exitIp,
      responseError(response.status, { reset, incomplete }),
      finalized,
      current.ended && !current.finalized ? 1 : 0,
      current.id,
    );
    return one("SELECT * FROM computer_proxy_sessions WHERE id=?", current.id);
  })();
}

function markProxyUnknown(session, message, time = Date.now()) {
  run(
    "UPDATE computer_proxy_sessions SET state='unknown',estimated=1,last_seen=?,last_error=? WHERE id=? AND ended IS NULL",
    time,
    String(message || "The computer proxy could not be reached.").slice(0, 500),
    session.id,
  );
  return one("SELECT * FROM computer_proxy_sessions WHERE id=?", session.id);
}

const controlTarget = () => {
  try {
    const url = new URL(process.env.COMPUTER_RELAY_URL || process.env.APP_URL);
    if (
      url.protocol !== "https:" ||
      !/^[A-Za-z0-9.-]{1,253}$/.test(url.hostname)
    )
      return {};
    return {
      control_host: url.hostname,
      control_port: Number(url.port || 443),
    };
  } catch {
    // Local tests and offline workspaces do not have a public relay URL.
    return {};
  }
};

const requestFor = (config, sessionId, op) => ({
  op,
  session_id: sessionId,
  lease_seconds: PROXY_LEASE_SECONDS,
  proxy_host: config.host,
  proxy_port: config.port,
  username: config.username,
  password: config.password,
  ...(op === "enable" ? controlTarget() : {}),
});

async function waitForProxyReady(
  session,
  computer,
  execute,
  { attempts, pollMs, wait },
) {
  let current = session;
  for (
    let attempt = 0;
    !current.ended && current.state === "starting";
    attempt++
  ) {
    if (!duckProxyAllowed(current.company_id, current.duck_id)) {
      await disableComputerProxy(computer, execute, { session: current });
      fail(403, "Proxy access is off for this duck.");
    }
    if (attempt >= attempts) {
      await disableComputerProxy(computer, execute, { session: current });
      fail(502, "The computer proxy did not become ready.");
    }
    await wait(pollMs);
    current = recordProxyGuestState(
      current.id,
      await execute(computer, { op: "status", session_id: current.id }),
    );
  }
  if (!duckProxyAllowed(current.company_id, current.duck_id)) {
    if (!current.ended)
      await disableComputerProxy(computer, execute, { session: current });
    fail(403, "Proxy access is off for this duck.");
  }
  if (current.state !== "enabled")
    fail(
      502,
      current.state === "blocked"
        ? "The proxy could not verify its route, so internet traffic remains blocked until it is disabled or expires."
        : "The computer proxy did not become ready.",
    );
  return publicSession(current);
}

export async function enableComputerProxy(
  job,
  computer,
  execute,
  {
    attempts = 30,
    pollMs = 250,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  if (!duckProxyAllowed(job.company_id, job.duck_id))
    fail(403, "Proxy access is off for this duck.");
  const config = readProxyConfig(job.company_id, { required: true });
  const prior = activeSession(computer.id);
  if (prior && prior.job_id !== job.id)
    fail(409, "This computer proxy is already in use by another run.");
  if (prior) {
    const response =
      prior.state === "enabled"
        ? await execute(computer, requestFor(config, prior.id, "renew"))
        : await execute(computer, { op: "status", session_id: prior.id });
    return waitForProxyReady(
      recordProxyGuestState(prior.id, response),
      computer,
      execute,
      { attempts, pollMs, wait },
    );
  }
  const sessionId = id();
  const started = Date.now();
  run(
    "INSERT INTO computer_proxy_sessions(id,computer_id,company_id,duck_id,job_id,state,started,last_seen,guest_upload_bytes,guest_download_bytes,upload_bytes,download_bytes,estimated,finalized,reconcile_attempts) VALUES(?,?,?,?,?,'starting',?,?,0,0,0,0,0,0,0)",
    sessionId,
    computer.id,
    job.company_id,
    job.duck_id,
    job.id,
    started,
    started,
  );
  try {
    const current = recordProxyGuestState(
      sessionId,
      await execute(computer, requestFor(config, sessionId, "enable")),
    );
    return await waitForProxyReady(current, computer, execute, {
      attempts,
      pollMs,
      wait,
    });
  } catch (error) {
    const open = activeSession(computer.id);
    if (open?.id === sessionId && open.state === "starting")
      markProxyUnknown(
        open,
        "Proxy activation could not be confirmed. The route may or may not be active.",
      );
    throw error;
  }
}

export function computerProxyStatus(companyId, computerId = null) {
  const configured = !!readProxyConfig(companyId);
  const session = computerId ? recentSession(computerId) : null;
  return { configured, ...publicSession(session) };
}

export async function disableComputerProxy(
  { company_id: companyId, id: computerId },
  execute,
  { session = null } = {},
) {
  const current = session || activeSession(computerId);
  if (!current || current.company_id !== companyId)
    return { configured: !!readProxyConfig(companyId), ...publicSession(null) };
  try {
    const response = await execute(
      one("SELECT * FROM computers WHERE id=?", computerId),
      { op: "disable", session_id: current.id },
    );
    return {
      configured: !!readProxyConfig(companyId),
      ...publicSession(recordProxyGuestState(current.id, response)),
    };
  } catch {
    return {
      configured: !!readProxyConfig(companyId),
      ...publicSession(
        markProxyUnknown(
          current,
          "Proxy shutdown could not be confirmed. The route may or may not still be active.",
        ),
      ),
    };
  }
}

export async function finishJobComputerProxy(job, execute) {
  const status = one("SELECT status FROM jobs WHERE id=?", job.id)?.status;
  if (activeJobStates.has(status)) return false;
  const sessions = all(
    "SELECT * FROM computer_proxy_sessions WHERE job_id=? AND ended IS NULL",
    job.id,
  );
  for (const session of sessions) {
    const computer = one(
      "SELECT * FROM computers WHERE id=? AND company_id=?",
      session.computer_id,
      job.company_id,
    );
    if (!computer || !["ready", "idle", "running"].includes(computer.state)) {
      markProxyUnknown(
        session,
        "The computer stopped before proxy shutdown and final usage could be verified.",
      );
      continue;
    }
    await disableComputerProxy(computer, execute, { session });
  }
  return sessions.length > 0;
}

async function reconcileEstimatedSession(
  computer,
  execute,
  time,
  force = false,
) {
  const session = one(
    "SELECT * FROM computer_proxy_sessions WHERE computer_id=? AND ended IS NOT NULL AND finalized=0 AND reconcile_attempts<20 ORDER BY ended DESC LIMIT 1",
    computer.id,
  );
  if (
    !session ||
    (!force &&
      session.last_seen &&
      time - session.last_seen < PROXY_RENEW_AFTER_MS)
  )
    return false;
  try {
    return publicSession(
      recordProxyGuestState(
        session.id,
        await execute(computer, { op: "status", session_id: session.id }),
        { time },
      ),
    );
  } catch {
    run(
      "UPDATE computer_proxy_sessions SET reconcile_attempts=reconcile_attempts+1,last_seen=? WHERE id=?",
      time,
      session.id,
    );
    return false;
  }
}

export async function reconcileComputerProxy(
  computer,
  execute,
  { time = Date.now(), force = false } = {},
) {
  const session = activeSession(computer.id);
  if (!session)
    return ["ready", "idle", "running"].includes(computer.state)
      ? reconcileEstimatedSession(computer, execute, time, force)
      : false;
  if (!["ready", "idle", "running"].includes(computer.state)) {
    markProxyUnknown(
      session,
      "The computer is stopped, so proxy shutdown and final usage are unconfirmed.",
      time,
    );
    return false;
  }
  if (
    !force &&
    duckProxyAllowed(computer.company_id, session.duck_id) &&
    session.last_seen &&
    time - session.last_seen < PROXY_RENEW_AFTER_MS
  )
    return false;
  try {
    const jobStatus = one(
      "SELECT status FROM jobs WHERE id=?",
      session.job_id,
    )?.status;
    const config = readProxyConfig(computer.company_id);
    if (
      !activeJobStates.has(jobStatus) ||
      !config ||
      !duckProxyAllowed(computer.company_id, session.duck_id)
    )
      return disableComputerProxy(computer, execute, { session });
    const response =
      session.state === "enabled"
        ? await execute(computer, requestFor(config, session.id, "renew"))
        : await execute(computer, { op: "status", session_id: session.id });
    const observed = recordProxyGuestState(session.id, response, { time });
    if (
      !observed.ended &&
      !duckProxyAllowed(computer.company_id, session.duck_id)
    )
      return disableComputerProxy(computer, execute, { session: observed });
    return publicSession(observed);
  } catch {
    return publicSession(
      markProxyUnknown(
        session,
        "Proxy status could not be confirmed. The route may or may not be active.",
        time,
      ),
    );
  }
}

const monthRange = (time = Date.now()) => {
  const d = new Date(time);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { start, end };
};
const monthStart = (time = Date.now()) => monthRange(time).start;

const usageRows = (companyId, time = Date.now()) => {
  const month = monthRange(time);
  return all(
    "SELECT duck_id,SUM(upload_bytes) upload_bytes,SUM(download_bytes) download_bytes FROM computer_proxy_usage WHERE company_id=? AND recorded>=? AND recorded<? GROUP BY duck_id ORDER BY duck_id",
    companyId,
    month.start,
    month.end,
  );
};

const monthlyEstimated = (
  companyId,
  { computerId = null, duckId = null, time = Date.now() } = {},
) => {
  const month = monthRange(time);
  const filters = [
    "s.company_id=?",
    "s.estimated=1",
    "(s.started<? AND (s.ended IS NULL OR s.ended>?) OR EXISTS(SELECT 1 FROM computer_proxy_usage u WHERE u.session_id=s.id AND u.recorded>=? AND u.recorded<?))",
  ];
  const params = [companyId, month.end, month.start, month.start, month.end];
  if (computerId) {
    filters.push("s.computer_id=?");
    params.push(computerId);
  }
  if (duckId) {
    filters.push("s.duck_id=?");
    params.push(duckId);
  }
  return !!one(
    "SELECT 1 FROM computer_proxy_sessions s WHERE " +
      filters.join(" AND ") +
      " LIMIT 1",
    ...params,
  );
};

export function proxyCompanySummary(companyId, time = Date.now()) {
  const config = readProxyConfig(companyId);
  const byDuck = usageRows(companyId, time).map((row) => ({
    duck_id: row.duck_id,
    estimated: monthlyEstimated(companyId, {
      duckId: row.duck_id,
      time,
    }),
    upload_bytes: Number(row.upload_bytes || 0),
    download_bytes: Number(row.download_bytes || 0),
    total_bytes:
      Number(row.upload_bytes || 0) + Number(row.download_bytes || 0),
    total_gb:
      (Number(row.upload_bytes || 0) + Number(row.download_bytes || 0)) / 1e9,
  }));
  const upload = byDuck.reduce((sum, row) => sum + row.upload_bytes, 0);
  const download = byDuck.reduce((sum, row) => sum + row.download_bytes, 0);
  return {
    configured: !!config,
    month_started: new Date(monthStart(time)).toISOString(),
    upload_bytes: upload,
    download_bytes: download,
    total_bytes: upload + download,
    total_gb: (upload + download) / 1e9,
    price_per_gb: config?.price_per_gb ?? null,
    estimated: monthlyEstimated(companyId, { time }),
    by_duck: byDuck,
  };
}

export function proxyComputerSummary(
  companyId,
  computerId,
  duckId,
  time = Date.now(),
) {
  const range = monthRange(time);
  const month = one(
    "SELECT COALESCE(SUM(upload_bytes),0) upload_bytes,COALESCE(SUM(download_bytes),0) download_bytes FROM computer_proxy_usage WHERE company_id=? AND computer_id=? AND duck_id=? AND recorded>=? AND recorded<?",
    companyId,
    computerId,
    duckId,
    range.start,
    range.end,
  );
  const upload = Number(month?.upload_bytes || 0);
  const download = Number(month?.download_bytes || 0);
  return {
    configured: !!readProxyConfig(companyId),
    ...publicSession(recentSession(computerId)),
    monthly_estimated: monthlyEstimated(companyId, {
      computerId,
      duckId,
      time,
    }),
    monthly_upload_bytes: upload,
    monthly_download_bytes: download,
    monthly_total_bytes: upload + download,
    monthly_total_gb: (upload + download) / 1e9,
  };
}

export const computerProxyInternals = {
  activeSession,
  configPath,
  configSchema,
  finiteCounter,
  monthRange,
  monthStart,
  monthlyEstimated,
  markProxyUnknown,
  publicSession,
  recentSession,
  responseError,
};
