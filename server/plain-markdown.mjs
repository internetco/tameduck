// Escape untrusted names in server-written Markdown messages. GFM links bare
// URLs and email addresses even when ordinary Markdown punctuation is escaped.
// A zero-width separator at each autolink trigger keeps the visible name
// intact while preventing it from becoming a clickable link. Use the actual
// character so plain-text previews do not show an HTML entity.
export const plainMarkdown = (value) =>
  String(value ?? "")
    .replace(/https?:\/\/|www\.|@/gi, (part) =>
      part === "@" ? "\u200b@" : part[0] + "\u200b" + part.slice(1),
    )
    .replace(/([\\`*_{}\[\]()#+.!|<>~-])/g, "\\$1");
