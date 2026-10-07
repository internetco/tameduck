import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createNativeRuntimeSafetyGate } from "../server/runtime-safety.mjs";
import {
  confine,
  verifyConfined,
  runConfinementProbe,
} from "../server/sandbox-network.mjs";
import { createRuntimeStartCoordinator } from "../server/runtime-startup.mjs";

const silent = { log() {}, error() {} };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const unavailable = (error) =>
  error.status === 503 &&
  error.code === "NATIVE_ISOLATION_UNAVAILABLE" &&
  /Native agents are disabled/.test(error.message);

test("one real readiness attempt is shared by pending callers and successful starts", async () => {
  const check = deferred();
  let probes = 0;
  const gate = createNativeRuntimeSafetyGate({
    verify: () => {
      probes++;
      return check.promise;
    },
  });
  const initialization = gate.initialize({ logger: silent });
  assert.equal(
    gate.initialize({ logger: silent, retry: true }),
    initialization,
  );
  const first = gate.ready(),
    second = gate.ready();
  let started = false;
  first.then(() => {
    started = true;
  });
  await tick();
  assert.equal(probes, 1);
  assert.equal(started, false);
  assert.throws(gate.assertReady, unavailable);
  check.resolve({ ok: true });
  assert.deepEqual(await initialization, { ok: true });
  await Promise.all([first, second]);
  gate.assertReady();
  assert.equal(started, true);
  await gate.ready();
  assert.equal(probes, 1);
});
test("failed, malformed and rejected probes remain blocked; retry must verify again", async () => {
  for (const answer of [
    { ok: false, reason: "Firewall missing" },
    undefined,
    { ok: "true" },
    new Error("probe crashed"),
  ]) {
    let probes = 0,
      fixed = false;
    const gate = createNativeRuntimeSafetyGate({
      verify: () => {
        probes++;
        if (fixed) return { ok: true };
        if (answer instanceof Error) throw answer;
        return answer;
      },
    });
    const result = await gate.initialize({ logger: silent });
    assert.equal(result.ok, false);
    await assert.rejects(gate.ready(), unavailable);
    assert.throws(gate.assertReady, unavailable);
    assert.equal(probes, 1);
    fixed = true;
    await assert.rejects(gate.ready(), unavailable);
    assert.equal(probes, 1);
    assert.deepEqual(await gate.initialize({ logger: silent, retry: true }), {
      ok: true,
    });
    await gate.ready();
    assert.equal(probes, 2);
  }
});
test("timeout aborts the probe and late success cannot open the gate", async () => {
  const check = deferred();
  let signal;
  const gate = createNativeRuntimeSafetyGate({
    timeout: 15,
    verify: (options) => {
      signal = options.signal;
      return check.promise;
    },
  });
  const result = await gate.initialize({ logger: silent });
  assert.equal(result.ok, false);
  assert.match(result.reason, /timed out/);
  assert.equal(signal.aborted, true);
  check.resolve({ ok: true });
  await tick();
  await assert.rejects(gate.ready(), unavailable);
});
test("unsupported host networking fails closed even after a successful synthetic probe", async () => {
  const before = process.env.DUCK_SANDBOX_NETWORK;
  process.env.DUCK_SANDBOX_NETWORK = "host";
  try {
    const gate = createNativeRuntimeSafetyGate({
      verify: () => ({ ok: true }),
    });
    const result = await gate.initialize({ logger: silent });
    assert.equal(result.ok, false);
    await assert.rejects(gate.ready(), unavailable);
    assert.throws(() => confine("fake", []), /unsupported/);
    const checked = await verifyConfined({
      spawn() {
        throw new Error("must never spawn");
      },
    });
    assert.equal(checked.ok, false);
    assert.match(checked.reason, /cannot be bypassed/);
  } finally {
    if (before === undefined) delete process.env.DUCK_SANDBOX_NETWORK;
    else process.env.DUCK_SANDBOX_NETWORK = before;
  }
});
test("a host opt-out added after verification still prevents native creation", async () => {
  const gate = createNativeRuntimeSafetyGate({ verify: () => ({ ok: true }) });
  await gate.initialize({ logger: silent });
  gate.assertReady();
  const before = process.env.DUCK_SANDBOX_NETWORK;
  process.env.DUCK_SANDBOX_NETWORK = "host";
  try {
    assert.throws(gate.assertReady, unavailable);
    await assert.rejects(gate.ready(), unavailable);
  } finally {
    if (before === undefined) delete process.env.DUCK_SANDBOX_NETWORK;
    else process.env.DUCK_SANDBOX_NETWORK = before;
  }
});

