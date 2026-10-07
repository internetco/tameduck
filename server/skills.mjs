import {
  catalogEntry,
  catalogResources,
  catalogContent,
} from "./skill-catalog-data.mjs";
import { addedSkillText, writtenSkillText } from "../shared/skill-text.mjs";
import { z } from "zod";
import {
  db,
  id,
  now,
  all,
  one,
  run,
  can,
  tenant,
  onTeam,
  fail,
  audit,
  emit,
  json,
  DUCK_LIMIT,
} from "./store.mjs";
export function listSkills(company) {
  return all(
    "SELECT s.id,s.name,s.description,s.enabled,s.version,s.created,s.updated,c.catalog_id,c.publisher,c.category,c.source_url,c.license,c.revision FROM skills s LEFT JOIN skill_catalog_installs c ON c.skill_id=s.id AND c.company_id=s.company_id WHERE s.company_id=? ORDER BY s.name",
    company,
  ).map((s) => ({
    ...s,
    ducks: all("SELECT duck_id FROM duck_skills WHERE skill_id=?", s.id).map(
      (d) => d.duck_id,
    ),
  }));
}
export function skillsFor(duck, company) {
  return all(
    "SELECT s.id,s.name,s.description,s.version FROM skills s JOIN duck_skills ds ON ds.skill_id=s.id WHERE ds.duck_id=? AND s.company_id=? AND s.enabled=1 ORDER BY s.name",
    duck,
    company,
  );
}
export function readSkill(duck, company, skill) {
  const row = one(
    "SELECT s.id,s.name,s.description,s.content,s.version FROM skills s JOIN duck_skills ds ON ds.skill_id=s.id WHERE s.id=? AND s.company_id=? AND ds.duck_id=? AND s.enabled=1",
    skill,
    company,
    duck,
  );
  if (!row) fail(403, "This skill is not enabled and assigned to you.");
  const installed = one(
    "SELECT catalog_id FROM skill_catalog_installs WHERE company_id=? AND skill_id=?",
    company,
    skill,
  );
  const entry = installed && catalogEntry(installed.catalog_id);
  return entry
    ? {
        ...row,
        publisher: entry.publisher,
        source_url: entry.sourceUrl,
        license: entry.license,
        resources: catalogResources(entry),
        assets: entry.assets,
      }
    : row;
}
export const skillSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500),
  content: z.string().trim().min(1).max(60000),
  enabled: z.boolean(),
  ducks: z.array(z.string().uuid()).max(DUCK_LIMIT),
  version: z.number().int().optional(),
});
export function saveSkill(company, input, skillId = null) {
  const a = skillSchema.parse(input);
  const prev = !!skillId ? tenant("skills", skillId, company) : null;
  // A duck taken off the team keeps its grant, so putting it back gives it the
  // skill again. The editor does not show it, and sends it back as it was:
  // that is keeping a grant, not giving one, and refusing it made the skill
  // impossible to save until the duck was put back.
  const had = new Set(
    prev
      ? all("SELECT duck_id FROM duck_skills WHERE skill_id=?", prev.id).map(
          (r) => r.duck_id,
        )
      : [],
  );
  for (const d of a.ducks) if (!had.has(d)) onTeam(d, company);
  if (prev && a.version !== prev.version)
    fail(409, "This skill changed. Reopen it to load the latest version.");
  if (
    !prev &&
    one("SELECT count(*) n FROM skills WHERE company_id=?", company).n >= 100
  )
    fail(400, "This company already has 100 skills.");
  const sid = prev?.id || id(),
    v = (prev?.version || 0) + 1,
    t = now();
  db.transaction(() => {
    if (prev)
      run(
        "UPDATE skills SET name=?,description=?,content=?,enabled=?,version=?,updated=? WHERE id=?",
        a.name,
        a.description,
        a.content,
        +a.enabled,
        v,
        t,
        sid,
      );
    else
      run(
        "INSERT INTO skills(id,company_id,name,description,content,enabled,version,created,updated) VALUES(?,?,?,?,?,?,?,?,?)",
        sid,
        company,
        a.name,
        a.description,
        a.content,
        +a.enabled,
        v,
        t,
        t,
      );
    run(
      "INSERT INTO skill_versions(skill_id,version,content,name,description,created) VALUES(?,?,?,?,?,?)",
      sid,
      v,
      a.content,
      a.name,
      a.description,
      t,
    );
    run("DELETE FROM duck_skills WHERE skill_id=?", sid);
    for (const d of new Set(a.ducks))
      run("INSERT INTO duck_skills VALUES(?,?)", d, sid);
  })();
  return tenant("skills", sid, company);
}

