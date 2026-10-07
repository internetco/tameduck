import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mutateComputerOutputFolder } from "../server/computer-output-folders.mjs";
import {
  scanComputerOutputTree,
  scanComputerOutputs,
} from "../server/computer-file-export.mjs";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duck-folders-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const provider = (home) => async (_p, _m, b) => {
  const r = spawnSync("/bin/bash", ["-c", b.command], {
    encoding: "utf8",
    timeout: 10000,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home },
  });
  return {
    success: r.status === 0 && !r.error,
    exitCode: r.status,
    timedOut: r.error?.code === "ETIMEDOUT",
    stdout: r.stdout,
    stderr: r.stderr,
  };
};
function home(name) {
  const h = path.join(tmp, name);
  fs.mkdirSync(path.join(h, "tameduck", "outputs"), {
    recursive: true,
    mode: 0o700,
  });
  return h;
}
async function op(h, operation, p, target) {
  return mutateComputerOutputFolder({
    request: provider(h),
    boxId: "b",
    operation,
    path: p,
    target,
  });
}
test("creates nested Unicode empty folders, moves files atomically, and deletes only empty folders", async () => {
  if (process.platform !== "linux") return;
  const h = home("one");
  await op(h, "create", "résumé/你好/empty");
  assert.ok(
    fs
      .statSync(path.join(h, "tameduck/outputs/résumé/你好/empty"))
      .isDirectory(),
  );
  fs.writeFileSync(path.join(h, "tameduck/outputs/résumé/你好/file"), "x");
  await op(h, "create", "moved");
  await op(h, "move_file", "résumé/你好/file", "moved/file");
  assert.equal(
    fs.readFileSync(path.join(h, "tameduck/outputs/moved/file"), "utf8"),
    "x",
  );
  await assert.rejects(op(h, "delete", "résumé/你好"), (e) => e.status === 409);
  await op(h, "delete", "résumé/你好/empty");
});
test("rejects traversal, root, symlink, hardlink, descendant, and collisions", async () => {
  const h = home("two");
  await assert.rejects(op(h, "delete", ""), (e) => e.status === 400);
  await assert.rejects(op(h, "create", "../x"), (e) => e.status === 400);
  await op(h, "create", "a");
  await assert.rejects(op(h, "rename", "a", "a/b"), (e) => e.status === 400);
  await op(h, "create", "b");
  await assert.rejects(op(h, "rename", "a", "b"), (e) => e.status === 409);
  fs.symlinkSync(
    path.join(h, "ordinary"),
    path.join(h, "tameduck/outputs/link"),
  );
  await assert.rejects(op(h, "delete", "link"), (e) => e.status === 400);
});

test("create reports whether the directory was new or already present", async () => {
  const h = home("created-flag");
  const fresh = await op(h, "create", "Existing");
  const replay = await op(h, "create", "Existing");
  assert.equal(fresh.created, true);
  assert.equal(replay.created, false);
});

test("deleting an already removed directory is safe and idempotent", async () => {
  const h = home("removed-folder");
  await op(h, "create", "Temporary");
  fs.rmdirSync(path.join(h, "tameduck/outputs/Temporary"));
  const removed = await op(h, "delete", "Temporary");
  assert.equal(removed.already_missing, true);
  const nested = await op(h, "delete", "Missing/Child");
  assert.equal(nested.already_missing, true);
  const outside = path.join(h, "private");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(h, "tameduck/outputs/redirect"));
  await assert.rejects(
    op(h, "delete", "redirect/Missing"),
    (e) => e.status === 400,
  );
});

test("first-use creation registers empty Unicode directories in a complete tree", async () => {
  const h = path.join(tmp, "first-use");
  fs.mkdirSync(h);
  await op(h, "create", "Reports/你好");
  const tree = await scanComputerOutputTree({
    request: provider(h),
    boxId: "first",
  });
  assert.deepEqual(tree.directories.map((d) => d.relative_path).sort(), [
    "",
    "Reports",
    "Reports/你好",
  ]);
  assert.deepEqual(tree.files, []);
  fs.writeFileSync(
    path.join(h, "tameduck/outputs/Reports/report.txt"),
    "saved",
  );
  const next = await scanComputerOutputTree({
    request: provider(h),
    boxId: "first",
  });
  const compatible = await scanComputerOutputs({
    request: provider(h),
    boxId: "first",
  });
  assert.deepEqual(next.files, compatible);
  assert.ok(next.directories.every((d) => d.token.length === 2));
});

