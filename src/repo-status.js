"use strict";

// Repository status in the thread details card: the open issues, open pull
// requests, and open security alerts of the GitHub repository behind the
// open thread. A row appears only when its count is above zero, and the whole
// section stays hidden when every count is zero or nothing can be read.
//
// The page reports which thread is open through a DevTools binding. The
// launcher finds the thread's folder in T3 Code's own database (read only),
// reads the folder's origin remote with git, and asks GitHub through the gh
// CLI, which keeps its own sign-in. The token never reaches the page.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const REPO_STATUS_BINDING = "__t3RtlFixRepoStatus";
const RECEIVER = "__t3RtlFixRepoStatusUpdate";
const PAGE_FLAG = "__t3RtlFixRepoStatusWatcher";
const CHECK = "__t3RtlFixRepoStatusCheck";
const SECTION_ATTRIBUTE = "data-t3-rtl-repo-status";
const STYLE_ID = "t3-rtl-fix-repo-status-style";

// A thread change or a return to the window reuses counts younger than this.
const FRESH_MS = 60 * 1000;
// The page asks for new counts this often while it is visible.
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
// A thread's folder and a folder's remote change rarely.
const LOCATION_CACHE_MS = 5 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 20 * 1000;
// Code scanning and secret scanning counts come from one page of alerts.
const ALERT_PAGE_SIZE = 100;

// Thread ids include forms such as mcp:launch:<hash>. The id is only bound as
// a query parameter, so any character except whitespace and a path separator
// is accepted.
const SAFE_ID = /^[^\s/\\]{1,256}$/;
const GITHUB_REMOTE =
  /^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;
const OPEN_KINDS = ["issues", "pulls", "security"];

const COUNTS_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN) { totalCount }
    pullRequests(states: OPEN) { totalCount }
    vulnerabilityAlerts(states: OPEN) { totalCount }
  }
}`;

// T3 Code routes a thread as /<environmentId>/<threadId>.
function parseThreadPath(pathname) {
  if (typeof pathname !== "string") return null;
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  let environmentId;
  let threadId;
  try {
    environmentId = decodeURIComponent(segments[0]);
    threadId = decodeURIComponent(segments[1]);
  } catch {
    return null;
  }
  if (!SAFE_ID.test(environmentId) || !SAFE_ID.test(threadId)) return null;
  return { environmentId, threadId };
}

// Reads the route from the page address, in its path or in a hash route.
function parseThreadLocation(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const route = url.hash.startsWith("#/") ? url.hash.slice(1).split("?")[0] : url.pathname;
  return parseThreadPath(route);
}

function parseGitHubRemote(remoteUrl) {
  if (typeof remoteUrl !== "string") return null;
  const match = GITHUB_REMOTE.exec(remoteUrl.trim());
  if (!match) return null;
  const [, owner, name] = match;
  if (name === "." || name === "..") return null;
  return { owner, name, slug: `${owner}/${name}` };
}

function repositoryUrl(repo, kind) {
  if (!repo || !OPEN_KINDS.includes(kind)) return null;
  return `https://github.com/${repo.owner}/${repo.name}/${kind}`;
}

function countValue(count) {
  return count && count.value > 0 ? count : null;
}

function countText(count) {
  return `${count.value}${count.capped ? "+" : ""}`;
}

// Turns the counts into the rows the page shows. Zero, missing, and
// unreadable counts produce no row.
function buildRows(status) {
  if (!status) return [];
  const rows = [];
  const issues = countValue(status.issues);
  if (issues) {
    rows.push({ kind: "issues", label: "Issues", count: countText(issues), title: "Open issues on GitHub" });
  }
  const pulls = countValue(status.pulls);
  if (pulls) {
    rows.push({ kind: "pulls", label: "Pull requests", count: countText(pulls), title: "Open pull requests on GitHub" });
  }
  const parts = [
    ["Dependabot", countValue(status.dependabot)],
    ["Code scanning", countValue(status.codeScanning)],
    ["Secret scanning", countValue(status.secretScanning)],
  ].filter(([, count]) => count);
  if (parts.length > 0) {
    const total = parts.reduce((sum, [, count]) => sum + count.value, 0);
    const capped = parts.some(([, count]) => count.capped);
    rows.push({
      kind: "security",
      label: "Security alerts",
      count: countText({ value: total, capped }),
      title: parts.map(([label, count]) => `${label}: ${countText(count)}`).join(", "),
      tone: "warning",
    });
  }
  return rows;
}

