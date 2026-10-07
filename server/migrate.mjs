// Database migrations.
//
// Every change to the database - its structure, and any one-time change to its
// data - is a numbered file in server/migrations/. Each runs exactly once, in
// number order, inside a transaction, and is written down in
// schema_migrations, so no change runs twice and none is missed. A new
// database is built by running them all; an existing one runs only what it has
// not seen. 0001 is the structure production had when this began.
//
// Before this, modules ran CREATE TABLE IF NOT EXISTS on every start. That
// never changes a table that already exists, so production kept old defaults
// and column orders that a fresh database did not have.
//
//   node server/migrate.mjs status [database]   what has run, what will, and whether it can
//   node server/migrate.mjs new <what-it-does>   start the next migration file
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const Database = createRequire(import.meta.url)("better-sqlite3");
const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS = path.join(here, "migrations");
const PRODUCTION = "/var/lib/tameduck/tameduck.sqlite";
// The server folder of a deployed release: legacy dated staging names or
// a full lowercase commit hash. Build and ready folders are never releases.
export const RELEASE = /^\/opt\/tameduck-releases\/(?:20\d{6}-\d{6}-[a-f0-9]{10}|[a-f0-9]{40})\/server$/;

// Whether two paths are one file: through symlinks and hard links alike.
function sameFile(a, b) {
  try {
    const x = fs.statSync(a), y = fs.statSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return a === b;
  }
}

// The database file for DATA_DIR, or why this code may not open it.
//
// There is no default folder. It used to be the live one, so every test or
// script that forgot DATA_DIR opened production and ran its table setup there.
// And production is opened by a deployed release only: the shared working tree
// holds everybody's unfinished changes, which run the moment they are imported.
export function databaseFile({ env = process.env, code = here, production = PRODUCTION, release = RELEASE } = {}) {
  if (!env.DATA_DIR) throw new Error("DATA_DIR is not set. Point it at a scratch folder: DATA_DIR=$(mktemp -d)");
  fs.mkdirSync(env.DATA_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(fs.realpathSync(env.DATA_DIR), "tameduck.sqlite");
  if (sameFile(file, production) && !release.test(fs.realpathSync(code)))
    throw new Error(
      `${file} is the live database, and this code runs from ${code}, not a deployed release. ` +
        `Use a scratch DATA_DIR, or import from /opt/tameduck-releases/current/server/.`,
    );
  return file;
}

const sum = (text) => crypto.createHash("sha256").update(text).digest("hex");
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
// An empty database in memory, set up the way a migration runs: foreign keys off.
const blank = () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  return db;
};

// storage.mjs rebuilds these from the list of tables and their columns every
// time the server starts, so they follow the tables and are not part of any
// migration. They mention every column, which would stop a migration from
// dropping or changing one, so they are dropped before a migration runs.
const rebuiltAtStart = (row) => row.type === "trigger" && row.name.startsWith("storage_");

// The files, in the order they run. A name is NNNN_what-it-does.sql.
export function migrationFiles(dir = MIGRATIONS) {
  const seen = new Map();
  const out = [];
  for (const file of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
    if (file.startsWith(".")) continue;
    const m = /^(\d{4})_([a-z0-9-]+)\.sql$/.exec(file);
    if (!m) throw new Error(`server/migrations/${file}: a migration is named NNNN_what-it-does.sql`);
    if (seen.has(m[1])) throw new Error(`two migrations are numbered ${m[1]}: ${seen.get(m[1])} and ${file}`);
    seen.set(m[1], file);
    // Windows line endings would end up inside the stored table definitions.
    const sql = fs.readFileSync(path.join(dir, file), "utf8").replace(/\r\n/g, "\n");
    out.push({ id: m[1], name: m[2], file, sql, checksum: sum(sql) });
  }
  return out;
}

// Pending migrations numbered below one this database has already run. Run
// now, they would run in a different order here than on a new database, so the
// two could end up different. One that has not run anywhere can be renumbered.
function lateOnes(pending, done) {
  const last = [...done.keys()].sort().at(-1);
  return pending
    .filter((f) => last && f.id < last)
    .map((f) => ({ ...f, why: `${f.file} is numbered below ${last}, which has already run on this database. Nothing has run it yet, so give it the next free number: git mv server/migrations/${f.file} server/migrations/<next>_${f.name}.sql` }));
}

