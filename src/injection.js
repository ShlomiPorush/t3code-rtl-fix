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
// The queue above the composer shows each queued prompt on one truncated
// line. The row with its reorder handle and actions keeps T3 Code's layout.
const QUEUED_PROMPT_SELECTOR =
  '[role="region"][aria-label*=" queued message"] [data-slot="composer-banner-content"] > span.min-w-0.flex-1.truncate';
// Thread titles in the sidebar rows, the open thread header, and the rename
// field shared by both, in the related threads list of the thread details
// panel, in the threads suggested after typing @ in the composer, and in the
// breadcrumb above a subagent's thread, which names its parent thread and
// project.
const THREAD_TITLE_SELECTOR = [
  'li[data-thread-item] span[aria-hidden="true"].text-sm.flex-1',
  '[data-thread-item] [data-testid^="thread-title-"]',
  ":has(> [data-thread-title-chevron]) > h2",
  'input[aria-label="Thread title"]',
  'ul[aria-label="Related threads"] span.block.truncate',
  '[data-composer-item-id^="thread:"] span.truncate',
  'nav[aria-label="Thread breadcrumb"] [data-slot="workspace-breadcrumb-text"]',
].join(", ");
// Notifications such as "Thread completed" name the thread in their
// description, so the title and description follow the same rule.
const TOAST_TEXT_SELECTOR = '[data-slot="toast-title"], [data-slot="toast-description"]';
// The agent's work log. Row summaries also describe shell commands, so they
// take dir="auto" and follow their first letter: a command that starts in
// English stays left to right even with a Hebrew argument. The questions and
// answers shown when an asked question is expanded are prose and follow the
// message rule. While the agent works, its latest thought is shown in a
// separate live row. It follows its first letter too, so it keeps its
// direction when the turn ends and it becomes an ordinary row.
const WORK_LOG_SUMMARY_SELECTOR = [
  '[class~="group/timeline-row"] p.items-baseline > span',
  '[class~="group/live-work"] .line-clamp-4',
].join(", ");
// Every tooltip shares one component, whether it shows a thread title, a
// queued prompt, tool output, or a shortcut, so each follows its first letter
// and an English tooltip with a Hebrew word stays left to right.
const TOOLTIP_SELECTOR = '[data-slot="tooltip-popup"]';
const WORK_LOG_ANSWER_SELECTOR = '[class~="group/timeline-row"] .space-y-1 > p';
// An expanded thought in the work log is Markdown, like a message.
const REASONING_MARKDOWN_ROOT_SELECTOR = '[data-v2-item-type="reasoning"] .chat-markdown';
// The card of a subagent or delegated task: its title and the one-line
// summary of its result, both written by the agent.
const SUBAGENT_TEXT_SELECTOR = [
  '[data-v2-item-type="subagent"] span.truncate.font-medium',
  '[data-v2-item-type="subagent"] .text-2xs > span.truncate',
].join(", ");
// The hover card that opens over a subagent card has a title and, in a row
// with a terminal icon, the result. T3 Code shows the result with its path
// component, a flex row of a truncated head and the last few characters, so
// a right-to-left direction also puts the two parts in reading order.
const HOVER_CARD_SELECTOR = ".flex-col.max-w-80.px-1.py-2";
const HOVER_CARD_TEXT_SELECTOR = [
  `${HOVER_CARD_SELECTOR} > .truncate.leading-tight.font-medium:first-child`,
  `${HOVER_CARD_SELECTOR} .grid > div:has(> svg.lucide-terminal) > span.whitespace-nowrap`,
].join(", ");
// The card that opens from a preview annotation chip in a message or the
// composer: the page title and the comment written on the element. Both class
// combinations are unique to this card in T3 Code's markup.
const PREVIEW_ANNOTATION_CARD_TEXT_SELECTOR = [
  "div.mt-1.whitespace-pre-wrap.wrap-break-word.text-sm",
  ".min-w-0.px-3.py-2\\.5 > .text-message-foreground.text-xs.font-medium",
].join(", ");
// The card that opens from a quoted text chip in a message: the quoted text,
// the comment written on it, and a Go to source button. The class combination
// of its scrolling text box is unique to this card in T3 Code's markup. The
// card follows its text, so the button sits on the side where the text
// starts, while the button's own English label keeps its direction.
const CITATION_CARD_TEXT_BOX_SELECTOR =
  ".max-h-64.min-h-0.space-y-3.self-stretch.overflow-y-auto.whitespace-pre-wrap.wrap-break-word";
