// Browser bindings and action refs live in structuredContent, while the text
// often only says how many tabs were found. The model needs both to act.
export function computerContentItems(result) {
  const items = (result.content || []).flatMap((item) =>
    item.type === "image"
      ? [
          {
            type: "inputImage",
            imageUrl: "data:" + item.mimeType + ";base64," + item.data,
          },
        ]
      : item.type === "text"
        ? [{ type: "inputText", text: item.text }]
        : [],
  );
  if (result.structuredContent != null) {
    items.push({
      type: "inputText",
      text:
        "Structured computer state:\n" +
        JSON.stringify(result.structuredContent),
    });
  }
  return items;
}

const EFFECT_STATUS = new Map([
  ["refused", { status: "refused", failed: true, inspectRequired: true }],
  ["error", { status: "error", failed: true, inspectRequired: true }],
  ["failed", { status: "error", failed: true, inspectRequired: true }],
  ["confirmed", { status: "confirmed", failed: false, inspectRequired: false }],
  ["sent", { status: "sent", failed: false, inspectRequired: true }],
  [
    "unverifiable",
    { status: "unverifiable", failed: false, inspectRequired: true },
  ],
  ["unknown", { status: "unknown", failed: false, inspectRequired: true }],
  ["interrupted", { status: "unknown", failed: false, inspectRequired: true }],
]);

export function computerOutcome(result) {
  const structured = result?.structuredContent;
  const effect = structured?.effect;
  const explicitRefusal =
    typeof structured?.status === "string" &&
    structured.status.toLowerCase() === "refused";
  const refusalObject =
    structured?.refusal &&
    typeof structured.refusal === "object" &&
    typeof structured.refusal.code === "string";
  if (result?.isError === true)
    return (typeof effect === "string" && effect.toLowerCase() === "refused") ||
      explicitRefusal ||
      refusalObject
      ? { status: "refused", failed: true, inspectRequired: true }
      : { status: "error", failed: true, inspectRequired: true };
  if (explicitRefusal || refusalObject)
    return { status: "refused", failed: true, inspectRequired: true };
  if (typeof effect === "string") {
    const known = EFFECT_STATUS.get(effect.toLowerCase());
    if (known) return { ...known };
  }
  return { status: "unknown", failed: false, inspectRequired: true };
}