function runFile(file, args, options = {}) {
  const env = { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  // On macOS the launcher starts without the login shell's PATH, so gh from
  // Homebrew would not be found.
  if (process.platform === "darwin") {
    env.PATH = [env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":");
  }
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || "") });
      },
    );
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function totalCount(node) {
  return typeof node?.totalCount === "number" ? { value: node.totalCount, capped: false } : null;
}

// gh exits with an error for a GraphQL answer that also carries errors, such
// as a missing permission for Dependabot alerts, so the answer is read anyway.
async function fetchCounts(run, repo) {
  // An explicit host keeps a GH_HOST setting for another server out of it.
  const graphql = run("gh", [
    "api",
    "--hostname",
    "github.com",
    "graphql",
    "-f",
    `query=${COUNTS_QUERY}`,
    "-f",
    `owner=${repo.owner}`,
    "-f",
    `name=${repo.name}`,
  ]);
  const alerts = (kind) =>
    run("gh", [
      "api",
      "--hostname",
      "github.com",
      `repos/${repo.owner}/${repo.name}/${kind}/alerts?state=open&per_page=${ALERT_PAGE_SIZE}`,
    ]).then((result) => {
      const list = parseJson(result.stdout);
      if (!Array.isArray(list)) return null;
      return { value: list.length, capped: list.length >= ALERT_PAGE_SIZE };
    });
  const [graphqlResult, codeScanning, secretScanning] = await Promise.all([
    graphql,
    alerts("code-scanning"),
    alerts("secret-scanning"),
  ]);
  if (graphqlResult.error?.code === "ENOENT") {
    throw new Error("the gh command was not found");
  }
  const repository = parseJson(graphqlResult.stdout)?.data?.repository;
  if (!repository) {
    const reason = (graphqlResult.stderr || graphqlResult.error?.message || "no answer").trim();
    throw new Error(`GitHub did not return ${repo.slug}: ${reason.split("\n")[0]}`);
  }
  return {
    issues: totalCount(repository.issues),
    pulls: totalCount(repository.pullRequests),
    dependabot: totalCount(repository.vulnerabilityAlerts),
    codeScanning,
    secretScanning,
  };
}

function defaultDatabaseDirectory() {
  return path.join(os.homedir(), ".t3", "userdata");
}

// T3 Code moved its threads to statev2.sqlite and stopped writing
// state.sqlite. The older file is read only when the newer one is missing.
const THREAD_DATABASES = [
  {
    file: "statev2.sqlite",
    query: `SELECT json_extract(t.payload_json, '$.worktreePath') AS worktree,
                   p.workspace_root AS root
            FROM orchestration_v2_projection_threads t
            LEFT JOIN projection_projects p ON p.project_id = t.project_id
            WHERE t.thread_id = ?`,
  },
  {
    file: "state.sqlite",
    query: `SELECT t.worktree_path AS worktree, p.workspace_root AS root
            FROM projection_threads t
            JOIN projection_projects p ON p.project_id = t.project_id
            WHERE t.thread_id = ?`,
  },
];

// node:sqlite ignores readOnly and opens the database for writing before
// Node.js 22.12 and in 23.0 and 23.1.
function opensSqliteReadOnly(version) {
  const [major, minor] = String(version).split(".").map(Number);
  if (major === 22) return minor >= 12;
  if (major === 23) return minor >= 2;
  return major > 23;
}

// Opens T3 Code's database read only for one lookup, so the launcher never
// holds it open while T3 Code migrates or checkpoints it.
function lookupThreadFolder(databaseDirectory, threadId) {
  const source = THREAD_DATABASES.map((candidate) => ({
    ...candidate,
    path: path.join(databaseDirectory, candidate.file),
  })).find((candidate) => fs.existsSync(candidate.path));
  if (!source) {
    throw new Error(`T3 Code's database was not found in ${databaseDirectory}`);
  }
  if (!opensSqliteReadOnly(process.versions.node)) {
    throw new Error(`Node.js ${process.versions.node} cannot open T3 Code's database read only`);
  }
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(source.path, { readOnly: true });
  try {
    const row = database.prepare(source.query).get(threadId);
    if (!row) return null;
    // A worktree that was removed after its branch merged can leave its
    // folder behind, so the project folder is the fallback.
    const folders = [...new Set([row.worktree, row.root].filter(Boolean))];
    return folders.length > 0 ? folders : null;
  } finally {
    database.close();
  }
}

