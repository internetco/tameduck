// Where this person has just been, per company, kept in this one browser.
// Search opens on it, so a box with nothing typed in it offers somewhere to go
// back to instead of a line explaining what a search box is for.
//
// A place is kept as a pointer and never as a name, so a channel that gets
// renamed shows its new name and one that is deleted simply stops resolving
// and drops out. Like the remembered board next door in navigation.mjs, this
// is a convenience for one browser: a store that is missing or blocked only
// means search opens empty, which is what it did before.
const KEY = "tameduck:recent-places:";
// The pages worth going back to: a chat, a task, a file. Everything else is a
// list you reach from the sidebar in one press anyway.
const worthKeeping = new Set(["chat", "tasks", "files"]);
// A few more than the five that are shown, so places that have since been
// deleted do not leave the list short.
const KEEP = 8;

// This place first, once, with the rest in the order they were last visited.
export function rememberPlace(list, place, keep = KEEP) {
  if (!place || !place.type || !place.id) return list;
  return [
    { type: place.type, id: place.id },
    ...list.filter((p) => !(p.type === place.type && p.id === place.id)),
  ].slice(0, keep);
}

export function recentPlaces(company) {
  try {
    const kept = JSON.parse(
      globalThis.localStorage?.getItem(KEY + company) || "[]",
    );
    return Array.isArray(kept)
      ? kept.filter(
          (p) => p && typeof p.type === "string" && typeof p.id === "string",
        )
      : [];
  } catch {
    return [];
  }
}

export function notePlace(company, view) {
  if (!company || !view?.id || !worthKeeping.has(view.type)) return;
  const kept = recentPlaces(company);
  // Every reload of the workspace re-checks the view somebody is already on,
  // and a duck at work reports several times a second. Writing only when the
  // list would change keeps that off the store.
  if (kept[0]?.type === view.type && kept[0]?.id === view.id) return;
  try {
    globalThis.localStorage?.setItem(
      KEY + company,
      JSON.stringify(rememberPlace(kept, view)),
    );
  } catch {
    // Storage blocked: this browser will not remember, and nothing else changes.
  }
}
