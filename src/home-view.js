"use strict";

// The Home page: where every project stands, from running agents to the last
// release.
//
// homeView is not called here. It is turned into source text and added to T3
// Code's script for the start route (see home-route.js), so it may use only
// what it gets. It returns the component.

function homeView({
  React, useProjects, useThreads, useBootstrapped, useNewThread, useRouter, useEnvironments,
  projectReference, Frame, focusProps, Header, electron, main, frameClass, css,
}) {
  const h = React.createElement;
  const STATIONS = ["Working", "Pull request", "Ready to merge", "Not released", "Last release"];
  const ASK_EVERY_MS = 60 * 1000;

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
  const count = (number, one, many) => `${number} ${number === 1 ? one : many || `${one}s`}`;
  function ago(ms) {
    const minutes = Math.max(1, Math.round(ms / 60000));
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 2880) return `${Math.round(minutes / 60)}h`;
    return minutes < 86400 ? `${Math.round(minutes / 1440)}d` : `${Math.round(minutes / 43200)}mo`;
  }

  const repositoryOf = (project) =>
    /^github\.com\/([a-z0-9_-]+\/[\w.-]+)$/i.exec(project.repositoryIdentity?.canonicalKey || "")?.[1].toLowerCase() ?? null;

  function isWorking(thread, connected) {
    return (
      ["preparing", "starting", "running"].includes(thread.runtime?.status) &&
      !thread.hasPendingApprovals && !thread.hasPendingUserInput && !thread.pendingSubagentRequest &&
      thread.archivedAt == null && thread.lineage?.relationshipToParent !== "subagent" &&
      thread.lineage?.sideChat !== true && connected.has(thread.environmentId)
    );
  }

  // One entry per repository: T3 Code can hold a repository as several
  // projects, such as one on each computer.
  function entriesOf(projects, threads, environments) {
    const connected = new Set(environments.filter((item) => item.connection?.phase === "connected").map((item) => item.environmentId));
    const byProject = new Map();
    const byKey = new Map();
    for (const project of projects) {
      const repository = repositoryOf(project);
      const id = `${project.environmentId}:${project.id}`;
      const key = repository || id;
      const entry = byKey.get(key) || { key, repository, project, latest: "", working: [] };
      byKey.set(key, entry);
      byProject.set(id, entry);
    }
    for (const thread of threads) {
      const entry = byProject.get(`${thread.environmentId}:${thread.projectId}`);
      if (!entry) continue;
      if (thread.updatedAt > entry.latest) {
        entry.latest = thread.updatedAt;
        entry.project = projects.find((project) => project.id === thread.projectId && project.environmentId === thread.environmentId);
      }
      if (isWorking(thread, connected)) entry.working.push(thread);
    }
    return [...byKey.values()].sort((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0));
  }

  function pullItem(entry, pull, now) {
    const age = pull.at ? `${ago(now - pull.at)} ago` : "";
    const url = `https://github.com/${entry.repository}/pull/${pull.number}`;
    return { key: `pull${pull.number}`, text: pull.title, note: [`#${pull.number}`, pull.note || age].filter(Boolean).join(", "), tone: pull.tone, pull: url };
  }

  // Dependency updates are one item, with the ones that need a look in its note.
  function pullStation(entry, pulls, tone, plus, now) {
    const own = pulls.filter((pull) => !pull.update);
    const updates = pulls.filter((pull) => pull.update);
    const worst = (list) => ["bad", "warn"].find((item) => list.some((pull) => pull.tone === item)) || "";
    const mark = (list, update, name) =>
      list.length ? [{ number: list.length, label: `${list.length}${plus}`, tone: tone || worst(list), update, name: count(list.length, name) }] : [];
    const troubled = updates.filter((pull) => pull.tone !== "ok");
    const updatesItem = updates.length
      ? [{
        key: "updates",
        text: count(updates.length, "dependency update"),
        note: troubled.length ? troubled.map((pull) => `#${pull.number}, ${pull.note}`).join(". ") : "ready to merge",
        tone: worst(updates),
        link: `https://github.com/${entry.repository}/pulls`,
      }]
      : [];
    return {
      marks: [...mark(own, false, "pull request"), ...mark(updates, true, "dependency update")],
      items: [...own.map((pull) => pullItem(entry, pull, now)), ...updatesItem],
    };
  }

  function stationsOf(entry, facts, now) {
    const working = {
      marks: entry.working.length ? [{ number: entry.working.length, label: String(entry.working.length), tone: "run", name: `${count(entry.working.length, "agent")} working` }] : [],
      items: entry.working.map((thread) => {
        const since = Date.parse(thread.runtime?.activityStartedAt || thread.latestRun?.startedAt || thread.latestRun?.requestedAt || "");
        return { key: `${thread.environmentId}:${thread.id}`, text: thread.title, note: since ? ago(now - since) : "", thread };
      }),
    };
    if (facts?.status !== "read") return [working, ...STATIONS.slice(1).map(() => ({ marks: [], items: [] }))];
    const plus = facts.partial && facts.pulls.length > 0 ? "+" : "";
    const release = facts.release;
    const ahead = release?.ahead || 0;
    const notReleased = { marks: [], items: [] };
    if (facts.mainFails) {
      notReleased.marks.push({ number: 0, label: "!", tone: "bad", name: "The default branch fails its checks" });
      notReleased.items.push({ key: "fails", text: "The default branch fails its checks", tone: "bad", link: `https://github.com/${entry.repository}/commits` });
    }
    if (ahead > 0) {
      notReleased.marks.push({ number: ahead, label: String(ahead), tone: "plain", name: `${count(ahead, "commit")} not released` });
      notReleased.items.push({ key: "ahead", text: count(ahead, "commit"), note: `since ${release.tag}`, link: `https://github.com/${entry.repository}/compare/${encodeURIComponent(release.tag)}...HEAD` });
    }
    return [
      working,
      pullStation(entry, facts.pulls.filter((pull) => pull.stage === "open"), "", plus, now),
      pullStation(entry, facts.pulls.filter((pull) => pull.stage === "ready"), "ok", plus, now),
      notReleased,
      { marks: [], items: release ? [{ key: "release", text: release.tag, note: release.at ? `${ago(now - release.at)} ago` : "", link: `https://github.com/${entry.repository}/releases` }] : [] },
    ];
  }

  function Glyph({ d, size = 16 }) {
    return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, h("path", { d }));
  }
  const PLUS = "M12 5v14M5 12h14";
  const BACK = "m15 18-6-6 6-6";
  const OUT = "M14 5h5v5M19 5l-8 8M11 7H6a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-5";

  function Picture({ project, className }) {
    const { Icon } = mainParts();
    if (Icon) return h(Icon, { project, className });
    return h("span", { className: `${className} t3h-letters`, "aria-hidden": true }, project.title.slice(0, 2).toUpperCase());
  }

  const text = (value, className) => h("span", { className, dir: directionOf(value) }, value);

  function Mark({ mark }) {
    return h("i", { className: `t3h-m t3h-${mark.tone || "muted"}${mark.update ? " t3h-update" : ""}`, title: mark.name, dir: "ltr", "aria-hidden": true }, mark.label);
  }
  const Stop = () => h("i", { className: "t3h-stop", "aria-hidden": true });

  function Item({ item, actions }) {
    const note = item.note ? h("small", { className: item.tone === "bad" || item.tone === "warn" ? `t3h-${item.tone}` : undefined, dir: "ltr" }, item.note) : null;
    const props = { className: "t3h-text", dir: directionOf(item.text) };
    let body = null;
    if (item.thread) body = h("button", { ...props, type: "button", onClick: () => actions.openThread(item.thread) }, item.text);
    else if (item.pull) body = h("a", { ...props, href: item.pull, target: "_blank", rel: "noreferrer", onClick: (event) => actions.openPull?.(event, item.pull) }, item.text);
    else if (item.link) body = h("a", { ...props, href: item.link, target: "_blank", rel: "noreferrer" }, item.text);
    else body = h("span", props, item.text);
    return h("div", { className: "t3h-item" }, body, note);
  }

  function Station({ entry, station, index, actions }) {
    if (station.marks.length === 0) return h("span", { className: "t3h-sp" }, h(Stop));
    const label = `${entry.project.title}: ${station.marks.map((mark) => mark.name).join(", ")}`;
    return h("span", { className: "t3h-sp" },
      h("button", { type: "button", className: "t3h-marks", "aria-label": label }, station.marks.map((mark, at) => h(Mark, { key: at, mark }))),
      h("div", { className: "t3h-pop", role: "group", "aria-label": label },
        h("div", { className: "t3h-card" },
          h("div", { className: "t3h-small", dir: "ltr" }, `${entry.project.title}, ${STATIONS[index].toLowerCase()}`),
          station.items.map((item) => h(Item, { key: item.key, item, actions })))));
  }

  function Release({ entry, facts, now }) {
    if (!entry.repository) return h("span", { className: "t3h-release" });
    if (!facts || facts.status === "waiting") return h("span", { className: "t3h-release t3h-small", dir: "ltr" }, "Reading…");
    if (facts.status === "unavailable") return h("span", { className: "t3h-release t3h-small", dir: "ltr" }, "Not available");
    return h("span", { className: "t3h-release", dir: "ltr" },
      facts.release ? [facts.release.tag, facts.release.at ? h("small", { key: "at" }, `${ago(now - facts.release.at)} ago`) : null] : null);
  }

  function Names({ label, entries, actions }) {
    if (entries.length === 0) return null;
    return h("div", { className: "t3h-names" },
      h("span", { className: "t3h-small", dir: "ltr" }, label),
      entries.map((entry) => h("button", { key: entry.key, type: "button", className: "t3h-name-small", onClick: () => actions.openProject(entry) },
        h(Picture, { project: entry.project, className: "t3h-icon-small" }), text(entry.project.title))));
  }

  function Overview({ entries, factsOf, now, actions }) {
    const rows = entries.map((entry) => ({ entry, facts: factsOf(entry), stations: stationsOf(entry, factsOf(entry), now) }));
    const open = rows.filter((row) => row.stations.some((station) => station.marks.length > 0));
    const idle = (test) => rows.filter((row) => !open.includes(row) && test(row)).map((row) => row.entry);
    const total = (index) => open.reduce((sum, row) => sum + row.stations[index].marks.reduce((all, mark) => all + (mark.update ? 0 : mark.number), 0), 0);
    const more = (index) => open.some((row) => row.stations[index].marks.some((mark) => mark.label.endsWith("+")));
    const has = (test) => open.some((row) => row.stations.some((station) => station.marks.some(test)));
    const keys = [
      has((mark) => mark.tone === "warn") && ["warn", "Conflicts"],
      has((mark) => mark.tone === "bad") && ["bad", "Failed check"],
      has((mark) => mark.update) && ["muted t3h-update", "Dependency updates, not counted above"],
    ].filter(Boolean);
    return h("div", { className: "t3h-map" },
      h("div", { className: "t3h-head" },
        h("div"),
        STATIONS.slice(0, 4).map((name, index) => h("div", { key: name, dir: "ltr" },
          h("b", { className: total(index) ? undefined : "t3h-zero" }, total(index), more(index) ? "+" : ""), name)),
        h("div", { dir: "ltr" }, STATIONS[4])),
      rows.every(({ entry, facts, stations }) => (!entry.repository || facts?.status === "read") && stations.every((station) => station.marks.length === 0))
        ? h("p", { className: "t3h-none", dir: "ltr" }, "Nothing is open.")
        : null,
      open.map(({ entry, facts, stations }, index) => h("section", { key: entry.key, className: `t3h-row${index > 3 && index > open.length - 4 ? " t3h-low" : ""}` },
        h("button", { type: "button", className: "t3h-name", onClick: () => actions.openProject(entry) },
          h(Picture, { project: entry.project, className: "t3h-icon" }), text(entry.project.title, "t3h-cut")),
        h("div", { className: "t3h-rail" },
          stations.slice(0, 4).map((station, at) => h(Station, { key: at, entry, station, index: at, actions })),
          h(Release, { entry, facts, now })))),
      h("div", { className: "t3h-foot" },
        h("div", { className: "t3h-groups" },
          h(Names, { label: "Nothing open", actions, entries: idle(({ entry, facts }) => entry.repository && facts?.status === "read") }),
          h(Names, { label: "Reading GitHub", actions, entries: idle(({ entry, facts }) => entry.repository && (!facts || facts.status === "waiting")) }),
          h(Names, { label: "GitHub is not available", actions, entries: idle(({ facts }) => facts?.status === "unavailable") }),
          h(Names, { label: "Not on GitHub", actions, entries: idle(({ entry }) => !entry.repository) })),
        h("div", { className: "t3h-keys" }, keys.map(([tone, name]) => h("span", { key: name }, h("i", { className: `t3h-m t3h-${tone}` }), h("span", { dir: "ltr" }, name))))));
  }

  function Project({ entry, facts, now, actions }) {
    const heading = React.useRef(null);
    React.useEffect(() => heading.current?.focus({ preventScroll: true }), [entry.key]);
    const stations = stationsOf(entry, facts, now);
    const url = entry.repository ? `https://github.com/${entry.repository}` : null;
    const link = (path, name) => h("a", { className: "t3h-button", href: url + path, target: "_blank", rel: "noreferrer", dir: "ltr" }, h(Glyph, { d: OUT, size: 15 }), name);
    const read = facts?.status === "read";
    return h("div", { className: "t3h-project" },
      h("button", { type: "button", className: "t3h-back", onClick: actions.openMap, dir: "ltr" }, h(Glyph, { d: BACK, size: 15 }), "Home"),
      h("div", { className: "t3h-title" },
        h(Picture, { project: entry.project, className: "t3h-icon-large" }),
        h("h1", { ref: heading, tabIndex: -1, dir: directionOf(entry.project.title) }, entry.project.title)),
      h("div", { className: "t3h-actions" },
        h("button", { type: "button", className: "t3h-button t3h-primary", onClick: () => actions.startThread(entry), dir: "ltr" }, h(Glyph, { d: PLUS }), "New thread"),
        url ? link("", "GitHub") : null,
        url ? link("/pulls", "Pull requests") : null,
        url ? link("/issues", read && facts.issues ? count(facts.issues, "issue") : "Issues") : null),
      h("div", { className: "t3h-track" },
        STATIONS.slice(0, url ? 5 : 1).map((name, index) => {
          const station = stations[index];
          const shown = station.marks.find((mark) => !mark.update) || station.marks[0];
          return h("section", { key: name, className: `t3h-stage${station.items.length ? "" : " t3h-empty"}` },
            h("div", { className: "t3h-dot" }, shown ? h(Mark, { mark: station.marks.length > 1 && shown.number ? { ...shown, label: shown.label.replace(/^\d+/, String(station.marks.reduce((sum, mark) => sum + mark.number, 0))) } : shown }) : h(Stop)),
            h("div", null, h("h2", { dir: "ltr" }, name), station.items.map((item) => h(Item, { key: item.key, item, actions }))));
        })),
      url && !read ? h("p", { className: "t3h-small", dir: "ltr" }, facts?.status === "unavailable" ? "GitHub could not be read for this project." : "Reading GitHub…") : null,
      read && facts.partial ? h("p", { className: "t3h-small", dir: "ltr" }, "GitHub gave only a part of this project.") : null);
  }

  // Facts come from the launcher, through the fix's own script in this page.
  function useGithub(repositories) {
    const [github, setGithub] = React.useState(null);
    const asked = JSON.stringify(repositories);
    React.useEffect(() => {
      const ask = () => {
        if (document.visibilityState === "visible" && asked !== "[]") document.dispatchEvent(new CustomEvent("t3-rtl-home:ask", { detail: asked }));
      };
      const receive = (event) => setGithub(JSON.parse(event.detail));
      document.addEventListener("t3-rtl-home:facts", receive);
      // The fix's script can start after this page.
      document.addEventListener("t3-rtl-home:ready", ask);
      document.addEventListener("visibilitychange", ask);
      const timer = setInterval(ask, ASK_EVERY_MS);
      ask();
      return () => {
        clearInterval(timer);
        document.removeEventListener("t3-rtl-home:facts", receive);
        document.removeEventListener("t3-rtl-home:ready", ask);
        document.removeEventListener("visibilitychange", ask);
      };
    }, [asked]);
    return github;
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

  function Page({ projects }) {
    const { useOpenPull } = mainParts();
    const threads = useThreads();
    const { environments } = useEnvironments();
    const router = useRouter();
    const newThread = useNewThread();
    const openPull = useOpenPull();
    const now = useNow();
    const chosen = useChosen(router);
    const [failed, setFailed] = React.useState(false);
    const entries = entriesOf(projects, threads, environments);
    const github = useGithub(entries.map((entry) => entry.repository).filter(Boolean).sort());
    const factsOf = (entry) => (entry.repository && github ? github.repositories[entry.repository] ?? null : null);
    const actions = {
      openPull,
      openMap: () => router.navigate({ to: "/" }),
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
      h("div", { className: "t3h" },
        h("div", { className: "t3h-page" },
          notes.length ? h("div", { className: "t3h-notes", role: "status" }, notes.map((note) => h("p", { key: note, dir: "ltr" }, note))) : null,
          entry ? h(Project, { entry, facts: factsOf(entry), now, actions }) : h(Overview, { entries, factsOf, now, actions }))));
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
    if (projects.length > 0) return h(Boundary, { native }, h(Page, { projects }));
    return bootstrapped ? h(native) : null;
  };
}

