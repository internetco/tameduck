// A half-written message, kept until it is sent.
//
// Kept in memory, it survived moving to another chat and back, and nothing
// else. Refresh - which the "An update is ready" banner asks for, and which on
// staging comes round several times a day - threw it away, as did closing the
// tab, or a phone quietly reloading it after a while in the background. So the
// words go into the tab's own storage as well, one entry per person,
// conversation and thread.
//
// The tab's, not the browser's, on purpose. People paste things into a chat
// box they would not want kept - a code, a password a duck asked for - and
// storage that outlives the browser would leave that on a shared computer for
// whoever sits down next, with or without signing out. This survives Refresh
// and the phone reloading the page, and goes when the tab is closed. Only the text and the documents picked from the workspace: an
// uploaded file is a draft on the server that gets swept, so it stays in
// memory as before rather than coming back as a file that no longer exists.
//
// Storage can be missing or full, or refuse outright in a private window.
// Every touch of it is allowed to fail, and memory carries on regardless.
const PREFIX = "td-draft:";
const KEEP_MS = 14 * 86400000;
const memory = new Map();
const browserStorage = () => {
  try {
    return globalThis.sessionStorage || null;
  } catch {
    return null;
  }
};

export const draftKey = (user, conversation, thread) =>
  user + ":" + conversation + ":" + (thread || "main");

export function keptDraft(key, { storage = browserStorage(), now = Date.now() } = {}) {
  if (memory.has(key)) return memory.get(key);
  try {
    const raw = storage?.getItem(PREFIX + key);
    if (!raw) return undefined;
    const saved = JSON.parse(raw);
    // A fortnight on, it is not a message somebody is in the middle of.
    if (!saved || !(now - saved.at < KEEP_MS)) {
      storage.removeItem(PREFIX + key);
      return undefined;
    }
    const draft = {
      body: String(saved.body || ""),
      documents: Array.isArray(saved.documents) ? saved.documents : [],
      files: [],
    };
    memory.set(key, draft);
    return draft;
  } catch {
    return undefined;
  }
}

export function keepDraft(key, draft, { storage = browserStorage(), now = Date.now() } = {}) {
  memory.set(key, draft);
  try {
    if (!String(draft?.body || "").trim() && !draft?.documents?.length)
      storage?.removeItem(PREFIX + key);
    else
      storage?.setItem(
        PREFIX + key,
        JSON.stringify({
          body: draft.body || "",
          documents: draft.documents || [],
          at: now,
        }),
      );
  } catch {}
}

// Signing out takes somebody's unsent words off this browser, so whoever
// signs in next on the same machine does not inherit them.
export function forgetDrafts(user, { storage = browserStorage() } = {}) {
  for (const key of [...memory.keys()])
    if (key.startsWith(user + ":")) memory.delete(key);
  try {
    const mine = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(PREFIX + user + ":")) mine.push(key);
    }
    for (const key of mine) storage.removeItem(key);
  } catch {}
}

// Drafts for chats nobody opens again would otherwise sit there for ever.
export function sweepDrafts({ storage = browserStorage(), now = Date.now() } = {}) {
  try {
    const old = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      let at = 0;
      try {
        at = JSON.parse(storage.getItem(key))?.at || 0;
      } catch {}
      if (!(now - at < KEEP_MS)) old.push(key);
    }
    for (const key of old) storage.removeItem(key);
  } catch {}
}

// Only for tests: what a fresh page load starts with.
export const forgetMemory = () => memory.clear();
