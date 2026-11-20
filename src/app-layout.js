"use strict";

const { mirrorCss } = require("./css-mirror");

const LAYOUT_KEY = "__t3RtlLayout";
const LAYOUT_EVENT = "t3-rtl-layout";

// Rules under the fix's own layer, which the page declares before T3 Code's
// layers, so any alignment T3 Code sets on an element wins over them. Only
// the alignment an element inherits is replaced.
const LOW_CSS = `@layer t3-rtl-layout {
  :root[data-t3-rtl-app="on"] [data-t3-rtl-text] {
    unicode-bidi: plaintext;
  }
  :root[data-t3-rtl-app="on"] [data-t3-rtl-text="start"] {
    text-align: right;
  }
}`;

// Icons that point to a side. T3 Code's own icons that already turn in a
// right-to-left document carry an rtl: class and are left alone.
const SIDE_ICON_SELECTOR = [
  "chevron-left",
  "chevron-right",
  "chevrons-left",
  "chevrons-right",
  "chevron-first",
  "chevron-last",
  "arrow-left",
  "arrow-right",
  "arrow-left-to-line",
  "arrow-right-to-line",
  "panel-left",
  "panel-right",
  "panel-left-open",
  "panel-left-close",
  "panel-right-open",
  "panel-right-close",
  "move-left",
  "move-right",
].map((name) => `svg.lucide-${name}`).join(", ");

// Rules that must win over T3 Code's own.
const HIGH_CSS = `
:root[data-t3-rtl-app="on"][data-t3-rtl-loading] body {
  visibility: hidden !important;
}

/* An icon that points to a side is mirrored. Its rotation, such as an open
   chevron that points down, turns the other way too (see css-mirror.js). */
:root[data-t3-rtl-app="on"] :is(${SIDE_ICON_SELECTOR}):not([class*="rtl:"]):not([dir="ltr"] *) {
  scale: -1 1;
  --t3-rtl-turn: -1;
}

/* The heading of a new thread is one English sentence whose project name and
   question mark are separate flex items, so it keeps its reading order. */
:root[data-t3-rtl-app="on"] [class~="group/draft-hero"] > h1 {
  direction: ltr;
}

/* Inputs outside messages read their value and placeholder in their own
   order. A placeholder sits on the right, with the layout. */
:root[data-t3-rtl-app="on"] :is(input, textarea):not([dir]):not([dir="ltr"] *):not(.composer-tiptap *) {
  unicode-bidi: plaintext;
}
:root[data-t3-rtl-app="on"] :is(input, textarea):not([dir]):not([dir="ltr"] *):not(.composer-tiptap *):placeholder-shown {
  text-align: right;
}
`;

// Parts of the app that stay left to right inside the right-to-left layout:
// code, terminals, diffs, keyboard keys, and the T3 Code logo, whose letters
// sit next to its mark. An island's own margins follow its new direction, so
// the logo's island is its content, inside the link that keeps the room for
// the window controls.
const LTR_ISLAND_SELECTOR = [
  'a[aria-label="T3 Code home"] > span',
  ".xterm",
  "pre",
  "kbd",
  "diffs-container",
].join(", ");

// Text that the right-to-left layout leaves to its own rules: messages and
// other Markdown, the composer, code, fields, and anything with a direction
// of its own.
const TEXT_EXCLUDE_SELECTOR = [
  ".chat-markdown",
  ".composer-tiptap",
  "pre",
  "code",
  "kbd",
  "textarea",
  "input",
  "select",
  "[contenteditable]",
  "svg",
  "style",
  "script",
  "template",
  ".xterm",
].join(", ");

