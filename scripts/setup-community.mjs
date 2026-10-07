#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = process.cwd();
const file = path.join(root, ".env");
const setup = crypto.randomBytes(32).toString("base64url");
const hash = crypto.createHash("sha256").update(setup).digest("hex");
const values = fs.readFileSync(path.join(root, ".env.example"), "utf8")
  .replace(/^ENCRYPTION_KEY=$/m, "ENCRYPTION_KEY=" + crypto.randomBytes(32).toString("hex"))
  .replace(/^SETUP_TOKEN_HASH=$/m, "SETUP_TOKEN_HASH=" + hash);
try {
  fs.writeFileSync(file, values, { flag: "wx", mode: 0o600 });
} catch (error) {
  if (error.code === "EEXIST") {
    console.error("A .env already exists. Keep its encryption key and data together; setup will not replace it.");
    process.exit(1);
  }
  throw error;
}
console.log("Created a private .env. Configure SMTP before inviting users.");
console.log("After building and starting the app, open this one-time owner setup link:");
console.log("http://localhost:3000/setup#" + setup);
console.log("Keep this link private. Preserve .env with your backups.");
