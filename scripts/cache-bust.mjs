// Every build stamps the assets its pages ask for with when it was built:
// /pricing.js becomes /pricing.js?v=20261007182933. A deploy is a build, so
// after one no browser keeps running yesterday's pricing.js against today's
// page - which is how the pricing page's play button once stayed hidden.
//
// Done to the files in dist once Vite has written them: the pages (index.html
// and everything copied from public/, the help pages included) and the
// stylesheets. Only addresses on this site, and only of assets - scripts,
// styles, pictures, fonts, video, sound. Links to pages, other sites, data:
// and anchors are left alone, and so is /assets/: Vite names those files
// after their content, so a new build is a new name already, and a module
// asked for with ?v= while the modules it imports ask for it without would
// be loaded twice, as two different modules.
import fs from "node:fs";
import path from "node:path";

const ASSET =
  /\.(?:js|mjs|css|png|jpe?g|gif|svg|webp|avif|ico|mp4|webm|mp3|ogg|wav|woff2?|ttf|otf|webmanifest|json)$/i;

// The build's time, UTC, to the second: 20261007182933.
export const stampOf = (date = new Date()) =>
  date.toISOString().replace(/\D/g, "").slice(0, 14);

// One address with the stamp in it, or as it was when it is not one of ours.
export function bust(url, stamp) {
  const raw = url.trim();
  if (!raw || raw.startsWith("#") || raw.startsWith("//")) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return url; // https:, data:, mailto:
  const at = raw.indexOf("#");
  const hash = at < 0 ? "" : raw.slice(at);
  const rest = at < 0 ? raw : raw.slice(0, at);
  const q = rest.indexOf("?");
  const file = q < 0 ? rest : rest.slice(0, q);
  // Not one of ours to stamp, or Vite's own output, named after its content.
  if (!ASSET.test(file) || file.startsWith("/assets/")) return url;
  const params = new URLSearchParams(q < 0 ? "" : rest.slice(q + 1));
  params.set("v", stamp);
  return `${file}?${params}${hash}`;
}

// url(...) in a stylesheet, a <style> block or a style attribute.
export const bustCss = (css, stamp) =>
  css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (whole, quote, url) => {
    const next = bust(url, stamp);
    return next === url ? whole : `url(${quote}${next}${quote})`;
  });

// The addresses a page asks for by itself: src, href, poster, srcset, and
// any url(...) in its styles.
export function bustHtml(html, stamp) {
  const attrs = html
    .replace(
      /(\s(?:src|href|poster)\s*=\s*)(["'])([^"']*)\2/gi,
      (whole, before, quote, url) => `${before}${quote}${bust(url, stamp)}${quote}`,
    )
    .replace(
      /(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi,
      (whole, before, quote, list) =>
        `${before}${quote}${list
          .split(",")
          .map((part) => part.replace(/^(\s*)(\S+)/, (m, space, url) => space + bust(url, stamp)))
          .join(",")}${quote}`,
    );
  return bustCss(attrs, stamp);
}

const filesIn = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesIn(full) : [full];
  });

// Stamps every page and stylesheet under `dist`; says how many it changed.
export function bustDist(dist, stamp) {
  let changed = 0;
  for (const file of filesIn(dist)) {
    const kind = path.extname(file).toLowerCase();
    if (kind !== ".html" && kind !== ".css") continue;
    const before = fs.readFileSync(file, "utf8");
    const after = kind === ".html" ? bustHtml(before, stamp) : bustCss(before, stamp);
    if (after !== before) {
      fs.writeFileSync(file, after);
      changed++;
    }
  }
  return changed;
}

// The Vite plugin. TAMEDUCK_BUILD_STAMP sets the stamp, for a test that needs
// to know it; otherwise it is the moment the build finishes.
export function cacheBust({ stamp = process.env.TAMEDUCK_BUILD_STAMP } = {}) {
  let outDir = "dist";
  return {
    name: "tameduck-cache-bust",
    apply: "build",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const value = stamp || stampOf();
      const changed = bustDist(outDir, value);
      console.log(`cache-bust: ?v=${value} on the assets of ${changed} files`);
    },
  };
}
