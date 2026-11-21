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
  // Rows that show the agent at work, and the composer's stop button, which
  // shows while it works even when those rows are not rendered.
  busyKinds: ["working", "work-live"],
  busySelector: 'button[class~="bg-destructive/90"][class~="rounded-full"]:has(> svg > rect)',
  // First route segments that name no thread.
  otherRoutes: ["draft", "settings"],
  // T3 Code opens a citation's source with this in the address, and scrolls
  // to the quoted text itself.
  citationMarker: "#assistant-citation=",
  // T3 Code shows its Scroll to end button once the person scrolled away from
  // the end. It remembers the last threads left, this many, and opens one
  // left with the button shown at the same place again.
  scrollToEndSelector: "[data-scroll-to-end]",
  rememberedThreads: 100,
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
  // path. Other changes, such as an opened panel, are not a new thread. A
  // route that names no thread gives an empty key.
  const routeKey = () => {
    const route = location.hash.startsWith("#/") ? location.hash.slice(1).split(/[?#]/)[0] : location.pathname;
    const segments = route.split("/").filter(Boolean);
    if (segments.length < 2 || config.otherRoutes.includes(segments[0])) return "";
    return segments.slice(0, 2).join("/");
  };
  const citationOpen = () => location.href.includes(config.citationMarker);

  // The threads left since the page loaded, the last left at the end, each
  // with whether it was left away from its end, as T3 Code keeps them.
  const left = new Map();
  // The open thread and the message rows shown when it was opened, which
  // belong to the thread before it.
  let entered = { key: "", previous: new Set() };
  const rememberLeaving = (key) => {
    const scroller = currentScroller();
    if (!key || key !== entered.key || !scroller) return;
    // The list may still show the thread before, if this one never showed.
    if (idsOf(scroller).some((id) => entered.previous.has(id))) return;
    left.delete(key);
    left.set(key, !!document.querySelector(config.scrollToEndSelector));
    if (left.size > config.rememberedThreads) left.delete(left.keys().next().value);
  };

  // Message rows only: other rows, such as the worktree setup row, have the
  // same id in every thread.
  const idsOf = (scroller) =>
    [...scroller.querySelectorAll(config.rowSelector)]
      .filter((row) => row.dataset.timelineRowKind === "message")
      .map((row) => row.dataset.timelineRowId);
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
  const replyRow = (scroller) => {
    const rows = [...scroller.querySelectorAll(config.rowSelector)];
    if (rows.some((row) => config.busyKinds.includes(row.dataset.timelineRowKind))) return null;
    if (document.querySelector(config.busySelector)) return null;
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
    const hidden = scroller.getBoundingClientRect().top - last.getBoundingClientRect().top;
    return hidden > 1 ? last : null;
  };

  // Releases T3 Code's follow of the end, then keeps the start of the reply
  // at the top while the rows above it are measured.
  const place = (scroller, row) => {
    const id = row.dataset.timelineRowId;
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
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

  // previousIds are the rows shown when the route changed, which belong to
  // the thread before it.
  const start = (previousIds) => {
    stop();
    const previous = new Set(previousIds);
    const job = { frame: 0, started: performance.now(), shown: 0, metrics: "", stable: 0, sawEnd: false };
    visit = job;
    const tick = guard(() => {
      if (visit !== job) return;
      if (citationOpen()) return stop();
      job.frame = requestAnimationFrame(tick);
      const now = performance.now();
      const scroller = currentScroller();
      const ids = scroller ? idsOf(scroller) : [];
      // Wait for the rows of this thread. A row still shown from the thread
      // before it means the list is not this thread's yet.
      if (!scroller || ids.some((id) => previous.has(id)) || document.querySelector(config.loadingSelector)) {
        job.stable = 0;
        if (now - job.started > config.loadTimeout) stop();
        return;
      }
      if (!job.shown) job.shown = now;
      if (now - job.shown > config.settleTimeout) return stop();
      // A thread T3 Code opens fresh is scrolled to its very end first, and
      // T3 Code may then settle it a little above. A place T3 Code remembers
      // is restored directly. A list too short to scroll is at its end before
      // T3 Code places it, so that end does not count.
      const fromEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      if (fromEnd <= config.endTolerance && scroller.scrollTop > 0) job.sawEnd = true;
      const metrics = [scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight, ids.join(" ")].join("|");
      if (metrics !== job.metrics) {
        job.metrics = metrics;
        job.stable = 0;
        return;
      }
      if (++job.stable < config.stableFrames) return;
      // A list still at its top may not be placed yet, so the visit waits for
      // T3 Code to scroll it to the end until the time is up. A list placed
      // elsewhere is a place T3 Code restored.
      if (!job.sawEnd) {
        if (scroller.scrollTop > 0) stop();
        return;
      }
      stop();
      const row = replyRow(scroller);
      if (row) place(scroller, row);
    });
    job.frame = requestAnimationFrame(tick);
  };

  let lastKey = routeKey();
  entered = { key: lastKey, previous: new Set() };
  const onRoute = () => {
    const key = routeKey();
    if (key === lastKey) return;
    // The list still shows the thread being left.
    rememberLeaving(lastKey);
    lastKey = key;
    const scroller = currentScroller();
    const previous = scroller ? idsOf(scroller) : [];
    entered = { key, previous: new Set(previous) };
    if (!key || left.get(key)) return stop();
    start(previous);
  };

  // The person's own scrolling, clicking, or typing wins. A click that no
  // pointer made, such as one from assistive technology, counts too.
  const onInput = (event) => {
    if (!event.isTrusted || !visit) return;
    if (event.type === "click" && event.detail !== 0) return;
    stop();
  };

  for (const type of ["wheel", "keydown", "pointerdown", "touchstart", "click"]) {
    window.addEventListener(type, onInput, { capture: true, passive: true });
  }
  if (window.navigation && typeof window.navigation.addEventListener === "function") {
    window.navigation.addEventListener("currententrychange", guard(onRoute));
  }
  window.addEventListener("popstate", guard(onRoute));
  window.addEventListener("hashchange", guard(onRoute));
  // A thread already shown when this script arrives was placed before it,
  // and stays as it is.
  if (lastKey && !currentScroller()) guard(start)([]);
}

function buildReplyStartSource(config = CONFIG) {
  return `(${replyStart.toString()})(${JSON.stringify(config)});`;
}

module.exports = { CONFIG, buildReplyStartSource };