function buildLayoutSource({ enabled }) {
  return `(() => {
  if (window.top !== window) return;
  const key = ${JSON.stringify(LAYOUT_KEY)};
  const eventName = ${JSON.stringify(LAYOUT_EVENT)};
  const lowCss = ${JSON.stringify(LOW_CSS)};
  const highCss = ${JSON.stringify(HIGH_CSS)};
  const islandSelector = ${JSON.stringify(LTR_ISLAND_SELECTOR)};
  const textExcludeSelector = ${JSON.stringify(TEXT_EXCLUDE_SELECTOR)};
  const mirrorCss = ${mirrorCss.toString()};

  const wanted = ${JSON.stringify(enabled === true)};
  const previous = globalThis[key];
  if (previous) previous.dispose();

  // A new document gets this script before it has a root element.
  if (!document.documentElement) {
    const waiter = new MutationObserver(() => {
      if (!document.documentElement) return;
      waiter.disconnect();
      main();
    });
    waiter.observe(document, { childList: true });
    return;
  }
  main();

  function main() {
  const root = document.documentElement;
  const state = {
    wanted,
    applied: null,
    originalDir: undefined,
    copies: new Map(),
    disabledByFix: new WeakSet(),
    generations: new WeakMap(),
    islands: new Set(),
    texts: new Set(),
    drag: null,
    observer: null,
    pendingRoots: new Set(),
    frame: 0,
    loadingTimer: 0,
    reported: new Set(),
    listeners: [],
  };

  const report = (message) => {
    if (state.reported.has(message)) return;
    state.reported.add(message);
    console.warn("[t3-rtl-fix] " + message);
  };

  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    state.listeners.push(() => target.removeEventListener(type, handler, options));
  };

  const ownNode = (node) =>
    node.hasAttribute("data-t3-rtl-mirror") ||
    node.hasAttribute("data-t3-rtl-layout") ||
    /^t3-(?:rtl|extras)/.test(node.id || "");

  // ---- The fix's own stylesheets -----------------------------------------

  const ensureStyles = () => {
    const head = document.head;
    if (!head) return false;
    let low = document.getElementById("t3-rtl-layout-low");
    if (!low) {
      low = document.createElement("style");
      low.id = "t3-rtl-layout-low";
      low.setAttribute("data-t3-rtl-layout", "");
      low.textContent = lowCss;
    }
    // The fix's layer is declared first, so it is the weakest layer.
    if (head.firstChild !== low) head.insertBefore(low, head.firstChild);
    let high = document.getElementById("t3-rtl-layout-high");
    if (!high) {
      high = document.createElement("style");
      high.id = "t3-rtl-layout-high";
      high.setAttribute("data-t3-rtl-layout", "");
      high.textContent = highCss;
      head.appendChild(high);
    }
    return true;
  };

  // ---- Mirrored copies of T3 Code's stylesheets ---------------------------

  const ownerKey = (owner) => (owner.localName === "link" ? owner.href : owner.textContent);

  const isStylesheetOwner = (node) =>
    node.nodeType === Node.ELEMENT_NODE &&
    ((node.localName === "link" && /(^|\\s)stylesheet(\\s|$)/i.test(node.rel || "")) || node.localName === "style") &&
    !ownNode(node);

  const removeCopy = (owner) => {
    const copy = state.copies.get(owner);
    if (!copy) return;
    state.copies.delete(owner);
    copy.style.remove();
    // Only a sheet the fix turned off is turned on again.
    if (copy.sheet && state.disabledByFix.has(copy.sheet)) {
      state.disabledByFix.delete(copy.sheet);
      copy.sheet.disabled = false;
    }
  };

  const mirrorOwner = async (owner) => {
    if (!state.applied || !owner.isConnected) return;
    const key = ownerKey(owner);
    const existing = state.copies.get(owner);
    if (existing && existing.key === key && existing.sheet === owner.sheet && existing.style.isConnected) return;
    const generation = (state.generations.get(owner) || 0) + 1;
    state.generations.set(owner, generation);
    const isLink = owner.localName === "link";
    let text;
    if (isLink) {
      // A sheet that has not loaded yet is mirrored from its load event.
      if (!owner.sheet) return;
      let url;
      try {
        url = new URL(owner.href);
      } catch {
        return;
      }
      if (url.origin !== location.origin) return;
      try {
        const response = await fetch(url.href);
        if (!response.ok) throw new Error("status " + response.status);
        text = await response.text();
      } catch (error) {
        report("Could not read " + url.href + ": " + error.message);
        removeCopy(owner);
        return;
      }
    } else {
      text = owner.textContent || "";
    }
    // The world changed while the sheet was read.
    if (!state.applied || !owner.isConnected || state.generations.get(owner) !== generation || ownerKey(owner) !== key) return;
    const sheet = owner.sheet;
    // A sheet that is off, or whose rules were added by script, so its text
    // does not hold them, stays as it is.
    if (!sheet || (sheet.disabled && !state.disabledByFix.has(sheet))) {
      removeCopy(owner);
      return;
    }
    let ownerRules;
    try {
      ownerRules = sheet.cssRules.length;
    } catch {
      removeCopy(owner);
      return;
    }
    const result = mirrorCss(text, { baseUrl: isLink ? owner.href : document.baseURI });
    if (result.imports || result.changed === 0 || ownerRules === 0) {
      removeCopy(owner);
      return;
    }
    const style = existing?.style || document.createElement("style");
    style.setAttribute("data-t3-rtl-mirror", "");
    if (owner.media) style.media = owner.media;
    else style.removeAttribute("media");
    if (style.textContent !== result.css) style.textContent = result.css;
    if (owner.nextSibling !== style) owner.after(style);
    // The copy takes over only when it holds the same rules as the sheet.
    let copyRules = -1;
    try {
      copyRules = style.sheet ? style.sheet.cssRules.length : -1;
    } catch {}
    if (copyRules !== ownerRules) {
      report("A mirrored stylesheet did not match its source, so it was left as it was");
      state.copies.set(owner, { style, key, sheet: existing?.sheet || null });
      removeCopy(owner);
      return;
    }
    if (existing?.sheet && existing.sheet !== sheet && state.disabledByFix.has(existing.sheet)) {
      state.disabledByFix.delete(existing.sheet);
    }
    if (!sheet.disabled) {
      sheet.disabled = true;
      state.disabledByFix.add(sheet);
    }
    state.copies.set(owner, { style, key, sheet });
  };

  const mirrorAll = () => {
    const owners = Array.from(document.querySelectorAll('link[rel~="stylesheet"], style')).filter(isStylesheetOwner);
    return Promise.all(owners.map((owner) => mirrorOwner(owner).catch((error) => report(error.message))));
  };

  const unmirrorAll = () => {
    for (const owner of Array.from(state.copies.keys())) removeCopy(owner);
  };

  // ---- Left to right islands ---------------------------------------------

  const markIslands = (scope) => {
    const found = [];
    if (scope.nodeType === Node.ELEMENT_NODE && scope.matches(islandSelector)) found.push(scope);
    if (typeof scope.querySelectorAll === "function") found.push(...scope.querySelectorAll(islandSelector));
    for (const element of found) {
      if (element.hasAttribute("dir")) continue;
      element.setAttribute("dir", "ltr");
      state.islands.add(element);
    }
  };

  const clearIslands = () => {
    for (const element of state.islands) {
      if (element.getAttribute("dir") === "ltr") element.removeAttribute("dir");
    }
    state.islands.clear();
  };

  // ---- English text in the app's own interface ----------------------------

  // Each text node belongs to the paragraph of its nearest box that is not
  // inline. That box gets plaintext, so English text keeps its reading order
  // under the right-to-left root, and its inline parts stay in one paragraph.
  const letter = /\\p{L}/u;
  const markText = (scope) => {
    const body = document.body;
    if (!body) return;
    const start = scope.nodeType === Node.TEXT_NODE ? scope.parentElement : scope;
    if (!start || !body.contains(start)) return;
    const walker = document.createTreeWalker(start, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!letter.test(node.data)) continue;
      const parent = node.parentElement;
      if (!parent || seen.has(parent)) continue;
      seen.add(parent);
      if (parent.closest(textExcludeSelector)) continue;
      const directed = parent.closest("[dir]");
      if (directed && directed !== root) continue;
      let box = parent;
      while (box && box !== body) {
        const display = getComputedStyle(box).display;
        if (display !== "inline" && display !== "contents") break;
        box = box.parentElement;
      }
      if (!box || box === body || box.hasAttribute("data-t3-rtl-text")) continue;
      const align = getComputedStyle(box).textAlign;
      box.setAttribute("data-t3-rtl-text", align === "start" ? "start" : "");
      state.texts.add(box);
    }
  };

  const clearText = () => {
    for (const element of state.texts) element.removeAttribute("data-t3-rtl-text");
    state.texts.clear();
  };

  const flush = () => {
    state.frame = 0;
    if (!state.applied) {
      state.pendingRoots.clear();
      return;
    }
    const roots = Array.from(state.pendingRoots);
    state.pendingRoots.clear();
    for (const scope of roots) {
      if (!scope.isConnected) continue;
      markIslands(scope);
      markText(scope);
    }
  };

  const schedule = (scope) => {
    state.pendingRoots.add(scope);
    if (!state.frame) state.frame = requestAnimationFrame(flush);
  };

  // ---- Observing the page -------------------------------------------------

  const watch = () => {
    if (state.observer) return;
    state.observer = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target;
        if (record.type === "attributes") {
          if (isStylesheetOwner(target)) void mirrorOwner(target);
          continue;
        }
        const style = (target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement)?.closest?.("style");
        if (style && isStylesheetOwner(style)) {
          void mirrorOwner(style);
          continue;
        }
        for (const node of record.removedNodes) {
          if (state.copies.has(node)) removeCopy(node);
        }
        for (const node of record.addedNodes) {
          if (isStylesheetOwner(node)) {
            void mirrorOwner(node);
            continue;
          }
          if (node.nodeType === Node.ELEMENT_NODE && node.hasAttribute("data-t3-rtl-mirror")) continue;
          if (node.nodeType === Node.ELEMENT_NODE && typeof node.querySelectorAll === "function") {
            for (const nested of node.querySelectorAll('link[rel~="stylesheet"], style')) {
              if (isStylesheetOwner(nested)) void mirrorOwner(nested);
            }
          }
          if (state.applied) schedule(node);
        }
        if (record.type === "characterData" && state.applied) schedule(target);
      }
    });
    state.observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["href", "media", "rel"],
    });
    // A stylesheet link is mirrored once its sheet has loaded.
    listen(document, "load", (event) => {
      if (isStylesheetOwner(event.target)) void mirrorOwner(event.target);
    }, true);
  };

  // ---- Resizing --------------------------------------------------------------

  // T3 Code turns the pointer's movement into a width from the side its
  // panels had before the layout was mirrored, so a drag would move the edge
  // the other way. While a resize handle is dragged in the mirrored layout,
  // the pointer's horizontal position is mirrored around where the drag
  // started. The decision is made when the drag starts, and a layout change
  // waits until the drag ends.
  const horizontalResize = /^(?:col-resize|ew-resize|e-resize|w-resize)$/;
  const resizeHandle = (target) => {
    for (let element = target; element && element !== document.body; element = element.parentElement) {
      if (horizontalResize.test(getComputedStyle(element).cursor)) return element;
      if (element.matches("button, [role=separator], a, input")) break;
    }
    return null;
  };

  const mirrorPointer = (event, x) => {
    const define = (name, value) => {
      try {
        Object.defineProperty(event, name, { configurable: true, value });
      } catch {}
    };
    define("clientX", x);
    define("x", x);
    define("pageX", x + window.scrollX);
    define("screenX", event.screenX + (x - event.clientX));
  };

  const endDrag = () => {
    if (!state.drag) return;
    state.drag = null;
    // T3 Code finishes the drag in its own handlers for this event first.
    setTimeout(() => {
      if (!state.drag && state.wanted !== state.applied) apply();
    }, 0);
  };

  const onPointerDown = (event) => {
    if (event.button !== 0 || state.drag) return;
    const handle = resizeHandle(event.target);
    if (!handle) return;
    state.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      mirror: state.applied === true && !handle.closest('[dir="ltr"]'),
    };
  };

  const onPointerMove = (event) => {
    const drag = state.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.mirror) mirrorPointer(event, 2 * drag.startX - event.clientX);
    if (event.type !== "pointermove") endDrag();
  };

  listen(window, "pointerdown", onPointerDown, true);
  listen(window, "pointermove", onPointerMove, true);
  listen(window, "pointerup", onPointerMove, true);
  listen(window, "pointercancel", onPointerMove, true);
  listen(window, "lostpointercapture", (event) => {
    if (state.drag && event.pointerId === state.drag.pointerId) endDrag();
  }, true);
  listen(window, "blur", endDrag);

  // ---- Turning the layout on and off ----------------------------------------

  const release = () => {
    clearTimeout(state.loadingTimer);
    root.removeAttribute("data-t3-rtl-loading");
  };

  const apply = () => {
    if (state.drag) return;
    const on = state.wanted;
    if (state.applied === on) return;
    state.applied = on;
    if (on) {
      if (state.originalDir === undefined) state.originalDir = root.getAttribute("dir");
      root.setAttribute("dir", "rtl");
      root.setAttribute("data-t3-rtl-app", "on");
      ensureStyles();
      void mirrorAll().finally(() => {
        if (document.readyState !== "loading") release();
      });
      if (document.body) schedule(document.body);
    } else {
      release();
      unmirrorAll();
      clearIslands();
      clearText();
      if (state.originalDir === null || state.originalDir === undefined) root.removeAttribute("dir");
      else root.setAttribute("dir", state.originalDir);
      root.setAttribute("data-t3-rtl-app", "off");
    }
    window.dispatchEvent(new CustomEvent(eventName, { detail: { on } }));
  };

  globalThis[key] = {
    set(on) {
      state.wanted = on === true;
      apply();
      return state.applied;
    },
    dispose() {
      if (state.observer) state.observer.disconnect();
      if (state.frame) cancelAnimationFrame(state.frame);
      for (const remove of state.listeners) remove();
      state.listeners = [];
      release();
    },
  };

  const begin = () => {
    if (!document.head) return false;
    ensureStyles();
    watch();
    apply();
    return true;
  };

  // A new document has no head yet. It stays hidden while its stylesheets
  // are mirrored, at most briefly, so it does not show T3 Code's layout
  // turned halfway.
  if (wanted && !document.body) {
    root.setAttribute("data-t3-rtl-loading", "");
    state.loadingTimer = setTimeout(release, 1500);
  }
  if (!begin()) {
    const waiter = new MutationObserver(() => {
      if (begin()) waiter.disconnect();
    });
    waiter.observe(document, { childList: true, subtree: true });
  }
  // Once the document is parsed, its stylesheet links are waited for, so the
  // page shows when their copies are in place.
  const sheetLoaded = (link) =>
    link.sheet
      ? Promise.resolve()
      : new Promise((resolve) => {
          link.addEventListener("load", resolve, { once: true });
          link.addEventListener("error", resolve, { once: true });
        });
  if (document.readyState === "loading") {
    listen(document, "DOMContentLoaded", () => {
      if (!state.applied) return;
      ensureStyles();
      schedule(document.body);
      const links = Array.from(document.querySelectorAll('link[rel~="stylesheet"]')).filter(isStylesheetOwner);
      void Promise.all(links.map(sheetLoaded))
        .then(mirrorAll)
        .finally(release);
    }, { once: true });
  }
  }
})();`;
}

module.exports = { LAYOUT_EVENT, LAYOUT_KEY, buildLayoutSource };
