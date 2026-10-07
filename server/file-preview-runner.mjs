import { Worker } from "node:worker_threads";
import { PREVIEW_LIMITS, PreviewError } from "../shared/file-preview.mjs";

const MAX_CONCURRENT = 2;
let active = 0;
export function previewRunnerFailure(error) {
  return error instanceof PreviewError
    ? error
    : new PreviewError(
        "This file could not be previewed. Download it to open it.",
      );
}
export function parsePreviewIsolated(buffer, item) {
  if (!Buffer.isBuffer(buffer) || buffer.length > PREVIEW_LIMITS.bytes)
    return Promise.reject(
      new PreviewError(
        "This file is too large to preview. Download it to open it.",
        413,
      ),
    );
  if (active >= MAX_CONCURRENT)
    return Promise.reject(
      new PreviewError(
        "The preview service is busy. Close the preview and try again shortly.",
        503,
      ),
    );
  active++;
  const safeItem = {
    name: String(item?.name || "").slice(0, 1024),
    mime: String(item?.mime || "").slice(0, 200),
  };
  return new Promise((resolve, reject) => {
    let settled = false,
      worker,
      timer;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Release the slot only after the parser has stopped, including failures.
      Promise.resolve(worker?.terminate())
        .catch(() => {})
        .finally(() => {
          active--;
          fn(value);
        });
    };
    try {
      worker = new Worker(
        new URL("./file-preview-worker.mjs", import.meta.url),
        {
          execArgv: [],
          workerData: { buffer, item: safeItem },
          resourceLimits: {
            maxOldGenerationSizeMb: 128,
            maxYoungGenerationSizeMb: 32,
          },
        },
      );
      timer = setTimeout(
        () =>
          finish(
            reject,
            new PreviewError(
              "This file took too long to preview. Download it to open it.",
            ),
          ),
        PREVIEW_LIMITS.timeout,
      );
      worker.once("message", (message) => {
        if (message?.ok) finish(resolve, message.value);
        else
          finish(
            reject,
            new PreviewError(
              String(message?.message || "This file could not be previewed."),
              [413, 415, 422].includes(message?.status) ? message.status : 422,
            ),
          );
      });
      worker.once("error", () =>
        finish(
          reject,
          new PreviewError(
            "This file could not be previewed. Download it to open it.",
          ),
        ),
      );
      worker.once("exit", () =>
        finish(
          reject,
          new PreviewError(
            "This file could not be previewed. Download it to open it.",
          ),
        ),
      );
    } catch {
      finish(
        reject,
        new PreviewError(
          "The preview service is unavailable. Try again shortly.",
          503,
        ),
      );
    }
  });
}
