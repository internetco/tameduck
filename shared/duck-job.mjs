// What a duck is given for a job when it is made without one: its name, its
// role, and a line that is true of every duck. It keeps the duck's prompt from
// having a hole in it. Nobody wrote it, though, so the duck dialog shows that
// job as the blank it stands in for, and its tab goes on saying "Empty".
const LAST = "You are a duck on this company's AI team.";
export const standInJob = (name, role) =>
  `# ${name}\n\nRole: ${role}\n\n${LAST}`;
// By its shape, not by its name: a duck that has since been renamed still has
// the old name in it.
export function isStandInJob(text) {
  const lines = String(text || "").split("\n");
  return (
    lines.length === 5 &&
    lines[0].startsWith("# ") &&
    lines[2].startsWith("Role: ") &&
    lines[1] === "" &&
    lines[3] === "" &&
    lines[4] === LAST
  );
}
