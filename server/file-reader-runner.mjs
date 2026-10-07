import { Worker } from "node:worker_threads";

// A duck reads a file in a worker, the way a preview is made. The file is
// somebody's input, and pdftotext and Pillow run synchronously: on the main
// thread one file could stall every company's requests. A read that runs out of
// time or memory is stopped and answered with a reason, not waited for. Reads
// beyond the running ones wait their turn rather than fail.
const MAX_CONCURRENT = 2;
const MAX_WAITING = 50;
const TIMEOUT = 30000;
let active = 0;
const waiting = [];

export async function readForAIIsolated(
  upload,
  buffer,
  format,
  offset = 0,
  { timeout = TIMEOUT } = {},
) {
  if (active < MAX_CONCURRENT) active++;
  else if (waiting.length >= MAX_WAITING)
    return {
      error:
        "Files are being read for many ducks at once. Try again in a moment.",
    };
  // A finished read hands its place straight to the next one waiting.
  else await new Promise((resolve) => waiting.push(resolve));
  try {
    return await readInWorker(upload, buffer, format, offset, timeout);
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

function readInWorker(upload, buffer, format, offset, timeout) {
  const name = String(upload?.name || "This file");
  const unreadable = {
    error: `${name} couldn't be opened. It may be damaged or too large to read. Try exporting it again.`,
  };
  return new Promise((resolve) => {
    let settled = false,
      worker,
      timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The next read starts only after this parser has really stopped.
      Promise.resolve(worker?.terminate())
        .catch(() => {})
        .finally(() => resolve(result));
    };
    try {
      worker = new Worker(new URL("./file-reader-worker.mjs", import.meta.url), {
        execArgv: [],
        workerData: { upload, buffer, format, offset },
        resourceLimits: {
          maxOldGenerationSizeMb: 512,
          maxYoungGenerationSizeMb: 64,
        },
      });
      timer = setTimeout(
        () =>
          finish({
            error: `${name} took too long to read. Share a smaller file, or paste the part that matters.`,
          }),
        timeout,
      );
      worker.once("message", (result) =>
        finish(result && typeof result === "object" ? result : unreadable),
      );
      worker.once("error", () => finish(unreadable));
      worker.once("exit", () => finish(unreadable));
    } catch {
      finish(unreadable);
    }
  });
}
