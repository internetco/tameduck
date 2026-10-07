// Search on the Help pages: answers drop down under the box while you type,
// and a step that answers the question is offered before the guide it is in.
// The matching itself is shared with the in-app Help panel (help-guides.js).
import { highlight, searchHelp } from "./help-guides.js";

const CONTACT = "info@tameduck.com";
const BOOK =
  '<svg class="icon" width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></svg>';
let loading = null;
const guides = () =>
  (loading ??= fetch("/help/guides.json")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
    .catch(() => {
      loading = null;
      return [];
    }));

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
};
const marked = (text, terms) =>
  highlight(text, terms).map((p) => (p.hit ? el("mark", {}, p.text) : document.createTextNode(p.text)));

function setup(form) {
  const input = form.querySelector("input[type=search]");
  const box = form.querySelector(".search-results");
  let options = [];
  let active = -1;

  const close = () => {
    box.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  };
  const choose = (i) => {
    options.forEach((o, j) => o.setAttribute("aria-selected", String(j === i)));
    active = i;
    if (options[i]) {
      input.setAttribute("aria-activedescendant", options[i].id);
      options[i].scrollIntoView({ block: "nearest" });
    }
  };

  async function show() {
    const query = input.value.trim();
    if (!query) return close();
    const all = await guides();
    if (input.value.trim() !== query) return; // typed on while the list loaded
    const found = searchHelp(all, query);
    box.replaceChildren();
    options = [];
    const option = (href, ...children) => {
      const a = el("a", { class: "result", href, role: "option", id: `${form.id}-o${options.length}`, "aria-selected": "false" }, ...children);
      options.push(a);
      return a;
    };
    if (found.steps.length) {
      box.append(el("p", { class: "results-head" }, "Steps that answer it"));
      for (const r of found.steps)
        box.append(option(`/help/${r.guide.id}#step-${r.number}`,
          el("span", { class: "result-num" }, String(r.number)),
          el("span", { class: "result-text" },
            el("span", { class: "result-title" }, ...marked(r.step.title, found.terms)),
            el("span", { class: "result-where" }, `${r.guide.title} · Step ${r.number}`,
              ...(r.snippet ? [" · “", ...marked(r.snippet, found.terms), "”"] : [])))));
    }
    if (found.guides.length) {
      box.append(el("p", { class: "results-head" }, "Guides"));
      for (const g of found.guides) {
        const book = el("span", { class: "result-num is-guide" });
        book.innerHTML = BOOK;
        box.append(option(`/help/${g.id}`, book,
          el("span", { class: "result-text" },
            el("span", { class: "result-title" }, ...marked(g.title, found.terms)),
            el("span", { class: "result-where" }, `${g.steps.length} steps`))));
      }
    }
    if (!options.length)
      box.append(el("p", { class: "results-none" }, `Nothing about “${query}” yet. Try other words, or email us.`));
    box.append(el("p", { class: "results-foot" },
      el("span", { class: "results-keys" }, el("kbd", {}, "↑"), el("kbd", {}, "↓"), " to move ", el("kbd", {}, "↵"), " to open"),
      el("a", { href: `mailto:${CONTACT}` }, "Can’t find it? Email us")));
    box.hidden = false;
    input.setAttribute("aria-expanded", "true");
    choose(options.length ? 0 : -1);
  }

  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(show, 60);
  });
  input.addEventListener("focus", () => input.value.trim() && show());
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (box.hidden) return show();
      e.preventDefault();
      if (options.length) choose((active + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
    } else if (e.key === "Escape") {
      if (!box.hidden) {
        e.preventDefault();
        close();
      } else input.blur();
    }
  });
  form.addEventListener("submit", (e) => {
    // Enter opens the highlighted answer. With nothing loaded yet, the form
    // still goes to /help?q=…, where the Help home runs the same search.
    if (options[active] && !box.hidden) {
      e.preventDefault();
      location.href = options[active].href;
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!form.contains(e.target)) close();
  });
  return { form, input, show };
}

const searches = [...document.querySelectorAll("form[data-search]")].map(setup);

// A search typed elsewhere arrives as /help?q=…
const asked = new URLSearchParams(location.search).get("q");
const hub = searches.find((s) => s.form.id === "hub-search");
if (asked && hub) {
  hub.input.value = asked;
  hub.input.focus();
  hub.show();
}

// On a narrow screen the header's search folds into a button.
const header = document.querySelector(".site-header");
const toggle = document.querySelector(".search-toggle");
toggle?.addEventListener("click", () => {
  const open = !header.classList.contains("search-open");
  header.classList.toggle("search-open", open);
  toggle.setAttribute("aria-expanded", String(open));
  if (open) header.querySelector("form[data-search] input")?.focus();
});

// "/" jumps to search from anywhere that is not itself a text field.
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return;
  const target = searches.find((s) => s.input.offsetParent !== null) ?? searches[0];
  if (!target) return;
  e.preventDefault();
  if (target.input.offsetParent === null && toggle) toggle.click();
  else target.input.focus();
});
