// Hashed production entry paths identify the interface actually loaded in a tab.
// Development entries and unavailable versions must not cause refresh loops.
export function appEntryPath(value) {
  if (!value || typeof value !== "string") return null;
  try {
    const path = new URL(value, "https://tameduck.invalid").pathname;
    return /^\/assets\/[^/]+\.js$/.test(path) ? path : null;
  } catch { return null; }
}
export function appEntryFromHtml(html) {
  for (const tag of String(html).match(/<script\b[^>]*>/gi) || []) {
    if (!/\btype\s*=\s*["']module["']/i.test(tag)) continue;
    const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
    const entry = appEntryPath(src);
    if (entry) return entry;
  }
  return null;
}
export function appUpdateAvailable(loaded, current) {
  const a = appEntryPath(loaded), b = appEntryPath(current);
  return !!a && !!b && a !== b;
}
