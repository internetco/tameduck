import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
test("local setup creates unique private configuration and never overwrites it", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tameduck-setup-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.copyFile(path.join(root, ".env.example"), path.join(dir, ".env.example"));
  const script = path.join(root, "scripts/setup-community.mjs");
  const run = () => spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8" });
  const first = run();
  assert.equal(first.status, 0);
  const content = await fs.readFile(path.join(dir, ".env"), "utf8");
  assert.match(content, /^ENCRYPTION_KEY=[a-f0-9]{64}$/m);
  assert.match(content, /^SETUP_TOKEN_HASH=[a-f0-9]{64}$/m);
  assert.match(first.stdout, /http:\/\/localhost:3000\/setup#[A-Za-z0-9_-]+/);
  if (process.platform !== "win32")
    assert.equal((await fs.stat(path.join(dir, ".env"))).mode & 0o777, 0o600);
  assert.equal(run().status, 1);
  assert.equal(await fs.readFile(path.join(dir, ".env"), "utf8"), content);
});
