import { WebSocketServer, WebSocket } from "ws";
import { hash } from "./store.mjs";
import { asciiRequest } from "./computers.mjs";
const credentials = new Map(),
  sockets = new Map();
const key = (cid, generation) => cid + ":" + generation;
const prefixFor = (cid, generation) =>
  `/api/computers/${cid}/control/native/${generation}`;
function session(req) {
  return hash(
    (req.headers.cookie || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("td_session="))
      ?.slice(11) || "",
  );
}
export function closeNativeDesktop(cid, generation) {
  const matches = (k) =>
    generation ? k === key(cid, generation) : k.startsWith(cid + ":");
  for (const [k, set] of sockets)
    if (matches(k)) {
      for (const close of [...set]) close();
      sockets.delete(k);
    }
  for (const k of credentials.keys()) if (matches(k)) credentials.delete(k);
}
// The provider documents `provisioning: true` as "poll again", not as a failure.
// Treating the first one as fatal retired the whole request and made the person
// repeat the entire takeover, so wait for the desktop inside the deadline instead.
export const provisionPollMs = 1500;
// Wall-clock alone must not decide how often we ask the provider: a fast or
// stubbed delay would otherwise turn the wait into a tight request loop.
export const provisionMaxAttempts = 40;
// Provider error codes that mean "not yet", not "this failed". Kept deliberately
// narrow: anything not listed here still fails the takeover on the first reply.
export const retryableDesktopCodes = new Set(["desktop_not_ready"]);
// Provider desktop URLs expire ten minutes after they are issued. A session that
// outlives that needs a fresh token, or every reconnect and asset fetch 401s.
export const refreshAfterMs = 8 * 60 * 1000;
function parseViewer(result) {
  let u;
  try {
    u = new URL(result.desktopUrl);
  } catch {
    throw new Error("The desktop provider did not return a valid viewer.");
  }
  const fragment = new URLSearchParams(u.hash.slice(1));
  const token = fragment.get("token"),
    encryptionKey = fragment.get("key");
  const hostId = u.searchParams.get("hostId"),
    appId = u.searchParams.get("appId");
  if (
    u.protocol !== "https:" ||
    ![".on.boat.dev", ".on.ascii.dev"].some((suffix) =>
      u.hostname.endsWith(suffix),
    ) ||
    u.username ||
    u.password ||
    u.port ||
    u.pathname !== "/stream.html" ||
    !/^\d+$/.test(hostId || "") ||
    !/^\d+$/.test(appId || "") ||
    !token ||
    token.length > 4096 ||
    /[\r\n]/.test(token)
  )
    throw new Error("The desktop provider returned an unsupported viewer.");
  return { origin: u.origin, token, hostId, appId, encryptionKey };
}
// Refreshed in place so live sockets keep passing the grant identity check.
// A desktop that comes back on a different host or app is a different desktop:
// leave the old grant alone and let the session fail closed into a reconnect.
export async function refreshGrant(
  cid,
  generation,
  { request = asciiRequest, after = refreshAfterMs } = {},
) {
  const k = key(cid, generation),
    grant = credentials.get(k);
  if (!grant || Date.now() - grant.issued < after) return grant;
  let viewer;
  try {
    viewer = parseViewer(
      await request(
        `/boxes/${encodeURIComponent(grant.box)}/desktop?theme=light`,
        "POST",
        {},
      ),
    );
  } catch {
    return grant;
  }
  if (credentials.get(k) !== grant) return credentials.get(k);
  if (
    viewer.origin !== grant.origin ||
    viewer.hostId !== grant.hostId ||
    viewer.appId !== grant.appId
  )
    return grant;
  grant.token = viewer.token;
  grant.issued = Date.now();
  return grant;
}
async function issueDesktop(c, { request, guard, deadline, sleep }) {
  for (let attempt = 1; ; attempt++) {
    let pending = null;
    try {
      const result = await request(
        `/boxes/${encodeURIComponent(c.box_id)}/desktop?theme=light`,
        "POST",
        {},
      );
      if (!result.provisioning) return result;
    } catch (e) {
      // A machine that is up but whose desktop has not started yet answers with
      // an error rather than the documented provisioning flag. That is the same
      // "ask again shortly" condition, and treating it as fatal was the failure
      // seen most often in practice: the takeover died seconds before the
      // desktop became available, taking its request with it.
      if (!retryableDesktopCodes.has(e.providerCode)) throw e;
      pending = e;
    }
    if (
      !deadline ||
      attempt >= provisionMaxAttempts ||
      Date.now() + provisionPollMs >= deadline
    )
      throw Object.assign(
        new Error("The native desktop is preparing. Reconnect in a moment."),
        { status: 409, providerCode: pending?.providerCode },
      );
    await sleep(provisionPollMs);
    // Cancellation, replacement or an expired deadline must win over a retry.
    guard();
  }
}
export async function prepareNativeDesktop(
  c,
  generation,
  {
    request = asciiRequest,
    guard = () => {},
    deadline = 0,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {},
) {
  const result = await issueDesktop(c, { request, guard, deadline, sleep });
  const { origin, token, hostId, appId, encryptionKey } = parseViewer(result);
  credentials.set(key(c.id, generation), {
    origin,
    token,
    hostId,
    appId,
    box: c.box_id,
    started: c.started_at,
    issued: Date.now(),
  });
  // The provider exposes no resolution or frame-rate option; these match its
  // documented defaults and are carried only for the viewer page itself.
  const query = new URLSearchParams({
    hostId,
    appId,
    theme: "light",
    width: "1920",
    height: "1080",
    fps: "60",
  });
  return {
    transport: "native",
    computer_id: c.id,
    box_id: c.box_id,
    started_at: c.started_at,
    viewer_url:
      prefixFor(c.id, generation) +
      "/stream.html?" +
      query +
      (encryptionKey ? "#key=" + encodeURIComponent(encryptionKey) : ""),
  };
}
// Pause the far side above the high mark and let it run again below the low one.
// Only a peer that ignores backpressure entirely reaches the hard cap.
const highWater = 8 * 1024 * 1024,
  lowWater = 2 * 1024 * 1024,
  hardCap = 64 * 1024 * 1024;
const assetPattern =
  /^(?:stream\.html|[A-Za-z0-9_./-]+\.(?:js|css|svg|png|webp|ico|wasm|woff2?|json))$/;
export function registerNativeDesktopHttp(app, { validStream }) {
  app.use("/api/computers/:id/control/native/:generation", async (req, res) => {
    const { id, generation } = req.params,
      grant = credentials.get(key(id, generation)),
      sessionHash = session(req);
    const valid = () =>
      credentials.get(key(id, generation)) === grant &&
      validStream(id, sessionHash, generation);
    if (!grant || !valid()) return res.sendStatus(403);
    await refreshGrant(id, generation);
    const asset = req.path.slice(1),
      api = req.path.startsWith("/api/");
    if (asset.includes("..") || asset.includes("//") || /[\\%]/.test(asset))
      return res.sendStatus(404);
    if (
      api
        ? !(
            (req.method === "GET" &&
              [
                "/api/authenticate",
                "/api/user",
                "/api/host",
                "/api/apps",
                "/api/app/image",
                "/api/clipboard",
              ].includes(req.path)) ||
            (req.method === "POST" && req.path === "/api/clipboard")
          )
        : req.method !== "GET" || !assetPattern.test(asset)
    )
      return res.sendStatus(404);
    const upstream = new URL(req.path, grant.origin);
    if (["/api/host", "/api/apps", "/api/app/image"].includes(req.path)) {
      const incoming = new URL(req.originalUrl, "http://local");
      for (const [name, value] of incoming.searchParams) {
        if (!["host_id", "app_id", "hostId", "appId"].includes(name))
          return res.sendStatus(400);
        if (
          value !==
          (name.toLowerCase().startsWith("host") ? grant.hostId : grant.appId)
        )
          return res.sendStatus(403);
        upstream.searchParams.set(name, value);
      }
    }
    try {
      const headers = {
        Authorization: "Bearer " + grant.token,
        Origin: grant.origin,
        Referer: grant.origin + "/stream.html",
      };
      let body;
      if (req.method === "POST") {
        headers["Content-Type"] =
          req.headers["content-type"] || "application/json";
        body =
          typeof req.body === "string" || Buffer.isBuffer(req.body)
            ? req.body
            : JSON.stringify(req.body || {});
        if (Buffer.byteLength(body) > 128 * 1024) return res.sendStatus(413);
      }
      const response = await fetch(upstream, {
        method: req.method,
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (!valid()) return res.sendStatus(403);
      if (!response.ok)
        return res
          .status(response.status)
          .send("Desktop resource unavailable.");
      const chunks = [];
      let size = 0;
      if (response.body)
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 16 * 1024 * 1024)
            throw new Error("Desktop resource exceeds the size limit");
          chunks.push(Buffer.from(chunk));
        }
      let data = Buffer.concat(chunks);
      if (!valid()) return res.sendStatus(403);
      if (["stream.js", "stream/input.js"].includes(asset))
        data = Buffer.from(
          data
            .toString()
            .replaceAll(
              "window.location.origin",
              `(window.location.origin + ${JSON.stringify(prefixFor(id, generation))})`,
            ),
        );
      res.set({
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "SAMEORIGIN",
        "Content-Type":
          response.headers.get("content-type") || "application/octet-stream",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; font-src 'self' data:; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'none'",
      });
      res.send(data);
    } catch {
      if (!res.headersSent)
        res
          .status(502)
          .send(
            "The desktop resource could not be loaded. Reconnect to try again.",
          );
    }
  });
}
export function registerNativeDesktopStream(
  server,
  { validStream, appUrl, WebSocketClass = WebSocket },
) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 128 * 1024,
    perMessageDeflate: false,
  });
  server.on("upgrade", (req, socket, head) => {
    if (!/^\/api\/computers\/[^/]+\/control\/native\//.test(req.url || ""))
      return;
    const m =
      /^\/api\/computers\/([0-9a-f-]{36})\/control\/native\/([0-9a-f-]{36})\/api\/host\/stream$/.exec(
        req.url || "",
      );
    const deny = () =>
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    if (!m || req.headers.origin !== new URL(appUrl).origin) return deny();
    const [_, cid, generation] = m,
      grant = credentials.get(key(cid, generation)),
      sessionHash = session(req);
    const valid = () =>
      credentials.get(key(cid, generation)) === grant &&
      validStream(cid, sessionHash, generation);
    if (!grant || !valid()) return deny();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const upstream = new WebSocketClass(
        grant.origin.replace(/^https:/, "wss:") + "/api/host/stream",
        {
          perMessageDeflate: false,
          maxPayload: 16 * 1024 * 1024,
          headers: { Origin: grant.origin },
          handshakeTimeout: 10000,
        },
      );
      let closed = false,
        initialized = false,
        pending = [],
        pendingBytes = 0,
        live = true,
        upstreamPaused = false,
        clientPaused = false;
      const set = sockets.get(key(cid, generation)) || new Set();
      sockets.set(key(cid, generation), set);
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        set.delete(close);
        ws.terminate();
        upstream.terminate();
        pending = [];
      };
      // Revalidated on a timer rather than per frame: the authorization queries
      // cost far more than forwarding the frame, and this interval already
      // bounded how long a revoked session could keep streaming.
      const timer = setInterval(() => {
        live = valid();
        if (!live) close();
      }, 1000);
      timer.unref();
      set.add(close);
      // Identity is still checked on every message; only the database lookups moved.
      const alive = () =>
        live && credentials.get(key(cid, generation)) === grant;
      const resumeClient = () => {
        if (clientPaused && upstream.bufferedAmount <= lowWater) {
          clientPaused = false;
          ws.resume();
        }
      };
      const send = (data, binary) => {
        if (upstream.readyState === 1) {
          upstream.send(data, { binary }, resumeClient);
          if (!clientPaused && upstream.bufferedAmount > highWater) {
            clientPaused = true;
            ws.pause();
          }
        } else {
          pendingBytes += data.length;
          if (pendingBytes > 128 * 1024) return close();
          pending.push([data, binary]);
        }
      };
      ws.on("message", (data, binary) => {
        if (!alive() || upstream.bufferedAmount > hardCap) return close();
        if (!binary) {
          let value;
          try {
            value = JSON.parse(data.toString());
          } catch {
            return close();
          }
          if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            "Authenticate" in value
          )
            return close();
          if ("Init" in value) {
            if (
              initialized ||
              String(value.Init?.host_id) !== grant.hostId ||
              String(value.Init?.app_id) !== grant.appId
            )
              return close();
            initialized = true;
          } else if (!initialized) return close();
        } else if (!initialized) return close();
        send(data, binary);
      });
      upstream.on("open", () => {
        if (!valid()) return close();
        upstream.send(
          JSON.stringify({ Authenticate: { bearer: grant.token } }),
        );
        for (const [data, binary] of pending) upstream.send(data, { binary });
        pending = [];
        pendingBytes = 0;
      });
      upstream.on("message", (data, binary) => {
        if (!alive() || ws.bufferedAmount > hardCap) return close();
        // A slow viewer throttles the provider instead of losing its desktop:
        // dropping the session here forced a full, manual takeover again.
        ws.send(data, { binary }, () => {
          if (upstreamPaused && ws.bufferedAmount <= lowWater) {
            upstreamPaused = false;
            upstream.resume();
          }
        });
        if (!upstreamPaused && ws.bufferedAmount > highWater) {
          upstreamPaused = true;
          upstream.pause();
        }
      });
      ws.on("error", close);
      upstream.on("error", close);
      ws.on("close", close);
      upstream.on("close", close);
    });
  });
  return wss;
}
