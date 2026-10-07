import fs from "node:fs/promises";
import path from "node:path";
import { db, DATA, permissions, fail } from "./store.mjs";

export const STORAGE_POLICY = "stored-payload-v1";
export const categories = [
  [
    "messages",
    "Messages",
    "Message text, delivery details and attachment references.",
    "messages",
  ],
  [
    "chats",
    "Chats",
    "Direct messages and channels, including archived conversations.",
    "chats",
  ],
  [
    "documents",
    "Documents",
    "Saved document contents and details.",
    "documents",
  ],
  [
    "uploads",
    "Uploaded files",
    "Files people share in chats, stored encrypted.",
    "files",
  ],
  [
    "duck_files",
    "Duck files",
    "Soul, identity and notes files, plus duck profiles.",
    "files",
  ],
  [
    "skills",
    "Skills & history",
    "Skills, assignments and every retained version.",
    "skills and versions",
  ],
  [
    "screenshots",
    "Screenshots",
    "Saved chat captures and the latest computer previews, stored encrypted.",
    "images",
  ],
  [
    "files",
    "Other files",
    "Files saved in company folders and AI working folders.",
    "files",
  ],
  [
    "tasks",
    "Tasks",
    "Ticket descriptions, updates, change history and workflow details.",
    "tasks",
  ],
  [
    "settings",
    "Settings & connections",
    "Company rules, team access, encrypted secrets and connections.",
    "secrets and connections",
  ],
  [
    "activity",
    "Activity & run history",
    "Activity records, tool results and computer checkpoints.",
    "activity entries",
  ],
  ["other", "Other workspace data", "Additional company records.", "records"],
  [
    "ai_runtime",
    "AI runtime files",
    "AI software, caches, logs, session files and sign-in files.",
    "files",
  ],
  [
    "mirrors",
    "Duck file copies",
    "Filesystem copies of the duck files already counted above.",
    "files",
  ],
  [
    "transient",
    "Sign-in sessions",
    "Temporary sessions and connection sign-in records.",
    "records",
  ],
].map(([id, label, description, unit]) => ({ id, label, description, unit }));

const categoryFor = {
  messages: "messages",
  duck_messages: "messages",
  message_reads: "messages",
  human_directs: "chats",
  message_artifacts: "messages",
  inbox: "messages",
  conversations: "chats",
  conversation_members: "chats",
  conversation_ducks: "chats",
  documents: "documents",
  uploads: "uploads",
  upload_notices: "messages",
  ducks: "duck_files",
  skills: "skills",
  skill_versions: "skills",
  duck_skills: "skills",
  computer_captures: "screenshots",
  tasks: "tasks",
  ticket_activity: "tasks",
  task_boards: "tasks",
  board_columns: "tasks",
  board_tasks: "tasks",
  workflow_runs: "tasks",
  workflow_history: "tasks",
  ai_credentials: "settings",
  ai_defaults: "settings",
  duck_models: "settings",
  job_ai: "activity",
  companies: "settings",
  memberships: "settings",
  secrets: "settings",
  secret_groups: "settings",
  connections: "settings",
  connection_oauth: "settings",
  invites: "settings",
  computer_settings: "settings",
  duck_computer_access: "settings",
  audit: "activity",
  jobs: "activity",
  approvals: "activity",
  connection_blocks: "activity",
  skill_proposals: "skills",
  board_proposals: "tasks",
  board_grants: "tasks",
  tool_receipts: "activity",
  computers: "activity",
  computer_actions: "activity",
  computer_usage: "activity",
  computer_events: "activity",
  computer_control: "activity",
  human_requests: "activity",
  human_wait_duck_overrides: "activity",
  company_work_limits: "settings",
  duck_auto_resume_overrides: "settings",
  unfinished_work: "activity",
  task_work_enrollment: "activity",
  duck_work_limit_overrides: "settings",
  sessions: "transient",
  pending_sign_ins: "transient",
  presence: "transient",
  mcp_oauth_flows: "transient",
};
const counted = new Set([
  "messages",
  "conversations",
  "documents",
  "uploads",
  "skills",
  "skill_versions",
  "computer_captures",
  "tasks",
  "secrets",
  "connections",
  "audit",
  "sessions",
  "mcp_oauth_flows",
]);
const parents = {
  conversation_members: ["conversations", "conversation_id"],
  conversation_ducks: ["conversations", "conversation_id"],
  inbox: ["messages", "message_id"],
  tool_receipts: ["jobs", "job_id"],
  connection_oauth: ["connections", "connection_id"],
  mcp_oauth_flows: ["connections", "connection_id"],
  duck_skills: ["ducks", "duck_id"],
  skill_versions: ["skills", "skill_id"],
  computer_actions: ["computers", "computer_id"],
};
const quoted = (value) => '"' + value.replaceAll('"', '""') + '"';
const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
const stamp = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

