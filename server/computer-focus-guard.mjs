// A refused native focus click leaves the previous field focused. Keep that
// fact scoped to one job/computer so a following credential cannot land in the
// wrong control. This is deliberately bounded and remains until focus is explicitly restored.
const guards = new Set();
const MAX_GUARDS = 256;
const keyFor = (computerId, jobId) => String(computerId) + ":" + String(jobId);
const explicitTarget = (input = {}) =>
  (Number.isFinite(input.x) && Number.isFinite(input.y)) ||
  (Number.isInteger(input.element_index) && input.element_index >= 0) ||
  (typeof input.element_token === "string" && input.element_token.length > 0);
export const nativeFocusTargeted = (tool, input = {}) =>
  tool === "click" ||
  tool === "double_click" ||
  tool === "right_click" ||
  (tool === "type_text" && explicitTarget(input));
export function markNativeFocusRefused(computerId, jobId) {
  if (guards.size >= MAX_GUARDS && !guards.has(keyFor(computerId, jobId)))
    guards.delete(guards.keys().next().value);
  guards.add(keyFor(computerId, jobId));
}
export function clearNativeFocusGuard(computerId, jobId) {
  guards.delete(keyFor(computerId, jobId));
}
export function nativeFocusGuardMessage(computerId, jobId) {
  if (!guards.has(keyFor(computerId, jobId))) return null;
  return "The previous native click was refused and did not focus a field. Take a fresh screen capture and target the intended field with a new explicit click or coordinate-targeted type_text before entering text.";
}
