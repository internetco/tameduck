const TRAJECTORY_TOOLS = new Set([
  "click",
  "double_click",
  "right_click",
  "type_text",
  "press_key",
  "hotkey",
  "scroll",
  "move_cursor",
]);

const PROBE_ARGUMENT_KEYS = [
  "pid",
  "window_id",
  "scope",
  "target",
  "x",
  "y",
  "delivery_mode",
  "session",
  "cursor_id",
];
const NATIVE_MARKERS = [
  "element_token",
  "element_index",
  "index",
  "snapshot_id",
  "from_zoom",
];

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const toolName = (tool) =>
  typeof tool === "string" ? tool : tool?.name || tool?.tool || tool?.id || "";

function safeTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target))
    return target;
  const copy = {};
  for (const key of ["kind", "pid", "window_id", "display_id"])
    if (Object.prototype.hasOwnProperty.call(target, key))
      copy[key] = target[key];
  return copy;
}

function sanitizedArguments(args) {
  const copy = {};
  for (const key of PROBE_ARGUMENT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
    copy[key] = key === "target" ? safeTarget(args[key]) : args[key];
  }
  return copy;
}

function hasWindowTarget(args) {
  return (
    args.pid !== undefined ||
    args.window_id !== undefined ||
    (args.target &&
      typeof args.target === "object" &&
      args.target.kind === "window") ||
    args.scope === "window"
  );
}

function hasDesktopTarget(args) {
  return (
    args.scope === "desktop" ||
    (args.target &&
      typeof args.target === "object" &&
      args.target.kind === "desktop")
  );
}

export function requiresCursorTrajectory(tool, args) {
  const name = toolName(tool);
  if (!TRAJECTORY_TOOLS.has(name) || !args || typeof args !== "object")
    return false;
  if (NATIVE_MARKERS.some((key) => args[key] !== undefined)) return false;
  if (!finite(args.x) || !finite(args.y)) return false;

  const windowTarget = hasWindowTarget(args);
  const desktopTarget = hasDesktopTarget(args);
  if (windowTarget && desktopTarget) return false;

  if (name === "move_cursor")
    return args.delivery_mode === undefined && !windowTarget && desktopTarget;

  return args.delivery_mode === "foreground";
}

function pair(value, name) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every(finite) &&
    (name === "screen" ? value[0] > 0 && value[1] > 0 : true)
  );
}

function inScreen(point, screen) {
  return (
    pair(point) &&
    point[0] >= 0 &&
    point[1] >= 0 &&
    point[0] < screen[0] &&
    point[1] < screen[1]
  );
}

function validFrame(frame, screen) {
  if (frame === null) return true;
  if (!frame || typeof frame !== "object") return false;
  if (!["x", "y", "w", "h"].every((key) => finite(frame[key]))) return false;
  return frame.w > 0 && frame.h > 0;
}

function validPointer(pointer) {
  if (!pointer || typeof pointer !== "object") return false;
  const { start, end, screen, window, frame } = pointer;
  if (!pair(start) || !pair(end) || !pair(screen, "screen")) return false;
  if (!inScreen(start, screen) || !inScreen(end, screen)) return false;
  if (!(
    window === null ||
    (pair(window) &&
      window.every((value) => Number.isInteger(value) && value > 0))
  ))
    return false;
  if ((window === null) !== (frame === null)) return false;
  return validFrame(frame, screen);
}

function validGenerated(result, pointer) {
  if (!result || typeof result !== "object" || !Array.isArray(result.points))
    return false;
  const points = result.points;
  if (points.length < 2 || points.length > 32) return false;
  if (!points.every((point) => inScreen(point, pointer.screen))) return false;
  if (points[0][0] !== pointer.start[0] || points[0][1] !== pointer.start[1])
    return false;
  const last = points[points.length - 1];
  if (last[0] !== pointer.end[0] || last[1] !== pointer.end[1]) return false;
  if (result.generator !== "onnx") return false;
  return finite(result.generationMs) && result.generationMs >= 0;
}

export async function attachCursorTrajectory({
  tool,
  args,
  probe,
  generate,
  guard = () => {},
} = {}) {
  const name = toolName(tool);
  if (!requiresCursorTrajectory(name, args)) return null;
  if (typeof probe !== "function" || typeof generate !== "function")
    return null;

  await guard();
  let observed;
  try {
    observed = await probe({ tool: name, arguments: sanitizedArguments(args) });
  } catch {
    await guard();
    return null;
  }
  await guard();
  if (!validPointer(observed?.pointer)) return null;

  const pointer = observed.pointer;
  let generated;
  try {
    generated = await generate({
      start: [...pointer.start],
      end: [...pointer.end],
      screen: [...pointer.screen],
    });
  } catch {
    await guard();
    return null;
  }
  await guard();
  if (!validGenerated(generated, pointer)) return null;

  return {
    start: [...pointer.start],
    end: [...pointer.end],
    screen: [...pointer.screen],
    window: pointer.window === null ? null : [...pointer.window],
    frame:
      pointer.frame === null
        ? null
        : {
            x: pointer.frame.x,
            y: pointer.frame.y,
            w: pointer.frame.w,
            h: pointer.frame.h,
          },
    points: generated.points.map((point) => [...point]),
    generator: generated.generator,
    generation_ms: generated.generationMs,
  };
}
