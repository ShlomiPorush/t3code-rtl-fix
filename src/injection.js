"use strict";

const FIX_ID = "t3-rtl-fix";
const STATE_KEY = "__t3RtlFixState";
const PLAN_CARD_MARKER = "data-t3-rtl-plan-card";
const TURN_PLAN_MARKER = "data-t3-rtl-turn-plan";
const PLAN_ACTION_SELECTOR = '[aria-label="Plan actions"]';
const PLAN_CARD_SELECTOR = `[${PLAN_CARD_MARKER}]`;
const TURN_PLAN_SELECTOR = `[${TURN_PLAN_MARKER}]`;
const COMPOSER_TASK_ROOT_SELECTOR =
  ':is([data-composer-tasks-badge="true"], [data-chat-composer-tasks-drawer="true"])';
const MARKDOWN_ROOT_SELECTOR =
  `:is([data-message-role], ${PLAN_CARD_SELECTOR}) .chat-markdown`;
const PENDING_USER_INPUT_ROOT_SELECTOR =
  '[data-slot="collapsible"]:has([data-pending-user-input-toggle])';
const DIRECTION_ROOT_SELECTOR = [
  MARKDOWN_ROOT_SELECTOR,
  PENDING_USER_INPUT_ROOT_SELECTOR,
  PLAN_CARD_SELECTOR,
  TURN_PLAN_SELECTOR,
  COMPOSER_TASK_ROOT_SELECTOR,
].join(", ");
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
  PLAN_CARD_SELECTOR,
  `${PLAN_CARD_SELECTOR} > div:first-child p`,
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
  `${PENDING_USER_INPUT_ROOT_SELECTOR} kbd`,
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
