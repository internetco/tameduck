import path from "node:path";

// What a browser may keep of the files in dist, and for how long. Everything
// not named here gets the hour express.static is given: assets carry a build
// hash in their name, so an hour is safe for them, and so it is for media.

// These public files have no build hash. A cached sign-in script can misread
// a newer API response and reject a still-valid request.
const NEVER_KEPT = new Set([
  "analytics.js",
  "privacy-analytics.js",
  "auth.js",
  "desktop-signin.js",
  "notifications-sw.js",
  "start.html",
  "login.html",
  "enter.html",
  "desktop-signin.html",
]);

export function cacheHeadersFor(root) {
  const dist = path.join(root, "dist");
  return (res, file) => {
    if (NEVER_KEPT.has(path.basename(file))) {
      res.setHeader("Cache-Control", "no-store");
      return;
    }
    // The site's other scripts and styles beside them have no hash either.
    // Kept for an hour, a page could run the script it had before a release:
    // the pricing page's play button stayed hidden for anybody who had opened
    // the page in the hour before its video shipped. no-cache still keeps
    // them, and asks whether they changed - a 304 when they have not.
    if (/\.(js|css)$/.test(file) && path.dirname(file) === dist) {
      res.setHeader("Cache-Control", "no-cache");
      return;
    }
    // index.html is the thing that says which hash is current: cache that
    // and a browser can spend an hour asking for a stylesheet this build no
    // longer ships. "/" is already served fresh; this makes the file behind
    // it agree.
    if (file.endsWith("index.html"))
      res.setHeader("Cache-Control", "public, max-age=0");
  };
}
