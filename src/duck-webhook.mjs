// The words and sums behind a duck's Webhook tab, kept out of the component
// so they can be tested without a browser.

export const LIMITS = [5, 10, 20, 50, 100, 200, 500];

// What the tab's boxes start from.
export const webhookForm = (hook) => ({
  instructions: hook.instructions || "",
  allowed_ips: hook.allowed_ips || "",
  reply_url: hook.reply_url || "",
  hourly_limit: String(hook.hourly_limit ?? 20),
});

export const webhookDirty = (form, hook) =>
  JSON.stringify(form) !== JSON.stringify(webhookForm(hook));

// How many of the two recommended locks are set: an API key, and a list of
// addresses calls may come from.
export const locksSet = (hook) =>
  (hook.has_key ? 1 : 0) + ((hook.allowed_ips || "").trim() ? 1 : 0);

// An example call, with what this webhook actually needs in it.
export function sampleRequest(hook) {
  return [
    "POST  …/api/hooks/" + (hook.link_hint || "whk_…"),
    "Content-Type: application/json",
    ...(hook.has_key ? ["Authorization: Bearer tdk_…"] : []),
    "",
    "{",
    '  "task": "New order 4512: email the',
    '           customer a delivery date",',
    '  "from": "Shopify"' + (hook.reply_url ? "," : ""),
    ...(hook.reply_url ? ['  "reply_url": "' + hook.reply_url + '"'] : []),
    "}",
  ].join("\n");
}
