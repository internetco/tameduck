// What a company may have at once: one fixed set of limits - how many ducks,
// and how many computers may run together - with no plans or trials behind it.
import { one } from "./store.mjs";

const LIMITS = Object.freeze({ ducks: 50, computerScale: 1, runningAtOnce: 10 });

export const companyPlan = () => ({ plan: LIMITS, trial: null });
export const duckLimitFor = () => LIMITS.ducks;
// What a full flock is told. `to` is who reads it: the person, or a duck who
// will pass it on.
export function flockFullMessage(company, { to = "person", name = "" } = {}) {
  const room = name
    ? `Take another duck off the team before putting ${name} back.`
    : to === "duck"
      ? "Ask the person to take one off the team from the Team page to make room"
      : "Take one off the team from the Team page to make room";
  return name
    ? `This company already has ${LIMITS.ducks} ducks on the team, which is the most it can have at once. ${room}`
    : `This company can have ${LIMITS.ducks} ducks at a time${to === "duck" ? " and it is full" : ""}. ${room}.`;
}
export function flockIsFull(company) {
  return (
    one(
      "SELECT count(*) n FROM ducks WHERE company_id=? AND removed=0",
      company,
    ).n >= LIMITS.ducks
  );
}
