"use strict";

const FIX_ID = "t3-rtl-fix";
const STATE_KEY = "__t3RtlFixState";
const PLAN_CARD_MARKER = "data-t3-rtl-plan-card";
const TURN_PLAN_MARKER = "data-t3-rtl-turn-plan";
const PLAN_ACTION_SELECTOR = '[aria-label="Plan actions"]';
const PLAN_CARD_SELECTOR = `[${PLAN_CARD_MARKER}]`;
const TURN_PLAN_SELECTOR = `[${TURN_PLAN_MARKER}]`;
const PULL_REQUEST_MARKDOWN_ROOT_SELECTOR =
  '[data-pull-request-summary-scroll] .chat-markdown';
const FILE_MARKDOWN_ROOT_SELECTOR =
  '[data-preview-panel-mode]:has([aria-label="Show markdown source"]) .chat-markdown';
const COMPOSER_TASK_ROOT_SELECTOR =
  ':is([data-composer-tasks-badge="true"], [data-chat-composer-tasks-drawer="true"])';
const CITATION_COMMENT_EDITOR_SELECTOR = '[data-citation-comment-editor="true"]';
const CITATION_CHIP_SELECTOR = '[data-assistant-citation-chip="true"]';
const QUEUED_MESSAGE_SELECTOR = "[data-queued-message-id]";
const QUEUED_MESSAGE_DETAILS_SELECTOR =
  `${QUEUED_MESSAGE_SELECTOR} > div > div:not(.chat-markdown):not([data-scroll-anchor-ignore])`;
const QUEUED_MARKDOWN_ROOT_SELECTOR = `${QUEUED_MESSAGE_SELECTOR} .chat-markdown`;
const MARKDOWN_ROOT_SELECTOR =
  `:is([data-message-role], ${PLAN_CARD_SELECTOR}) .chat-markdown`;
const PENDING_USER_INPUT_ROOT_SELECTOR =
  '[data-slot="collapsible"]:has([data-pending-user-input-toggle])';
