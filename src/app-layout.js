"use strict";

const { mirrorCss } = require("./css-mirror");

const LAYOUT_KEY = "__t3RtlLayout";
const LAYOUT_EVENT = "t3-rtl-layout";

// Rules under the fix's own layer, which the page declares before T3 Code's
// layers, so any alignment T3 Code sets on an element wins over them. Only
// the alignment an element inherits is replaced.
//
// plaintext keeps English text in its reading order, but it would also turn
// a "start" alignment to the left. match-parent takes the parent's alignment
// with its start read in the parent's direction: right in the right-to-left
// layout, and still centered inside a centered parent.
const LOW_CSS = `@layer t3-rtl-layout {
  :root[data-t3-rtl-app="on"] [data-t3-rtl-text] {
    unicode-bidi: plaintext;
    text-align: -webkit-match-parent;
    text-align: match-parent;
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

// A box with an automatic direction that holds icons is a layout, such as a
// hover card, not a line of text.
const LAYOUT_AUTO_SELECTOR = '[dir="auto"]:has(svg)';

// Rows of the composer menu that read left to right, by the prefix of the
// item id T3 Code gives each row.
const COMPOSER_LTR_ITEM_SELECTORS = ["skill:", "slash:", "provider-slash-command:", "model:"].map(
  (prefix) => `[data-composer-item-id^="${prefix}"]`,
);

// The floating browser or device preview over the conversation, and the grip
// that holds its buttons and moves it.
const MINI_PLAYER_SELECTOR = "[data-preview-mini-player]";
const MINI_PLAYER_GRIP_SELECTOR = `${MINI_PLAYER_SELECTOR} > .group`;

// Rules that must win over T3 Code's own.
const HIGH_CSS = `
:root[data-t3-rtl-app="on"][data-t3-rtl-loading] body {
  visibility: hidden !important;
}

/* The mirrored copies move an element sideways by --t3-rtl-x times its
   distance (see css-mirror.js): the other way in a right-to-left box, and as
   T3 Code wrote it in a left-to-right island or where a script placed it.
   Inside a placed element, each box follows its own direction again. */
:root[data-t3-rtl-app="on"] [dir="rtl"] { --t3-rtl-x: -1; }
:root[data-t3-rtl-app="on"] [dir="ltr"] { --t3-rtl-x: 1; }
:root[data-t3-rtl-app="on"] :is(${SCRIPT_PLACED_SELECTOR}) { --t3-rtl-x: 1; }
:root[data-t3-rtl-app="on"] :is(${SCRIPT_PLACED_SELECTOR}) :dir(rtl) { --t3-rtl-x: -1; }
:root[data-t3-rtl-app="on"] :is(${SCRIPT_PLACED_SELECTOR}) :dir(ltr) { --t3-rtl-x: 1; }
:root[data-t3-rtl-app="on"] :is(${SCRIPT_PLACED_SELECTOR}) :is(${SCRIPT_PLACED_SELECTOR}) { --t3-rtl-x: 1; }
:root[data-t3-rtl-app="on"] { --t3-rtl-x: -1; }

/* T3 Code places the floating preview from the left of the conversation, on
   the side where it keeps the conversation clear of it, which is the end of
   the conversation. The layout moves that end to the left, so the layer that
   holds the preview is mirrored, and the preview is turned back inside it.
   The page in the preview follows the preview's place on the screen. The
   layer keeps the preview in front of the conversation, as its own parts
   were. */
:root[data-t3-rtl-app="on"] :has(> ${MINI_PLAYER_SELECTOR}):dir(rtl) {
  scale: -1 1;
  z-index: 49;
}
:root[data-t3-rtl-app="on"] :has(> ${MINI_PLAYER_SELECTOR}):dir(rtl) > ${MINI_PLAYER_SELECTOR} {
  scale: -1 1;
}
/* A browser page is drawn outside the preview, between the preview's
   background and its buttons. The layer draws the whole preview above the
   page, so the background, which is solid in some themes, lets the page
   show through. Its shadow stays. */
:root[data-t3-rtl-app="on"] :has(> ${MINI_PLAYER_SELECTOR}):dir(rtl) > ${MINI_PLAYER_SELECTOR}:has(> [data-browser-surface-slot]) > [class~="z-[47]"] {
  background-color: transparent;
}
/* Its corner handles move to the other corners, so their cursors slant the
   other way. */
