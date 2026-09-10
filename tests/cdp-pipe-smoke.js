"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { buildInjectionSource } = require("../src/injection");

const edgePath = path.join(
  process.env["ProgramFiles(x86)"] || "",
  "Microsoft",
  "Edge",
  "Application",
  "msedge.exe",
);
const css = fs.readFileSync(path.join(__dirname, "..", "src", "rtl.css"), "utf8");
const injectionSource = buildInjectionSource(css);
const rtlText = "\u05d4\u05d5\u05d3\u05e2\u05d4 \u05d1\u05e2\u05d1\u05e8\u05d9\u05ea";

if (process.platform !== "win32" || !fs.existsSync(edgePath)) {
  process.stdout.write("CDP pipe smoke test skipped: Microsoft Edge is unavailable\n");
  process.exit(0);
}

const testProfile = fs.mkdtempSync(path.join(os.tmpdir(), "t3-rtl-pipe-test-"));
const child = spawn(edgePath, [
  "--headless=new",
  "--no-first-run",
  `--user-data-dir=${testProfile}`,
  "--remote-debugging-pipe",
  "about:blank",
], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });

const input = child.stdio[3];
const output = child.stdio[4];
const pending = new Map();
let nextId = 1;
let incoming = Buffer.alloc(0);

function send(method, params = {}, sessionId) {
  const id = nextId++;
  const message = { id, method, params };
  if (sessionId) message.sessionId = sessionId;
  input.write(`${JSON.stringify(message)}\0`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

output.on("data", (chunk) => {
  incoming = Buffer.concat([incoming, chunk]);
  while (true) {
    const separator = incoming.indexOf(0);
    if (separator === -1) break;
    const raw = incoming.subarray(0, separator).toString("utf8");
    incoming = incoming.subarray(separator + 1);
    if (!raw) continue;
    const message = JSON.parse(raw);
    if (!message.id || !pending.has(message.id)) continue;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result || {});
  }
});

async function run() {
  const { targetInfos } = await send("Target.getTargets");
  const page = targetInfos.find((target) => target.type === "page");
  if (!page) throw new Error("No page target was created");
  const { sessionId } = await send("Target.attachToTarget", {
    targetId: page.targetId,
    flatten: true,
  });
  const fixtureHtml = `
    <style>
      :root { --border: rgb(10, 20, 30); }
      .chat-markdown ul { --list-gutter: 20px; padding-left: 20px; }
      .chat-markdown li.task-list-item input { margin: 0 5px 2px -20px; }
      .chat-markdown blockquote { border-left: 2px solid var(--border); padding-left: 12px; }
      .chat-markdown div[role="note"] { border-left: 2px solid blue; padding-left: 12px; }
      #table { width: 280px; }
      #table-scroll { width: 100%; overflow-x: auto; }
      .chat-markdown table { width: 100%; min-width: max-content; border-collapse: collapse; }
      .chat-markdown th, .chat-markdown td { padding: 8px 12px; text-align: start; }
      .chat-markdown-table-container[data-expanded="false"] th,
      .chat-markdown-table-container[data-expanded="false"] td { white-space: nowrap; }
      .chat-markdown-table-container[data-expanded="true"] td { overflow-wrap: anywhere; }
      .text-left { text-align: left; }
      .justify-end { justify-content: flex-end; }
      .chip-button { margin-left: 3px; }
      #citation-comment-editor, #english-citation-comment-editor { width: 280px; }
      [data-citation-comment-editor] textarea { width: 100%; }
      .flex { display: flex; }
      .flex-1 { flex: 1 1 0%; }
      .gap-3 { gap: 12px; }
      .ml-auto { margin-left: auto; }
      .w-full { width: 300px; }
      .icon { width: 16px; height: 16px; }
    </style>
    <div data-message-role="assistant">
      <div id="rtl-message" class="chat-markdown">
        <p id="rtl-paragraph">${rtlText}</p>
        <code id="inline-code">npm test</code>
        <p id="english-paragraph">An English paragraph.</p>
        <p id="english-leading-paragraph">pstack ${rtlText}</p>
        <p>${rtlText} <strong id="english-strong">Claude Code</strong> ${rtlText}</p>
        <ol><li id="english-leading-item"><strong>pstack</strong> ${rtlText} Cursor, ${rtlText} Claude Code.</li></ol>
        <a id="file-link" class="chat-markdown-file-link">src/index.ts</a>
        <ul id="rtl-list"><li class="task-list-item"><input id="task-checkbox" type="checkbox">${rtlText}</li></ul>
        <blockquote id="rtl-quote">${rtlText}</blockquote>
        <div id="rtl-alert" role="note">${rtlText}</div>
        <div id="table" class="chat-markdown-table-container" data-expanded="false">
          <div id="table-scroll">
            <table id="table-element">
              <thead><tr><th>Number</th><th>${rtlText}</th><th>Details</th></tr></thead>
              <tbody><tr><td id="english-cell">Name</td><td id="rtl-cell">${rtlText}</td><td>long-unbroken-table-content-that-needs-wrapping</td></tr></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
    <div data-message-role="assistant">
      <div id="code-first-message" class="chat-markdown"><code>npm</code><p id="code-first-paragraph">${rtlText}</p></div>
    </div>
    <div data-message-role="user">
      <div id="english-message" class="chat-markdown"><p id="english-user-paragraph">English user message.</p></div>
    </div>
    <div data-message-role="user">
      <div id="rtl-user-message" class="chat-markdown"><p id="rtl-user-paragraph">${rtlText}</p></div>
    </div>
    <div data-message-role="assistant">
      <div class="chat-markdown"><p id="streamed-paragraph">pstack</p></div>
    </div>
    <div data-pull-request-summary-scroll>
      <section data-pull-request-summary-section>
        <div id="pull-request-markdown" class="chat-markdown">
          <h2 id="pull-request-heading">${rtlText}</h2>
          <p id="pull-request-paragraph">session-transfer ${rtlText}</p>
          <p id="pull-request-english-paragraph">English pull request text.</p>
          <ul><li id="pull-request-list-item"><code>npm test</code> ${rtlText}</li></ul>
        </div>
      </section>
    </div>
    <div data-preview-panel-mode="panel">
      <button aria-label="Show markdown source"></button>
      <div id="file-markdown" class="chat-markdown">
        <h2 id="file-markdown-heading">${rtlText}</h2>
        <p id="file-markdown-paragraph">Docker ${rtlText}</p>
        <p id="file-markdown-english-paragraph">English file documentation.</p>
        <div id="file-markdown-table" class="chat-markdown-table-container">
          <table><tbody><tr><td id="file-markdown-rtl-cell">${rtlText}</td></tr></tbody></table>
        </div>
        <pre><code id="file-markdown-code">npm test</code></pre>
      </div>
    </div>
    <div id="pending-card" data-slot="collapsible">
      <button
        id="pending-toggle"
        class="flex w-full text-left"
        data-slot="collapsible-trigger"
        data-pending-user-input-toggle="expanded"
      ><span>${rtlText}</span><span>3/3</span><svg id="pending-chevron" class="icon ml-auto"></svg></button>
      <div data-slot="collapsible-panel">
        <p id="pending-question">${rtlText} GitHub?</p>
        <button id="pending-option" class="flex w-full gap-3 text-left">
          <div id="pending-option-content" class="flex flex-1">
            <span>${rtlText} Docker</span>
          </div>
          <kbd id="pending-shortcut">1</kbd>
        </button>
        <button id="pending-english-option" class="flex w-full gap-3 text-left">
          <div id="pending-english-option-content" class="flex flex-1">
            <span>Use the local fix</span>
          </div>
          <kbd id="pending-english-shortcut">2</kbd>
        </button>
        <button id="pending-selected-option" class="flex w-full gap-3 text-left">
          <div id="pending-selected-option-content" class="flex flex-1">
            <span>${rtlText} selected</span>
          </div>
          <kbd id="pending-selected-shortcut">3</kbd>
        </button>
        <button id="pending-english-selected-option" class="flex w-full gap-3 text-left">
          <div id="pending-english-selected-option-content" class="flex flex-1">
            <span>Selected English option</span>
          </div>
          <kbd id="pending-english-selected-shortcut">4</kbd>
        </button>
      </div>
    </div>
    <div id="plan-card">
      <div class="flex">
        <div class="flex flex-1"><span>Plan</span><p id="plan-title">${rtlText} RTL FIX</p></div>
        <button aria-label="Plan actions">...</button>
      </div>
      <div>
        <div id="plan-markdown" class="chat-markdown" dir="auto">
          <h2 id="plan-heading">${rtlText}</h2>
          <p id="plan-paragraph">${rtlText} <code>RTL FIX</code> ${rtlText}</p>
          <ul><li id="plan-list-item"><code>dir=rtl</code> ${rtlText}</li></ul>
        </div>
      </div>
    </div>
    <div id="english-plan-card">
      <div class="flex">
        <div class="flex flex-1"><span>Plan</span><p id="english-plan-title">English plan</p></div>
        <button aria-label="Plan actions">...</button>
      </div>
      <div>
        <div id="english-plan-markdown" class="chat-markdown" dir="auto">
          <h2 id="english-plan-heading">Summary</h2>
          <p id="english-plan-paragraph">Keep the English layout unchanged.</p>
        </div>
      </div>
    </div>
    <div id="rtl-turn-plan" class="min-w-0 px-1 py-0.5">
      <button id="rtl-turn-plan-toggle" class="flex w-full text-left" aria-expanded="false">
        <svg id="rtl-turn-plan-chevron" class="icon"></svg>
        <span aria-hidden class="flex"><span></span><span></span></span>
        <span id="rtl-turn-plan-label" class="min-w-0 truncate">${rtlText}</span>
        <span id="rtl-turn-plan-count" class="shrink-0 tabular-nums">0/3</span>
      </button>
      <div class="mt-0.5 space-y-px pl-6">
        <div id="rtl-turn-plan-step" class="flex items-baseline"><span>○</span><span>${rtlText}</span></div>
      </div>
    </div>
    <div id="rtl-expanded-turn-plan" class="min-w-0 px-1 py-0.5">
      <button class="flex w-full text-left" aria-expanded="true">
        <svg id="rtl-expanded-turn-plan-chevron" class="icon"></svg>
        <span id="rtl-expanded-turn-plan-label" class="min-w-0 truncate">${rtlText}</span>
        <span class="shrink-0 tabular-nums">1/3</span>
      </button>
    </div>
    <div id="english-turn-plan" class="min-w-0 px-1 py-0.5">
      <button id="english-turn-plan-toggle" class="flex w-full text-left" aria-expanded="false">
        <svg id="english-turn-plan-chevron" class="icon"></svg>
        <span aria-hidden class="flex"><span></span><span></span></span>
        <span id="english-turn-plan-label" class="min-w-0 truncate">Implement the plan</span>
        <span class="shrink-0 tabular-nums">1/3</span>
      </button>
    </div>
    <div id="rtl-composer-tasks" class="chat-composer-tasks-tab flex" data-composer-tasks-badge="true">
      <button id="rtl-composer-tasks-toggle" class="flex min-w-0 flex-1 text-left" aria-expanded="false" aria-label="Tasks: 0 of 3 complete">
        <svg class="icon"></svg><span>Tasks</span>
        <span id="rtl-composer-task-current" class="min-w-0 flex-1 truncate text-left" data-composer-task-current="true">${rtlText}</span>
        <span class="tabular-nums">0/3</span><span aria-hidden class="flex"></span>
      </button>
      <button aria-label="Dismiss tasks for this turn"><svg class="icon"></svg></button>
    </div>
    <div id="english-composer-tasks" class="chat-composer-tasks-tab flex" data-composer-tasks-badge="true">
      <button id="english-composer-tasks-toggle" class="flex min-w-0 flex-1 text-left" aria-expanded="false" aria-label="Tasks: 1 of 3 complete">
        <svg class="icon"></svg><span>Tasks</span>
        <span id="english-composer-task-current" class="min-w-0 flex-1 truncate text-left" data-composer-task-current="true">Implement the plan</span>
        <span class="tabular-nums">1/3</span><span aria-hidden class="flex"></span>
      </button>
      <button aria-label="Dismiss tasks for this turn"><svg class="icon"></svg></button>
    </div>
    <div id="citation-comment-editor" data-citation-comment-editor="true">
      <textarea id="citation-comment-input" aria-label="Comment on selected text" placeholder="Add an optional comment..."></textarea>
      <p id="citation-comment-status" role="status">Comments can contain up to 4,000 characters.</p>
      <div id="citation-comment-actions" class="flex items-center justify-end gap-3">
        <button id="citation-comment-cancel">Cancel</button>
        <button id="citation-comment-save">Save</button>
      </div>
    </div>
    <div id="english-citation-comment-editor" data-citation-comment-editor="true">
      <textarea id="english-citation-comment-input" aria-label="Comment on selected text"></textarea>
      <div id="english-citation-comment-actions" class="flex items-center justify-end gap-3">
        <button id="english-citation-comment-cancel">Cancel</button>
        <button id="english-citation-comment-save">Save</button>
      </div>
    </div>
    <span id="rtl-citation-chip" class="flex" data-assistant-citation-chip="true">
      <a id="rtl-citation-chip-link"><svg class="icon"></svg><span id="rtl-citation-chip-label">${rtlText}</span></a>
      <button id="rtl-citation-chip-edit" class="chip-button" aria-label="Edit citation comment"><svg class="icon"></svg></button>
    </span>
    <span id="english-citation-chip" class="flex" data-assistant-citation-chip="true">
      <a id="english-citation-chip-link"><svg class="icon"></svg><span id="english-citation-chip-label">Cite this line</span></a>
      <button id="english-citation-chip-edit" class="chip-button" aria-label="Edit citation comment"><svg class="icon"></svg></button>
    </span>
    <div id="composer-chrome">
      <textarea id="pending-answer" placeholder="Type your own answer"></textarea>
      <button>Submit answers</button>
    </div>`;
  await send("Runtime.evaluate", {
    expression: `document.body.innerHTML = ${JSON.stringify(fixtureHtml)}`,
  }, sessionId);
  await send("Runtime.evaluate", { expression: injectionSource }, sessionId);
  const result = await send("Runtime.evaluate", {
    expression: `new Promise((resolve) => {
      const dynamicRow = document.createElement("div");
      dynamicRow.setAttribute("data-message-role", "assistant");
      dynamicRow.innerHTML = '<div id="dynamic-message" class="chat-markdown"><p id="dynamic-paragraph">${rtlText}</p><pre><code id="dynamic-code">const value = 1;</code></pre></div>';
      document.body.appendChild(dynamicRow);
      const dynamicPlanCard = document.createElement("div");
      dynamicPlanCard.id = "dynamic-plan-card";
      dynamicPlanCard.innerHTML = '<div><div><p id="dynamic-plan-title">${rtlText}</p></div><button aria-label="Plan actions">...</button></div><div><div id="dynamic-plan-markdown" class="chat-markdown" dir="auto"><p id="dynamic-plan-paragraph">${rtlText}</p></div></div>';
      document.body.appendChild(dynamicPlanCard);
      for (const [shortcutId, checkId] of [
        ["pending-selected-shortcut", "pending-selected-check"],
        ["pending-english-selected-shortcut", "pending-english-selected-check"],
      ]) {
        const check = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        check.id = checkId;
        check.setAttribute("class", "icon");
        document.getElementById(shortcutId).replaceWith(check);
      }
      document.getElementById("streamed-paragraph").append(" ", ${JSON.stringify(rtlText)});
      const dynamicCommentEditor = document.createElement("div");
      dynamicCommentEditor.id = "dynamic-citation-comment-editor";
      dynamicCommentEditor.setAttribute("data-citation-comment-editor", "true");
      dynamicCommentEditor.innerHTML = '<textarea id="dynamic-citation-comment-input" aria-label="Comment on selected text"></textarea>';
      document.body.appendChild(dynamicCommentEditor);
      // The popup opens empty and the user types into it, so the comment
      // direction has to follow the value rather than the initial markup.
      const commentInput = document.getElementById("citation-comment-input");
      commentInput.value = ${JSON.stringify(rtlText)};
      commentInput.dispatchEvent(new Event("input", { bubbles: true }));
      const englishCommentInput = document.getElementById("english-citation-comment-input");
      englishCommentInput.value = "Rename this option.";
      englishCommentInput.dispatchEvent(new Event("input", { bubbles: true }));
      const tableContainer = document.getElementById("table");
      const tableScroll = document.getElementById("table-scroll");
      const tableElement = document.getElementById("table-element");
      const collapsedTableOverflows = tableScroll.scrollWidth > tableScroll.clientWidth;
      tableContainer.dataset.expanded = "true";
      setTimeout(() => {
        const style = (id) => getComputedStyle(document.getElementById(id));
        resolve({
          styleInjected: Boolean(document.getElementById("t3-rtl-fix")),
          rtlMessageDir: document.getElementById("rtl-message").dir,
          rtlMessageDirection: style("rtl-message").direction,
          rtlParagraphDir: document.getElementById("rtl-paragraph").dir,
          rtlParagraphDirection: style("rtl-paragraph").direction,
          englishParagraphDir: document.getElementById("english-paragraph").dir,
          englishParagraphDirection: style("english-paragraph").direction,
          englishLeadingParagraphDir: document.getElementById("english-leading-paragraph").dir,
          englishLeadingParagraphDirection: style("english-leading-paragraph").direction,
          englishStrongDir: document.getElementById("english-strong").dir,
          englishStrongDirection: style("english-strong").direction,
          englishLeadingItemDir: document.getElementById("english-leading-item").dir,
          englishLeadingItemDirection: style("english-leading-item").direction,
          englishMessageDir: document.getElementById("english-message").dir,
          englishMessageDirection: style("english-message").direction,
          rtlUserMessageDir: document.getElementById("rtl-user-message").dir,
          rtlUserMessageDirection: style("rtl-user-message").direction,
          rtlUserParagraphDir: document.getElementById("rtl-user-paragraph").dir,
          rtlUserParagraphDirection: style("rtl-user-paragraph").direction,
          codeFirstDirection: style("code-first-message").direction,
          codeFirstParagraphDirection: style("code-first-paragraph").direction,
          inlineCodeDir: document.getElementById("inline-code").dir,
          fileLinkDir: document.getElementById("file-link").dir,
          listPaddingLeft: style("rtl-list").paddingLeft,
          listPaddingRight: style("rtl-list").paddingRight,
          taskMarginInlineStart: style("task-checkbox").marginInlineStart,
          quoteBorderLeft: style("rtl-quote").borderLeftWidth,
          quoteBorderRight: style("rtl-quote").borderRightWidth,
          alertBorderLeft: style("rtl-alert").borderLeftWidth,
          alertBorderRight: style("rtl-alert").borderRightWidth,
          tableDir: document.getElementById("table").dir,
          collapsedTableOverflows,
          expandedTableFits: tableElement.getBoundingClientRect().width <= tableScroll.clientWidth + 1,
          englishCellDir: document.getElementById("english-cell").dir,
          rtlCellDir: document.getElementById("rtl-cell").dir,
          dynamicMessageDir: document.getElementById("dynamic-message").dir,
          dynamicMessageDirection: style("dynamic-message").direction,
          dynamicParagraphDirection: style("dynamic-paragraph").direction,
          dynamicCodeDir: document.getElementById("dynamic-code").dir,
          streamedParagraphDir: document.getElementById("streamed-paragraph").dir,
          streamedParagraphDirection: style("streamed-paragraph").direction,
          pullRequestMarkdownDir: document.getElementById("pull-request-markdown").dir,
          pullRequestMarkdownDirection: style("pull-request-markdown").direction,
          pullRequestHeadingDir: document.getElementById("pull-request-heading").dir,
          pullRequestParagraphDir: document.getElementById("pull-request-paragraph").dir,
          pullRequestEnglishParagraphDir: document.getElementById(
            "pull-request-english-paragraph",
          ).dir,
          pullRequestListItemDir: document.getElementById("pull-request-list-item").dir,
          pullRequestCodeDir: document.querySelector("#pull-request-list-item code").dir,
          fileMarkdownDir: document.getElementById("file-markdown").dir,
          fileMarkdownDirection: style("file-markdown").direction,
          fileMarkdownHeadingDir: document.getElementById("file-markdown-heading").dir,
          fileMarkdownParagraphDir: document.getElementById("file-markdown-paragraph").dir,
          fileMarkdownEnglishParagraphDir: document.getElementById(
            "file-markdown-english-paragraph",
          ).dir,
          fileMarkdownTableDir: document.getElementById("file-markdown-table").dir,
          fileMarkdownRtlCellDir: document.getElementById("file-markdown-rtl-cell").dir,
          fileMarkdownCodeDir: document.getElementById("file-markdown-code").dir,
          pendingCardDir: document.getElementById("pending-card").dir,
          pendingCardDirection: style("pending-card").direction,
          pendingToggleDir: document.getElementById("pending-toggle").dir,
          pendingToggleTextAlign: style("pending-toggle").textAlign,
          pendingChevronAtFarEdge:
            Math.abs(
              document.getElementById("pending-chevron").getBoundingClientRect().left -
                document.getElementById("pending-toggle").getBoundingClientRect().left,
            ) <= 12,
          pendingQuestionDir: document.getElementById("pending-question").dir,
          pendingOptionDir: document.getElementById("pending-option").dir,
          pendingOptionTextAlign: style("pending-option").textAlign,
          pendingShortcutDir: document.getElementById("pending-shortcut").dir,
          pendingShortcutAfterContent:
            document.getElementById("pending-shortcut").getBoundingClientRect().left >=
            document.getElementById("pending-option-content").getBoundingClientRect().right,
          pendingEnglishOptionDir: document.getElementById("pending-english-option").dir,
          pendingEnglishShortcutDir: document.getElementById("pending-english-shortcut").dir,
          pendingEnglishShortcutBeforeContent:
            document.getElementById("pending-english-shortcut").getBoundingClientRect().right <=
            document
              .getElementById("pending-english-option-content")
              .getBoundingClientRect().left,
          pendingSelectedOptionDir: document.getElementById("pending-selected-option").dir,
          pendingSelectedOptionTextAlign: style("pending-selected-option").textAlign,
          pendingSelectedCheckAfterContent:
            document.getElementById("pending-selected-check").getBoundingClientRect().left >=
            document
              .getElementById("pending-selected-option-content")
              .getBoundingClientRect().right,
          pendingEnglishSelectedOptionDir: document.getElementById(
            "pending-english-selected-option",
          ).dir,
          pendingEnglishSelectedOptionTextAlign: style(
            "pending-english-selected-option",
          ).textAlign,
          pendingEnglishSelectedCheckBeforeContent:
            document.getElementById("pending-english-selected-check").getBoundingClientRect()
              .right <=
            document
              .getElementById("pending-english-selected-option-content")
              .getBoundingClientRect().left,
          planCardMarked: document.getElementById("plan-card").hasAttribute("data-t3-rtl-plan-card"),
          planCardDir: document.getElementById("plan-card").dir,
          planTitleDir: document.getElementById("plan-title").dir,
          planTitleTextAlign: style("plan-title").textAlign,
          planMarkdownDir: document.getElementById("plan-markdown").dir,
          planHeadingDir: document.getElementById("plan-heading").dir,
          planParagraphDir: document.getElementById("plan-paragraph").dir,
          planListItemDir: document.getElementById("plan-list-item").dir,
          englishPlanCardMarked: document
            .getElementById("english-plan-card")
            .hasAttribute("data-t3-rtl-plan-card"),
          englishPlanCardDir: document.getElementById("english-plan-card").dir,
          englishPlanTitleDir: document.getElementById("english-plan-title").dir,
          englishPlanMarkdownDir: document.getElementById("english-plan-markdown").dir,
          englishPlanHeadingDir: document.getElementById("english-plan-heading").dir,
          englishPlanParagraphDir: document.getElementById("english-plan-paragraph").dir,
          dynamicPlanCardMarked: document
            .getElementById("dynamic-plan-card")
            .hasAttribute("data-t3-rtl-plan-card"),
          dynamicPlanCardDir: document.getElementById("dynamic-plan-card").dir,
          dynamicPlanTitleDir: document.getElementById("dynamic-plan-title").dir,
          dynamicPlanMarkdownDir: document.getElementById("dynamic-plan-markdown").dir,
          dynamicPlanParagraphDir: document.getElementById("dynamic-plan-paragraph").dir,
          rtlTurnPlanMarked: document
            .getElementById("rtl-turn-plan")
            .hasAttribute("data-t3-rtl-turn-plan"),
          rtlTurnPlanDir: document.getElementById("rtl-turn-plan").dir,
          rtlTurnPlanToggleDir: document.getElementById("rtl-turn-plan-toggle").dir,
          rtlTurnPlanToggleTextAlign: style("rtl-turn-plan-toggle").textAlign,
          rtlTurnPlanChevronOppositeLabel:
            document.getElementById("rtl-turn-plan-chevron").getBoundingClientRect().right <=
            document.getElementById("rtl-turn-plan-count").getBoundingClientRect().left,
          rtlCollapsedTurnPlanChevronTransform: style("rtl-turn-plan-chevron").transform,
          rtlExpandedTurnPlanChevronTransform: style(
            "rtl-expanded-turn-plan-chevron",
          ).transform,
          rtlTurnPlanStepDir: document.getElementById("rtl-turn-plan-step").dir,
          rtlTurnPlanExpandedPaddingLeft: getComputedStyle(
            document.getElementById("rtl-turn-plan-step").parentElement,
          ).paddingLeft,
          englishTurnPlanMarked: document
            .getElementById("english-turn-plan")
            .hasAttribute("data-t3-rtl-turn-plan"),
          englishTurnPlanDir: document.getElementById("english-turn-plan").dir,
          englishTurnPlanToggleDir: document.getElementById("english-turn-plan-toggle").dir,
          englishTurnPlanChevronBeforeLabel:
            document.getElementById("english-turn-plan-chevron").getBoundingClientRect().right <=
            document.getElementById("english-turn-plan-label").getBoundingClientRect().left,
          englishCollapsedTurnPlanChevronTransform: style(
            "english-turn-plan-chevron",
          ).transform,
          rtlComposerTasksDir: document.getElementById("rtl-composer-tasks").dir,
          rtlComposerTasksToggleDir: document.getElementById("rtl-composer-tasks-toggle").dir,
          rtlComposerTaskCurrentDir: document.getElementById("rtl-composer-task-current").dir,
          rtlComposerTaskCurrentTextAlign: style("rtl-composer-task-current").textAlign,
          englishComposerTasksDir: document.getElementById("english-composer-tasks").dir,
          englishComposerTasksToggleDir: document.getElementById("english-composer-tasks-toggle").dir,
          englishComposerTaskCurrentDir: document.getElementById("english-composer-task-current").dir,
          pendingAnswerDir: document.getElementById("pending-answer").dir,
          pendingAnswerDirection: style("pending-answer").direction,
          citationCommentInputDir: document.getElementById("citation-comment-input").dir,
          citationCommentInputDirection: style("citation-comment-input").direction,
          citationCommentInputTextAlign: style("citation-comment-input").textAlign,
          citationCommentInputUnicodeBidi: style("citation-comment-input").unicodeBidi,
          citationCommentEditorDirection: style("citation-comment-editor").direction,
          citationCommentStatusDir: document.getElementById("citation-comment-status").dir,
          citationCommentStatusTextAlign: style("citation-comment-status").textAlign,
          citationCommentSaveBeforeCancel:
            document.getElementById("citation-comment-save").getBoundingClientRect().right <=
            document.getElementById("citation-comment-cancel").getBoundingClientRect().left,
          citationCommentActionsAtStart:
            Math.abs(
              document.getElementById("citation-comment-save").getBoundingClientRect().left -
                document.getElementById("citation-comment-actions").getBoundingClientRect().left,
            ) <= 1,
          englishCitationCommentInputDir: document.getElementById(
            "english-citation-comment-input",
          ).dir,
          englishCitationCommentInputDirection: style("english-citation-comment-input").direction,
          englishCitationCommentEditorDirection: style("english-citation-comment-editor").direction,
          englishCitationCommentCancelBeforeSave:
            document.getElementById("english-citation-comment-cancel").getBoundingClientRect()
              .right <=
            document.getElementById("english-citation-comment-save").getBoundingClientRect().left,
          dynamicCitationCommentInputDir: document.getElementById(
            "dynamic-citation-comment-input",
          ).dir,
          rtlCitationChipDir: document.getElementById("rtl-citation-chip").dir,
          rtlCitationChipDirection: style("rtl-citation-chip").direction,
          rtlCitationChipLabelDir: document.getElementById("rtl-citation-chip-label").dir,
          rtlCitationChipEditMarginLeft: style("rtl-citation-chip-edit").marginLeft,
          rtlCitationChipEditMarginRightApplied:
            parseFloat(style("rtl-citation-chip-edit").marginRight) > 0,
          rtlCitationChipEditAfterLabel:
            document.getElementById("rtl-citation-chip-edit").getBoundingClientRect().right <=
            document.getElementById("rtl-citation-chip-link").getBoundingClientRect().left,
          englishCitationChipDir: document.getElementById("english-citation-chip").dir,
          englishCitationChipDirection: style("english-citation-chip").direction,
          englishCitationChipLabelDir: document.getElementById("english-citation-chip-label").dir,
          englishCitationChipEditMarginLeftApplied:
            parseFloat(style("english-citation-chip-edit").marginLeft) > 0,
          englishCitationChipEditMarginRight: style("english-citation-chip-edit").marginRight,
          englishCitationChipEditAfterLabel:
            document.getElementById("english-citation-chip-edit").getBoundingClientRect().left >=
            document.getElementById("english-citation-chip-link").getBoundingClientRect().right,
        });
      }, 0);
    })`,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  const actual = result.result?.value;
  const expected = {
    styleInjected: true,
    rtlMessageDir: "rtl",
    rtlMessageDirection: "rtl",
    rtlParagraphDir: "rtl",
    rtlParagraphDirection: "rtl",
    englishParagraphDir: "auto",
    englishParagraphDirection: "ltr",
    englishLeadingParagraphDir: "rtl",
    englishLeadingParagraphDirection: "rtl",
    englishStrongDir: "auto",
    englishStrongDirection: "ltr",
    englishLeadingItemDir: "rtl",
    englishLeadingItemDirection: "rtl",
    englishMessageDir: "auto",
    englishMessageDirection: "ltr",
    rtlUserMessageDir: "rtl",
    rtlUserMessageDirection: "rtl",
    rtlUserParagraphDir: "rtl",
    rtlUserParagraphDirection: "rtl",
    codeFirstDirection: "rtl",
    codeFirstParagraphDirection: "rtl",
    inlineCodeDir: "ltr",
    fileLinkDir: "ltr",
    listPaddingLeft: "0px",
    listPaddingRight: "20px",
    taskMarginInlineStart: "-20px",
    quoteBorderLeft: "0px",
    quoteBorderRight: "2px",
    alertBorderLeft: "0px",
    alertBorderRight: "2px",
    tableDir: "rtl",
    collapsedTableOverflows: true,
    expandedTableFits: true,
    englishCellDir: "auto",
    rtlCellDir: "rtl",
    dynamicMessageDir: "rtl",
    dynamicMessageDirection: "rtl",
    dynamicParagraphDirection: "rtl",
    dynamicCodeDir: "ltr",
    streamedParagraphDir: "rtl",
    streamedParagraphDirection: "rtl",
    pullRequestMarkdownDir: "rtl",
    pullRequestMarkdownDirection: "rtl",
    pullRequestHeadingDir: "rtl",
    pullRequestParagraphDir: "rtl",
    pullRequestEnglishParagraphDir: "auto",
    pullRequestListItemDir: "rtl",
    pullRequestCodeDir: "ltr",
    fileMarkdownDir: "rtl",
    fileMarkdownDirection: "rtl",
    fileMarkdownHeadingDir: "rtl",
    fileMarkdownParagraphDir: "rtl",
    fileMarkdownEnglishParagraphDir: "auto",
    fileMarkdownTableDir: "rtl",
    fileMarkdownRtlCellDir: "rtl",
    fileMarkdownCodeDir: "ltr",
    pendingCardDir: "rtl",
    pendingCardDirection: "rtl",
    pendingToggleDir: "rtl",
    pendingToggleTextAlign: "start",
    pendingChevronAtFarEdge: true,
    pendingQuestionDir: "rtl",
    pendingOptionDir: "rtl",
    pendingOptionTextAlign: "start",
    pendingShortcutDir: "ltr",
    pendingShortcutAfterContent: true,
    pendingEnglishOptionDir: "auto",
    pendingEnglishShortcutDir: "ltr",
    pendingEnglishShortcutBeforeContent: true,
    pendingSelectedOptionDir: "rtl",
    pendingSelectedOptionTextAlign: "start",
    pendingSelectedCheckAfterContent: true,
    pendingEnglishSelectedOptionDir: "auto",
    pendingEnglishSelectedOptionTextAlign: "start",
    pendingEnglishSelectedCheckBeforeContent: true,
    planCardMarked: true,
    planCardDir: "rtl",
    planTitleDir: "rtl",
    planTitleTextAlign: "start",
    planMarkdownDir: "rtl",
    planHeadingDir: "rtl",
    planParagraphDir: "rtl",
    planListItemDir: "rtl",
    englishPlanCardMarked: true,
    englishPlanCardDir: "auto",
    englishPlanTitleDir: "auto",
    englishPlanMarkdownDir: "auto",
    englishPlanHeadingDir: "auto",
    englishPlanParagraphDir: "auto",
    dynamicPlanCardMarked: true,
    dynamicPlanCardDir: "rtl",
    dynamicPlanTitleDir: "rtl",
    dynamicPlanMarkdownDir: "rtl",
    dynamicPlanParagraphDir: "rtl",
    rtlTurnPlanMarked: true,
    rtlTurnPlanDir: "rtl",
    rtlTurnPlanToggleDir: "rtl",
    rtlTurnPlanToggleTextAlign: "start",
    rtlTurnPlanChevronOppositeLabel: true,
    rtlCollapsedTurnPlanChevronTransform: "matrix(-1, 0, 0, 1, 0, 0)",
    rtlExpandedTurnPlanChevronTransform: "none",
    rtlTurnPlanStepDir: "rtl",
    rtlTurnPlanExpandedPaddingLeft: "0px",
    englishTurnPlanMarked: true,
    englishTurnPlanDir: "auto",
    englishTurnPlanToggleDir: "auto",
    englishTurnPlanChevronBeforeLabel: true,
    englishCollapsedTurnPlanChevronTransform: "none",
    rtlComposerTasksDir: "rtl",
    rtlComposerTasksToggleDir: "rtl",
    rtlComposerTaskCurrentDir: "rtl",
    rtlComposerTaskCurrentTextAlign: "start",
    englishComposerTasksDir: "auto",
    englishComposerTasksToggleDir: "auto",
    englishComposerTaskCurrentDir: "auto",
    pendingAnswerDir: "",
    pendingAnswerDirection: "ltr",
    citationCommentInputDir: "auto",
    citationCommentInputDirection: "rtl",
    citationCommentInputTextAlign: "start",
    citationCommentInputUnicodeBidi: "plaintext",
    citationCommentEditorDirection: "ltr",
    citationCommentStatusDir: "",
    citationCommentStatusTextAlign: "start",
    citationCommentSaveBeforeCancel: true,
    citationCommentActionsAtStart: true,
    englishCitationCommentInputDir: "auto",
    englishCitationCommentInputDirection: "ltr",
    englishCitationCommentEditorDirection: "ltr",
    englishCitationCommentCancelBeforeSave: true,
    dynamicCitationCommentInputDir: "auto",
    rtlCitationChipDir: "rtl",
    rtlCitationChipDirection: "rtl",
    rtlCitationChipLabelDir: "rtl",
    rtlCitationChipEditMarginLeft: "0px",
    rtlCitationChipEditMarginRightApplied: true,
    rtlCitationChipEditAfterLabel: true,
    englishCitationChipDir: "auto",
    englishCitationChipDirection: "ltr",
    englishCitationChipLabelDir: "auto",
    englishCitationChipEditMarginLeftApplied: true,
    englishCitationChipEditMarginRight: "0px",
    englishCitationChipEditAfterLabel: true,
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected injected layout: ${JSON.stringify(actual)}`);
  }
  process.stdout.write("CDP pipe direction injection passed\n");
}

const timeout = setTimeout(() => {
  process.stderr.write("CDP pipe injection timed out\n");
  child.kill();
  process.exitCode = 1;
}, 15000);

run().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
}).finally(() => {
  clearTimeout(timeout);
  child.kill();
});

child.on("exit", () => {
  const resolved = path.resolve(testProfile);
  const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (resolved.startsWith(tempRoot) && path.basename(resolved).startsWith("t3-rtl-pipe-test-")) {
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