const DIRECTION_ROOT_SELECTOR = [
  MARKDOWN_ROOT_SELECTOR,
  PULL_REQUEST_MARKDOWN_ROOT_SELECTOR,
  FILE_MARKDOWN_ROOT_SELECTOR,
  PENDING_USER_INPUT_ROOT_SELECTOR,
  PLAN_CARD_SELECTOR,
  TURN_PLAN_SELECTOR,
  COMPOSER_TASK_ROOT_SELECTOR,
  CITATION_COMMENT_EDITOR_SELECTOR,
  CITATION_CHIP_SELECTOR,
  QUEUED_MESSAGE_SELECTOR,
  QUEUED_MARKDOWN_ROOT_SELECTOR,
].join(", ");
const RTL_TEXT_PATTERN = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/u;
const LETTER_PATTERN = /\p{L}/u;
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
  PLAN_CARD_SELECTOR,
  `${PLAN_CARD_SELECTOR} > div:first-child :is(p, h3)`,
  `${PLAN_CARD_SELECTOR} .chat-markdown`,
  `${PLAN_CARD_SELECTOR} .chat-markdown p`,
  `${PLAN_CARD_SELECTOR} .chat-markdown h1`,
  `${PLAN_CARD_SELECTOR} .chat-markdown h2`,
  `${PLAN_CARD_SELECTOR} .chat-markdown h3`,
  `${PLAN_CARD_SELECTOR} .chat-markdown h4`,
  `${PLAN_CARD_SELECTOR} .chat-markdown h5`,
  `${PLAN_CARD_SELECTOR} .chat-markdown h6`,
  `${PLAN_CARD_SELECTOR} .chat-markdown blockquote`,
  `${PLAN_CARD_SELECTOR} .chat-markdown li`,
  `${PLAN_CARD_SELECTOR} .chat-markdown strong`,
  `${PLAN_CARD_SELECTOR} .chat-markdown em`,
  `${PLAN_CARD_SELECTOR} .chat-markdown a:not(.chat-markdown-file-link)`,
  `${PLAN_CARD_SELECTOR} .chat-markdown .chat-markdown-table-container`,
  `${PLAN_CARD_SELECTOR} .chat-markdown th`,
  `${PLAN_CARD_SELECTOR} .chat-markdown td`,
  PULL_REQUEST_MARKDOWN_ROOT_SELECTOR,
  `${PULL_REQUEST_MARKDOWN_ROOT_SELECTOR} p`,
  `${PULL_REQUEST_MARKDOWN_ROOT_SELECTOR} h1`,
  `${PULL_REQUEST_MARKDOWN_ROOT_SELECTOR} h2`,
  `${PULL_REQUEST_MARKDOWN_ROOT_SELECTOR} h3`,
  `${PULL_REQUEST_MARKDOWN_ROOT_SELECTOR} h4`,
  `${PULL_REQUEST_MARKDOWN_ROOT_SELECTOR} h5`,
  `${PULL_REQUEST_MARKDOWN_ROOT_SELECTOR} h6`,
  `${PULL_REQUEST_MARKDOWN_ROOT_SELECTOR} blockquote`,
  `${PULL_REQUEST_MARKDOWN_ROOT_SELECTOR} li`,
  `${PULL_REQUEST_MARKDOWN_ROOT_SELECTOR} strong`,
  `${PULL_REQUEST_MARKDOWN_ROOT_SELECTOR} em`,
  `${PULL_REQUEST_MARKDOWN_ROOT_SELECTOR} a:not(.chat-markdown-file-link)`,
  `${PULL_REQUEST_MARKDOWN_ROOT_SELECTOR} .chat-markdown-table-container`,
  `${PULL_REQUEST_MARKDOWN_ROOT_SELECTOR} th`,
  `${PULL_REQUEST_MARKDOWN_ROOT_SELECTOR} td`,
  FILE_MARKDOWN_ROOT_SELECTOR,
  `${FILE_MARKDOWN_ROOT_SELECTOR} p`,
  `${FILE_MARKDOWN_ROOT_SELECTOR} h1`,
  `${FILE_MARKDOWN_ROOT_SELECTOR} h2`,
  `${FILE_MARKDOWN_ROOT_SELECTOR} h3`,
  `${FILE_MARKDOWN_ROOT_SELECTOR} h4`,
  `${FILE_MARKDOWN_ROOT_SELECTOR} h5`,
  `${FILE_MARKDOWN_ROOT_SELECTOR} h6`,
  `${FILE_MARKDOWN_ROOT_SELECTOR} blockquote`,
  `${FILE_MARKDOWN_ROOT_SELECTOR} li`,
  `${FILE_MARKDOWN_ROOT_SELECTOR} strong`,
  `${FILE_MARKDOWN_ROOT_SELECTOR} em`,
  `${FILE_MARKDOWN_ROOT_SELECTOR} a:not(.chat-markdown-file-link)`,
  `${FILE_MARKDOWN_ROOT_SELECTOR} .chat-markdown-table-container`,
  `${FILE_MARKDOWN_ROOT_SELECTOR} th`,
  `${FILE_MARKDOWN_ROOT_SELECTOR} td`,
  PENDING_USER_INPUT_ROOT_SELECTOR,
  `${PENDING_USER_INPUT_ROOT_SELECTOR} [data-pending-user-input-toggle]`,
  `${PENDING_USER_INPUT_ROOT_SELECTOR} [data-slot="collapsible-panel"] p`,
  `${PENDING_USER_INPUT_ROOT_SELECTOR} [data-slot="collapsible-panel"] button`,
  TURN_PLAN_SELECTOR,
  `${TURN_PLAN_SELECTOR} > button[aria-expanded]`,
  `${TURN_PLAN_SELECTOR} > div`,
  `${TURN_PLAN_SELECTOR} > div > div`,
  COMPOSER_TASK_ROOT_SELECTOR,
  `${COMPOSER_TASK_ROOT_SELECTOR} button[aria-expanded]`,
  `${COMPOSER_TASK_ROOT_SELECTOR} [data-composer-task-current]`,
  `${COMPOSER_TASK_ROOT_SELECTOR} [role="listitem"]`,
  `${CITATION_COMMENT_EDITOR_SELECTOR} textarea`,
  CITATION_CHIP_SELECTOR,
  `${CITATION_CHIP_SELECTOR} a > span`,
  `${QUEUED_MESSAGE_SELECTOR} > div`,
  QUEUED_MESSAGE_DETAILS_SELECTOR,
  QUEUED_MARKDOWN_ROOT_SELECTOR,
  `${QUEUED_MARKDOWN_ROOT_SELECTOR} p`,
  `${QUEUED_MARKDOWN_ROOT_SELECTOR} h1`,
  `${QUEUED_MARKDOWN_ROOT_SELECTOR} h2`,
  `${QUEUED_MARKDOWN_ROOT_SELECTOR} h3`,
  `${QUEUED_MARKDOWN_ROOT_SELECTOR} h4`,
  `${QUEUED_MARKDOWN_ROOT_SELECTOR} h5`,
  `${QUEUED_MARKDOWN_ROOT_SELECTOR} h6`,
  `${QUEUED_MARKDOWN_ROOT_SELECTOR} blockquote`,
  `${QUEUED_MARKDOWN_ROOT_SELECTOR} li`,
  `${QUEUED_MARKDOWN_ROOT_SELECTOR} strong`,
  `${QUEUED_MARKDOWN_ROOT_SELECTOR} em`,
  `${QUEUED_MARKDOWN_ROOT_SELECTOR} a:not(.chat-markdown-file-link)`,
  `${QUEUED_MARKDOWN_ROOT_SELECTOR} .chat-markdown-table-container`,
  `${QUEUED_MARKDOWN_ROOT_SELECTOR} th`,
  `${QUEUED_MARKDOWN_ROOT_SELECTOR} td`,
].join(", ");
const LTR_DIRECTION_SELECTOR = [
  '[data-message-role] .chat-markdown pre',
  '[data-message-role] .chat-markdown code',
  '[data-message-role] .chat-markdown a.chat-markdown-file-link',
  '[data-message-role] .chat-markdown .chat-markdown-codeblock',
  `${PLAN_CARD_SELECTOR} .chat-markdown pre`,
  `${PLAN_CARD_SELECTOR} .chat-markdown code`,
  `${PLAN_CARD_SELECTOR} .chat-markdown a.chat-markdown-file-link`,
  `${PLAN_CARD_SELECTOR} .chat-markdown .chat-markdown-codeblock`,
  `${PULL_REQUEST_MARKDOWN_ROOT_SELECTOR} pre`,
  `${PULL_REQUEST_MARKDOWN_ROOT_SELECTOR} code`,
  `${PULL_REQUEST_MARKDOWN_ROOT_SELECTOR} a.chat-markdown-file-link`,
  `${PULL_REQUEST_MARKDOWN_ROOT_SELECTOR} .chat-markdown-codeblock`,
  `${FILE_MARKDOWN_ROOT_SELECTOR} pre`,
  `${FILE_MARKDOWN_ROOT_SELECTOR} code`,
  `${FILE_MARKDOWN_ROOT_SELECTOR} a.chat-markdown-file-link`,
  `${FILE_MARKDOWN_ROOT_SELECTOR} .chat-markdown-codeblock`,
  `${PENDING_USER_INPUT_ROOT_SELECTOR} kbd`,
  `${QUEUED_MARKDOWN_ROOT_SELECTOR} pre`,
  `${QUEUED_MARKDOWN_ROOT_SELECTOR} code`,
  `${QUEUED_MARKDOWN_ROOT_SELECTOR} a.chat-markdown-file-link`,
  `${QUEUED_MARKDOWN_ROOT_SELECTOR} .chat-markdown-codeblock`,
].join(", ");

