// Who a duck may ask for help, as switches: one for each other duck on the
// team, and one for ducks added later. The duck's profile and Settings > Ducks
// both draw them, and both turn a flip into what the server keeps. Kept apart
// from the screens so the sums can be checked without a browser.
//
// The server knows three answers: every duck, now and later ("all"), these
// ducks ("selected"), or nobody ("none"). It has no "these ducks and later
// ones", so the switch for later ducks is on only while the answer is "all".

export const LATER = "later";

// Whether the switch for `to` (a duck's id, or LATER) is on.
export function canAsk(policy, to) {
  if (policy.mode === "all") return true;
  if (to === LATER) return false;
  return policy.mode === "selected" && policy.allowed_duck_ids.includes(to);
}

// The ducks on a list that are off the team. `others` is the ids of the ducks
// on the team other than this one.
export const offTeam = (policy, others) =>
  policy.mode === "selected"
    ? policy.allowed_duck_ids.filter((id) => !others.includes(id))
    : [];

// The answer to send once the switch for `to` is set to `on`.
//
// A duck taken off the team stays on the list it was on, so that putting it
// back puts it back. No switch shows it, so no switch may drop it. `kept` is
// who those are. The profile passes the list it opened with: "every duck"
// holds no list, so turning ducks you add later on and off again would
// otherwise forget them.
export function flip(policy, others, to, on, kept = offTeam(policy, others)) {
  // On means every duck, now and later, so every other switch goes on too.
  if (to === LATER && on) return { mode: "all", allowed_duck_ids: [] };
  const asked = others.filter((id) => (id === to ? on : canAsk(policy, id)));
  if (!asked.length && !kept.length)
    return { mode: "none", allowed_duck_ids: [] };
  return { mode: "selected", allowed_duck_ids: [...kept, ...asked] };
}

// What of `next` the server will take, for a duck whose list is now `now`: the
// ducks on the team, and a duck off the team only while it is still on that
// list. `left` is the ducks that had to go. Undo after "every duck" would put
// a duck off the team back on an empty list, and a duck switched on in the
// profile may be taken off the team before Save changes.
export function takeable(next, others, now) {
  if (next.mode !== "selected")
    return { mode: next.mode, allowed_duck_ids: [], left: [] };
  const onList = now.mode === "selected" ? now.allowed_duck_ids : [];
  const ok = (id) => others.includes(id) || onList.includes(id);
  const ids = next.allowed_duck_ids.filter(ok);
  return {
    mode: ids.length ? "selected" : "none",
    allowed_duck_ids: ids,
    left: next.allowed_duck_ids.filter((id) => !ok(id)),
  };
}

// Every switch is off: nobody on the team can be asked.
const alone = (policy, others) =>
  policy.mode === "none" ||
  (policy.mode === "selected" && !others.some((d) => canAsk(policy, d.id)));

// "Up to 5 asks, one at a time": the two limits in words, or "" for neither.
export function limitsLine(policy) {
  const asks = policy.max_requests_per_task;
  const helpers = policy.max_parallel_requests;
  const parts = [];
  if (asks != null)
    parts.push(asks === 1 ? "one ask" : "up to " + asks + " asks");
  if (helpers != null)
    parts.push(
      helpers === 1 ? "one at a time" : "up to " + helpers + " at a time",
    );
  const line = parts.join(", ");
  return line && line[0].toUpperCase() + line.slice(1);
}

// The line under a duck's name in the grid. The switches beside it already say
// who, so it gives the limits when there are any, and otherwise the gist.
// `others` is the other ducks on the team, as {id, name}.
export function rowLine(policy, others) {
  if (alone(policy, others)) return "Works alone";
  const limits = limitsLine(policy);
  if (limits) return limits;
  if (policy.mode === "all") return "Any duck";
  const n = others.filter((d) => canAsk(policy, d.id)).length;
  return n + " of " + others.length + " ducks";
}

// The line on a folded row, on a phone, where the switches are out of sight.
export function askLine(policy, others) {
  if (alone(policy, others)) return "Works alone";
  if (policy.mode === "all") return "Can ask any duck";
  const names = others.filter((d) => canAsk(policy, d.id)).map((d) => d.name);
  return names.length > 2
    ? "Can ask " + names.length + " ducks"
    : "Can ask " + names.join(" and ");
}

