import crypto from "node:crypto";

// Whether somebody else changed a ticket's details while this person had the
// editor open, so that saving would quietly undo their work.
//
// This used to be "has the ticket changed at all", and a ticket a duck is
// working on changes all the time: every comment moves it, including the
// person's own, and so does a duck's progress note or a duck starting work.
// So an edit was refused with "Someone edited this ticket while you had it
// open" when nobody had touched the words, and reopening, as it said to,
// threw away what they had typed.
//
// Now the editor sends what it was opened with, and the save is refused only
// when one of those things is different now. The description travels as a
// fingerprint rather than the text: it can run to sixty thousand characters,
// and twice that would not fit in a request. Only the fields the editor writes
// back are compared, because those are the ones a save would overwrite.
const COMPARED = ["title", "priority", "status", "assignee_id"];

export const fingerprint = (text) =>
  crypto.createHash("sha256").update(String(text ?? "")).digest("hex");

export function editedSinceOpened(task, { updated, opened } = {}) {
  if (opened && typeof opened === "object" && !Array.isArray(opened)) {
    for (const key of COMPARED)
      if (key in opened && String(opened[key] ?? "") !== String(task[key] ?? ""))
        return true;
    if (
      "description_sha256" in opened &&
      opened.description_sha256 !== fingerprint(task.description)
    )
      return true;
    return false;
  }
  // An editor from before this, still open in somebody's tab, says only when
  // it was loaded. It gets the old strict answer rather than none.
  return !!updated && updated !== task.updated;
}
