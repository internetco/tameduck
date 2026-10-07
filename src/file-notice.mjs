const legacyPreviewReasons = [
  /^AI can't read (?:\.[a-z0-9]{1,10}|this type of) files\./i,
  /^Older \.(?:doc|xls|ppt) files can't be read by AI\./i,
  /^PDF reading isn't set up on this server yet\./i,
  /^AI can only view PNG, JPEG, GIF and WebP images\./i,
  /^The AI model this duck is using can't view images\./i,
];

export function isPreviewUnavailableNotice({ reason = "" } = {}) {
  const text = String(reason);
  return (
    /^This file (?:cannot|can't) be previewed directly\./i.test(text) ||
    legacyPreviewReasons.some((pattern) => pattern.test(text))
  );
}

export function noticeHeading({
  name = "",
  reason = "",
  duckName = "The duck",
} = {}) {
  return isPreviewUnavailableNotice({ reason })
    ? "Preview unavailable for " + name
    : duckName + " couldn’t read " + name + ".";
}

export function noticeReason(notice) {
  return isPreviewUnavailableNotice(notice)
    ? "The duck can still process the original file on its computer when computer access is enabled."
    : notice.reason;
}
