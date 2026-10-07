// A navigation receipt only proves dispatch. Observe the exact bound tab twice
// before letting its new document be described as visible to the duck.
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const intervalMs = 150;

const address = (value) => {
  try {
    return new URL(value).href;
  } catch {
    return null;
  }
};
export const normalizedPageAddress = address;

// A native address-bar read names the tab the person can see. Only use a
// browser binding for follow-up observation when that exact tab is present.
// Another active tab, or a stale pre-navigation tab list, is not evidence.
export function boundTabForNativeAddress(result, observedUrl) {
  const state = result?.structuredContent || {};
  const observed = address(observedUrl);
  if (
    result?.isError ||
    state.mode !== "bind" ||
    state.status !== "ok" ||
    state.binding_quality !== "exact" ||
    typeof state.target_id !== "string" ||
    !observed ||
    !Array.isArray(state.tabs)
  )
    return null;
  const matching = state.tabs.filter(
    (tab) => tab?.active !== false && address(tab.url) === observed,
  );
  if (matching.length !== 1 || typeof matching[0].tab_id !== "string")
    return null;
  return { target_id: state.target_id, tab_id: matching[0].tab_id };
}
const stateOf = (result) => result?.structuredContent || {};
const meaningfulOutline = (state) => {
  if (typeof state.outline !== "string") return null;
  const lines = state.outline
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (
        /\[[^\]]*(?:\b(?:visibility|display|hidden)\s*=\s*(?:hidden|offscreen|off_viewport|out_of_viewport|none|true)|\b(?:hidden|offscreen)\b)[^\]]*\]/i.test(
          line,
        )
      )
        return false;
      const role = /^-?\s*([\w-]+)/.exec(line)?.[1]?.toLowerCase();
      if (["rootwebarea", "document", "webarea", "root"].includes(role))
        return false;
      // A lone structural node is not evidence that body content rendered.
      return /["“][^"”]+["”]/.test(line) || /:\s*\S/.test(line);
    });
  return lines.length ? lines.join("\n") : null;
};
const hasImage = (result) =>
  result?.content?.some(
    (item) =>
      item.type === "image" &&
      typeof item.data === "string" &&
      item.data.length > 0,
  ) === true;

export function browserObservationFingerprint(result) {
  const outline = meaningfulOutline(stateOf(result));
  return outline ? outline.replace(/p\d+:\d+/g, "p:ref") : null;
}

// `baseline` is a get_browser_state result taken before browser_navigate. It
// keeps an old document from being mistaken for a different destination.
// Same-URL reloads may show identical content; repeated visible evidence is
// enough to say "observed", but never promises a load completed.
export async function waitForBrowserObservation({
  arguments: navigation,
  read,
  now = Date.now,
  sleep = pause,
  timeoutMs = 8000,
  baseline = null,
  guard = () => {},
}) {
  if (
    typeof read !== "function" ||
    typeof guard !== "function" ||
    typeof navigation?.target_id !== "string" ||
    typeof navigation?.tab_id !== "string" ||
    !address(navigation?.url) ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0
  )
    throw new TypeError(
      "A bound browser navigation and bounded reader are required",
    );
  const requested = address(navigation.url);
  const previousUrl = address(stateOf(baseline).page?.url);
  const previousContent = browserObservationFingerprint(baseline);
  const input = {
    target_id: navigation.target_id,
    tab_id: navigation.tab_id,
    ...(navigation.session ? { session: navigation.session } : {}),
    snapshot_format: "semantic_v2",
    include_screenshot: true,
  };
  const deadline = now() + timeoutMs;
  let prior = null;
  let snapshot = null;
  let attempts = 0;
  while (attempts++ < 64) {
    guard();
    snapshot = await read(input);
    guard();
    const state = stateOf(snapshot);
    // A refusal, lost binding, or switched tab must not be treated as a page
    // that merely needs more time. Its read result is returned for diagnosis.
    if (
      snapshot?.isError ||
      (state.refusal && typeof state.refusal === "object") ||
      state.effect === "refused" ||
      state.mode !== "snapshot" ||
      state.status !== "ok" ||
      state.target_id !== navigation.target_id ||
      state.tab_id !== navigation.tab_id
    )
      return { status: "pending", reason: "unavailable", snapshot, attempts };
    const currentUrl = address(state.page?.url);
    const content = browserObservationFingerprint(snapshot);
    // Exact requested URL needs no preflight. A redirect is acceptable only
    // with a baseline proving that this is not the old address.
    const onDestination =
      currentUrl === requested ||
      (previousUrl && currentUrl && currentUrl !== previousUrl);
    const changed =
      previousUrl === requested ||
      !previousContent ||
      content !== previousContent;
    const coherent = onDestination && changed && content && hasImage(snapshot);
    const signature = coherent ? `${currentUrl}\n${content}` : null;
    if (signature && signature === prior && now() <= deadline)
      return { status: "observed", snapshot, attempts };
    prior = signature;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    guard();
    await sleep(Math.min(intervalMs, remaining));
    guard();
  }
  return { status: "pending", reason: "timeout", snapshot, attempts };
}