:root[data-t3-rtl-app="on"] :has(> ${MINI_PLAYER_SELECTOR}):dir(rtl) :is([data-preview-mini-player-resize="northeast"], [data-preview-mini-player-resize="southwest"]) {
  cursor: nwse-resize;
}
:root[data-t3-rtl-app="on"] :has(> ${MINI_PLAYER_SELECTOR}):dir(rtl) :is([data-preview-mini-player-resize="northwest"], [data-preview-mini-player-resize="southeast"]) {
  cursor: nesw-resize;
}

/* Every icon turns the other way, so a down chevron that T3 Code rotates to
   point right, as on a closed project, points left (see css-mirror.js). An
   icon that is the same both ways round is mirrored by that alone. */
:root[data-t3-rtl-app="on"] svg.lucide:not([class*="rtl:"]):dir(rtl) {
  --t3-rtl-turn: -1;
}

/* An icon that points to a side is mirrored. Its rotation, such as an open
   chevron that points down, turns the other way too (see css-mirror.js). */
:root[data-t3-rtl-app="on"] :is(${SIDE_ICON_SELECTOR}):not([class*="rtl:"]):dir(rtl) {
  scale: -1 1;
  --t3-rtl-turn: -1;
}

/* The heading of a new thread is one English sentence whose project name and
   question mark are separate flex items, so it keeps its reading order. */
:root[data-t3-rtl-app="on"] [class~="group/draft-hero"] > h1 {
  direction: ltr;
}

/* A box that T3 Code aligns to its start with a class aligns to the start of
   the layout too, not of its English text. */
:root[data-t3-rtl-app="on"] [data-t3-rtl-text]:is(.text-left, .text-start) {
  text-align: -webkit-match-parent;
  text-align: match-parent;
}

/* English text that the per-block rule turned left to right inside the
   right-to-left layout, such as a thread title in the sidebar or a work log
   row, sits on the right like the rest of its row, also where T3 Code aligns
   it to its start. Messages keep their side, and centered text stays
   centered. */
:root[data-t3-rtl-app="on"] :dir(rtl) > :is([dir="auto"], [dir="ltr"]:is(.text-start, .text-left)):dir(ltr):not(.chat-markdown, .chat-markdown *, .text-center, [data-t3-rtl-island]) {
  text-align: -webkit-match-parent;
  text-align: match-parent;
}

/* A popup that T3 Code lets take its direction from its first text, such as
   a thread's hover card, is laid out with the app. Its first text is often an
   English project name, which would put its icons on the left. Each line
   still reads in its own order (see markText), and an English title in it
   sits on the right. */
:root[data-t3-rtl-app="on"] :is(${LAYOUT_AUTO_SELECTOR}) {
  direction: rtl;
}
:root[data-t3-rtl-app="on"] :where(${LAYOUT_AUTO_SELECTOR}) [dir="ltr"]:not([data-t3-rtl-island], [data-t3-rtl-island] *) {
  text-align: -webkit-match-parent;
  text-align: match-parent;
}

/* A command, skill, or model row of the composer menu reads left to right.
   Its name and description each keep their own reading order, so a Hebrew
   description still reads from its start, and stay on the left, next to
   each other. The full description, shown in a tooltip outside the menu
   while its row is highlighted, sits on the side where its text starts. */
:root[data-t3-rtl-app="on"] [data-composer-item-id][data-t3-rtl-island] span:not(:has(*)) {
  unicode-bidi: plaintext;
  text-align: left;
}
:root[data-t3-rtl-app="on"]:has([data-composer-item-id][data-t3-rtl-island] [data-popup-open]) [data-slot="tooltip-popup"] {
  text-align: start !important;
}

/* A path or branch name keeps its order and sits on the right of a
   right-to-left row. */
:root[data-t3-rtl-app="on"] :dir(rtl) > [data-t3-rtl-island]:has(> span.peer.whitespace-pre + span.whitespace-pre) {
  justify-content: flex-end;
}

/* An English thread title sits next to its project in the header. */
:root[data-t3-rtl-app="on"] nav[aria-label="Thread breadcrumb"] :is(h2, input):dir(ltr) {
  text-align: right;
}

/* Inputs outside messages read their value in its own order, and a
   placeholder sits on the right, with the layout. An English placeholder
   gets a left-to-right mark at its end from the fix, so its punctuation
   stays there (see markPlaceholders). */