// What a skill's page shows under "What it tells the duck". A skill added from
// the catalogue is compared with the text it was added with, which only the
// server has, so that the block TameDuck wrote is left out only while nobody
// has changed it. A catalogue that cannot be read shows every line instead.
function pageText(skill, provenance) {
  let entry = null;
  try {
    entry = provenance?.catalog_id ? catalogEntry(provenance.catalog_id) : null;
  } catch {}
  return entry
    ? addedSkillText(skill.content, catalogContent(entry), skill.name)
    : writtenSkillText(skill.content, skill.name);
}
export function registerSkills(app) {
  app.get("/api/skills/:id", (req, res) => {
    const skill = tenant("skills", req.params.id, req.company.id);
    const provenance = one(
      "SELECT catalog_id,publisher,category,source_url,license,revision FROM skill_catalog_installs WHERE company_id=? AND skill_id=?",
      req.company.id,
      skill.id,
    );
    res.json({ ...skill, ...provenance, text: pageText(skill, provenance) });
  });
  app.get("/api/skills/:id/versions", (req, res) => {
    can(req.member, "skills");
    tenant("skills", req.params.id, req.company.id);
    res.json(
      all(
        "SELECT * FROM skill_versions WHERE skill_id=? ORDER BY version DESC LIMIT 30",
        req.params.id,
      ),
    );
  });
  for (const method of ["post", "patch"])
    app[method](
      "/api/skills" + (method === "patch" ? "/:id" : ""),
      (req, res) => {
        can(req.member, "skills");
        const saved = saveSkill(
          req.company.id,
          req.body,
          method === "patch" ? req.params.id : null,
        );
        audit(
          req.company.id,
          req.user.id,
          method === "patch" ? "Skill updated" : "Skill created",
          { name: saved.name, version: saved.version },
        );
        res.json(saved);
      },
    );
  // Adding a skill was a one-way door: nothing could remove one, and the
  // library is capped at a hundred, so a company that filled it up - or added
  // one by mistake - was stuck with it for good.
  app.delete("/api/skills/:id", (req, res) => {
    can(req.member, "skills");
    const skill = tenant("skills", req.params.id, req.company.id);
    db.transaction(() => {
      run("DELETE FROM duck_skills WHERE skill_id=?", skill.id);
      run("DELETE FROM skill_versions WHERE skill_id=?", skill.id);
      run(
        "DELETE FROM skill_catalog_installs WHERE company_id=? AND skill_id=?",
        req.company.id,
        skill.id,
      );
      run(
        "DELETE FROM skills WHERE id=? AND company_id=?",
        skill.id,
        req.company.id,
      );
    })();
    audit(req.company.id, req.user.id, "Skill removed", skill.name);
    emit(req.company.id);
    res.json({ ok: true });
  });
  // One tick at a time, which is what the screen actually does: each checkbox
  // saves itself the moment it is pressed. It used to send the whole list, and
  // that list was read once when the panel opened and never refreshed - so two
  // people on the same duck's skills each saved their own snapshot plus their
  // own tick, and the later save silently took away what the earlier one had
  // just granted. Both were told their change had been saved.
  // "Give ducks new skills" is the whole permission for this, as it is in the
  // library. This also asked for "create and configure ducks", so the same
  // person ticking the same skill for the same duck was let through on one
  // screen and refused on another.
  app.put("/api/ducks/:id/skills", (req, res) => {
    can(req.member, "skills");
    const duck = onTeam(req.params.id, req.company.id);
    const a = z
      .object({ skill: z.string().uuid(), enabled: z.boolean() })
      .parse(req.body);
    const skill = tenant("skills", a.skill, req.company.id);
    db.transaction(() => {
      if (a.enabled)
        run("INSERT OR IGNORE INTO duck_skills VALUES(?,?)", duck.id, skill.id);
      else
        run(
          "DELETE FROM duck_skills WHERE duck_id=? AND skill_id=?",
          duck.id,
          skill.id,
        );
      // Who may read a skill is part of the skill, so changing it counts as
      // changing the skill. Without this, somebody with that skill open in the
      // library saved a typo fix and the version check waved it through - the
      // text really had not changed - and the save then put its own stale duck
      // list back, undoing this.
      run(
        "UPDATE skills SET version=version+1,updated=? WHERE id=?",
        now(),
        skill.id,
      );
    })();
    audit(req.company.id, req.user.id, "Duck skills updated", {
      duck: duck.name,
      skill: skill.name,
      allowed: a.enabled,
    });
    emit(req.company.id);
    res.json({ ok: true });
  });
}
