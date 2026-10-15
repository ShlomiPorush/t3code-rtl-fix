"use strict";

// T3 Code draws its element annotation window inside the preview <webview>,
// in a closed shadow root that scripts in the page cannot reach. A small
// listener in the preview reports when that window takes focus or receives
// typing, and the launcher then gives its comment field dir="auto" through the
// DevTools protocol, which can see into closed shadow roots. The previewed
// page's own content is never changed.
const ANNOTATION_HOST_SELECTOR = "[data-t3code-annotation-ui]";
const ANNOTATION_BINDING = "__t3RtlFixAnnotationFocus";
const WATCHER_FLAG = "__t3RtlFixAnnotationWatcher";
// Typing reports at most this often, so a comment does not trigger a DevTools
// round trip per keystroke.
const INPUT_REPORT_INTERVAL_MS = 500;

function buildAnnotationWatcherSource() {
  return `(() => {
  const binding = ${JSON.stringify(ANNOTATION_BINDING)};
  const hostSelector = ${JSON.stringify(ANNOTATION_HOST_SELECTOR)};
  const flag = ${JSON.stringify(WATCHER_FLAG)};
  const inputInterval = ${INPUT_REPORT_INTERVAL_MS};
  if (window[flag]) return;
  Object.defineProperty(window, flag, { value: true });
  let lastInputReport = 0;
  // Focus and input events from inside the closed shadow root reach the
  // document retargeted to the annotation host. Typing is a second trigger in
  // case the field gained focus before the window joined the document.
  const report = (event) => {
    const target = event.target;
    if (!(target instanceof Element) || !target.matches(hostSelector)) return;
    if (event.type === "input") {
      const now = Date.now();
      if (now - lastInputReport < inputInterval) return;
      lastInputReport = now;
    }
    const notify = window[binding];
    if (typeof notify === "function") notify(event.type);
  };
  document.addEventListener("focusin", report, true);
  document.addEventListener("input", report, true);
})();`;
}

function collectTextareas(node, found = []) {
  if (!node) return found;
  if (node.nodeName === "TEXTAREA") found.push(node.backendNodeId);
  for (const child of node.children || []) collectTextareas(child, found);
  for (const shadowRoot of node.shadowRoots || []) collectTextareas(shadowRoot, found);
  return found;
}

// send(method, params, sessionId) resolves with the CDP result object.
async function watchAnnotations(send, sessionId) {
  const source = buildAnnotationWatcherSource();
  await send("Runtime.addBinding", { name: ANNOTATION_BINDING }, sessionId);
  await send("Page.addScriptToEvaluateOnNewDocument", { source }, sessionId);
  await send("Runtime.evaluate", { expression: source }, sessionId);
}

// T3 Code can keep more than one annotation host in the page, for example one
// for the element highlight and one for the comment window, so every host is
// searched. Returns how many hosts and comment fields were found.
async function applyAnnotationDirection(send, sessionId) {
  const selector = JSON.stringify(ANNOTATION_HOST_SELECTOR);
  const count = await send(
    "Runtime.evaluate",
    { expression: `document.querySelectorAll(${selector}).length`, returnByValue: true },
    sessionId,
  );
  const hosts = Number(count?.result?.value) || 0;
  let fields = 0;
  for (let index = 0; index < hosts; index += 1) {
    const host = await send(
      "Runtime.evaluate",
      { expression: `document.querySelectorAll(${selector})[${index}]` },
      sessionId,
    );
    const hostObjectId = host?.result?.objectId;
    if (!hostObjectId) continue;
    try {
      const { node } = await send(
        "DOM.describeNode",
        { objectId: hostObjectId, depth: -1, pierce: true },
        sessionId,
      );
      for (const backendNodeId of collectTextareas(node)) {
        const { object } = await send("DOM.resolveNode", { backendNodeId }, sessionId);
        if (!object?.objectId) continue;
        try {
          await send(
            "Runtime.callFunctionOn",
            {
              objectId: object.objectId,
              functionDeclaration:
                'function () { if (this.getAttribute("dir") !== "auto") this.setAttribute("dir", "auto"); }',
            },
            sessionId,
          );
          fields += 1;
        } finally {
          await send("Runtime.releaseObject", { objectId: object.objectId }, sessionId);
        }
      }
    } finally {
      await send("Runtime.releaseObject", { objectId: hostObjectId }, sessionId);
    }
  }
  return { hosts, fields };
}

module.exports = {
  ANNOTATION_BINDING,
  ANNOTATION_HOST_SELECTOR,
  buildAnnotationWatcherSource,
  watchAnnotations,
  applyAnnotationDirection,
};