// What a flip on Settings > Ducks says it did, beside its Undo. Turning one
// duck off turns off ducks added later as well, and that is said too, or a
// switch in another column would change without a word.
export function flipSaid(asker, target, on, before) {
  if (target === null)
    return on
      ? asker + " can now ask every duck, now and later."
      : asker + " can no longer ask ducks you add later.";
  if (on) return asker + " can now ask " + target + ".";
  return (
    asker +
    " can no longer ask " +
    target +
    (before.mode === "all" ? ", or ducks you add later." : ".")
  );
}

// What an Undo on Settings > Ducks says it did. `left` is the names of ducks
// off the team that could not go back on the list.
export function undoneSaid(asker, left) {
  if (!left.length)
    return "Undone. Who " + asker + " can ask is back as it was.";
  const names =
    left.length === 1
      ? left[0]
      : left.slice(0, -1).join(", ") + " and " + left[left.length - 1];
  return (
    "Undone, except for " +
    names +
    ": " +
    (left.length === 1 ? "it is" : "they are") +
    " off the team, so " +
    (left.length === 1 ? "it" : "they") +
    " cannot go back on " +
    asker +
    "’s list."
  );
}

// The two limits in the profile, each a short list of set numbers. A number
// set some other way, by the Chief or before this list existed, is shown as
// what it is rather than as a choice it is not.
export const HOW_OFTEN = [
  {
    key: "max_requests_per_task",
    label: "Asks for one piece of work",
    picks: [null, 3, 5, 10],
    say: (n) => (n === null ? "No limit" : "Up to " + n),
  },
  {
    key: "max_parallel_requests",
    label: "Helpers at the same time",
    picks: [null, 1, 2, 3],
    say: (n) =>
      n === null ? "No limit" : n === 1 ? "One at a time" : "Up to " + n,
  },
];
export const ANOTHER = "Another number…";

// The choices a limit's list offers while it holds `value`.
export function limitChoices(limit, value) {
  const picks =
    typeof value === "number" && !limit.picks.includes(value)
      ? [...limit.picks, value].sort((a, b) => (a ?? 0) - (b ?? 0))
      : limit.picks;
  return picks.map((n) => ({
    value: n === null ? "" : String(n),
    text: limit.say(n),
  }));
}

// A number typed in "Another number…": a whole number from 1 to 1000, which is
// what the server keeps, or null when it is not one.
export function typedLimit(text) {
  const t = String(text).trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 1000 ? n : null;
}

// What the profile's Contacts tab holds while it is being changed. A limit is
// a number, null for no limit, or the text typed after "Another number…".
export const formFor = (policy) => ({
  mode: policy.mode,
  allowed_duck_ids: [...policy.allowed_duck_ids],
  chief_can_manage: policy.chief_can_manage,
  max_requests_per_task: policy.max_requests_per_task ?? null,
  max_parallel_requests: policy.max_parallel_requests ?? null,
});
const limitOf = (v) => (typeof v === "string" ? (typedLimit(v) ?? v) : v);
// What the server is sent for a form, or null while a typed limit is not a
// number it would take.
export function toSave(form) {
  const out = { ...form };
  for (const { key } of HOW_OFTEN) {
    out[key] = limitOf(form[key]);
    if (typeof out[key] === "string") return null;
  }
  return out;
}
// Whether the form says something other than what was saved.
export function changed(form, policy) {
  const a = formFor(policy);
  return (
    form.mode !== a.mode ||
    form.chief_can_manage !== a.chief_can_manage ||
    HOW_OFTEN.some(({ key }) => limitOf(form[key]) !== a[key]) ||
    [...form.allowed_duck_ids].sort().join() !==
      [...a.allowed_duck_ids].sort().join()
  );
}

// Whether a grid of `ducks` rows and ducks + 1 columns of switches fits in
// `width` pixels. Past about eight ducks it never does on Settings > Ducks,
// which is 800px at most, and the grid folds into one row per duck as it does
// on a phone, rather than scrolling sideways.
export const gridFits = (width, ducks) =>
  width >= Math.max(560, 88 * (ducks + 1));
