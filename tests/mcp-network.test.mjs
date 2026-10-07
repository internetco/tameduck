import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const previousDataDir = process.env.DATA_DIR;
const previousEncryptionKey = process.env.ENCRYPTION_KEY;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tameduck-mcp-network-"));
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
const { db } = await import("../server/store.mjs");
const { validateUrl, guardedFetch, limitBody } = await import(
  "../server/mcp-network.mjs"
);

after(() => {
  db.close();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = previousEncryptionKey;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("validateUrl accepts public HTTPS DNS hostnames on the default port", () => {
  assert.equal(
    validateUrl("https://mcp.example.com/mcp").hostname,
    "mcp.example.com",
  );
  assert.equal(validateUrl("https://mcp.example.com:443/mcp").port, "");
});

test("validateUrl rejects all IP literal forms, including bracketed IPv6", () => {
  for (const value of [
    "https://127.0.0.1/mcp",
    "https://127.1/mcp",
    "https://2130706433/mcp",
    "https://0x7f000001/mcp",
    "https://0177.0.0.1/mcp",
    "https://[::1]/mcp",
    "https://[fd00::1]/mcp",
    "https://[2606:4700:4700::1111]/mcp",
    "https://[::ffff:127.0.0.1]/mcp",
    "https://[::ffff:7f00:1]/mcp",
  ]) {
    assert.throws(
      () => validateUrl(value),
      (error) =>
        error.status === 400 && /public HTTPS hostname/.test(error.message),
    );
  }
});

test("guardedFetch validates a literal before attempting outbound work", async () => {
  await assert.rejects(
    guardedFetch(["[::1]"])("https://[::1]/mcp"),
    (error) =>
      error.status === 400 && /public HTTPS hostname/.test(error.message),
  );
});

test("validateUrl enforces HTTPS, no credentials or fragments, and port 443", () => {
  for (const value of [
    "http://mcp.example.com/mcp",
    "https://user@mcp.example.com/mcp",
    "https://user:password@mcp.example.com/mcp",
    "https://mcp.example.com/mcp#fragment",
    "https://mcp.example.com:8443/mcp",
  ]) {
    assert.throws(
      () => validateUrl(value),
      (error) => error.status === 400,
    );
  }
  assert.equal(
    validateUrl("https://mcp.example.com:443/mcp").hostname,
    "mcp.example.com",
  );
});

// An MCP server somebody added answers with whatever it likes. Every answer
// is held to the limit - JSON, an error page, an event stream - so an endless
// one cannot fill the memory of the process every company shares.
test("limitBody holds every kind of answer to its limit", async () => {
  const kind = (type) => ({ headers: { "content-type": type } });
  let cancelled = false;
  const endless = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(100).fill(120));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    limitBody(new Response(endless, kind("text/html")), 1000),
    /too large/,
  );
  assert.equal(cancelled, true, "and it stops reading");

  const json = await limitBody(
    new Response(JSON.stringify({ ok: true }), {
      status: 201,
      ...kind("application/json"),
    }),
    1000,
  );
  assert.equal(json.status, 201);
  assert.deepEqual(await json.json(), { ok: true });

  const events = (n) =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < n; i++)
            controller.enqueue(new TextEncoder().encode("data: x\n\n"));
          controller.close();
        },
      }),
      kind("text/event-stream"),
    );
  const few = await limitBody(events(3), 1000);
  assert.equal(await few.text(), "data: x\n\n".repeat(3), "a stream stays a stream");
  const many = await limitBody(events(500), 1000);
  await assert.rejects(many.text(), /too large/);

  const empty = new Response(null, { status: 204 });
  assert.equal(await limitBody(empty, 1000), empty);
  await assert.rejects(
    limitBody(new Response("x", { headers: { "content-length": "3000000" } })),
    /too large/,
  );
});
