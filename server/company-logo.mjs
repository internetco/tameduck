import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DATA, one, run, can, fail, memberFor, audit } from "./store.mjs";
import { sniff } from "./file-reader.mjs";
import { key } from "./uploads.mjs";

// A company's logo, shown wherever its letter tile was drawn before. At most
// 1 MB, and only PNG, JPEG or WebP - never SVG, which can carry a script. The
// real bytes decide the type, sniffed the same way a chat upload is, never
// the file's name or the browser's declared Content-Type, so a renamed file
// cannot sneak a different kind of file past this.
export const LOGO_MAX_BYTES = 1_000_000;
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

const root = () => path.resolve(DATA);
const logoPath = (companyId) =>
  path.join(root(), "companies", companyId, "logo.bin");

// Same file layout as an upload: 12-byte IV, AES-256-GCM ciphertext, 16-byte
// tag. It sits directly under the company's folder, not its uploads/
// subfolder, so storage.mjs's own periodic scan counts its bytes the way it
// already counts every other company file - nothing extra to track here.
function readLogo(companyId) {
  const raw = fs.readFileSync(logoPath(companyId));
  const d = crypto.createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([
    d.update(raw.subarray(12, raw.length - 16)),
    d.final(),
  ]);
}
function writeLogo(companyId, bytes) {
  const filename = logoPath(companyId);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  fs.writeFileSync(filename, Buffer.concat([iv, body, cipher.getAuthTag()]), {
    mode: 0o600,
  });
}
function removeLogoFile(companyId) {
  fs.rmSync(logoPath(companyId), { force: true });
}

// A logo is small, so the whole body is read into memory and capped as it
// comes in - simpler than a chat upload's streaming pipeline, and enough for
// something this size.
async function readBounded(req, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) fail(413, "Logos can be up to 1 MB.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// version on the URL so the browser fetches the new picture instead of the
// one it already cached under the same address.
export const companyLogoUrl = (company) =>
  company.logo_mime
    ? "/api/company/logo/" + company.id + "?v=" + company.logo_version
    : null;
export const invitationLogoUrl = (token, company) =>
  company.logo_mime
    ? "/api/auth/invitation-logo/" + token + "?v=" + company.logo_version
    : null;

function sendLogo(res, companyId, company) {
  if (!company?.logo_mime) fail(404, "This company has no logo.");
  let body;
  try {
    body = readLogo(companyId);
  } catch {
    fail(410, "This logo could not be loaded from storage.");
  }
  res.set({
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Content-Type": company.logo_mime,
  });
  res.send(body);
}
// The invitation page has no session and no company id of its own - only the
// token the email gave it. This is the same lookup /api/auth/invitation
// already does, so a logo is shown only through a live, unaccepted invite.
export function serveInvitationLogo(res, companyId) {
  sendLogo(
    res,
    companyId,
    one("SELECT logo_mime FROM companies WHERE id=?", companyId),
  );
}

export function registerCompanyLogo(app) {
  const uuid = z.string().uuid();
  app.post("/api/company/logo", async (req, res) => {
    can(req.member, "company");
    const declared = Number(req.get("content-length"));
    if (declared > LOGO_MAX_BYTES) {
      // Stop reading a body we are going to refuse anyway.
      res.set("Connection", "close");
      fail(413, "Logos can be up to 1 MB.");
    }
    const bytes = await readBounded(req, LOGO_MAX_BYTES);
    if (!bytes.length) fail(400, "Choose a picture to upload.");
    const { mime } = sniff("logo", bytes.subarray(0, 8192));
    if (!ALLOWED_MIME.has(mime))
      fail(400, "Logos can be PNG, JPG or WebP pictures.");
    writeLogo(req.company.id, bytes);
    run(
      "UPDATE companies SET logo_mime=?,logo_version=logo_version+1 WHERE id=?",
      mime,
      req.company.id,
    );
    audit(req.company.id, req.user.id, "Company logo changed");
    res.json({ ok: true });
  });
  app.delete("/api/company/logo", (req, res) => {
    can(req.member, "company");
    if (req.company.logo_mime) {
      removeLogoFile(req.company.id);
      run(
        "UPDATE companies SET logo_mime=NULL,logo_version=logo_version+1 WHERE id=?",
        req.company.id,
      );
      audit(req.company.id, req.user.id, "Company logo removed");
    }
    res.json({ ok: true });
  });
  // Any company the signed-in person is a member of, not only the one this
  // session is bound to: the workspace switcher shows every company's own
  // tile, and a session only ever belongs to one company.
  app.get("/api/company/logo/:id", (req, res) => {
    const companyId = uuid.parse(req.params.id);
    if (!memberFor(companyId, req.user.id))
      fail(404, "This company has no logo.");
    sendLogo(
      res,
      companyId,
      one("SELECT logo_mime FROM companies WHERE id=?", companyId),
    );
  });
}
