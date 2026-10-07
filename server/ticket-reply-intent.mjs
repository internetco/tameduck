export const TICKET_REPLY_INSTRUCTIONS = `
Classify the latest human ticket reply using the complete ticket context and workflow state supplied by the caller. Return exactly one JSON object with action and message: action must be resume, acknowledge, or clarify; message must be 1 to 1000 characters in plain language. Treat the latest correction or clarification as authoritative for the requested work while preserving completed work. Decide acknowledgements and actionable follow-ups from meaning and context, never from fixed keyword lists. Choose resume only when the reply supplies enough actionable direction to continue the workflow. Choose acknowledge for a reply that adds no work or decision. Choose clarify when a consequential detail is still missing. Never approve, bypass, or imply approval of gated board changes, payments, credentials, private codes, or other actions requiring an existing approval or human-only step. Do not invent facts, IDs, permissions, or results.
`;

const decisionSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["resume", "acknowledge", "clarify"] },
    message: { type: "string", minLength: 1, maxLength: 1000 },
  },
  required: ["action", "message"],
  additionalProperties: false,
};

export function parseTicketReplyDecision(output) {
  let value = output;
  if (typeof output !== "string")
    throw new Error("Ticket reply decision must be JSON text.");
  const text = output
    .trim()
    .replace(/^\`\`\`(?:json)?\s*/i, "")
    .replace(/\s*\`\`\`$/i, "")
    .trim();
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Ticket reply decision was not valid JSON.");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !decisionSchema.properties.action.enum.includes(value.action) ||
    typeof value.message !== "string" ||
    value.message.trim().length < 1 ||
    value.message.length > 1000 ||
    Object.keys(value).some((k) => !["action", "message"].includes(k))
  ) {
    throw new Error("Ticket reply decision did not match the required schema.");
  }
  return { action: value.action, message: value.message };
}