function openExternal(run, url) {
  if (process.platform === "win32") {
    // explorer.exe hands a URL to the default browser and exits with code 1.
    return run(path.join(process.env.SystemRoot || "C:\\Windows", "explorer.exe"), [url]);
  }
  return run(process.platform === "darwin" ? "open" : "xdg-open", [url]);
}

function createRepoStatusService({
  send,
  log = () => {},
  run = runFile,
  now = Date.now,
  databaseDirectory = defaultDatabaseDirectory(),
  findThreadFolder = (threadId) => lookupThreadFolder(databaseDirectory, threadId),
  open = (url) => openExternal(run, url),
} = {}) {
  const sessions = new Map();
  const attached = new Set();
  const folders = new Map();
  const remotes = new Map();
  const counts = new Map();
  const loggedMessages = new Set();

  function logOnce(message) {
    if (loggedMessages.has(message)) return;
    loggedMessages.add(message);
    log(`Repository status: ${message}`);
  }

  // An empty value is cached only when keepEmpty is set, so a thread that
  // T3 Code has not written yet is looked up again on the next check. A
  // failure drops the entry, so no later check shows a value from before it.
  function cached(cache, key, maxAge, load, keepEmpty = true) {
    const entry = cache.get(key);
    if (entry?.promise) return entry.promise;
    if (entry && now() - entry.at < maxAge) return Promise.resolve(entry.value);
    const promise = Promise.resolve()
      .then(load)
      .then(
        (value) => {
          if (value == null && !keepEmpty) cache.delete(key);
          else cache.set(key, { value, at: now() });
          return value;
        },
        (error) => {
          cache.delete(key);
          throw error;
        },
      );
    cache.set(key, { promise });
    return promise;
  }

  async function resolveRepository(threadId) {
    const found = await cached(
      folders,
      threadId,
      LOCATION_CACHE_MS,
      () => findThreadFolder(threadId),
      false,
    );
    for (const folder of [].concat(found || [])) {
      const repo = await cached(remotes, folder, LOCATION_CACHE_MS, async () => {
        const result = await run("git", ["-C", folder, "remote", "get-url", "origin"]);
        if (result.error?.code === "ENOENT") throw new Error("the git command was not found");
        return parseGitHubRemote(result.stdout);
      });
      if (repo) return repo;
    }
    return null;
  }

  async function push(sessionId, data) {
    const expression = `(() => { const receive = window[${JSON.stringify(RECEIVER)}]; if (typeof receive === "function") receive(${JSON.stringify(data)}); })()`;
    await send("Runtime.evaluate", { expression }, sessionId);
  }

  function loadCounts(repo, reason) {
    const maxAge = reason === "interval" ? REFRESH_INTERVAL_MS - 30 * 1000 : FRESH_MS;
    return cached(counts, repo.slug, maxAge, () => fetchCounts(run, repo));
  }

  async function check(sessionId, pagePath, reason) {
    const thread = parseThreadLocation(pagePath);
    const session = sessions.get(sessionId) || {};
    sessions.set(sessionId, session);
    session.path = pagePath;
    // The rows shown stay clickable while the same thread refreshes.
    const threadId = thread?.threadId ?? null;
    if (session.threadId !== threadId) {
      session.threadId = threadId;
      session.repo = null;
    }
    // A newer check may replace this one at any await.
    const current = () => session.path === pagePath;
    let rows = [];
    let repo = null;
    if (thread) {
      try {
        repo = await resolveRepository(thread.threadId);
        if (!current()) return;
        if (repo) rows = buildRows(await loadCounts(repo, reason));
      } catch (error) {
        logOnce(error.message);
        rows = [];
      }
    }
    if (!current()) return;
    session.repo = rows.length > 0 ? repo : null;
    await push(sessionId, { path: pagePath, repo: session.repo?.slug || null, rows });
  }

  async function handle(sessionId, payload) {
    const message = parseJson(payload);
    if (!message || typeof message !== "object") return;
    if (message.type === "check" && typeof message.path === "string") {
      await check(sessionId, message.path.slice(0, 2048), String(message.reason || ""));
      return;
    }
    if (message.type === "open") {
      const url = repositoryUrl(sessions.get(sessionId)?.repo, message.kind);
      if (url) await open(url);
    }
  }

  async function attach(sessionId) {
    const source = buildRepoStatusPageSource();
    // Without the Page domain, a reloaded page does not run the script
    // registered for new documents.
    await send("Page.enable", {}, sessionId);
    await send("Runtime.addBinding", { name: REPO_STATUS_BINDING }, sessionId);
    await send("Page.addScriptToEvaluateOnNewDocument", { source }, sessionId);
    await send("Runtime.evaluate", { expression: source }, sessionId);
    attached.add(sessionId);
  }

  // A reloaded page loses the binding. The launcher adds it again when the
  // new document is ready, and the page then checks again. The Runtime domain
  // would keep it, but would also hold T3 Code's console objects.
  async function reattach(sessionId) {
    if (!attached.has(sessionId)) return;
    await send("Runtime.addBinding", { name: REPO_STATUS_BINDING }, sessionId);
    await send(
      "Runtime.evaluate",
      { expression: `(() => { const check = window[${JSON.stringify(CHECK)}]; if (typeof check === "function") check("navigate"); })()` },
      sessionId,
    );
  }

  function forget(sessionId) {
    sessions.delete(sessionId);
    attached.delete(sessionId);
  }

  return { attach, reattach, handle, forget };
}

