import { z } from "zod";
import {
  db,
  all,
  one,
  run,
  id,
  now,
  json,
  encrypt,
  decrypt,
  audit,
  emit,
  fail,
} from "./store.mjs";
import { assertDuckSecrets } from "./duck-settings.mjs";
export const secretName = z
  .string()
  .trim()
  .min(1, "Give the secret a name.")
  .max(100);
export const secretValue = z
  .string()
  .min(1, "A secret needs a value.")
  .max(16000);
// The allowed list is the whole answer. A duck that saves a secret is put on
// that list when it is created, so it still keeps a password it chose without a
// human granting it afterwards. Reading created_by_duck as a second, silent
// grant meant a person who unticked a duck here was told the access was gone
// while the duck could still read the value, and nothing they could do in the
// interface would ever take it away.
function reachable(secret, duck) {
  return !!secret && json(secret.allowed_ducks).includes(duck);
}
// The activity log is where a person checks what a duck did with a credential,
// so it has to name the duck rather than print its identifier.
const duckName = (duck) =>
  one("SELECT name FROM ducks WHERE id=?", duck)?.name || duck;
export function duckSecret(company, duck, name) {
  const secret = one(
    "SELECT * FROM secrets WHERE company_id=? AND name=?",
    company,
    name,
  );
  if (!reachable(secret, duck))
    fail(
      404,
      "No secret with that name is available to you. Use secret_list to see the ones you can reach.",
    );
  return secret;
}
export function listDuckSecrets(company, duck) {
  assertDuckSecrets(duck, company);
  return all(
    "SELECT id,name,allowed_ducks,created_by_duck,created FROM secrets WHERE company_id=? ORDER BY name",
    company,
  )
    .filter((s) => reachable(s, duck))
    .map((s) => ({
      name: s.name,
      mine: s.created_by_duck === duck,
      created: s.created,
    }));
}
export function saveDuckSecret(
  company,
  duck,
  { name, value, overwrite },
  job = null,
) {
  assertDuckSecrets(duck, company);
  const existing = one(
    "SELECT * FROM secrets WHERE company_id=? AND name=?",
    company,
    name,
  );
  if (existing) {
    // Never silently replace a credential another duck or a human depends on.
    // Only the duck that saved a secret may rotate it: being allowed to use a
    // shared credential is not permission to change what everyone else gets,
    // and the old message here actively invited a duck to overwrite one.
    // The allowed list decides this too. Having created a secret was treated as
    // a standing right to rewrite it, so a person who unticked the duck here
    // stopped it reading the value and left it able to replace one that other
    // ducks and people were still using.
    if (!reachable(existing, duck))
      fail(409, "A secret with that name already exists. Choose another name.");
    if (existing.created_by_duck !== duck)
      fail(
        409,
        "A secret with that name is shared with you but belongs to someone else, so you cannot change its value. Save yours under a different name, or ask a person to update it.",
      );
    if (!overwrite)
      fail(
        409,
        "You already saved a secret with that name. Call again with overwrite true to replace the value you saved.",
      );
    run("UPDATE secrets SET value=? WHERE id=?", encrypt(value), existing.id);
    audit(
      company,
      null,
      "Duck replaced a secret",
      { duck: duckName(duck), name },
      { duck, job },
    );
    emit(company);
    return { name, replaced: true };
  }
  run(
    "INSERT INTO secrets(id,company_id,name,value,allowed_ducks,created,created_by_duck) VALUES(?,?,?,?,?,?,?)",
    id(),
    company,
    name,
    encrypt(value),
    JSON.stringify([duck]),
    now(),
    duck,
  );
  audit(
    company,
    null,
    "Duck saved a secret",
    { duck: duckName(duck), name },
    { duck, job },
  );
  emit(company);
  return { name, replaced: false };
}
export function readDuckSecret(company, duck, name, job = null) {
  assertDuckSecrets(duck, company);
  const secret = duckSecret(company, duck, name);
  audit(
    company,
    null,
    "Duck read a secret",
    { duck: duckName(duck), name },
    { duck, job },
  );
  return decrypt(secret.value);
}
// What a duck writes when it needs a secret: {{secret:name}}, left in the text
// exactly as it typed it. The value is put in here, on the way out to the
// computer, and nowhere else.
//
// The duck used to be handed the value itself and told not to repeat it. That
// asks the model to keep something it can see, and everything the model sees is
// kept: it goes to the provider, into the run journal, and stays there after
// the secret is deleted or rotated. A password should not be readable by the
// thing that only needs it typed.
export const SECRET_PLACEHOLDER = /\{\{\s*secret:([\s\S]{1,100}?)\}\}/g;
export const mentionsSecret = (text) =>
  /\{\{\s*secret:/u.test(String(text ?? ""));
// Substitutes on the way to the computer. Every name goes through the same
// access check a direct read would, so a placeholder cannot reach a secret this
// duck was never given.
export function fillSecrets(company, duck, text, job = null) {
  const source = String(text ?? "");
  // Refuse incomplete or oversized references instead of typing them literally.
  if (mentionsSecret(source.replace(SECRET_PLACEHOLDER, "")))
    fail(
      400,
      "A secret reference is incomplete or too long. Use {{secret:name}} with a saved secret name.",
    );
  const used = [];
  const filled = source.replace(SECRET_PLACEHOLDER, (_, rawName) => {
    const name = secretName.parse(rawName);
    assertDuckSecrets(duck, company);
    const secret = duckSecret(company, duck, name);
    used.push(name);
    return decrypt(secret.value);
  });
  if (used.length)
    audit(
      company,
      null,
      "Duck used a secret",
      { duck: duckName(duck), names: used.join(", ") },
      { duck, job },
    );
  return { text: filled, used };
}