:root[data-t3-rtl-app="on"] :is(input, textarea):not([dir]):dir(rtl):not(.composer-tiptap *) {
  unicode-bidi: plaintext;
}
:root[data-t3-rtl-app="on"] :is(input, textarea):not([dir]):dir(rtl):not(.composer-tiptap *):placeholder-shown {
  text-align: right;
}

/* The comment on quoted text has dir="auto" from the fix, which is left to
   right while the field is empty. */
:root[data-t3-rtl-app="on"] [data-citation-comment-editor="true"] textarea:placeholder-shown {
  text-align: right !important;
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
  // The floating preview's buttons sit in its top right corner, held by a
  // grip that T3 Code places from that corner.
  MINI_PLAYER_GRIP_SELECTOR,
  // A previewed page is placed and scaled from its top left corner inside
  // its viewport, which T3 Code also scrolls from the left, so in the
  // mirrored layout the page would leave the viewport.
  "[data-preview-viewport]",
  "file-tree-container",
  // T3 Code shows a long path or branch name as its head and its tail side
  // by side, with the middle cut, so the two parts keep their order.
  ":has(> span.peer.whitespace-pre + span.whitespace-pre)",
  "pre",
  "kbd",
  "diffs-container",
  // Commands, skills, and models in the composer menu are English
  // identifiers with English descriptions, so their rows keep T3 Code's
  // layout. Threads, files, and pull requests in the same menu can be titled
  // in Hebrew, so they stay with the app. Each row is its own element, so a
  // mark never carries over to a row of another kind.
  ...COMPOSER_LTR_ITEM_SELECTORS,
].join(", ");

