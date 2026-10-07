// Models are offered only after a real provider test has recorded them here.
export const VERIFIED_MODELS = Object.freeze({
  codex: Object.freeze([
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6-sol",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
  ]),
  openai: Object.freeze(["gpt-6-luna"]),
  claude: Object.freeze([]),
  openrouter: Object.freeze(["openai/gpt-6.1-sol", "google/gemini-3.8-flash"]),
});
const reasons = Object.freeze({
  codex: "No tested ChatGPT model is currently available.",
  openai: "OpenAI API is available only for tested models.",
  claude:
    "Claude is temporarily unavailable while its models are being tested.",
  openrouter:
    "OpenRouter is temporarily unavailable while its models are being tested.",
});
export const verifiedModels = (provider) => VERIFIED_MODELS[provider] || [];
export const modelVerified = (provider, model) =>
  typeof model === "string" && verifiedModels(provider).includes(model);
export const providerEnabled = (provider) =>
  verifiedModels(provider).length > 0;
export const filterAvailableModels = (provider, models = []) =>
  models.filter((model) =>
    modelVerified(provider, typeof model === "string" ? model : model?.id),
  );
export const availability = (provider) => ({
  enabled: providerEnabled(provider),
  statusReason: providerEnabled(provider)
    ? null
    : reasons[provider] || "No tested model is currently available.",
});
export const unavailableReason = (provider) =>
  availability(provider).statusReason;
