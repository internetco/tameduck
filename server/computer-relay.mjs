import fs from "node:fs";
import crypto from "node:crypto";
import { WebSocketServer, createWebSocketStream } from "ws";
import { computerInternals as C } from "./computers.mjs";
const tickets = new Map(),
  installed = new Set();
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const key = (s) => crypto.createHash("sha256").update(s).digest("hex");
const script = fs.readFileSync(
  new URL("./guest/relay.py", import.meta.url),
  "utf8",
);
const managedRelay = "/usr/local/lib/tameduck/relay.py";
function relayOrigin() {
  const origin = new URL(
    process.env.COMPUTER_RELAY_URL || process.env.APP_URL || "http://localhost",
  );
  if (origin.protocol !== "https:")
    throw new Error(
      "A public HTTPS address is required for the computer connection.",
    );
  return origin;
}
export async function prepareComputerRelay(c) {
  const origin = relayOrigin();
  const identity = c.id + ":" + c.box_id + ":" + c.started_at;
  if (!installed.has(identity)) {
    // Install directly under a root-owned directory. Never execute the copy
    // in the Duck's writable home with sudo just to gain SO_MARK privilege.
    const install =
      "sudo -n install -d -o root -g root -m 0755 /usr/local/lib/tameduck && sudo -n python3 -c " +
      quote(
        "import base64,os,pathlib,tempfile; directory=pathlib.Path('/usr/local/lib/tameduck'); fd,tmp=tempfile.mkstemp(prefix='.relay-',dir=directory); os.fchmod(fd,0o700); data=base64.b64decode(" +
          JSON.stringify(Buffer.from(script).toString("base64")) +
          "); os.write(fd,data); os.fsync(fd); os.close(fd); os.replace(tmp,directory/'relay.py')",
      );
    await C.command(
      c,
      install +
        " && sudo -n python3 " +
        managedRelay +
        " --configure " +
        quote(origin.hostname) +
        " " +
        Number(origin.port || 443),
      10,
    );
    installed.add(identity);
  }
  return managedRelay;
}
export async function openComputerSocket(c, port) {
  if (![5901, 9223].includes(port))
    throw new Error("Unsupported desktop transport.");
  const origin = relayOrigin();
  await prepareComputerRelay(c);
  const token = crypto.randomBytes(32).toString("base64url"),
    digest = key(token);
  let timeout;
  const result = new Promise((resolve, reject) => {
    timeout = setTimeout(() => {
      tickets.delete(digest);
      reject(
        new Error(
          "The computer could not connect securely. Reconnect to try again.",
        ),
      );
    }, 20000);
    tickets.set(digest, {
      cid: c.id,
      port,
      box: c.box_id,
      started: c.started_at,
      resolve,
      reject,
      expires: Date.now() + 20000,
    });
  });
  // Attach a handler before starting the guest so a timeout cannot become unhandled.
  result.catch(() => {});
  try {
    const endpoint = new URL("/api/computer-relay/" + c.id + "/" + port, origin)
      .href;
    const launch =
      'import subprocess,sys; subprocess.Popen([sys.executable,"' +
      managedRelay +
      '",' +
      JSON.stringify(endpoint) +
      "," +
      JSON.stringify(token) +
      "," +
      JSON.stringify(String(port)) +
      '],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True); print("relay started")';
    await C.command(c, "sudo -n python3 -c " + quote(launch), 10);
    return await result;
  } finally {
    clearTimeout(timeout);
    tickets.delete(digest);
  }
}
export function registerComputerRelay(server) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 128 * 1024,
    perMessageDeflate: false,
  });
  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/api/computer-relay/")) return;
    const match = /^\/api\/computer-relay\/([0-9a-f-]{36})\/(5901|9223)$/.exec(
      req.url,
    );
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    const digest = key(token),
      grant = tickets.get(digest);
    if (
      !match ||
      !grant ||
      grant.expires <= Date.now() ||
      grant.cid !== match[1] ||
      grant.port !== Number(match[2])
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    tickets.delete(digest);
    wss.handleUpgrade(req, socket, head, (ws) => {
      const stream = createWebSocketStream(ws);
      stream.setNoDelay = () => stream;
      stream.setKeepAlive = () => stream;
      stream.setTimeout = () => stream;
      stream.on("error", () => {});
      const started = Date.now();
      let alive = true;
      ws.on("pong", () => {
        alive = true;
      });
      const timer = setInterval(() => {
        const c = C.row(grant.cid);
        if (
          !alive ||
          !c ||
          c.box_id !== grant.box ||
          c.started_at !== grant.started ||
          !C.readyStates.includes(c.state) ||
          Date.now() - started > 16 * 60000
        ) {
          stream.destroy();
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, 15000);
      timer.unref();
      ws.on("close", () => clearInterval(timer));
      grant.resolve(stream);
    });
  });
  return wss;
}
