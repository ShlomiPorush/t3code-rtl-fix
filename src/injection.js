"use strict";

const FIX_ID = "t3-rtl-fix";
const STATE_KEY = "__t3RtlFixState";
const MARKDOWN_ROOT_SELECTOR = '[data-message-role] .chat-markdown';
const RTL_TEXT_PATTERN = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/u;
const AUTO_DIRECTION_SELECTOR = [
  MARKDOWN_ROOT_SELECTOR,
  '[data-message-role] .chat-markdown p',
  '[data-message-role] .chat-markdown h1',
  '[data-message-role] .chat-markdown h2',
  '[data-message-role] .chat-markdown h3',
  '[data-message-role] .chat-markdown h4',
  '[data-message-role] .chat-markdown h5',
  '[data-message-role] .chat-markdown h6',
  '[data-message-role] .chat-markdown blockquote',
  '[data-message-role] .chat-markdown li',
  '[data-message-role] .chat-markdown strong',
  '[data-message-role] .chat-markdown em',
  '[data-message-role] .chat-markdown a:not(.chat-markdown-file-link)',
  '[data-message-role] .chat-markdown .chat-markdown-table-container',
  '[data-message-role] .chat-markdown th',
  '[data-message-role] .chat-markdown td',
].join(", ");
const LTR_DIRECTION_SELECTOR = [
  '[data-message-role] .chat-markdown pre',
  '[data-message-role] .chat-markdown code',
  '[data-message-role] .chat-markdown a.chat-markdown-file-link',
  '[data-message-role] .chat-markdown .chat-markdown-codeblock',
].join(", ");

function buildInjectionSource(css) {
  return `(() => {
  const id = ${JSON.stringify(FIX_ID)};
  const stateKey = ${JSON.stringify(STATE_KEY)};
  const css = ${JSON.stringify(css)};
  const markdownRootSelector = ${JSON.stringify(MARKDOWN_ROOT_SELECTOR)};
  const rtlTextPattern = new RegExp(${JSON.stringify(RTL_TEXT_PATTERN.source)}, "u");
  const autoDirectionSelector = ${JSON.stringify(AUTO_DIRECTION_SELECTOR)};
  const ltrDirectionSelector = ${JSON.stringify(LTR_DIRECTION_SELECTOR)};

  const previousState = globalThis[stateKey];
  if (previousState?.observer) previousState.observer.disconnect();
  if (previousState?.onReady) {
    document.removeEventListener("DOMContentLoaded", previousState.onReady);
  }

  const state = { observer: null, onReady: null };
  globalThis[stateKey] = state;

  const applyStyle = () => {
    if (!document.head) return false;
    let style = document.getElementById(id);
    if (!style) {
      style = document.createElement("style");
      style.id = id;
      document.head.appendChild(style);
    }
    if (style.textContent !== css) style.textContent = css;
    return true;
  };

  const setDirection = (root, selector, direction) => {
    if (root.nodeType === Node.ELEMENT_NODE && root.matches(selector)) {
      root.setAttribute("dir", direction);
    }
    if (typeof root.querySelectorAll !== "function") return;
    for (const element of root.querySelectorAll(selector)) {
      element.setAttribute("dir", direction);
    }
  };

  const hasRtlProse = (element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const ltrAncestor = node.parentElement?.closest(ltrDirectionSelector);
      if (ltrAncestor && ltrAncestor !== element && element.contains(ltrAncestor)) continue;
      if (rtlTextPattern.test(node.data)) return true;
    }
    return false;
  };

  const setContentDirection = (root) => {
    const apply = (element) => {
      const ltrAncestor = element.closest(ltrDirectionSelector);
      if (ltrAncestor && ltrAncestor !== element && !element.matches("th, td")) return;
      element.setAttribute("dir", hasRtlProse(element) ? "rtl" : "auto");
    };
    if (root.nodeType === Node.ELEMENT_NODE && root.matches(autoDirectionSelector)) apply(root);
    if (typeof root.querySelectorAll !== "function") return;
    for (const element of root.querySelectorAll(autoDirectionSelector)) apply(element);
  };

  const applyDirections = (root) => {
    setContentDirection(root);
    setDirection(root, ltrDirectionSelector, "ltr");
  };

  const applyDirectionsAround = (node) => {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!element) return;
    const markdownRoot = element.matches(markdownRootSelector)
      ? element
      : element.closest(markdownRootSelector);
    applyDirections(markdownRoot ?? element);
  };

  const start = () => {
    if (!applyStyle() || !document.documentElement) return false;
    applyDirections(document);
    state.observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          applyDirectionsAround(node);
        }
        if (record.type === "characterData") applyDirectionsAround(record.target);
      }
    });
    state.observer.observe(document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return true;
  };

  if (!start()) {
    state.onReady = () => {
      state.onReady = null;
      start();
    };
    document.addEventListener("DOMContentLoaded", state.onReady, { once: true });
  }
})();`;
}

module.exports = { buildInjectionSource };
