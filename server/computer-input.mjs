const NATIVE_INPUT_TOOLS = new Set([
  "click",
  "double_click",
  "right_click",
  "drag",
  "type_text",
  "press_key",
  "hotkey",
  "scroll",
  "move_cursor",
]);
const KEY_ALIASES = new Map([
  ["ArrowDown", "DOWN"],
  ["ARROWDOWN", "DOWN"],
  ["ArrowUp", "UP"],
  ["ARROWUP", "UP"],
  ["ArrowLeft", "LEFT"],
  ["ARROWLEFT", "LEFT"],
  ["ArrowRight", "RIGHT"],
  ["ARROWRIGHT", "RIGHT"],
  ["Escape", "ESC"],
  ["ESCAPE", "ESC"],
  ["Return", "ENTER"],
  ["RETURN", "ENTER"],
]);

const toolName = (tool) =>
  typeof tool === "string" ? tool : tool?.name || tool?.tool || tool?.id || "";

const inputSchema = (schema) => schema?.inputSchema || schema?.schema || schema;
const hasDeliveryMode = (schema) =>
  !!inputSchema(schema)?.properties?.delivery_mode;

export const isDuckDesktopInput = (tool, schema) =>
  NATIVE_INPUT_TOOLS.has(toolName(tool)) && hasDeliveryMode(schema);

export function duckDesktopSchema(schema, clickSchema) {
  const copy = structuredClone(schema);
  const name = toolName(copy);
  // The provider's older convenience tools lack desktop targeting. Expose
  // the common click contract; the guest sends one native click operation.
  if (["double_click", "right_click"].includes(name) && clickSchema) {
    copy.inputSchema = structuredClone(inputSchema(clickSchema));
    delete copy.inputSchema.properties.count;
    delete copy.inputSchema.properties.button;
  }
  const target = inputSchema(copy);
  if (name === "get_browser_state" && target?.properties?.snapshot_format) {
    target.properties.snapshot_format.default = "semantic_v2";
    target.properties.snapshot_format.description =
      "semantic_v2 returns accessible live control state by default. dom_refs_v1 remains available when explicitly requested.";
    copy.description +=
      " TameDuck defaults page reads to semantic_v2 for accessible control state. A DOM attribute is not proof of the current field value; verify the live control state or the fresh native screenshot after input.";
    return copy;
  }
  if (name === "move_cursor" && target?.properties?.scope) {
    copy.description =
      "Move the real mouse pointer on the assigned desktop, including hover. Read x/y from a fresh get_desktop_state screenshot. Desktop scope is the default; window marker movement is not exposed as a mouse action. Human takeover blocks actions.";
    target.properties.scope = {
      type: "string",
      enum: ["desktop"],
      default: "desktop",
    };
    target.properties.target = {
      type: "object",
      properties: {
        kind: { const: "desktop", type: "string" },
        display_id: { const: "primary", type: "string" },
      },
      required: ["kind", "display_id"],
      additionalProperties: false,
    };
    return copy;
  }
  if (!isDuckDesktopInput(name, copy)) return copy;
  if (target.properties.scope)
    target.properties.scope = {
      ...target.properties.scope,
      default: "desktop",
      description:
        "With no window target, use the primary desktop and coordinates from get_desktop_state. An explicit pid/window_id or window target retains window screenshot coordinates. Never mix the two coordinate spaces.",
    };
  target.properties.delivery_mode = {
    ...target.properties.delivery_mode,
    default: "foreground",
    description:
      "Foreground is the default on this assigned remote desktop. " +
      (target.properties.delivery_mode.description || "").replace(
        "'background' (default)",
        "'background' when explicitly requested",
      ),
  };
  const explanation =
    "This assigned desktop input may use the foreground; human takeover blocks actions. ";
  if (typeof copy.description === "string")
    copy.description =
      explanation +
      copy.description.replace(
        "'background' (default)",
        "'background' when explicitly requested",
      );
  else if (typeof target.description === "string")
    target.description = explanation + target.description;
  else copy.description = explanation.trim();
  if (name === "type_text")
    copy.description =
      explanation +
      "Type into the focused field on the assigned desktop. Supply x/y from get_desktop_state to click the field first. An explicit window target uses that window's screenshot coordinates instead. Desktop text and foreground Unicode use the remote UTF-8 clipboard and one paste after focusing the field, preserving accents and emoji.";
  const nativeDescriptions = {
    click:
      "Click the real desktop at x/y from get_desktop_state, using the requested mouse button. An explicit window target or native element handle uses that window's coordinates instead.",
    double_click:
      "Double-click the real desktop at x/y from get_desktop_state. Explicit window targets use window screenshot coordinates.",
    right_click:
      "Right-click the real desktop at x/y from get_desktop_state. Explicit window targets use window screenshot coordinates.",
    drag: "Press, move and release the real mouse from from_x/from_y to to_x/to_y in the get_desktop_state screenshot. Explicit window targets use window screenshot coordinates. Duration, steps, button and modifiers are supported.",
    scroll:
      "Scroll at the observed pointer location on the desktop. Use get_desktop_state coordinates, or an explicit window target and matching window screenshot coordinates.",
    press_key:
      "Press a key in the desktop's focused control. Supply observed x/y to click the field first. Explicit window targets retain window targeting. Key names include DOWN, UP, LEFT, RIGHT, ENTER and ESC.",
    hotkey:
      "Press a keyboard shortcut in the desktop's focused control, for example [ctrl,c]. Supply observed x/y to focus a field first. Explicit window targets retain window targeting.",
  };
  if (nativeDescriptions[name])
    copy.description = explanation + nativeDescriptions[name];
  return copy;
}

export function duckDesktopInput(tool, args, schema) {
  const copy = { ...(args || {}) };
  const name = toolName(tool);
  const properties = inputSchema(schema)?.properties || {};
  if (
    name === "get_browser_state" &&
    properties.snapshot_format &&
    copy.target_id &&
    copy.tab_id &&
    copy.snapshot_format === undefined
  )
    copy.snapshot_format = "semantic_v2";
  const windowTarget =
    copy.pid !== undefined ||
    copy.window_id !== undefined ||
    copy.target?.kind === "window" ||
    copy.element_index !== undefined ||
    copy.element_token !== undefined ||
    copy.snapshot_id !== undefined ||
    copy.from_zoom === true;
  if (name === "move_cursor" && properties.scope) {
    if (windowTarget || copy.scope === "window")
      throw Object.assign(
        new Error(
          "Mouse movement needs desktop screenshot coordinates. Capture get_desktop_state, then call move_cursor with x/y and scope desktop. No input was sent.",
        ),
        { status: 400 },
      );
    if (copy.scope === undefined) copy.scope = "desktop";
    return copy;
  }
  if (!isDuckDesktopInput(name, schema)) return copy;
  if (
    properties.scope &&
    copy.scope === undefined &&
    !windowTarget &&
    (copy.target == null || copy.target.kind === "desktop")
  )
    copy.scope = "desktop";
  if (copy.delivery_mode === undefined) copy.delivery_mode = "foreground";
  if (name === "press_key" && typeof copy.key === "string")
    copy.key = KEY_ALIASES.get(copy.key) || copy.key;
  return copy;
}
