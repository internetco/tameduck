import path from "node:path";
import fs from "node:fs";

const file = (root, name) => path.join(root, "dist", name + ".html");

/** Register the browser pages shared by hosted and app-only distributions. */
export function registerWebPages(app, { root, signedIn, appOnly = false }) {
  appOnly ||= readDistribution(root)?.edition === "community";
  const send = (name, status = 200) => (req, res) => {
    res.status(status).sendFile(file(root, name));
  };

  app.get("/", (req, res) => {
    const page = appOnly ? (signedIn(req) ? "index" : "enter") :
      signedIn(req) ? "index" : "home";
    res.sendFile(file(root, page));
  });

  for (const page of ["start", "login", "enter", "desktop-signin"]) {
    app.get("/" + page, (req, res) => {
      res.set("Cache-Control", "no-store");
      res.sendFile(file(root, page));
    });
  }
  app.get("/password", (_req, res) => res.redirect("/login"));

  if (!appOnly) {
    for (const page of ["pricing", "privacy", "terms"])
      app.get("/" + page, send(page));
    app.get("/demo.html", send("demo"));
    // The website's home page for somebody signed in, for whom "/" is the
    // workspace: the TameDuck mark in the app leads here from their chats.
    // Their way back is in the nav, where a signed-out visitor has Sign in.
    app.get("/home", async (req, res, next) => {
      if (!signedIn(req)) return res.redirect("/");
      try {
        const html = await fs.promises.readFile(file(root, "home"), "utf8");
        res.set("Cache-Control", "no-store");
        res.set("X-Robots-Tag", "noindex");
        res.type("html").send(html.replace('<a href="/login">Sign in</a>', '<a href="/">Open TameDuck</a>'));
      } catch (error) {
        next(error);
      }
    });
  } else {
    for (const page of ["privacy", "terms", "about"]) {
      app.get("/" + page, (req, res, next) => {
        res.sendFile(file(root, page), error => error ? res.sendStatus(404) : undefined);
      });
    }
    for (const page of ["pricing", "demo.html"])
      app.get("/" + page, (_req, res) => res.sendStatus(404));
  }

  const helpRoot = path.join(root, "dist", "help");
  const sendHelp = name => (_req, res, next) => {
    res.set("Cache-Control", "no-cache");
    res.sendFile(path.join(helpRoot, name), error => {
      if (error?.status === 404) res.sendStatus(404);
      else if (error) next(error);
    });
  };
  app.get(["/help", "/help/"], sendHelp("index.html"));
  app.get("/help/guides.json", sendHelp("guides.json"));
  app.get("/help/help.css", sendHelp("help.css"));
  for (const guide of ["connect-ai", "create-first-duck", "first-task", "needs-you", "computers", "files", "task-board", "team", "webhooks"])
    app.get("/help/" + guide, sendHelp(guide + ".html"));
  // Missing documentation assets must not fall through to the application shell.
  app.use("/help", (_req, res) => res.sendStatus(404));

  app.get("/{*path}", (req, res, next) => {
    const target = file(root, "index");
    res.sendFile(target, (error) => error ? next(error) : undefined);
  });
}

export function readDistribution(root, { env = process.env } = {}) {
  const markerPath = path.join(root, "dist", "distribution.json");
  if (!fs.existsSync(markerPath)) return null;
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  if (!marker || marker.edition !== "community")
    throw new Error("invalid distribution marker");
  const sourceUrl = env.PUBLIC_SOURCE_URL || marker.sourceUrl;
  if (sourceUrl) {
    const url = new URL(sourceUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error("PUBLIC_SOURCE_URL must be an HTTP(S) source location without credentials");
  }
  return { edition: "community", license: marker.license, sourceUrl };
}

export function registerWebPageGuards(app, { root }) {
  // Stable help filenames revalidate after a release, including static assets.
  app.use("/help", (_req, res, next) => {
    res.set("Cache-Control", "no-cache");
    next();
  });
  const distribution = readDistribution(root);
  if (distribution?.edition !== "community") return;
  app.get("/source", (_req, res) => distribution.sourceUrl
    ? res.redirect(distribution.sourceUrl) : res.sendStatus(404));
  for (const route of ["/home.html", "/pricing.html", "/pricing.js", "/demo.js", "/demo.html"]) {
    app.all(route, (_req, res) => res.sendStatus(404));
  }
  app.use("/demo", (_req, res) => res.sendStatus(404));
}