// Parts of T3 Code's own interface inside an island that are laid out with
// the app again, such as the device toolbar over a previewed page.
const RTL_RETURN_SELECTOR = "[data-preview-viewport] [data-browser-device-toolbar]";

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
  const returnSelector = ${JSON.stringify(RTL_RETURN_SELECTOR)};
  const textExcludeSelector = ${JSON.stringify(TEXT_EXCLUDE_SELECTOR)};
  const scriptPlacedSelector = ${JSON.stringify(SCRIPT_PLACED_SELECTOR)};
  const miniPlayerSelector = ${JSON.stringify(MINI_PLAYER_SELECTOR)};
  const miniPlayerGripSelector = ${JSON.stringify(MINI_PLAYER_GRIP_SELECTOR)};
  const layoutAutoSelector = ${JSON.stringify(LAYOUT_AUTO_SELECTOR)};
  const mirrorCss = ${mirrorCss.toString()};

  const wanted = ${JSON.stringify(enabled === true)};
  // A second run in the same document, such as the launcher's injection into
  // an open page after the new-document script already ran, takes over from
  // the first: the first gives back everything it changed.
  const previous = globalThis[key];
  if (previous) previous.dispose();

  // A new document gets this script before it has a root element. The run
  // that waits for it is registered at once, so a later run replaces it.
  if (!document.documentElement) {
    let pending = wanted;
    const waiter = new MutationObserver(() => {
      if (!document.documentElement) return;
      waiter.disconnect();
      main(pending);
    });
    waiter.observe(document, { childList: true });
    globalThis[key] = {
      set(on) {
        pending = on === true;
        return null;
      },
      dispose() {
        waiter.disconnect();
      },
    };
    return;
  }
  main(wanted);

  function main(wanted) {
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
      islands: [],
      findBars: new WeakSet(),
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
        state.applied && !state.disposed && owner.isConnected && state.generations.get(owner) === generation && ownerKey(owner) === key &&
        (owner.getAttribute("media") || "") === media;
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
      const mark = (selector, dir, attribute) => {
        const found = [];
        // An island can be recognized by content that appears inside it
        // later, such as the terminal's buttons, so the scope's ancestors
        // count too.
        if (scope.nodeType === Node.ELEMENT_NODE) {
          const outer = scope.closest(selector);
          if (outer) found.push(outer);
        }
        if (typeof scope.querySelectorAll === "function") found.push(...scope.querySelectorAll(selector));
        for (const element of found) {
          if (element.hasAttribute("dir")) continue;
          element.setAttribute("dir", dir);
          element.setAttribute(attribute, "");
          // A weak reference finds the element again if T3 Code moves it out
          // of the page and back, without keeping it alive.
          state.islands.push(new WeakRef(element));
        }
      };
      mark(islandSelector, "ltr", "data-t3-rtl-island");
      mark(returnSelector, "rtl", "data-t3-rtl-return");
    };

    // T3 Code enables the buttons that scroll the right panel's tabs from
    // scrollLeft as it is in a left-to-right row, and scrolls with
    // scrollBy({ left }). In a right-to-left row scrollLeft runs from 0 at
    // the right to negative values, so for that row the fix presents it the
    // mirrored way: the distance from the start, and a scroll toward the end
    // as a positive one. Each button then moves toward the side it now sits
    // on. Outside the layout the row behaves natively.
    const tabListSelector = '[data-right-panel-tab-list] > [data-slot="scroll-area-viewport"]';
    const scrollLeftOf = Object.getOwnPropertyDescriptor(Element.prototype, "scrollLeft");
    const nativeScrollBy = Element.prototype.scrollBy;
    const mirroredScroll = (element) => state.applied === true && getComputedStyle(element).direction === "rtl";
    const fixTabScroll = (scope) => {
      const found = [];
      if (scope.nodeType === Node.ELEMENT_NODE) {
        if (scope.matches(tabListSelector)) found.push(scope);
        found.push(...scope.querySelectorAll(tabListSelector));
      }
      for (const viewport of found) {
        if (Object.prototype.hasOwnProperty.call(viewport, "scrollLeft")) continue;
        Object.defineProperty(viewport, "scrollLeft", {
          configurable: true,
          get() {
            const value = scrollLeftOf.get.call(this);
            return mirroredScroll(this) ? -value : value;
          },
          set(value) {
            scrollLeftOf.set.call(this, mirroredScroll(this) ? -value : value);
          },
        });
        Object.defineProperty(viewport, "scrollBy", {
          configurable: true,
          value(first, second) {
            if (!mirroredScroll(this)) return nativeScrollBy.apply(this, arguments);
            if (first && typeof first === "object") {
              return nativeScrollBy.call(this, { ...first, left: typeof first.left === "number" ? -first.left : first.left });
            }
            return nativeScrollBy.call(this, -(Number(first) || 0), second);
          },
        });
        // T3 Code works out its buttons again on the next scroll event.
        viewport.dispatchEvent(new Event("scroll"));
      }
    };

    // T3 Code keeps the floating preview clear of the find bar in a thread by
    // the bar's place in the conversation, as in a left-to-right layout. The
    // preview is shown mirrored (see HIGH_CSS), so the fix presents the bar's
    // place mirrored too, and both sit on the left.
    const findBarSelector = "[data-thread-find-bar]";
    const nativeRect = Element.prototype.getBoundingClientRect;
    const fixFindBar = (scope) => {
      const found = scope.matches(findBarSelector) ? [scope] : [];
      found.push(...scope.querySelectorAll(findBarSelector));
      for (const bar of found) {
        // A later injection replaces what an earlier one defined.
        if (state.findBars.has(bar)) continue;
        state.findBars.add(bar);
        Object.defineProperty(bar, "getBoundingClientRect", {
          configurable: true,
          value() {
            const rect = nativeRect.call(this);
            if (state.applied !== true) return rect;
            const canvas = this.closest("[data-chat-canvas]");
            if (!canvas || getComputedStyle(this).direction !== "rtl") return rect;
            const outer = nativeRect.call(canvas);
            return new DOMRect(outer.left + outer.right - rect.right, rect.top, rect.width, rect.height);
          },
        });
      }
    };

    const clearIslands = () => {
      const marks = [["data-t3-rtl-island", "ltr"], ["data-t3-rtl-return", "rtl"]];
      const marked = new Set(document.querySelectorAll("[data-t3-rtl-island], [data-t3-rtl-return]"));
      for (const ref of state.islands) {
        const element = ref.deref();
        if (element && marks.some(([attribute]) => element.hasAttribute(attribute))) marked.add(element);
      }
      state.islands = [];
      for (const element of marked) {
        for (const [attribute, dir] of marks) {
          if (!element.hasAttribute(attribute)) continue;
          element.removeAttribute(attribute);
          if (element.getAttribute("dir") === dir) element.removeAttribute("dir");
        }
      }
    };

    // ---- English text in the app's own interface --------------------------

    // Each text node belongs to the paragraph of its nearest box that is not
    // inline. That box gets plaintext, so English text keeps its reading
    // order under the right-to-left root, and its inline parts stay in one
    // paragraph. Excluded parts of the page are skipped whole, and the page is
    // read before anything is written.
    const letter = /\\p{L}/u;
    // A part laid out with the app again inside an island is read like the
    // rest of the app.
    const returnedSelector = "[data-t3-rtl-return]";
    const directedSelector = "[dir]:not(" + layoutAutoSelector + ", " + returnedSelector + ")";
    const excluded = (element) =>
      element.matches(textExcludeSelector) || (element !== root && element.matches(directedSelector));
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
      const all = new Set(scopes);
      for (const scope of scopes) {
        if (typeof scope.querySelectorAll === "function") for (const part of scope.querySelectorAll(returnedSelector)) all.add(part);
      }
      for (const scope of all) {
        const start = scope.nodeType === Node.TEXT_NODE ? scope.parentElement : scope;
        if (!start || !start.isConnected || !body.contains(start)) continue;
        const outside = start.closest(textExcludeSelector);
        const directed = start.closest(directedSelector + ", " + returnedSelector);
        if (outside || (directed && directed !== root && !directed.matches(returnedSelector))) continue;
        if (scope.nodeType === Node.TEXT_NODE) {
          if (letter.test(scope.data)) parents.add(start);
          continue;
        }
        const walker = document.createTreeWalker(start, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, filter);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) parents.add(node.parentElement);
      }
      const marks = new Set();
      for (const parent of parents) {
        let box = parent;
        while (box && box !== body) {
          const display = getComputedStyle(box).display;
          if (display !== "inline" && display !== "contents") break;
          box = box.parentElement;
        }
        if (!box || box === body || box.hasAttribute("data-t3-rtl-text")) continue;
        marks.add(box);
      }
      for (const box of marks) box.setAttribute("data-t3-rtl-text", "");
    };

    const clearText = () => {
      for (const element of document.querySelectorAll("[data-t3-rtl-text]")) element.removeAttribute("data-t3-rtl-text");
    };

    // T3 Code docks the thread details card beside the conversation with an
    // inline right offset, and keeps room for it through variables that the
    // mirrored copies already put on the left. The card follows: its offset
    // moves from the right to the left, each time T3 Code writes it. Only
    // this element's style is watched.
    // Each card is held weakly, and its watcher stops when T3 Code removes it.
    const cardObservers = new WeakMap();
    let cardRefs = [];
    const swapCard = (card) => {
      const right = card.style.right;
      if (!right || right === "auto") return;
      card.style.left = right;
      card.style.right = "";
      card.setAttribute("data-t3-rtl-card", "");
    };
    const mirrorCards = (scope) => {
      if (scope.nodeType !== Node.ELEMENT_NODE) return;
      const regions = [];
      if (scope.matches('[aria-label="Thread details"]')) regions.push(scope);
      regions.push(...scope.querySelectorAll('[aria-label="Thread details"]'));
      for (const card of regions) {
        // A floating card is placed by its popover, which follows the layout.
        if (cardObservers.has(card) || getComputedStyle(card).position !== "absolute" || !card.style.right) continue;
        swapCard(card);
        const observer = new MutationObserver(() => {
          if (card.isConnected) {
            swapCard(card);
            return;
          }
          observer.disconnect();
          cardObservers.delete(card);
        });
        observer.observe(card, { attributes: true, attributeFilter: ["style"] });
        cardObservers.set(card, observer);
        cardRefs = cardRefs.filter((ref) => ref.deref()?.isConnected);
        cardRefs.push(new WeakRef(card));
      }
    };
    const clearCards = () => {
      for (const ref of cardRefs) {
        const card = ref.deref();
        if (!card) continue;
        cardObservers.get(card)?.disconnect();
        cardObservers.delete(card);
        if (card.hasAttribute("data-t3-rtl-card")) {
          card.style.right = card.style.left;
          card.style.left = "";
          card.removeAttribute("data-t3-rtl-card");
        }
      }
      cardRefs = [];
    };

    // An English placeholder ends with a left-to-right mark, so punctuation
    // such as "Search models..." stays at its end in a right-to-left field.
    // The field keeps its direction and padding. The original text is kept
    // to give it back when the layout is turned off.
    const lrm = "\\u200e";
    const firstStrong = /[\\p{L}]/u;
    const latin = /[A-Za-z]/;
    const markPlaceholders = (scope) => {
      if (scope.nodeType !== Node.ELEMENT_NODE) return;
      const fields = [];
      if (scope.matches("input[placeholder], textarea[placeholder]")) fields.push(scope);
      fields.push(...scope.querySelectorAll("input[placeholder], textarea[placeholder]"));
      for (const field of fields) {
        const text = field.getAttribute("placeholder") || "";
        if (text.endsWith(lrm) || field.closest(".composer-tiptap") || !field.matches(":dir(rtl)")) continue;
        const strong = text.match(firstStrong);
        if (!strong || !latin.test(strong[0])) continue;
        field.setAttribute("data-t3-rtl-placeholder", text);
        field.setAttribute("placeholder", text + lrm);
      }
    };

    const clearPlaceholders = () => {
      for (const field of document.querySelectorAll("[data-t3-rtl-placeholder]")) {
        const original = field.getAttribute("data-t3-rtl-placeholder");
        if (field.getAttribute("placeholder") === original + lrm) field.setAttribute("placeholder", original);
        field.removeAttribute("data-t3-rtl-placeholder");
      }
    };

    const flush = () => {
      state.frame = 0;
      const scopes = Array.from(state.pendingRoots);
      state.pendingRoots.clear();
      if (!state.applied) return;
      for (const scope of scopes) {
        if (!scope.isConnected || scope.nodeType !== Node.ELEMENT_NODE) continue;
        markIslands(scope);
        fixTabScroll(scope);
        fixFindBar(scope);
        markPlaceholders(scope);
        mirrorCards(scope);
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
            // T3 Code wrote a new placeholder.
            if (record.attributeName === "placeholder") {
              if (state.applied) schedule(target);
              continue;
            }
            if (isStylesheetOwner(target)) void mirrorOwner(target);
            // A link that stops being a stylesheet loses its copy.
            else if (state.copies.has(target)) removeCopy(target);
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
        attributeFilter: ["href", "media", "rel", "placeholder"],
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
    // The cursor is inherited, so the handle is the outermost element that
    // shows it.
    const resizeHandle = (target) => {
      for (let element = target; element && element !== document.body; element = element.parentElement) {
        const cursor = getComputedStyle(element).cursor;
        if (resizeCursor.test(cursor)) {
          let handle = element;
          while (handle.parentElement && handle.parentElement !== document.body &&
            getComputedStyle(handle.parentElement).cursor === cursor) {
            handle = handle.parentElement;
          }
          return handle;
        }
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

    // T3 Code moves the floating preview by its grip, where its buttons do
    // not start a drag. It moves the preview by the pointer's movement from
    // where the preview would be, so while the preview is shown mirrored (see
    // HIGH_CSS), the drag is mirrored too.
    const previewGrip = (target) => {
      if (!(target instanceof Element) || target.closest("button")) return null;
      return target.closest(miniPlayerGripSelector);
    };

    const onPointerDown = (event) => {
      if (event.button !== 0 || state.drag) return;
      const grip = previewGrip(event.target);
      const handle = grip || resizeHandle(event.target);
      if (!handle) return;
      state.drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        // A handle that a script places from its physical side, such as those
        // of the device preview, already moves the way the pointer does. One
        // placed by the mirrored stylesheets inside such an element, such as
        // those of the floating preview, moved to the other side.
        mirror: grip
          ? state.applied === true && getComputedStyle(grip.parentElement.parentElement).scale === "-1 1"
          : state.applied === true && handle.matches(":dir(rtl)") && !handle.matches(scriptPlacedSelector),
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
      clearPlaceholders();
      clearCards();
      if (state.originalDir === null || state.originalDir === undefined) root.removeAttribute("dir");
      else root.setAttribute("dir", state.originalDir);
    };

    // T3 Code places the page of a floating preview over the preview from
    // where the preview was when T3 Code last measured it, and measures it
    // again on a scroll. Turning the layout on or off moves the preview to
    // the other side without changing its size.
    const remeasurePreviews = () => {
      if (state.disposed) return;
      for (const preview of document.querySelectorAll(miniPlayerSelector)) preview.dispatchEvent(new Event("scroll"));
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
          if (state.applied) remeasurePreviews();
        });
        if (document.body) schedule(document.body);
        // The preview moves at once, and again once every copy is in place.
        remeasurePreviews();
      } else {
        undo();
        root.setAttribute("data-t3-rtl-app", "off");
        remeasurePreviews();
      }
      window.dispatchEvent(new CustomEvent(eventName, { detail: { on } }));
      for (const viewport of document.querySelectorAll(tabListSelector)) viewport.dispatchEvent(new Event("scroll"));
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
