export const MODEL_INTELLIGENCE_SNAPSHOT = Object.freeze({
  version: "Artificial Analysis Intelligence Index v4.3.2",
  checked: "30 Sep 2026",
  methodologyURL:
    "https://artificialanalysis.ai/methodology/intelligence-benchmarking",
  scaleMaximum: 60,
});

const entry = (
  provider,
  model,
  name,
  score,
  input,
  output,
  slug,
  reasoning = "max",
) =>
  Object.freeze({
    provider,
    model,
    name,
    score,
    apiPrice: Object.freeze({ input, output }),
    reasoning,
    sourceURL: `https://artificialanalysis.ai/models/${slug}`,
  });

// A dated, static source registry. Runtime model catalogs are joined to this
// exact provider + model identity; aliases are deliberately not guessed.
export const MODEL_INTELLIGENCE = Object.freeze([
  entry("codex", "gpt-6-astra", "GPT-6 Astra", 53, 10, 50, "gpt-6-astra"),
  entry("codex", "gpt-6.1-sol", "GPT-6.1 Sol", 52, 2, 10, "gpt-6-1-sol", "max"),
  entry("codex", "gpt-6-sol", "GPT-6 Sol", 48, 2, 10, "gpt-6-sol", "max"),
  entry("codex", "gpt-5.6-sol", "GPT-5.6 Sol", 47, 4, 20, "gpt-5-6-sol"),
  entry("codex", "gpt-5.6-terra", "GPT-5.6 Terra", 42, 2, 12, "gpt-5-6-terra"),
  entry("codex", "gpt-5.5", "GPT-5.5", 38, 5, 30, "gpt-5-5", "xhigh"),
  entry("codex", "gpt-5.6-luna", "GPT-5.6 Luna", 37, 0.2, 1.2, "gpt-5-6-luna"),
  entry("openai", "gpt-6-luna", "GPT-6 Luna", 37, 0.1, 0.5, "gpt-6-luna"),
  entry(
    "openrouter",
    "openai/gpt-6.1-sol",
    "GPT-6.1 Sol (OpenRouter)",
    52,
    2,
    10,
    "gpt-6-1-sol",
    "max",
  ),
  entry(
    "openrouter",
    "google/gemini-3.8-flash",
    "Gemini 3.8 Flash (high)",
    41,
    0.75,
    3.75,
    "gemini-3-8-flash",
    "high",
  ),
]);

const modelId = (model) => model?.id ?? model?.model ?? "";
const sameChoice = (left, right) =>
  !!left &&
  !!right &&
  left.provider === right.provider &&
  modelId(left) === modelId(right);

export const intelligenceFor = (provider, model) =>
  MODEL_INTELLIGENCE.find(
    (candidate) => candidate.provider === provider && candidate.model === model,
  ) || null;

export const rankedIntelligence = (models = []) =>
  models
    .map((model, order) => ({
      ...model,
      intelligence: intelligenceFor(model.provider, modelId(model)),
      order,
    }))
    .sort(
      (left, right) =>
        (right.intelligence?.score ?? -1) - (left.intelligence?.score ?? -1) ||
        left.order - right.order,
    )
    .map(({ order, ...model }) => model);

export const highestRated = (models = []) =>
  rankedIntelligence(models).find((model) =>
    Number.isFinite(model.intelligence?.score),
  ) || null;

// A saved choice that is no longer in the live catalog has no meaningful gap.
// Automatic routing has no fixed score and follows the same rule.
export const scoreGap = (selected, availableModels = []) => {
  const live = availableModels.find((model) => sameChoice(selected, model));
  const best = highestRated(availableModels);
  const score = live && intelligenceFor(live.provider, modelId(live))?.score;
  return Number.isFinite(score) && Number.isFinite(best?.intelligence?.score)
    ? Math.max(0, best.intelligence.score - score)
    : null;
};

export const automaticChoice = (provider) => ({
  provider,
  id: "",
  model: "",
  name: "Automatic",
  automatic: true,
  intelligence: null,
});
