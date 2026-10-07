// Who stopped a run, in the one line the card has for it. Away from the markup
// so the sentences can be read and tested on their own, the way
// pause-flock-words.mjs is.
//
// The card used to say "Run stopped." and nothing else, which is the one thing
// somebody looking at it already knows. What they want is who - a run that
// went quiet because a colleague stopped it reads, until you are told, exactly
// like a run that broke.
//
// Three sentences and one refusal, and the refusal is the important part.
// Most stops have nobody behind them: a deadline, a guard, a restart, a parent
// run that went. Naming a person on those would be a lie told on the one card
// built to answer that question, so anything short of a person we actually
// recorded and can still name falls back to saying nothing about who.
export function whoStopped(job, data) {
  const by = job?.stopped_by;
  if (!by) return "Run stopped.";
  if (by === data?.user?.id) return "Stopped by you.";
  // Only current members are sent to the screen, so somebody who has since
  // left the company resolves to nothing. "Stopped by undefined" is worse than
  // not saying, and so is their name appearing nowhere else in the product.
  const person = (data?.members || []).find((m) => m.id === by);
  return person?.name ? "Stopped by " + person.name + "." : "Run stopped.";
}

// The half that never changes. It is the reassurance, and it is true whoever
// stopped the run: cancelling ends the run, not what it already wrote.
export const STOPPED_TAIL = " Any completed work remains saved.";
