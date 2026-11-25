"use strict";

// The Home page: a card for every project with open work, and what is in the
// middle there.
//
// homeView is not called here. It is turned into source text and added to T3
// Code's script for the start route (see home-route.js), so it may use only
// what it gets. It returns the component.

function homeView({
  React, useProjects, useThreads, useBootstrapped, useNewThread, useRouter, useEnvironments,
  projectReference, Frame, focusProps, Header, electron, main, frameClass, css,
}) {
  const h = React.createElement;
  const OLD_MS = 14 * 24 * 60 * 60 * 1000;
  const ROWS = 5;
  const COLUMN_REM = 19.25;

  // T3 Code's project icon and its click handler for pull request links. Its
  // main script exports both under names that change with every build.
  let parts = null;
  function mainParts() {
    if (parts) return parts;
    const functions = Object.values(main).filter((value) => typeof value === "function").map((value) => [value, String(value)]);
    const only = (...marks) => {
      const found = functions.filter(([, text]) => marks.every((mark) => text.includes(mark)));
      return found.length === 1 ? found[0][0] : null;
    };
    parts = {
      Icon: only("projectIcon?.kind===`monogram`", "projectIcon?.kind===`emoji`"),
      useOpenPull: only("instanceof HTMLAnchorElement", "stopPropagation", "threadRef:") || (() => null),
    };
    return parts;
  }

  const directionOf = (text) => (/[\u0590-\u08ff]/.test(text) ? "rtl" : "ltr");
  const count = (number, one) => `${number} ${number === 1 ? one : `${one}s`}`;
  function ago(ms) {
    const minutes = Math.max(1, Math.round(ms / 60000));
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 2880) return `${Math.round(minutes / 60)}h`;
    return minutes < 86400 ? `${Math.round(minutes / 1440)}d` : `${Math.round(minutes / 43200)}mo`;
  }
  const timeOf = (text) => Date.parse(text || "") || 0;

  const repositoryOf = (project) =>
    /^github\.com\/([a-z0-9_-]+\/[\w.-]+)$/i.exec(project.repositoryIdentity?.canonicalKey || "")?.[1].toLowerCase() ?? null;

  const isWaiting = (thread) =>
    thread.hasPendingApprovals || thread.hasPendingUserInput || thread.pendingSubagentRequest != null || thread.pendingGuestMessageCount > 0;

  // An idle runtime with background work is an agent whose turn ended while its
  // delegates or commands still run. T3 Code lists it under Working too.
  function isWorking(thread, connected) {
    const status = thread.runtime?.status;
    const active = ["preparing", "queued", "starting", "running", "waiting"].includes(status);
    return (active || (status === "idle" && thread.pendingBackgroundTasks?.length > 0)) && connected.has(thread.environmentId);
  }

  function stateOf(thread, connected) {
    if (isWaiting(thread)) return "ask";
    if (isWorking(thread, connected)) return "run";
    const run = thread.latestRun;
    if (run?.status === "failed") return "fail";
    const unread = thread.lastVisitedAt && timeOf(run?.completedAt) > timeOf(thread.lastVisitedAt);
    return unread && run.status !== "interrupted" && run.status !== "cancelled" ? "done" : "idle";
  }

  // T3 Code's own rule: a snoozed thread comes back early when something new
  // needs its owner.
  function isSnoozed(thread, now) {
    if (timeOf(thread.snoozedUntil) <= now) return false;
    const isNew = (at) => !thread.snoozedAt || timeOf(at) > timeOf(thread.snoozedAt);
    const request = thread.source?.pendingRuntimeRequest;
    const asked = thread.hasPendingUserInput && (!thread.pendingUserInputAt || isNew(thread.pendingUserInputAt));
    const failed = ["error", "failed"].includes(thread.runtime?.status) &&
      isNew(thread.latestRun?.status === "failed" ? thread.latestRun.completedAt : thread.runtime.updatedAt);
    return !(
      thread.hasPendingApprovals || (request && request.kind !== "user_input") || asked || failed ||
      thread.pendingSubagentRequest != null || thread.pendingGuestMessageCount > 0
    );
  }

  const isOwn = (thread) =>
    thread.archivedAt == null && thread.lineage?.relationshipToParent !== "subagent" && thread.lineage?.sideChat !== true;

  const activityOf = (thread) =>
    Math.max(timeOf(thread.latestUserMessageAt), timeOf(thread.latestRun?.requestedAt), timeOf(thread.latestRun?.completedAt)) || timeOf(thread.createdAt);

  // One entry per repository: T3 Code can hold a repository as several
  // projects, such as one on each computer.
  function entriesOf(projects, threads, environments, now) {
    const connected = new Set(environments.filter((item) => item.connection?.phase === "connected").map((item) => item.environmentId));
    const byProject = new Map();
    const byKey = new Map();
    for (const project of projects) {
      const repository = repositoryOf(project);
      const id = `${project.environmentId}:${project.id}`;
      const key = repository || id;
      const entry = byKey.get(key) || { key, repository, copies: [], threads: [] };
      const copy = { project, connected: connected.has(project.environmentId), latest: 0 };
      entry.copies.push(copy);
      byKey.set(key, entry);
      byProject.set(id, { entry, copy });
    }
    for (const thread of threads) {
      const found = byProject.get(`${thread.environmentId}:${thread.projectId}`);
      if (!found || !isOwn(thread)) continue;
      const at = activityOf(thread);
      found.copy.latest = Math.max(found.copy.latest, at);
      if (thread.settledOverride === "settled" || isSnoozed(thread, now)) continue;
      const state = stateOf(thread, connected);
      found.entry.threads.push({ thread, at, state, old: state === "idle" && thread.pinnedAt == null && now - at > OLD_MS });
    }
    const entries = [...byKey.values()].map(({ copies, ...entry }) => {
      const latest = Math.max(...copies.map((copy) => copy.latest));
      const pinned = copies.some((copy) => copy.project.pinnedAt != null);
      // A new thread starts here, so a connected computer comes first.
      const [{ project }] = copies.sort((a, b) => b.connected - a.connected || b.latest - a.latest);
      const first = (item) => (item.state === "ask" ? 2 : item.state === "run" ? 1 : 0);
      entry.threads.sort((a, b) => a.old - b.old || first(b) - first(a) || b.at - a.at);
      return { ...entry, project, latest, pinned };
    });
    return entries.sort((a, b) => b.pinned - a.pinned || has(b, "run") - has(a, "run") || b.latest - a.latest);
  }

  const has = (entry, state) => entry.threads.some((item) => item.state === state);
  const isRead = (facts) => facts?.status === "read";
  const pullsOf = (facts) => (isRead(facts) ? facts.pulls : []);
  const pullUrl = (entry, number) => `https://github.com/${entry.repository}/pull/${number}`;
  const pullWord = (pull) => (pull.stage === "ready" ? `ready to merge${pull.note ? `, ${pull.note}` : ""}` : pull.note);

  function pullRow(entry, pull) {
    return {
      key: `pull${pull.number}`, tone: pull.tone, text: pull.title, at: pull.at, link: pullUrl(entry, pull.number),
      notes: [{ key: "stage", text: `#${pull.number} ${pullWord(pull)}`, tone: pull.tone }],
    };
  }

  const STATES = {
    ask: { text: "Waiting for you", tone: "warn" },
    run: { text: "Working", tone: "run" },
    fail: { text: "Error", tone: "bad" },
    done: { text: "Finished", tone: "ok" },
    idle: { text: "Open" },
  };

  function threadRow(entry, { thread, at, state, old }, facts) {
    const pulls = pullsOf(facts);
    // T3 Code can keep a link open long after its pull request was closed.
    const isOpen = ({ number, linkedAt }) =>
      !isRead(facts) || facts.cut || pulls.some((pull) => pull.number === number) || timeOf(linkedAt) > facts.readAt;
    const linked = (thread.pullRequests || []).filter((link) =>
      link.host === "github.com" && link.repository?.toLowerCase() === entry.repository && link.snapshot?.state === "open" && isOpen(link));
    return {
      key: `${thread.environmentId}:${thread.id}`, state, text: thread.title, at, thread,
      linked: linked.map((link) => link.number),
      notes: linked.map(({ number }) => {
        const pull = pulls.find((other) => other.number === number);
        return { key: number, text: `#${number} ${pull ? pullWord(pull) : "open"}`, tone: pull?.tone, pull: pullUrl(entry, number) };
      }),
      old,
    };
  }
  const workingSince = (thread) =>
    timeOf(thread.runtime?.activityStartedAt || thread.latestRun?.startedAt || thread.latestRun?.requestedAt) || activityOf(thread);

  function rowsOf(entry, facts) {
    const threads = entry.threads.map((item) => threadRow(entry, item, facts));
    const linked = new Set(threads.filter((row) => !row.old).flatMap((row) => row.linked));
    const others = pullsOf(facts).filter((pull) => !linked.has(pull.number));
    const rowsFor = (update) => others.filter((pull) => pull.update === update).map((pull) => pullRow(entry, pull));
    return {
      rows: [...threads.filter((row) => !row.old), ...rowsFor(false), ...threads.filter((row) => row.old)],
      updates: rowsFor(true),
    };
  }

  const isKnown = (entry, facts) => !entry.repository || (isRead(facts) && !facts.cut);

  function unreadReason(entry, facts) {
    if (!entry.repository) return null;
    if (!facts || facts.status === "waiting") return "Reading GitHub…";
    if (facts.status === "unavailable") return "GitHub is not available";
    return facts.cut || facts.failedField || facts.release?.ahead === null ? "Read in part" : null;
  }

  function Glyph({ children, size = 16 }) {
    return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, children);
  }
  const path = (d) => h("path", { key: d, d });
  const dot = (cx, cy, r) => h("circle", { key: `${cx} ${cy}`, cx, cy, r });
  const GLYPHS = {
    plus: path("M12 5v14M5 12h14"),
    back: path("m15 18-6-6 6-6"),
    out: path("M14 5h5v5M19 5l-8 8M11 7H6a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-5"),
    pin: path("M12 17v5M8 3h8l-1 7 3 3.5V16H6v-2.5L9 10z"),
    issue: [dot(12, 12, 8.5), dot(12, 12, 1)],
    pull: [dot(6, 6, 2.6), dot(6, 18, 2.6), dot(18, 18, 2.6), path("M6 8.6v6.8M18 15.4V10a3 3 0 0 0-3-3h-3.5M14 4l-3 3 3 3")],
    shield: path("M12 3l7.5 2.8v5.4c0 4.6-3.1 8-7.5 9.8-4.4-1.8-7.5-5.2-7.5-9.8V5.8z"),
  };

  function Picture({ project, className }) {
    const { Icon } = mainParts();
    if (Icon) return h(Icon, { project, className });
    return h("span", { className: `${className} t3h-letters`, "aria-hidden": true }, project.title.slice(0, 2).toUpperCase());
  }

  const text = (value, className) => h("span", { className, dir: directionOf(value) }, value);
  const small = (value, className = "") => h("span", { className: `t3h-small ${className}`, dir: "ltr" }, value);
  const toneOf = (tone) => (tone ? `t3h-${tone}` : "");
  const outward = { target: "_blank", rel: "noreferrer" };

  function Row({ row, now, actions }) {
    const title = { className: "t3h-text", dir: directionOf(row.text) };
    const openPull = (url) => ({ ...outward, href: url, onClick: (event) => actions.openPull?.(event, url) });
    return h("li", { className: `t3h-row${row.old && row.state === "idle" ? " t3h-old" : ""}` },
      row.thread
        ? h("span", { className: "t3h-mark", role: "img", title: STATES[row.state].text, "aria-label": STATES[row.state].text }, h("i", { className: `t3h-state t3h-is-${row.state}` }))
        : h("span", { className: `t3h-mark ${toneOf(row.tone)}` }, h(Glyph, { size: 14 }, GLYPHS.pull)),
      row.thread
        ? h("button", { ...title, type: "button", onClick: () => actions.openThread(row.thread) }, row.text)
        : h("a", { ...title, ...openPull(row.link) }, row.text),
      row.at ? small(ago(now - row.at), "t3h-age") : null,
      row.notes.length
        ? h("div", { className: "t3h-row-notes" }, row.notes.map((note) =>
          note.pull
            ? h("a", { key: note.key, className: `t3h-small ${toneOf(note.tone)}`, dir: "ltr", ...openPull(note.pull) }, note.text)
            : h("span", { key: note.key, className: `t3h-small ${toneOf(note.tone)}`, dir: "ltr" }, note.text)))
        : null);
  }

  const rowList = (rows, now, actions) => (rows.length ? h("ul", { className: "t3h-rows" }, rows.map((row) => h(Row, { key: row.key, row, now, actions }))) : null);

  const share = (all, number, word) => (number === 0 ? "" : number === all ? ` ${word}` : `, ${number} ${word}`);

  // A count that GitHub does not give is left out, so 0 always means 0.
  function countsOf(entry, facts) {
    if (!isRead(facts)) return [];
    const updates = facts.pulls.filter((pull) => pull.update).length;
    const alerts = facts.alerts;
    const graded = !alerts ? "" : alerts.critical ? share(alerts.total, alerts.critical, "critical") : share(alerts.total, alerts.high, "high");
    const url = `https://github.com/${entry.repository}`;
    return [
      facts.issues === null ? null : { key: "issue", number: facts.issues, name: count(facts.issues, "issue"), href: `${url}/issues` },
      facts.openPulls === null ? null : {
        key: "pull", number: facts.openPulls, name: count(facts.openPulls, "pull request"), href: `${url}/pulls`,
        extra: facts.cut ? "" : share(facts.openPulls, updates, updates === 1 ? "update" : "updates"),
      },
      !alerts ? null : {
        key: "shield", number: alerts.total, name: `${count(alerts.total, "security alert")} in ${alerts.sources.join(", ")}`, href: `${url}/security`,
        extra: graded, tone: alerts.critical || alerts.high ? "bad" : alerts.total ? "warn" : "",
      },
    ].filter(Boolean);
  }

  const nameOf = ({ name, number, extra }) => (extra ? `${name}: ${number}${extra}` : name);

  function Counts({ entry, facts, now, actions }) {
    const counts = countsOf(entry, facts);
    const reason = unreadReason(entry, facts);
    if (counts.length === 0 && !reason && !releaseOf(facts)) return null;
    return h("div", { className: "t3h-counts" },
      counts.map((item) => {
        const detail = item.number > 0 ? facts.details?.[item.key] : null;
        return h("a", {
          key: item.key, ...outward, href: item.href, "aria-label": nameOf(item),
          ...(detail ? actions.tips.anchor(entry.repository, item.key) : { title: item.name }),
          className: `t3h-count ${toneOf(item.tone)}${item.number ? "" : " t3h-zero"}`,
        }, h(Glyph, { size: 14 }, GLYPHS[item.key]), h("span", { dir: "ltr" }, item.number, item.extra));
      }),
      reason ? small(reason) : null,
      releaseOf(facts) ? h("span", { className: "t3h-release" }, h(ReleaseTag, { entry, facts, now })) : null);
  }

  const releaseOf = (facts) => (isRead(facts) && facts.release?.tag ? facts.release : null);

  function ReleaseTag({ entry, facts, now, linked = true }) {
    const release = releaseOf(facts);
    if (!release) return null;
    const url = `https://github.com/${entry.repository}`;
    const ahead = release.ahead > 0 ? release.ahead : 0;
    const since = ahead ? `, ${count(ahead, "commit")} since` : release.at ? `, released ${ago(now - release.at)} ago` : "";
    const label = `Version ${release.tag}${since}`;
    const content = [
      h("span", { key: "tag", className: "t3h-cut" }, release.tag),
      ahead ? h("span", { key: "ahead", className: "t3h-tag-ahead" }, `+${ahead}`) : null,
    ];
    const shared = { className: "t3h-tag", dir: "ltr", title: label, "aria-label": label };
    if (!linked) return h("span", shared, ...content);
    const href = ahead ? `${url}/compare/${encodeURIComponent(release.tag)}...HEAD` : release.tagOnly ? `${url}/releases/tag/${encodeURIComponent(release.tag)}` : `${url}/releases`;
    return h("a", { ...shared, ...outward, href }, ...content);
  }

  function Foot({ entry, facts, now, actions }) {
    const url = `https://github.com/${entry.repository}`;
    return h(React.Fragment, null,
      isRead(facts) && facts.mainFails ? h("div", { className: "t3h-foot" }, h("a", { ...outward, href: `${url}/commits`, className: "t3h-small t3h-bad", dir: "ltr" }, "The default branch fails its checks")) : null,
      h(Counts, { entry, facts, now, actions }));
  }

  const LIST_LINE_MIN = 5;

  function Badge({ badge }) {
    const color = /^[0-9a-f]{6}$/i.test(badge.color || "") ? badge.color : null;
    return h("span", {
      className: "t3h-tip-badge", dir: "auto", "data-tone": badge.tone || undefined,
      "data-label": color ? "" : undefined, style: color ? { "--t3h-label": `#${color}` } : undefined,
    }, badge.text);
  }

  function TipItem({ item, now, linkTo }) {
    const meta = [...(item.meta || []), item.time ? `${ago(now - item.time)} ago` : ""].filter(Boolean).join(" · ");
    const badges = item.badges || [];
    return h(item.link ? "a" : "div", {
      className: "t3h-tip-item", ...(item.link ? linkTo(item.link) : {}),
      "data-lead": item.lead ? "" : undefined, "data-inline": !item.lead && !meta && badges.length ? "" : undefined,
    },
    item.lead ? h("span", { className: "t3h-tip-lead" }, item.lead) : null,
    h("span", { className: "t3h-tip-text", dir: "auto" }, item.text),
    meta || badges.length
      ? h("div", { className: "t3h-tip-sub" },
        meta ? h("span", { className: "t3h-tip-meta", dir: "auto" }, meta) : null,
        badges.map((badge, index) => h(Badge, { key: index, badge })))
      : null);
  }

  function TipSection({ section, now, linkTo }) {
    const items = section.items || [];
    const lined = section.more > 0 || (section.link && (section.partial || items.length > LIST_LINE_MIN));
    const line = section.more > 0 ? `and ${section.more} more` : section.partial ? "View all on GitHub" : `View all ${items.length} on GitHub`;
    return h("div", { className: "t3h-tip-section" },
      section.title ? h("div", { className: "t3h-tip-section-title" }, section.title) : null,
      section.chips?.length ? h("div", { className: "t3h-tip-chips" }, section.chips.map((chip, index) => h(Badge, { key: index, badge: chip }))) : null,
      items.map((item, index) => h(TipItem, { key: item.link || index, item, now, linkTo })),
      lined ? h(section.link ? "a" : "div", { className: "t3h-tip-more", ...(section.link ? linkTo(section.link) : {}) }, line) : null);
  }

  const TIP_DELAY_MS = 250;
  const TIP_SWITCH_DELAY_MS = 120;
  const TIP_HIDE_DELAY_MS = 200;

  function useTips() {
    const [tip, setTip] = React.useState(null);
    const state = React.useRef({ show: 0, hide: 0, hiddenAt: 0, tip: null });
    const box = React.useRef(null);
    const held = state.current;
    held.tip = tip;
    const clear = () => {
      clearTimeout(held.show);
      clearTimeout(held.hide);
    };
    const show = (anchor, repository, kind) => {
      clear();
      setTip({ anchor, repository, kind });
    };
    const hide = () => {
      clear();
      if (held.tip) held.hiddenAt = Date.now();
      held.tip = null;
      setTip(null);
    };
    const focusInside = () => Boolean(box.current?.contains(document.activeElement));
    const scheduleHide = () => {
      clear();
      if (held.tip) held.hide = setTimeout(() => focusInside() || held.tip?.anchor.matches(":focus-visible") || hide(), TIP_HIDE_DELAY_MS);
    };
    const links = () => [...(box.current?.querySelectorAll("a") || [])];
    const focusLink = (index) => {
      const all = links();
      if (all.length) all[((index % all.length) + all.length) % all.length].focus();
    };
    const returnFocus = () => {
      const anchor = held.tip?.anchor;
      hide();
      held.returning = true;
      try {
        anchor?.focus();
      } finally {
        held.returning = false;
      }
    };
    const anchor = (repository, kind) => ({
      "aria-haspopup": "dialog",
      "aria-expanded": tip?.repository === repository && tip?.kind === kind,
      onPointerEnter: (event) => {
        const target = event.currentTarget;
        clear();
        if (held.tip?.anchor === target || focusInside()) return;
        const delay = held.tip ? TIP_SWITCH_DELAY_MS : Date.now() - held.hiddenAt < 300 ? 0 : TIP_DELAY_MS;
        held.show = setTimeout(() => show(target, repository, kind), delay);
      },
      onPointerLeave: scheduleHide,
      onFocus: (event) => {
        if (!held.returning && event.currentTarget.matches(":focus-visible")) show(event.currentTarget, repository, kind);
      },
      onBlur: (event) => {
        if (!box.current?.contains(event.relatedTarget) && held.tip?.anchor === event.currentTarget) hide();
      },
      onClick: hide,
      onKeyDown: (event) => {
        if (event.key !== "ArrowDown") return;
        event.preventDefault();
        if (held.tip?.anchor === event.currentTarget) {
          focusLink(0);
        } else {
          held.enter = true;
          show(event.currentTarget, repository, kind);
        }
      },
    });
    const keys = (event) => {
      const all = links();
      const index = all.indexOf(document.activeElement);
      if (index !== -1 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        focusLink(index + (event.key === "ArrowDown" ? 1 : -1));
      } else if (index !== -1 && (event.key === "Home" || event.key === "End")) {
        event.preventDefault();
        focusLink(event.key === "Home" ? 0 : -1);
      } else if (event.key === "Tab") {
        returnFocus();
      }
    };
    const close = () => (focusInside() ? returnFocus() : hide());
    const escape = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    return { tip, box, anchor, clear, hide, close, scheduleHide, keys, escape, focusLink, held };
  }

  function placeTip(node, anchor) {
    const gap = 6;
    const margin = 8;
    const room = anchor.getBoundingClientRect();
    const below = innerHeight - room.bottom - gap - margin;
    const above = room.top - gap - margin;
    const down = node.scrollHeight <= below || below >= above;
    node.style.maxHeight = `${Math.max(0, down ? below : above)}px`;
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    const start = getComputedStyle(anchor).direction === "rtl" ? room.right - width : room.left;
    const left = Math.min(Math.max(start, margin), Math.max(margin, innerWidth - width - margin));
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(down ? room.bottom + gap : room.top - gap - height)}px`;
  }

  function Tip({ tips, detail, now, actions }) {
    const { tip, box } = tips;
    const open = Boolean(tip && detail);
    React.useLayoutEffect(() => {
      const node = box.current;
      if (!node) return;
      const isOpen = () => {
        try {
          return node.matches(":popover-open");
        } catch {
          return false;
        }
      };
      if (!open || !tip.anchor.isConnected) {
        node.removeAttribute("data-shown");
        if (isOpen()) node.hidePopover();
        if (tip) tips.hide();
        return;
      }
      if (typeof node.showPopover === "function" && !isOpen()) {
        node.setAttribute("popover", "manual");
        try {
          node.showPopover();
        } catch {
          node.removeAttribute("popover");
        }
      }
      placeTip(node, tip.anchor);
      if (tips.held.enter) {
        tips.held.enter = false;
        tips.focusLink(0);
      }
      const frame = requestAnimationFrame(() => node.setAttribute("data-shown", ""));
      return () => cancelAnimationFrame(frame);
    }, [open, tip, detail]);
    React.useEffect(() => {
      if (!open) return;
      const scrolled = (event) => {
        if (!box.current?.contains(event.target)) tips.close();
      };
      addEventListener("scroll", scrolled, true);
      addEventListener("resize", tips.close);
      addEventListener("keydown", tips.escape, true);
      return () => {
        removeEventListener("scroll", scrolled, true);
        removeEventListener("resize", tips.close);
        removeEventListener("keydown", tips.escape, true);
      };
    }, [open]);
    const url = (link) => `https://github.com/${tip.repository}/${link}`;
    const linkTo = (link) => ({
      ...outward, href: url(link), tabIndex: -1,
      onClick: (event) => {
        const issue = /^issues\/(\d+)$/.exec(link);
        if (/^pull\/\d+$/.test(link)) actions.openPull?.(event, url(link));
        else if (issue) actions.openIssue(event, tip.repository, issue[1]);
        tips.hide();
      },
    });
    return h("div", {
      ref: box, className: "t3h-tip", role: "dialog", dir: "ltr",
      "aria-label": open ? detail.title : undefined, "data-open": open ? "" : undefined,
      onPointerEnter: tips.clear, onPointerLeave: tips.scheduleHide, onKeyDown: tips.keys,
      onMouseDown: (event) => event.target.closest?.("a") || event.preventDefault(),
      onBlur: (event) => {
        if (!box.current?.contains(event.relatedTarget) && event.relatedTarget !== tip?.anchor) tips.hide();
      },
    }, open
      ? [
        h("div", { key: "head", className: "t3h-tip-head" }, h("span", { className: "t3h-tip-title" }, detail.title), h("span", { className: "t3h-tip-summary" }, detail.summary)),
        ...(detail.sections || []).map((section, index) => h(TipSection, { key: index, section, now, linkTo })),
        detail.note ? h("div", { key: "note", className: "t3h-tip-note" }, detail.note) : null,
      ]
      : null);
  }

  function Headline({ entry, now }) {
    const state = ["ask", "run", "done", "fail"].find((item) => has(entry, item));
    if (!state) return small(entry.latest ? `${ago(now - entry.latest)} ago` : "\u00a0");
    const { thread } = entry.threads.find((item) => item.state === state);
    const { text: word, tone } = STATES[state];
    return small(state === "run" ? `${word}, ${ago(now - workingSince(thread))}` : word, `t3h-${tone}`);
  }

  const shownRows = (rows, opened) => (opened ? rows : rows.slice(0, ROWS));

  function Card({ entry, facts, rows, now, actions, opened, toggle }) {
    const lit = ["ask", "run"].find((state) => has(entry, state));
    const shown = shownRows(rows, opened);
    const more = rows.length - shownRows(rows, false).length;
    const { title } = entry.project;
    return h("article", { className: `t3h-card${lit ? ` t3h-card-${lit}` : ""}` },
      h("div", { className: "t3h-head" },
        h(Picture, { project: entry.project, className: "t3h-icon" }),
        h("div", { className: "t3h-names" },
          h("h3", null,
            entry.pinned ? h("span", { className: "t3h-pin", title: "Pinned", role: "img", "aria-label": "Pinned" }, h(Glyph, { size: 15 }, GLYPHS.pin)) : null,
            h("button", { type: "button", className: "t3h-name t3h-cut", dir: directionOf(title), onClick: () => actions.openProject(entry) }, title)),
          h(Headline, { entry, now })),
        h("button", { type: "button", className: "t3h-add", title: "New thread", "aria-label": `New thread in ${title}`, onClick: () => actions.startThread(entry) }, h(Glyph, { size: 17 }, GLYPHS.plus))),
      rowList(shown, now, actions),
      more ? h("button", { type: "button", className: "t3h-more t3h-small", "aria-expanded": opened, "aria-label": opened ? `Show less of ${title}` : `${more} more in ${title}`, onClick: () => toggle(entry.key) }, text(opened ? "Show less" : `${more} more`)) : null,
      h(Foot, { entry, facts, now, actions }));
  }

  function heightOf({ entry, rows }) {
    const shown = shownRows(rows, false);
    const notes = shown.filter((row) => row.notes.length > 0).length;
    return 4.4 + shown.length * 1.75 + notes * 0.8 + (shown.length < rows.length ? 1.2 : 0) + (entry.repository ? 2.6 : 0);
  }

  // Agents start and stop all the time, and cards that follow them never rest,
  // so a placed card stays. CSS columns would balance them again.
  function place(before, cards) {
    const byKey = new Map(cards.map((card) => [card.entry.key, card]));
    const columns = before.map((keys) => keys.filter((key) => byKey.has(key)));
    const heights = columns.map((keys) => keys.reduce((sum, key) => sum + heightOf(byKey.get(key)), 0));
    const placed = new Set(columns.flat());
    for (const [key, card] of byKey) {
      if (placed.has(key)) continue;
      const shortest = heights.indexOf(Math.min(...heights));
      columns[shortest].push(key);
      heights[shortest] += heightOf(card);
    }
    return columns;
  }

  function Wall({ cards, complete, now, actions }) {
    const [columns, setColumns] = React.useState(1);
    const [opened, setOpened] = React.useState(() => new Set());
    const wall = React.useRef(null);
    React.useLayoutEffect(() => {
      const measure = () => {
        const column = COLUMN_REM * parseFloat(getComputedStyle(document.documentElement).fontSize);
        setColumns(Math.max(1, Math.floor(wall.current.clientWidth / column)));
      };
      const observer = new ResizeObserver(measure);
      observer.observe(wall.current);
      measure();
      return () => observer.disconnect();
    }, []);
    const toggle = (key) => setOpened((before) => {
      const after = new Set(before);
      if (!after.delete(key)) after.add(key);
      return after;
    });
    const places = React.useRef([]);
    const before = places.current.length === columns ? places.current : Array.from({ length: columns }, () => []);
    const placed = place(before, cards);
    if (complete) places.current = placed;
    const cardOf = (key) => cards.find((card) => card.entry.key === key);
    return h("div", { className: "t3h-wall", ref: wall }, placed.map((keys, index) =>
      h("div", { key: index, className: "t3h-column" }, keys.map((key) =>
        h(Card, { key, ...cardOf(key), now, actions, opened: opened.has(key), toggle })))));
  }

  function Tile({ entry, facts, now, actions }) {
    const reason = unreadReason(entry, facts);
    const details = [
      ...countsOf(entry, facts).filter((item) => item.number > 0).map((item) =>
        h("span", { key: item.key, title: item.name, className: `t3h-count ${toneOf(item.tone)}` },
          h(Glyph, { size: 14 }, GLYPHS[item.key]), h("span", { dir: "ltr", "aria-label": nameOf(item), role: "img" }, item.number, item.extra))),
      reason ? small(reason) : null,
      releaseOf(facts) ? h("span", { key: "release", className: "t3h-release" }, h(ReleaseTag, { entry, facts, now, linked: false })) : null,
    ];
    return h("button", { type: "button", className: "t3h-tile", onClick: () => actions.openProject(entry) },
      h(Picture, { project: entry.project, className: "t3h-icon-small" }),
      h("span", { className: "t3h-tile-text" },
        text(entry.project.title, "t3h-cut t3h-tile-name"),
        h("span", { className: "t3h-tile-details" }, ...details)));
  }

  function Tiles({ title, cards, now, actions }) {
    if (cards.length === 0) return null;
    return h("section", null,
      h(SectionTitle, { title, cards }),
      h("div", { className: "t3h-tiles" }, cards.map(({ entry, facts }) => h(Tile, { key: entry.key, entry, facts, now, actions }))));
  }

  function SectionTitle({ title, cards }) {
    return h("h2", { className: "t3h-section" }, text(title), h("small", { dir: "ltr" }, count(cards.length, "project")));
  }

  // Threads keep their order while Home is open, and new ones come first.
  function useSteadyThreads(entries, complete) {
    const seen = React.useRef(new Map());
    if (!complete) return;
    for (const { threads } of entries) {
      for (const item of [...threads].reverse()) {
        const key = `${item.thread.environmentId}:${item.thread.id}`;
        if (!seen.current.has(key)) seen.current.set(key, { rank: -seen.current.size, old: item.old });
        Object.assign(item, seen.current.get(key));
      }
      threads.sort((a, b) => a.rank - b.rank);
    }
  }

  function Overview({ entries, factsOf, complete, now, actions }) {
    useSteadyThreads(entries, complete);
    const cards = entries.map((entry) => ({ entry, facts: factsOf(entry), rows: rowsOf(entry, factsOf(entry)).rows }));
    const open = cards.filter(({ entry, rows }) => rows.length > 0 || entry.pinned);
    const rest = cards.filter((card) => !open.includes(card));
    const known = rest.filter(({ entry, facts }) => isKnown(entry, facts));
    return h("div", null,
      open.length ? h("section", null, h(SectionTitle, { title: "In the middle", cards: open }), h(Wall, { cards: open, complete, now, actions })) : null,
      h(Tiles, { title: "No open work", cards: known, now, actions }),
      h(Tiles, { title: "GitHub is not read", cards: rest.filter((card) => !known.includes(card)), now, actions }));
  }

  function Project({ entry, facts, now, actions }) {
    const heading = React.useRef(null);
    React.useEffect(() => heading.current?.focus(), [entry.key]);
    const { rows, updates } = rowsOf(entry, facts);
    return h("div", { className: "t3h-project" },
      h("button", { type: "button", className: "t3h-back", onClick: actions.openMap, dir: "ltr" }, h(Glyph, { size: 15 }, GLYPHS.back), "Home"),
      h("div", { className: "t3h-title" },
        h(Picture, { project: entry.project, className: "t3h-icon-large" }),
        h("h1", { ref: heading, tabIndex: -1, dir: directionOf(entry.project.title) }, entry.project.title)),
      h("div", { className: "t3h-actions" },
        h("button", { type: "button", className: "t3h-button t3h-primary", onClick: () => actions.startThread(entry), dir: "ltr" }, h(Glyph, null, GLYPHS.plus), "New thread"),
        entry.repository ? h("a", { ...outward, className: "t3h-button", href: `https://github.com/${entry.repository}`, dir: "ltr" }, h(Glyph, { size: 15 }, GLYPHS.out), "GitHub") : null),
      rowList(rows, now, actions),
      rows.length === 0 && isKnown(entry, facts) ? h("p", { className: "t3h-none", dir: "ltr" }, "Nothing is in the middle.") : null,
      updates.length ? h("h2", { className: "t3h-section", dir: "ltr" }, "Dependency updates") : null,
      rowList(updates, now, actions),
      h(Foot, { entry, facts, now, actions }));
  }

  // Facts come from the launcher, through the fix's own script in this page,
  // also while Home is closed.
  let github = null;
  let heard = false;
  const subscribers = new Set();
  document.addEventListener("t3-rtl-home:facts", (event) => {
    const next = JSON.parse(event.detail);
    const some = (status) => Object.values(next.repositories).some((facts) => facts.status === status);
    const cached = !heard && some("read");
    heard = true;
    // Without a cache, all the first answers together, so the page changes once
    // and not with every repository.
    if (!github && !cached && some("waiting")) return;
    github = next;
    for (const changed of subscribers) changed();
  });
  function subscribeToGithub(changed) {
    subscribers.add(changed);
    return () => subscribers.delete(changed);
  }

  function useGithub(repositories) {
    const current = React.useSyncExternalStore(subscribeToGithub, () => github);
    const asked = JSON.stringify(repositories);
    React.useEffect(() => {
      const ask = () => {
        if (document.visibilityState === "visible" && asked !== "[]") document.dispatchEvent(new CustomEvent("t3-rtl-home:ask", { detail: asked }));
      };
      // The fix's script can start after this page.
      document.addEventListener("t3-rtl-home:ready", ask);
      document.addEventListener("visibilitychange", ask);
      ask();
      return () => {
        document.removeEventListener("t3-rtl-home:ready", ask);
        document.removeEventListener("visibilitychange", ask);
      };
    }, [asked]);
    return repositories.length > 0 ? current : null;
  }

  function useNow() {
    const [now, setNow] = React.useState(Date.now);
    React.useEffect(() => {
      const timer = setInterval(() => setNow(Date.now()), 30 * 1000);
      return () => clearInterval(timer);
    }, []);
    return now;
  }

  // The chosen project is in the address, so the logo and Back leave it.
  function useChosen(router) {
    const subscribe = React.useCallback((changed) => {
      const subscription = router.stores.location.subscribe(changed);
      return () => subscription.unsubscribe();
    }, [router]);
    return React.useSyncExternalStore(subscribe, () => {
      const chosen = router.state.location.search?.project;
      return typeof chosen === "string" ? chosen : null;
    });
  }

  function Page({ projects, complete }) {
    const { useOpenPull } = mainParts();
    const threads = useThreads();
    const { environments } = useEnvironments();
    const router = useRouter();
    const newThread = useNewThread();
    const openPull = useOpenPull();
    const now = useNow();
    const chosen = useChosen(router);
    const [failed, setFailed] = React.useState(false);
    const tips = useTips();
    const entries = entriesOf(projects, threads, environments, now);
    const github = useGithub(entries.map((entry) => entry.repository).filter(Boolean).sort());
    const factsOf = (entry) => (entry.repository && github ? github.repositories[entry.repository] ?? null : null);
    const actions = {
      openPull,
      tips,
      openMap: () => router.navigate({ to: "/" }),
      openIssue: (event, repository, key) => {
        const project = entries.find((item) => item.repository === repository)?.project;
        const environment = project && environments.find((item) => item.environmentId === project.environmentId);
        if (environment?.serverConfig?.environment?.capabilities?.issues !== true) return;
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        router.navigate({
          to: "/issues",
          search: { selectedEnvironmentId: project.environmentId, selectedProjectId: project.id, selectedHost: "github.com", tracker: "github", scope: repository, key },
        });
      },
      openProject: (entry) => router.navigate({ to: "/", search: { project: entry.key } }),
      openThread: (thread) => router.navigate({ to: "/$environmentId/$threadId", params: { environmentId: thread.environmentId, threadId: thread.id } }),
      startThread: (entry) => {
        setFailed(false);
        newThread(projectReference(entry.project.environmentId, entry.project.id)).then(
          (started) => setFailed(started === null),
          () => setFailed(true),
        );
      },
    };
    const entry = entries.find((item) => item.key === chosen);
    const stale = github ? Object.values(github.repositories).filter((facts) => facts.stale).map((facts) => facts.readAt) : [];
    const notes = [
      failed && "Could not start a new thread. Try again.",
      github?.problem === "gh-missing" && "The GitHub CLI (gh) was not found. Install it and sign in to see pull requests and releases.",
      github?.problem === "github-failed" && "GitHub could not be read. Check that gh is signed in.",
      stale.length > 0 && `Some GitHub data is from ${ago(now - Math.min(...stale))} ago.`,
    ].filter(Boolean);
    return h(Frame, { ...focusProps("home", 1, "Home"), role: "main", className: frameClass },
      h("style", null, css),
      h(Header, { electron }, text(entry ? entry.project.title : "Home", "t3h-header")),
      h("div", { className: "t3h", key: entry ? entry.key : "map" },
        h("div", { className: "t3h-page" },
          notes.length ? h("div", { className: "t3h-notes", role: "status" }, notes.map((note) => h("p", { key: note, dir: "ltr" }, note))) : null,
          entry ? h(Project, { entry, facts: factsOf(entry), now, actions }) : h(Overview, { entries, factsOf, complete, now, actions }))),
      h(Tip, { tips, detail: tips.tip && github ? github.repositories[tips.tip.repository]?.details?.[tips.tip.kind] ?? null : null, now, actions }));
  }

  class Boundary extends React.Component {
    constructor(props) {
      super(props);
      this.state = { failed: false };
    }
    static getDerivedStateFromError() {
      return { failed: true };
    }
    componentDidCatch(error) {
      console.error("t3code-rtl-fix: the Home page failed", error);
    }
    render() {
      return this.state.failed ? h(this.props.native) : this.props.children;
    }
  }

  // T3 Code's component starts a draft as soon as there is a project, so it
  // shows only when no project can still arrive.
  return function Home({ native }) {
    const projects = useProjects().filter((project) => project.archivedAt == null);
    const bootstrapped = useBootstrapped();
    if (projects.length > 0) return h(Boundary, { native }, h(Page, { projects, complete: bootstrapped }));
    return bootstrapped ? h(native) : null;
  };
}