function buildInjectionSource(css) {
  return `(() => {
  const id = ${JSON.stringify(FIX_ID)};
  const stateKey = ${JSON.stringify(STATE_KEY)};
  const css = ${JSON.stringify(css)};
  const planCardMarker = ${JSON.stringify(PLAN_CARD_MARKER)};
  const turnPlanMarker = ${JSON.stringify(TURN_PLAN_MARKER)};
  const planActionSelector = ${JSON.stringify(PLAN_ACTION_SELECTOR)};
  const composerTaskRootSelector = ${JSON.stringify(COMPOSER_TASK_ROOT_SELECTOR)};
  const directionRootSelector = ${JSON.stringify(DIRECTION_ROOT_SELECTOR)};
  const rtlTextPattern = new RegExp(${JSON.stringify(RTL_TEXT_PATTERN.source)}, "u");
  const letterPattern = new RegExp(${JSON.stringify(LETTER_PATTERN.source)}, "u");
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

  const markPlanCards = (root) => {
    const actions = [];
    if (root.nodeType === Node.ELEMENT_NODE && root.matches(planActionSelector)) {
      actions.push(root);
    }
    if (typeof root.querySelectorAll === "function") {
      actions.push(...root.querySelectorAll(planActionSelector));
    }
    for (const action of actions) {
      let candidate = action.parentElement;
      while (candidate && candidate !== document.body) {
        if (candidate.querySelector(":scope > div .chat-markdown")) {
          candidate.setAttribute(planCardMarker, "");
          break;
        }
        candidate = candidate.parentElement;
      }
    }
  };

  const markTurnPlans = (root) => {
    const toggles = [];
    const selector = 'button[aria-expanded]';
    if (root.nodeType === Node.ELEMENT_NODE && root.matches(selector)) toggles.push(root);
    if (typeof root.querySelectorAll === "function") {
      toggles.push(...root.querySelectorAll(selector));
    }
    for (const toggle of toggles) {
      if (toggle.closest(composerTaskRootSelector)) continue;
      const count = Array.from(toggle.children).find(
        (child) =>
          child.matches?.("span.tabular-nums") &&
          /^\\s*\\d+\\s*\\/\\s*\\d+\\s*$/.test(child.textContent ?? ""),
      );
      if (!count) continue;
      toggle.parentElement?.setAttribute(turnPlanMarker, "");
    }
  };

  // Hebrew or Arabic prose makes a block right to left, and other letters let
  // the browser resolve it. A block with no letters at all, such as a lone
  // image or a number, has nothing to resolve from, so it keeps the direction
  // of the content around it.
  const proseDirection = (element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let hasLetters = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const ltrAncestor = node.parentElement?.closest(ltrDirectionSelector);
      if (ltrAncestor && ltrAncestor !== element && element.contains(ltrAncestor)) continue;
      if (rtlTextPattern.test(node.data)) return "rtl";
      if (!hasLetters && letterPattern.test(node.data)) hasLetters = true;
    }
    return hasLetters ? "auto" : null;
  };

  const setContentDirection = (root) => {
    const apply = (element) => {
      const ltrAncestor = element.closest(ltrDirectionSelector);
      if (ltrAncestor && ltrAncestor !== element && !element.matches("th, td")) return;
      // A text field holds its text in a value property rather than in child
      // nodes, so the browser has to resolve its direction while the user types.
      const direction = element.matches("textarea, input") ? "auto" : proseDirection(element);
      if (direction) element.setAttribute("dir", direction);
      else element.removeAttribute("dir");
    };
    if (root.nodeType === Node.ELEMENT_NODE && root.matches(autoDirectionSelector)) apply(root);
    if (typeof root.querySelectorAll !== "function") return;
    for (const element of root.querySelectorAll(autoDirectionSelector)) apply(element);
  };

  const applyDirections = (root) => {
    markPlanCards(root);
    markTurnPlans(root);
    setContentDirection(root);
    setDirection(root, ltrDirectionSelector, "ltr");
  };

  const applyDirectionsAround = (node) => {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!element) return;
    const directionRoot = element.matches(directionRootSelector)
      ? element
      : element.closest(directionRootSelector);
    applyDirections(directionRoot ?? element);
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