test(
  "directory rename preserves subtree bytes and empty-only deletion includes hidden files",
  { skip: process.platform !== "linux" },
  async () => {
    const h = home("subtree");
    await op(h, "create", "Before/empty");
    const root = path.join(h, "tameduck/outputs");
    fs.writeFileSync(path.join(root, "Before/.saved"), "keep me");
    await op(h, "rename", "Before", "After");
    assert.equal(fs.existsSync(path.join(root, "Before")), false);
    assert.equal(
      fs.readFileSync(path.join(root, "After/.saved"), "utf8"),
      "keep me",
    );
    await op(h, "delete", "After/empty");
    await assert.rejects(op(h, "delete", "After"), (e) => e.status === 409);
    assert.equal(
      fs.readFileSync(path.join(root, "After/.saved"), "utf8"),
      "keep me",
    );
  },
);

test(
  "move collisions and hard links preserve source and destination bytes",
  { skip: process.platform !== "linux" },
  async () => {
    const h = home("files");
    const root = path.join(h, "tameduck/outputs");
    fs.writeFileSync(path.join(root, "source"), "source bytes");
    fs.writeFileSync(path.join(root, "target"), "target bytes");
    await assert.rejects(
      op(h, "move_file", "source", "target"),
      (e) => e.status === 409,
    );
    assert.equal(
      fs.readFileSync(path.join(root, "source"), "utf8"),
      "source bytes",
    );
    assert.equal(
      fs.readFileSync(path.join(root, "target"), "utf8"),
      "target bytes",
    );
    fs.linkSync(path.join(root, "source"), path.join(root, "alias"));
    await assert.rejects(
      op(h, "move_file", "source", "moved"),
      (e) => e.status === 400,
    );
    assert.equal(fs.existsSync(path.join(root, "moved")), false);
  },
);

test(
  "intermediate symlinks and FIFOs cannot redirect or block folder operations",
  { skip: process.platform !== "linux" },
  async () => {
    const h = home("links");
    const root = path.join(h, "tameduck/outputs");
    const outside = path.join(h, "private");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, "redirect"));
    await assert.rejects(
      op(h, "create", "redirect/leaked"),
      (e) => e.status === 400,
    );
    assert.equal(fs.existsSync(path.join(outside, "leaked")), false);
    const fifo = path.join(root, "fifo");
    assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
    await assert.rejects(
      op(h, "move_file", "fifo", "moved"),
      (e) => e.status === 400,
    );
    await assert.rejects(
      scanComputerOutputTree({ request: provider(h), boxId: "links" }),
      (e) => e.status === 502,
    );
  },
);

test("guard revocation prevents the command and malformed inventories are refused", async () => {
  let calls = 0;
  await assert.rejects(
    mutateComputerOutputFolder({
      request: async () => {
        calls++;
      },
      boxId: "guard",
      operation: "create",
      path: "New",
      guard: () => {
        throw Object.assign(new Error("revoked"), { status: 403 });
      },
    }),
    (e) => e.status === 403,
  );
  assert.equal(calls, 0);
  const malformed = {
    files: [],
    directories: [{ relative_path: "../private", token: ["1", "2"] }],
    output_directory: "/home/duck/tameduck/outputs",
  };
  await assert.rejects(
    scanComputerOutputTree({
      boxId: "bad",
      request: async () => ({
        success: true,
        exitCode: 0,
        stdout: JSON.stringify(malformed),
      }),
    }),
    (e) => e.status === 502,
  );
  for (const invalid of [
    ".",
    "a//b",
    "a/../b",
    "/absolute",
    "a\\b",
    "x\u0001",
    "你".repeat(100),
  ])
    await assert.rejects(
      op(home("invalid-" + Math.random()), "create", invalid),
      (e) => e.status === 400,
    );
});