// Run the real exported class and runtimeFor bodies with synthetic process/FS
// dependencies. This catches a constructor bypass without importing the live
// application database or invoking a provider, cgroup or sandbox executable.
const runtimeSource = fs.readFileSync(
  new URL("../server/runtime.mjs", import.meta.url),
  "utf8",
);
const classStart = runtimeSource.indexOf("export class Runtime {");
const classEnd = runtimeSource.indexOf(
  "// An AI connection belongs",
  classStart,
);
const forStart = runtimeSource.indexOf("export async function runtimeFor(");
const forEnd = runtimeSource.indexOf("// One runtime per duck", forStart);
assert.ok(
  classStart >= 0 &&
    classEnd > classStart &&
    forStart >= 0 &&
    forEnd > forStart,
);
function syntheticChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    return true;
  };
  return child;
}
function runtimeFixture(gate) {
  const starts = [],
    files = [],
    cache = new Map();
  const context = vm.createContext({
    awaitNativeRuntimeSafety: gate.ready,
    assertNativeRuntimeSafety: gate.assertReady,
    workspaceHome: () => "/synthetic/workspace",
    loginHome: () => "/synthetic/login",
    refuseRoot() {},
    fs: {
      mkdirSync: (...args) => files.push(args),
      existsSync: () => false,
      writeFileSync() {},
      renameSync() {},
      rmSync() {},
    },
    path,
    randomUUID: () => "synthetic",
    runtimeConfigToml: "",
    SANDBOX_UID: 123,
    confine: (command, args) => ({ command, args }),
    spawn(command, args) {
      gate.assertReady();
      starts.push({ command, args });
      return syntheticChild();
    },
    createInterface: () => new EventEmitter(),
    instances: cache,
    startRuntime: createRuntimeStartCoordinator(cache),
    fail: (_status, message) => {
      throw new Error(message);
    },
    subscriptionName: "subscription",
    gone: (message) => new Error(message),
    console,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(
    runtimeSource
      .slice(classStart, classEnd)
      .replace("export class Runtime", "class Runtime") +
      runtimeSource
        .slice(forStart, forEnd)
        .replace("export async function", "async function") +
      "\nglobalThis.Runtime = Runtime; globalThis.runtimeFor = runtimeFor;",
    context,
  );
  // Model the initialize response while retaining the actual constructor and
  // private startup method, including both readiness checks and spawn call.
  context.Runtime.prototype.request = async function () {
    assert.ok(this.process);
    return {};
  };
  return {
    Runtime: context.Runtime,
    runtimeFor: context.runtimeFor,
    starts,
    files,
  };
}
test("direct Runtime and runtimeFor await the same pending check before any filesystem/native spawn", async () => {
  const check = deferred();
  let probes = 0;
  const gate = createNativeRuntimeSafetyGate({
    verify: () => {
      probes++;
      return check.promise;
    },
  });
  gate.initialize({ logger: silent });
  const f = runtimeFixture(gate),
    direct = new f.Runtime("owner-a");
  const fromApi = f.runtimeFor("owner-b", "duck-b");
  await tick();
  assert.equal(probes, 1);
  assert.equal(f.starts.length, 0);
  assert.equal(f.files.length, 0);
  check.resolve({ ok: true });
  await Promise.all([direct.ready, fromApi]);
  assert.equal(f.starts.length, 2);
});
test("direct Runtime and runtimeFor reject failed checks without spawning", async () => {
  for (const verify of [
    () => ({ ok: false, reason: "Not confined" }),
    () => {
      throw new Error("Probe rejected");
    },
    () => new Promise(() => {}),
  ]) {
    const gate = createNativeRuntimeSafetyGate({ verify, timeout: 10 });
    gate.initialize({ logger: silent });
    const f = runtimeFixture(gate),
      direct = new f.Runtime("owner");
    await Promise.all([
      assert.rejects(direct.ready, unavailable),
      assert.rejects(f.runtimeFor("owner"), unavailable),
    ]);
    assert.equal(f.starts.length, 0);
    assert.equal(f.files.length, 0);
    direct.close();
  }
});
test("closing a pending direct Runtime prevents a spawn after the probe succeeds", async () => {
  const check = deferred(),
    gate = createNativeRuntimeSafetyGate({ verify: () => check.promise });
  gate.initialize({ logger: silent });
  const f = runtimeFixture(gate),
    direct = new f.Runtime("owner");
  direct.close();
  check.resolve({ ok: true });
  await assert.rejects(direct.ready, /closed before initialization/);
  assert.equal(f.starts.length, 0);
});

test("probe completion clears its deadline and does not later kill the child", async () => {
  const child = syntheticChild();
  const probe = runConfinementProbe({
    spawn: () => child,
    command: "fake",
    args: [],
    timeoutMs: 10,
  });
  child.stdout.write("refused\n");
  child.emit("close", 0);
  assert.deepEqual(await probe, { out: "refused", err: "", code: 0 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(child.kills, []);
});
test("probe timeout/abort force-kills and cannot be converted to success by close", async () => {
  for (const abort of [false, true]) {
    const child = syntheticChild();
    child.kill = (signal) => {
      child.kills.push(signal);
      child.emit("close", 0);
      return true;
    };
    const controller = new AbortController();
    const probe = runConfinementProbe({
      spawn: () => child,
      command: "fake",
      args: [],
      signal: controller.signal,
      timeoutMs: 10,
    });
    child.stdout.write("refused\n");
    if (abort) controller.abort();
    const result = await probe;
    assert.equal(result.code, null);
    assert.equal(result.out, abort ? "cancelled" : "timeout");
    assert.deepEqual(child.kills, ["SIGKILL"]);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
  }
});
test("probe synchronous spawn errors and emitted process errors settle failure", async () => {
  const result = await runConfinementProbe({
    spawn() {
      throw new Error("No executable");
    },
    command: "fake",
    args: [],
  });
  assert.equal(result.code, null);
  assert.equal(result.out, "error");
  const child = syntheticChild(),
    probe = runConfinementProbe({
      spawn: () => child,
      command: "fake",
      args: [],
    });
  child.emit("error", new Error("Spawn failed"));
  assert.equal((await probe).out, "error");
  assert.deepEqual(child.kills, ["SIGKILL"]);
});

test("an asynchronously rejected confinement probe keeps native agents disabled", async () => {
  const gate = createNativeRuntimeSafetyGate({
    verify: () => Promise.reject(new Error("asynchronous probe failure")),
  });
  const result = await gate.initialize({ logger: silent });
  assert.equal(result.ok, false);
  assert.match(result.reason, /asynchronous probe failure/);
  await assert.rejects(gate.ready(), unavailable);
});

test("a verifier claiming synchronous success on abort cannot beat the timeout gate", async () => {
  const gate = createNativeRuntimeSafetyGate({
    timeout: 10,
    verify: ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ ok: true }), {
          once: true,
        });
      }),
  });
  const result = await gate.initialize({ logger: silent });
  assert.equal(result.ok, false);
  assert.match(result.reason, /timed out/);
  await assert.rejects(gate.ready(), unavailable);
  assert.throws(gate.assertReady, unavailable);
});