const CITATION_CARD_SELECTOR = `div:has(> ${CITATION_CARD_TEXT_BOX_SELECTOR})`;
const CITATION_CARD_TEXT_SELECTOR = [
  CITATION_CARD_SELECTOR,
  `${CITATION_CARD_SELECTOR} > ${CITATION_CARD_TEXT_BOX_SELECTOR} > :is(blockquote, p)`,
  `${CITATION_CARD_SELECTOR} > :not(${CITATION_CARD_TEXT_BOX_SELECTOR})`,
].join(", ");
const COMPOSER_ROOT_SELECTOR = ".composer-tiptap";
const COMPOSER_CHIP_SELECTOR = ".react-renderer";
const COMPOSER_MARKER = "data-t3-rtl-composer";
const COMPOSER_STYLE_ID = "t3-rtl-fix-composer";
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
  QUEUED_PROMPT_SELECTOR,
  THREAD_TITLE_SELECTOR,
  REASONING_MARKDOWN_ROOT_SELECTOR,
  SUBAGENT_TEXT_SELECTOR,
  HOVER_CARD_TEXT_SELECTOR,
  TOAST_TEXT_SELECTOR,
  CITATION_CARD_SELECTOR,
].join(", ");
// T3 Code 0.1.2 gives every top-level Markdown block its own dir from a
// majority vote of its words, so these blocks need the fix's rule too, or an
// English sentence with one Hebrew word puts a list gutter, alert border, or
// table columns on the left.
const MARKDOWN_BLOCK_SELECTORS = [
  "ul",
  "ol",
  "table",
  'div[role="note"]',
  "details",
  "section[data-footnotes]",
];
const markdownBlocks = (root) => MARKDOWN_BLOCK_SELECTORS.map((block) => `${root} ${block}`);
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
  ...markdownBlocks('[data-message-role] .chat-markdown'),
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
  ...markdownBlocks(`${PLAN_CARD_SELECTOR} .chat-markdown`),
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
  ...markdownBlocks(PULL_REQUEST_MARKDOWN_ROOT_SELECTOR),
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
  ...markdownBlocks(FILE_MARKDOWN_ROOT_SELECTOR),
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
  ...markdownBlocks(QUEUED_MARKDOWN_ROOT_SELECTOR),
  QUEUED_PROMPT_SELECTOR,
  THREAD_TITLE_SELECTOR,
  WORK_LOG_ANSWER_SELECTOR,
  PREVIEW_ANNOTATION_CARD_TEXT_SELECTOR,
  REASONING_MARKDOWN_ROOT_SELECTOR,
  `${REASONING_MARKDOWN_ROOT_SELECTOR} p`,
  `${REASONING_MARKDOWN_ROOT_SELECTOR} h1`,
  `${REASONING_MARKDOWN_ROOT_SELECTOR} h2`,
  `${REASONING_MARKDOWN_ROOT_SELECTOR} h3`,
  `${REASONING_MARKDOWN_ROOT_SELECTOR} h4`,
  `${REASONING_MARKDOWN_ROOT_SELECTOR} h5`,
  `${REASONING_MARKDOWN_ROOT_SELECTOR} h6`,
  `${REASONING_MARKDOWN_ROOT_SELECTOR} blockquote`,
  `${REASONING_MARKDOWN_ROOT_SELECTOR} li`,
  `${REASONING_MARKDOWN_ROOT_SELECTOR} strong`,
  `${REASONING_MARKDOWN_ROOT_SELECTOR} em`,
  `${REASONING_MARKDOWN_ROOT_SELECTOR} a:not(.chat-markdown-file-link)`,
  `${REASONING_MARKDOWN_ROOT_SELECTOR} .chat-markdown-table-container`,
  `${REASONING_MARKDOWN_ROOT_SELECTOR} th`,
  `${REASONING_MARKDOWN_ROOT_SELECTOR} td`,
  ...markdownBlocks(REASONING_MARKDOWN_ROOT_SELECTOR),
  SUBAGENT_TEXT_SELECTOR,
  HOVER_CARD_TEXT_SELECTOR,
  TOAST_TEXT_SELECTOR,
  CITATION_CARD_TEXT_SELECTOR,
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
  `${REASONING_MARKDOWN_ROOT_SELECTOR} pre`,
  `${REASONING_MARKDOWN_ROOT_SELECTOR} code`,
  `${REASONING_MARKDOWN_ROOT_SELECTOR} a.chat-markdown-file-link`,
  `${REASONING_MARKDOWN_ROOT_SELECTOR} .chat-markdown-codeblock`,
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
  const composerRootSelector = ${JSON.stringify(COMPOSER_ROOT_SELECTOR)};
  const workLogSummarySelector = ${JSON.stringify(WORK_LOG_SUMMARY_SELECTOR)};
  const tooltipSelector = ${JSON.stringify(TOOLTIP_SELECTOR)};
  const composerChipSelector = ${JSON.stringify(COMPOSER_CHIP_SELECTOR)};
  const composerMarker = ${JSON.stringify(COMPOSER_MARKER)};
  const composerStyleId = ${JSON.stringify(COMPOSER_STYLE_ID)};

  const previousState = globalThis[stateKey];
  if (previousState?.observer) previousState.observer.disconnect();
  if (previousState?.onReady) {
    document.removeEventListener("DOMContentLoaded", previousState.onReady);
  }

  const state = { observer: null, onReady: null, composerRules: new Map() };
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

  // T3 Code renders its own dir on some of the elements the fix directs, so
  // the observer also watches dir changes. Each element remembers the value
  // the fix wrote last, which tells the fix's own writes apart from T3
  // Code's, and a write happens only when the value changes.
  const writtenDirections = new WeakMap();
  const writeDirection = (element, direction) => {
    writtenDirections.set(element, direction);
    if (direction === null) {
      if (element.hasAttribute("dir")) element.removeAttribute("dir");
    } else if (element.getAttribute("dir") !== direction) {
      element.setAttribute("dir", direction);
    }
  };

  const setDirection = (root, selector, direction) => {
    if (root.nodeType === Node.ELEMENT_NODE && root.matches(selector)) {
      writeDirection(root, direction);
    }
    if (typeof root.querySelectorAll !== "function") return;
    for (const element of root.querySelectorAll(selector)) {
      writeDirection(element, direction);
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
      writeDirection(element, direction);
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
    setDirection(root, workLogSummarySelector, "auto");
    setDirection(root, tooltipSelector, "auto");
  };

  // The composer editor replaces any paragraph whose attributes it did not
  // write, so a dir attribute there would loop forever. Each block's
  // direction goes into a generated stylesheet instead. The caret and
  // Ctrl+Shift+Arrow follow the computed direction, so they match the text.
  // Same rule as a sent message: any Hebrew or Arabic prose makes the
  // paragraph right to left, even when it starts with an English word.
  // Typed text decides first. A paragraph that holds only chips follows a
  // Hebrew or Arabic chip, such as a quoted comment. A chip without such text,
  // such as a file name, decides nothing and the previous paragraph's
  // direction applies.
  const composerParagraphDirection = (paragraph) => {
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let hasLetters = false;
    let chipHasRtlText = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest(composerChipSelector)) {
        if (rtlTextPattern.test(node.data)) chipHasRtlText = true;
        continue;
      }
      if (rtlTextPattern.test(node.data)) return "rtl";
      if (!hasLetters && letterPattern.test(node.data)) hasLetters = true;
    }
    if (hasLetters) return "ltr";
    return chipHasRtlText ? "rtl" : null;
  };

  const writeComposerStyle = () => {
    for (const id of state.composerRules.keys()) {
      if (!document.querySelector(composerRootSelector + "[" + composerMarker + '="' + id + '"]')) {
        state.composerRules.delete(id);
      }
    }
    const text = [...state.composerRules.values()].filter(Boolean).join(" ");
    let style = document.getElementById(composerStyleId);
    if (!style) {
      if (!text || !document.head) return;
      style = document.createElement("style");
      style.id = composerStyleId;
      document.head.appendChild(style);
    }
    if (style.textContent !== text) style.textContent = text;
  };

  const updateComposer = (editor) => {
    let id = editor.getAttribute(composerMarker);
    if (!id) {
      let next = 0;
      while (document.querySelector("[" + composerMarker + '="' + next + '"]')) next++;
      id = String(next);
      editor.setAttribute(composerMarker, id);
    }
    const selectors = { rtl: [], ltr: [] };
    let previous = "ltr";
    // Walks the blocks in document order. A list, list item or quote takes the
    // direction of its first paragraph, which puts its marker, gutter or
    // border on the side where that paragraph starts. Every block gets a rule,
    // because T3 Code puts its own dir attribute on the top-level blocks and a
    // block without a rule would follow that attribute instead.
    const visit = (container, path) => {
      let first = null;
      Array.from(container.children).forEach((child, index) => {
        // Chips and code blocks are React node views with their own layout.
        if (child.matches(composerChipSelector)) return;
        const name = child.localName;
        const selector = path + " > " + name + ":nth-child(" + (index + 1) + ")";
        let direction;
        if (/^(p|h[1-6])$/.test(name)) {
          // A paragraph without letters yet, such as a new empty line, keeps
          // the direction of the paragraph before it.
          direction = composerParagraphDirection(child) ?? previous;
          previous = direction;
        } else if (/^(blockquote|ul|ol|li)$/.test(name) || (name === "div" && container.localName === "li")) {
          // The div holds the text of a task list item next to its checkbox.
          direction = visit(child, selector);
        }
        if (!direction) return;
        first ??= direction;
        selectors[direction].push(selector);
      });
      return first;
    };
    visit(editor, composerRootSelector + "[" + composerMarker + '="' + id + '"]');
    state.composerRules.set(
      id,
      ["rtl", "ltr"]
        .filter((direction) => selectors[direction].length)
        .map((direction) => selectors[direction].join(", ") + " { direction: " + direction + "; }")
        .join(" "),
    );
  };

  const collectComposers = (node, composers) => {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!element) return;
    const editor = element.closest(composerRootSelector);
    if (editor) composers.add(editor);
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    for (const nested of node.querySelectorAll(composerRootSelector)) composers.add(nested);
  };

  const updateComposers = (composers) => {
    if (composers.size === 0) return;
    for (const editor of composers) updateComposer(editor);
    writeComposerStyle();
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
    updateComposers(new Set(document.querySelectorAll(composerRootSelector)));
    state.observer = new MutationObserver((records) => {
      const composers = new Set();
      for (const record of records) {
        if (record.type === "attributes") {
          // The composer directs its blocks through a stylesheet, so T3 Code's
          // dir attributes there change nothing.
          const target = record.target;
          if (target.closest(composerRootSelector)) continue;
          if (writtenDirections.get(target) === target.getAttribute("dir")) continue;
          applyDirectionsAround(target);
          continue;
        }
        for (const node of record.addedNodes) {
          applyDirectionsAround(node);
          collectComposers(node, composers);
        }
        // Removed text, such as the last Hebrew word of a block, can change
        // the direction of what remains.
        if (record.type === "characterData" || record.removedNodes.length > 0) {
          applyDirectionsAround(record.target);
        }
        collectComposers(record.target, composers);
      }
      updateComposers(composers);
    });
    state.observer.observe(document.documentElement, {
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["dir"],
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
