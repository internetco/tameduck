// A port for a check's own server. The runner (tests/run-checks.mjs) hands
// one out in CHECK_PORT; run by hand, the system picks a free one. Checks used
// to carry fixed numbers, and two of them both used 3033: when they ran at the
// same time, the second one's browser reached the first one's server and
// failed in a way that looked like a real bug.
import net from "node:net";
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer().on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(String(port)));
    });
  });
}
