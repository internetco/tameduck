import fs from "node:fs";
import { performance } from "node:perf_hooks";

const MODEL_PATH = new URL("./models/cursor/model.onnx", import.meta.url);
const MAX_POINTS = 24;
const MAX_SCREEN = 10000;
const MIN_MODEL_SCALE = 64;

const pair = (v) =>
  Array.isArray(v) && v.length === 2 && v.every(Number.isFinite);
function validRequest(r) {
  return (
    r &&
    pair(r.start) &&
    pair(r.end) &&
    pair(r.screen) &&
    r.screen.every((n) => Number.isInteger(n) && n > 1 && n <= MAX_SCREEN) &&
    [r.start, r.end].every((p) => p.every((n, i) => n >= 0 && n < r.screen[i]))
  );
}

async function loadModel() {
  if (process.env.CURSOR_TRAJECTORY_DISABLE === "1")
    throw Error("cursor model disabled");
  // Import lazily: a missing native binding must not prevent the app starting.
  const ort = await import("onnxruntime-node");
  const session = await ort.InferenceSession.create(
    fs.readFileSync(MODEL_PATH),
    {
      executionProviders: ["cpu"],
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
    },
  );
  return async (values) => {
    const tensor = new ort.Tensor(
      "float32",
      Float32Array.from(values),
      [1, 2, 2],
    );
    const output = await session.run({ [session.inputNames[0]]: tensor });
    return output[session.outputNames[0]]?.data;
  };
}

// Port of the upstream API's normalization, interpolation and endpoint
// correction. Timing and actual input remain in our existing guest driver.
function correctedPath(predictions, randomizedStart, start, end, screen) {
  const generated = [randomizedStart, ...predictions];
  const first = generated[0],
    last = generated.at(-1);
  const points = Array.from({ length: MAX_POINTS }, (_, i) => {
    const t = i / (MAX_POINTS - 1),
      index = t * (generated.length - 1),
      left = Math.floor(index);
    const right = Math.min(left + 1, generated.length - 1),
      fraction = index - left;
    return [0, 1].map((axis) => {
      const value =
        generated[left][axis] +
        fraction * (generated[right][axis] - generated[left][axis]) +
        (start[axis] - first[axis]) * (1 - t) +
        (end[axis] - last[axis]) * t;
      return Math.max(0, Math.min(screen[axis] - 1, Math.round(value)));
    });
  });
  points[0] = start.slice();
  points[points.length - 1] = end.slice();
  const distance = Math.hypot(end[0] - start[0], end[1] - start[1]);
  const length = points
    .slice(1)
    .reduce(
      (n, p, i) => n + Math.hypot(p[0] - points[i][0], p[1] - points[i][1]),
      0,
    );
  if (!points.every(pair) || length > Math.max(16, distance * 3))
    throw Error("invalid cursor path");
  return points;
}

// Injectable loader and short deadlines let tests prove hung inference never
// starts unbounded parallel work. Production creates exactly one instance.
export function createCursorTrajectoryGenerator({
  load = loadModel,
  random = Math.random,
  coldTimeoutMs = 2000,
  inferenceTimeoutMs = 180,
  queueTimeoutMs = 500,
  maxQueue = 64,
} = {}) {
  let sessionPromise,
    running = false;
  const pending = [];
  const counts = { sessionLoads: 0, completed: 0, unavailable: 0 };
  const stats = () => ({
    ...counts,
    active: running ? 1 : 0,
    queued: pending.length,
  });
  const session = () => {
    if (!sessionPromise) {
      counts.sessionLoads++;
      sessionPromise = Promise.resolve().then(load);
    }
    return sessionPromise;
  };
  async function infer(request) {
    const predict = await session();
    const jitter = () => (random() * 2 - 1) * 1.5;
    const start = request.start.map((n) => n + jitter()),
      end = request.end.map((n) => n + jitter());
    const distance = Math.hypot(
      request.end[0] - request.start[0],
      request.end[1] - request.start[1],
    );
    // Use a stable local coordinate range so curvature scales with the move,
    // not with the pointer's absolute position on the screen.
    const modelScale = Math.max(MIN_MODEL_SCALE, distance * 2);
    // Keep both endpoints positive even when the requested move is left/up.
    const modelOrigin = request.end.map((value, axis) =>
      value < request.start[axis] ? 0.75 : 0.25,
    );
    const modelStart = modelOrigin.map(
      (origin, axis) =>
        origin + (start[axis] - request.start[axis]) / modelScale,
    );
    const modelEnd = modelOrigin.map(
      (origin, axis) => origin + (end[axis] - request.start[axis]) / modelScale,
    );
    const values = await predict([...modelStart, ...modelEnd]);
    if (
      !values ||
      values.length < 2 ||
      values.length > 2000 ||
      values.length % 2 ||
      !Array.from(values).every(Number.isFinite)
    )
      throw Error("invalid cursor model output");
    const predictions = [];
    for (let i = 0; i < values.length; i += 2)
      predictions.push(
        modelOrigin.map(
          (origin, axis) =>
            request.start[axis] + (values[i + axis] - origin) * modelScale,
        ),
      );
    if (distance === 0)
      return Array.from({ length: MAX_POINTS }, () => request.start.slice());
    return correctedPath(
      predictions,
      start,
      request.start,
      request.end,
      request.screen,
    );
  }
  function pump() {
    if (running || !pending.length) return;
    const job = pending.shift();
    clearTimeout(job.waitTimer);
    running = true;
    let responded = false;
    const finish = (points) => {
      if (responded) return;
      responded = true;
      if (points) {
        counts.completed++;
        job.resolve({
          points,
          generator: "onnx",
          generationMs: performance.now() - job.enqueued,
        });
      } else {
        counts.unavailable++;
        job.resolve(null);
      }
    };
    const timeout = setTimeout(
      () => finish(null),
      sessionPromise ? inferenceTimeoutMs : coldTimeoutMs,
    );
    infer(job.request)
      .then(
        (points) => finish(points),
        () => finish(null),
      )
      .finally(() => {
        clearTimeout(timeout);
        // Keep the slot until native work actually settles, even if its caller
        // already received an unavailable result. Otherwise each timeout could
        // start another native run.
        running = false;
        pump();
      });
  }
  async function generate(request) {
    if (!validRequest(request) || pending.length >= maxQueue) {
      counts.unavailable++;
      return null;
    }
    const result = new Promise((resolve) => {
      const job = {
        request: {
          start: [...request.start],
          end: [...request.end],
          screen: [...request.screen],
        },
        resolve,
        enqueued: performance.now(),
      };
      job.waitTimer = setTimeout(() => {
        const index = pending.indexOf(job);
        if (index < 0) return;
        pending.splice(index, 1);
        counts.unavailable++;
        resolve(null);
      }, queueTimeoutMs);
      pending.push(job);
    });
    pump();
    return result;
  }
  return { generate, stats };
}
const shared = createCursorTrajectoryGenerator();
export const generateCursorTrajectory = (request) => shared.generate(request);
export const cursorTrajectoryStats = () => shared.stats();
