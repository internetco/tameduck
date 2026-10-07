import { all } from "./store.mjs";

// The runs and the kind of thing each did come first, one row per run and
// kind, and only then the conversations and consultations. Joined straight
// onto every action, each action met every run in its conversation before
// DISTINCT threw the copies away: with eight thousand actions that took 400ms
// on every load of the workspace, which a working duck asks for every second,
// and a click on a duck waited behind it. Exported for the test that checks it
// is answered from indexes (server/migrations/0037_computer-use-indexes.sql).
export const COMPUTER_USE_SQL =
  "WITH done AS (SELECT DISTINCT a.job_id, a.tool='terminal' typed FROM jobs cj JOIN computer_actions a ON a.job_id=cj.id WHERE cj.company_id=?) " +
  "SELECT DISTINCT COALESCE(consultation.child_job_id,done.job_id) job_id, done.typed FROM done " +
  "JOIN jobs j ON j.id=done.job_id " +
  "LEFT JOIN jobs current_helper ON current_helper.conversation_id=j.conversation_id " +
  "LEFT JOIN duck_consultations consultation ON consultation.child_job_id=current_helper.id " +
  "LEFT JOIN jobs parent ON parent.id=consultation.parent_job_id " +
  "WHERE j.company_id=? AND (EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=j.conversation_id AND cm.user_id=?) OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=parent.conversation_id AND cm.user_id=?))";

// What each run did with its computer, so the transcript can show the part
// that is worth looking at and leave out the part that is not.
//
// A run that only ever typed at a terminal changed nothing on the desktop,
// so a picture of that desktop is a picture of something else - and that is
// what people were being shown, motionless, beside a terminal doing all the
// work. A run that drove the desktop gets its picture; a run that typed
// gets its terminal; a run that did both gets both.
export function computerUseOfRuns(company, user) {
  const did = all(COMPUTER_USE_SQL, company, company, user, user);
  return {
    terminal_jobs: did.filter((r) => r.typed).map((r) => r.job_id),
    desktop_jobs: did.filter((r) => !r.typed).map((r) => r.job_id),
  };
}
