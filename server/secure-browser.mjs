import { randomUUID } from "node:crypto";
const frozenForms = new Map();
export async function releaseFormLease(binding) {
  const held = frozenForms.get(binding?.lease_id);
  if (!held) return false;
  if (held.releasing) return held.releasing;
  clearTimeout(held.timer);
  held.releasing = (async () => {
    try {
      await held.cdp
        .send("Emulation.setScriptExecutionDisabled", { value: false })
        .catch(() => {});
      await held.cdp
        .send("Page.setWebLifecycleState", { state: "active" })
        .catch(() => {});
    } finally {
      held.cdp.close();
      held.browser.close();
      frozenForms.delete(binding.lease_id);
    }
    return true;
  })();
  return held.releasing;
}

import http from "node:http";
import WebSocket from "ws";
import { openComputerSocket } from "./computer-relay.mjs";
// Read by somebody who has just typed a password into their duck's screen. It
// used to end "before entering any values", which is advice for a person who
// has not yet done the thing they have already done, and said nothing about
// what became of it.
const stale = () =>
  Object.assign(
    new Error(
      "The page or form changed, so nothing was typed. Ask your duck to open it again.",
    ),
    { status: 409 },
  );
// CDP traffic, including values, travels only inside the verified TLS relay, never in provider commands.
export async function browserFor(c) {
  const streams = new Set();
  const newSocket = async () => {
    const stream = await openComputerSocket(c, 9223);
    streams.add(stream);
    stream.on("close", () => streams.delete(stream));
    return stream;
  };
  const initial = await newSocket();
  const tabs = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: 9223,
        path: "/json/list",
        createConnection: () => initial,
      },
      (res) => {
        let data = "";
        res.on("data", (d) => {
          data += d;
          if (data.length > 1000000) req.destroy();
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(stale());
          }
        });
      },
    );
    req.setTimeout(10000, () => req.destroy());
    req.on("error", () => reject(stale()));
    req.end();
  }).catch((e) => {
    for (const stream of streams) stream.destroy();
    throw e;
  });
  return {
    tabs: tabs.filter((t) => t.type === "page"),
    connect: async (target) => {
      const url = new URL(target.webSocketDebuggerUrl);
      if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
        throw stale();
      const stream = await newSocket();
      return cdpConnect(url.href, { createConnection: () => stream });
    },
    close: () => {
      for (const stream of streams) stream.destroy();
    },
  };
}
export async function cdpConnect(url, options = {}) {
  const ws = new WebSocket(url, options),
    pending = new Map();
  let counter = 0;
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", () => reject(stale()));
    setTimeout(() => {
      if (ws.readyState === 0) ws.terminate();
    }, 10000).unref();
    ws.once("close", () => reject(stale()));
  });
  const failAll = () => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(stale());
    }
    pending.clear();
  };
  ws.on("close", failAll);
  ws.on("error", failAll);
  ws.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    m.error ? p.reject(stale()) : p.resolve(m.result);
  });
  return {
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++counter;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(stale());
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params }), (err) => {
          if (err) {
            clearTimeout(timer);
            pending.delete(id);
            reject(stale());
          }
        });
      }),
    close: () => ws.close(),
  };
}
async function frame(cdp) {
  const current = (await cdp.send("Page.getFrameTree")).frameTree.frame;
  // CDP separates the fragment, including its leading # even when otherwise
  // empty. Compare the full address so an unchanged page can be handed over,
  // while a changed hash route still fails the same identity checks.
  return typeof current.urlFragment === "string"
    ? { ...current, url: current.url + current.urlFragment }
    : current;
}
async function fieldNodes(cdp, fields) {
  const { root } = await cdp.send("DOM.getDocument");
  const result = [];
  for (const field of fields) {
    const { nodeIds } = await cdp.send("DOM.querySelectorAll", {
      nodeId: root.nodeId,
      selector: field.selector,
    });
    if (nodeIds.length !== 1) throw stale();
    const { node } = await cdp.send("DOM.describeNode", { nodeId: nodeIds[0] });
    const { object } = await cdp.send("DOM.resolveNode", {
      nodeId: nodeIds[0],
    });
    result.push({
      backendNodeId: node.backendNodeId,
      objectId: object.objectId,
    });
  }
  return result;
}
const fieldInfo = function (...elements) {
  return elements.map((e) => {
    const allowed =
      e instanceof HTMLTextAreaElement ||
      e instanceof HTMLSelectElement ||
      (e instanceof HTMLInputElement &&
        ![
          "file",
          "hidden",
          "submit",
          "button",
          "image",
          "reset",
          "radio",
          "checkbox",
        ].includes(e.type));
    const action = e.form
      ? new URL(e.form.action || location.href).href
      : location.href;
    if (
      !allowed ||
      !e.isConnected ||
      e.disabled ||
      e.readOnly ||
      !e.getClientRects().length ||
      new URL(action).origin !== location.origin
    )
      throw new Error("invalid");
    return {
      tag: e.tagName,
      type: e.type,
      name: e.name,
      action,
      method: e.form?.method || null,
    };
  });
};
async function infos(cdp, nodes) {
  const r = await cdp.send("Runtime.callFunctionOn", {
    objectId: nodes[0].objectId,
    functionDeclaration: fieldInfo.toString(),
    arguments: nodes.map((n) => ({ objectId: n.objectId })),
    returnByValue: true,
  });
  if (r.exceptionDetails) throw stale();
  return r.result.value;
}
export async function captureForm(
  browser,
  url,
  fields,
  expires = Date.now() + 15 * 60000,
) {
  // Handing the screen over is about preserving what is already there. With
  // fields, the caller names the page it observed. Without them it is asking to
  // freeze wherever it currently is, so take the open page rather than making
  // it name an address it may not have.
  const open = browser.tabs.filter((t) => /^https:\/\//.test(t.url || ""));
  // With fields, the address must be exactly the one the duck observed: the
  // person's typing goes into whatever is found here, so a near miss is not
  // good enough. Without fields it is handing over a screen, and a duck that
  // honestly opened the page can still be looking at a slightly different
  // address than the one it names - a redirect, a dropped www, a tracking
  // parameter. Demanding an exact string there made the feature unusable: a
  // duck passed the address, was told the page had changed, worked out for
  // itself that the tab had dropped the www, passed that instead, and was told
  // to pass an address.
  const path = (u) => {
    try {
      const x = new URL(u);
      return {
        origin: x.origin,
        host: x.hostname.replace(/^www\./, ""),
        at: x.pathname.replace(/\/+$/, ""),
      };
    } catch {
      return null;
    }
  };
  const near = (a, b) => a && b && a.origin === b.origin && a.at === b.at;
  const sameSite = (a, b) => a && b && a.host === b.host && a.at === b.at;
  let matches = open;
  if (url) {
    const wanted = path(url);
    const exact = browser.tabs.filter((t) => t.url === url);
    if (exact.length || fields.length) matches = exact;
    else {
      const ignoringQuery = open.filter((t) => near(path(t.url), wanted));
      matches = ignoringQuery.length
        ? ignoringQuery
        : open.filter((t) => sameSite(path(t.url), wanted));
    }
  }
  if (!matches.length)
    throw url
      ? Object.assign(
          new Error(
            "Nothing open on the computer is at " +
              url +
              ". Open that page yourself, read the address it actually has, and ask again with that one.",
          ),
          { status: 409 },
        )
      : stale();
  // Only ambiguous when nothing was named. A named page that matches several
  // tabs matched them by being the same page, so any of them will do.
  if (!url && matches.length !== 1)
    throw Object.assign(
      new Error(
        "Several pages are open. Pass the address of the one the person should continue on.",
      ),
      { status: 409 },
    );
  const target = matches[0],
    // The address the tab really has. After a redirect that is not the one the
    // duck asked for, and every check below compares against what is there.
    page = target.url,
    cdp = await browser.connect(target);
  try {
    const before = await frame(cdp);
    if (before.url !== page || new URL(page).protocol !== "https:")
      throw stale();
    await cdp.send("Emulation.setScriptExecutionDisabled", { value: true });
    await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
    const current = await frame(cdp);
    if (current.loaderId !== before.loaderId || current.url !== page)
      throw stale();
    const nodes = await fieldNodes(cdp, fields),
      info = nodes.length ? await infos(cdp, nodes) : [];
    if (new Set(nodes.map((n) => n.backendNodeId)).size !== nodes.length)
      throw stale();
    const lease_id = randomUUID();
    const timer = setTimeout(
      () => releaseFormLease({ lease_id }),
      Math.max(1, expires - Date.now()),
    );
    timer.unref();
    frozenForms.set(lease_id, { browser, cdp, timer });
    return {
      lease_id,
      target_id: target.id,
      url: page,
      origin: new URL(page).origin,
      loader_id: current.loaderId,
      nodes: nodes.map((n) => n.backendNodeId),
      info,
    };
  } catch (e) {
    await cdp
      .send("Emulation.setScriptExecutionDisabled", { value: false })
      .catch(() => {});
    await cdp
      .send("Page.setWebLifecycleState", { state: "active" })
      .catch(() => {});
    cdp.close();
    throw e;
  }
}
export async function withBoundForm(
  browser,
  binding,
  fields,
  fn,
  { validateFields = true } = {},
) {
  const target = browser.tabs.find((t) => t.id === binding.target_id);
  if (!target || target.url !== binding.url) throw stale();
  const cdp = await browser.connect(target);
  try {
    const current = await frame(cdp);
    if (current.loaderId !== binding.loader_id || current.url !== binding.url)
      throw stale();
    const nodes = validateFields ? await fieldNodes(cdp, fields) : [];
    if (
      validateFields &&
      (JSON.stringify(nodes.map((n) => n.backendNodeId)) !==
        JSON.stringify(binding.nodes) ||
        JSON.stringify(nodes.length ? await infos(cdp, nodes) : []) !==
          JSON.stringify(binding.info))
    )
      throw stale();
    return await fn(cdp, nodes);
  } finally {
    cdp.close();
  }
}
// beforeWriting is called at the one moment values could start reaching the
// page. Everything before it - finding the tab, matching the fields, turning
// scripts back on - is setup, and a refusal there has typed nothing. The caller
// uses this to tell somebody whose password it is holding which of those two
// happened, rather than saying "may have been applied" about both.
export async function fillBoundForm(
  browser,
  binding,
  fields,
  values,
  { beforeWriting = () => {} } = {},
) {
  return withBoundForm(browser, binding, fields, async (cdp, nodes) => {
    await cdp.send("Emulation.setScriptExecutionDisabled", { value: false });
    beforeWriting();
    const r = await cdp.send("Runtime.callFunctionOn", {
      objectId: nodes[0].objectId,
      functionDeclaration: function (url, info, values, ...elements) {
        if (location.href !== url || elements.length !== values.length)
          throw new Error("stale");
        for (let i = 0; i < elements.length; i++) {
          const e = elements[i],
            f = info[i];
          if (
            !e.isConnected ||
            e.disabled ||
            e.readOnly ||
            e.tagName !== f.tag ||
            e.type !== f.type ||
            e.name !== f.name ||
            (e.form
              ? new URL(e.form.action || location.href).href
              : location.href) !== f.action ||
            (e.form?.method || null) !== f.method
          )
            throw new Error("stale");
          if (
            values[i] !== null &&
            e instanceof HTMLSelectElement &&
            ![...e.options].some((o) => o.value === values[i])
          )
            throw new Error("invalid");
        }
        // Validate everything before the first write; dispatch site events only after all values are set.
        elements.forEach((e, i) => {
          if (values[i] === null) return;
          const proto =
            e instanceof HTMLInputElement
              ? HTMLInputElement.prototype
              : e instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : HTMLSelectElement.prototype;
          Object.getOwnPropertyDescriptor(proto, "value").set.call(
            e,
            values[i],
          );
        });
        elements.forEach((e, i) => {
          if (values[i] === null) return;
          e.dispatchEvent(new Event("input", { bubbles: true }));
          e.dispatchEvent(new Event("change", { bubbles: true }));
        });
        return true;
      }.toString(),
      arguments: [
        { value: binding.url },
        { value: binding.info },
        {
          value: fields.map((f) =>
            Object.hasOwn(values, f.id) ? values[f.id] : null,
          ),
        },
        ...nodes.map((n) => ({ objectId: n.objectId })),
      ],
      returnByValue: true,
    });
    // The page-side function above checks every field before it writes the
    // first one, so its own refusal means nothing reached the page - which is
    // worth carrying back, because by this point the caller has to assume the
    // worst about anything else that goes wrong here.
    if (r.exceptionDetails || r.result.value !== true)
      throw /\b(stale|invalid)\b/.test(
        (r.exceptionDetails?.exception?.description || "") +
          " " +
          (r.exceptionDetails?.exception?.value || "") +
          " " +
          (r.exceptionDetails?.text || ""),
      )
        ? Object.assign(stale(), { nothingTyped: true })
        : Object.assign(new Error("The form did not accept the values."), {
            status: 409,
          });
    await cdp.send("Page.setWebLifecycleState", { state: "active" });
    await releaseFormLease(binding);
  });
}
export async function activateBoundForm(
  browser,
  binding,
  fields,
  { relaxed = false } = {},
) {
  return withBoundForm(
    browser,
    binding,
    fields,
    async (cdp) => {
      // A restored Chromium can keep the native content surface white even
      // after bringToFront, while CDP screenshots contain the intact page. A
      // real tab switch repaints it. Reproduce that visibility transition with
      // one empty target before the viewer is exposed, then remove it again.
      // The original target is never navigated, and its loader is checked after
      // the cycle so a changed page is refused rather than handed to a person.
      let temporary = null;
      try {
        const made = await cdp.send("Target.createTarget", {
          url: "about:blank",
          background: true,
        });
        const candidate = made?.targetId;
        if (!candidate || candidate === binding.target_id) throw stale();
        temporary = candidate;
        // The proven repaint needs the preserved page active while it leaves
        // and re-enters the foreground. Thaw before that exact transition.
        await cdp.send("Emulation.setScriptExecutionDisabled", {
          value: false,
        });
        await cdp.send("Page.setWebLifecycleState", { state: "active" });
        await cdp.send("Target.activateTarget", { targetId: temporary });
        await cdp.send("Target.activateTarget", {
          targetId: binding.target_id,
        });
        const closed = await cdp.send("Target.closeTarget", {
          targetId: temporary,
        });
        if (closed?.success === false) throw stale();
        temporary = null;
        await cdp.send("Page.bringToFront");
        const current = await frame(cdp);
        if (
          current.loaderId !== binding.loader_id ||
          current.url !== binding.url
        )
          throw stale();
      } finally {
        if (temporary) {
          // If activation or cleanup failed after the empty tab took focus,
          // make every best-effort move back toward the protected original.
          await cdp
            .send("Target.activateTarget", { targetId: binding.target_id })
            .catch(() => {});
          await cdp
            .send("Target.closeTarget", { targetId: temporary })
            .catch(() => {});
          await cdp.send("Page.bringToFront").catch(() => {});
        }
      }
      await releaseFormLease(binding);
    },
    { validateFields: !relaxed },
  );
}
// Best-effort thaw on cancel. Never writes input and never follows a replacement target.
export async function thawForm(browser, binding) {
  await releaseFormLease(binding);
  const target = browser.tabs.find((t) => t.id === binding?.target_id);
  if (!target) return;
  const cdp = await browser.connect(target);
  try {
    await cdp.send("Emulation.setScriptExecutionDisabled", { value: false });
    await cdp.send("Page.setWebLifecycleState", { state: "active" });
  } finally {
    cdp.close();
  }
}
