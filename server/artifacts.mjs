import { db, id, now, one, all, run, fail } from "./store.mjs";
export function attachArtifact(
  company,
  message,
  kind,
  reference,
  title,
  verb,
  changes = [],
) {
  if (
    !one("SELECT 1 FROM messages WHERE id=? AND company_id=?", message, company)
  )
    fail(404, "Message not found.");
  db.transaction(() => {
    run(
      `INSERT INTO message_artifacts VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(message_id,kind,reference_id) DO UPDATE SET title=excluded.title,verb=CASE WHEN message_artifacts.verb IN ('Created','Updated') AND excluded.verb='Viewed' THEN message_artifacts.verb ELSE excluded.verb END`,
      id(),
      company,
      message,
      kind,
      reference,
      title,
      verb,
      now(),
    );
    if (verb !== "Updated") return;
    const artifact = one(
      "SELECT id FROM message_artifacts WHERE message_id=? AND kind=? AND reference_id=? AND company_id=?",
      message,
      kind,
      reference,
      company,
    );
    for (const change of changes) {
      if (
        !change ||
        typeof change.key !== "string" ||
        typeof change.label !== "string" ||
        typeof change.before !== "string" ||
        typeof change.after !== "string"
      )
        continue;
      run(
        `INSERT INTO message_artifact_changes(artifact_id,field_key,label,before_value,after_value) VALUES(?,?,?,?,?) ON CONFLICT(artifact_id,field_key) DO UPDATE SET label=excluded.label,after_value=excluded.after_value`,
        artifact.id,
        change.key,
        change.label,
        change.before,
        change.after,
      );
    }
  })();
}
export const artifactsFor = (message, company) =>
  all(
    // kept says whether what this refers to is still there. Only screenshots can
    // go missing on their own: a company keeps its last 500 and the oldest give
    // way, so a message from last month still knows a picture was taken and can
    // say that it is no longer kept rather than showing nothing at all.
    "SELECT id,kind,reference_id,title,verb,created,CASE WHEN kind='screenshot' THEN EXISTS(SELECT 1 FROM computer_captures cc WHERE cc.id=reference_id) ELSE 1 END kept,EXISTS(SELECT 1 FROM message_artifact_changes ac WHERE ac.artifact_id=message_artifacts.id) has_changes FROM message_artifacts WHERE message_id=? AND company_id=? ORDER BY created",
    message,
    company,
  );

export function artifactChangesFor(artifactId, company, authorize = () => {}) {
  const artifact = one(
    `SELECT a.id,a.title,a.kind,a.verb,a.created,m.conversation_id
       FROM message_artifacts a
       JOIN messages m ON m.id=a.message_id
      WHERE a.id=? AND a.company_id=? AND m.company_id=?`,
    artifactId,
    company,
    company,
  );
  if (!artifact) fail(404, "Artifact not found.");
  authorize(artifact.conversation_id);
  const fields = all(
    "SELECT field_key key,label,before_value before,after_value after FROM message_artifact_changes WHERE artifact_id=? ORDER BY rowid",
    artifact.id,
  );
  if (!fields.length)
    fail(404, "Changes are unavailable for this older update.");
  const { conversation_id, ...publicArtifact } = artifact;
  return { artifact: publicArtifact, fields, conversation_id };
}
