import { all, permissions } from "./store.mjs";
import {
  canConnectAI,
  whoConnectsAI,
  duckRefusal,
} from "../shared/ai-access.mjs";

// Whether a person may start or take over a duck's computer, decided from what
// the AI connection says. With no AI no duck can work, so a computer would only
// cost money - and somebody who takes one over would hand it back to a duck
// that cannot carry on.
//
// Only a certain "no" refuses. When asking the AI itself fails for a moment, the
// answer is connected:false with an error beside it, and refusing somebody's
// takeover over our own hiccup is worse than letting one through. An answer
// that does not say false at all is not a certain no either.
//
// Somebody who can connect one is told to; everybody else is told who can, by
// name - admins can connect one too, and were told to "ask the company owner".
export function refusalWithoutAI(status, member) {
  if (
    status?.connected !== false ||
    status.error ||
    status.codex?.error
  )
    return null;
  return canConnectAI(member?.role, permissions(member))
    ? "Connect an AI first. Without one no duck can work, so computers stay off."
    : "Nobody has connected an AI yet, so no duck can work and computers stay off. Ask " +
        whoConnectsAI(aiConnectors(member?.company_id)) +
        " to connect one.";
}

// What Send, Retry and "Ask duck to work" answer when no duck can work, or null
// when one can. Unlike a computer, a duck's turn needs the AI there and then,
// so a connection that has dropped refuses too - but it is said as what it is,
// and nobody is told to connect what only an owner or admin can.
export const duckRefusalFor = (status, member) =>
  status?.connected
    ? null
    : duckRefusal(status, {
        role: member?.role,
        permissions: permissions(member),
        members: aiConnectors(member?.company_id),
      });

// Everybody in a company, and whether each could connect its AI. The screens
// get the same list, so they name the same people.
export const aiConnectors = (company) =>
  all(
    "SELECT u.name,m.role,m.permissions FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.company_id=? ORDER BY m.rowid",
    company,
  ).map((m) => ({
    name: m.name,
    role: m.role,
    connects_ai: canConnectAI(m.role, permissions(m)),
  }));
