// What a duck's brain may reach on the network. See docs/duck-isolation.md.
//
// The sandbox shares this machine's network stack, so everything listening on
// loopback was an address a duck could dial, and the Nginx allowlist never saw
// that traffic because it never went through Nginx. A duck's brain has no
// business reaching this machine at all: it talks to the application over the
// stdin/stdout channel it was started with, it listens on nothing, and the only
// thing it needs the network for is the model provider.
//
// The fix is a firewall rule rather than a private network. Giving the sandbox
// its own network namespace is the obvious approach and it does not work here:
// attaching user-mode networking to that namespace needs CAP_SYS_ADMIN inside
// the namespace's own user namespace, which this service - correctly - does not
// have. The alternative that does work unprivileged, pasta, splices connections
// to the host's loopback on purpose, which is the thing being prevented.
//
// So every duck sandbox is placed in one cgroup, and a rule installed at deploy
// time refuses traffic from that cgroup to this machine. The sandbox keeps
// ordinary outbound internet, which is what the provider needs, and the rule is
// enforced by the kernel rather than by anything the sandbox could talk its way
// past.
//
// Placing the process is race-free because the process places itself: the child
// writes its own pid into the cgroup and only then execs bwrap, so it is subject
// to the rule before any sandbox exists, let alone any model call.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
const ROOT = "/sys/fs/cgroup";
// Host networking opt-out is rejected. This predicate records unsupported
// configuration so both preparation and the readiness gate can fail closed.
export const isolated = () => process.env.DUCK_SANDBOX_NETWORK !== "host";
// The single cgroup every duck sandbox is placed in. The deploy-time rule names
// the same path; they have to agree, so both read it from here.
export const CGROUP_NAME = "ducks";
// Reads this process's own cgroup, which is where we are allowed to make one.
// systemd hands the service its cgroup subtree only with Delegate=yes in the
// unit; without that, creating a child cgroup fails and so does every duck.
export function ownCgroup() {
  const line = fs
    .readFileSync("/proc/self/cgroup", "utf8")
    .split("\n")
    .find((l) => l.startsWith("0::"));
  return line ? line.slice(3).trim() : null;
}
export const cgroupDir = () => {
  const own = ownCgroup();
  return own ? path.join(ROOT, own.replace(/^\//, ""), CGROUP_NAME) : null;
};
// The path as a firewall rule spells it: relative to the cgroup root, no
// leading slash. deploy/duck-sandbox.nft is generated from this.
export const cgroupMatch = () => {
  const dir = cgroupDir();
  return dir ? dir.slice(ROOT.length + 1) : null;
};
let prepared = null;
export function prepareCgroup() {
  if (!isolated())
    throw new Error(
      "DUCK_SANDBOX_NETWORK=host is unsupported; native isolation cannot be bypassed.",
    );
  if (prepared) return prepared;
  const dir = cgroupDir();
  if (!dir)
    throw new Error(
      "Cannot find this service's cgroup, so a duck's sandbox cannot be confined.",
    );
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw new Error(
      "Cannot create the duck sandbox cgroup at " +
        dir +
        " (" +
        e.code +
        "). The service needs Delegate=yes in its unit.",
    );
  }
  // No memory or pid ceiling is set here. Writing one would need the memory and
  // pids controllers enabled for this cgroup's children, and enabling them means
  // first moving the application's own processes into a leaf of their own,
  // because a cgroup cannot both hold processes and delegate controllers. The
  // unit already carries MemoryMax and TasksMax, which cover the service and
  // every sandbox under it, so the cost of that rearrangement buys only a finer
  // split of a limit that already exists. Left out on purpose rather than
  // written and silently ignored.
  prepared = dir;
  return dir;
}
// Turns the bwrap command into one that confines itself first. /bin/sh writes
// its own pid into the cgroup, then becomes bwrap - so the exec'd sandbox is
// already inside it and there is no window where it is not.
export function confine(command, args) {
  if (!isolated())
    throw new Error(
      "DUCK_SANDBOX_NETWORK=host is unsupported; native isolation cannot be bypassed.",
    );
  const dir = prepareCgroup();
  const quoted = [command, ...args]
    .map((a) => "'" + String(a).replaceAll("'", "'\\''") + "'")
    .join(" ");
  return {
    command: "/bin/sh",
    args: ["-c", 'echo $$ > "$0"/cgroup.procs || exit 97\nexec ' + quoted, dir],
  };
}
// Proves the rule is actually in force, rather than trusting that a deploy
// installed it. Runs one connection from inside the cgroup to a socket this
// process opens on loopback: if it arrives, ducks are not confined and the
// caller is told so in terms an operator can act on.
//
// A firewall rule that quietly stopped being applied would otherwise look
// exactly like a working one.
export async function verifyConfined({ spawn, signal }) {
  if (!isolated())
    return {
      ok: false,
      reason:
        "DUCK_SANDBOX_NETWORK=host is unsupported; native isolation cannot be bypassed.",
    };
  if (signal?.aborted)
    return { ok: false, reason: "The isolation check was cancelled." };
  const server = net.createServer((socket) => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        server.off("error", failed);
        server.off("listening", listening);
        signal?.removeEventListener("abort", aborted);
      };
      const failed = (error) => {
        cleanup();
        reject(error);
      };
      const listening = () => {
        cleanup();
        resolve();
      };
      const aborted = () => {
        cleanup();
        reject(new Error("The isolation check was cancelled."));
      };
      server.once("error", failed);
      server.once("listening", listening);
      signal?.addEventListener("abort", aborted, { once: true });
      server.listen(0, "127.0.0.1");
    });
    if (signal?.aborted)
      return { ok: false, reason: "The isolation check was cancelled." };
    const port = server.address().port;
    // node rather than a shell one-liner: /bin/sh here is dash, which has no
    // /dev/tcp, and an empty answer from a probe that could not run reads the
    // same as a probe that was blocked.
    const { command, args } = confine(process.execPath, [
      "-e",
      `const say=w=>{console.log(w);process.exit(0);};` +
        `const s=require("net").connect(${port},"127.0.0.1");` +
        `s.on("connect",()=>say("REACHED"));` +
        `s.on("error",()=>say("refused"));` +
        `setTimeout(()=>say("timeout"),5000);`,
    ]);
    const { out, err, code } = await runConfinementProbe({
      spawn,
      command,
      args,
      signal,
    });
    if (signal?.aborted)
      return { ok: false, reason: "The isolation check was cancelled." };
    if (out === "refused" && code === 0) return { ok: true };
    if (out === "REACHED")
      return {
        ok: false,
        reason:
          "A duck sandbox can still reach this machine. The rule in deploy/duck-sandbox.nft is not loaded.",
      };
    // Anything else means the check did not work, which is not the same as a
    // duck being loose - so say which it is, with enough to act on.
    return {
      ok: false,
      reason:
        "Could not confirm duck sandbox confinement" +
        (code === 97 ? "; the sandbox cgroup could not be joined" : "") +
        (code !== null && code !== 97 ? "; the check exited " + code : "") +
        (err ? ": " + err.slice(0, 300) : "."),
    };
  } finally {
    // close also cancels a pending listen after abort; accepted sockets were
    // destroyed immediately, so none can keep the listener alive.
    server.close(() => {});
  }
}

