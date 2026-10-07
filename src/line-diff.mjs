const MAX_LCS_CELLS = 40_000;
const MAX_LCS_LINES = 600;

function splitLines(value) {
  const text = String(value ?? "").replace(/\r\n?/g, "\n");
  return text === "" ? [] : text.split("\n");
}

function changedBlock(before, after) {
  if (
    before.length + after.length > MAX_LCS_LINES ||
    before.length * after.length > MAX_LCS_CELLS
  )
    return [
      ...before.map((text) => ({ type: "removed", text })),
      ...after.map((text) => ({ type: "added", text })),
    ];

  const lengths = Array.from(
    { length: before.length + 1 },
    () => new Uint32Array(after.length + 1),
  );
  for (let i = before.length - 1; i >= 0; i -= 1)
    for (let j = after.length - 1; j >= 0; j -= 1)
      lengths[i][j] =
        before[i] === after[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);

  const lines = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      lines.push({ type: "context", text: before[i] });
      i += 1;
      j += 1;
    } else if (
      i < before.length &&
      (j === after.length || lengths[i + 1][j] >= lengths[i][j + 1])
    ) {
      lines.push({ type: "removed", text: before[i] });
      i += 1;
    } else {
      lines.push({ type: "added", text: after[j] });
      j += 1;
    }
  }
  return lines;
}

// Keep the cheap, identical edges out of the LCS matrix. Large changed blocks
// fall back to exact before/after blocks so a long document cannot cause
// quadratic work in the browser.
export function lineDiff(beforeValue, afterValue) {
  const before = splitLines(beforeValue);
  const after = splitLines(afterValue);
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  )
    prefix += 1;

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix += 1;

  return [
    ...before.slice(0, prefix).map((text) => ({ type: "context", text })),
    ...changedBlock(
      before.slice(prefix, before.length - suffix),
      after.slice(prefix, after.length - suffix),
    ),
    ...before
      .slice(before.length - suffix)
      .map((text) => ({ type: "context", text })),
  ];
}

export function lineChangeSummary(beforeValue, afterValue, lines) {
  const before = String(beforeValue ?? "");
  const after = String(afterValue ?? "");
  if (before === after) return { kind: "unchanged", added: 0, removed: 0 };

  const result = lines || lineDiff(before, after);
  const added = result.filter((line) => line.type === "added").length;
  const removed = result.filter((line) => line.type === "removed").length;
  return {
    kind: added || removed ? "changed" : "line-endings",
    added,
    removed,
  };
}
