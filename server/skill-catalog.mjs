import { z } from "zod";
import { db, one, all, run, can, fail, audit, now , DUCK_LIMIT } from "./store.mjs";
import { saveSkill, readSkill } from "./skills.mjs";
import {
  catalogEntries,
  catalogCard,
  catalogEntry,
  catalogSummary,
  catalogContent,
  catalogResources,
} from "./skill-catalog-data.mjs";
import { catalogueText } from "../shared/skill-text.mjs";
const importSchema = z
  .object({ ducks: z.array(z.string().uuid()).max(DUCK_LIMIT).default([]) })
  .strict();
export function listCatalog(company) {
  const installed = new Map(
    all(
      "SELECT catalog_id,skill_id FROM skill_catalog_installs WHERE company_id=?",
      company,
    ).map((row) => [row.catalog_id, row.skill_id]),
  );
  return catalogEntries.map((entry) => ({
    ...catalogCard(entry),
    installedSkillId: installed.get(entry.id) || null,
  }));
}
function requireEntry(id) {
  const entry = catalogEntry(id);
  if (!entry) fail(404, "This catalog skill is unavailable.");
  return entry;
}
export function catalogDetail(id) {
  const entry = requireEntry(id);
  return {
    ...catalogSummary(entry),
    // The publisher's own instructions, as the skill's page shows them:
    // without the block TameDuck puts on top when it is added, and without the
    // name-and-description block written for the software that loads it.
    content: catalogueText(entry.content),
    licenseText: entry.licenseText,
    resources: catalogResources(entry),
    assets: entry.assets,
  };
}
export function installCatalogSkill(company, member, user, catalogId, input) {
  // Handing it to ducks needs nothing more than "skills", the same as in the
  // library and on a duck's profile.
  can(member, "skills");
  const entry = requireEntry(catalogId),
    data = importSchema.parse(input);
  return db.transaction(() => {
    const existing = one(
      "SELECT skill_id FROM skill_catalog_installs WHERE company_id=? AND catalog_id=?",
      company,
      entry.id,
    );
    if (existing) return { id: existing.skill_id, alreadyInstalled: true };
    const saved = saveSkill(company, {
      name: entry.name,
      description: entry.description,
      content: catalogContent(entry),
      enabled: true,
      ducks: data.ducks,
    });
    run(
      "INSERT INTO skill_catalog_installs(company_id,catalog_id,skill_id,publisher,category,source_url,license,revision,installed) VALUES(?,?,?,?,?,?,?,?,?)",
      company,
      entry.id,
      saved.id,
      entry.publisher,
      entry.category,
      entry.sourceUrl,
      entry.license,
      entry.revision,
      now(),
    );
    audit(company, user, "Catalog skill added", {
      name: entry.name,
      catalogId: entry.id,
      publisher: entry.publisher,
      revision: entry.revision,
      ducks: data.ducks,
    });
    return { ...saved, alreadyInstalled: false };
  })();
}
export function readSkillResource(duck, company, input) {
  const { id, path, offset } = z
    .object({
      id: z.string().uuid(),
      path: z.string().min(1).max(500),
      offset: z.number().int().min(0).default(0),
    })
    .parse(input);
  readSkill(duck, company, id);
  const installed = one(
    "SELECT catalog_id FROM skill_catalog_installs WHERE company_id=? AND skill_id=?",
    company,
    id,
  );
  const entry = installed && catalogEntry(installed.catalog_id);
  const resource =
    entry && Object.hasOwn(entry.resources, path) && entry.resources[path];
  if (!resource)
    fail(404, "This supporting text file is not included in the skill.");
  const end = Math.min(offset + 20000, resource.content.length);
  return {
    skill_id: id,
    path,
    content: resource.content.slice(offset, end),
    offset,
    next_offset: end < resource.content.length ? end : null,
    total_characters: resource.content.length,
    source_url: resource.sourceUrl,
  };
}
export function registerSkillCatalog(app) {
  app.get("/api/skill-catalog", (req, res) =>
    res.json({ skills: listCatalog(req.company.id) }),
  );
  app.get("/api/skill-catalog/:id", (req, res) =>
    res.json(catalogDetail(req.params.id)),
  );
  app.post("/api/skill-catalog/:id/install", (req, res) =>
    res.json(
      installCatalogSkill(
        req.company.id,
        req.member,
        req.user.id,
        req.params.id,
        req.body,
      ),
    ),
  );
}
