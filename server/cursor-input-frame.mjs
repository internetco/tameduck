import { requiresCursorTrajectory } from "./cursor-trajectory-bridge.mjs";

// Only images returned to the Duck count. Viewer, preview, and probe captures
// never call observeDeliveredImage.
const latestByJob = new Map();
const MAX_OBSERVATIONS = 512;
const keyFor = (computerId, jobId) => `${computerId}:${jobId}`;
const hasImage = (content) =>
  content?.some((item) => item.type === "image" && !!item.data);

const nativeTarget = (target) => {
  if (target?.scope === "desktop") return { scope: "desktop" };
  if (
    target?.scope === "window" &&
    Number.isSafeInteger(target.pid) &&
    target.pid > 0 &&
    Number.isSafeInteger(target.window_id) &&
    target.window_id > 0
  )
    return { scope: "window", pid: target.pid, window_id: target.window_id };
  return null;
};

export function observeDeliveredImage(
  computerId,
  jobId,
  result,
  { tool, target, cropped = false } = {},
) {
  if (!hasImage(result?.content)) return;
  // A crop or browser/zoom image has no full native coordinate frame, even
  // when a provider supplies native_input_target metadata alongside it.
  const fallbackTarget =
    tool === "get_desktop_state"
      ? { scope: "desktop" }
      : tool === "get_window_state"
        ? {
            scope: "window",
            pid: result.structuredContent?.pid,
            window_id: result.structuredContent?.window_id,
          }
        : null;
  const native =
    !cropped && !["zoom", "get_browser_state"].includes(tool)
      ? nativeTarget(
          target ||
            result.structuredContent?.native_input_target ||
            fallbackTarget,
        )
      : null;
  const key = keyFor(computerId, jobId);
  latestByJob.delete(key);
  latestByJob.set(key, native || { scope: "unknown" });
  while (latestByJob.size > MAX_OBSERVATIONS)
    latestByJob.delete(latestByJob.keys().next().value);
}

export function cursorInputFrameRefusal(computerId, jobId, tool, args) {
  if (!requiresCursorTrajectory(tool, args)) return null;
  const observed = latestByJob.get(keyFor(computerId, jobId));
  if (!observed) return null;
  const windowTarget =
    args.target?.kind === "window" ||
    args.pid !== undefined ||
    args.window_id !== undefined;
  const intended = nativeTarget({
    scope: args.scope || (windowTarget ? "window" : "desktop"),
    pid: args.pid ?? args.target?.pid,
    window_id: args.window_id ?? args.target?.window_id,
  });
  if (
    intended &&
    observed.scope === intended.scope &&
    (intended.scope === "desktop" ||
      (observed.pid === intended.pid &&
        observed.window_id === intended.window_id))
  )
    return null;
  const observedText =
    observed.scope === "window"
      ? `window pid=${observed.pid}, window_id=${observed.window_id}`
      : observed.scope === "desktop"
        ? "desktop"
        : "a cropped, zoom, or browser image without native input coordinates";
  const requiredText =
    intended?.scope === "window"
      ? `get_window_state for pid=${intended.pid}, window_id=${intended.window_id}, with include_screenshot=true`
      : "get_desktop_state for desktop coordinates";
  return `Cursor input refused before probe or input: the latest image delivered to this job is ${observedText}. Capture a fresh native ${requiredText} image and use coordinates from that exact image. No input was sent.`;
}

export function forgetCursorInputFrame(computerId, jobId) {
  latestByJob.delete(keyFor(computerId, jobId));
}