function recorded(db) {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  return new Map(has ? db.prepare("SELECT * FROM schema_migrations").all().map((r) => [r.id, r]) : []);
}

// Anything TameDuck keeps, whether or not migrations have ever run on it.
function hasTables(db) {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' LIMIT 1")
    .get();
}

// Rows that point at something that is not there, named by their primary key
// and the columns that point: a rebuilt table gives its rows new rowids, and a
// row that was already broken must not look new afterwards.
function brokenReferences(db) {
  const out = new Set();
  for (const r of db.prepare("PRAGMA foreign_key_check").all()) {
    const pk = db.prepare("SELECT name FROM pragma_table_info(?) WHERE pk>0 ORDER BY pk").pluck().all(r.table);
    const row = pk.length && r.rowid != null
      ? db.prepare(`SELECT ${pk.map(quote).join(",")} FROM ${quote(r.table)} WHERE rowid=?`).raw().get(r.rowid)
      : [r.rowid];
    const from = db.prepare("SELECT group_concat(\"from\") FROM pragma_foreign_key_list(?) WHERE id=?").pluck().get(r.table, r.fkid);
    out.add(`${r.table} ${JSON.stringify(row)} ${from} -> ${r.parent}`);
  }
  return out;
}

// Runs a migration on its own, on an empty copy of the structure the earlier
// ones build, to refuse one that would break the one-transaction rule before
// it is let near a real database.
function tryAlone(m, earlier) {
  const scratch = blank();
  try {
    for (const f of earlier) scratch.exec(f.sql);
    scratch.exec("BEGIN");
    scratch.exec(m.sql);
    if (!scratch.inTransaction)
      throw new Error("it ends the transaction itself (COMMIT, END or ROLLBACK). Leave that out: every migration already runs in one transaction.");
  } finally {
    scratch.close();
  }
}

// The structure of a database, for comparing two: every table, index, view
// and trigger as SQLite stores it, minus its own internals, the tables
// full-text search makes for itself, and what storage.mjs rebuilds at start.
export function schemaOf(db) {
  const shadow = new Set(
    db.prepare("SELECT name FROM pragma_table_list WHERE schema='main' AND type='shadow'").all().map((r) => r.name),
  );
  return db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name")
    .all()
    .filter((r) => !r.name.startsWith("sqlite_") && !shadow.has(r.name) && r.name !== "schema_migrations" && !rebuiltAtStart(r));
}

// What differs between two schemaOf() lists, as short lines.
export function schemaDifferences(a, b, [nameA, nameB] = ["one", "the other"]) {
  const index = (list) => new Map(list.map((r) => [`${r.type} ${r.name}`, r.sql]));
  const A = index(a), B = index(b);
  const out = [];
  for (const [k, sql] of A) if (!B.has(k)) out.push(`${k}: only in ${nameA}`);
  else if (B.get(k) !== sql) out.push(`${k}: defined differently`);
  for (const k of B.keys()) if (!A.has(k)) out.push(`${k}: only in ${nameB}`);
  return out;
}

