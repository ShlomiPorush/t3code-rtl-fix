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

// An element placed by a script from its physical left or right keeps its
// sideways movement, such as the centered handle of a color picker.
const SCRIPT_PLACED_SELECTOR = [
  '[style^="left:"]',
  '[style*=" left:"]',
  '[style*=";left:"]',
  '[style^="right:"]',
  '[style*=" right:"]',
  '[style*=";right:"]',
].join(", ");

// Rules that must win over T3 Code's own.
const HIGH_CSS = `
:root[data-t3-rtl-app="on"][data-t3-rtl-loading] body {
  visibility: hidden !important;
}

/* The mirrored copies move an element sideways by --t3-rtl-x times its
   distance (see css-mirror.js): the other way in a right-to-left box, and as
   T3 Code wrote it in a left-to-right island or where a script placed it. */
:root[data-t3-rtl-app="on"] [dir="rtl"] { --t3-rtl-x: -1; }
:root[data-t3-rtl-app="on"] [dir="ltr"] { --t3-rtl-x: 1; }
:root[data-t3-rtl-app="on"] :is(${SCRIPT_PLACED_SELECTOR}) { --t3-rtl-x: 1; }
:root[data-t3-rtl-app="on"] { --t3-rtl-x: -1; }

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
// code, terminals, diffs, the file tree, keyboard keys, and the T3 Code logo,
// whose letters sit next to its mark. An island's own margins follow its new
// direction, so the logo's island is its content, inside the link that keeps
// the room for the window controls. The terminal draws its text on a canvas
// from the left, and the file tree keeps its indentation and arrow keys in
// its own shadow root, so both stay as T3 Code made them.
const LTR_ISLAND_SELECTOR = [
  'a[aria-label="T3 Code home"] > span',
  ".xterm",
  ":has(> textarea.t3-ghostty-input)",
  // The terminal's buttons float over its top right corner, away from where
  // each line starts.
  ':has(> * > button[aria-label^="New Terminal"])',
  "file-tree-container",
  "pre",
  "kbd",
  "diffs-container",
].join(", ");

// Text that the right-to-left layout leaves to its own rules: messages and
// other Markdown, the composer, code, fields, and islands.
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
  "canvas",
  "style",
  "script",
  "template",
  ".xterm",
  "file-tree-container",
  "diffs-container",
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
  // A second run in the same document, such as the launcher's injection into
  // an open page after the new-document script already ran, takes over from
  // the first: the first gives back everything it changed.
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
      disposed: false,
      originalDir: undefined,
      copies: new Map(),
      disabledByFix: new WeakSet(),
      generations: new WeakMap(),
      drag: null,
      observer: null,
      headWaiter: null,
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

    // ---- The fix's own stylesheets ---------------------------------------

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
        head.appendChild(high);
      }
      if (high.textContent !== highCss) high.textContent = highCss;
      return true;
    };

    // ---- Mirrored copies of T3 Code's stylesheets -------------------------

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
      const media = owner.getAttribute("media") || "";
      const existing = state.copies.get(owner);
      if (
        existing &&
        existing.key === key &&
        existing.media === media &&
        existing.sheet === owner.sheet &&
        existing.style.isConnected
      ) {
        return;
      }
      const generation = (state.generations.get(owner) || 0) + 1;
      state.generations.set(owner, generation);
      // Anything that changed while the sheet was read wins over this run.
      const current = () =>
        state.applied && !state.disposed && owner.isConnected && state.generations.get(owner) === generation && ownerKey(owner) === key;
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
          if (!current()) return;
          report("Could not read " + url.href + ": " + error.message);
          removeCopy(owner);
          return;
        }
      } else {
        text = owner.textContent || "";
      }
      if (!current()) return;
      const sheet = owner.sheet;
      // A sheet that is off stays as it is.
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
      // A sheet that imports another, or whose rules were added by script, so
      // its text does not hold them, stays as it is.
      if (result.imports || result.changed === 0 || ownerRules === 0) {
        removeCopy(owner);
        return;
      }
      const style = existing?.style || document.createElement("style");
      style.setAttribute("data-t3-rtl-mirror", "");
      if (media) style.setAttribute("media", media);
      else style.removeAttribute("media");
      if (style.textContent !== result.css) style.textContent = result.css;
      if (owner.nextSibling !== style) owner.after(style);
      // The copy takes over only when it holds as many rules as the sheet.
      let copyRules = -1;
      try {
        copyRules = style.sheet ? style.sheet.cssRules.length : -1;
      } catch {}
      if (copyRules !== ownerRules) {
        report("A mirrored stylesheet did not match its source, so it was left as it was");
        state.copies.set(owner, { style, key, media, sheet: existing?.sheet || null });
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
      state.copies.set(owner, { style, key, media, sheet });
    };

    const mirrorAll = () => {
      const owners = Array.from(document.querySelectorAll('link[rel~="stylesheet"], style')).filter(isStylesheetOwner);
      return Promise.all(owners.map((owner) => mirrorOwner(owner).catch((error) => report(error.message))));
    };

    const unmirrorAll = () => {
      for (const owner of Array.from(state.copies.keys())) removeCopy(owner);
      // A copy whose run ended early is removed with the rest.
      for (const style of document.querySelectorAll("style[data-t3-rtl-mirror]")) style.remove();
    };

    // ---- Left to right islands -------------------------------------------

    // The fix marks what it changed in the page itself, so nothing that T3
    // Code removes is kept alive by the fix.
    const markIslands = (scope) => {
      const found = [];
      // An island can be recognized by content that appears inside it later,
      // such as the terminal's buttons, so the scope's ancestors count too.
      if (scope.nodeType === Node.ELEMENT_NODE) {
        const outer = scope.closest(islandSelector);
        if (outer) found.push(outer);
      }
      if (typeof scope.querySelectorAll === "function") found.push(...scope.querySelectorAll(islandSelector));
      for (const element of found) {
        if (element.hasAttribute("dir")) continue;
        element.setAttribute("dir", "ltr");
        element.setAttribute("data-t3-rtl-island", "");
      }
    };

    const clearIslands = () => {
      for (const element of document.querySelectorAll("[data-t3-rtl-island]")) {
        element.removeAttribute("data-t3-rtl-island");
        if (element.getAttribute("dir") === "ltr") element.removeAttribute("dir");
      }
    };

    // ---- English text in the app's own interface --------------------------

    // Each text node belongs to the paragraph of its nearest box that is not
    // inline. That box gets plaintext, so English text keeps its reading
    // order under the right-to-left root, and its inline parts stay in one
    // paragraph. Excluded parts of the page are skipped whole, and the page is
    // read before anything is written.
    const letter = /\\p{L}/u;
    const excluded = (element) =>
      element.matches(textExcludeSelector) || (element !== root && element.hasAttribute("dir"));
    const filter = {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) return excluded(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        return letter.test(node.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    };
    const markText = (scopes) => {
      const body = document.body;
      if (!body) return;
      const parents = new Set();
      for (const scope of scopes) {
        const start = scope.nodeType === Node.TEXT_NODE ? scope.parentElement : scope;
        if (!start || !start.isConnected || !body.contains(start)) continue;
        const outside = start.closest(textExcludeSelector);
        const directed = start.closest("[dir]");
        if (outside || (directed && directed !== root)) continue;
        if (scope.nodeType === Node.TEXT_NODE) {
          if (letter.test(scope.data)) parents.add(start);
          continue;
        }
        const walker = document.createTreeWalker(start, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, filter);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) parents.add(node.parentElement);
      }
      const marks = new Map();
      for (const parent of parents) {
        let box = parent;
        while (box && box !== body) {
          const display = getComputedStyle(box).display;
          if (display !== "inline" && display !== "contents") break;
          box = box.parentElement;
        }
        if (!box || box === body || marks.has(box) || box.hasAttribute("data-t3-rtl-text")) continue;
        marks.set(box, getComputedStyle(box).textAlign === "start" ? "start" : "");
      }
      for (const [box, value] of marks) box.setAttribute("data-t3-rtl-text", value);
    };

    const clearText = () => {
      for (const element of document.querySelectorAll("[data-t3-rtl-text]")) element.removeAttribute("data-t3-rtl-text");
    };

    const flush = () => {
      state.frame = 0;
      const scopes = Array.from(state.pendingRoots);
      state.pendingRoots.clear();
      if (!state.applied) return;
      for (const scope of scopes) {
        if (scope.isConnected && scope.nodeType === Node.ELEMENT_NODE) markIslands(scope);
      }
      markText(scopes);
    };

    const schedule = (scope) => {
      const element = scope.nodeType === Node.ELEMENT_NODE ? scope : scope.parentElement;
      // A streamed message changes often, and the layout has nothing to do in it.
      if (!element || element.closest(".chat-markdown, .composer-tiptap, .xterm, pre")) return;
      state.pendingRoots.add(scope);
      if (!state.frame) state.frame = requestAnimationFrame(flush);
    };

    // ---- Observing the page -----------------------------------------------

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

    // ---- Resizing -----------------------------------------------------------

    // T3 Code turns the pointer's movement into a width from the side its
    // panels had before the layout was mirrored, so a drag would move the
    // edge the other way. While a resize handle is dragged in the mirrored
    // layout, the pointer's horizontal position is mirrored around where the
    // drag started. The decision is made when the drag starts, and a layout
    // change waits until the drag ends.
    const resizeCursor = /^(?:col-resize|ew-resize|e-resize|w-resize|nwse-resize|nesw-resize|ne-resize|nw-resize|se-resize|sw-resize)$/;
    const resizeHandle = (target) => {
      for (let element = target; element && element !== document.body; element = element.parentElement) {
        if (resizeCursor.test(getComputedStyle(element).cursor)) return element;
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
      const screenX = event.screenX + (x - event.clientX);
      define("clientX", x);
      define("x", x);
      define("pageX", x + window.scrollX);
      define("screenX", screenX);
    };

    const endDrag = () => {
      if (!state.drag) return;
      state.drag = null;
      // T3 Code finishes the drag in its own handlers for this event first.
      setTimeout(() => {
        if (!state.drag && !state.disposed && state.wanted !== state.applied) apply();
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

    // ---- Turning the layout on and off --------------------------------------

    const release = () => {
      clearTimeout(state.loadingTimer);
      root.removeAttribute("data-t3-rtl-loading");
    };

    const undo = () => {
      release();
      unmirrorAll();
      clearIslands();
      clearText();
      if (state.originalDir === null || state.originalDir === undefined) root.removeAttribute("dir");
      else root.setAttribute("dir", state.originalDir);
    };

    const apply = () => {
      if (state.drag || state.disposed) return;
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
        undo();
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
        state.disposed = true;
        if (state.observer) state.observer.disconnect();
        if (state.headWaiter) state.headWaiter.disconnect();
        if (state.frame) cancelAnimationFrame(state.frame);
        for (const remove of state.listeners) remove();
        state.listeners = [];
        if (state.applied) undo();
        else release();
        state.applied = false;
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
      state.headWaiter = new MutationObserver(() => {
        if (!begin()) return;
        state.headWaiter.disconnect();
        state.headWaiter = null;
      });
      state.headWaiter.observe(document, { childList: true, subtree: true });
    }
    // Once the document is parsed, its stylesheet links are waited for, so
    // the page shows when their copies are in place.
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
