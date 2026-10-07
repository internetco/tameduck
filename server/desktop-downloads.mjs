import fs from "node:fs";
import path from "node:path";

const versionPattern = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const filePattern = /^TameDuck-[a-zA-Z0-9._-]+\.(?:dmg|exe|zip|blockmap)$/;
const platforms = {
  windows: { route: "windows", extension: ".exe" },
  macArm64: { route: "mac-arm64", extension: ".dmg" },
  macIntel: { route: "mac-x64", extension: ".dmg" },
  macUniversal: { route: "mac", extension: ".dmg" },
};

function readJson(file) {
  try {
    if (fs.statSync(file).size > 65536) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Only a regular file beneath the release directory can be served. Downloads
// live outside Git and deployments, so changing website releases keeps them.
function regularFile(directory, ...parts) {
  if (!directory) return null;
  try {
    const root = fs.realpathSync(directory);
    const file = path.join(root, ...parts);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    if (!fs.realpathSync(file).startsWith(root + path.sep)) return null;
    return { file, size: stat.size };
  } catch {
    return null;
  }
}

export function desktopDownloads(
  directory,
  manifest = directory && readJson(path.join(directory, "manifest.json")),
) {
  const version = versionPattern.test(manifest?.version || "")
    ? manifest.version
    : null;
  const result = { version, platforms: {} };
  for (const [name, spec] of Object.entries(platforms)) {
    const artifact = manifest?.platforms?.[name];
    const valid =
      version &&
      filePattern.test(artifact?.file || "") &&
      artifact.file.endsWith(spec.extension) &&
      /^[a-f0-9]{64}$/.test(artifact.sha256 || "") &&
      Number.isSafeInteger(artifact.size) &&
      artifact.size > 0;
    const file = valid && regularFile(directory, version, artifact.file);
    result.platforms[name] = {
      available: !!file && file.size === artifact.size,
      url: `/downloads/desktop/${spec.route}`,
      ...(file && file.size === artifact.size
        ? {
            sha256: artifact.sha256,
            size: file.size,
            signed: artifact.signed === true,
          }
        : {}),
    };
  }
  return result;
}

export function registerDesktopDownloads(app, options = {}) {
  const directory =
    options.directory ||
    process.env.DESKTOP_RELEASES_DIR ||
    (process.env.DATA_DIR &&
      path.join(process.env.DATA_DIR, "desktop-releases"));
  app.get("/api/desktop-downloads", (_req, res) => {
    res.set("Cache-Control", "no-store").json(desktopDownloads(directory));
  });
  app.get("/downloads/desktop/:platform", (req, res) => {
    res.set("Cache-Control", "no-store");
    const name = Object.keys(platforms).find(
      (key) => platforms[key].route === req.params.platform,
    );
    const manifest =
      directory && readJson(path.join(directory, "manifest.json"));
    if (
      !name ||
      !desktopDownloads(directory, manifest).platforms[name].available
    )
      return res
        .status(404)
        .send("This desktop download is not available yet.");
    const record = regularFile(
      directory,
      manifest.version,
      manifest.platforms[name].file,
    );
    if (!record) return res.status(404).end();
    res.set("X-Content-Type-Options", "nosniff");
    res.download(record.file, manifest.platforms[name].file);
  });
  app.get("/downloads/releases/:version/:file", (req, res) => {
    if (
      !versionPattern.test(req.params.version) ||
      !filePattern.test(req.params.file)
    )
      return res.status(404).end();
    const record = regularFile(directory, req.params.version, req.params.file);
    if (!record) return res.status(404).end();
    res.set({
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
    res.download(record.file, req.params.file);
  });
  // Preview builds have no update feed. Publication enables a platform only
  // after signed installers and their update metadata have been verified.
  app.get("/downloads/updates/:file", (req, res) => {
    const name = req.params.file;
    const enabled =
      directory && readJson(path.join(directory, "updates-enabled.json"));
    const allowed =
      name === "latest-mac.yml"
        ? enabled?.mac === true
        : name === "latest.yml"
          ? enabled?.windows === true
          : filePattern.test(name) &&
            (enabled?.mac === true || enabled?.windows === true);
    if (!allowed) return res.status(404).end();
    const record = regularFile(directory, "updates", name);
    if (!record) return res.status(404).end();
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.sendFile(record.file);
  });
}
