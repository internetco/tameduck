import dns from "node:dns";
import net from "node:net";
import { Agent, fetch as safeFetch } from "undici";
import { fail } from "./store.mjs";
export function publicIPv4(ip) {
  if (net.isIP(ip) !== 4) return false;
  const [a, b] = ip.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || b === 2)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0)
  );
}
export function validateUrl(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    fail(400, "Enter a valid HTTPS address.");
  }
  // URL.hostname keeps brackets around IPv6 literals (for example, "[::1]")
  // while net.isIP expects the address without them. Normalize only for this
  // check so every IP literal, including IPv4-mapped IPv6, is refused.
  const hostname = u.hostname.replace(/^\[|\]$/g, "");
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.hash ||
    net.isIP(hostname) ||
    /^(localhost)$|\.(localhost|local|internal)$/i.test(u.hostname)
  )
    fail(400, "Use a public HTTPS hostname for your MCP server.");
  if (u.port && u.port !== "443")
    fail(400, "MCP servers must use HTTPS port 443.");
  return u;
}
const dispatcher = new Agent({
  connect: {
    lookup(host, opts, cb) {
      dns.lookup(host, { all: true, family: 4 }, (error, addresses) => {
        if (error) return cb(error);
        if (!addresses.length || addresses.some((x) => !publicIPv4(x.address)))
          return cb(new Error("Private network addresses are not allowed"));
        if (opts.all) cb(null, addresses);
        else cb(null, addresses[0].address, 4);
      });
    },
  },
});

export function guardedFetch(allowedHosts) {
  return async (input, init) => {
    const target = validateUrl(
      typeof input === "string" ? input : input.url || String(input),
    );
    if (!allowedHosts.includes(target.hostname))
      throw new Error("This provider redirected outside its trusted servers.");
    const response = await safeFetch(target, {
      ...init,
      dispatcher,
      redirect: "error",
      signal: AbortSignal.any([
        ...(init?.signal ? [init.signal] : []),
        AbortSignal.timeout(30000),
      ]),
    });
    return limitBody(response);
  };
}

const LIMIT = 2000000;
// Statuses whose responses carry no body at all.
const BODILESS = new Set([101, 103, 204, 205, 304]);
// Every body an MCP server, or its OAuth server, sends is held to 2 MB:
// counted, not taken from Content-Length. Only JSON was before, so a server
// somebody added could answer with an endless text error page or event stream
// and fill the memory of the one process every company shares. JSON and
// everything else is read in full up to the limit; an event stream stays a
// stream and is stopped when it passes it.
export async function limitBody(response, limit = LIMIT) {
  if (Number(response.headers.get("content-length") || 0) > limit) {
    await response.body?.cancel();
    throw new Error("MCP response is too large");
  }
  if (!response.body || BODILESS.has(response.status)) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  const answer = (body) => {
    const limited = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    // Kept for anybody who reads where the answer came from.
    Object.defineProperty(limited, "url", { value: response.url });
    return limited;
  };
  if ((response.headers.get("content-type") || "").includes("text/event-stream")) {
    let size = 0;
    return answer(
      response.body.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            size += chunk.length;
            if (size > limit) throw new Error("MCP response is too large");
            controller.enqueue(chunk);
          },
        }),
      ),
    );
  }
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("MCP response is too large");
      parts.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return answer(Buffer.concat(parts));
}