// Content never leaves the source tables. The ledger holds only ownership, IDs,
// byte lengths and counts. SQL triggers cover every writer, including streaming.
// Rebuildable search indexes duplicate already-counted source payloads. Their
// FTS shadow tables and lookup keys are database overhead, not company content.
const derivedSearchTables = new Set([
  "activity_recall_fts",
  "activity_recall_fts_data",
  "activity_recall_fts_idx",
  "activity_recall_fts_content",
  "activity_recall_fts_docsize",
  "activity_recall_fts_config",
  "activity_recall_search_keys",
  "activity_recall_index_meta",
]);
// The server's own notes about a company, not anything the company made: the
// emails sent about it, what the board email has noticed, when its people were
// last in. Not theirs to count - and counted, the email log could not keep a
// row about a company this database does not know.
// Billing's records are the same: what a company paid and the invoices we
// issued are ours to keep for the tax office, not files the company made.
const serverNotes = new Set([
  "email_log",
  "board_waits",
  "presence",
  "billing_profiles",
  "billing_subscriptions",
  "billing_trials",
  "billing_payments",
  "billing_invoices",
]);
export function createStorage(database, dataDirectory) {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'storage_%'",
    )
    .all()
    .filter(
      ({ name }) => !derivedSearchTables.has(name) && !serverNotes.has(name),
    );
  const descriptors = [];
  for (const { name: table } of tables) {
    const columns = database
      .prepare(`PRAGMA table_info(${quoted(table)})`)
      .all();
    if (
      table !== "companies" &&
      !columns.some((c) => c.name === "company_id") &&
      !parents[table]
    )
      continue;
    const keys = columns
      .filter((c) => c.pk)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    if (!keys.length)
      throw new Error("Storage needs a primary key on " + table);
    const category = categoryFor[table] || "other";
    const owner = (alias) =>
      table === "companies"
        ? `${alias}.id`
        : parents[table]
          ? `(SELECT company_id FROM ${quoted(parents[table][0])} WHERE id=${alias}.${quoted(parents[table][1])})`
          : `${alias}.company_id`;
    const key = (alias) =>
      `json_array(${keys.map((k) => `${alias}.${quoted(k)}`).join(",")})`;
    const make = (source, fields, count) => ({
      table,
      owner,
      key,
      source,
      category,
      scope: category === "transient" ? "supporting" : "workspace",
      count,
      size: (alias) =>
        fields
          .map((c) => `coalesce(length(CAST(${alias}.${quoted(c)} AS BLOB)),0)`)
          .join("+") || "0",
    });
    descriptors.push(
      make(
        "db:" + table,
        columns
          .map((c) => c.name)
          .filter(
            (c) =>
              table !== "ducks" || !["soul", "identity", "notes"].includes(c),
          ),
        counted.has(table) || !categoryFor[table] ? 1 : 0,
      ),
    );
    if (table === "ducks")
      for (const field of ["soul", "identity", "notes"])
        descriptors.push(make("duck-file:" + field, [field], 1));
  }
  const insert = (
    d,
    alias,
  ) => `INSERT INTO storage_items(source,object_id,company_id,category,scope,bytes,item_count,updated_at)
    SELECT ${literal(d.source)},${d.key(alias)},${d.owner(alias)},${literal(d.category)},${literal(d.scope)},${d.size(alias)},${d.count},${stamp}`;
  database.transaction(() => {
    // The server's notes had triggers before they stopped being counted, and
    // a start with no migration to run (after a rollback, say) still has them.
    const noLonger = [...serverNotes].map((table) => ({
      source: "db:" + table,
    }));
    for (const d of [...descriptors, ...noLonger]) {
      const prefix = "storage_" + d.source.replaceAll(/[^a-z_]/g, "_");
      for (const suffix of ["insert", "update", "delete"])
        database.exec(
          `DROP TRIGGER IF EXISTS ${quoted(prefix + "_" + suffix)}`,
        );
      if (!d.table) continue;
      const upsert = `ON CONFLICT(source,object_id) DO UPDATE SET company_id=excluded.company_id,category=excluded.category,scope=excluded.scope,bytes=excluded.bytes,item_count=excluded.item_count,updated_at=excluded.updated_at`;
      database.exec(`CREATE TRIGGER ${quoted(prefix + "_insert")} AFTER INSERT ON ${quoted(d.table)} BEGIN ${insert(d, "NEW")} WHERE ${d.owner("NEW")} IS NOT NULL ${upsert}; END;
        CREATE TRIGGER ${quoted(prefix + "_update")} AFTER UPDATE ON ${quoted(d.table)} BEGIN
          DELETE FROM storage_items WHERE source=${literal(d.source)} AND object_id=${d.key("OLD")} AND object_id<>${d.key("NEW")};
          ${insert(d, "NEW")} WHERE ${d.owner("NEW")} IS NOT NULL ${upsert}; END;
        CREATE TRIGGER ${quoted(prefix + "_delete")} AFTER DELETE ON ${quoted(d.table)} BEGIN
          DELETE FROM storage_items WHERE source=${literal(d.source)} AND object_id=${d.key("OLD")}; END;`);
      // Rebuild at startup: backfills old rows and repairs any out-of-band drift.
      database
        .prepare("DELETE FROM storage_items WHERE source=?")
        .run(d.source);
      database.exec(
        `${insert(d, "r")} FROM ${quoted(d.table)} r WHERE ${d.owner("r")} IS NOT NULL;`,
      );
    }
    // A table that is gone - a migration dropped it - leaves nothing counted.
    database
      .prepare(
        "DELETE FROM storage_items WHERE (source LIKE 'db:%' OR source LIKE 'duck-file:%') AND source NOT IN (SELECT value FROM json_each(?))",
      )
      .run(JSON.stringify(descriptors.map((d) => d.source)));
    for (const [child, [parent, foreignKey]] of Object.entries(parents)) {
      if (!tables.some((t) => t.name === child)) continue;
      const name = quoted("storage_owner_" + child);
      database.exec(`DROP TRIGGER IF EXISTS ${name}; CREATE TRIGGER ${name} AFTER UPDATE OF company_id ON ${quoted(parent)}
        WHEN NEW.company_id<>OLD.company_id BEGIN UPDATE ${quoted(child)} SET ${quoted(foreignKey)}=${quoted(foreignKey)} WHERE ${quoted(foreignKey)}=NEW.id; END;`);
    }
    database
      .prepare(
        "INSERT OR IGNORE INTO storage_meta VALUES('tracking_started_at',?)",
      )
      .run(new Date().toISOString());
  })();

  const pending = new Map();
  const recent = new Map();
  const errors = new Map();
  const itemInsert =
    database.prepare(`INSERT INTO storage_items VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source,object_id) DO UPDATE SET
    company_id=excluded.company_id,category=excluded.category,scope=excluded.scope,bytes=excluded.bytes,item_count=excluded.item_count,updated_at=excluded.updated_at`);
  async function walk(directory, accept) {
    let entries;
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Invalid storage directory");
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (let offset = 0; offset < entries.length; offset += 16) {
      await Promise.all(
        entries.slice(offset, offset + 16).map(async (entry) => {
          const filename = path.join(directory, entry.name);
          if (entry.isDirectory()) return walk(filename, accept);
          // Never follow links into another company or shared system directories.
          if (!entry.isFile()) return;
          try {
            const stat = await fs.lstat(filename);
            if (stat.isFile()) accept(filename, stat.size);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }),
      );
    }
  }
  async function scanFiles(company, { force = false } = {}) {
    if (!database.prepare("SELECT 1 FROM companies WHERE id=?").get(company))
      throw new Error("Company not found");
    // IDs are also directory names; never accept filesystem traversal from data.
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(company))
      throw new Error("Invalid company directory");
    if (pending.has(company)) return pending.get(company);
    if (!force && Date.now() - (recent.get(company) || 0) < 30000) return;
    const task = (async () => {
      try {
        const files = [];
        const root = path.resolve(dataDirectory);
        const add = (
          filename,
          bytes,
          category,
          scope = "workspace",
          count = 1,
        ) =>
          files.push([
            "file",
            path.relative(root, filename),
            company,
            category,
            scope,
            bytes,
            count,
            new Date().toISOString(),
          ]);
        const companyRoot = path.join(root, "companies", company);
        const ducks = new Set(
          database
            .prepare("SELECT id FROM ducks WHERE company_id=?")
            .all(company)
            .map((d) => d.id),
        );
        await walk(companyRoot, (filename, bytes) => {
          const parts = path.relative(companyRoot, filename).split(path.sep);
          // Each upload is already counted by its database record; the file adds its bytes.
          if (parts.length === 2 && parts[0] === "uploads")
            return add(filename, bytes, "uploads", "workspace", 0);
          const mirror =
            parts.length === 3 &&
            parts[0] === "ducks" &&
            ducks.has(parts[1]) &&
            ["soul.md", "identity.md", "notes.md"].includes(parts[2]);
          add(
            filename,
            bytes,
            mirror ? "mirrors" : "files",
            mirror ? "supporting" : "workspace",
          );
        });
        const runtimeRoot = path.join(root, "runtimes", company);
        await walk(runtimeRoot, (filename, bytes) => {
          const runtime =
            path.relative(runtimeRoot, filename).split(path.sep)[1] ===
            ".codex";
          add(
            filename,
            bytes,
            runtime ? "ai_runtime" : "files",
            runtime ? "supporting" : "workspace",
          );
        });
        for (const c of database
          .prepare(
            "SELECT id,screenshot_path FROM computers WHERE company_id=? AND screenshot_path IS NOT NULL",
          )
          .all(company)) {
          const filename = path.join(root, "computer-previews", c.id + ".enc");
          if (path.resolve(c.screenshot_path) !== filename)
            throw new Error("Unexpected preview location");
          try {
            const stat = await fs.lstat(filename);
            if (!stat.isFile()) throw new Error("Invalid preview file");
            add(filename, stat.size, "screenshots");
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
        for (const c of database
          .prepare("SELECT id FROM computers WHERE company_id=?")
          .all(company))
          await walk(
            path.join(root, "computer-control", c.id),
            (filename, bytes) =>
              add(filename, bytes, "ai_runtime", "supporting"),
          );
        const at = new Date().toISOString();
        database.transaction(() => {
          database
            .prepare(
              "DELETE FROM storage_items WHERE source='file' AND company_id=?",
            )
            .run(company);
          for (const row of files) itemInsert.run(...row);
          database
            .prepare(
              "INSERT INTO storage_scans VALUES(?,?) ON CONFLICT(company_id) DO UPDATE SET checked_at=excluded.checked_at",
            )
            .run(company, at);
        })();
        recent.set(company, Date.now());
        errors.delete(company);
      } catch (error) {
        // Keep the last complete measurement. A failed scan must not become zero.
        errors.set(
          company,
          "Saved files could not be fully checked. Their last complete measurement is shown.",
        );
        throw error;
      }
    })();
    pending.set(company, task);
    try {
      return await task;
    } finally {
      pending.delete(company);
    }
  }
  function summary(company) {
    const rows = database
      .prepare(
        "SELECT category,scope,sum(bytes) bytes,sum(item_count) count FROM storage_items WHERE company_id=? GROUP BY category,scope",
      )
      .all(company);
    const breakdown = categories.map((c) => ({
      ...c,
      scope: ["ai_runtime", "mirrors", "transient"].includes(c.id)
        ? "supporting"
        : "workspace",
      bytes: 0,
      count: 0,
      ...rows.find((r) => r.category === c.id),
    }));
    const total = (scope) =>
      breakdown
        .filter((c) => c.scope === scope)
        .reduce((n, c) => n + c.bytes, 0);
    return {
      company_id: company,
      policy: STORAGE_POLICY,
      measured_at: new Date().toISOString(),
      tracking_started_at: database
        .prepare(
          "SELECT value FROM storage_meta WHERE key='tracking_started_at'",
        )
        .get().value,
      files_checked_at:
        database
          .prepare("SELECT checked_at FROM storage_scans WHERE company_id=?")
          .get(company)?.checked_at || null,
      warning: errors.get(company) || null,
      workspace_bytes: total("workspace"),
      supporting_bytes: total("supporting"),
      breakdown,
    };
  }
  function snapshot(company, at = new Date()) {
    const s = summary(company);
    if (!s.files_checked_at || s.warning) return false;
    return !!database
      .prepare(
        "INSERT OR IGNORE INTO storage_snapshots VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        company,
        at.toISOString().slice(0, 13),
        STORAGE_POLICY,
        at.toISOString(),
        s.files_checked_at,
        s.workspace_bytes,
        s.supporting_bytes,
        JSON.stringify(
          s.breakdown.map(({ id, scope, bytes, count }) => ({
            id,
            scope,
            bytes,
            count,
          })),
        ),
      ).changes;
  }
  function history(company) {
    return database
      .prepare(
        `SELECT period,observed_at,workspace_bytes,supporting_bytes FROM storage_snapshots
      WHERE company_id=? AND policy=? ORDER BY period DESC LIMIT 24`,
      )
      .all(company, STORAGE_POLICY)
      .reverse();
  }
  let timer;
  let sweeping = false;
  let sweepDone = Promise.resolve();
  async function sweep() {
    if (sweeping) return;
    sweeping = true;
    try {
      for (const { id: company } of database
        .prepare("SELECT id FROM companies")
        .all()) {
        try {
          await scanFiles(company);
          snapshot(company);
        } catch {
          console.error(
            "Storage file measurement failed for a company; previous totals retained.",
          );
        }
      }
    } finally {
      sweeping = false;
    }
  }
  return {
    scanFiles,
    summary,
    snapshot,
    history,
    sweep,
    start() {
      if (timer) return;
      sweepDone = sweep();
      timer = setInterval(() => {
        sweepDone = sweep();
      }, 5 * 60000);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = null;
      return sweepDone;
    },
  };
}

export function registerStorage(app) {
  const storage = createStorage(db, DATA);
  app.get("/api/storage", async (req, res) => {
    const p = permissions(req.member);
    if (!p.company && !p.billing)
      fail(
        403,
        "Only company admins and billing managers can view storage usage.",
      );
    await storage.scanFiles(req.company.id).catch(() => {});
    storage.snapshot(req.company.id);
    res.json({
      ...storage.summary(req.company.id),
      history: storage.history(req.company.id),
    });
  });
  storage.start();
  return storage;
}
