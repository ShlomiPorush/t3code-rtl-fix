"use strict";

// T3 Code draws its element annotation window inside the preview <webview>,
// in a closed shadow root that scripts in the page cannot reach. A small
// listener in the preview reports when that window takes focus, and the
// launcher then gives its comment field dir="auto" through the DevTools
// protocol, which can see into closed shadow roots. The previewed page's own
// content is never changed.
const ANNOTATION_HOST_SELECTOR = "[data-t3code-annotation-ui]";
const ANNOTATION_BINDING = "__t3RtlFixAnnotationFocus";
const WATCHER_FLAG = "__t3RtlFixAnnotationWatcher";

function buildAnnotationWatcherSource() {
  return `(() => {
  const binding = ${JSON.stringify(ANNOTATION_BINDING)};
  const hostSelector = ${JSON.stringify(ANNOTATION_HOST_SELECTOR)};
  const flag = ${JSON.stringify(WATCHER_FLAG)};
  if (window[flag]) return;
  Object.defineProperty(window, flag, { value: true });
  document.addEventListener("focusin", (event) => {
    const target = event.target;
    if (!(target instanceof Element) || !target.matches(hostSelector)) return;
    const report = window[binding];
    if (typeof report === "function") report("focus");
  }, true);
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

async function applyAnnotationDirection(send, sessionId) {
  const host = await send(
    "Runtime.evaluate",
    { expression: `document.querySelector(${JSON.stringify(ANNOTATION_HOST_SELECTOR)})` },
    sessionId,
  );
  const hostObjectId = host?.result?.objectId;
  if (!hostObjectId) return 0;

  let updated = 0;
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
        updated += 1;
      } finally {
        await send("Runtime.releaseObject", { objectId: object.objectId }, sessionId);
      }
    }
  } finally {
    await send("Runtime.releaseObject", { objectId: hostObjectId }, sessionId);
  }
  return updated;
}

module.exports = {
  ANNOTATION_BINDING,
  ANNOTATION_HOST_SELECTOR,
  buildAnnotationWatcherSource,
  watchAnnotations,
  applyAnnotationDirection,
};
