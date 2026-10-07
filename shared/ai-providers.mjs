// One list. Everything else - the screens, the validation, the routes - is
// derived from it, because four separate hand-kept enums of the same four names
// is how a fifth one gets half-added. It sits in shared/ because the screens
// need the same names the server does: when this list lived twice, the copy in
// the browser kept a name the server had already changed and quietly left a
// whole provider out of the picker.
//
// `kind` is what somebody actually chooses between: a subscription they already
// pay for and sign in to, or a key they paste and are billed for by usage. It
// used to be a boolean called `personal`, which said nothing about which of
// those it meant.
//
// `wire` is which request shape the transport speaks, kept separate from the id
// because two different companies can speak the same one.
//
// `mark` and `blurb` are what the provider’s row shows in Settings. They live
// here for the same reason the name does: they used to be an if/else chain in
// the screen with a fallback at the end, so the provider added last wore the
// sentence belonging to whichever one the chain ended on. A blurb says what
// the row needs and where to get it, in one line, because it sits beside a
// button.
//
// The order is the order of that list. OpenAI does not sit under ChatGPT:
// they are the two most easily taken for each other, a plan you sign in to
// and a key you paste.
//
// `notPlan` is the label on a key row that people mistake for the chat plan
// they already pay for. A Claude Pro subscriber pressed Claude, was asked for
// a key, looked in claude.ai, found none, and was stuck on the first screen.
//
// `name` is what a person is shown, everywhere, and it is not our word for the
// thing: it is the name on the account they signed in to or the key they
// pasted. Nothing in the product should say "Codex" at somebody who connected
// an Anthropic key.
export const providers = [
  {
    id: "codex",
    name: "ChatGPT",
    label: "ChatGPT plan",
    kind: "subscription",
    mark: "C",
    blurb: "Sign in with your plan. No key.",
  },
  {
    id: "claude",
    name: "Claude",
    label: "Claude key",
    kind: "api_key",
    wire: "anthropic",
    url: "https://api.anthropic.com/v1",
    keyUrl: "https://platform.claude.com/settings/keys",
    mark: "C",
    blurb: "Key from platform.claude.com",
    notPlan: "Not your Claude Pro plan",
  },
  {
    id: "openai",
    name: "OpenAI",
    label: "OpenAI key",
    kind: "api_key",
    wire: "openai-chat",
    url: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    mark: "O",
    blurb: "Key from platform.openai.com",
    notPlan: "Not your ChatGPT plan",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    label: "OpenRouter key",
    kind: "api_key",
    wire: "openai-chat",
    url: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/settings/keys",
    mark: "R",
    blurb: "One key for many AI companies",
  },
];
export const providerIds = providers.map((p) => p.id);
export const providerById = (id) => providers.find((p) => p.id === id) || null;
// What to call a provider on screen. An id we have never heard of is shown as
// itself rather than swallowed, so a stale row reads as odd instead of missing.
export const providerName = (id) => providerById(id)?.name || id;
// A connection somebody signs in to rather than pastes a key for. Asking this
// rather than asking whether the id is the string "codex" is what lets a second
// one exist without hunting through the codebase for that string.
// Which request shape to speak to a provider. Everything that used to ask
// Provider-specific questions ask this instead, because those questions are
// about the request shape rather than the company: they are about the shape of
// the request. Asking by name is how a fifth provider that speaks a shape we
// already handle still arrives broken.
export const providerWire = (id, model = "") => {
  // Modern OpenAI reasoning models use Responses for tool work. Keep older
  // chat-only model families on their existing transport.
  if (id === "openai") {
    const generation = /^gpt-(\d+)(?:[.-]|$)/i.exec(model);
    if (
      (generation && Number(generation[1]) >= 5) ||
      /^o[3-9](?:[-.]|$)/i.test(model)
    )
      return "openai-responses";
  }
  return providerById(id)?.wire || "openai-chat";
};
export const isSubscription = (id) => providerById(id)?.kind === "subscription";
export const keyProviderIds = providerIds.filter((id) => !isSubscription(id));
// The one connection somebody signs in to, under the name they know it by. The
// process that runs it is called Codex, and its failures used to say so out
// loud to people who had signed in to ChatGPT and never chosen anything called
// Codex in their lives.
export const subscriptionName = providers.find(
  (p) => p.kind === "subscription",
).name;
