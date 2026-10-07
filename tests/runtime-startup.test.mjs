import { test } from "node:test";
import assert from "node:assert/strict";
import { createRuntimeStartCoordinator } from "../server/runtime-startup.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("one owner's cold runtimes initialize in order but their ready instances stay separate", async () => {
  const cache = new Map(), start = createRuntimeStartCoordinator(cache);
  const first = deferred(), second = deferred(), created = [];
  const a = start("owner", "duck-a", () => {
    created.push("a");
    return { ready: first.promise };
  });
  const b = start("owner", "duck-b", () => {
    created.push("b");
    return { ready: second.promise };
  });
  await tick();
  assert.deepEqual(created, ["a"]);
  first.resolve();
  const readyA = await a;
  await tick();
  assert.deepEqual(created, ["a", "b"]);
  second.resolve();
  const readyB = await b;
  assert.notEqual(readyA, readyB);
  assert.equal(cache.size, 2);
});

test("different owners can initialize concurrently", async () => {
  const start = createRuntimeStartCoordinator(new Map());
  const first = deferred(), second = deferred(), created = [];
  const a = start("owner-a", "duck-a", () => {
    created.push("a");
    return { ready: first.promise };
  });
  const b = start("owner-b", "duck-b", () => {
    created.push("b");
    return { ready: second.promise };
  });
  await tick();
  assert.deepEqual(created, ["a", "b"]);
  first.resolve();
  second.resolve();
  await Promise.all([a, b]);
});

test("a cached initializing runtime is reused without another startup", async () => {
  const cache = new Map(), start = createRuntimeStartCoordinator(cache);
  const pending = deferred();
  let created = 0;
  const a = start("owner", "same-duck", () => {
    created++;
    return { ready: pending.promise };
  });
  await tick();
  const b = start("owner", "same-duck", () => {
    created++;
    throw new Error("duplicate startup");
  });
  assert.equal(created, 1);
  pending.resolve();
  assert.equal(await a, await b);
  assert.equal(created, 1);
});

test("failed startup is closed, evicted, and releases the next owner startup", async () => {
  const cache = new Map(), start = createRuntimeStartCoordinator(cache);
  const first = deferred(), second = deferred(), created = [], closed = [];
  const a = start("owner", "duck-a", () => {
    created.push("a");
    return { ready: first.promise, close: () => closed.push("a") };
  });
  const b = start("owner", "duck-b", () => {
    created.push("b");
    return { ready: second.promise };
  });
  await tick();
  first.reject(new Error("initialize failed"));
  await assert.rejects(a, /initialize failed/);
  await tick();
  assert.deepEqual(created, ["a", "b"]);
  assert.deepEqual(closed, ["a"]);
  assert.equal(cache.has("duck-a"), false);
  second.resolve();
  await b;
  const retry = start("owner", "duck-a", () => {
    created.push("a-retry");
    return { ready: Promise.resolve() };
  });
  await retry;
  assert.equal(cache.has("duck-a"), true);
});
