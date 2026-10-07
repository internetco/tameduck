const clean = (text) => String(text || "").trim();

function appendExactParagraph(body, paragraph) {
  const text = clean(body);
  const addition = clean(paragraph);
  if (!addition) return text;
  if (
    text === addition ||
    text.endsWith("\n\n" + addition) ||
    (text && text.split(/\n{2,}/).some((part) => part.trim() === addition))
  )
    return text;
  return text ? text + "\n\n" + addition : addition;
}

export function finishedReplyBody(visible, finish) {
  if (finish.quiet) return "";
  let output = appendExactParagraph(visible, finish.summary);
  if (finish.outcome === "incomplete") {
    const incomplete =
      "Could not finish: " +
      finish.reason +
      "\n\nRemaining work: " +
      finish.remaining_work;
    if (output !== incomplete && !output.endsWith("\n\n" + incomplete))
      output = output ? output + "\n\n" + incomplete : incomplete;
  }
  return output;
}