const ICONS = {
  repo: [["path", { d: "M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" }]],
  issues: [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["circle", { cx: "12", cy: "12", r: "1" }],
  ],
  pulls: [
    ["circle", { cx: "18", cy: "18", r: "3" }],
    ["circle", { cx: "6", cy: "6", r: "3" }],
    ["path", { d: "M13 6h3a2 2 0 0 1 2 2v7" }],
    ["path", { d: "M6 9v12" }],
  ],
  security: [
    ["path", { d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" }],
    ["path", { d: "M12 8v4" }],
    ["path", { d: "M12 16h.01" }],
  ],
};

const PAGE_CSS = `
[${SECTION_ATTRIBUTE}] {
  display: grid;
  gap: 2px;
  padding: 10px 12px;
  border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  direction: ltr;
  font-size: 13px;
}
[${SECTION_ATTRIBUTE}] .t3-rtl-repo-status-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 2px;
  font-size: 12px;
  opacity: 0.65;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
[${SECTION_ATTRIBUTE}] button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: calc(100% + 12px);
  margin: 0 -6px;
  padding: 4px 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
}
[${SECTION_ATTRIBUTE}] button:hover,
[${SECTION_ATTRIBUTE}] button:focus-visible {
  background: color-mix(in srgb, currentColor 8%, transparent);
  outline: none;
}
[${SECTION_ATTRIBUTE}] svg {
  flex: none;
  width: 14px;
  height: 14px;
}
[${SECTION_ATTRIBUTE}] .t3-rtl-repo-status-count {
  margin-inline-start: auto;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
[${SECTION_ATTRIBUTE}] button[data-tone="warning"] .t3-rtl-repo-status-count,
[${SECTION_ATTRIBUTE}] button[data-tone="warning"] svg {
  color: var(--warning, #d97706);
}
`;

function buildRepoStatusPageSource() {
  return `(() => {
  const binding = ${JSON.stringify(REPO_STATUS_BINDING)};
  const receiver = ${JSON.stringify(RECEIVER)};
  const flag = ${JSON.stringify(PAGE_FLAG)};
  const attribute = ${JSON.stringify(SECTION_ATTRIBUTE)};
  const styleId = ${JSON.stringify(STYLE_ID)};
  const css = ${JSON.stringify(PAGE_CSS)};
  const icons = ${JSON.stringify(ICONS)};
  const refreshInterval = ${REFRESH_INTERVAL_MS};
  if (window[flag]) return;
  Object.defineProperty(window, flag, { value: true });

  let current = null;
  let lastHref = location.href;
  let renderQueued = false;

  // The first two route segments name the thread. Other address changes,
  // such as an opened panel, keep the shown counts while they are checked.
  const routeKey = (href) => {
    try {
      const url = new URL(href);
      const route = url.hash.startsWith("#/") ? url.hash.slice(1).split("?")[0] : url.pathname;
      return route.split("/").filter(Boolean).slice(0, 2).join("/");
    } catch {
      return href;
    }
  };

  const notify = (message) => {
    const call = window[binding];
    if (typeof call === "function") call(JSON.stringify(message));
  };
  const request = (reason) => notify({ type: "check", path: location.href, reason });
  Object.defineProperty(window, ${JSON.stringify(CHECK)}, { value: request });

  const ensureStyle = () => {
    if (document.getElementById(styleId) || !document.head) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = css;
    document.head.appendChild(style);
  };

  const icon = (name) => {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "lucide");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    for (const [tag, attributes] of icons[name] || []) {
      const child = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attributes)) child.setAttribute(key, value);
      svg.appendChild(child);
    }
    return svg;
  };

  // The card holds a scroll area around one element with its sections. The
  // section goes after the last of them.
  const sectionContainer = (card) => {
    let node = card.querySelector('[data-slot="scroll-area-viewport"]') || card;
    const start = node;
    for (let depth = 0; node && depth < 8; depth += 1) {
      const children = Array.from(node.children).filter((child) => !child.hasAttribute(attribute));
      if (children.length !== 1) return children.length > 1 ? node : start;
      node = children[0];
    }
    return start;
  };

  const buildSection = (data, signature) => {
    const section = document.createElement("div");
    section.setAttribute(attribute, "");
    section.dataset.signature = signature;
    const head = document.createElement("div");
    head.className = "t3-rtl-repo-status-head";
    head.appendChild(icon("repo"));
    const name = document.createElement("span");
    name.textContent = data.repo || "";
    head.appendChild(name);
    section.appendChild(head);
    for (const row of data.rows) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.kind = row.kind;
      if (row.tone) button.dataset.tone = row.tone;
      button.title = row.title || "";
      button.appendChild(icon(row.kind));
      const label = document.createElement("span");
      label.textContent = row.label;
      const count = document.createElement("span");
      count.className = "t3-rtl-repo-status-count";
      count.textContent = row.count;
      button.append(label, count);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        notify({ type: "open", kind: row.kind });
      });
      section.appendChild(button);
    }
    return section;
  };

  const render = () => {
    renderQueued = false;
    const rows = current && Array.isArray(current.rows) ? current.rows : [];
    const signature = rows.length ? JSON.stringify([current.repo, rows]) : "";
    const keep = new Set();
    if (signature) {
      ensureStyle();
      for (const card of document.querySelectorAll("[data-thread-details-card]")) {
        const container = sectionContainer(card);
        let section = Array.from(container.children).find((child) => child.hasAttribute(attribute));
        if (!section || section.dataset.signature !== signature || section !== container.lastElementChild) {
          if (section) section.remove();
          section = buildSection(current, signature);
          container.appendChild(section);
        }
        keep.add(section);
      }
    }
    for (const section of document.querySelectorAll("[" + attribute + "]")) {
      if (!keep.has(section)) section.remove();
    }
  };

  const scheduleRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
  };

  window[receiver] = (data) => {
    if (!data || routeKey(data.path) !== routeKey(location.href)) return;
    current = data;
    scheduleRender();
  };

  const observer = new MutationObserver(() => {
    if (current?.rows?.length || document.querySelector("[" + attribute + "]")) scheduleRender();
  });
  const startObserving = () => {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.documentElement) startObserving();
  else document.addEventListener("DOMContentLoaded", startObserving, { once: true });

  setInterval(() => {
    if (location.href === lastHref) return;
    const threadChanged = routeKey(location.href) !== routeKey(lastHref);
    lastHref = location.href;
    if (threadChanged) {
      current = null;
      scheduleRender();
    }
    request("navigate");
  }, 1000);
  setInterval(() => {
    if (document.visibilityState === "visible") request("interval");
  }, refreshInterval);
  window.addEventListener("focus", () => request("focus"));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") request("focus");
  });
  request("navigate");
})();`;
}

module.exports = {
  REPO_STATUS_BINDING,
  RECEIVER,
  SECTION_ATTRIBUTE,
  FRESH_MS,
  REFRESH_INTERVAL_MS,
  buildRepoStatusPageSource,
  buildRows,
  createRepoStatusService,
  fetchCounts,
  lookupThreadFolder,
  opensSqliteReadOnly,
  parseGitHubRemote,
  parseThreadLocation,
  parseThreadPath,
  repositoryUrl,
};
