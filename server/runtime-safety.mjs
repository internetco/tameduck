// Native processes are unavailable until the real network confinement probe
// succeeds. API-key providers do not depend on this gate.
import { spawn } from "node:child_process";
import { isolated, verifyConfined } from "./sandbox-network.mjs";

const timeoutMs = 15000;
export class NativeRuntimeUnavailableError extends Error {
  constructor(reason) {
    super(
      "Native agents are disabled because sandbox network isolation has not been verified. " +
        reason +
        " An administrator must repair the Linux cgroup/firewall configuration and restart TameDuck or retry verification. API-key providers remain available.",
    );
    this.name = "NativeRuntimeUnavailableError";
    this.code = "NATIVE_ISOLATION_UNAVAILABLE";
    this.status = 503;
    this.unavailable = true;
  }
}

// Each factory result owns independent state. Only the module-private singleton
// below is used by Runtime; callers cannot inject a probe or permit into it.
export function createNativeRuntimeSafetyGate({ verify, timeout = timeoutMs }) {
  let pending = null;
  let state = "unchecked";
  let result = { ok: false, reason: "The isolation check has not completed." };
  function initialize({ logger = console, retry = false } = {}) {
    if (pending) return pending;
    if (state !== "unchecked" && !retry) return Promise.resolve(result);
    state = "checking";
    const controller = new AbortController();
    pending = (async () => {
      let timer;
      try {
        const expired = new Promise((resolve) => {
          timer = setTimeout(() => {
            // Settle expiry first: an abort listener may synchronously claim
            // success, which must never turn this deadline into a permit.
            resolve({ ok: false, reason: "The isolation check timed out." });
            controller.abort();
          }, timeout);
        });
        const checked = await Promise.race([
          Promise.resolve().then(() => verify({ signal: controller.signal })),
          expired,
        ]);
        result =
          checked?.ok === true && !controller.signal.aborted && isolated()
            ? { ok: true }
            : {
                ok: false,
                reason: !isolated()
                  ? "DUCK_SANDBOX_NETWORK=host is unsupported; native isolation cannot be bypassed."
                  : controller.signal.aborted
                    ? "The isolation check timed out."
                    : String(
                        checked?.reason ||
                          "The isolation check did not confirm confinement.",
                      ),
              };
      } catch (error) {
        result = {
          ok: false,
          reason:
            "The isolation check failed: " + String(error?.message || error),
        };
      } finally {
        clearTimeout(timer);
      }
      state = result.ok ? "ready" : "blocked";
      // Diagnostics must never turn failed checks into a successful gate or
      // prevent the web app from starting if an operator's logger fails.
      try {
        logger?.[result.ok ? "log" : "error"]?.(
          result.ok
            ? "Native sandbox isolation verified."
            : new NativeRuntimeUnavailableError(result.reason).message,
        );
      } catch {}
      pending = null;
      return result;
    })();
    return pending;
  }
  function assertReady() {
    if (state !== "ready" || !isolated()) {
      throw new NativeRuntimeUnavailableError(
        !isolated()
          ? "DUCK_SANDBOX_NETWORK=host is unsupported; native isolation cannot be bypassed."
          : state === "checking"
            ? "The isolation check is still running."
            : result.reason,
      );
    }
  }
  async function ready() {
    await initialize();
    assertReady();
  }
  return Object.freeze({ initialize, ready, assertReady });
}
const nativeSafety = createNativeRuntimeSafetyGate({
  verify: ({ signal }) => verifyConfined({ spawn, signal }),
});
export const initializeNativeRuntimeSafety = (options) =>
  nativeSafety.initialize(options);
export const awaitNativeRuntimeSafety = () => nativeSafety.ready();
export const assertNativeRuntimeSafety = () => nativeSafety.assertReady();