const HOME_CSS = `
.t3h { flex: 1; min-height: 0; overflow: auto; container-type: inline-size; color: var(--foreground); font-size: .875rem; line-height: 1.45; direction: ltr; }
:root[data-t3-rtl-app="on"] .t3h { direction: rtl; }
.t3h [dir] { text-align: -webkit-match-parent; text-align: match-parent; }
.t3h button, .t3h a { font: inherit; color: inherit; text-decoration: none; background: none; border: 0; padding: 0; cursor: pointer; }
.t3h button { text-align: start; }
.t3h :is(button, a, h1):focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; border-radius: .4rem; }
.t3h :is(h1, h2, h3, p, ul) { margin: 0; padding: 0; font: inherit; list-style: none; }
.t3h h1:focus { outline: 0; }
.t3h svg { display: block; flex: none; }
.t3h-header { font-size: .875rem; font-weight: 500; color: var(--foreground); }
.t3h-page { padding: .6rem 2.75rem 4rem; }
.t3h .t3h-small { font-size: .8rem; color: var(--t3h-k, var(--muted-foreground)); }
.t3h a.t3h-small:hover { text-decoration: underline; text-underline-offset: 3px; }
.t3h-ok { --t3h-k: var(--success); } .t3h-bad { --t3h-k: var(--destructive); } .t3h-warn { --t3h-k: var(--warning); } .t3h-run { --t3h-k: var(--foreground); }
.t3h-notes { margin-bottom: 1rem; padding: .7rem .9rem; border-radius: .7rem; border: 1px solid var(--border); color: var(--muted-foreground); }
.t3h-cut { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t3h-none { padding: 1rem 0; font-size: 1.15rem; color: var(--muted-foreground); }
.t3h .t3h-section { display: flex; align-items: baseline; gap: .55rem; margin: 2rem 0 .9rem; font-size: 1.35rem; font-weight: 700; letter-spacing: -.015em; }
.t3h section:first-child > .t3h-section { margin-top: .4rem; }
.t3h-section small { font-size: .85rem; font-weight: 500; letter-spacing: 0; color: var(--muted-foreground); }

.t3h-wall { display: flex; gap: .9rem; align-items: flex-start; }
.t3h-column { flex: 1; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: .9rem; }
.t3h-card { --t3h-edge: color-mix(in srgb, var(--foreground) 9%, transparent); min-width: 0; padding: 1rem 1.05rem .9rem; border-radius: 1rem; background: var(--card); box-shadow: inset 0 0 0 1px var(--t3h-edge); }
.t3h-card-run { --t3h-edge: var(--primary); background: color-mix(in srgb, var(--primary) 9%, var(--card)); }
.t3h-card-ask { --t3h-edge: var(--warning); background: color-mix(in srgb, var(--warning) 9%, var(--card)); }
.t3h-head { display: flex; align-items: center; gap: .7rem; }
.t3h-names { flex: 1; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); row-gap: .1rem; line-height: 1.3; }
.t3h-names > .t3h-small:is(.t3h-run, .t3h-warn, .t3h-ok, .t3h-bad) { font-weight: 600; }
.t3h-names h3 { display: flex; align-items: center; gap: .4rem; }
.t3h .t3h-name { font-size: 1.14rem; font-weight: 680; letter-spacing: -.012em; }
.t3h .t3h-name:hover { text-decoration: underline; text-underline-offset: 4px; }
.t3h-pin { color: var(--muted-foreground); }
.t3h .t3h-tag { display: inline-flex; align-items: center; gap: .3rem; flex: none; min-width: 0; max-width: 9rem; padding: .08rem .5rem; border-radius: 999px; font-size: .72rem; font-weight: 600; line-height: 1.35; letter-spacing: 0; font-variant-numeric: tabular-nums; color: color-mix(in srgb, var(--foreground) 80%, transparent); background: color-mix(in srgb, var(--foreground) 7%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--foreground) 11%, transparent); }
.t3h a.t3h-tag:hover { color: var(--foreground); background: color-mix(in srgb, var(--foreground) 12%, transparent); }
.t3h-tag-ahead { color: var(--muted-foreground); }
.t3h-release { display: flex; min-width: 0; margin-inline-start: auto; }
.t3h-icon { width: 2.1rem; height: 2.1rem; flex: none; }
.t3h-icon-small { width: 1.5rem; height: 1.5rem; flex: none; }
.t3h-icon-large { width: 3rem; height: 3rem; flex: none; }
.t3h-letters { display: inline-grid; place-items: center; border-radius: .4rem; font-size: .65rem; font-weight: 700; background: color-mix(in srgb, var(--primary) 22%, transparent); }
.t3h .t3h-add { display: grid; place-items: center; flex: none; width: 2rem; height: 2rem; border-radius: .55rem; color: var(--muted-foreground); }
.t3h .t3h-add:hover { background: color-mix(in srgb, var(--foreground) 9%, transparent); color: var(--foreground); }

.t3h .t3h-rows { display: grid; grid-template-columns: minmax(0, 1fr); margin-top: .7rem; }
.t3h-row { display: grid; grid-template-columns: 1.05rem minmax(0, 1fr) auto; column-gap: .6rem; align-items: baseline; padding: .34rem 0; }
.t3h-mark { display: grid; place-items: center; align-self: start; height: 1.35em; font-size: .92rem; color: var(--t3h-k, var(--muted-foreground)); }
.t3h .t3h-text { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; font-size: .92rem; line-height: 1.35; }
.t3h .t3h-text:hover { text-decoration: underline; text-underline-offset: 3px; }
.t3h-old .t3h-text { color: var(--muted-foreground); }
.t3h-age { white-space: nowrap; }
.t3h-row-notes { grid-column: 2 / -1; display: flex; flex-wrap: wrap; column-gap: .7rem; line-height: 1.4; }
.t3h-state { position: relative; width: .52rem; height: .52rem; border-radius: 50%; background: var(--t3h-k); }
.t3h-is-idle { background: none; box-shadow: inset 0 0 0 1.6px var(--muted-foreground); }
.t3h-is-run { --t3h-k: var(--primary); } .t3h-is-ask { --t3h-k: var(--warning); } .t3h-is-fail { --t3h-k: var(--destructive); } .t3h-is-done { --t3h-k: var(--success); }
.t3h-is-run::after { content: ""; position: absolute; inset: 0; border-radius: 50%; background: var(--t3h-k); animation: t3h-breathe 2.8s ease-out infinite; }
@keyframes t3h-breathe { from { scale: 1; opacity: .55; } 70%, to { scale: 3.2; opacity: 0; } }
.t3h .t3h-more { margin: .3rem 0 0; margin-inline-start: 1.65rem; }
.t3h .t3h-more:hover { color: var(--foreground); }

.t3h-foot { margin-top: .6rem; line-height: 1.3; }
.t3h-foot + .t3h-foot { margin-top: .2rem; }
.t3h-counts { display: flex; flex-wrap: wrap; gap: .1rem 1rem; margin-top: .75rem; padding-top: .65rem; box-shadow: inset 0 1px 0 color-mix(in srgb, var(--foreground) 8%, transparent); }
.t3h .t3h-count { display: inline-flex; align-items: center; gap: .32rem; font-size: .82rem; font-weight: 550; color: var(--t3h-k, color-mix(in srgb, var(--foreground) 82%, transparent)); }
.t3h a.t3h-count:hover { text-decoration: underline; text-underline-offset: 3px; }
.t3h .t3h-zero { font-weight: 400; color: color-mix(in srgb, var(--muted-foreground) 70%, transparent); }

.t3h-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(19rem, 100%), 1fr)); gap: .1rem .9rem; }
.t3h .t3h-tile { display: flex; align-items: center; gap: .65rem; min-width: 0; padding: .5rem .4rem; border-radius: .6rem; }
.t3h .t3h-tile:hover { background: color-mix(in srgb, var(--foreground) 6%, transparent); }
.t3h-tile-text { flex: 1; display: grid; min-width: 0; }
.t3h-tile-name { font-size: .95rem; font-weight: 600; }
.t3h-tile-details { display: flex; flex-wrap: wrap; align-items: center; gap: 0 .9rem; }

.t3h-project { max-width: 44rem; margin: 0 auto; padding-top: .9rem; }
.t3h .t3h-back { display: inline-flex; align-items: center; gap: .3rem; font-size: .85rem; color: var(--muted-foreground); }
:root[data-t3-rtl-app="on"] .t3h-back { flex-direction: row-reverse; }
:root[data-t3-rtl-app="on"] .t3h-back svg { scale: -1 1; }
.t3h-title { display: flex; align-items: center; gap: 1rem; margin-top: 1.2rem; }
.t3h .t3h-title h1 { font-size: 3rem; line-height: 1.05; font-weight: 680; letter-spacing: -.035em; overflow-wrap: anywhere; }
.t3h-actions { display: flex; flex-wrap: wrap; gap: .6rem; margin: 1.4rem 0 1.6rem; }
.t3h .t3h-button { display: inline-flex; align-items: center; gap: .45rem; height: 2.5rem; padding: 0 1.05rem; border: 1px solid var(--border); border-radius: var(--radius, .625rem); background: var(--card); font-size: .95rem; font-weight: 550; white-space: nowrap; }
.t3h .t3h-button:hover { border-color: color-mix(in srgb, var(--foreground) 35%, var(--border)); }
.t3h .t3h-button.t3h-primary { background: var(--primary); border-color: var(--primary); color: var(--primary-foreground); }
.t3h .t3h-project .t3h-text { -webkit-line-clamp: none; font-size: 1.05rem; line-height: 1.4; }
.t3h-project .t3h-mark { height: 1.4em; font-size: 1.05rem; }

.t3h-tip {
  --t3h-tip-critical: var(--destructive, #dc2626); --t3h-tip-high: #ea580c; --t3h-tip-medium: var(--warning, #d97706);
  --t3h-tip-low: var(--muted-foreground, #71717a); --t3h-tip-muted: var(--muted-foreground, #71717a);
  --t3h-tip-success: var(--success, #16a34a); --t3h-tip-info: var(--info, #2563eb);
  position: fixed; inset: auto; top: 0; left: 0; z-index: 2147483647; box-sizing: border-box;
  width: max-content; min-width: 240px; max-width: min(360px, calc(100vw - 16px)); max-height: calc(100vh - 16px);
  margin: 0; padding: 0; overflow: hidden auto; scrollbar-width: thin;
  border: 1px solid var(--border, rgb(0 0 0 / .12)); border-radius: 10px;
  background: var(--popover, #fff); color: var(--popover-foreground, #18181b);
  box-shadow: 0 12px 32px -10px rgb(0 0 0 / .35), 0 2px 6px -2px rgb(0 0 0 / .15);
  direction: ltr; font-size: 12px; line-height: 1.4; text-align: start;
  pointer-events: none; opacity: 0; transform: translateY(3px); transition: opacity 120ms ease-out, transform 120ms ease-out;
}
.t3h-tip:not([data-open]) { display: none; }
.t3h-tip[data-shown] { opacity: 1; transform: none; pointer-events: auto; }
.t3h-tip-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; padding: 9px 12px 8px; border-bottom: 1px solid var(--border, rgb(0 0 0 / .12)); }
.t3h-tip-title { font-size: 13px; font-weight: 600; }
.t3h-tip :is(.t3h-tip-summary, .t3h-tip-lead, .t3h-tip-meta, .t3h-tip-more, .t3h-tip-note, .t3h-tip-section-title) { color: var(--muted-foreground, #71717a); }
.t3h-tip-summary { font-size: 11.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.t3h-tip-section { display: grid; gap: 2px; padding: 7px 12px 8px; }
.t3h-tip-section + .t3h-tip-section { border-top: 1px solid var(--border, rgb(0 0 0 / .12)); }
.t3h-tip-section-title { font-size: 10.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
.t3h-tip :is(.t3h-tip-chips, .t3h-tip-badges) { display: flex; flex-wrap: wrap; gap: 4px; }
.t3h-tip-chips { margin: 2px 0 3px; }
.t3h-tip-item { display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: 8px; row-gap: 2px; margin: 0 -6px; padding: 3px 6px; border-radius: 6px; color: inherit; text-decoration: none; }
.t3h-tip a.t3h-tip-item { cursor: pointer; }
.t3h-tip a.t3h-tip-item:is(:hover, :focus-visible) { background: color-mix(in srgb, currentColor 8%, transparent); outline: none; }
.t3h-tip-lead { font-variant-numeric: tabular-nums; }
.t3h-tip-text { grid-column: 2; font-weight: 500; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.t3h-tip-sub { grid-column: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; }
.t3h-tip-item:not([data-lead]) :is(.t3h-tip-text, .t3h-tip-sub) { grid-column: 1 / -1; }
.t3h-tip-meta { font-size: 11px; overflow-wrap: anywhere; }
.t3h-tip-item[data-inline] { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.t3h-tip-item[data-inline] .t3h-tip-sub { flex: none; }
.t3h-tip-badge { --t3h-tone: var(--t3h-tip-muted); display: inline-flex; align-items: center; max-width: 100%; padding: 0 6px; border: 1px solid color-mix(in srgb, var(--t3h-tone) 35%, transparent); border-radius: 999px; background: color-mix(in srgb, var(--t3h-tone) 14%, transparent); color: color-mix(in srgb, var(--t3h-tone) 75%, currentColor); font-size: 10.5px; font-weight: 600; line-height: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.t3h-tip-badge[data-tone="critical"] { --t3h-tone: var(--t3h-tip-critical); }
.t3h-tip-badge[data-tone="high"] { --t3h-tone: var(--t3h-tip-high); }
.t3h-tip-badge[data-tone="medium"] { --t3h-tone: var(--t3h-tip-medium); }
.t3h-tip-badge[data-tone="low"] { --t3h-tone: var(--t3h-tip-low); }
.t3h-tip-badge[data-tone="success"] { --t3h-tone: var(--t3h-tip-success); }
.t3h-tip-badge[data-tone="info"] { --t3h-tone: var(--t3h-tip-info); }
.t3h-tip-badge[data-label] { --t3h-tone: var(--t3h-label); color: color-mix(in oklab, var(--t3h-label) 45%, currentColor); }
.t3h-tip-more { padding-top: 2px; font-size: 11px; justify-self: start; border-radius: 4px; text-decoration: none; }
.t3h-tip a.t3h-tip-more:is(:hover, :focus-visible) { color: inherit; text-decoration: underline; outline: none; }
.t3h-tip-note { padding: 7px 12px 8px; border-top: 1px solid var(--border, rgb(0 0 0 / .12)); font-size: 11px; }

@container (max-width: 56rem) {
  .t3h-page { padding-inline: 1.15rem; }
  .t3h .t3h-title h1 { font-size: 2.3rem; }
  .t3h-icon-large { width: 2.3rem; height: 2.3rem; }
}
@media (prefers-reduced-motion: reduce) { .t3h-is-run::after { display: none; } .t3h-tip { transition: none; transform: none; } }
`;

module.exports = { homeView, HOME_CSS };