// Separate resource management is portable to test with synthetic children;
// successful probe text alone is not a readiness permit.
export function runConfinementProbe({
  spawn,
  command,
  args,
  signal,
  timeoutMs = 10000,
}) {
  return new Promise((resolve) => {
    let child,
      timer,
      settled = false,
      text = "",
      errors = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      resolve(result);
    };
    const stop = (reason) => {
      // Settle failure before killing: a synchronous/late close event must not
      // turn an expired or cancelled probe into success.
      finish({ out: reason, err: errors.trim(), code: null });
      try {
        child?.kill("SIGKILL");
      } catch {}
      child?.stdout?.destroy?.();
      child?.stderr?.destroy?.();
    };
    const aborted = () => stop("cancelled");
    if (signal?.aborted)
      return finish({ out: "cancelled", err: "", code: null });
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (chunk) => {
        text = (text + chunk.toString()).slice(-1000);
      });
      child.stderr.on("data", (chunk) => {
        errors = (errors + chunk.toString()).slice(-1000);
      });
      child.on("error", (error) => {
        errors = String(error.message).slice(-1000);
        stop("error");
      });
      // close waits for the process and its output pipes, unlike exit.
      child.on("close", (code) =>
        finish({ out: text.trim(), err: errors.trim(), code }),
      );
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) return aborted();
      timer = setTimeout(() => stop("timeout"), timeoutMs);
    } catch (error) {
      errors = String(error.message).slice(-1000);
      stop("error");
    }
  });
}
