// Document versions are externally visible timestamps, so keep the API shape
// while guaranteeing that each successful write advances the version.
export function nextDocumentVersion(previous, clock = Date.now()) {
  const prior = previous == null ? NaN : Date.parse(previous);
  if (previous != null && !Number.isFinite(prior))
    throw new Error("Invalid document version.");
  const current = Number.isFinite(clock) ? clock : Date.now();
  return new Date(Math.max(current, Number.isFinite(prior) ? prior + 1 : 0)).toISOString();
}
