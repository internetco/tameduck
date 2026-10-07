export function codexReplyCollector(earlier = "") {
  let body = earlier;
  let completed = [];
  let opening = "";
  let openingKind = "";
  let paragraphItemId = null;
  let beforeToolIds = new Set();
  let ignoredIds = new Set();
  let streamItemId = null;
  let streamItemOpen = false;
  return {
    get body() {
      return body;
    },
    delta({ delta = "", itemId }) {
      if (!delta) return;
      if (itemId) beforeToolIds.add(itemId);
      const sameItem =
        streamItemOpen &&
        (itemId ? itemId === streamItemId : streamItemId === null);
      body += (body && (body === earlier || !sameItem) ? "\n\n" : "") + delta;
      streamItemId = itemId || null;
      streamItemOpen = true;
    },
    itemCompleted(item) {
      if (item?.type !== "agentMessage" || !item.text) return;
      if (
        streamItemOpen &&
        (!item.id || !streamItemId || item.id === streamItemId)
      ) {
        streamItemId = null;
        streamItemOpen = false;
      }
      if (item.id && ignoredIds.delete(item.id)) return;
      if (
        openingKind === "paragraph" &&
        (!item.id || item.id === paragraphItemId) &&
        item.text.trim().startsWith(opening)
      ) {
        const rest = item.text.trim().slice(opening.length).trimStart();
        opening = "";
        openingKind = "";
        if (rest) completed.push(rest);
        return;
      }
      // Older app-server events without item ids may complete after the tool.
      // Only an exact match is safe to discard: a later final answer may
      // legitimately begin with the same words.
      if (!item.id && openingKind === "tool" && item.text.trim() === opening) {
        opening = "";
        openingKind = "";
        return;
      }
      completed.push(item.text);
    },
    opening() {
      return completed.join("\n\n").trim() || body.slice(earlier.length).trim();
    },
    splitParagraph(first, remainder, itemId = null) {
      opening = first;
      openingKind = "paragraph";
      paragraphItemId = itemId;
      body = earlier + (earlier && remainder ? "\n\n" : "") + remainder;
      completed = [];
      streamItemId = itemId;
      streamItemOpen = true;
    },
    split() {
      opening = this.opening();
      openingKind = "tool";
      ignoredIds = new Set(beforeToolIds);
      beforeToolIds = new Set();
      body = earlier;
      completed = [];
      streamItemId = null;
      streamItemOpen = false;
    },
    reply() {
      return completed.length
        ? (earlier ? earlier + "\n\n" : "") + completed.join("\n\n")
        : body;
    },
  };
}
