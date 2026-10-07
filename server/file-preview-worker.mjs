import { parentPort, workerData } from "node:worker_threads";
import { parsePreview, previewFailure } from "./file-preview.mjs";
try {
  parentPort.postMessage({
    ok: true,
    value: parsePreview(Buffer.from(workerData.buffer), workerData.item),
  });
} catch (error) {
  const safe = previewFailure(error);
  parentPort.postMessage({
    ok: false,
    message: safe.message,
    status: safe.status,
  });
}
