"use strict";

// Opens a thread at the start of the agent's last reply. T3 Code opens a
// thread at its end, so a long reply shows its last lines and has to be
// scrolled back to its first one. T3 Code remembers where a thread was read
// only after it was left away from its end, and then it opens there.
//
// When a thread opens and T3 Code has placed it at its end, the page checks
// the last row of the conversation. When that row is a reply from the agent,
// or a proposed plan, whose start is above the visible area, it scrolls the
// start to the top. It leaves the thread as T3 Code placed it when the agent
// is still working, the reply fits, T3 Code returned to a remembered place,
// the person scrolls, clicks, or types first, or the page is not as expected.
//
// T3 Code keeps following the end of a thread until the person scrolls up,
// and pulls the view back to the end while it follows. A plain change of the
// scroll position does not count as scrolling up for T3 Code, so the page
// first sends the list one small upward wheel event. An event made by a
// script never scrolls the page itself.

const CONFIG = Object.freeze({
  scrollerSelector: ".messages-timeline-scroll",
  rowSelector: "[data-timeline-row-id]",
  loadingSelector: "[data-timeline-loading]",
  // Rows that show the agent at work.
  busyKinds: ["working", "work-live"],
  // The space above the start of the reply, as T3 Code leaves above a new turn.
  offset: 16,
  // How far from the end still counts as the end.
  endTolerance: 2,
  // Frames with no change before the thread counts as placed.
  stableFrames: 4,
  // How long the new thread may take to show, and to settle once shown.
  loadTimeout: 10000,
  settleTimeout: 3000,
  // Frames to keep the start of the reply in place while rows are measured.
  placeFrames: 30,
});

function replyStart(config) {
  if (window.top !== window) return;
  const flag = "__t3RtlReplyStart";
  if (window[flag]) return;
  Object.defineProperty(window, flag, { value: true });

  // The first two route segments name the thread, in a hash route or in the
  // path. Other changes, such as an opened panel, are not a new thread.
  const routeKey = () => {
    const route = location.hash.startsWith("#/") ? location.hash.slice(1).split("?")[0] : location.pathname;
    return route.split("/").filter(Boolean).slice(0, 2).join("/");
  };

  const rowsOf = (scroller) => [...scroller.querySelectorAll(config.rowSelector)];
  const signatureOf = (rows) => rows.map((row) => row.dataset.timelineRowId).join("\n");
  const currentScroller = () => {
    const scroller = document.querySelector(config.scrollerSelector);
    return scroller && scroller.querySelector(config.rowSelector) ? scroller : null;
  };

  // The visit of the open thread, from the moment its route shows until it
  // is placed or given up.
  let visit = null;

  const stop = () => {
    if (visit && visit.frame) cancelAnimationFrame(visit.frame);
    visit = null;
  };

  // A page that is not as expected ends the visit and changes nothing more.
  const guard = (fn) => (...args) => {
    try {
      fn(...args);
    } catch {
      stop();
    }
  };

  // The row whose start the thread opens on, or null.
  const replyRow = (scroller, rows) => {
    if (rows.some((row) => config.busyKinds.includes(row.dataset.timelineRowKind))) return null;
    let last = null;
    let lastBottom = -Infinity;
    for (const row of rows) {
      const bottom = row.getBoundingClientRect().bottom;
      if (bottom > lastBottom) {
        last = row;
        lastBottom = bottom;
      }
    }
    if (!last) return null;
    const kind = last.dataset.timelineRowKind;
    const reply = (kind === "message" && last.dataset.messageRole === "assistant") || kind === "proposed-plan";
    if (!reply) return null;
    const hidden = scroller.getBoundingClientRect().top + config.offset - last.getBoundingClientRect().top;
    return hidden > 1 ? last : null;
  };

  // Releases T3 Code's follow of the end, then keeps the start of the reply
  // at the top while the rows above it are measured.
  const place = (scroller, row) => {
    const id = row.dataset.timelineRowId;
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true, cancelable: true }));
    const job = { frame: 0 };
    visit = job;
    let frames = 0;
    let settled = 0;
    const step = guard(() => {
      if (visit !== job || !scroller.isConnected) return;
      const target = [...scroller.querySelectorAll(config.rowSelector)].find((r) => r.dataset.timelineRowId === id);
      if (!target) return stop();
      const delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - config.offset;
      if (Math.abs(delta) > 1) {
        scroller.scrollTop += delta;
        settled = 0;
      } else {
        settled += 1;
      }
      if (settled >= 3 || ++frames >= config.placeFrames) return stop();
      job.frame = requestAnimationFrame(step);
    });
    step();
  };

  const start = (previousSignature) => {
    stop();
    const job = { frame: 0, started: performance.now(), shown: 0, metrics: "", stable: 0, sawEnd: false };
    visit = job;
    const tick = guard(() => {
      if (visit !== job) return;
      job.frame = requestAnimationFrame(tick);
      const now = performance.now();
      const scroller = currentScroller();
      const rows = scroller ? rowsOf(scroller) : [];
      const signature = signatureOf(rows);
      // Wait for the rows of this thread, not the ones still shown from the
      // thread before it.
      if (!scroller || signature === previousSignature || document.querySelector(config.loadingSelector)) {
        job.stable = 0;
        if (now - job.started > config.loadTimeout) stop();
        return;
      }
      if (!job.shown) job.shown = now;
      if (now - job.shown > config.settleTimeout) return stop();
      // A thread T3 Code opens fresh is scrolled to its very end first, and
      // T3 Code may then settle it a little above. A place T3 Code remembers
      // is restored directly.
      if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= config.endTolerance) job.sawEnd = true;
      const metrics = [scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight, signature].join("|");
      if (metrics !== job.metrics) {
        job.metrics = metrics;
        job.stable = 0;
        return;
      }
      if (++job.stable < config.stableFrames) return;
      stop();
      if (!job.sawEnd) return;
      const row = replyRow(scroller, rows);
      if (row) place(scroller, row);
    });
    job.frame = requestAnimationFrame(tick);
  };

  let lastKey = routeKey();
  const onRoute = () => {
    const key = routeKey();
    if (key === lastKey) return;
    lastKey = key;
    const scroller = currentScroller();
    start(scroller ? signatureOf(rowsOf(scroller)) : "");
  };

  // The person's own scrolling, clicking, or typing wins.
  const onInput = (event) => {
    if (event.isTrusted && visit) stop();
  };

  for (const type of ["wheel", "keydown", "pointerdown", "touchstart"]) {
    window.addEventListener(type, onInput, { capture: true, passive: true });
  }
  if (window.navigation && typeof window.navigation.addEventListener === "function") {
    window.navigation.addEventListener("currententrychange", guard(onRoute));
  }
  window.addEventListener("popstate", guard(onRoute));
  window.addEventListener("hashchange", guard(onRoute));
  guard(start)("");
}

function buildReplyStartSource(config = CONFIG) {
  return `(${replyStart.toString()})(${JSON.stringify(config)});`;
}

module.exports = { CONFIG, buildReplyStartSource };
