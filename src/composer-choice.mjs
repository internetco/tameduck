// Who answers in a chat, and what the bar under the message box says about it.
//
// The decisions live here rather than in Chat.jsx so they can be read, and
// tested, on their own. The one they replace: a channel started on "People
// only · no duck response", so the first "draft the post" somebody typed in
// #blog went to nobody, and nothing on the screen said so.

// The answer is this person's, in this browser, the way their theme and their
// last board are. It is not the company's, and no two people in a channel have
// to agree about it.
export const answerKey = (conversation) => "tameduck-answers-" + conversation;
export function rememberedAnswer(conversation) {
  try {
    return globalThis.localStorage?.getItem(answerKey(conversation)) || null;
  } catch {
    return null;
  }
}
export function rememberAnswer(conversation, value) {
  try {
    globalThis.localStorage?.setItem(answerKey(conversation), value);
  } catch {
    // A browser with storage switched off still sends; it asks again next time.
  }
}
// A channel with ducks in it is the only place where who answers is a question,
// so it is the only place the bar asks one. A direct chat with a duck is not a
// question - that duck answers - and a chat between people has nobody to ask.
export const hasPicker = (conversation, ducks) =>
  conversation.kind === "group" && ducks.length > 0;
// Where a conversation starts: with what was said last time, or with nothing.
export const firstAnswer = (conversation) =>
  conversation.kind === "direct"
    ? "all"
    : conversation.kind === "group"
      ? rememberedAnswer(conversation.id)
      : "none";
// Whether the question has an answer at all. A pick kept from last time can
// name a duck that has since left the channel or the team, and that is not an
// answer any more: the bar asks again rather than sending into the void.
export const isAnswered = (selected, ducks) =>
  selected === "none" ||
  selected === "all" ||
  ducks.some((d) => d.id === selected);
// What a message sent from here right now would go to. Only a channel with
// ducks in it can answer "nobody has said" - a channel with none has nobody to
// ask, and a chat with one duck is that duck's chat. Getting this wrong meant
// a channel of people with no duck in it refused to send anything at all.
export function answeringNow(conversation, ducks, selected) {
  if (!ducks.length) return "none";
  if (!hasPicker(conversation, ducks)) return "all";
  return isAnswered(selected, ducks) ? selected : null;
}
// Which ducks a message goes to. Nobody has said, so nothing is sent: that is
// the whole point of the bar, and it is a mistake worth throwing over rather
// than a message that quietly reaches no one.
export function duckIdsFor(who, ducks) {
  if (who === null || who === undefined)
    throw new Error("Nobody has said who answers here yet.");
  return who === "none" ? [] : who === "all" ? ducks.map((d) => d.id) : [who];
}
// The words on the button, which say where the message goes. With one duck in
// the channel "both ducks" means nothing, and with nobody to ask there is
// nothing to say.
export function sendLabelFor(picker, answering, ducks) {
  if (!picker) return "Send";
  if (answering === "none") return "Send to people";
  if (answering === "all")
    return "Send to " + (ducks.length === 2 ? "both ducks" : "all ducks");
  const duck = ducks.find((d) => d.id === answering);
  return "Send to " + (duck ? duck.name : "the duck");
}
// What a run is doing, in the words a person would use for it. "queued" and
// "waiting_consultation" are the server's names for these, not anybody's.
export const doingWord = (status) =>
  status === "queued"
    ? "waiting its turn"
    : status === "waiting_consultation"
      ? "waiting for teammate replies"
      : "working";
// What the bar says while ducks are working here. The strip above the box
// counted them - "1 working · 1 queued" - which named neither the duck nor how
// long it had been at it, and put Stop a screen-width away from the words.
// The name comes back apart from the rest of the sentence, because the name is
// what somebody reads first.
export function runSentences(running, ducks) {
  const said = [];
  for (const word of [
    "working",
    "waiting its turn",
    "waiting for teammate replies",
  ]) {
    const jobs = running.filter((j) => doingWord(j.status) === word);
    if (!jobs.length) continue;
    const names = [
      ...new Set(
        jobs
          .map((j) => ducks.find((d) => d.id === j.duck_id)?.name)
          .filter(Boolean),
      ),
    ];
    const missing = jobs.some((j) => !ducks.some((d) => d.id === j.duck_id));
    const who = missing
      ? jobs.length === 1
        ? "A duck"
        : jobs.length + " runs"
      : names.length === 1
        ? names[0]
        : names.length === 2
          ? names[0] + " and " + names[1]
          : names.length + " ducks";
    const many = jobs.length > 1;
    const tail =
      word === "waiting its turn" && many
        ? names.length === 1 && !missing
          ? ` has ${jobs.length} runs waiting their turns`
          : " are waiting their turns"
        : (missing ? jobs.length === 1 : names.length === 1)
          ? " is " + word
          : " are " + word;
    said.push({ who, tail });
  }
  return said;
}
// How long the one run has been going, in whole minutes. With several there is
// no single number, and the names have the room instead.
export function runMinutes(running, at = Date.now()) {
  if (running.length !== 1) return 0;
  const started = new Date(running[0].created).getTime();
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.floor((at - started) / 60000));
}