const HOME_CSS = `
.t3h { flex: 1; min-height: 0; overflow: auto; container-type: inline-size; color: var(--foreground); font-size: .875rem; line-height: 1.45; direction: ltr; }
:root[data-t3-rtl-app="on"] .t3h { direction: rtl; }
.t3h [dir] { text-align: -webkit-match-parent; text-align: match-parent; }
.t3h button, .t3h a { font: inherit; color: inherit; text-decoration: none; background: none; border: 0; padding: 0; cursor: pointer; }
.t3h button { text-align: start; }
.t3h :is(button, a, h1):focus-visible { outline: 2px solid var(--ring); outline-offset: 3px; border-radius: .4rem; }
.t3h :is(h1, h2, p) { margin: 0; font: inherit; }
.t3h h1:focus { outline: 0; }
.t3h-header { font-size: .875rem; font-weight: 500; color: var(--foreground); }
.t3h-page { max-width: 66rem; margin: 0 auto; padding: 1.5rem 2.75rem 4rem; }
.t3h-small { font-size: .78rem; color: var(--muted-foreground); }
.t3h-ok { --t3h-k: var(--success); } .t3h-bad { --t3h-k: var(--destructive); } .t3h-warn { --t3h-k: var(--warning); }
.t3h-run { --t3h-k: var(--info); } .t3h-plain { --t3h-k: var(--foreground); } .t3h-muted { --t3h-k: var(--muted-foreground); }
.t3h small { display: block; font-size: .78rem; font-weight: 400; color: var(--muted-foreground); }
.t3h small:is(.t3h-bad, .t3h-warn) { color: var(--t3h-k); }
.t3h-notes { margin-bottom: 1.5rem; padding: .7rem .9rem; border-radius: .7rem; border: 1px solid var(--border); color: var(--muted-foreground); }

.t3h-m {
  --t3h-bg: var(--background); position: relative; display: inline-grid; place-items: center; box-sizing: border-box; min-width: 1.9rem; height: 1.9rem;
  padding: 0 .45rem; border-radius: 99px; background: var(--t3h-k); color: var(--t3h-bg); font-size: .88rem; font-style: normal;
  font-weight: 680; font-variant-numeric: tabular-nums; line-height: 1;
}
.t3h-m.t3h-update { background: var(--t3h-bg); color: var(--t3h-k); box-shadow: inset 0 0 0 2px var(--t3h-k); }
.t3h-m.t3h-run::after { content: ""; position: absolute; inset: 0; border-radius: 99px; box-shadow: 0 0 0 2px var(--t3h-k); animation: t3h-breathe 2.6s ease-out infinite; }
@keyframes t3h-breathe { from { scale: 1; opacity: .6; } 70%, to { scale: 1.55; opacity: 0; } }
.t3h-stop { display: block; width: .5rem; height: .5rem; margin-inline: .7rem; border-radius: 50%; background: color-mix(in srgb, var(--muted-foreground) 45%, var(--background)); }

.t3h-head, .t3h-row { display: grid; grid-template-columns: 13.5rem 1fr 1.05fr 1.2fr .8fr 6.2rem; column-gap: 1rem; }
.t3h-head { align-items: end; padding: .6rem 0 1rem; font-size: .88rem; color: var(--muted-foreground); }
.t3h-head b { display: block; margin-bottom: .3rem; font-size: 2.5rem; line-height: 1; font-weight: 650; letter-spacing: -.04em; font-variant-numeric: tabular-nums; color: var(--foreground); }
.t3h-head b.t3h-zero { color: color-mix(in srgb, var(--muted-foreground) 55%, transparent); }
.t3h-row { align-items: center; min-height: 3.55rem; }
.t3h-none { padding: 1rem 0; font-size: 1.15rem; color: var(--muted-foreground); }
.t3h-name { display: flex; align-items: center; gap: .65rem; min-width: 0; font-size: 1.18rem !important; font-weight: 620 !important; letter-spacing: -.015em; }
:is(.t3h-name, .t3h-name-small):hover { color: var(--primary) !important; }
.t3h-cut { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t3h-icon { width: 1.45rem; height: 1.45rem; flex: none; }
.t3h-icon-small { width: 1rem; height: 1rem; flex: none; }
.t3h-icon-large { width: 3rem; height: 3rem; flex: none; }
.t3h-letters { display: inline-grid; place-items: center; border-radius: .3rem; font-size: .55rem; font-weight: 700; background: color-mix(in srgb, var(--primary) 22%, transparent); }
.t3h-rail { grid-column: 2 / -1; display: grid; grid-template-columns: subgrid; align-items: center; align-self: stretch; position: relative; }
.t3h-rail::before { content: ""; position: absolute; top: calc(50% - 1px); height: 2px; inset-inline: .95rem 6.9rem; border-radius: 2px; background: color-mix(in srgb, var(--muted-foreground) 32%, var(--background)); }
.t3h-sp { position: relative; display: flex; align-items: center; align-self: stretch; }
.t3h-sp:is(:hover, :focus-within) { z-index: 30; }
.t3h-marks { position: relative; display: flex; gap: .3rem; border-radius: 99px; }
.t3h-release { font-size: .95rem; font-weight: 600; line-height: 1.2; overflow-wrap: anywhere; }
.t3h-release.t3h-small { font-size: .78rem; font-weight: 400; }

/* The padding keeps the pointer inside on its way to the card. */
.t3h-pop { display: none; position: absolute; z-index: 20; top: calc(50% + .95rem); inset-inline-start: -.9rem; padding-top: .55rem; width: max-content; max-width: 22rem; }
.t3h-low .t3h-pop { top: auto; bottom: calc(50% + .95rem); padding: 0 0 .55rem; }
.t3h-sp:is(:hover, :focus-within) > .t3h-pop { display: block; }
.t3h-map:has(.t3h-sp:hover) .t3h-sp:not(:hover) > .t3h-pop { display: none; }
.t3h-card { display: grid; gap: .6rem; max-height: 20rem; overflow: auto; padding: .85rem 1rem; border: 1px solid var(--border); border-radius: .8rem; background: var(--popover); color: var(--popover-foreground); box-shadow: 0 14px 34px -12px rgb(0 0 0 / .38); font-size: .95rem; line-height: 1.4; }
.t3h-text { display: block; width: 100%; overflow-wrap: anywhere; }
:is(a, button).t3h-text:hover { color: var(--primary) !important; }

.t3h-foot { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: start; gap: .8rem 2rem; margin-top: 1.4rem; }
.t3h-groups { display: grid; gap: .7rem; flex: 1 1 24rem; }
.t3h-names { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1.3rem; }
.t3h-name-small { display: inline-flex; align-items: center; gap: .4rem; font-size: .95rem !important; color: var(--muted-foreground) !important; }
.t3h-keys { display: flex; flex-wrap: wrap; gap: .3rem 1.1rem; font-size: .78rem; color: var(--muted-foreground); }
.t3h-keys > span { display: inline-flex; align-items: center; gap: .4rem; }
.t3h-keys .t3h-m { min-width: .8rem; width: .8rem; height: .8rem; padding: 0; }

.t3h-back { display: inline-flex; align-items: center; gap: .3rem; font-size: .85rem !important; color: var(--muted-foreground) !important; }
:root[data-t3-rtl-app="on"] .t3h-back { flex-direction: row-reverse; }
:root[data-t3-rtl-app="on"] .t3h-back svg { scale: -1 1; }
.t3h-title { display: flex; align-items: center; gap: 1rem; margin-top: 1.2rem; }
.t3h-title h1 { font-size: 3.2rem; line-height: 1.05; font-weight: 680; letter-spacing: -.035em; overflow-wrap: anywhere; }
.t3h-actions { display: flex; flex-wrap: wrap; gap: .6rem; margin-top: 1.4rem; }
.t3h-button { display: inline-flex; align-items: center; gap: .45rem; height: 2.5rem; padding: 0 1.05rem !important; border: 1px solid var(--border) !important; border-radius: var(--radius, .625rem); background: var(--card) !important; font-size: .95rem !important; font-weight: 550 !important; white-space: nowrap; }
.t3h-button:hover { border-color: color-mix(in srgb, var(--foreground) 35%, var(--border)) !important; }
.t3h-button.t3h-primary { background: var(--primary) !important; border-color: var(--primary) !important; color: var(--primary-foreground) !important; }
.t3h-track { max-width: 44rem; margin: 2.2rem 0 .6rem; }
.t3h-stage { position: relative; display: grid; grid-template-columns: 1.9rem minmax(0, 1fr); column-gap: 1.1rem; padding-bottom: 1.25rem; }
.t3h-stage:not(:last-child)::before { content: ""; position: absolute; inset-inline-start: calc(.95rem - 1px); top: .9rem; bottom: -.9rem; width: 2px; background: color-mix(in srgb, var(--muted-foreground) 32%, var(--background)); }
.t3h-empty { padding-bottom: .55rem; }
.t3h-empty h2 { opacity: .7; }
.t3h-dot { position: relative; display: grid; justify-items: center; align-content: start; }
.t3h-dot .t3h-stop { margin: .7rem 0 0; }
.t3h-stage h2 { font-size: .85rem; line-height: 1.9rem; color: var(--muted-foreground); }
.t3h-stage .t3h-item + .t3h-item { margin-top: .75rem; }
.t3h-stage .t3h-text { font-size: 1.08rem !important; line-height: 1.4; }

@container (max-width: 56rem) {
  .t3h-page { padding-inline: 1.15rem; }
  .t3h-head, .t3h-row { grid-template-columns: 9.6rem 1fr 1fr 1fr 1fr 4.6rem; column-gap: .5rem; }
  .t3h-head { font-size: .78rem; }
  .t3h-head b { font-size: 1.8rem; }
  .t3h-name { font-size: 1rem !important; gap: .45rem; }
  .t3h-icon { width: 1.2rem; height: 1.2rem; }
  .t3h-rail::before { inset-inline-end: 4.9rem; }
  .t3h-release { font-size: .85rem; }
  .t3h-sp { position: static; }
  .t3h-pop { inset-inline: 0; width: auto; max-width: none; }
  .t3h-title h1 { font-size: 2.3rem; }
  .t3h-icon-large { width: 2.3rem; height: 2.3rem; }
}
@container (max-width: 36rem) {
  .t3h-head, .t3h-row { grid-template-columns: 1fr 1fr 1fr 1fr 4.2rem; }
  .t3h-head > :first-child { display: none; }
  .t3h-row { row-gap: .3rem; padding: .5rem 0; }
  .t3h-name, .t3h-rail { grid-column: 1 / -1; }
  .t3h-rail { min-height: 2.4rem; }
}
@media (prefers-reduced-motion: reduce) { .t3h-m.t3h-run::after { display: none; } }
`;

module.exports = { HOME_CSS, homeView };