export function migrate(db, { dir = MIGRATIONS, log = (s) => console.log(s), production = PRODUCTION, release = RELEASE } = {}) {
  const files = migrationFiles(dir);
  let done = recorded(db);

  // A migration that has run is history. Editing its file afterwards would make
  // every new database differ from every existing one, without a word.
  for (const f of files) {
    const r = done.get(f.id);
    if (r && r.checksum !== f.checksum)
      throw new Error(`migration ${f.file} was changed after it ran on this database. Put the change in a new migration instead.`);
  }
  for (const [id, r] of done)
    if (!files.some((f) => f.id === id))
      log(`migration ${id}_${r.name} has run on this database but this code does not have it (an older release?)`);
  const pending = files.filter((f) => !done.has(f.id));
  if (!pending.length) return [];
  const late = lateOnes(pending, done);
  if (late.length) throw new Error(late[0].why);
  const ahead = [...done.keys()].filter((id) => !files.some((f) => f.id === id));
  if (ahead.length)
    throw new Error(
      `this database has run ${ahead.join(", ")}, which this code does not have, so it will not run ` +
        `${pending.map((p) => p.file).join(", ")} on top of it.`,
    );

  // Production is changed by a deployed release and nothing else, whoever
  // opened it: the working tree can hold somebody's unfinished migration.
  let file = "";
  try { file = fs.realpathSync(db.name); } catch {}
  const live = sameFile(file, production);
  if (live && !release.test(fs.realpathSync(here)))
    throw new Error(
      `the production database has not run ${pending.map((p) => p.file).join(", ")}, and this code runs from ${here}, ` +
        `not a release. Only tameduck-deploy migrates production.`,
    );

  const ran = [];
  for (const m of pending) {
    // Foreign keys off while it runs, the way SQLite's manual says to change a
    // table: dropping a table with them on silently deletes every row that
    // cascades from it. What the migration leaves behind is checked instead.
    const fk = db.pragma("foreign_keys", { simple: true });
    db.pragma("foreign_keys = OFF");
    let began = false;
    try {
      try {
        db.exec("BEGIN IMMEDIATE");
        began = true;
        db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(
          id TEXT PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL, how TEXT NOT NULL)`);
        // Another process may have run it while this one waited for the lock.
        if (db.prepare("SELECT 1 FROM schema_migrations WHERE id=?").get(m.id)) { db.exec("COMMIT"); continue; }
        // A database from before migrations already has 0001's structure,
        // because 0001 was copied from it. Check that, then record it as run.
        const adopt = m.id === "0001" && !recorded(db).size && hasTables(db);
        if (adopt) {
          const empty = blank();
          let expected;
          try { empty.exec(m.sql); expected = schemaOf(empty); } finally { empty.close(); }
          const diff = schemaDifferences(schemaOf(db), expected, ["this database", m.file]);
          if (diff.length)
            throw new Error(
              `this database from before migrations does not match ${m.file}, so it cannot be adopted. ` +
                (live
                  ? "It is the live database: do NOT delete it. Snapshot it, find out how each difference got there, and change only that. "
                  : "If it is a scratch database, delete it and a new one is built from the migrations. ") +
                `\n  ${diff.slice(0, 20).join("\n  ")}`,
            );
        } else {
          const done = recorded(db);
          tryAlone(m, files.filter((f) => done.has(f.id)));
          for (const t of db.prepare("SELECT type, name FROM sqlite_master WHERE type='trigger'").all())
            if (rebuiltAtStart(t)) db.exec(`DROP TRIGGER ${quote(t.name)}`);
          const before = brokenReferences(db);
          db.exec(m.sql);
          if (!db.inTransaction) throw new Error("it ended the transaction itself (COMMIT, END or ROLLBACK)");
          const after = [...brokenReferences(db)].filter((x) => !before.has(x));
          if (after.length)
            throw new Error(`it would leave ${after.length} row(s) pointing at nothing: ${after.slice(0, 3).join("; ")}`);
        }
        db.prepare("INSERT INTO schema_migrations VALUES(?,?,?,?,?)").run(
          m.id, m.name, m.checksum, new Date().toISOString(), adopt ? "adopted" : "applied");
        db.exec("COMMIT");
        ran.push(m.id);
        log(`migration ${m.file}: ${adopt ? "adopted - this database already had it" : "applied"}`);
      } catch (e) {
        const undone = db.inTransaction;
        if (undone) db.exec("ROLLBACK");
        throw new Error(
          !began || undone
            ? `migration ${m.file} failed and was rolled back, nothing changed: ${e.message}`
            : `migration ${m.file} failed part way, and what it did before that was NOT undone - ` +
                `restore the snapshot tameduck-deploy took just before: ${e.message}`,
        );
      }
    } finally {
      db.pragma(`foreign_keys = ${fk ? "ON" : "OFF"}`);
    }
  }
  return ran;
}

// ---- the command line ----------------------------------------------------------
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, arg, folder] = process.argv.slice(2);
  if (cmd === "new") {
    if (!arg) { console.error("usage: node server/migrate.mjs new <what-it-does>"); process.exit(1); }
    const slug = arg.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const last = migrationFiles().at(-1);
    const id = String(Number(last ? last.id : 0) + 1).padStart(4, "0");
    const file = path.join(MIGRATIONS, `${id}_${slug}.sql`);
    fs.writeFileSync(
      file,
      `-- ${arg}\n--\n-- Runs once, in a transaction, with foreign keys off and checked afterwards.\n` +
        `-- Once this has run anywhere, never edit it: write the next migration instead.\n\n`,
    );
    console.log(path.relative(process.cwd(), file));
  } else if (cmd === "status" || !cmd) {
    const target = arg || path.join(process.env.DATA_DIR || path.dirname(PRODUCTION), "tameduck.sqlite");
    let files;
    try {
      files = migrationFiles(folder || MIGRATIONS);
    } catch (e) {
      console.log(`  REFUSED   ${e.message}`);
      process.exit(1);
    }
    let bad = 0;
    // Each migration still to run is tried on an empty copy of what the ones
    // before it build, so one that cannot run is refused here - before the
    // release that needs it is started.
    const tryPending = (earlier, pending) => {
      earlier = [...earlier];
      for (const f of pending) {
        try {
          tryAlone(f, earlier);
          earlier.push(f);
        } catch (e) {
          bad++;
          console.log(`  WILL FAIL ${f.file}: ${e.message}`);
        }
      }
    };
    if (!fs.existsSync(target)) {
      console.log(target + "  (no database yet: the server builds it from these when it first starts)");
      for (const f of files) console.log(`  pending   ${f.file}`);
      tryPending([], files);
      process.exit(bad ? 1 : 0);
    }
    const db = new Database(target, { readonly: true, fileMustExist: true });
    const done = recorded(db);
    console.log(target + (done.size ? "" : hasTables(db) ? "  (from before migrations)" : "  (empty)"));
    const late = new Set(lateOnes(files.filter((f) => !done.has(f.id)), done).map((f) => f.id));
    for (const f of files) {
      const r = done.get(f.id);
      if (!r && late.has(f.id)) { bad++; console.log(`  TOO LATE  ${f.file}  - numbered below a migration that already ran here; renumber it`); }
      else if (!r) console.log(`  pending   ${f.file}`);
      else if (r.checksum !== f.checksum) { bad++; console.log(`  CHANGED   ${f.file}  - edited after it ran on this database`); }
      else console.log(`  ${r.how.padEnd(9)} ${f.file}  ${r.applied_at}`);
    }
    for (const [id, r] of done)
      if (!files.some((f) => f.id === id)) console.log(`  ahead     ${id}_${r.name}  - this database has run it; this code does not have the file`);
    // Is it what its migrations build? Anything else got there some other way.
    // Not answerable when it has run migrations this code does not have.
    const ahead = [...done.keys()].filter((id) => !files.some((f) => f.id === id));
    if (ahead.length) {
      if (files.some((f) => !done.has(f.id))) {
        bad++;
        console.log(`  REFUSED   the server will not run new migrations on top of ${ahead.join(", ")}, which this code does not have`);
      }
      console.log("  not compared: this database has run migrations this code does not have");
      process.exit(bad ? 1 : 0);
    }
    const before = !done.size && hasTables(db);
    const applied = files.filter((f) => done.has(f.id) || (before && f.id === "0001"));
    tryPending(applied, files.filter((f) => !applied.includes(f) && !late.has(f.id)));
    const built = blank();
    for (const f of files) if (done.has(f.id) || (before && f.id === "0001")) built.exec(f.sql);
    const drift = schemaDifferences(schemaOf(db), schemaOf(built), ["this database", "its migrations"]);
    built.close();
    if (before && !drift.length) console.log("  0001 will be adopted: this database matches it");
    if (drift.length && before) {
      bad++;
      console.log(`  CANNOT ADOPT 0001 - this database differs from it, so the server would not start:`);
    } else if (drift.length) console.log(`  DRIFT     ${drift.length} difference(s) from what its migrations build - made outside a migration:`);
    for (const d of drift.slice(0, 30)) console.log(`            ${d}`);
    process.exit(bad ? 1 : 0);
  } else {
    console.error("usage: node server/migrate.mjs status [database] [migrations folder] | new <what-it-does>");
    process.exit(1);
  }
}
